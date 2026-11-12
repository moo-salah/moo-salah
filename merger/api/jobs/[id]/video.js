// GET /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range) للتقديم/الترجيع في المشغل
// ?download=1 للتحميل المباشر كملف MP4
const { limits } = require("../../../lib/limits");
const { error, options, methodNotAllowed, setCors } = require("../../../lib/http");
const dbm = require("../../../lib/db");
const storage = require("../../../lib/storage");

function parseRange(header, totalSize) {
  if (!header) return null;
  const m = String(header).trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return { invalid: true };
  const [, a, b] = m;
  if (a === "" && b === "") return { invalid: true };
  if (a === "") {
    // لاحقة: آخر N بايت
    const suffix = Number(b);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }
  const start = Number(a);
  if (!Number.isFinite(start) || start >= totalSize) return { invalid: true };
  const end = b === "" ? totalSize - 1 : Math.min(Number(b), totalSize - 1);
  if (!Number.isFinite(end) || end < start) return { invalid: true };
  return { start, end };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return options(res);
  if (req.method !== "GET") return methodNotAllowed(res, "GET");

  try {
    const jobId = String(req.query.id ?? "");
    if (!jobId) return error(res, 400, "معرّف المهمة مطلوب");

    const job = await dbm.getJob(jobId);
    if (!job) return error(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");
    if (job.status !== "done") {
      return error(res, 409, `الناتج غير جاهز بعد — الحالة الحالية: ${job.status} (${job.progress}%)`);
    }

    const totalSize = job.size ?? (await dbm.countOutputBytes(jobId));
    if (totalSize <= 0) return error(res, 404, "لا يوجد ناتج مخزّن لهذه المهمة");

    const range = parseRange(req.headers.range, totalSize);
    if (range && range.invalid) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      return res.end();
    }

    const isDownload = req.query.download === "1" || req.query.download === "true";
    setCors(res);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600"
    );
    if (isDownload) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="merged-${jobId}.mp4"`
      );
    }

    if (range) {
      const { start, end } = range;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      res.setHeader("Content-Length", String(end - start + 1));
      let bytesSent = 0;
      await storage.readOutputRange(jobId, start, end, (buf) => {
        bytesSent += buf.length;
        res.write(buf);
      });
      res.end();
      // ضمان تطابق Content-Length مع المرسل فعليًا (دفاعي)
      if (bytesSent !== end - start + 1) {
        // لا يمكن تغيير الترويسات بعد الإرسال — التسجيل فقط للمراجعة
        console.error(`[video] طول غير متوقع: متوقع ${end - start + 1} أُرسل ${bytesSent}`);
      }
    } else {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(totalSize));
      await storage.readOutputRange(jobId, 0, totalSize - 1, (buf) => res.write(buf));
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) {
      error(res, e.statusCode || 500, e.message || "خطأ غير متوقع أثناء البث");
    } else {
      res.end();
    }
  }
};
