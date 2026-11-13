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
