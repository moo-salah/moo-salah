// محرك الدمج (الأهم): ffprobe لفحص المصادر + ffmpeg للترميز الموحد عالي الجودة
// الناتج ثابت المواصفات: MP4 (H.264 CRF 18 + AAC 192k/44100Hz) + faststart — بلا معاملات resolution/fps
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { limits } = require("./limits");

// ثنائيات ffmpeg قد تفقد صلاحية التنفيذ على الاستضافة: ننسخها إلى /tmp بصلاحية 755 عند الحاجة
let _binaries = null;
function ensureExecutable() {
  if (_binaries) return _binaries;
  const ffmpegSrc = require("ffmpeg-static");
  const ffprobeSrc = require("ffprobe-static").path;
  const dir = path.join(os.tmpdir(), "merger-bin");
  const prep = (src, name) => {
    try {
      fs.accessSync(src, fs.constants.X_OK);
      return src;
    } catch {
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, name);
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
      return dst;
    }
  };
  _binaries = {
    ffmpeg: prep(ffmpegSrc, "ffmpeg"),
    ffprobe: prep(ffprobeSrc, "ffprobe"),
  };
  return _binaries;
}

function runBin(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`انتهت المهلة أثناء تشغيل ${path.basename(bin)}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().split("\n").slice(-4).join("\n") || `exit ${code}`));
    });
  });
}

// فحص مصدر: الدقة، معدل الإطارات، المدة، وجود صوت
async function ffprobeInfo(filePath) {
  const { ffprobe } = ensureExecutable();
  const { stdout } = await runBin(ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const meta = JSON.parse(stdout);
  const video = meta.streams?.find((s) => s.codec_type === "video");
  const audio = meta.streams?.find((s) => s.codec_type === "audio");
  if (!video) throw new Error("المصدر لا يحتوي مسار فيديو صالحًا");
  const fpsRaw = String(video.r_frame_rate || "0/1");
  const [num, den] = fpsRaw.split("/").map(Number);
  const fps = den ? num / den : 0;
  let duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = Number(meta.format?.duration);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    // محاولة أخيرة: قراءة المدة عبر ffmpeg نفسه
    duration = 0;
  }
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: Number.isFinite(fps) ? fps : 0,
    duration,
    hasAudio: Boolean(audio),
  };
}

function even(n) {
  n = Math.max(2, Math.floor(n));
  return n % 2 === 0 ? n : n - 1;
}

// أكبر دقة بين المدخلات بحد أقصى 1920×1080 وبأبعاد زوجية
function targetDimensions(infos) {
  const w = even(Math.min(1920, Math.max(...infos.map((i) => i.width || 0))));
  const h = even(Math.min(1080, Math.max(...infos.map((i) => i.height || 0))));
  return { width: w, height: h };
}

// بناء أمر ffmpeg الكامل: توحيد كل المصادر ثم concat
// مصدر بلا صوت؟ نضيف مسارًا صامتًا anullsrc بنفس مدته بدل أن يفشل الدمج
function buildMergeArgs(localPaths, infos, outPath, preset = limits.ffmpegPreset) {
  const { width, height } = targetDimensions(infos);
  const filterParts = [];
  const segments = [];
  const silentInputs = [];
  let silentCount = 0;

  infos.forEach((info, i) => {
    const dur = Math.max(0.01, info.duration).toFixed(3);
    filterParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
    );
    if (info.hasAudio) {
      filterParts.push(
        `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      );
    } else {
      const silentIdx = localPaths.length + silentCount;
      silentCount++;
      silentInputs.push({ idx: silentIdx, duration: dur });
      filterParts.push(
        `[${silentIdx}:a]atrim=duration=${dur},asetpts=N/SR/TB,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      );
    }
    segments.push(`[v${i}][a${i}]`);
  });

  filterParts.push(
    segments.join("") + `concat=n=${infos.length}:v=1:a=1[vout][aout]`
  );

  const args = ["-y", "-nostdin", "-progress", "pipe:1", "-nostats"];
  for (const p of localPaths) args.push("-i", p);
  for (const s of silentInputs) {
    args.push("-f", "lavfi", "-t", s.duration, "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`);
  }
  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", preset,
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-movflags", "+faststart",
    outPath
  );
  return { args, width, height };
}

// تشغيل الدمج مع قراءة تقدم الترميز من -progress pipe:1 (out_time_us)
function runMerge(localPaths, infos, outPath, onProgress) {
  const { ffmpeg } = ensureExecutable();
  const { args, width, height } = buildMergeArgs(localPaths, infos, outPath);
  const totalUs = infos.reduce((a, i) => a + Math.max(0, i.duration) * 1e6, 0);

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    let lastSent = 0;

    child.stdout.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        const m = line.trim().match(/^out_time_us=(\d+)/);
        if (m && totalUs > 0) {
          const frac = Math.min(1, Number(m[1]) / totalUs);
          if (frac - lastSent >= 0.01) {
            lastSent = frac;
            onProgress && onProgress(frac);
          }
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).split("\n").slice(-6).join("\n");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ width, height });
      else reject(new Error(`فشل ترميز ffmpeg: ${stderrTail.trim() || "exit " + code}`));
    });
  });
}

module.exports = { ensureExecutable, ffprobeInfo, targetDimensions, buildMergeArgs, runMerge };
