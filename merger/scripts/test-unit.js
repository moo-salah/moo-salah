#!/usr/bin/env node
// اختبار وحدات لمحرك الدمج والتخزين — بدون HTTP:
// 1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (أحدهما بصوت والآخر صامت)
// 2) دمجهما والتحقق: اكتمال، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت
// 3) التخزين في Turso والاسترجاع بتطابق sha256 (+ قراءة مدى وسطي)
// 4) مسار رفع الأجزاء (تجميع source_chunks)
// 5) حدود الحجم والحذف الشامل
require("../lib/env");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const FFMPEG = require("ffmpeg-static");
const dbm = require("../lib/db");
const storage = require("../lib/storage");
const ffmpegLib = require("../lib/ffmpeg");
const { limits } = require("../lib/limits");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sha256File = (p) => sha256(fs.readFileSync(p));

async function main() {
  console.log("=== اختبار وحدات — Video Merger API ===\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-unit-"));
  const ff = (args) => execFileSync(FFMPEG, args, { stdio: "pipe" });

  // 1) توليد مقطعين مختلفين
  console.log("[1] توليد مقطعين تجريبيين مختلفي الدقة…");
  const v1 = path.join(tmp, "v1.mp4"); // 640x360 — 4 ثوان — بصوت sine
  const v2 = path.join(tmp, "v2.mp4"); // 1280x720 — 3 ثوان — صامت
  ff(["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", v1]);
  ff(["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=3",
      "-c:v", "libx264", "-preset", "veryfast", "-an", v2]);
  check("توليد المقطع الأول (640x360 مع صوت)", fs.existsSync(v1) && fs.statSync(v1).size > 10000);
  check("توليد المقطع الثاني (1280x720 صامت)", fs.existsSync(v2) && fs.statSync(v2).size > 10000);

  // 2) الدمج عبر المحرك مباشرة
  console.log("\n[2] دمج المحرك المباشر (scale+pad+concat مع مسار صامت)…");
  const infos = [await ffmpegLib.ffprobeInfo(v1), await ffmpegLib.ffprobeInfo(v2)];
  check("فحص ffprobe: أبعاد المقطع الأول", infos[0].width === 640 && infos[0].height === 360);
  check("فحص ffprobe: المقطع الثاني صامت", infos[1].hasAudio === false);
  const outPath = path.join(tmp, "merged.mp4");
  const lastFrac = { v: 0 };
  const { width, height } = await new Promise(async (resolve, reject) => {
    try {
      const dims = ffmpegLib.targetDimensions(infos);
      await ffmpegLib.runMerge([v1, v2], infos, outPath, (f) => { lastFrac.v = f; });
      resolve(dims);
    } catch (e) { reject(e); }
  });
  check("اكتمال الدمج", fs.existsSync(outPath) && fs.statSync(outPath).size > 10000);
  check("تقدم الترميز وصل 1.0", Math.abs(lastFrac.v - 1) < 0.2, `(آخر قيمة ${lastFrac.v})`);
  const mergedInfo = await ffmpegLib.ffprobeInfo(outPath);
  check("الدقة = أكبر دقة مدخل (1280x720)", width === 1280 && height === 720 && mergedInfo.width === 1280 && mergedInfo.height === 720);
  const totalDur = infos[0].duration + infos[1].duration;
  check("المدة ≈ مجموع المدد", Math.abs(mergedInfo.duration - totalDur) < 1.2,
    `(المتوقع ${totalDur.toFixed(2)} الفعلي ${mergedInfo.duration?.toFixed(2)})`);
  check("وجود مسار صوت في الناتج (المصدر الصامت عُوّض بمسار صامت)", mergedInfo.hasAudio === true);

  // 3) التخزين في Turso والاسترجاع بتطابق sha256
  console.log("\n[3] التخزين في Turso والاسترجاع…");
  const jobId = dbm.newJobId();
  await dbm.insertJob([{ kind: "url", url: "https://example.com/x.mp4" }]);
  const size = await storage.storeOutputFile(jobId, outPath, limits.outputMaxMb * 1048576);
  check("حجم المخزّن = حجم الملف", size === fs.statSync(outPath).size);
  // استرجاع كامل
  const chunks = [];
  await storage.readOutputRange(jobId, 0, size - 1, (b) => chunks.push(b));
  const restored = Buffer.concat(chunks);
  check("استرجاع كامل بتطابق sha256", sha256(restored) === sha256File(outPath));
  // استرجاع مدى وسطي
  const midStart = Math.floor(size / 3), midEnd = Math.floor(size / 3) + 50000;
  const mid = [];
  await storage.readOutputRange(jobId, midStart, midEnd, (b) => mid.push(b));
  const fileBuf = fs.readFileSync(outPath);
  check("استرجاع مدى وسطي مطابق", sha256(Buffer.concat(mid)) === sha256(fileBuf.subarray(midStart, midEnd + 1)));

  // 4) مسار رفع الأجزاء (تجميع source_chunks)
  console.log("\n[4] مسار رفع الأجزاء وتجميعها…");
  const uploadSrc = fileBuf.subarray(0, 5 * 1048576); // 5MB
  const uploadChunkBytes = 1 * 1048576; // نحاكي قطع رفع 1MB
  const perUpload = Math.ceil(limits.uploadChunkBytes / limits.blobChunkBytes);
  for (let c = 0; c * uploadChunkBytes < uploadSrc.length; c++) {
    await dbm.insertSourceChunk(jobId, 0, c, uploadSrc.subarray(c * uploadChunkBytes, (c + 1) * uploadChunkBytes));
  }
  // ملاحظة: insertSourceChunk يحسب تقسيم صفوف الـ 2MB داخليًا — نتحقق من التطابق الكامل
  const assembledPath = path.join(tmp, "assembled.bin");
  const assembledBytes = await dbm.assembleSourceToTmp(jobId, 0, assembledPath, limits.sourceMaxMb * 1048576);
  check("تجميع الأجزاء المرفوعة بتطابق sha256", assembledBytes === uploadSrc.length && sha256File(assembledPath) === sha256(uploadSrc.subarray(0, assembledBytes)));

  // 5) الحدود والحذف الشامل
  console.log("\n[5] الحدود والحذف الشامل…");
  let sizeLimitThrown = false;
  try { await storage.storeOutputFile(jobId, outPath, 1024); } catch (e) { sizeLimitThrown = /يتجاوز الحد/.test(e.message); }
  check("تجاوز حد حجم الناتج يرفض برسالة عربية", sizeLimitThrown);
  await dbm.deleteJob(jobId);
  const after = await dbm.getJob(jobId);
  check("الحذف الشامل يزيل المهمة", after === null);
  const bytesAfter = await dbm.countOutputBytes(jobId);
  check("الحذف الشامل يزيل كل الـ Blobs", bytesAfter === 0);

  // تنظيف
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n=== النتيجة: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("خطأ غير متوقع:", e); process.exit(1); });
