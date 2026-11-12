// GET /api/jobs/<id> — الحالة + التقدم + الرابط عند الاكتمال
// DELETE /api/jobs/<id> — حذف فوري شامل (المهمة + المصادر + كل الأجزاء)
const { json, error, options, methodNotAllowed, publicBaseUrl } = require("../../lib/http");
const dbm = require("../../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return options(res);
  if (req.method !== "GET" && req.method !== "DELETE") {
    return methodNotAllowed(res, "GET, DELETE");
  }

  try {
    const jobId = String(req.query.id ?? "");
    if (!jobId) return error(res, 400, "معرّف المهمة مطلوب");

    if (req.method === "DELETE") {
      const job = await dbm.getJob(jobId);
      if (!job) return error(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");
      await dbm.deleteJob(jobId);
      return json(res, 200, { ok: true, deleted: true, jobId });
    }

    const job = await dbm.getJob(jobId);
    if (!job) return error(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");

    const base = publicBaseUrl(req);
    const response = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      expiresAt: job.expiresAt,
      createdAt: job.createdAt,
    };
    if (job.status === "done") {
      response.videoUrl = `${base}/api/jobs/${job.id}/video`;
      response.downloadUrl = `${base}/api/jobs/${job.id}/video?download=1`;
      response.size = job.size;
      response.duration = job.duration;
      response.resolution = job.resolution;
    }
    if (job.status === "failed") {
      response.error = job.error || "فشل غير محدد";
    }
    json(res, 200, response);
  } catch (e) {
    error(res, e.statusCode || 500, e.message || "خطأ غير متوقع");
  }
};
