// تخزين واسترجاع الوسائط كصفوف BLOB في Turso — 2MB لكل صف وقراءة تدفقية بصفحات من 8 صفوف
const fs = require("fs");
const { limits } = require("./limits");
const dbm = require("./db");

// تخزين ملف الناتج في صفوف 2MB — مع فرض حد الحجم قبل البدء
async function storeOutputFile(jobId, filePath, maxBytes, onProgress) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw Object.assign(
      new Error(
        `حجم الناتج (${(stat.size / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${Math.floor(maxBytes / 1048576)}MB)`
      ),
      { statusCode: 413 }
    );
  }
  // نجمع البايتات في تراكم ونقطع صفوفًا بحجم 2MB بالضبط (عدا الأخير) —
  // هذا إلزامي لدقة حساب المدى (Range) لاحقًا: chunk_index × 2MB = إزاحة البداية
  const stream = fs.createReadStream(filePath, { highWaterMark: limits.blobChunkBytes });
  let index = 0;
  let written = 0;
  let pending = Buffer.alloc(0);
  const flushFull = async () => {
    while (pending.length >= limits.blobChunkBytes) {
      const piece = pending.subarray(0, limits.blobChunkBytes);
      await dbm.insertOutputChunk(jobId, index++, Buffer.from(piece));
      written += piece.length;
      pending = pending.subarray(limits.blobChunkBytes);
      if (onProgress) onProgress(written / stat.size);
    }
  };
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    await flushFull();
  }
  if (pending.length) {
    await dbm.insertOutputChunk(jobId, index++, pending);
    written += pending.length;
    if (onProgress) onProgress(1);
  }
  return written;
}

// قراءة مدى بايتات محدد [start..end] من صفوف الـ Blobs بصفحات — تُمرَّر فقط الأجزاء المتداخلة
async function readOutputRange(jobId, start, end, write) {
  const pageSize = limits.readPageRows;
  let nextIndex = Math.floor(start / limits.blobChunkBytes);
  let coveredEnd = -1;
  while (coveredEnd < end) {
    const rows = await dbm.readOutputPage(jobId, nextIndex, pageSize);
    if (!rows.length) break;
    for (const row of rows) {
      const chunkStart = row.chunkIndex * limits.blobChunkBytes;
      const chunkEnd = chunkStart + row.data.length - 1;
      const s = Math.max(start, chunkStart);
      const e = Math.min(end, chunkEnd);
      if (s <= e) {
        write(row.data.subarray(s - chunkStart, e - chunkStart + 1));
      }
      coveredEnd = Math.max(coveredEnd, chunkEnd);
    }
    nextIndex = rows[rows.length - 1].chunkIndex + 1;
  }
}

module.exports = { storeOutputFile, readOutputRange };
