// مسار خادم MCP — Streamable HTTP حسب مواصفة MCP باستخدام SDK الرسمي
// (McpServer + StreamableHTTPServerTransport) داخل Next.js App Router.
// نمرر جسم الطلب المحلّل مسبقًا (parsedBody) ونعيد استجابة Web نتيجةً لسلوك النقل
// الذي يكتب عبر واجهة Node (writeHead/write/end) — لذا نبني Shim shims متوافقة
// مع @hono/node-server الذي يستخدمه الـ SDK داخليًا للتحويل.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";
import { KNOWN_TOOLS, validateMergeArgsCounts } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------- جلسات في الذاكرة (كل نسخة سيرفر تحفظ جلساتها) ----------
type Session = { server: unknown; transport: StreamableHTTPServerTransport };
const g = globalThis as unknown as { __mcpSessions?: Map<string, Session> };
const sessions = (g.__mcpSessions ??= new Map<string, Session>());

// ---------- Shim: طلب على نمط IncomingMessage يكفيه @hono/node-server ----------
// الأهم: rawBody (Buffer) — يمنع hono من لمس مجرى الجسم إطلاقًا
// و rawHeaders (مصفوفة مسطحة) — لأن RequestHeaders في hono يقرأها بـ .slice()
class ShimRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  rawBody: Buffer;
  rawHeaders: string[];
  // خصائص دفاعية قد يلمسها hono أثناء معالجة إغلاق الاتصال
  complete = true;
  readableAborted = false;
  readableDidRead = false;
  readableEnded = false;
  readableLength = 0;
  readableEncoding = null;
  errored = null;
  socket = { encrypted: false };
  constructor(method: string, url: string, headers: Record<string, string>, rawBody: Buffer) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.rawBody = rawBody;
    this.rawHeaders = Object.entries(headers).flatMap(([k, v]) => [k, v]);
  }
  read(): Buffer | null {
    return null;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  destroy(): this {
    return this;
  }
}

// ---------- Shim: استجابة تلتقط ما يكتبه hono وتحوّله إلى Web Response قابل للبث ----------
class ShimResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = "";
  headers: Array<[string, string]> = [];
  writable = true;
  writableFinished = false;
  private response: Response | null = null;
  private resolve!: (r: Response) => void;
  readonly done: Promise<Response>;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private encoder = new TextEncoder();

  constructor() {
    super();
    this.done = new Promise<Response>((resolve) => {
      this.resolve = resolve;
    });
  }

  private ensureResponse(): void {
    if (this.response) return;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
    const h = new Headers();
    for (const [k, v] of this.headers) h.set(k, v);
    this.response = new Response(stream, { status: this.statusCode, headers: h });
    this.resolve(this.response);
  }

  get headersSent(): boolean {
    return this.response !== null;
  }

  writeHead(code: number, headers?: Record<string, string> | Array<[string, string]>): this {
    this.statusCode = code;
    if (headers) {
      if (Array.isArray(headers)) {
        for (const [k, v] of headers) this.headers.push([k, String(v)]);
      } else {
        for (const [k, v] of Object.entries(headers)) this.headers.push([k, String(v)]);
      }
    }
    return this;
  }

  setHeader(name: string, value: string | number | string[]): this {
    const v = Array.isArray(value) ? value.join(", ") : String(value);
    this.headers = this.headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
    this.headers.push([name, v]);
    return this;
  }

  getHeader(name: string): string | undefined {
    const found = this.headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found ? found[1] : undefined;
  }

  hasHeader(name: string): boolean {
    return this.getHeader(name) !== undefined;
  }

  removeHeader(name: string): void {
    this.headers = this.headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
  }

  flushHeaders(): void {
    this.ensureResponse();
  }

  write(chunk: unknown): boolean {
    this.ensureResponse();
    if (!this.controller) return false;
    const data =
      typeof chunk === "string" ? this.encoder.encode(chunk) : new Uint8Array(chunk as ArrayBuffer);
    try {
      this.controller.enqueue(data);
    } catch {
      return false;
    }
    return true;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableFinished = true;
    this.ensureResponse();
    try {
      this.controller?.close();
    } catch {
      // أُغلق المجرى مسبقًا
    }
    this.emit("close");
    return this;
  }

  destroy(): this {
    return this;
  }
}

// ---------- أدوات مساعدة ----------

function jsonResponse(status: number, payload: unknown, sessionId?: string | null): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Response(JSON.stringify(payload), { status, headers });
}

// نتيجة أداة JSON-RPC جاهزة (للاعتراض قبل الوصول للـ SDK برسائل عربية)
function toolTextResponse(
  id: unknown,
  text: string,
  isError: boolean,
  sessionId?: string | null
): Response {
  return jsonResponse(
    200,
    {
      jsonrpc: "2.0",
      id: id ?? null,
      result: { content: [{ type: "text", text }], isError },
    },
    sessionId
  );
}

