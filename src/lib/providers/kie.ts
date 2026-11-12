// مزود kie.ai — Jobs API الموحد (الأشكال مقاسة فعليًا ضد api.kie.ai وفق docs.kie.ai)
// POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo?taskId= → data.state: waiting|queuing|generating|success|fail
//      data.resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا → {"resultUrls":[...]}
import { ProviderError } from "../keys";
import type { ProviderAdapter, ProviderKey } from "./types";

const KIE_BASE = "https://api.kie.ai";

async function kieFetch(
  key: ProviderKey,
  path: string,
  init?: RequestInit
): Promise<{ code: number; msg?: string; data?: Record<string, unknown> }> {
  let resp: Response;
  try {
    resp = await fetch(`${KIE_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    // انقطاع شبكة/مهلة = خطأ مؤقت (بلا حالة HTTP)
    throw new ProviderError(0, `temporary network error: ${(e as Error).message}`);
  }
  let body: { code?: number; msg?: string; message?: string; data?: Record<string, unknown> } | null = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  // kie قد يرجع الأخطاء بحالة HTTP 200 مع body.code — نوحّد الحالة من الاثنين
  const code = typeof body?.code === "number" ? body.code : resp.status;
  const msg = body?.msg || body?.message || `HTTP ${resp.status}`;
  if (code >= 400) {
    throw new ProviderError(code === 200 ? resp.status : code, msg);
  }
  return { code, msg, data: body?.data };
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input) {
    const body = await kieFetch(key, "/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    const taskId = body.data?.taskId;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError(500, "استجابة createTask من المزود بلا taskId");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    const body = await kieFetch(
      key,
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    );
    const data = (body.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string;
      response?: { resultUrls?: string[] };
    };
    const state = String(data.state ?? "waiting");

    if (state === "success") {
      // resultJson نص JSON داخل JSON — نحلّله مرتين، وإن تغيّر الشكل نستخدم data.response.resultUrls
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(data.resultJson || "{}") as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls.map(String) : [];
      } catch {
        urls = [];
      }
      if (!urls.length && Array.isArray(data.response?.resultUrls)) {
        urls = data.response.resultUrls.map(String);
      }
      if (!urls.length) {
        return { status: "failed", error: "اكتملت المهمة لدى المزود بدون روابط نتائج" };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail") {
      return { status: "failed", error: data.failMsg || "فشل المزود بدون تفاصيل" };
    }

    // waiting | queuing | generating — تقدم تقديري بحسب الحالة
    const progress = state === "generating" ? 55 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};
