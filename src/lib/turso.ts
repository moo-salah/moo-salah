// طبقة قاعدة البيانات (Turso/libSQL عبر HTTP) — إلزامية للتوافق مع Vercel (لا ملفات SQLite محلية)
import { createClient, type Client, type InStatement } from "@libsql/client";

let _client: Client | null = null;

export function turso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error(
        "متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة — راجع إعدادات النشر"
      );
    }
    _client = createClient({ url, authToken });
  }
  return _client;
}

// إعادة محاولة تلقائية للأخطاء الشبكية العابرة فقط (فشل fetch/انقطاع socket)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isTransient(e: unknown): boolean {
  const err = e as { message?: string; cause?: { code?: string }; code?: string };
  const msg = `${err?.message ?? ""} ${err?.cause?.code ?? ""} ${err?.code ?? ""}`;
  return /fetch failed|socket|ECONNRESET|EPIPE|UND_ERR|timed out|aborted|network|other side closed/i.test(msg);
}

export async function exec(stmt: InStatement, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await turso().execute(stmt);
    } catch (e) {
      if (i >= tries - 1 || !isTransient(e)) throw e;
      await sleep(250 * (i + 1));
    }
  }
}

export async function batch(statements: InStatement[], mode: "write" | "read" = "write", tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await turso().batch(statements, mode);
    } catch (e) {
      if (i >= tries - 1 || !isTransient(e)) throw e;
      await sleep(250 * (i + 1));
    }
  }
}

// إنشاء الجداول عند أول وصول — بلا أداة migrations
let schemaPromise: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = batch([
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys (provider, created_at)`,
    ])
      .then(() => undefined)
      .catch((e) => {
        schemaPromise = null; // نسمح بإعادة المحاولة في الطلب التالي
        throw e;
      });
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await turso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ---------- أنواع ومهام جدول tasks ----------

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface Attempt {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok?: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToTask(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    provider: (row.provider as string | null) ?? null,
    provider_task_id: (row.provider_task_id as string | null) ?? null,
    key_id: (row.key_id as string | null) ?? null,
    model: String(row.model ?? ""),
    type: (row.type as TaskType) ?? "image",
    prompt: String(row.prompt ?? ""),
    params_json: String(row.params_json ?? "{}"),
    status: (row.status as TaskStatus) ?? "processing",
    progress: Number(row.progress ?? 0),
    result_urls_json: (row.result_urls_json as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    attempts_json: String(row.attempts_json ?? "[]"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    completed_at: (row.completed_at as string | null) ?? null,
  };
}

export function parseTaskUrls(row: TaskRow): string[] {
  try {
    const parsed = JSON.parse(row.result_urls_json || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseTaskAttempts(row: TaskRow): Attempt[] {
  try {
    const parsed = JSON.parse(row.attempts_json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function insertTask(row: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: TaskType;
  prompt?: string;
  params_json?: string;
  status: TaskStatus;
  progress?: number;
}): Promise<void> {
  await ensureSchema();
  await exec({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      row.provider ?? null,
      row.provider_task_id ?? null,
      row.key_id ?? null,
      row.model,
      row.type,
      row.prompt ?? "",
      row.params_json ?? "{}",
      row.status,
      row.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await exec({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  if (!res.rows.length) return null;
  return rowToTask(res.rows[0] as unknown as Record<string, unknown>);
}

// تحديث جزئي للمهمة — يضيف محاولة جديدة إلى attempts_json ويثبت completed_at تلقائيًا عند الاكتمال
const TASK_FIELDS = new Set([
  "provider",
  "provider_task_id",
  "key_id",
  "status",
  "progress",
  "result_urls_json",
  "error_message",
]);

export async function updateTask(
  id: string,
  patch: {
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    status?: TaskStatus;
    progress?: number;
    result_urls_json?: string | null;
    error_message?: string | null;
  },
  newAttempt?: Attempt
): Promise<void> {
  await ensureSchema();
  const statements: InStatement[] = [];
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const args = keys.map((k) => patch[k] as string | number | null);
    statements.push({
      sql: `UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
      args: [...args, id],
    });
  }
  // إضافة المحاولة إلى السجل بأسلوب قراءة-تعديل-كتابة (كاتب واحد لكل مهمة عمليًا)
  if (newAttempt) {
    const current = await getTask(id);
    const attempts = current ? parseTaskAttempts(current) : [];
    attempts.push(newAttempt);
    statements.push({
      sql: `UPDATE tasks SET attempts_json = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [JSON.stringify(attempts), id],
    });
  }
  if (patch.status === "completed" || patch.status === "failed") {
    statements.push({
      sql: `UPDATE tasks SET completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?`,
      args: [id],
    });
  }
  await batch(statements);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: TaskType; status?: TaskStatus }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const res = await exec({ sql, args });
  return res.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const res = await exec({
    sql: `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END), 0) AS processing
          FROM tasks`,
  });
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(r?.total ?? 0),
    completed: Number(r?.completed ?? 0),
    failed: Number(r?.failed ?? 0),
    processing: Number(r?.processing ?? 0),
  };
}

// حذف مهمة (يُستخدم لتنظيف مهام الاختبار)
export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await exec({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}
