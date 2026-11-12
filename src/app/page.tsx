"use client";

import { useEffect, useState } from "react";
import KeyManager from "@/components/KeyManager";
import TasksPanel from "@/components/TasksPanel";
import ConnectPanel from "@/components/ConnectPanel";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

export default function DashboardPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    const loadHealth = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => {});
    loadHealth();
    const t = setInterval(loadHealth, 10000);
    return () => clearInterval(t);
  }, []);

  const dbConnected = health?.database === "turso-connected";

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      {/* الهيدر — حالة قاعدة البيانات وخدمة الدمج */}
      <header className="mb-7 text-center">
        <h1 className="grad-text mb-2 text-3xl font-extrabold">
          MCP Media Generator
        </h1>
        <p className="mb-3 text-sm text-[#8f9bb8]">
          خادم MCP لتوليد الصور والفيديو ودمج المقاطع — لوحة الإدارة العربية
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-bold ${
              dbConnected
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-red-500/40 bg-red-500/10 text-red-400"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                dbConnected ? "bg-emerald-400" : "bg-red-400"
              }`}
            />
            {dbConnected ? "Turso متصل" : "Turso غير متصل"}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-bold ${
              health?.merger?.healthy
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-400"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                health?.merger?.healthy ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            خدمة الدمج:{" "}
            {health?.merger?.healthy ? "جاهزة" : health?.merger?.base ? "غير مستجيبة" : "غير مضبوطة (MERGER_API_BASE)"}
          </span>
          {health?.authRequired && (
            <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 font-bold text-violet-300">
              /mcp محمي بـ Bearer token
            </span>
          )}
        </div>
      </header>

      {/* الأدوات الخمس — رقائق تعريفية */}
      <section className="card mb-6 p-5">
        <h2 className="mb-3 text-base font-bold">
          الأدوات الخمس المتاحة على <code className="grad-text">/mcp</code>
        </h2>
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            ["generate_image", "توليد صورة من وصف نصي — تعيد الرابط أو task_id"],
            ["generate_video", "فيديو بصوت متزامن أصلي — يتابَع بـ get_task"],
            ["merge_videos", "دمج عدة مقاطع بالترتيب المطلوب في فيديو واحد"],
            ["get_task", "تتبع أي مهمة بمعرّفها حتى اكتمالها"],
            ["list_media", "استرجاع أحدث الوسائط المخزنة بروابطها"],
          ].map(([name, desc]) => (
            <div
              key={name}
              className="rounded-xl border border-[#26304d] bg-[#0d1322] px-3 py-2"
            >
              <code className="grad-text font-bold">{name}</code>
              <div className="mt-0.5 text-[#8f9bb8]">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      <KeyManager />
      <TasksPanel />
      <ConnectPanel origin={origin} authRequired={health?.authRequired ?? false} />

      <footer className="mt-8 text-center text-xs leading-7 text-[#8f9bb8]">
        media-generator-mcp v1.2.0 — Next.js + @modelcontextprotocol/sdk + Turso
        <br />
        المفاتيح مُقنَّعة دائمًا ولا تُعاد كاملة في أي استجابة — التبديل بينها تلقائي وصامت
      </footer>
    </main>
  );
}
