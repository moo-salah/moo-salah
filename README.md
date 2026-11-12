# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

تطبيق **Next.js واحد** فيه جزءان:

1. **خادم MCP** على المسار `/mcp` (Streamable HTTP حسب مواصفة MCP) يعرض **5 أدوات** يستدعيها نموذج الذكاء الاصطناعي من أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK):
   - `generate_image` — توليد صور بـ `gpt-image-2-6/flare-text-to-image`
   - `generate_video` — توليد فيديو بصوت متزامن أصلي بـ `grok-imagine-video-1-5-preview`
   - `merge_videos` — دمج عدة مقاطع في مقطع واحد بالترتيب المطلوب
   - `get_task` — تتبع أي مهمة بمعرّفها
   - `list_media` — استرجاع الوسائط المخزنة بروابطها
2. **واجهة ويب عربية RTL** لإدارة مفاتيح API، ومتابعة المهام حية، وإعدادات الربط جاهزة للنسخ.

## القواعد الجوهرية المطبَّقة

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر؛ تُخزَّن روابط النتائج في قاعدة البيانات.
- **مفاتيح تسلسلية صارمة** بترتيب الإضافة (`created_at ASC, id ASC`) — وليس round-robin.
- **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف: نفس المهمة بنفس `task_id` تُستأنف على المفتاح التالي، **والعميل لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- مهمة فشلت على كل المفاتيح تبقى **processing** وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- **إخفاء المفاتيح إلزامي** في كل الاستجابات والسجلات (`maskKey`: أول 7 + •••••••• + آخر 4).
- تصنيف موحد للأخطاء: `disabled` (401/403) / `exhausted` (402 أو رسائل النفاد) / `provider` (موديل غير مدعوم) / `params` (توقف فوري) / `temporary` (429/5xx/شبكة).
- ملفات الدمج تُحذف بعد **24 ساعة** — مذكورة في وصف الأداة وفي SERVER_INSTRUCTIONS.

## البنية

```
src/
├── app/
│   ├── mcp/route.ts            # خادم MCP (Streamable HTTP + SDK رسمي)
│   ├── api/health/route.ts     # حالة القاعدة + الموديلات + خدمة الدمج
│   ├── api/keys/route.ts       # GET (مقنّع) + POST (رفض تكرار)
│   ├── api/keys/[id]/route.ts  # PATCH تعطيل/تنشيط + DELETE
│   ├── api/tasks/route.ts      # أحدث المهام + الإحصائيات (للوحة)
│   ├── page.tsx                # اللوحة العربية (هيدر حالة + 3 بطاقات)
│   └── layout.tsx              # RTL + lang=ar + خط Cairo
├── components/                 # KeyManager / TasksPanel / ConnectPanel
└── lib/
    ├── turso.ts                # العميل + المخطط + عمليات المهام
    ├── keys.ts                 # ترتيب المفاتيح الصارم + تصنيف الأخطاء + maskKey
    ├── models.ts               # سجل MODELS + الأسماء البديلة + تجاوزات البيئة
    ├── generation.ts           # منسّق التوليد بالتبديل «لا توقف أبدًا»
    ├── merger.ts               # عميل Video Merger API v2 + runMerge + refreshMergeTask
    ├── format.ts               # صياغة الردود العربية
    ├── providers/              # kie.ts (Jobs API) + cometapi.ts + types.ts
    └── mcp/                    # server.ts (SERVER_INSTRUCTIONS) + tools.ts (الأدوات الخمس)
merger/                         # مشروع خدمة الدمج المستقل (راجع merger/README.md)
scripts/e2e-mcp.js              # اختبار e2e كامل ضد خادم محلي
```

## متغيرات البيئة

```bash
# إلزامية (محليًا في .env.local — وعلى Vercel في Environment Variables)
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>
MERGER_API_BASE=https://<مشروع-خدمة-الدمج>.vercel.app

# اختيارية
MCP_ACCESS_TOKEN=            # إن ضُبط يُطلب Bearer token على /mcp
KIE_IMAGE_MODEL=             # تجاوز أسماء الموديلات إن لزم
KIE_VIDEO_MODEL=
COMETAPI_IMAGE_MODEL=
COMETAPI_VIDEO_MODEL=
```

`.env*` في `.gitignore` منذ أول commit — لا أسرار في الكود أو Git إطلاقًا.

## التشغيل المحلي

```bash
npm install
cp .env.example .env.local   # املأ القيم
npm run dev                  # http://localhost:3000

# خدمة الدمج المحلية (طرفية ثانية) — لاختبار merge_videos محليًا
cd merger && npm install && node dev-server.js   # http://localhost:3001
# ثم اجعل MERGER_API_BASE=http://localhost:3001 في .env.local

# الاختبارات
npm run typecheck            # tsc --noEmit
npm run build                # next build
BASE=http://localhost:3000 npm run test:e2e   # e2e كامل (صورة/فيديو/دمج/تبديل مفاتيح حقيقي)
```

## النشر على Vercel (مشروعان من نفس المستودع)

1. **مشروع التطبيق الرئيسي:** Verwer → New Project → اختر المستودع → Root Directory = **(الجذر)** → أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE` → Deploy.
2. **مشروع خدمة الدمج:** New Project → نفس المستودع → Root Directory = **`merger`** → أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` → Deploy.
3. انسخ رابط مشروع الدمج (مثل `https://moo-salah-merger.vercel.app`) وضعه في `MERGER_API_BASE` للمشروع الرئيسي ثم أعد النشر.

التفاصيل خطوة بخطوة في `merger/README.md`.

## اختبار الاتصال بأي عميل MCP

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
# خذ mcp-session-id من الترويسات ثم:
curl -s -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'mcp-session-id: <SESSION>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## المزودون

- **kie.ai** (الأساسي): Jobs API الموحد — `POST /api/v1/jobs/createTask` و `GET /api/v1/jobs/recordInfo` (الأشكال مقاسة فعليًا؛ `resultJson` نص JSON داخلي يحتاج `JSON.parse` ثانيًا).
- **CometAPI** (الثاني): صور متزامنة عبر نقطة متوافقة مع OpenAI + فيديو بنمط مهام غير متزامن — يُضبط الشكل النهائي وفق توثيقهم الحالي عند إضافة مفتاح CometAPI (الأخطاء تُصنَّف وتُبدّل المفاتيح كأي مزود).
