// سجل الموديلات — الأسماء المدمجة مثبتة كما في المواصفة وقابلة للتجاوز بمتغيرات البيئة
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحه كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
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
];

// توحيد الاسم: نقاط ↔ شرطات قبل المطابقة (نقبل gpt-image-2.6/... و grok-imagine-video-1.5-preview)
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
