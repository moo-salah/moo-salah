// صياغة الردود العربية لأدوات MCP — المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية
import type { Outcome } from "./generation";
import type { TaskRow } from "./turso";
import { parseTaskUrls } from "./turso";

export interface FormattedResult {
  text: string;
  isError: boolean;
}

export function formatOutcome(o: Outcome): FormattedResult {
  switch (o.kind) {
    case "completed": {
      if (o.type === "image") {
        const url = o.urls[0];
        return {
          text: `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}`,
          isError: false,
        };
      }
      if (o.type === "video") {
        return {
          text: `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${o.urls.map((u) => `- ${u}`).join("\n")}`,
          isError: false,
        };
      }
      return {
        text: `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${o.urls[0]}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
        isError: false,
      };
    }
    case "processing": {
      const pct = o.progress != null ? `\n\nالنسبة: ${Math.round(o.progress)}%` : "";
      return {
        text: `⏳ المهمة قيد المعالجة — task_id: ${o.taskId}${pct}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
        isError: false,
      };
    }
    case "failed":
      return { text: o.message, isError: true };
    case "no_keys":
      return { text: o.message, isError: true };
    case "bad_params":
      return { text: o.message, isError: true };
  }
}

// صياغة سطر مهمة داخل list_media
export function formatTaskLine(row: TaskRow): string {
  const typeLabel: Record<string, string> = { image: "🖼️ صورة", video: "🎬 فيديو", merge: "🎞️ دمج" };
  const statusLabel: Record<string, string> = {
    completed: "مكتملة",
    failed: "فاشلة",
    processing: "جارية",
    pending: "بالانتظار",
  };
  const urls = parseTaskUrls(row);
  const link = urls.length ? ` — الرابط: ${urls[0]}` : "";
  const err = row.status === "failed" && row.error_message ? ` — السبب: ${row.error_message}` : "";
  return `- ${typeLabel[row.type] ?? row.type} | ${row.model} | ${statusLabel[row.status] ?? row.status}${link}${err} | task_id: ${row.id} | ${row.created_at}`;
}

export function formatListMedia(rows: TaskRow[], requestedLimit: number): FormattedResult {
  if (!rows.length) {
    return {
      text: "لا توجد وسائط مخزنة بعد — ولّد أول وسيط بـ generate_image أو generate_video وسيظهر هنا بروابطه.",
      isError: false,
    };
  }
  return {
    text: `📚 أحدث الوسائط المخزنة (${rows.length} من حد ${requestedLimit}):\n\n${rows.map(formatTaskLine).join("\n")}`,
    isError: false,
  };
}
