# 🎬 Video Merger API v2 — خدمة دمج مقاطع الفيديو

خدمة كاملة لدمج عدة مقاطع فيديو في مقطع واحد عالي الجودة، مع واجهة برمجية عامة (API) للمطورين ولوحة ويب عربية RTL — جاهزة للنشر على **Vercel** بدون أي خطوة بناء.

- **المخرجات ثابتة عالية الجودة:** MP4 (H.264 CRF 18 + AAC 192k/44100Hz) + `+faststart` — حتى **1080p** بمعدل 30 إطارًا.
- **النتيجة تُوحَّد تلقائيًا** على أكبر دقة بين المدخلات (بحد 1920×1080) مع `scale+pad` و `setsar=1` و `format=yuv420p`.
- **مصدر بلا صوت؟** يُضاف مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج.
- **التخزين كاملًا في Turso (libSQL)** كصفوف BLOB من 2MB — لا S3 ولا ملفات محلية دائمة.
- **الحذف التلقائي بعد 24 ساعة** (تنظيف كسول عند كل إنشاء + Cron يومي).
- **البث بدعم Range (206)** — التقديم/الترجيع يعمل فورًا في أي مشغل ويب.

---

## الحدود

| الحد | القيمة الافتراضية | متغير البيئة |
|---|---|---|
| أقصى عدد مقاطع | 10 | `MAX_SOURCES` |
| أقصى حجم لكل مصدر | 200MB | `SOURCE_MAX_MB` |
| أقصى حجم للناتج | 150MB | `OUTPUT_MAX_MB` |
| أقصى مجموع المدد | 600 ثانية | `MAX_TOTAL_DURATION_SEC` |
| حجم قطعة الرفع | 4MB | `UPLOAD_CHUNK_BYTES` |
| حجم صف التخزين | 2MB | `BLOB_CHUNK_BYTES` |
| مدة الاحتفاظ | 24 ساعة | `RETENTION_HOURS` |
| سرعة الترميز | medium | `FFMPEG_PRESET` |

> صيغ المصادر المرفوعة المدعومة: mp4 / mov / webm / mkv / avi / m4v / mpg / 3gp

---

## النشر على Vercel — خطوة بخطوة

### 1) إنشاء قاعدة Turso والحصول على التوكن

```bash
# ثبّت Turso CLI ثم سجّل الدخول
turso auth signup        # أو turso auth login

# إنشاء قاعدة مجانية
turso db create moo-salah

# جلب الرابط والتوكن (بصلاحيات كتابة)
turso db show moo-salah --url
turso db tokens create moo-salah
```

### 2) ربط المستودع بـ Vercel

