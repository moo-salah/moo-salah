export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Partial<Record<ProviderId, string>>;
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL =
  process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL =
  process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
  {
    canonical: "google/gemini-omni-flash-1-2",
    aliases: ["google/gemini-omni-flash-1.2", "gemini-omni-flash-1-2", "gemini-omni-1-2-flash"],
    type: "video",
    providers: ["kie"],
    providerModel: { kie: "google/gemini-omni-flash-1-2" },
  },
  {
    canonical: "bytedance/seedance-2-5",
    aliases: ["bytedance/seedance-2.5", "seedance-2-5", "seedance-2.5"],
    type: "video",
    providers: ["kie"],
    providerModel: { kie: "bytedance/seedance-2-5" },
  },
];

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\./g, "-").replace(/\s+/g, "");
}

export function findModel(name: string): ModelDef | null {
  if (!name) return null;
  const n = normalizeName(name);
  return (
    MODELS.find(
      (m) =>
        normalizeName(m.canonical) === n ||
        m.aliases.some((a) => normalizeName(a) === n)
    ) ?? null
  );
}

export const IMAGE_MODEL = MODELS[0].canonical;
export const VIDEO_MODEL = MODELS[1].canonical;
