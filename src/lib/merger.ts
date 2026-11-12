// عميل خدمة دمج الفيديو — Video Merger API v2
// العنوان من MERGER_API_BASE — بلا مفاتيح أو توثيق. المخرجات: MP4 (H.264 + AAC) حتى 1080p.
// قواعد حتمية: أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري؛ أخطاء شبكتنا = مؤقتة وتستمر بالاستعلام.
import { randomUUID } from "crypto";
import { insertTask, getTask, updateTask, parseTaskUrls, type TaskRow } from "./turso";
import type { Notify, Outcome } from "./generation";

const MERGER_BASE = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

export function mergerConfigured(): boolean {
  return /^https?:\/\/.+/i.test(MERGER_BASE);
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 320000
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!mergerConfigured()) {
    throw new Error("خدمة الدمج غير مضبوطة على السيرفر (MERGER_API_BASE)");
  }
  let resp: Response;
  try {
    resp = await fetch(`${MERGER_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw Object.assign(new Error(`temporary merger network error: ${(e as Error).message}`), {
      temporary: true,
    });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: resp.status, body };
}

// تحليل الحالة دفاعيًا (قسم 7.2):
// أكمل: done|completed|complete|success|succeeded|finished — فشل: error|failed|failure|cancelled
// قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا. progress قد يأتي كسرًا 0..1.
const DONE_RE = /done|completed|complete|success|succeeded|finished/i;
const FAIL_RE = /error|failed|failure|cancelled/i;

export function parseMergeStatus(body: Record<string, unknown>): {
  status: "processing" | "done" | "failed";
  progress: number;
} {
  const raw = String(body?.status ?? "");
  const hasError = typeof body?.error === "string" && (body.error as string).length > 0;
  if (!raw && hasError) return { status: "failed", progress: 0 };
  if (DONE_RE.test(raw)) return { status: "done", progress: 100 };
  if (FAIL_RE.test(raw)) return { status: "failed", progress: 0 };
  let progress = Number(body?.progress ?? 0);
  if (progress > 0 && progress < 1) progress = progress * 100; // كسر 0..1 → اضربه في 100
  return { status: "processing", progress: Math.max(0, Math.min(100, progress)) };
}

// رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط من jobId
function pickResultUrl(body: Record<string, unknown>, jobId: string): string {
  if (typeof body?.videoUrl === "string" && body.videoUrl) return body.videoUrl;
  if (typeof body?.downloadUrl === "string" && body.downloadUrl) return body.downloadUrl;
  return `${MERGER_BASE}/api/jobs/${jobId}/video`;
}

// قفل في الذاكرة حتى لا يتزامن استدعاء process مع get_task (مرة واحدة فقط لكل مهمة)
const g = globalThis as unknown as { __mergerProcessInFlight?: Set<string> };
const processInFlight = (g.__mergerProcessInFlight ??= new Set<string>());

function kickProcess(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  mergerFetch(`/api/jobs/${jobId}/process`, { method: "POST" }, 330000)
    .catch(() => {
      /* أخطاء process تُكتشف من الاستعلام الدوري/refreshMergeTask */
    })
    .finally(() => processInFlight.delete(jobId));
}

// حلّ معرّفات المهام المكتملة إلى روابط بالترتيب — مع تفاصيل كل معرّف فاشل
async function resolveTaskUrls(taskIds: string[]): Promise<{ urls: string[]; failures: string[] }> {
  const urls: string[] = [];
  const failures: string[] = [];
  for (const id of taskIds) {
    const row = await getTask(id);
    if (!row) {
      failures.push(`المعرّف ${id}: غير موجود في قاعدة البيانات`);
      continue;
    }
    if (row.type !== "video") {
      failures.push(`المعرّف ${id}: نوعه «${row.type}» وليس فيديو`);
      continue;
    }
    if (row.status !== "completed") {
      failures.push(`المعرّف ${id}: حالته «${row.status}» وليست مكتملة`);
      continue;
    }
    const resultUrls = parseTaskUrls(row);
    if (!resultUrls.length) {
      failures.push(`المعرّف ${id}: مكتملة بدون روابط مخزنة`);
      continue;
    }
    urls.push(resultUrls[0]);
  }
  return { urls, failures };
}

export interface MergeArgs {
  urls?: string[];
  task_ids?: string[];
  wait_seconds?: number;
}

// تدفق runMerge وقواعده (قسم 7.3)
export async function runMerge(args: MergeArgs, notify?: Notify): Promise<Outcome> {
  const waitSeconds = Math.max(0, Math.min(240, Math.round(args.wait_seconds ?? 60)));

  // 1) تحقق صارم قبل أي تسجيل
  const taskIds = (args.task_ids ?? []).map(String);
  const directUrls = (args.urls ?? []).map((u) => String(u).trim());
  const resolved = taskIds.length ? await resolveTaskUrls(taskIds) : { urls: [], failures: [] };
  const failures = [...resolved.failures];
  // الترتيب: روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
  const urls = [...resolved.urls, ...directUrls];

  if (urls.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failures.length) msg += "\n\nتفاصيل المعرفات الفاشلة:\n- " + failures.join("\n- ");
    return { kind: "bad_params", message: msg };
  }
  if (urls.length > 10) {
    return { kind: "bad_params", message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  const badUrl = urls.find((u) => !/^https?:\/\/.+/i.test(u));
  if (badUrl) {
    return {
      kind: "bad_params",
      message: `❌ كل الروابط يجب أن تكون روابط فيديو مباشرة عامة (http/https) — الرابط غير الصالح: ${badUrl}`,
    };
  }
  if (!mergerConfigured()) {
    return {
      kind: "failed",
      message: "❌ خدمة الدمج غير مضبوطة على السيرفر — أضف متغير البيئة MERGER_API_BASE ثم أعد المحاولة.",
    };
  }

  // 2) سجّل مهمة type="merge", provider="merger", model="video-merger" في Turso أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    params_json: JSON.stringify({ urls, wait_seconds: waitSeconds }),
    status: "processing",
    progress: 0,
  });

  // 3) POST /api/jobs ثم إطلاق process خلفيًا وبمرة واحدة فقط
  let jobId: string;
  try {
    const created = await mergerFetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ videos: urls }),
    });
    if (created.status >= 400 || created.body?.error) {
      // خطأ معلن من الخدمة = فشل نهائي فوري
      const msg = String(created.body?.error || `HTTP ${created.status}`);
      await updateTask(taskId, { status: "failed", error_message: `خدمة الدمج رفضت إنشاء المهمة: ${msg}` });
      return { kind: "failed", taskId, message: `❌ فشلت المهمة: خدمة الدمج رفضت إنشاء المهمة (${msg})` };
    }
    jobId = String(created.body?.jobId ?? "");
    if (!jobId) {
      await updateTask(taskId, { status: "failed", error_message: "استجابة خدمة الدمج بلا jobId" });
      return { kind: "failed", taskId, message: "❌ فشلت المهمة: استجابة خدمة الدمج بلا معرّف" };
    }
  } catch (e) {
    if ((e as { temporary?: boolean }).temporary) {
      // خطأ شبكتنا نحن — المهمة تبقى processing وget_task سيعيد إنشاءها
      await updateTask(taskId, {}, { provider: "merger", ok: false, errorClass: "temporary", error: (e as Error).message, at: nowIso() });
      return { kind: "processing", taskId, model: "video-merger", type: "merge" };
    }
    await updateTask(taskId, { status: "failed", error_message: (e as Error).message });
    return { kind: "failed", taskId, message: `❌ فشلت المهمة: ${(e as Error).message}` };
  }

  await updateTask(taskId, { provider_task_id: jobId, progress: 5 }, { provider: "merger", ok: true, at: nowIso() });
  kickProcess(jobId);

  // 4) حتى نهاية نافذة الانتظار (افتراضي 60 ثانية): استعلام كل 3 ثوانٍ مع بث تقدم
  const deadline = Date.now() + waitSeconds * 1000;
  let progress = 5;
  await notify?.(progress, 100, "جارٍ الدمج… 5%");
  while (Date.now() < deadline) {
    await sleep(3000);
    let st: { status: number; body: Record<string, unknown> };
    try {
      st = await mergerFetch(`/api/jobs/${jobId}`);
    } catch (e) {
      if ((e as { temporary?: boolean }).temporary) continue; // أخطاء شبكتنا = مؤقتة → استمر حتى انتهاء النافذة
      throw e;
    }
    // 5) قاعدة حتمية: أي خطأ HTTP معلن (4xx/5xx بجسم error) = فشل نهائي فوري
    if (st.status >= 400) {
      const msg = String(st.body?.error || `HTTP ${st.status}`);
      await updateTask(taskId, { status: "failed", error_message: `خدمة الدمج أعلنت فشلًا: ${msg}` });
      return { kind: "failed", taskId, message: `❌ فشلت المهمة: خدمة الدمج أعلنت فشلًا (${msg})` };
    }
    const parsed = parseMergeStatus(st.body);
    if (parsed.status === "failed") {
      const msg = String(st.body?.error || "فشل غير محدد من خدمة الدمج");
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", taskId, message: `❌ فشلت المهمة: ${msg}` };
    }
    if (parsed.status === "done") {
      const url = pickResultUrl(st.body, jobId);
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([url]) });
      await notify?.(100, 100, "اكتمل الدمج ✅");
      return { kind: "completed", taskId, urls: [url], model: "video-merger", type: "merge" };
    }
    progress = Math.min(95, 10 + parsed.progress * 0.85);
    await updateTask(taskId, { progress: Math.round(progress) });
    await notify?.(progress, 100, `جارٍ الدمج… ${Math.round(progress)}%`);
  }

  // انتهت النافذة — المهمة تبقى processing والعميل يتابع بـ get_task
  return { kind: "processing", taskId, model: "video-merger", type: "merge", progress };
}

// refreshMergeTask لأداة get_task (قسم 7.3.6)
export async function refreshMergeTaskRow(row: TaskRow): Promise<Outcome> {
  if (row.status === "completed") {
    return { kind: "completed", taskId: row.id, urls: parseTaskUrls(row), model: row.model, type: "merge" };
  }
  if (row.status === "failed") {
    return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: ${row.error_message || "سبب غير معروف"}` };
  }
  if (!mergerConfigured()) {
    return { kind: "processing", taskId: row.id, model: row.model, type: "merge" };
  }

  const params = JSON.parse(row.params_json || "{}") as { urls?: string[] };
  let jobId = row.provider_task_id;

  // لا يوجد jobId (انقطع الاتصال عند الإنشاء؟) — نعيد إنشاء مهمة الدمج
  if (!jobId && params.urls?.length) {
    try {
      const created = await mergerFetch("/api/jobs", { method: "POST", body: JSON.stringify({ videos: params.urls }) });
      if (created.status >= 400 || created.body?.error || !created.body?.jobId) {
        const msg = String(created.body?.error || `HTTP ${created.status}`);
        await updateTask(row.id, { status: "failed", error_message: `خدمة الدمج رفضت إنشاء المهمة: ${msg}` });
        return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: خدمة الدمج رفضت إنشاء المهمة (${msg})` };
      }
      jobId = String(created.body.jobId);
      await updateTask(row.id, { provider_task_id: jobId, progress: 5 }, { provider: "merger", ok: true, at: nowIso() });
    } catch (e) {
      if ((e as { temporary?: boolean }).temporary) {
        return { kind: "processing", taskId: row.id, model: row.model, type: "merge" };
      }
      await updateTask(row.id, { status: "failed", error_message: (e as Error).message });
      return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: ${(e as Error).message}` };
    }
  }

  if (!jobId) {
    return { kind: "processing", taskId: row.id, model: row.model, type: "merge" };
  }

  try {
    const st = await mergerFetch(`/api/jobs/${jobId}`);
    // 404 → فشل نهائي: مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
    if (st.status === 404) {
      const msg = "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
      await updateTask(row.id, { status: "failed", error_message: msg });
      return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: ${msg}` };
    }
    if (st.status >= 400) {
      const msg = String(st.body?.error || `HTTP ${st.status}`);
      await updateTask(row.id, { status: "failed", error_message: `خدمة الدمج أعلنت فشلًا: ${msg}` });
      return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: خدمة الدمج أعلنت فشلًا (${msg})` };
    }
    const parsed = parseMergeStatus(st.body);
    if (parsed.status === "failed") {
      const msg = String(st.body?.error || "فشل غير محدد من خدمة الدمج");
      await updateTask(row.id, { status: "failed", error_message: msg });
      return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: ${msg}` };
    }
    if (parsed.status === "done") {
      const url = pickResultUrl(st.body, jobId);
      await updateTask(row.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify([url]) });
      return { kind: "completed", taskId: row.id, urls: [url], model: row.model, type: "merge" };
    }
    // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (محمي بقفل الذاكرة)
    const rawStatus = String(st.body?.status ?? "");
    if (/queued|uploading/i.test(rawStatus) && !processInFlight.has(jobId)) {
      kickProcess(jobId);
    }
    const progress = Math.min(95, 10 + parsed.progress * 0.85);
    await updateTask(row.id, { progress: Math.round(progress) });
    return { kind: "processing", taskId: row.id, model: row.model, type: "merge", progress };
  } catch (e) {
    if ((e as { temporary?: boolean }).temporary) {
      return { kind: "processing", taskId: row.id, model: row.model, type: "merge" };
    }
    await updateTask(row.id, { status: "failed", error_message: (e as Error).message });
    return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: ${(e as Error).message}` };
  }
}
