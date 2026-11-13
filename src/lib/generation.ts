// منسّق التوليد — يطبّق سلوك التبديل «لا توقف أبدًا»:
// 1) جرّب المرشحين بالترتيب الصارم حتى نجاح الإنشاء (كل محاولة تُسجَّل + عدّادات المفتاح تتحدث)
// 2) أثناء نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم حي
// 3) فشل مفتاح/رصيد في أي لحظة → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي صامتة
// 4) فشل على كل المفاتيح → المهمة تبقى processing وتُعاد المحاولة مع كل get_task (تهدئة ~45 ثانية)
// 5) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا
import { randomUUID } from "crypto";
import { MODELS, findModel, type MediaType, type ModelDef, type ProviderId } from "./models";
import {
  KEY_BALANCE_FAIL_RE,
  ProviderError,
  bumpKeyStats,
  classifyProviderError,
  errorClassOf,
  getKeyById,
  getKeyPool,
  type ApiKeyRow,
} from "./keys";
import {
  insertTask,
  parseTaskAttempts,
  getTask,
  updateTask,
  type TaskRow,
} from "./turso";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import { toProviderKey, type CheckTaskResult, type ProviderAdapter } from "./providers/types";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export type Notify = (progress: number, total: number, message: string) => Promise<void> | void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

export type Outcome =
  | { kind: "completed"; taskId: string; urls: string[]; model: string; type: MediaType }
  | { kind: "processing"; taskId: string; model: string; type: MediaType; progress?: number }
  | { kind: "failed"; taskId?: string; message: string }
  | { kind: "no_keys"; model: string; message: string }
  | { kind: "bad_params"; message: string };

export interface GenerationRequest {
  type: "image" | "video";
  modelInput: string;
  prompt?: string;
  params: Record<string, unknown>; // كل معطيات الطلب الأصلية (لإعادة الإنشاء عند التبديل)
  waitSeconds: number; // 0–240
  notify?: Notify;
}

interface Bound {
  key: ApiKeyRow;
  provider: ProviderId;
  providerTaskId: string;
}

