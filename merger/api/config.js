// GET /api/config — الحدود العامة + إصدار الخدمة (تُستخدم لفحص الجهوزية)
const { limits } = require("../lib/limits");
const { json, options, methodNotAllowed } = require("../lib/http");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return options(res);
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  json(res, 200, {
    version: "2.0.0",
    limits: {
      maxSources: limits.maxSources,
      sourceMaxMb: limits.sourceMaxMb,
      outputMaxMb: limits.outputMaxMb,
      maxTotalDurationSec: limits.maxTotalDurationSec,
      uploadChunkBytes: limits.uploadChunkBytes,
      retentionHours: limits.retentionHours,
    },
    output: {
      container: "mp4",
      video: "H.264 CRF 18",
      audio: "AAC 192k / 44100Hz",
      fps: 30,
      maxResolution: "1920x1080",
      resolutionNote: "الناتج يُوحَّد على أكبر دقة بين المدخلات (بحد 1080p) — لا توجد معاملات resolution/fps",
    },
    storage: "turso-blobs",
    deletionAfterHours: limits.retentionHours,
  });
};
