// GET /api/health — حالة السيرفر للواجهة وللعملاء
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MERGER_BASE = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");

async function mergerHealthy(): Promise<boolean> {
  // فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  if (!mergerConfigured()) return false;
  try {
    const resp = await fetch(`${MERGER_BASE}/api/config`, {
      signal: AbortSignal.timeout(4000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  let ok = true;
  let database = "turso-connected";
  try {
    const healthy = await dbHealthy();
    database = healthy ? "turso-connected" : "turso-error";
    if (!healthy) ok = false;
  } catch {
    database = "turso-error";
    ok = false;
  }

  return NextResponse.json({
    ok,
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: {
      base: mergerConfigured() ? MERGER_BASE : "",
      healthy: await mergerHealthy(),
    },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
