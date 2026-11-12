// GET /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
// POST /api/keys — إضافة مفتاح {provider, api_key, label?} مع رفض التكرار لنفس المزود
import { NextResponse } from "next/server";
import { listKeys, insertKey } from "@/lib/keys";
import type { ProviderId } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const keys = await listKeys();
    return NextResponse.json({ keys });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

const VALID_PROVIDERS: ProviderId[] = ["kie", "cometapi"];

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = String(body.provider ?? "") as ProviderId;
    const apiKey = String(body.api_key ?? "").trim();
    const label = String(body.label ?? "").trim();

    if (!VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json(
        { error: "المزود غير معروف — المسموح: kie أو cometapi" },
        { status: 400 }
      );
    }
    if (!apiKey) {
      return NextResponse.json({ error: "المفتاح مطلوب" }, { status: 400 });
    }
    try {
      const { id } = await insertKey(provider, apiKey, label);
      return NextResponse.json({ ok: true, id }, { status: 201 });
    } catch (e) {
      const msg = (e as Error).message;
      if (/مضاف مسبقًا/.test(msg)) {
        return NextResponse.json({ error: msg }, { status: 409 });
      }
      throw e;
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
