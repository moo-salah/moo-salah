#!/usr/bin/env node
// خادم تطوير محلي يحاكي بيئة Vercel: يحلّل المسارات الديناميكية ويضعها في req.query
// ويقدّم public/ ثابتًا ويستدعي نفس دوال api/ المستخدمة على Vercel حرفيًا
require("./lib/env");

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3001);
const PUBLIC_DIR = path.join(__dirname, "public");

// تحميل دوال الـ API نفسها التي تُنشر على Vercel
const handlers = {
  config: require("./api/config"),
  jobsCreate: require("./api/jobs"),
  job: require("./api/jobs/[id].js"),
  jobProcess: require("./api/jobs/[id]/process.js"),
  jobVideo: require("./api/jobs/[id]/video.js"),
  upload: require("./api/upload"),
  cron: require("./api/cron"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.statusCode = 404;
    return res.end("Not Found");
  }
  const ext = path.extname(full).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  req.query = Object.fromEntries(url.searchParams);
  const p = url.pathname;

  try {
    // التوجيه — نفس أشكال نقاط النهاية المعلنة في التوثيق
    if (p === "/api/config") return await handlers.config(req, res);
    if (p === "/api/jobs") return await handlers.jobsCreate(req, res);
    if (p === "/api/upload") return await handlers.upload(req, res);
    if (p === "/api/cron") return await handlers.cron(req, res);

    let m = p.match(/^\/api\/jobs\/([^/]+)\/process$/);
    if (m) {
      req.query.id = decodeURIComponent(m[1]);
      return await handlers.jobProcess(req, res);
    }
    m = p.match(/^\/api\/jobs\/([^/]+)\/video$/);
    if (m) {
      req.query.id = decodeURIComponent(m[1]);
      return await handlers.jobVideo(req, res);
    }
    m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m) {
      req.query.id = decodeURIComponent(m[1]);
      return await handlers.job(req, res);
    }

    if (p.startsWith("/api/")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "نقطة النهاية غير موجودة" }));
    }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error("[dev-server]", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: e.message || "خطأ داخلي" }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`✅ Video Merger API (dev) يعمل على http://localhost:${PORT}`);
  console.log(`   الواجهة: http://localhost:${PORT}/`);
  console.log(`   فحص الجهوزية: http://localhost:${PORT}/api/config`);
});
