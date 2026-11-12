// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ثنائية (≤ uploadChunkBytes)
const { limits } = require("../lib/limits");
const { json, error, options, methodNotAllowed, readRawBody } = require("../lib/http");
const dbm = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return options(res);
  if (req.method !== "POST") return methodNotAllowed(res, "POST");

  try {
    const jobId = String(req.query.job ?? "");
    const seq = Number(req.query.seq);
    const chunk = Number(req.query.chunk);
    if (!jobId) return error(res, 400, "معامل job مطلوب");
    if (!Number.isInteger(seq) || seq < 0) return error(res, 400, "معامل seq يجب أن يكون رقمًا صحيحًا ≥ 0");
    if (!Number.isInteger(chunk) || chunk < 0) return error(res, 400, "معامل chunk يجب أن يكون رقمًا صحيحًا ≥ 0");

    const job = await dbm.getJob(jobId);
    if (!job) return error(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");
    if (job.status !== "queued" && job.status !== "uploading") {
      return error(res, 409, `لا يمكن الرفع في حالة المهمة الحالية (${job.status})`);
    }
    const sources = await dbm.listSources(jobId);
    if (seq >= sources.length) return error(res, 400, `seq خارج النطاق — عدد المصادر ${sources.length}`);
    const src = sources[seq];
    if (src.kind !== "file") return error(res, 400, "المصدر المطلوب ليس ملفًا مرفوعًا (kind=file فقط)");

    const body = await readRawBody(req, limits.uploadChunkBytes);
    if (!body.length) return error(res, 400, "قطعة فارغة — أرسل بايتات ثنائية (application/octet-stream)");

    await dbm.insertSourceChunk(jobId, seq, chunk, body);
    const sourcesAfter = await dbm.listSources(jobId);
    json(res, 200, {
      ok: true,
      job: jobId,
      seq,
      chunk,
      receivedBytes: sourcesAfter[seq].receivedBytes,
      expectedBytes: sourcesAfter[seq].size,
    });
  } catch (e) {
    error(res, e.statusCode || 500, e.message || "خطأ غير متوقع أثناء الرفع");
  }
};
