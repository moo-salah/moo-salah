// مزود CometAPI — المزود الثاني:
// - صور متزامنة عبر نقطة متوافقة مع OpenAI (/v1/images/generations) تعيد الرابط أو b64_json فورًا.
// - فيديو عبر نقطة مهام غير متزامنة بنفس نمط create/check (وفق المواصفة — يُضبط الشكل النهائي
//   بحسب توثيق api.cometapi.com الحالي عند إضافة مفتاح CometAPI فعلي؛ الأخطاء تُصنَّف وتُبدّل
//   المفاتيح تلقائيًا كأي مزود، فلا انقطاع في الخدمة).
import { ProviderError } from "../keys";
import type { ProviderAdapter, ProviderKey } from "./types";

const COMETAPI_BASE = "https://api.cometapi.com";

async function cometFetch(
  key: ProviderKey,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: Record<string, unknown> }> {
  let resp: Response;
  try {
    resp = await fetch(`${COMETAPI_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    throw new ProviderError(0, `temporary network error: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const msg =
    (body?.error as { message?: string })?.message ||
    (body?.message as string) ||
    `HTTP ${resp.status}`;
  if (!resp.ok || body?.error) {
    // بعض المزودين يرسلون النفاد بحالة 400 — classifyProviderError يفحص الرسالة قبل الحالة
    throw new ProviderError(resp.status, msg);
  }
  return { status: resp.status, body };
}

export const cometapiAdapter: ProviderAdapter = {
  async createImageSync(key, providerModel, input) {
    const body = await cometFetch(key, "/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        n: 1,
      }),
    });
    const data = (body.body?.data ?? []) as Array<{ url?: string; b64_json?: string }>;
    const urls = data
      .map((d) => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : null))
      .filter((u): u is string => Boolean(u));
    if (!urls.length) {
      throw new ProviderError(500, "استجابة توليد الصور المتزامن بلا روابط");
    }
    return { urls };
  },

  async createTask(key, providerModel, input) {
    const body = await cometFetch(key, "/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    const data = (body.body?.data ?? {}) as { taskId?: string; task_id?: string };
    const taskId = data.taskId ?? data.task_id;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError(500, "استجابة createTask من CometAPI بلا معرّف مهمة");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    const body = await cometFetch(
      key,
      `/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    );
    const data = (body.body?.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string;
      response?: { resultUrls?: string[] };
    };
    const state = String(data.state ?? "waiting");
    if (state === "success") {
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(data.resultJson || "{}") as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls : [];
      } catch {
        urls = [];
      }
      if (!urls.length && Array.isArray(data.response?.resultUrls)) {
        urls = data.response.resultUrls;
      }
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة بدون روابط نتائج" };
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: data.failMsg || "فشل المزود بدون تفاصيل" };
    }
    const progress = state === "generating" ? 55 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};