// نسب النسب المدعومة فعليًا لدى المزود (من توثيق docs.kie.ai — لا نخترع حقولًا)
const KIE_IMAGE_RATIOS = new Set(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"]);
const KIE_VIDEO_RATIOS = new Set(["1:1", "16:9", "9:16", "3:2", "2:3"]);
const GEMINI_RATIOS = new Set(["16:9", "9:16", "auto"]);
const SEEDANCE_RATIOS = new Set(["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"]);

// بناء input المزود من معطيات الأداة الأصلية
export function buildProviderInput(
  type: "image" | "video",
  _provider: ProviderId,
  params: Record<string, unknown>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (type === "image") {
    input.prompt = String(params.prompt ?? "");
    const ar = params.aspect_ratio ? String(params.aspect_ratio) : "auto";
    if (ar !== "auto" && KIE_IMAGE_RATIOS.has(ar)) input.aspect_ratio = ar;
    const res = params.resolution ? String(params.resolution) : "1K";
    if (["1K", "2K", "4K"].includes(res)) input.resolution = res;
    const bg = params.background ? String(params.background) : "auto";
    if (bg !== "auto" && res === "1K") input.background = bg; // الخلفية مدعومة عند 1K فقط
  } else {
    const modelName = String(params.model ?? "");
    input.prompt = String(params.prompt ?? "");
    const ar = params.aspect_ratio ? String(params.aspect_ratio) : "auto";

    // 1) موديل google/gemini-omni-flash-1-2 (مثبت على 360p فقط لتوفير الرصيد)
    if (modelName.includes("gemini-omni")) {
      if (params.image_url) input.image_urls = [String(params.image_url)];
      if (GEMINI_RATIOS.has(ar) && ar !== "auto") input.aspect_ratio = ar;
      input.resolution = "360p";
      const dur = params.duration != null ? Number(params.duration) : 8;
      input.duration = Math.min(15, Math.max(3, dur));
      return input;
    }

    // 2) موديل bytedance/seedance-2-5 (مثبت على أقل جودة مدعومة 480p لتوفير الرصيد)
    if (modelName.includes("seedance")) {
      if (params.image_url) input.reference_image_urls = [String(params.image_url)];
      if (SEEDANCE_RATIOS.has(ar) && ar !== "auto") input.aspect_ratio = ar;
      input.resolution = "480p";
      const dur = params.duration != null ? Number(params.duration) : 8;
      input.duration = Math.min(30, Math.max(4, dur));
      if (params.enable_audio != null) input.generate_audio = Boolean(params.enable_audio);
      return input;
    }

    // 3) الموديل الافتراضي grok-imagine-video-1-5-preview
    if (params.image_url) input.image_url = String(params.image_url);
    if (ar !== "auto" && KIE_VIDEO_RATIOS.has(ar)) input.aspect_ratio = ar;
    input.resolution = "480p";
    if (params.duration != null) input.duration = Number(params.duration);
    if (params.enable_audio != null) input.enable_audio = Boolean(params.enable_audio);
  }
  return input;
}

// هل مضت فترة تهدئة كافية (45 ثانية) منذ آخر محاولة؟ — لمنع ضغط المزودين مع كل get_task
function cooldownPassed(row: TaskRow, ms = 45000): boolean {
  const attempts = parseTaskAttempts(row);
  const last = attempts[attempts.length - 1];
  if (!last?.at) return true;
  const t = Date.parse(last.at);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t >= ms;
}

// محاولة الإنشاء على مرشحين بالترتيب — تسجيل كل محاولة وتحديث العدّادات دائمًا
async function attemptCreation(
  taskId: string,
  modelDef: ModelDef,
  req: { type: "image" | "video"; params: Record<string, unknown>; prompt?: string },
  candidates: ApiKeyRow[],
  triedKeyIds: Set<string>
): Promise<{ bound: Bound | null; stop?: Outcome }> {
  for (const key of candidates) {
    if (triedKeyIds.has(key.id)) continue;
    triedKeyIds.add(key.id);
    const adapter = ADAPTERS[key.provider];
    const input = buildProviderInput(req.type, key.provider, req.params);
    try {
      const r = await adapter.createTask(toProviderKey(key), modelDef.providerModel[key.provider]!, input);
      await bumpKeyStats(key.id, true);
      await updateTask(
        taskId,
        { provider: key.provider, provider_task_id: r.providerTaskId, key_id: key.id, status: "processing", progress: 5, error_message: null },
        { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: nowIso() }
      );
      return { bound: { key, provider: key.provider, providerTaskId: r.providerTaskId } };
    } catch (e) {
      const err = e as Error;
      const cls = errorClassOf(e);
      await bumpKeyStats(key.id, false, err.message);
      await updateTask(taskId, {}, {
        provider: key.provider,
        keyId: key.id,
        keyLabel: key.label,
        ok: false,
        errorClass: cls,
        error: err.message,
        at: nowIso(),
      });
      if (cls === "disabled") {
        await import("./keys").then((m) => m.setKeyStatus(key.id, "disabled", err.message));
      } else if (cls === "exhausted") {
        await import("./keys").then((m) => m.setKeyStatus(key.id, "exhausted", err.message));
      }
      if (cls === "params") {
        // خطأ معطيات — تبديل المفاتيح لن يحلّه: توقف فورًا
        return {
          bound: null,
          stop: { kind: "failed", taskId, message: `❌ فشلت المهمة: ${err.message}` },
        };
      }
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي
    }
  }
  return { bound: null };
}

// إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي (فشل مفتاح/رصيد في منتصف المهمة)
async function recreateOnNextKey(
  taskId: string,
  modelDef: ModelDef,
  req: { type: "image" | "video"; params: Record<string, unknown>; prompt?: string },
  triedKeyIds: Set<string>
): Promise<Bound | null> {
  const pool = await getKeyPool(modelDef.providers); // حالات المفاتيح محدَّثة بعد التعليم
  const candidates = pool.filter((k) => !triedKeyIds.has(k.id));
  const r = await attemptCreation(taskId, modelDef, req, candidates, triedKeyIds);
  return r.bound;
}

function waitModeOutcome(taskId: string, model: string, type: MediaType, progress?: number): Outcome {
  // مهمة تبقى processing (وليست failed) — برسالة داخلية «بانتظار توفر مفتاح صالح…»
  return { kind: "processing", taskId, model, type, progress };
}

async function saveInternalWaitingNote(taskId: string): Promise<void> {
  // رسالة داخلية فقط — لا تخرج أبدًا للعميل
  await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
}

// نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم + تبديل صامت عند فشل مفتاح/رصيد
async function waitWindow(
  taskId: string,
  modelDef: ModelDef,
  req: { type: "image" | "video"; params: Record<string, unknown>; prompt?: string },
  bound: Bound,
  triedKeyIds: Set<string>,
  waitSeconds: number,
  notify?: Notify
): Promise<Outcome> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let progress = 5;
  await notify?.(progress, 100, "قيد التوليد… 5%");

  while (Date.now() < deadline) {
    let r: CheckTaskResult;
    try {
      r = await ADAPTERS[bound.provider].checkTask(toProviderKey(bound.key), bound.providerTaskId);
    } catch (e) {
      const cls = errorClassOf(e);
      await bumpKeyStats(bound.key.id, false, (e as Error).message);
      if (cls === "disabled" || cls === "exhausted") {
        const next = await recreateOnNextKey(taskId, modelDef, req, triedKeyIds);
        if (!next) {
          await saveInternalWaitingNote(taskId);
          return waitModeOutcome(taskId, modelDef.canonical, modelDef.type, progress);
        }
        bound = next;
        continue;
      }
      // temporary / provider → استمر بالاستعلام حتى انتهاء النافذة
      await sleep(3000);
      continue;
    }

    if (r.status === "completed" && r.urls?.length) {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(r.urls) });
      await notify?.(100, 100, "اكتمل التوليد ✅");
      return { kind: "completed", taskId, urls: r.urls, model: modelDef.canonical, type: modelDef.type };
    }

    if (r.status === "failed") {
      const msg = r.error || "فشل المزود";
      if (KEY_BALANCE_FAIL_RE.test(msg)) {
        // فشل مفتاح/رصيد — العميل لا يرى شيئًا: نعيد الإنشاء بنفس task_id ونستمر
        const next = await recreateOnNextKey(taskId, modelDef, req, triedKeyIds);
        if (!next) {
          await saveInternalWaitingNote(taskId);
          return waitModeOutcome(taskId, modelDef.canonical, modelDef.type, progress);
        }
        bound = next;
        continue;
      }
      // فشل حقيقي (انتهاك سياسة/معطيات) — يُعرض سببه
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", taskId, message: `❌ فشلت المهمة: ${msg}` };
    }

    progress = Math.min(95, Math.max(progress + 2, r.progress ?? progress));
    await updateTask(taskId, { progress });
    await notify?.(progress, 100, `قيد التوليد… ${progress}%`);
    await sleep(3000);
  }

  return waitModeOutcome(taskId, modelDef.canonical, modelDef.type, progress);
}

