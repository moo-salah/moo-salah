// الأدوات الخمس — الأوصاف الإنجليزية الدقيقة (العميل يقرأها) والنتائج بالعربية
import { z } from "zod";
import { runGeneration, type Outcome } from "../generation";
import { runMerge } from "../merger";
import { refreshTask } from "../generation";
import { listRecentTasks, type TaskType, type TaskStatus } from "../turso";
import { formatOutcome, formatListMedia, type FormattedResult } from "../format";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const KNOWN_TOOLS = [
  "generate_image",
  "generate_video",
  "merge_videos",
  "get_task",
  "list_media",
] as const;

// بث إشعارات التقدم إذا زوّد العميل الطلب بـ _meta.progressToken — كل ~3 ثوانٍ برسالة عربية
type ExtraLike = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: unknown) => Promise<void>;
};

async function notifyProgress(
  extra: unknown,
  progress: number,
  total: number,
  message: string
): Promise<void> {
  const e = extra as ExtraLike | undefined;
  const token = e?._meta?.progressToken;
  if (token === undefined || token === null || typeof e?.sendNotification !== "function") return;
  try {
    await e.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  } catch {
    // العميل ربما قطع الاتصال — لا نُوقف التوليد
  }
}

function textResult(r: FormattedResult) {
  return {
    content: [{ type: "text" as const, text: r.text }],
    isError: r.isError,
  };
}

function wrapNotify(extra: unknown) {
  return (progress: number, total: number, message: string) =>
    notifyProgress(extra, progress, total, message);
}

async function outcomeToResult(outcome: Outcome): Promise<ReturnType<typeof textResult>> {
  return textResult(formatOutcome(outcome));
}

// تحقق مسبق لعدد مقاطع الدمج — رسائل عربية حتى مع انصراف مخطط zod (يُستدعى أيضًا من المسار)
export function validateMergeArgsCounts(args: {
  urls?: unknown;
  task_ids?: unknown;
}): string | null {
  const urls = Array.isArray(args.urls) ? args.urls.length : 0;
  const taskIds = Array.isArray(args.task_ids) ? args.task_ids.length : 0;
  const total = urls + taskIds;
  if (total < 2) {
    return "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
  }
  if (total > 10) {
    return "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
  }
  return null;
}

export function registerMediaTools(server: McpServer): void {
  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). Returns the finished image URL if it completes within the wait window; otherwise returns a task_id — call get_task with it every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum([
            "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
            "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3",
          ])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z
          .enum(["auto", "transparent", "opaque"])
          .default("auto")
          .describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const a = args as {
        prompt: string;
        model: string;
        aspect_ratio: string;
        resolution: string;
        background: string;
        output_format: string;
        wait_seconds: number;
      };
      try {
        const outcome = await runGeneration({
          type: "image",
          modelInput: a.model,
          prompt: a.prompt,
          params: { ...a },
          waitSeconds: a.wait_seconds ?? 90,
          notify: wrapNotify(extra),
        });
        return await outcomeToResult(outcome);
      } catch (e) {
        return textResult({ text: `❌ فشلت المهمة: ${(e as Error).message}`, isError: true });
      }
    }
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video using grok-imagine-video-1-5-preview, google/gemini-omni-flash-1-2, or bytedance/seedance-2-5 (native synchronized audio, optional image-to-video). Resolution is locked to the lowest economy tier (360p/480p) to save credits. Video takes minutes: a short wait with live progress streaming first, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z
          .string()
          .max(4096)
          .describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z
          .string()
          .optional()
          .describe("Optional public image URL as the first/reference frame (image-to-video)."),
        model: z
          .enum([
            "grok-imagine-video-1-5-preview",
            "grok-imagine-video-1.5-preview",
            "google/gemini-omni-flash-1-2",
            "bytedance/seedance-2-5",
          ])
          .default("google/gemini-omni-flash-1-2")
          .describe("Video generation model to use."),
        aspect_ratio: z
          .enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "21:9"])
          .default("auto"),
        resolution: z
          .enum(["360p", "480p"])
          .default("360p")
          .describe("Locked to economy resolution (360p for Gemini Omni, 480p for Seedance/Grok)."),
        enable_audio: z.boolean().default(true),
        duration: z
          .number()
          .int()
          .min(3)
          .max(30)
          .default(8)
          .describe("Duration in seconds (3-15s for Gemini Omni/Grok, 4-30s for Seedance)."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const a = args as {
        prompt: string;
        image_url?: string;
        model: string;
        aspect_ratio: string;
        resolution: string;
        enable_audio: boolean;
        duration: number;
        wait_seconds: number;
      };
      try {
        const outcome = await runGeneration({
          type: "video",
          modelInput: a.model,
          prompt: a.prompt,
          params: { ...a },
          waitSeconds: a.wait_seconds ?? 25,
          notify: wrapNotify(extra),
        });
        return await outcomeToResult(outcome);
      } catch (e) {
        return textResult({ text: `❌ فشلت المهمة: ${(e as Error).message}`, isError: true });
      }
    }
  );
  // 3) merge_videos
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Concatenate several clips into ONE final video in the given order. Pass 'urls' (public direct video links — like links returned by generate_video) or 'task_ids' (COMPLETED video generation tasks, resolved from the database in this order — ideal right after generating several clips). Merging is usually fast: a short wait with progress streaming first, then a merge task_id — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly. No resolution/fps options — the merging service fixes the output.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe(
            "Public direct video URLs (http/https) in merge order — the first clip starts the final video."
          ),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const a = args as { urls?: string[]; task_ids?: string[]; wait_seconds?: number };
      const pre = validateMergeArgsCounts(a);
      if (pre) return textResult({ text: pre, isError: true });
      try {
        const outcome = await runMerge(a, wrapNotify(extra));
        return await outcomeToResult(outcome);
      } catch (e) {
        return textResult({ text: `❌ فشلت المهمة: ${(e as Error).message}`, isError: true });
      }
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/merging service if still running). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by a generation or merge tool."),
      },
    },
    async (args) => {
      const a = args as { task_id: string };
      try {
        const outcome = await refreshTask(a.task_id);
        return await outcomeToResult(outcome);
      } catch (e) {
        return textResult({ text: `❌ فشلت المهمة: ${(e as Error).message}`, isError: true });
      }
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Most recent stored images/videos/merges with their result URLs from the database (no regeneration) — to recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const a = args as {
        type?: TaskType;
        status?: TaskStatus;
        limit?: number;
      };
      try {
        const rows = await listRecentTasks(a.limit ?? 10, { type: a.type, status: a.status });
        return textResult(formatListMedia(rows, a.limit ?? 10));
      } catch (e) {
        return textResult({ text: `❌ فشلت المهمة: ${(e as Error).message}`, isError: true });
      }
    }
  );
}
