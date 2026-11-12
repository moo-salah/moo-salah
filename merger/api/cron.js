// GET /api/cron — حذف كل المهام المنتهية الصلاحية (مجدول يوميًا عبر vercel.json + تنظيف كسول)
const { json, options, methodNotAllowed } = require("../lib/http");
const dbm = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return options(res);
  if (req.method !== "GET") return methodNotAllowed(res, "GET");
  try {
    const deleted = await dbm.cleanupExpired();
    json(res, 200, { ok: true, deleted, at: new Date().toISOString() });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
};
