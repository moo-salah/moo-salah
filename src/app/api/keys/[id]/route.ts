// PATCH /api/keys/{id} — تعطيل/تنشيط يدوي {status: "active" | "disabled"}
// DELETE /api/keys/{id} — حذف المفتاح نهائيًا
import { NextResponse } from "next/server";
import { setKeyStatus, deleteKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { status?: string; action?: string };
    // نقبل صيغة status مباشرة أو action: enable/disable
    let status = body.status;
    if (!status && body.action) {
      status = body.action === "enable" ? "active" : body.action === "disable" ? "disabled" : undefined;
    }
    if (status !== "active" && status !== "disabled") {
      return NextResponse.json(
        { error: "status يجب أن يكون active أو disabled" },
        { status: 400 }
      );
    }
    await setKeyStatus(id, status);
    return NextResponse.json({ ok: true, id, status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteKey(id);
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