function checkAuth(req: Request): Response | null {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return null;
  const header = req.headers.get("authorization") || "";
  if (header === `Bearer ${token}`) return null;
  return jsonResponse(401, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32001, message: "Unauthorized — مطلوب Authorization: Bearer <MCP_ACCESS_TOKEN>" },
  });
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// تشغيل handleRequest دون انتظار — نعيد الـ Response فورًا حتى يبدأ البث مبكرًا
function runTransport(
  session: Session,
  req: Request,
  url: URL,
  rawBody: Buffer,
  parsedBody?: unknown
): Promise<Response> {
  const shimReq = new ShimRequest(req.method, url.pathname + url.search, headersToObject(req.headers), rawBody);
  const shimRes = new ShimResponse();
  const p = session.transport.handleRequest(
    shimReq as unknown as import("node:http").IncomingMessage,
    shimRes as unknown as import("node:http").ServerResponse,
    parsedBody
  );
  // أي خطأ غير متوقع نغلقه بأمان (الاستجابة تكون قد بدأت أو لن تبدأ)
  p.catch(() => {
    try {
      shimRes.end();
    } catch {
      /* تجاهل */
    }
  });
  return shimRes.done;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  if (!out.host) out.host = "localhost";
  return out;
}

// ---------- POST: الرسائل (initialize / tools/list / tools/call ...) ----------
export async function POST(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const sessionId = req.headers.get("mcp-session-id");

  let body: unknown = null;
  let parseFailed = false;
  try {
    body = await req.json();
  } catch {
    parseFailed = true;
  }
  if (parseFailed || !isJsonObject(body)) {
    return jsonResponse(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error — الجسم يجب أن يكون JSON-RPC صالحًا" },
    });
  }
  const rpc = body as {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");

  // اعتراض مبكر: أداة غير معروفة برسالة عربية (بدل رسالة الـ SDK الإنجليزية)
  if (rpc.method === "tools/call") {
    const name = String(rpc.params?.name ?? "");
    if (!KNOWN_TOOLS.includes(name as (typeof KNOWN_TOOLS)[number])) {
      return toolTextResponse(
        rpc.id,
        `❌ أداة غير معروفة: ${name}. المتاح: ${KNOWN_TOOLS.join(", ")}`,
        true,
        sessionId
      );
    }
    if (name === "merge_videos") {
      const pre = validateMergeArgsCounts(rpc.params?.arguments ?? {});
      if (pre) return toolTextResponse(rpc.id, pre, true, sessionId);
    }
  }

  // جلب الجلسة القائمة أو إنشاء واحدة جديدة عند initialize فقط
  let session = sessionId ? sessions.get(sessionId) : undefined;
  let createdNew = false;
  if (!session) {
    if (rpc.method !== "initialize") {
      return jsonResponse(
        404,
        {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          error: {
            code: -32001,
            message: "Session not found — أعد إرسال initialize أولًا للحصول على mcp-session-id",
          },
        },
        sessionId
      );
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, { server, transport });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
    // تسجيل أخطاء النقل للمشخصة (السجل فقط — لا يخرج للعميل)
    transport.onerror = (e: Error) => {
      console.error("[mcp] transport error:", e?.stack || e);
    };
    await server.connect(transport);
    session = { server, transport };
    createdNew = true;
  }

  try {
    const response = await runTransport(session, req, url, rawBody, body);
    // شبكة أمان: إن لم يخزّن الجلسة عبر onsessioninitialized (اختلاف إصدار؟) نخزنها بعد initialize
    if (createdNew && session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
      sessions.set(session.transport.sessionId, session);
    }
    return response;
  } catch (e) {
    return jsonResponse(500, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: { code: -32603, message: `Internal error: ${(e as Error).message}` },
    });
  }
}

// ---------- GET: مجرى SSE مستقل للرسائل من السيرفر للعميل ----------
export async function GET(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (auth) return auth;
  const sessionId = req.headers.get("mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    return jsonResponse(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "GET يتطلب جلسة قائمة عبر ترويسة mcp-session-id" },
    });
  }
  const url = new URL(req.url);
  return runTransport(session, req, url, Buffer.alloc(0));
}

// ---------- DELETE: إنهاء الجلسة ----------
export async function DELETE(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (auth) return auth;
  const sessionId = req.headers.get("mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    return jsonResponse(404, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Session not found" },
    });
  }
  const url = new URL(req.url);
  const response = await runTransport(session, req, url, Buffer.alloc(0));
  sessions.delete(sessionId as string);
  return response;
}
