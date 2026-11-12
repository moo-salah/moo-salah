// الحدود القابلة للضبط عبر متغيرات البيئة — الافتراضيات مطابقة للمواصفة تمامًا
function intEnv(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const limits = {
  // أقصى عدد مقاطع في مهمة الدمج الواحدة
  maxSources: intEnv("MAX_SOURCES", 10),
  // أقصى حجم لكل مصدر (رابط أو ملف مرفوع) بالميغابايت
  sourceMaxMb: intEnv("SOURCE_MAX_MB", 200),
  // أقصى حجم للفيديو الناتج بالميغابايت
  outputMaxMb: intEnv("OUTPUT_MAX_MB", 150),
  // أقصى مجموع مدد المقاطع بالثواني
  maxTotalDurationSec: intEnv("MAX_TOTAL_DURATION_SEC", 600),
  // حجم قطعة الرفع الواحدة من الواجهة/العميل (حد Vercel ≈ 4.5MB للطلب الواحد)
  uploadChunkBytes: intEnv("UPLOAD_CHUNK_BYTES", 4 * 1024 * 1024),
  // حجم صف التخزين في Turso (حد HTTP آمن ≈ 2MB)
  blobChunkBytes: intEnv("BLOB_CHUNK_BYTES", 2 * 1024 * 1024),
  // عدد صفوف Blob المقروءة في كل استعلام (قراءة تدفقية بصفحات)
  readPageRows: intEnv("READ_PAGE_ROWS", 8),
  // مدة الاحتفاظ بالمهمة والناتج قبل الحذف التلقائي
  retentionHours: intEnv("RETENTION_HOURS", 24),
  // سرعة ترميز ffmpeg: ultrafast|superfast|veryfast|faster|fast|medium|slow
  ffmpegPreset: process.env.FFMPEG_PRESET || "medium",
};

module.exports = { limits };
