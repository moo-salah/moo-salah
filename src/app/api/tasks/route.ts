// GET /api/tasks — أحدث المهام + الإحصائيات (للوحة المهام التي تتحدث تلقائيًا كل ~5 ثوانٍ)
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats, type TaskType, type TaskStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20));
    const type = (url.searchParams.get("type") ?? undefined) as TaskType | undefined;
    const status = (url.searchParams.get("status") ?? undefined) as TaskStatus | undefined;

    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, { type, status }),
      taskStats(),
    ]);
    return NextResponse.json({ tasks, stats });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