// التدفق الرئيسي لأداة generate_image / generate_video
export async function runGeneration(req: GenerationRequest): Promise<Outcome> {
  // 1) توحيد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري
  const modelDef = findModel(req.modelInput);
  if (!modelDef || modelDef.type !== req.type) {
    return {
      kind: "bad_params",
      message: `❌ موديل غير معروف: ${req.modelInput || "(فارغ)"} — المتاح: ${MODELS.map((m) => m.canonical).join(" ، ")}`,
    };
  }

  // 2) جلب مرشحي المفاتيح بالترتيب الصارم — فارغ → رد no_keys بالصياغة المحددة
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) {
    return {
      kind: "no_keys",
      model: modelDef.canonical,
      message: `❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type: req.type,
    prompt: String(req.prompt ?? ""),
    params_json: JSON.stringify({ ...req.params, model: req.modelInput, wait_seconds: req.waitSeconds }),
    status: "processing",
    progress: 0,
  });

  // 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const triedKeyIds = new Set<string>();
  const creation = await attemptCreation(taskId, modelDef, req, pool, triedKeyIds);
  if (creation.stop) return creation.stop;
  if (!creation.bound) {
    // فشل الإنشاء على كل المفاتيح → processing بانتظار مفتاح صالح (تُعاد المحاولة مع كل get_task)
    await saveInternalWaitingNote(taskId);
    return waitModeOutcome(taskId, modelDef.canonical, modelDef.type);
  }

  // 5) نافذة الانتظار مع بث التقدم
  return await waitWindow(taskId, modelDef, req, creation.bound, triedKeyIds, req.waitSeconds, req.notify);
}

// refreshTask لأداة get_task: المهمة الجارية تُحدَّث حية من المزود بنفس منطق التبديل أعلاه
export async function refreshTask(taskId: string): Promise<Outcome> {
  const row = await getTask(taskId);
  if (!row) {
    return { kind: "failed", message: `❌ لم يتم العثور على المهمة: ${taskId}` };
  }
  if (row.type === "merge") {
    // مهمة دمج — منطقها في merger.ts (يُستدعى من هنا لتجنب التبعية الدائرية)
    const { refreshMergeTaskRow } = await import("./merger");
    return refreshMergeTaskRow(row);
  }
  if (row.status === "completed") {
    return { kind: "completed", taskId: row.id, urls: parseUrls(row), model: row.model, type: row.type };
  }
  if (row.status === "failed") {
    return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: ${row.error_message || "سبب غير معروف"}` };
  }

  const modelDef = findModel(row.model);
  if (!modelDef) {
    return { kind: "failed", taskId: row.id, message: `❌ موديل المهمة غير معروف: ${row.model}` };
  }
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.params_json || "{}");
  } catch {
    params = {};
  }
  const req = { type: row.type as "image" | "video", params, prompt: row.prompt };

  // لا يوجد provider_task_id: الإنشاء فشل سابقًا على كل المفاتيح — نعيد المحاولة بعد تهدئة 45 ثانية
  if (!row.provider_task_id) {
    if (!cooldownPassed(row)) {
      return waitModeOutcome(row.id, row.model, row.type, row.progress);
    }
    const pool = await getKeyPool(modelDef.providers);
    if (!pool.length) return waitModeOutcome(row.id, row.model, row.type, row.progress);
    const tried = new Set<string>();
    const creation = await attemptCreation(row.id, modelDef, req, pool, tried);
    if (creation.stop) return creation.stop;
    if (creation.bound) {
      return await waitWindow(row.id, modelDef, req, creation.bound, tried, 15);
    }
    await saveInternalWaitingNote(row.id);
    return waitModeOutcome(row.id, row.model, row.type, row.progress);
  }

  // المفتاح المربوط: إن صار معطلًا نعيد الإنشاء على التالي؛ وإلا نحدّث من المزود حية
  const keyRow = row.key_id ? await getKeyById(row.key_id) : null;
  if (!keyRow || keyRow.status === "disabled") {
    const tried = new Set<string>();
    const creation = await attemptCreation(row.id, modelDef, req, await getKeyPool(modelDef.providers), tried);
    if (creation.stop) return creation.stop;
    if (creation.bound) {
      return await waitWindow(row.id, modelDef, req, creation.bound, tried, 15);
    }
    await saveInternalWaitingNote(row.id);
    return waitModeOutcome(row.id, row.model, row.type, row.progress);
  }

  try {
    const r = await ADAPTERS[keyRow.provider].checkTask(toProviderKey(keyRow), row.provider_task_id);
    if (r.status === "completed" && r.urls?.length) {
      await updateTask(row.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify(r.urls) });
      return { kind: "completed", taskId: row.id, urls: r.urls, model: row.model, type: row.type };
    }
    if (r.status === "failed") {
      const msg = r.error || "فشل المزود";
      if (KEY_BALANCE_FAIL_RE.test(msg)) {
        // فشل مفتاح/رصيد في منتصف المهمة → نفس المهمة على المفتاح التالي
        const tried = new Set<string>();
        const creation = await attemptCreation(row.id, modelDef, req, await getKeyPool(modelDef.providers), tried);
        if (creation.stop) return creation.stop;
        if (creation.bound) {
          return await waitWindow(row.id, modelDef, req, creation.bound, tried, 15);
        }
        await saveInternalWaitingNote(row.id);
        return waitModeOutcome(row.id, row.model, row.type, row.progress);
      }
      await updateTask(row.id, { status: "failed", error_message: msg });
      return { kind: "failed", taskId: row.id, message: `❌ فشلت المهمة: ${msg}` };
    }
    const progress = Math.max(row.progress, r.progress ?? row.progress);
    await updateTask(row.id, { progress });
    return { kind: "processing", taskId: row.id, model: row.model, type: row.type, progress };
  } catch (e) {
    const cls = errorClassOf(e);
    if (cls === "disabled" || cls === "exhausted") {
      const tried = new Set<string>();
      const creation = await attemptCreation(row.id, modelDef, req, await getKeyPool(modelDef.providers), tried);
      if (creation.stop) return creation.stop;
      if (creation.bound) {
        return await waitWindow(row.id, modelDef, req, creation.bound, tried, 15);
      }
      await saveInternalWaitingNote(row.id);
    }
    return waitModeOutcome(row.id, row.model, row.type, row.progress);
  }
}

function parseUrls(row: TaskRow): string[] {
  try {
    const parsed = JSON.parse(row.result_urls_json || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// يُصدَّر ليستخدمه refreshTask عند فشل التصنيف الصريح
export { classifyProviderError, ProviderError };
