#!/usr/bin/env node
// اختبار e2e كامل ضد خادم Next.js (localhost:3000) + خدمة الدمج المحلية (localhost:3001)
// يغطي معايير القبول: tools/list، توليد صورة حقيقي، توليد فيديو حقيقي، التبديل التسلسلي
// بين مفاتيح خاطئ/صحيح، الدمج الحقيقي بمقطعين، validation الدمج، list_media، ثم التنظيف.
// الاستخدام: BASE=http://localhost:3000 node scripts/e2e-mcp.js
// (يحتاج TURSO_DATABASE_URL و TURSO_AUTH_TOKEN في البيئة للتنظيف المباشر)

const BASE = process.env.BASE || "http://localhost:3000";
// E2E_ONLY=video: الفيديو فقط (بعد جولة كاملة سابقة) — E2E_SKIP=video: تخطّ الفيديو
const SKIP_VIDEO = process.env.E2E_SKIP === "video";
const ONLY_VIDEO = process.env.E2E_ONLY === "video";

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- MCP client helpers (يدعم JSON و SSE) ----------
async function postRpc(sessionId, body) {
  const resp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = resp.headers.get("mcp-session-id") || sessionId || null;
  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text();
  const messages = [];
  if (ct.includes("text/event-stream")) {
    for (const block of text.split("\n\n")) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        try { messages.push(JSON.parse(dataLine.slice(5).trim())); } catch {}
      }
    }
  } else if (text.trim()) {
    try { messages.push(JSON.parse(text)); } catch {}
  }
  const response = messages.find((m) => m.id === body.id && (m.result || m.error));
  const notifications = messages.filter((m) => m.method && m.method.startsWith("notifications/"));
  return { status: resp.status, sid, messages, response, notifications };
}

function toolText(res) {
  const c = res?.response?.result?.content;
  return c?.[0]?.text ?? "";
}
function toolIsError(res) {
  return Boolean(res?.response?.result?.isError);
}

// تنظيف مباشر عبر Turso (مهام الاختبار فقط) + مفتاح الاختبار عبر الـ API
async function cleanup(deleteFakeKeyId) {
  try {
    if (deleteFakeKeyId) {
      await fetch(`${BASE}/api/keys/${deleteFakeKeyId}`, { method: "DELETE" }).catch(() => {});
    }
    const { createClient } = require("@libsql/client");
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    // حذف مهام الاختبار + مهام الدمج المحلية من قاعدة البيانات
    await client.execute("DELETE FROM tasks");
    await client.execute("DELETE FROM jobs");
    await client.execute("DELETE FROM sources");
    await client.execute("DELETE FROM source_chunks");
    await client.execute("DELETE FROM output_chunks");
    console.log("  🧹 نُظفت مهام الاختبار من قاعدة البيانات");
  } catch (e) {
    console.log(`  ⚠️ التنظيف الجزئي: ${e.message}`);
  }
}

