// نظام المفاتيح المتسلسلة — قلب المشروع
// الترتيب صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin وليس «الأقل استخدامًا أولًا»
import { randomUUID } from "crypto";
import { exec, ensureSchema } from "./turso";
import type { ProviderId } from "./models";

export type ApiKeyStatus = "active" | "exhausted" | "disabled";

export interface ApiKeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: ApiKeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// إخفاء المفتاح إلزامي في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(key: string): string {
  if (!key) return "••••";
  if (key.length >= 14) return key.slice(0, 7) + "••••••••" + key.slice(-4);
  return key.slice(0, 3) + "••••";
}

function rowToKey(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(row.id),
    provider: row.provider as ProviderId,
    label: String(row.label ?? ""),
    api_key: String(row.api_key ?? ""),
    status: (row.status as ApiKeyStatus) ?? "active",
    usage_count: Number(row.usage_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    last_used_at: (row.last_used_at as string | null) ?? null,
    last_checked_at: (row.last_checked_at as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

// جلب المرشحين بهذا الترتيب بالضبط: أول مفتاح أُضيف يُجرَّب أولًا
// المفتاح المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي (disabled)
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const res = await exec({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as unknown as string[],
  });
  return res.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
}

export async function listKeys(): Promise<Array<Omit<ApiKeyRow, "api_key"> & { masked: string }>> {
  await ensureSchema();
  const res = await exec({
    sql: "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC",
  });
  return res.rows.map((r) => {
    const { api_key, ...rest } = rowToKey(r as unknown as Record<string, unknown>);
    // إخفاء المفتاح إلزامي — أول 7 أحرف + •••••••• + آخر 4 (القصيرة: أول 3 + ••••)
    return { ...rest, masked: maskKey(api_key) };
  });
}

export async function insertKey(provider: ProviderId, apiKey: string, label: string): Promise<{ id: string }> {
  await ensureSchema();
  // رفض التكرار لنفس المزود
  const dup = await exec({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?",
    args: [provider, apiKey],
  });
  if (dup.rows.length) {
    throw new Error("هذا المفتاح مضاف مسبقًا لنفس المزود");
  }
  const id = randomUUID();
  await exec({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [id, provider, label, apiKey],
  });
  return { id };
}

export async function setKeyStatus(id: string, status: ApiKeyStatus, error?: string | null): Promise<void> {
  await ensureSchema();
  await exec({
    sql: `UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = datetime('now') WHERE id = ?`,
    args: [status, error ?? null, id],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await exec({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// تحديث عدّادات المفتاح دائمًا مع كل محاولة (نجاح أو فشل)
export async function bumpKeyStats(id: string, ok: boolean, error?: string | null): Promise<void> {
  await ensureSchema();
  await exec({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, error ?? null, id],
  });
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const res = await exec({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  if (!res.rows.length) return null;
  return rowToKey(res.rows[0] as unknown as Record<string, unknown>);
}

// ---------- تصنيف الأخطاء (دالة موحدة) ----------

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * تصنيف خطأ المزود لتحديد الإجراء:
 * - disabled:  المفتاح مرفوض → علّمه disabled تلقائيًا → انتقل للمفتاح التالي
 * - exhausted: نفاد الرصيد (يفحص قبل 400 — بعض المزودين يرسلونه بحالة 400) → علّمه exhausted → التالي
 * - provider:  الموديل غير مدعوم لدى هذا المزود → انتقل للتالي
 * - params:    خطأ معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحلّه)
 * - temporary: 429/5xx/شبكة/timeout → انتقل للتالي الآن والمفتاح يبقى سليمًا
 */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const s = status ?? 0;
  const msg = (message || "").toLowerCase();
  // نفاد الرصيد أولًا — قبل فحص 400
  if (
    s === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|رصيد|لا يوجد رصيد/.test(msg)
  ) {
    return "exhausted";
  }
  if (s === 401 || s === 403 || /invalid api key|unauthorized|forbidden|authentication|api key not|invalid key/.test(msg)) {
    return "disabled";
  }
  if (/model not found|unsupported model|unknown model|invalid model|not a valid model/.test(msg) && [400, 404, 422].includes(s)) {
    return "provider";
  }
  if ([400, 422].includes(s)) return "params";
  return "temporary"; // 429، 5xx، شبكة، timeout، abort
}

// أنماط فشل مفتاح/رصيد في منتصف المهمة (قسم 4.3.2) — تفعّل إعادة الإنشاء على المفتاح التالي
export const KEY_BALANCE_FAIL_RE =
  /insufficient|balance|credit|quota|402|401|unauthorized|exhausted/i;

export function errorClassOf(e: unknown): ErrorClass {
  if (e instanceof ProviderError) return classifyProviderError(e.status, e.message);
  const msg = e instanceof Error ? e.message : String(e);
  // أخطاء الشبكة/المهلة من عندنا = مؤقتة
  return classifyProviderError(undefined, msg) === "temporary"
    ? "temporary"
    : classifyProviderError(undefined, msg);
}
