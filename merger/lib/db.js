// طبقة قاعدة البيانات (Turso/libSQL عبر HTTP) — الجداول + عمليات المهام + صفوف الـ Blobs
// لا توجد ملفات محلية إطلاقًا: كل شيء (المهام، أجزاء المصادر، الناتج) يُخزَّن في Turso
const crypto = require("crypto");
const { createClient } = require("@libsql/client");
const { limits } = require("./limits");

let _client = null;
function db() {
  if (!_client) {
    const url = (process.env.TURSO_DATABASE_URL || "").trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
    if (!url || !authToken) {
      throw Object.assign(
        new Error(
          "متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة — راجع إعدادات النشر"
        ),
        { statusCode: 500 }
      );
    }
    _client = createClient({ url, authToken });
  }
  return _client;
}

// إعادة محاولة تلقائية للأخطاء الشبكية العابرة فقط (لا نعيد محاولة أخطاء SQL نفسها)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransient(e) {
  const msg = `${e?.message || ""} ${e?.cause?.code || ""} ${e?.code || ""}`;
  return /fetch failed|socket|ECONNRESET|EPIPE|UND_ERR|timed out|aborted|network|other side closed/i.test(
    msg
  );
}
async function execute(stmt, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await db().execute(stmt);
    } catch (e) {
      if (i >= tries - 1 || !isTransient(e)) throw e;
      await sleep(250 * (i + 1));
    }
  }
}
async function batch(statements, mode = "write", tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await db().batch(statements, mode);
    } catch (e) {
      if (i >= tries - 1 || !isTransient(e)) throw e;
      await sleep(250 * (i + 1));
    }
  }
}