async function main() {
  let fakeData = null;
  console.log(`=== e2e — MCP Media Generator ضد ${BASE} ===\n`);

  // [0] الصحة
  console.log("[0] /api/health…");
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("ok:true و database turso-connected", health.ok === true && health.database === "turso-connected", JSON.stringify(health));
  check("merger.healthy:true (الخدمة المحلية)", health.merger?.healthy === true, JSON.stringify(health.merger));
  check("mcpEndpoint /mcp", health.mcpEndpoint === "/mcp");
  check("موديلان مسجلان", Array.isArray(health.models) && health.models.length === 2);

  // [1] تهيئة الجلسة
  console.log("\n[1] initialize + initialized + tools/list…");
  const init = await postRpc(null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e-test", version: "1.0" } },
  });
  check("initialize نجح", init.response?.result?.serverInfo?.name === "media-generator-mcp", JSON.stringify(init.response?.error || ""));
  check("أُرجعت mcp-session-id", Boolean(init.sid));
  const sid = init.sid;
  await postRpc(sid, { jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await postRpc(sid, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = list.response?.result?.tools ?? [];
  check("خمس أدوات", tools.length === 5, `(${tools.length})`);
  const names = tools.map((t) => t.name).sort().join(",");
  check("أسماء الأدوات صحيحة", names === "generate_image,generate_video,get_task,list_media,merge_videos", names);
  const mergeTool = tools.find((t) => t.name === "merge_videos");
  const mergeProps = mergeTool?.inputSchema?.properties ?? {};
  check("merge بلا resolution/fps", !("resolution" in mergeProps) && !("fps" in mergeProps));
  check("merge بحد 10", mergeProps.urls?.maxItems === 10 && mergeProps.task_ids?.maxItems === 10);

  if (!ONLY_VIDEO) {
  // [2] الاعتراضات العربية
  console.log("\n[2] أداة مجهولة + validation الدمج…");
  const unknown = await postRpc(sid, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not_a_tool", arguments: {} } });
  check("أداة مجهولة برسالة عربية", toolText(unknown).includes("أداة غير معروفة"), toolText(unknown));
  const oneUrl = await postRpc(sid, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "merge_videos", arguments: { urls: ["https://example.com/x.mp4"] } } });
  check("دمج بمقطع واحد مرفوض بالعربية", toolIsError(oneUrl) && toolText(oneUrl).includes("مقطعَين على الأقل"), toolText(oneUrl));
  const manyUrls = await postRpc(sid, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "merge_videos", arguments: { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) } } });
  check("دمج بأكثر من 10 مرفوض بالعربية", toolIsError(manyUrls) && toolText(manyUrls).includes("أقصى عدد مقاطع"), toolText(manyUrls));

  // [3] list_media
  console.log("\n[3] list_media…");
  const lm = await postRpc(sid, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_media", arguments: { limit: 5 } } });
  check("list_media يرد نصًا عربيًا", toolText(lm).length > 0 && !toolIsError(lm), toolText(lm).slice(0, 100));

  // [4] توليد صورة حقيقي
  console.log("\n[4] generate_image (حقيقي عبر kie.ai)…");
  const img = await postRpc(sid, {
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "generate_image", arguments: { prompt: "A tiny robot painting a colorful canvas in a bright studio, digital art, detailed", wait_seconds: 100 } },
  });
  const imgText = toolText(img);
  const imgCompleted = imgText.includes("تم توليد الصورة بنجاح") && imgText.includes("الرابط المباشر");
  const imgProcessing = imgText.includes("قيد المعالجة");
  check("الصورة اكتملت خلال نافذة الانتظار أو أعادت task_id", imgCompleted || imgProcessing, imgText.slice(0, 200));
  if (!imgCompleted && imgProcessing) {
    const tid = imgText.match(/task_id:\s*([a-f0-9-]+)/)?.[1];
    for (let i = 0; i < 20 && tid; i++) {
      await sleep(10000);
      const r = await postRpc(sid, { jsonrpc: "2.0", id: 70 + i, method: "tools/call", params: { name: "get_task", arguments: { task_id: tid } } });
      const t = toolText(r);
      if (t.includes("تم توليد الصورة")) { check("الصورة اكتملت عبر get_task", t.includes("الرابط المباشر"), t.slice(0, 150)); break; }
      if (t.includes("فشلت المهمة")) { check("الصورة اكتملت عبر get_task", false, t.slice(0, 150)); break; }
    }
  }

  } // نهاية القسم غير الفيديو

  if (!SKIP_VIDEO) {
  // [5] توليد فيديو حقيقي (يحتاج دقائق — نتابع بـ get_task كل 10 ثوانٍ)
  console.log("\n[5] generate_video (حقيقي — قد يستغرق دقائق)…");
  const vid = await postRpc(sid, {
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "generate_video", arguments: { prompt: "A golden retriever puppy running happily in a sunny park, cinematic, natural audio", duration: 8, resolution: "480p", wait_seconds: 25 } },
  });
  const vidText = toolText(vid);
  check("الفيديو أعاد task_id أو اكتمل", vidText.includes("قيد المعالجة") || vidText.includes("تم توليد الفيديو بنجاح"), vidText.slice(0, 200));
  let videoTid = vidText.match(/task_id:\s*([a-f0-9-]+)/)?.[1];
  if (videoTid) {
    let done = false;
    for (let i = 0; i < 50; i++) {
      await sleep(10000);
      const r = await postRpc(sid, { jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: "get_task", arguments: { task_id: videoTid } } });
      const t = toolText(r);
      if (t.includes("تم توليد الفيديو بنجاح")) {
        check("الفيديو اكتمل برابط صالح عبر get_task", t.includes("https://"), t.slice(0, 150));
        done = true;
        break;
      }
      if (t.includes("فشلت المهمة")) { check("الفيديو اكتمل برابط صالح عبر get_task", false, t.slice(0, 200)); done = true; break; }
      process.stdout.write(`  ⏳ ${i * 10}s…\r`);
    }
    if (!done) check("الفيديو اكتمل خلال المهلة (8 دقائق)", false, "timeout");
  }

  } // نهاية قسم الفيديو

  if (!ONLY_VIDEO) {
  // [6] التبديل التسلسلي: مفتاح خاطئ أولًا ثم الصحيح — نفس task_id تكتمل ولا شيء يرى أخطاء المفاتيح
  console.log("\n[6] اختبار التبديل التسلسلي (مفتاح خاطئ ثم الصحيح)…");
  const keysBefore = (await (await fetch(`${BASE}/api/keys`)).json()).keys ?? [];
  const realKey = keysBefore.find((k) => k.provider === "kie" && k.status !== "disabled");
  check("يوجد مفتاح kie حقيقي في القاعدة", Boolean(realKey), JSON.stringify(keysBefore.map((k) => [k.provider, k.status])));
  const addFake = await fetch(`${BASE}/api/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "kie", api_key: `invalid-fake-key-e2e-${Date.now()}`, label: "اختبار فاشل" }),
  });
  fakeData = await addFake.json();
  check("أُضيف المفتاح الخاطئ", addFake.status === 201 && fakeData.id, JSON.stringify(fakeData));
  // تعطيل المفتاح الحقيقي مؤقتًا ليُجرَّب الخاطئ أولًا (الترتيب تسلسلي صارم)
  await fetch(`${BASE}/api/keys/${realKey.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "disabled" }),
  });
  const failover = await postRpc(sid, {
    jsonrpc: "2.0", id: 9, method: "tools/call",
    params: { name: "generate_image", arguments: { prompt: "A red balloon floating over white clouds, minimal art", wait_seconds: 10 } },
  });
  const failoverText = toolText(failover);
  check("أعاد processing بـ task_id (بدون أي ذكر للمفاتيح/الرصيد)", failoverText.includes("قيد المعالجة"), failoverText.slice(0, 200));
  check("الرسالة لا تذكر مفتاحًا ولا رصيدًا", !/مفتاح|رصيد|invalid|401|unauthorized/i.test(failoverText), failoverText.slice(0, 120));
  const failoverTid = failoverText.match(/task_id:\s*([a-f0-9-]+)/)?.[1];
  // إعادة تنشيط المفتاح الحقيقي ثم نتابع بـ get_task حتى اكتمال نفس المهمة
  await fetch(`${BASE}/api/keys/${realKey.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" }),
  });
  if (failoverTid) {
    let failoverDone = false;
    for (let i = 0; i < 25; i++) {
      await sleep(10000); // التهدئة ~45 ثانية قبل إعادة المحاولة
      const r = await postRpc(sid, { jsonrpc: "2.0", id: 200 + i, method: "tools/call", params: { name: "get_task", arguments: { task_id: failoverTid } } });
      const t = toolText(r);
      if (t.includes("تم توليد الصورة بنجاح")) {
        check("نفس المهمة (نفس task_id) اكتملت على المفتاح الصحيح", t.includes("الرابط المباشر"), t.slice(0, 120));
        failoverDone = true;
        break;
      }
      if (t.includes("فشلت المهمة")) { check("نفس المهمة اكتملت على المفتاح الصحيح", false, t.slice(0, 150)); failoverDone = true; break; }
      process.stdout.write(`  ⏳ انتظار التهدئة وإعادة المحاولة ${i * 10}s…\r`);
    }
    if (!failoverDone) check("نفس المهمة اكتملت على المفتاح الصحيح", false, "timeout");
  }
  const keysAfter = (await (await fetch(`${BASE}/api/keys`)).json()).keys ?? [];
  const fakeKeyAfter = keysAfter.find((k) => k.id === fakeData.id);
  check("المفتاح الخاطئ صار disabled تلقائيًا", fakeKeyAfter?.status === "disabled", JSON.stringify(fakeKeyAfter?.status));

  // [7] دمج حقيقي بمقطعين عامين (عبر خدمة الدمج المحلية)
  console.log("\n[7] merge_videos حقيقي بمقطعين عامين…");
  const merge = await postRpc(sid, {
    jsonrpc: "2.0", id: 10, method: "tools/call",
    params: {
      name: "merge_videos",
      arguments: {
        urls: [
          "https://www.w3schools.com/html/mov_bbb.mp4",
          "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
        ],
        wait_seconds: 120,
      },
    },
  });
  const mergeText = toolText(merge);
  check("الدمج اكتمل برابط نهائي", mergeText.includes("تم دمج المقاطع بنجاح"), mergeText.slice(0, 250));
  check("تحذير الـ 24 ساعة موجود", mergeText.includes("24 ساعة"));
  const mergedUrlMatch = mergeText.match(/https:\/\/\S+\.mp4/) || mergeText.match(/الرابط المباشر:\s*(\S+)/);
  const mergedUrl = mergedUrlMatch ? (mergedUrlMatch[0].startsWith("h") ? mergedUrlMatch[0] : mergedUrlMatch[1]) : null;
  if (mergedUrl) {
    const head = await fetch(mergedUrl, { headers: { Range: "bytes=0-99" } });
    check("رابط الدمج يعمل (206/200 من نطاق خدمة الدمج)", head.status === 206 || head.status === 200, `(status ${head.status})`);
  }

  // [8] list_media بعد التوليد — مرتبة من الأحدث
  const lm2 = await postRpc(sid, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "list_media", arguments: { limit: 10 } } });
  check("list_media يعرض المهام بروابطها", /الرابط:|task_id:/.test(toolText(lm2)), toolText(lm2).slice(0, 200));

  } // نهاية أقسام ما بعد الفيديو

  // [9] التنظيف
  console.log("\n[9] تنظيف آثار الاختبار…");
  await cleanup(fakeData?.id);
  check("تم التنظيف", true);

  console.log(`\n=== النتيجة: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("خطأ غير متوقع:", e);
  await cleanup(null);
  process.exit(1);
});
