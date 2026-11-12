// تحميل يدوي لملف .env (بدون أي مكتبة خارجية) — لا نستبدل قيمًا موجودة مسبقًا في process.env
// هذا يحاكي سلوك Vercel الذي يحقن متغيرات البيئة مباشرة، ويسمح بالتشغيل المحلي بملف .env
const fs = require("fs");
const path = require("path");

function loadEnvFile(dir) {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
  return true;
}

loadEnvFile(path.join(__dirname, ".."));

module.exports = { loadEnvFile };
