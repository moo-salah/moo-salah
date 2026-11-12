#!/usr/bin/env node
// اختبار HTTP كامل ضد خادم التطوير (dev-server.js على المنفذ 3001 افتراضيًا):
// إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع)
// → حذف → 404 → JSON تالف → قائمة فارغة → تجاوز الحد
require("../lib/env");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BASE = process.env.TEST_BASE || "http://localhost:3001";
const FFMPEG = require("ffmpeg-static");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function jfetch(url, opts = {}, timeoutMs = 300000) {
  const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  const text = await resp.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, headers: resp.headers, body };
}

async function main() {
  console.log(`=== اختبار HTTP كامل ضد ${BASE} ===\n`);

  // فحص الجهوزية
  console.log("[1] فحص /api/config…");
  const cfg = await jfetch(`${BASE}/api/config`);
  check("config يرجع 200", cfg.status === 200);
  check("حدود صحيحة (maxSources=10)", cfg.body?.limits?.maxSources === 10, JSON.stringify(cfg.body?.limits));
  const uploadChunkBytes = cfg.body?.limits?.uploadChunkBytes || 4 * 1048576;

  const URL1 = "https://www.w3schools.com/html/mov_bbb.mp4";
  const URL2 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";

  // مهمة من روابط مباشرة
  console.log("\n[2] مهمة من روابط مباشرة → دمج كامل…");
  const created = await jfetch(`${BASE}/api/jobs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [URL1, URL2] }),
  });
  check("إنشاء المهمة يرجع 201", created.status === 201, JSON.stringify(created.body));
  const jobId = created.body?.jobId;
  check("استجابة الإنشاء فيها jobId/status/statusUrl/processUrl/expiresAt",
    Boolean(jobId && created.body.status && created.body.statusUrl && created.body.processUrl && created.body.expiresAt));

  const proc = await jfetch(`${BASE}/api/jobs/${jobId}/process`, { method: "POST" });
  check("process يرجع 200 و status=done", proc.status === 200 && proc.body?.status === "done", JSON.stringify(proc.body).slice(0, 200));
  check("الناتج فيه videoUrl + downloadUrl + size + duration + resolution",
    Boolean(proc.body?.videoUrl && proc.body?.downloadUrl && proc.body?.size > 0 && proc.body?.duration > 0 && proc.body?.resolution));
  check("videoUrl على نطاق الخدمة نفسها (بدون نطاقات داخلية)", proc.body?.videoUrl?.startsWith(BASE) === true);

  // حالة المهمة بعد الاكتمال
  const status = await jfetch(`${BASE}/api/jobs/${jobId}`);
  check("GET حالة المهمة: done + progress 100", status.body?.status === "done" && status.body?.progress === 100);

  // بث الناتج مع Range
  console.log("\n[3] بث الناتج بدعم Range…");
  const range = await fetch(`${proc.body.videoUrl}`, { headers: { Range: "bytes=0-1023" } });
  const rangeBuf = Buffer.from(await range.arrayBuffer());
  check("Range يرجع 206", range.status === 206, `(${range.status})`);
  check("Content-Range صحيح", range.headers.get("content-range") === `bytes 0-1023/${proc.body.size}`, range.headers.get("content-range"));
  check("طول المحتوى المستلم = 1024", rangeBuf.length === 1024);
  check("Accept-Ranges: bytes", range.headers.get("accept-ranges") === "bytes");
  const suffix = await fetch(proc.body.videoUrl, { headers: { Range: "bytes=-1000" } });
  check("Range لاحقة (-N) يرجع 206", suffix.status === 206 && Number(suffix.headers.get("content-length")) === 1000);
  const full = await fetch(proc.body.videoUrl);
  check("بدون Range يرجع 200 كامل", full.status === 200 && Number(full.headers.get("content-length")) === proc.body.size);
  const dl = await fetch(proc.body.downloadUrl);
  check("download=1 يضيف Content-Disposition", (dl.headers.get("content-disposition") || "").includes("attachment"));

  // حذف ثم 404
  console.log("\n[4] الحذف ثم 404…");
  const del = await jfetch(`${BASE}/api/jobs/${jobId}`, { method: "DELETE" });
  check("DELETE يرجع ok", del.status === 200 && del.body?.ok === true);
  const afterDel = await jfetch(`${BASE}/api/jobs/${jobId}`);
  check("GET بعد الحذف يرجع 404", afterDel.status === 404, `(${afterDel.status})`);

  // أخطاء المدخلات
  console.log("\n[5] أخطاء المدخلات…");
  const bad = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{تالف" });
  check("JSON تالف يرجع 400 و error عربي", bad.status === 400);
  const empty = await jfetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [] }) });
  check("قائمة فارغة يرجع 400", empty.status === 400 && /فارغة/.test(empty.body?.error || ""));
  const many = await jfetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) }) });
  check("أكثر من 10 مصادر يرجع 400", many.status === 400 && /أقصى عدد/.test(many.body?.error || ""));
  const notUrl = await jfetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: ["ftp://x"] }) });
  check("رابط غير http يرجع 400", notUrl.status === 400);
  const random404 = await jfetch(`${BASE}/api/jobs/nonexistent99`);
  check("مهمة غير موجودة يرجع 404", random404.status === 404);

  // مهمة مختلطة (رابط + ملف مرفوع بالأجزاء)
  console.log("\n[6] مهمة مختلطة (رابط + ملف مرفوع بالأجزاء)…");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
  const sample = path.join(tmp, "sample.mp4");
  execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=660:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", sample]);
  const sampleBuf = fs.readFileSync(sample);
  const mixed = await jfetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: [{ kind: "url", url: URL1 }, { kind: "file", name: "sample.mp4", size: sampleBuf.length, mime: "video/mp4" }] }) });
  check("إنشاء المهمة المختلطة يرجع 201 مع uploads", mixed.status === 201 && Array.isArray(mixed.body?.uploads) && mixed.body.uploads.length === 1);
  const fileSeq = mixed.body.uploads[0].seq;
  // حماية: تنفيذ process قبل رفع أي بايت يجب أن يرفض 409
  const earlyProcess = await jfetch(`${BASE}/api/jobs/${mixed.body.jobId}/process`, { method: "POST" });
  check("process قبل اكتمال الرفع يرجع 409 (محمي)", earlyProcess.status === 409, `(الحالة ${earlyProcess.status})`);
  let uploadOk = true;
  for (let c = 0, off = 0; off < sampleBuf.length; c++, off += 1024 * 1024) {
    const piece = sampleBuf.subarray(off, Math.min(off + 1024 * 1024, sampleBuf.length));
    const up = await jfetch(`${BASE}/api/upload?job=${mixed.body.jobId}&seq=${fileSeq}&chunk=${c}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: piece });
    if (up.status !== 200 || up.body?.ok !== true) { uploadOk = false; console.log("   فشل رفع:", JSON.stringify(up.body)); break; }
  }
  check("رفع كل الأجزاء نجح", uploadOk);
  const mixedProc = await jfetch(`${BASE}/api/jobs/${mixed.body.jobId}/process`, { method: "POST" });
  check("الدمج المختلط يكتمل (done)", mixedProc.status === 200 && mixedProc.body?.status === "done", JSON.stringify(mixedProc.body).slice(0, 200));
  check("الدمج المختلط ينتج رابطًا على نطاق الخدمة", mixedProc.body?.videoUrl?.startsWith(BASE) === true);
  await jfetch(`${BASE}/api/jobs/${mixed.body.jobId}`, { method: "DELETE" });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n=== النتيجة: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("خطأ غير متوقع:", e); process.exit(1); });
