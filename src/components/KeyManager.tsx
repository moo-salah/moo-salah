"use client";

// مدير المفاتيح — إضافة/تعطيل/تنشيط/حذف مع إخفاء إلزامي للمفاتيح
import { useCallback, useEffect, useState } from "react";

interface ApiKey {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
};

const STATUS_STYLE: Record<string, string> = {
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  exhausted: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  disabled: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
};

const STATUS_LABEL: Record<string, string> = {
  active: "نشط",
  exhausted: "مستنزف الرصيد",
  disabled: "معطل",
};

export default function KeyManager() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => setKeys(d.keys ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const addKey = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const resp = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "فشل إضافة المفتاح");
      setMsg({ text: "✅ أُضيف المفتاح بنجاح — سيُجرَّب أولًا في الترتيب حسب وقت الإضافة", ok: true });
      setApiKey("");
      setLabel("");
      load();
    } catch (e) {
      setMsg({ text: `❌ ${(e as Error).message}`, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (k: ApiKey) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    load();
  };

  const remove = async (k: ApiKey) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    load();
  };

  return (
    <section className="card mb-6 p-5">
      <h2 className="mb-4 flex items-center gap-2 text-base font-bold">
        <span className="grad-dot inline-block h-2 w-2 rounded-full" />
        مدير المفاتيح
      </h2>

      {/* نموذج الإضافة */}
      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="min-w-36"
        >
          <option value="kie">kie.ai</option>
          <option value="cometapi">CometAPI</option>
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="تسمية اختيارية (مثل: الحساب الرئيسي)"
          className="min-w-48 flex-1"
        />
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="المفتاح الكامل — يُخفى دائمًا بعد الحفظ"
          className="min-w-56 flex-[2] font-mono text-xs"
          dir="ltr"
          type="password"
        />
        <button
          onClick={addKey}
          disabled={busy || !apiKey.trim()}
          className="grad-btn rounded-xl px-5 py-2 text-sm font-bold disabled:opacity-40"
        >
          + إضافة المفتاح
        </button>
      </div>

      {msg && (
        <div
          className={`mb-4 rounded-xl border px-3 py-2 text-xs ${
            msg.ok
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-red-500/40 bg-red-500/10 text-red-400"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* النص التوضيحي الثابت */}
      <p className="mb-3 rounded-xl border border-[#26304d] bg-[#0d1322] px-3 py-2.5 text-xs leading-6 text-[#8f9bb8]">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
        تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      {/* قائمة المفاتيح */}
      {keys.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#26304d] px-3 py-6 text-center text-sm text-[#8f9bb8]">
          لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {keys.map((k, i) => (
            <div
              key={k.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-[#26304d] bg-[#121a2d] px-3 py-2.5 text-xs"
            >
              <span className="grad-btn flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-extrabold">
                {i + 1}
              </span>
              <span className="font-bold">{PROVIDER_LABEL[k.provider] ?? k.provider}</span>
              {k.label && <span className="text-[#8f9bb8]">({k.label})</span>}
              <code className="rounded bg-[#0d1322] px-2 py-0.5 font-mono text-[11px] text-[#22d3ee]" dir="ltr">
                {k.masked}
              </code>
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_STYLE[k.status]}`}
              >
                {STATUS_LABEL[k.status]}
              </span>
              <span className="text-[#8f9bb8]">
                استخدام: <b className="text-[#e7ecf7]">{k.usage_count}</b> · نجاح:{" "}
                <b className="text-emerald-400">{k.success_count}</b> · فشل:{" "}
                <b className="text-red-400">{k.fail_count}</b>
              </span>
              {k.last_error && (
                <span
                  className="max-w-64 truncate rounded bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300"
                  title={k.last_error}
                  dir="ltr"
                >
                  آخر خطأ: {k.last_error}
                </span>
              )}
              <span className="me-auto" />
              <button
                onClick={() => toggle(k)}
                className="rounded-lg border border-[#26304d] px-3 py-1.5 font-bold hover:border-[#22d3ee]"
              >
                {k.status === "disabled" ? "تنشيط" : "تعطيل"}
              </button>
              <button
                onClick={() => remove(k)}
                className="rounded-lg border border-[#26304d] px-3 py-1.5 font-bold text-red-400 hover:border-red-500"
              >
                حذف
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
