"use client";

// بطاقة ربط السيرفر — الرابط المطلق + JSON جاهز للنسخ لكل عميل + ملاحظة الفيديو
import { useMemo, useState } from "react";

async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export default function ConnectPanel({
  origin,
  authRequired,
}: {
  origin: string;
  authRequired: boolean;
}) {
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);

  const mcpUrl = origin ? `${origin}/mcp` : "";
  const authHeader = useMemo(
    () => (authRequired ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }` : ""),
    [authRequired]
  );

  const configs = useMemo(() => {
    const chatgpt = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeader}\n    }\n  }\n}`;
    const claude = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authHeader}\n    }\n  }\n}`;
    const cursor = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeader}\n    }\n  }\n}`;
    return { chatgpt, claude, cursor };
  }, [mcpUrl, authHeader]);

  const copy = async (what: string, text: string) => {
    const ok = await copyText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
    if (!ok) alert("تعذّر النسخ — انسخ يدويًا");
  };

  const TABS = [
    { id: "chatgpt", label: "ChatGPT / GPT Agents" },
    { id: "claude", label: "Claude Desktop" },
    { id: "cursor", label: "Cursor / Windsurf / Cline" },
  ] as const;

  return (
    <section className="card p-5">
      <h2 className="mb-4 flex items-center gap-2 text-base font-bold">
        <span className="grad-dot inline-block h-2 w-2 rounded-full" />
        ربط السيرفر بأي عميل MCP
      </h2>

      {/* الرابط المطلق + نسخ */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs text-[#8f9bb8]">رابط الخادم (Server URL)</label>
        <div className="flex gap-2">
          <input
            readOnly
            value={mcpUrl}
            dir="ltr"
            className="code-box flex-1 rounded-xl"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            onClick={() => copy("url", mcpUrl)}
            className="grad-btn rounded-xl px-4 py-2 text-sm font-bold"
          >
            {copied === "url" ? "✅ نُسخ" : "📋 نسخ"}
          </button>
        </div>
      </div>

      {/* التبويبات الثلاثة */}
      <div className="mb-2 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-xl px-3.5 py-2 text-xs font-bold transition ${
              tab === t.id
                ? "grad-btn"
                : "border border-[#26304d] text-[#8f9bb8] hover:text-[#e7ecf7]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre className="code-box overflow-x-auto rounded-xl p-3.5 pb-11">
          {configs[tab]}
        </pre>
        <button
          onClick={() => copy(tab, configs[tab])}
          className="absolute left-3 bottom-3 rounded-lg border border-[#26304d] bg-[#121a2d] px-3 py-1.5 text-[11px] font-bold"
        >
          {copied === tab ? "✅ نُسخ" : "📋 نسخ JSON"}
        </button>
      </div>

      {tab === "chatgpt" && (
        <p className="mt-2 text-xs leading-6 text-[#8f9bb8]">
          في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
        </p>
      )}
      {tab === "claude" && (
        <p className="mt-2 text-xs leading-6 text-[#8f9bb8]">
          انسخ الإعداد إلى ملف <code dir="ltr">claude_desktop_config.json</code> ثم أعد تشغيل Claude Desktop.
        </p>
      )}
      {tab === "cursor" && (
        <p className="mt-2 text-xs leading-6 text-[#8f9bb8]">
          ضعه في <code dir="ltr">mcp.json</code> داخل إعدادات Cursor / Windsurf / Cline ثم أعد التشغيل.
        </p>
      )}
      {authRequired && (
        <p className="mt-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs text-violet-300">
          الخادم محمي بـ MCP_ACCESS_TOKEN — استبدل{" "}
          <code dir="ltr">&lt;MCP_ACCESS_TOKEN&gt;</code> بالقيمة الفعلية في الإعدادات أعلاه.
        </p>
      )}

      {/* الملاحظة الكهرمانية */}
      <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs leading-6 text-amber-300">
        ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10
        ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي
        (Progress notifications) حتى لا تنقطع العملية.
      </div>
    </section>
  );
}