// إنشاء الجداول عند أول وصول — بلا أداة migrations (CREATE TABLE IF NOT EXISTS)
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = db()
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'queued',
            progress INTEGER NOT NULL DEFAULT 0,
            sources_json TEXT NOT NULL DEFAULT '[]',
            error TEXT,
            size INTEGER,
            duration REAL,
            resolution TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS sources (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            url TEXT,
            name TEXT,
            mime TEXT,
            size INTEGER,
            received_bytes INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_id, seq)
          )`,
          `CREATE TABLE IF NOT EXISTS source_chunks (
            job_id TEXT NOT NULL,
            source_seq INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, source_seq, chunk_index)
          )`,
          `CREATE TABLE IF NOT EXISTS output_chunks (
            job_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, chunk_index)
          )`,
        ],
        "write"
      )
      .catch((e) => {
        schemaPromise = null; // نسمح بإعادة المحاولة في الطلب التالي
        throw e;
      });
  }
  return schemaPromise;
}

// معرّف مهمة قصير صغير الحروف مثل الأمثلة الحقيقية للخدمة
function newJobId() {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(11);
  let id = "";
  for (const b of bytes) id += abc[b % abc.length];
  return id;
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    progress: Number(row.progress ?? 0),
    sources: JSON.parse(row.sources_json || "[]"),
    error: row.error ?? null,
    size: row.size != null ? Number(row.size) : null,
    duration: row.duration != null ? Number(row.duration) : null,
    resolution: row.resolution ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function expiresDate() {
  return new Date(Date.now() + limits.retentionHours * 3600 * 1000).toISOString();
}

async function insertJob(sources) {
  await ensureSchema();
  const id = newJobId();
  const hasFiles = sources.some((s) => s.kind === "file");
  const status = hasFiles ? "uploading" : "queued";
  const expiresAt = expiresDate();
  await execute({
    sql: "INSERT INTO jobs (id, status, progress, sources_json, created_at, expires_at) VALUES (?, ?, 0, ?, ?, ?)",
    args: [id, status, JSON.stringify(sources), new Date().toISOString(), expiresAt],
  });
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    await execute({
      sql: "INSERT INTO sources (job_id, seq, kind, url, name, mime, size, received_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      args: [id, i, s.kind, s.url ?? null, s.name ?? null, s.mime ?? null, s.size ?? null],
    });
  }
  return { id, status, expiresAt };
}

async function getJob(id) {
  await ensureSchema();
  const res = await execute({
    sql: "SELECT * FROM jobs WHERE id = ?",
    args: [id],
  });
  return rowToJob(res.rows[0]);
}

// تحديث جزئي للمهمة (patch) — يبني SET ديناميكيًا من المفاتيح المسموحة
const JOB_FIELDS = new Set([
  "status",
  "progress",
  "error",
  "size",
  "duration",
  "resolution",
]);
async function updateJob(id, patch) {
  await ensureSchema();
  const keys = Object.keys(patch).filter((k) => JOB_FIELDS.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const args = keys.map((k) => patch[k]);
  args.push(id);
  await execute({ sql: `UPDATE jobs SET ${sets} WHERE id = ?`, args });
}

async function listSources(jobId) {
  const res = await execute({
    sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    url: r.url ?? null,
    name: r.name ?? null,
    mime: r.mime ?? null,
    size: r.size != null ? Number(r.size) : null,
    receivedBytes: Number(r.received_bytes ?? 0),
  }));
}

// ---------- أجزاء المصادر المرفوعة ----------

// تخزين قطعة رفع واحدة (≤ uploadChunkBytes) — تُقسَّم داخليًا لصفوف 2MB
async function insertSourceChunk(jobId, sourceSeq, uploadChunkIndex, buffer) {
  const perUpload = Math.ceil(limits.uploadChunkBytes / limits.blobChunkBytes);
  const base = uploadChunkIndex * perUpload;
  for (let offset = 0, j = 0; offset < buffer.length; offset += limits.blobChunkBytes, j++) {
    const piece = buffer.subarray(offset, offset + limits.blobChunkBytes);
    await execute({
      sql: "INSERT OR REPLACE INTO source_chunks (job_id, source_seq, chunk_index, data) VALUES (?, ?, ?, ?)",
      args: [jobId, sourceSeq, base + j, Buffer.from(piece)],
    });
  }
  await execute({
    sql: "UPDATE sources SET received_bytes = received_bytes + ? WHERE job_id = ? AND seq = ?",
    args: [buffer.length, jobId, sourceSeq],
  });
}

// قراءة صفحات من أجزاء مصدر — للاختبار والتجميع التدفقي
async function readSourceChunksPage(jobId, sourceSeq, fromIndex, rowsCount) {
  const res = await execute({
    sql: "SELECT chunk_index, data FROM source_chunks WHERE job_id = ? AND source_seq = ? AND chunk_index >= ? ORDER BY chunk_index ASC LIMIT ?",
    args: [jobId, sourceSeq, fromIndex, rowsCount],
  });
  return res.rows.map((r) => ({
    chunkIndex: Number(r.chunk_index),
    data: Buffer.from(r.data),
  }));
}

// تجميع مصدر مرفوع إلى ملف محلي مؤقت للتشفير — مع فرض حد الحجم أثناء التجميع
async function assembleSourceToTmp(jobId, sourceSeq, destPath, maxBytes) {
  await fsPromises.mkdir(require("path").dirname(destPath), { recursive: true });
  const out = require("fs").createWriteStream(destPath);
  let written = 0;
  let nextIndex = 0;
  while (true) {
    const rows = await readSourceChunksPage(jobId, sourceSeq, nextIndex, limits.readPageRows);
    if (!rows.length) break;
    for (const row of rows) {
      written += row.data.length;
      if (written > maxBytes) {
        out.destroy();
        throw Object.assign(
          new Error(
            `حجم المصدر المرفوع يتجاوز الحد المسموح (${limits.sourceMaxMb}MB)`
          ),
          { final: true, statusCode: 413 }
        );
      }
      if (!out.write(row.data)) {
        await new Promise((r) => out.once("drain", r));
      }
    }
    nextIndex = rows[rows.length - 1].chunkIndex + 1;
  }
  await new Promise((resolve, reject) => out.end(resolve));
  return written;
}

// ---------- الناتج ----------

async function insertOutputChunk(jobId, chunkIndex, buffer) {
  await execute({
    sql: "INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)",
    args: [jobId, chunkIndex, buffer],
  });
}

async function readOutputPage(jobId, fromIndex, rowsCount) {
  const res = await execute({
    sql: "SELECT chunk_index, data FROM output_chunks WHERE job_id = ? AND chunk_index >= ? ORDER BY chunk_index ASC LIMIT ?",
    args: [jobId, fromIndex, rowsCount],
  });
  return res.rows.map((r) => ({
    chunkIndex: Number(r.chunk_index),
    data: Buffer.from(r.data),
  }));
}

async function countOutputBytes(jobId) {
  const res = await execute({
    sql: "SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM output_chunks WHERE job_id = ?",
    args: [jobId],
  });
  return Number(res.rows[0]?.total ?? 0);
}

// بعد نجاح الدمج نحذف أجزاء المصادر — الناتج فقط هو المطلوب
async function deleteSourceChunks(jobId) {
  await execute({
    sql: "DELETE FROM source_chunks WHERE job_id = ?",
    args: [jobId],
  });
}

// حذف شامل فوري للمهمة من الجداول الأربعة في دفعة واحدة
async function deleteJob(jobId) {
  await ensureSchema();
  await batch(
    [
      { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
    ],
    "write"
  );
}

// التنظيف الكسول: حذف كل المهام التي انتهت صلاحيتها (يُستدعى عند كل إنشاء/دمج + نقطة /api/cron)
async function cleanupExpired() {
  await ensureSchema();
  const now = new Date().toISOString();
  const res = await execute({
    sql: "SELECT id FROM jobs WHERE expires_at < ?",
    args: [now],
  });
  let deleted = 0;
  for (const row of res.rows) {
    await deleteJob(row.id);
    deleted++;
  }
  return deleted;
}

// fp/fs helpers (تُستخدم هنا وداخل storage.js)
const fs = require("fs");
const fsPromises = fs.promises;

module.exports = {
  db,
  ensureSchema,
  newJobId,
  insertJob,
  getJob,
  updateJob,
  listSources,
  insertSourceChunk,
  readSourceChunksPage,
  assembleSourceToTmp,
  insertOutputChunk,
  readOutputPage,
  countOutputBytes,
  deleteSourceChunks,
  deleteJob,
  cleanupExpired,
};