1. ادخل [vercel.com/new](https://vercel.com/new) واختر المستودع.
2. **مهم:** في إعدادات المشروع اضبط **Root Directory = `merger`** (لأن هذه الخدمة تعيش في مجلد فرعي داخل المستودع).
3. Vercel سيتعرف عليها كـ «Other» (Node.js خالص بدون بناء) — لا تغيّر ذلك.
4. في **Settings → Environment Variables** أضف المتغيرين:

| المتغير | القيمة |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://<db-name>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | التوكن من الخطوة 1 |

5. اضغط **Deploy** — سيعمل كل شيء فورًا (`vercel.json` يضبط `maxDuration: 300` لكل الدوال + Cron يومي للتنظيف + تضمين ثنائيات ffmpeg).

### 3) جرّب الـ API بعد النشر

```bash
BASE="https://your-project.vercel.app"

# فحص الجهوزية والحدود
curl "$BASE/api/config"

# إنشاء مهمة دمج من رابطين مباشرين
curl -X POST "$BASE/api/jobs" -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# → 201 {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# تنفيذ الدمج (متزامن — يستغرق ~10-30 ثانية حسب الأحجام)
curl -X POST "$BASE/api/jobs/<jobId>/process"
# → 200 {"status":"done","videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"1280x720","expiresAt":"..."}

# متابعة حالة (إن أعدت العملية من مكان آخر)
curl "$BASE/api/jobs/<jobId>"

# حذف فوري شامل
curl -X DELETE "$BASE/api/jobs/<jobId>"
```

**رفع ملف من الجهاز عبر API** (أجزاء ثنائية ≤ 4MB):

```bash
# 1) أنشئ مهمة بمصدر ملف
curl -X POST "$BASE/api/jobs" -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/clip1.mp4"},{"kind":"file","name":"my.mp4","size":6217982,"mime":"video/mp4"}]}'
# → 201 مع uploads[] يحدد seq الخاص بالملف

# 2) ارفع الأجزاء واحدًا تلو الآخر (chunk يبدأ من 0)
curl -X POST "$BASE/api/upload?job=<jobId>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @part0.bin

# 3) نفّذ الدمج
curl -X POST "$BASE/api/jobs/<jobId>/process"
```

### رموز الاستجابة

| الكود | المعنى |
|---|---|
| 201 | أُنشئت المهمة |
| 400 | مدخلات تالفة (JSON تالف / رابط غير http / مصادر فارغة…) |
| 404 | المهمة غير موجودة (حُذفت أو انتهت صلاحيتها) |
| 405 | طريقة HTTP خاطئة |
| 409 | حالة غير مناسبة (رفع غير مكتمل / مهمة معالجة فعلًا / فشلت نهائيًا) |
| 413 | تجاوز حد الحجم |
| 416 | مدى Range غير صالح |
| 500 | فشل تنفيذ (يرجع سببًا عربيًا واضحًا) |

---

## التشغيل المحلي

```bash
cd merger
cp .env.example .env       # املأ TURSO_DATABASE_URL و TURSO_AUTH_TOKEN
npm install
npm run dev                # خادم تطوير يحاكي Vercel على المنفذ 3001

# الاختبارات
npm run test:unit          # اختبار وحدات (محرك الدمج + التخزين + الحدود)
npm run test:http          # اختبار HTTP كامل ضد خادم التطوير
```

خادم التطوير يحاكي بيئة Vercel بالكامل: يحلّل المسارات الديناميكية (`/api/jobs/<id>`) ويضعها في `req.query` ويستدعي **نفس دوال api/** المنشورة حرفيًا.

---

## بنية المشروع

```
merger/
├── api/                    # دوال Vercel Serverless (Node.js خالص CommonJS)
│   ├── config.js           # GET  /api/config — الحدود + version
│   ├── cron.js             # GET  /api/cron   — تنظيف المهام المنتهية (يومي)
│   ├── jobs.js             # POST /api/jobs   — إنشاء مهمة
│   ├── upload.js           # POST /api/upload?job&seq&chunk
│   └── jobs/
│       ├── [id].js         # GET/DELETE /api/jobs/<id>
│       └── [id]/
│           ├── process.js  # POST — تنفيذ الدمج كاملًا (متزامن)
│           └── video.js    # GET  — بث بدعم Range + ?download=1
├── lib/
│   ├── db.js               # Turso: الجداول + عمليات المهام + صفوف الـ Blobs
│   ├── ffmpeg.js           # ensureExecutable + ffprobe + محرك الدمج الموحد
│   ├── storage.js          # تخزين/قراءة Blobs بصفحات 2MB (قراءة 8 صفوف/استعلام)
│   ├── limits.js           # الحدود من متغيرات البيئة
│   ├── http.js             # CORS مفتوح + JSON + أخطاء {"error":"..."}
│   └── env.js              # تحميل يدوي لملف .env
├── public/index.html       # الواجهة العربية RTL (ثيم داكن سماوي/بنفسجي)
├── scripts/                # اختبارات الوحدات و HTTP
├── dev-server.js           # خادم تطوير يحاكي Vercel
└── vercel.json             # maxDuration 300 + تضمين ffmpeg + Cron يومي
```

---

## ملاحظات حدود الخطة المجانية التي يجب معرفتها

- **مدة الدالة:** `vercel.json` يضبط `maxDuration: 300` (تعمل كاملة على حسابات Fluid الحالية؛ على الخطط الأقدم قد يُقصّ إلى 60 ثانية — الدمج النموذجي يستغرق 10–30 ثانية فلا مشكلة، لكن الفيديوهات الطويلة جدًا قد تحتاج خطة أعلى).
- **حجم الطلب:** حد Vercel ≈ 4.5MB — لهذا يُرفع الملف أجزاءً ثنائية 4MB مع إعادة محاولة ×3 في الواجهة.
- **حجم قاعدة Turso:** كل ناتج يُخزَّن كـ BLOB حتى 150MB ويُحذف تلقائيًا بعد 24 ساعة — الخطة المجانية (5GB) تكفي للاستخدام الطبيعي، ونقطة `/api/cron` تنظف يوميًا.
- **لا نظام ملفات دائم:** المعالجة كلها في `/tmp` وتُنظَّف في `finally` — كل شيء دائم يعيش في Turso فقط.
