// أدوات HTTP مشتركة: CORS مفتوح، ردود JSON، قراءة الجسم الخام، وأخطاء بصيغة {"error":"..."}
const { limits } = require("./limits");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers":
    "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
  "Access-Control-Max-Age": "86400",
};

function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function json(res, code, obj) {
  setCors(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

// كل الأخطاء بصيغة موحدة {"error":"رسالة عربية واضحة"}
function error(res, code, message, extra) {
  json(res, code, { error: message, ...(extra || {}) });
}

function options(res) {
  setCors(res);
  res.statusCode = 204;
  res.end();
}

function methodNotAllowed(res, allowed) {
  error(res, 405, `الطريقة غير مسموحة — المسموح: ${allowed}`);
}

// قراءة الجسم الخام (ثنائي) بحد أقصى — لتجاوز الحد نرمي خطأ 413
function readRawBody(req, maxBytes = limits.uploadChunkBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(
          Object.assign(
            new Error(
              `حجم الجسم يتجاوز الحد المسموح (${Math.floor(maxBytes / 1024 / 1024)}MB)`
            ),
            { statusCode: 413 }
          )
        );
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// قراءة جسم JSON مع رسائل عربية للتالف/الفارغ
function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return readRawBody(req, maxBytes).then((buf) => {
    const text = buf.toString("utf8").trim();
    if (!text) {
      throw Object.assign(new Error("الجسم مطلوب بصيغة JSON"), {
        statusCode: 400,
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error("JSON تالف — لا يمكن تحليل الجسم"), {
        statusCode: 400,
      });
    }
  });
}

// الرابط العام للنتائج: يُحترم MERGER_PUBLIC_BASE إن ضُبط، وإلا يُستنتج من ترويسات الوكيل
function publicBaseUrl(req) {
  if (process.env.MERGER_PUBLIC_BASE) {
    return process.env.MERGER_PUBLIC_BASE.replace(/\/+$/, "");
  }
  const proto = String(req.headers["x-forwarded-proto"] || "http")
    .split(",")[0]
    .trim();
  const host = String(
    req.headers["x-forwarded-host"] || req.headers.host || "localhost"
  );
  return `${proto}://${host}`;
}

// خطأ "نهائي" — لا يعاد الاتصال به عند المزود (فشل حتمي حسب المواصفة)
function finalError(message, statusCode) {
  return Object.assign(new Error(message), { final: true, statusCode });
}

module.exports = {
  setCors,
  json,
  error,
  options,
  methodNotAllowed,
  readRawBody,
  readJsonBody,
  publicBaseUrl,
  finalError,
};
