// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن): تنزيل/سحب المصادر ← ترميز ← تخزين ← رابط الناتج
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { limits } = require("../../../lib/limits");
const { json, error, options, methodNotAllowed, publicBaseUrl, finalError } = require("../../../lib/http");
const dbm = require("../../../lib/db");
const ffmpeg = require("../../../lib/ffmpeg");

// تنزيل مصدر رابط إلى ملف محلي مع عدّ البايتات وفرض حد الحجم أثناء التنزيل
async function downloadUrlSource(url, destPath, maxBytes) {
  const resp = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(240000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VideoMerger/2.0; +https://vercel.com)",
      Accept: "*/*",
    },
  });
  if (!resp.ok) {
    throw finalError(`فشل تنزيل المصدر (HTTP ${resp.status})`, 500);
  }
  let total = 0;
  const counter = new (require("stream").Transform)({
    transform(chunk, enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(finalError(`حجم المصدر يتجاوز الحد المسموح (${limits.sourceMaxMb}MB)`, 413));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(resp.body), counter, fs.createWriteStream(destPath));
  } catch (e) {
    throw e.final ? e : finalError(`فشل تنزيل المصدر: ${e.message}`, 500);
  }
  return total;
}

// تحديث تقدم المهمة مع تهدئة لتقليل عدد الكتابات على Turso
function progressWriter(jobId) {
  let lastValue = -1;
  let lastTime = 0;
  return async function setProgress(p) {
    const value = Math.max(0, Math.min(99, Math.round(p)));
    const now = Date.now();
    if (value === lastValue || (now - lastTime < 1500 && value - lastValue < 2)) return;
    lastValue = value;
    lastTime = now;
    try {
      await dbm.updateJob(jobId, { progress: value, status: "processing" });
    } catch { /* تحديث التقدم ليس حرجًا */ }
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return options(res);
  if (req.method !== "POST") return methodNotAllowed(res, "POST");

  let tmpDir = null;
  try {
    const jobId = String(req.query.id ?? "");
    if (!jobId) return error(res, 400, "معرّف المهمة مطلوب");

    const job = await dbm.getJob(jobId);
    if (!job) return error(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");
    const base = publicBaseUrl(req);

    // حالات تُعاد فورًا دون إعادة تنفيذ
    if (job.status === "done") {
      return json(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${job.id}/video`,
        downloadUrl: `${base}/api/jobs/${job.id}/video?download=1`,
        size: job.size,
        duration: job.duration,
        resolution: job.resolution,
        expiresAt: job.expiresAt,
      });
    }
    if (job.status === "processing") {
      return json(res, 202, { status: "processing", progress: job.progress });
    }
    if (job.status === "failed") {
      return error(res, 409, `المهمة فشلت نهائيًا — ${job.error || "سبب غير محدد"}`, { status: "failed" });
    }

    // التحقق من اكتمال مصادر الملفات قبل البدء
    const sources = await dbm.listSources(jobId);
    for (const s of sources) {
      if (s.kind === "file") {
        const expected = s.size ?? 0;
        if (expected <= 0 || s.receivedBytes < expected) {
          return error(res, 409, `الرفع غير مكتمل للمصدر رقم ${s.seq + 1} (${s.receivedBytes}/${expected} بايت)`);
        }
      }
    }

    await dbm.updateJob(jobId, { status: "processing", progress: 2, error: null });
    const setProgress = progressWriter(jobId);
    tmpDir = path.join(os.tmpdir(), `merger-${jobId}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // سحب المصادر (0–40% من التقدم): روابط تُنزَّل، ملفات تُجمَّع من أجزاء Turso
    const localPaths = [];
    let doneSources = 0;
    for (const s of sources) {
      const dest = path.join(tmpDir, `src${s.seq}.bin`);
      if (s.kind === "url") {
        await downloadUrlSource(s.url, dest, limits.sourceMaxMb * 1024 * 1024);
      } else {
        await dbm.assembleSourceToTmp(jobId, s.seq, dest, limits.sourceMaxMb * 1024 * 1024);
      }
      doneSources++;
      await setProgress((doneSources / sources.length) * 40);
      localPaths.push(dest);
    }

    // فحص كل مصدر بـ ffprobe + التحقق من حدود المدد
    const infos = [];
    for (const p of localPaths) {
      const info = await ffmpeg.ffprobeInfo(p);
      if (!Number.isFinite(info.duration) || info.duration <= 0) {
        throw finalError("تعذر قراءة مدة أحد المصادر — تأكد أن الملف فيديو صالح", 400);
      }
      infos.push(info);
    }
    const totalDuration = infos.reduce((a, i) => a + i.duration, 0);
    if (totalDuration > limits.maxTotalDurationSec) {
      throw finalError(
        `مجموع مدد المقاطع (${totalDuration.toFixed(1)} ثانية) يتجاوز الحد المسموح (${limits.maxTotalDurationSec} ثانية)`,
        400
      );
    }

    // الترميز الموحد (40–90%): scale+pad لأكبر دقة (≤1080p) + fps=30 + concat
    const outPath = path.join(tmpDir, "result.mp4");
    const { width, height } = ffmpeg.targetDimensions(infos);
    await ffmpeg.runMerge(localPaths, infos, outPath, (frac) => {
      setProgress(40 + frac * 50).catch(() => {});
    });

    // تخزين الناتج في Turso كصفوف BLOB (90–99%)
    await setProgress(90);
    const size = await require("../../../lib/storage").storeOutputFile(
      jobId, outPath, limits.outputMaxMb * 1024 * 1024,
      (f) => { setProgress(90 + f * 9).catch(() => {}); }
    );

    // نجاح: حذف أجزاء المصادر + قفل الحالة النهائية
    await dbm.deleteSourceChunks(jobId);
    await dbm.updateJob(jobId, {
      status: "done",
      progress: 100,
      size,
      duration: Number(totalDuration.toFixed(2)),
      resolution: `${width}x${height}`,
      error: null,
    });

    json(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${jobId}/video`,
      downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
      size,
      duration: Number(totalDuration.toFixed(2)),
      resolution: `${width}x${height}`,
      expiresAt: job.expiresAt,
    });
  } catch (e) {
    // أي فشل معلن هنا نهائي — لا إعادة محاولة (تكرارها يعطي النتيجة نفسها)
    const msg = e.message || "فشل غير معروف أثناء الدمج";
    try {
      const jobId = String(req.query.id ?? "");
      if (jobId) await dbm.updateJob(jobId, { status: "failed", error: msg });
    } catch { /* تجاهل */ }
    error(res, e.statusCode || 500, msg);
  } finally {
    // نظّف الملفات المؤقتة دائمًا — لا اعتماد على نظام ملفات دائم
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* تجاهل */ }
    }
  }
};
