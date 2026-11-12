// واجهة المزودات — أي خطأ يُرمى كـ ProviderError ليُصنَّف في classifyProviderError
import type { ProviderError } from "../keys";
import type { ProviderId } from "../models";

export interface ProviderKey {
  id: string;
  api_key: string;
  label: string;
}

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(
    key: ProviderKey,
    providerModel: string,
    input: Record<string, unknown>
  ): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(
    key: ProviderKey,
    providerModel: string,
    input: Record<string, unknown>
  ): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult>;
}

export type { ProviderId, ProviderError };

export function toProviderKey(row: {
  id: string;
  api_key: string;
  label?: string;
}): ProviderKey {
  return { id: row.id, api_key: row.api_key, label: row.label ?? "" };
}
