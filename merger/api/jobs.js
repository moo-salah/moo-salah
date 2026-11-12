// POST /api/jobs — إنشاء مهمة دمج من روابط مباشرة و/أو ملفات ستُرفع بالأجزاء
const { limits } = require("../lib/limits");
const { json, error, options, methodNotAllowed, readJsonBody, publicBaseUrl, finalError } = require("../lib/http");
const dbm = require("../lib/db");

function normalizeSources(body) {
  // يقبل {"videos":[...]} أو {"sources":[{"kind":"url"|"file", ...}]}
  let raw = null;
  if (Array.isArray(body?.videos)) {
    raw = body.videos.map((u) => ({ kind: "url", url: u }));
  } else if (Array.isArray(body?.sources)) {
    raw = body.sources;
  }
  if (!raw) return { err: "الجسم يجب أن يحتوي videos (مصفوفة روابط) أو sources (مصفوفة مصادر)" };
  if (raw.length === 0) return { err: "قائمة المصادر فارغة — مرّر رابطًا واحدًا على الأقل" };
  if (raw.length > limits.maxSources) {
    return { err: `أقصى عدد مصادر هو ${limits.maxSources} (تم تمرير ${raw.length})` };
  }
  const sources = [];
  for (const [i, s] of raw.entries()) {
    // kind صريح (url/file) أو استنتاج من وجود url
    const kind = s?.kind ? String(s.kind) : s?.url ? "url" : "file";
    if (kind === "url") {
      const url = String(s?.url ?? (typeof s === "string" ? s : "")).trim();
      if (!/^https?:\/\/.+/i.test(url)) {
        return { err: `المصدر رقم ${i + 1}: الرابط يجب أن يكون رابطًا مباشرًا عامًا يبدأ بـ http/https` };
      }
      sources.push({ kind: "url", url });
    } else if (kind === "file") {
      const name = String(s?.name ?? "").trim();
      const size = Number(s?.size ?? 0);
      if (!name) return { err: `المصدر رقم ${i + 1}: اسم الملف مطلوب للمصادر المرفوعة` };
      if (!Number.isFinite(size) || size <= 0) {
        return { err: `المصدر رقم ${i + 1}: حجم الملف غير صالح` };
      }
      if (size > limits.sourceMaxMb * 1024 * 1024) {
        return { err: `المصدر رقم ${i + 1}: الحجم ${(size / 1048576).toFixed(1)}MB يتجاوز الحد المسموح ${limits.sourceMaxMb}MB` };
      }
      sources.push({ kind: "file", name, mime: s?.mime ? String(s.mime) : null, size });
    } else {
      return { err: `المصدر رقم ${i + 1}: kind غير معروف (المسموح: url أو file)` };
    }
  }
  return { sources };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return options(res);
  if (req.method !== "POST") return methodNotAllowed(res, "POST");

  try {
    const body = await readJsonBody(req);
    const norm = normalizeSources(body);
    if (norm.err) return error(res, 400, norm.err);

    // تنظيف كسول للمهام المنتهية قبل كل إنشاء
    try { await dbm.cleanupExpired(); } catch { /* التنظيف ليس حرجًا للطلب */ }

    const sources = norm.sources;
    const job = await dbm.insertJob(sources);
    const base = publicBaseUrl(req);

    const response = {
      jobId: job.id,
      status: job.status,
      statusUrl: `${base}/api/jobs/${job.id}`,
      processUrl: `${base}/api/jobs/${job.id}/process`,
      expiresAt: job.expiresAt,
      uploadChunkBytes: limits.uploadChunkBytes,
    };

    // رابط رفع لكل مصدر ملف + عدد البايتات لكل قطعة
    const uploads = sources
      .map((s, seq) => ({ s, seq }))
      .filter(({ s }) => s.kind === "file")
      .map(({ s, seq }) => ({
        seq,
        name: s.name,
        size: s.size,
        uploadUrl: `${base}/api/upload?job=${job.id}&seq=${seq}&chunk=0`,
        uploadChunkBytes: limits.uploadChunkBytes,
      }));
    if (uploads.length) response.uploads = uploads;

    json(res, 201, response);
  } catch (e) {
    error(res, e.statusCode || 500, e.message || "خطأ غير متوقع أثناء إنشاء المهمة");
  }
};
