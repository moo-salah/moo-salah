"use client";

// لوحة المهام — شرائح إحصائيات + قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ
import { useCallback, useEffect, useState } from "react";

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const TYPE_LABEL: Record<string, string> = {
  image: "🖼️ صورة",
  video: "🎬 فيديو",
  merge: "🎞️ دمج",
};

const STATUS_STYLE: Record<string, string> = {
  completed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  failed: "border-red-500/40 bg-red-500/10 text-red-400",
  processing: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  pending: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "بالانتظار",
};

function urlsOf(t: TaskItem): string[] {
  try {
    const parsed = JSON.parse(t.result_urls_json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function attemptsOf(t: TaskItem): number {
  try {
    const parsed = JSON.parse(t.attempts_json || "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function snippet(t: TaskItem): string {
  if (!t.prompt) return t.type === "merge" ? "دمج مقاطع" : "—";
  return t.prompt.length > 90 ? t.prompt.slice(0, 90) + "…" : t.prompt;
}

export default function TasksPanel() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const load = useCallback(() => {
    fetch("/api/tasks?limit=20")
      .then((r) => r.json())
      .then((d) => {
        setTasks(d.tasks ?? []);
        setStats(d.stats ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="card mb-6 p-5">
      <h2 className="mb-4 flex items-center gap-2 text-base font-bold">
        <span className="grad-dot inline-block h-2 w-2 rounded-full" />
        لوحة المهام
      </h2>

      {/* شرائح الإحصائيات */}
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {[
          ["إجمالي", stats?.total ?? 0, "border-[#26304d] bg-[#0d1322] text-[#e7ecf7]"],
          ["مكتملة", stats?.completed ?? 0, "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"],
          ["فاشلة", stats?.failed ?? 0, "border-red-500/40 bg-red-500/10 text-red-400"],
          ["جارية", stats?.processing ?? 0, "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"],
        ].map(([label, value, cls]) => (
          <span key={label as string} className={`rounded-xl border px-3 py-1.5 font-bold ${cls as string}`}>
            {label}: {value}
          </span>
        ))}
        <span className="me-auto" />
        <span className="self-center text-[11px] text-[#8f9bb8]">تتحدث تلقائيًا كل 5 ثوانٍ</span>
      </div>

      {/* قائمة المهام */}
      {tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#26304d] px-3 py-6 text-center text-sm text-[#8f9bb8]">
          لا توجد مهام بعد — استدعِ generate_image أو generate_video من عميل MCP وستظهر هنا
        </div>
        ) : (
        <div className="flex flex-col gap-2.5">
          {tasks.map((t) => {
            const urls = urlsOf(t);
            const attempts = attemptsOf(t);
            return (
              <div
                key={t.id}
                className="rounded-xl border border-[#26304d] bg-[#121a2d] px-3 py-2.5 text-xs"
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="font-bold">{TYPE_LABEL[t.type] ?? t.type}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_STYLE[t.status]}`}>
                    {STATUS_LABEL[t.status]}
                  </span>
                  <code className="rounded bg-[#0d1322] px-2 py-0.5 font-mono text-[10px] text-[#8f9bb8]" dir="ltr">
                    {t.id.slice(0, 8)}…
                  </code>
                  <span className="font-mono text-[11px] text-[#a78bfa]" dir="ltr">
                    {t.model}
                  </span>
                  {attempts > 0 && (
                    <span className="text-[11px] text-[#8f9bb8]">محاولات: {attempts}</span>
                  )}
                  <span className="me-auto" />
                  <span className="text-[11px] text-[#8f9bb8]">{t.created_at?.replace("T", " ").slice(0, 19)}</span>
                </div>

                <div className="mb-1.5 text-[#c7d0e6]">{snippet(t)}</div>

                {(t.status === "processing" || t.status === "pending") && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#0d1322]">
                    <div
                      className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-400 transition-all"
                      style={{ width: `${Math.max(3, Math.min(100, t.progress))}%` }}
                    />
                  </div>
                )}

                {t.status === "completed" && urls.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {urls.map((u, i) => (
                      <a
                        key={i}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        className="grad-btn rounded-lg px-3 py-1.5 text-[11px] font-bold"
                      >
                        🔗 فتح الرابط {urls.length > 1 ? i + 1 : ""}
                      </a>
                    ))}
                  </div>
                )}

                {t.status === "failed" && t.error_message && (
                  <div className="mt-1.5 rounded-lg bg-red-500/10 px-2 py-1.5 text-[11px] leading-5 text-red-300">
                    ❌ {t.error_message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
