// bosta-orders-returned-scanner — Cloudflare Worker
// Account : ecommoda-dev (Ecommoda.dev@gmail.com)
// Auth/D1 tool value : bosta_return | Types: login / logout  (unchanged — Universal D1 Auth)
// Status-write log    : tool = metafields_change | type = update
//                       (extra.sourceTool = "bosta_orders_returned_scanner" — see §CONSTANTS)
//
// ═══════════════════════════════════════════════════════════════════════════
// v3.3.0 — "الانتظار المشروط + التصدير الصادق" (05-09-2026)
// ═══════════════════════════════════════════════════════════════════════════
// مراجعة كاملة مقابل `ecommoda-worker-builder` v2.0.0. البندان الكاسران:
//
//   ① التحقق بعد ميوتيشن غير متزامنة لازم **يستنى**، مايقراش فورًا.
//      `verifyCancels` كانت بتنام مدد ثابتة وتقرا الأوردر من غير ما تبص على
//      الـ Job نفسه — نفس عطل `Order-Cancel` (#53033): القراءة بتسبق التأكيد
//      بثانية، فكل إلغاء ناجح بيطلع أصفر، والموظف بيتعوّد يتجاهل الأصفر.
//      دلوقتي: backoff متصاعد [400,700,1100,1600,2200] + فحص `job(id){ done }`
//      مجمّع بالـ aliases + الوقوف على أول تأكيد، و`{ jobDone, attempts,
//      waitedMs }` بترجع للواجهة وبتتسجّل في D1 عشان الأصفر يبقى قابل للتشخيص.
//
//   ② `get_logs_export` كان بيرجّع `entries` لوحدها والدالة بتقص عند 2000 صف
//      في السكوت → الواجهة بتقول "تم التصدير ✓" على ملف ناقص. دلوقتي
//      `LOG_EXPORT_MAX` ثابت مسمّى، و`getLogsCount` بيتنادى بالتوازي **بنفس
//      الفلاتر بالظبط**، والرد بقى `{ entries, cap, total, truncated }`.
//
// ومعاهم: `buildLogFilterSQL` + `logParamsFrom` (فلاتر السجل بقت قوايم +
// مدى تاريخ — شرط تنفيذ بند ٢١ في `data-table-standard`)، ومنع تكرار نفس
// الأوردر في نفس الدفعة (رقمين تتبع لنفس الأوردر كانوا بيلغوه مرتين)،
// و`Invalid disposition quantity` بقت "مسترجَع قبل كده" مش فشل.
//
// v3.2.0 — "مفيش نجاح من غير دليل" (23-08-2026)
// ═══════════════════════════════════════════════════════════════════════════
// خلفية العطل اللي أنتج الإصدار ده: من 19-08 لحد 23-08 الأداة سجّلت
// `reverseDispose×N` على ٧ أوردرات S2 وكلها **كذب** — التطبيق (WareHouse-App)
// ماكانش واخد صلاحية `write_returns`، فشوبيفاي كانت بترجّع خطأ GraphQL علوي
// (`data: null`) والكود كان بيقرا `userErrors` بس (اللي بتبقى `[]` في الحالة
// دي) ويعتبرها نجاح. الاسترجاع الحقيقي كان بيعمله الـ Flow أو يدوي — وده اللي
// خفى العطل تمامًا. (اتأكد من Timeline كل أوردر: مفيش ولا حدث واحد باسم
// WareHouse-App، كلهم "Flow Platform" أو يدوي.)
//
// المبدأ الحاكم للإصدار ده: **أي عملية ما اتأكدتش = مش نجاح.** الأداة بتقول
// بالظبط اللي حصل، واللي ما حصلش، وليه.
//
// v3.1.0 — أكشنز شوبيفاي إضافية بجانب كتابة الميتافيلد (مسار RTO: إلغاء
// الأوردر قبل كتابة الميتافيلد | مسار S2: استرجاع المخزون بعد الكتابة).
// v3.0.0 — استبدال نظام التاجات بتحديث ميتافيلد S1/S2 مباشرة.
//
// منطق القرار (بدون أي اعتماد على state.code من بوسطة — السكان نفسه هو تأكيد
// الاستلام الفعلي بالمخزن):
//   1) Bosta orderType == "Send" → رفض فوري (مش من اختصاص أداة المرتجعات)
//   2) أي orderType تاني → نجيب S1 + S2 + returnStatus من شوبيفاي:
//      مسار RTO  : S1 ∈ {Shipped, In-Return} AND S2 فاضي AND returnStatus = NO_RETURN
//                  → custom.manual_status = "Returned"  (+ إلغاء الأوردر واسترجاع مخزونه)
//      مسار مرتجع بعد التسليم : S1 = Delivered AND S2 ∈ {Shipped, In-Return}
//                  AND returnStatus = IN_PROGRESS
//                  → custom.status_2_r_e = "Returned"  (+ استرجاع القطع الراجعة)
//   3) غير كده → رفض هذا الأوردر فقط مع سبب مفصّل، وباقي الأوردرات تتحدث عادي
//
// Endpoints:
//   ?action=check_employee   GET
//   ?action=register_pin     POST
//   ?action=verify_employee  POST
//   ?action=log_logout       GET
//   ?action=get_employees    GET
//   ?action=get_config       GET   — نسخة الـ Worker + وقت السيرفر (لمطابقة نسخة الواجهة)
//   ?action=diag             GET   — فحص ذاتي كامل بدون أي كتابة  ← جديد v3.2.0
//   ?action=lookup           POST  — Bosta search + Shopify batch check + validation
//   ?action=update           POST  — تنفيذ + **تحقق** + D1 log (نجاح/تحذير/فشل)
//   ?action=get_logs         GET   — server-side filtering + pagination (100/صفحة)
//   ?action=get_logs_count   GET   — العدّ المطابق لنفس الفلاتر
//   ?action=get_logs_export  GET   — التصدير + { cap, total, truncated }
//
// فلاتر السجل (نفس المجموعة على التلاتة):
//   employees=a,b · types=x,y · results=success,warning,error · machines=S1,S2
//   · search · dateFrom · dateTo    (employee/type المفردين مقبولين للتوافق)
//
// D1 Binding:   DB
// Secrets:      WORKER_SECRET, CLIENT_ID, CLIENT_SECRET, BOSTA_API_KEY
// Vars:         SHOP_DOMAIN = 6c7e1a-53.myshopify.com
//               LOCATION_ID = 98849620290
//               ⚠️ الأداة دي لسه بترفع يدويًا → المتغيرين دول لازم يكونوا
//               مضافين في Dashboard → Settings → Variables (Plain text).
//               بعد أي إضافة/تعديل: Deployments → Version History → Promote.
//
// ⚠️ صلاحيات التطبيق المطلوبة على Shopify (WareHouse-App):
//    read_orders · write_orders · read_returns · **write_returns** ·
//    read_inventory · write_inventory · read_locations
//    (`write_returns` هي اللي كانت ناقصة وسببت عطل 19→23-08. شغّل ?action=diag
//     بعد أي تغيير في التطبيق للتأكد إنها لسه موجودة.)
//
// skills: worker-builder v2.0.0 · constants v1.4.4 · order-lifecycle v1.2.0 ·
//         shopify-graphql-helper v1.0.0 — 05-09-2026

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const WORKER_VERSION   = '3.3.0';
const API_VERSION      = '2026-01';                          // صريح دايمًا — أبدًا "latest"
const TOOL_NAME        = 'bosta_return';                     // login/logout D1 logging only — unchanged
const SOURCE_TOOL      = 'bosta_orders_returned_scanner';    // used in extra.sourceTool for status-write logs
const SOURCE_TOOL_LIKE = `%"sourceTool":"${SOURCE_TOOL}"%`;
const BOSTA_API_BASE   = 'https://app.bosta.co/api/v2';

// الصلاحيات اللي الأداة مش هتشتغل من غيرها — بيتفحصوا في ?action=diag
// v3.3.0 — القايمة كانت أربعة بس بينما رأس الملف و`CLAUDE.md` بيقولوا سبعة.
// `read_locations` بالذات فحص الـ LOCATION_ID في diag معتمد عليها، وغيابها كان
// بيطلّع رسالة خطأ عامة بدل ما يقول اسم الصلاحية الناقصة.
const REQUIRED_SCOPES = [
  'read_orders', 'write_orders',
  'read_returns', 'write_returns',
  'read_inventory', 'write_inventory',
  'read_locations',
];

// ─── §CONSTANTS::log — سقف التصدير ───
// v3.3.0 — كان `LIMIT 2000` مكتوب حرفيًا جوه `getLogsExport`. السقف نفسه صح
// (مفيش تصدير بلا سقف)، الغلط إنه ما كانش بيرجع للواجهة — فالواجهة بتقول
// "تم التصدير ✓" على ملف مقصوص. دلوقتي بيرجع كـ `cap` جنب `total`/`truncated`.
const LOG_EXPORT_MAX = 2000;

// §CONSTANTS::status — verbatim strings from ecommoda-order-lifecycle (casing is load-bearing)
const S1_STATUS = {
  NEW_ORDER:      'New Order',
  CONFIRMED:      'Confirmed',
  WA_CONFIRMED:   'WhatsApp-Confirmed',
  WA_CANCELLED:   'WhatsApp-CANCELLED',
  CONFIRMED_EDIT: 'Confirmed + Edit',
  PENDING_EDIT:   'Pending Edit',
  READY:          'Ready',
  SHIPPED:        'Shipped',
  IN_RETURN:      'In-Return',
  DELIVERED:      'Delivered',
  RETURNED:       'Returned',
  CANCELLED:      'Cancelled',
};

const S2_STATUS = {
  CONFIRMED_RETURN:   'Confirmed + RETURN',
  CONFIRMED_EXCHANGE: 'Confirmed + EXCHANGE',
  READY:              'Ready',
  SHIPPED:            'Shipped',
  IN_RETURN:          'In-Return',
  RETURNED:           'Returned',
};

// §CONSTANTS::returnStatus — Shopify OrderReturnStatus enum. الحقل non-null
// (`OrderReturnStatus!`) يعني عمره ما بيرجع null: أوردر من غير مرتجعات بيرجع
// NO_RETURN صراحةً.
const RETURN_STATUS = {
  NO_RETURN:           'NO_RETURN',
  RETURN_REQUESTED:    'RETURN_REQUESTED',
  IN_PROGRESS:         'IN_PROGRESS',
  INSPECTION_COMPLETE: 'INSPECTION_COMPLETE',
  RETURNED:            'RETURNED',
  RETURN_FAILED:       'RETURN_FAILED',
};

// §CONSTANTS::env — المتغيرات المطلوبة لكل نوع عملية
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
  bosta:   ['BOSTA_API_KEY'],
  stock:   ['LOCATION_ID'],
};

// ══════════════════════════════════════════════════════════════
// §CORS — Option B (strict allow-list)
// v3.2.0: الأداة بقت بتلغي أوردرات وبتحرّك مخزون → أداة كتابة، مش قراءة.
// (`ecommoda-worker-builder` §3 · `ecommoda-constants` §5)
// ⚠️ ecommoda24.github.io مهجور ومتشال عمدًا.
// ══════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
];

function getCORS(request) {
  const origin  = request?.headers?.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] });
  return new Response(JSON.stringify(data), { status, headers });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── §HELPERS::cleanOrderName ───
// المفتاح الموحّد لأي اسم أوردر داخل هذا الـ Worker: بدون '#' وبدون مسافات.
// ⚠️ Bosta بيرجّع businessReference بالـ '#' (معيار إلزامي — راجع bosta-api-helper)،
// فأي مطابقة بين قيمة جاية من بوسطة ومفتاح ماب مبني من أسماء أوردرات لازم تعدّي
// من هنا — نفس الباج اللي ظهر في Shipped Scanner v2.0.0.
function cleanOrderName(v) {
  return String(v ?? '').replace(/^#/, '').trim();
}

// ─── §HELPERS::assertEnv ───
// v3.2.0 — متغير ناقص لازم يوقف العملية برسالة باسمه. قبل كده LOCATION_ID
// الناقص كان بيتحوّل لـ "gid://shopify/Location/undefined" وشوبيفاي بترفضه
// بخطأ علوي كان بيتبلع → استرجاع وهمي. (راجع ecommoda-debugger D1)
function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      const val = env[key];
      if (val === undefined || val === null || String(val).trim() === '') missing.push(key);
    }
  }
  if (!env.DB) missing.push('DB (D1 binding)');
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ` +
      `ضِفها من Dashboard → Settings → Variables ثم Promote النسخة. ` +
      `(شغّل ?action=diag للتفاصيل)`
    );
  }
}

// ─── §HELPERS::requireLocationId ───
// بيرجّع الـ LOCATION_ID بعد التأكد إنه رقم فعلاً. أي قيمة غير رقمية بتفشل هنا
// بوضوح بدل ما تتحول لـ GID غلط تفشل جوه الميوتيشن.
function requireLocationId(env) {
  const raw = String(env.LOCATION_ID ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `LOCATION_ID غير صالح ("${raw || 'فارغ'}") — لازم يكون رقم فقط ` +
      `(القيمة الرسمية لـ EcomModa: 98849620290 — راجع ecommoda-constants §1)`
    );
  }
  return raw;
}

// ══════════════════════════════════════════════════════════════
// §SHARED: Auth & Logging Functions — EcomModa D1 Pattern v1.2.0
// Copy this block VERBATIM into every Worker — no modifications
// ══════════════════════════════════════════════════════════════

async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;

  if (!row.is_active) {
    throw new Error('الحساب موقوف — تواصل مع المسؤول');
  }

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?')
    .bind(pin, username)
    .run();

  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

// ══════════════════════════════════════════════════════════════
// END §SHARED BLOCK
// ══════════════════════════════════════════════════════════════

// ─── §LOG-ENDPOINTS helpers — this tool's writes live under tool='metafields_change' ──
// Filtered by extra.sourceTool so this tool's log tab shows only its own entries,
// even though other EcomModa tools write to the same 'metafields_change' bucket.
//
// ⚠️ السجل التاريخي: قبل v3.0.0 كانت الأداة بتسجل تحت tool='bosta_return' و
// type='returned' (نظام التاجات القديم). الشرط تحت بيضم النوعين مع بعض عشان
// السجل القديم يفضل ظاهر — من غيره تاب السجل بيبان فاضي تمامًا.
//
// ⚠️ ليه مفيش `AND tool = ?` زي `references/shared-functions.md`: نطاق الأداة
// دي مش قيمة `tool` واحدة — هو **كاتب** جوه دلو مشترك (`metafields_change`)
// بيميّزه `extra.sourceTool`، زائد نطاق تاريخي باسم قديم. باقي العقد (القوايم
// المتعددة · مدى التاريخ · استبعاد login/logout في SQL · مصدر شرط واحد للتلات
// دوال) متطبّق حرفيًا.
const LOG_SCOPE_SQL = `(
     (tool = 'metafields_change' AND type = 'update'   AND extra LIKE ?)
  OR (tool = 'bosta_return'      AND type = 'returned')
)`;

// ─── §LOG-ENDPOINTS::buildLogFilterSQL ───
// v3.3.0 — بنّاء الشرط الوحيد للتلات دوال (`get_logs` · `get_logs_count` ·
// `get_logs_export`)، فمفيش SQL مكرر يتعتّق في واحدة ويسيب التانية — وده
// بالظبط اللي بيخلي التصدير ينزّل غير المعروض.
//
// كل الباراميترات اختيارية، والسلوك من غيرها **مطابق للنسخة القديمة بالحرف**:
//   employees[] / types[] / results[] / machines[]  → قوايم (multi-select
//        إلزامي في أي شاشة فيها جدول — `data-table-standard` بند ٢١).
//   employee / type                                → قيمة واحدة، متسابة للتوافق.
//   results[] / machines[] بيتفلتروا على `extra` JSON (`"result":"warning"` ·
//        `"machine":"S1"`) — دول الفلترين اللي ليهم معنى تشغيلي في الأداة دي،
//        لأن كل صفوفها `type = 'update'`.
//   dateFrom / dateTo → بيتقارنوا بـ substr(timestamp,1,10) يعني **UTC**، والعرض
//        بتوقيت القاهرة (UTC+3). فرق التلات ساعات ممكن يحط عملية بعد ٩ مساءً
//        بتوقيت القاهرة في يوم UTC اللي بعده. مقبول لفلتر بالأيام — **بس مكتوب**.
function buildLogFilterSQL(select, {
  employee = null, employees = null,
  type     = null, types     = null,
  results  = null, machines  = null,
  search   = null,
  dateFrom = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout') AND ${LOG_SCOPE_SQL}`;
  const b = [SOURCE_TOOL_LIKE];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (emps.length) { sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps); }
  if (typs.length) { sql += ` AND type IN (${typs.map(() => '?').join(',')})`;     b.push(...typs); }

  if (Array.isArray(results) && results.length) {
    sql += ` AND (${results.map(() => 'extra LIKE ?').join(' OR ')})`;
    b.push(...results.map(v => `%"result":"${v}"%`));
  }
  if (Array.isArray(machines) && machines.length) {
    sql += ` AND (${machines.map(() => 'extra LIKE ?').join(' OR ')})`;
    b.push(...machines.map(v => `%"machine":"${v}"%`));
  }

  if (search)   { sql += ' AND (order_name LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

// ─── §LOG-ENDPOINTS::getLogs ───
// صفحة واحدة للعرض — السقف 100 صف، مفروض من السيرفر. ⚠️ ممنوع تستخدمها
// للتصدير (`getLogsExport` هي المخصصة لده).
async function getLogs(db, { limit = 100, offset = 0, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  return (await db.prepare(q).bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

// ─── §LOG-ENDPOINTS::getLogsCount ───
// بيتنادى بالتوازي مع `getLogs` (للـ pagination) **ومع `getLogsExport`** (عشان
// `total` و`truncated`). نفس الفلاتر بالظبط — نداء بفلاتر مختلفة بيطلّع نسبة
// "٢٠٠٠ من ٥٠٠٠" كذّابة، وهي أسوأ من مفيش رقم.
async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

// ─── §LOG-ENDPOINTS::getLogsExport ───
// ⚠️ الدالة دي **بتقص في السكوت** بطبيعتها عند `LOG_EXPORT_MAX`. المسؤولية
// اللي جنبها إلزامية: الـ endpoint لازم يرجّع `cap` و`total` و`truncated`.
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

// ─── §LOG-ENDPOINTS::logParamsFrom ───
// مصدر واحد لقراءة الفلاتر من الـ query string — التلات endpoints بتستخدمه،
// فمفيش endpoint بيفلتر بشكل مختلف عن اللي جنبه. القوايم CSV.
function logParamsFrom(url) {
  const csv = (k) => (url.searchParams.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  const results   = csv('results'),   machines = csv('machines');
  return {
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    results:   results.length  ? results  : null,
    machines:  machines.length ? machines : null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

// ══════════════════════════════════════════════════════════════
// §BOSTA
// ══════════════════════════════════════════════════════════════

// ⚠️ state.value بيرجع "Delivered" لكلٍّ من code 45 و code 46 — دايمًا STATE_MAP[code]
const STATE_MAP = {
  10:  'Pickup requested',
  11:  'Waiting for route',
  20:  'Route Assigned',
  21:  'Picked up from business',
  22:  'Picking up from consignee',
  23:  'Picked up from consignee',
  24:  'Received at warehouse',
  25:  'Fulfilled',
  30:  'In transit between Hubs',
  40:  'Picking up',
  41:  'Picked up',
  45:  'Delivered',
  46:  'Returned to business',
  47:  'Exception',
  48:  'Terminated',
  49:  'Canceled',
  60:  'Returned to stock',
  100: 'Lost',
  101: 'Damaged',
  102: 'Investigation',
  103: 'Awaiting your action',
  104: 'Archived',
  105: 'On hold',
};

// بوسطة بترجّع ٤ أشكال مختلفة للرد — لازم يتغطوا كلهم
function extractDeliveries(raw) {
  if (Array.isArray(raw?.data?.deliveries)) return raw.data.deliveries;
  if (Array.isArray(raw?.data))             return raw.data;
  if (Array.isArray(raw?.deliveries))       return raw.deliveries;
  if (raw?.trackingNumber)                  return [raw];
  return [];
}

// ─── §BOSTA::searchDeliveries ───
// v3.2.0 — الفشل بقى بيترمي بدل ما يتبلع. النداء ده كان جوه try/catch فاضي
// (`catch (_) {}`) + `if (!res.ok) continue;` — يعني مفتاح غلط أو بوسطة واقعة
// كانوا بيديّوا نفس النتيجة بالظبط: "كل الأرقام غير موجودة ببوسطة". الموظف
// كان بيفتكر إن الشحنات مش موجودة أصلاً.
async function searchDeliveries(env, trackingNumbers) {
  const res = await fetch(`${BOSTA_API_BASE}/deliveries/search`, {
    method:  'POST',
    headers: { Authorization: env.BOSTA_API_KEY, 'Content-Type': 'application/json' }, // ✅ بدون "Bearer"
    body: JSON.stringify({
      trackingNumbers: trackingNumbers.map(String),
      limit: trackingNumbers.length,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' — غالبًا BOSTA_API_KEY غلط أو منتهي'
      : '';
    throw new Error(`بوسطة رجّعت HTTP ${res.status}${hint}: ${text.slice(0, 180)}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`رد بوسطة مش JSON صالح: ${text.slice(0, 180)}`); }

  return extractDeliveries(data);
}

// ══════════════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════════════

async function getAccessToken(env) {
  const resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      grant_type:    'client_credentials',
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`فشل OAuth مع شوبيفاي (HTTP ${resp.status}) — راجع CLIENT_ID/CLIENT_SECRET/SHOP_DOMAIN: ${body.slice(0, 160)}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error('شوبيفاي ردّت بدون access_token');
  return data.access_token;
}

// ─── §SHOPIFY::shopifyGQL ───
// ⭐ الدالة دي هي إصلاح v3.2.0 الأساسي.
//
// النسخة القديمة كانت `return resp.json();` وبس. يعني:
//   • HTTP 401/403/429/5xx  → بيعدّي كأنه رد عادي
//   • أخطاء GraphQL عليا     → `data: null` والـ userErrors بتبقى [] → "نجاح"
//   • رد مش JSON             → استثناء غامض
// وده بالظبط اللي خلّى الأداة تقول `reverseDispose×1` وهي ما رجّعتش ولا قطعة:
// شوبيفاي كانت بترد
//   {"errors":[{"message":"Access denied for reverseFulfillmentOrderDispose
//     field. Required access: `write_returns` access scope."}],"data":null}
// والكود كان بيقرا `data.data.reverseFulfillmentOrderDispose.userErrors` = []
// → مفيش خطأ → يعتبرها نجاح.
//
// دلوقتي أي فشل بيترمي كـ Error برسالة فيها اسم العملية + النص الحقيقي من
// شوبيفاي، وبيوصل للموظف في الواجهة وللسجل في D1.
// + إعادة محاولة تلقائية على THROTTLED / 429 / 5xx (الأداة بتعمل نداءات
//   متتابعة كتير لكل أوردر، والـ throttle وارد جدًا في دفعة كبيرة).
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify') {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
      throw lastErr;
    }

    // ① HTTP status — كان متجاهَل تمامًا قبل v3.2.0
    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await sleep(700 * attempt); continue; }
      throw lastErr;
    }

    // ② رد مش JSON (صفحة خطأ من Cloudflare/Shopify مثلاً)
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    // ③ أخطاء GraphQL عليا — هنا بالظبط كان بيضيع السبب الحقيقي
    if (Array.isArray(data.errors) && data.errors.length) {
      const codes  = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      const isThrottled = codes.includes('THROTTLED');
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (isThrottled && attempt < MAX_ATTEMPTS) { await sleep(1200 * attempt); continue; }
      throw lastErr;
    }

    // ④ رد سليم شكلاً لكن بدون data
    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);

    return data;
  }

  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}

// ─── §SHOPIFY::fetchShopifyOrdersByNames ───
// بيجمع عدة أوردرات في نداء واحد بالـ aliases (o0, o1, …) لحد 20 في المرة.
// v3.2.0 — إضافتان مهمتان:
//   • التحقق من الاسم: بحث شوبيفاي `name:#X` ممكن يرجّع أوردر **مقارب** مش
//     مطابق. بنقارن اسم الأوردر الراجع بالمطلوب، وأي اختلاف = "غير موجود"
//     بدل ما نكتب حالة على أوردر تاني.
//   • أي اسم فيه حروف غير مسموحة بيترفض صراحةً بدل ما يتنضّف بصمت ويتحوّل
//     البحث لاسم تاني.
// Returns { [cleanName]: { orderId, orderGid, orderName, s1, s2, returnStatus } | null }
async function fetchShopifyOrdersByNames(env, token, orderNames) {
  const clean = [...new Set(orderNames.map(cleanOrderName).filter(Boolean))];
  if (!clean.length) return {};

  const CHUNK = 20;
  const map = {};

  for (let i = 0; i < clean.length; i += CHUNK) {
    const chunk = clean.slice(i, i + CHUNK);

    const usable = chunk.filter(name => {
      const safe = name.replace(/[^a-zA-Z0-9\-]/g, '');
      if (safe !== name) { map[name] = null; return false; }   // اسم غير صالح → مش هنبحث باسم مختلف
      return true;
    });
    if (!usable.length) continue;

    const aliasBlocks = usable.map((name, idx) => `o${idx}: orders(first: 1, query: "name:#${name}") {
        edges { node {
          id
          legacyResourceId
          name
          returnStatus
          s1: metafield(namespace: "custom", key: "manual_status") { value }
          s2: metafield(namespace: "custom", key: "status_2_r_e") { value }
        } }
      }`).join('\n');

    const resp = await shopifyGQL(env, token, `query { ${aliasBlocks} }`, {}, 'بحث الأوردرات');
    const data = resp.data || {};

    usable.forEach((name, idx) => {
      const node = data[`o${idx}`]?.edges?.[0]?.node || null;
      // ⚠️ التحقق من الاسم — مطابقة تامة بعد التنظيف
      if (!node || cleanOrderName(node.name) !== name) { map[name] = null; return; }
      map[name] = {
        orderId:      node.legacyResourceId,   // numeric — لازم للـ orderLink() في الواجهة
        orderGid:     node.id,
        orderName:    node.name,
        s1:           node.s1?.value || null,
        s2:           node.s2?.value || null,
        returnStatus: node.returnStatus || null,
      };
    });
  }

  return map;
}

// ─── §SHOPIFY::validateTransition ───
// جدول القرار (لا يعتمد على Bosta state.code خالص — السكان نفسه هو تأكيد
// الاستلام الفعلي بالمخزن، وبوسطة ممكن تتأخر):
//
//   Bosta orderType == "Send" → رفض فوري.
//
//   أي orderType تاني:
//     مسار RTO (S1) :
//       S1 ∈ {Shipped, In-Return} AND S2 فاضي AND returnStatus = NO_RETURN
//       → custom.manual_status = "Returned"
//     مسار مرتجع بعد التسليم (S2) :
//       S1 = Delivered AND S2 ∈ {Shipped, In-Return} AND returnStatus = IN_PROGRESS
//       → custom.status_2_r_e = "Returned"
//
// ⚠️ v3.2.0 — RETURN_REQUESTED اتشال من المسار الثاني (قرار Ahmed 23-08-2026).
// السبب: في الحالة دي المرتجع لسه مطلوب ومش متعمله approve، يعني شوبيفاي لسه
// ما أنشأتش أي reverseFulfillmentOrder — فالميتافيلد كان هيتكتب "Returned"
// والمخزون ما يرجعش، وهو بالظبط نوع الفشل النصفي اللي الإصدار ده بيقفله.
function validateTransition(orderType, sOrder) {
  // ⚠️ قرار مقصود (مؤكَّد من أحمد 05-09-2026): `Send` هو الرفض الوحيد على مستوى
  // نوع الشحنة. أي نوع تاني من بوسطة — `RTO` · `Return` · `EXCHANGE` ·
  // `CUSTOMER_RETURN_PICKUP` · حتى `CASH_COLLECTION` — بيعدّي لفحص شوبيفاي،
  // وحراسات S1/S2/returnStaty تحت هي اللي بترفض اللي مالوش مسار صحيح.
  // ده **مش سهو**: قايمة أنواع بوسطة بتتوسّع من غير إشعار، وقايمة سماح مقفولة
  // كانت هترفض شحنات مرتجعة سليمة بسبب اسم نوع جديد.
  const isSend = String(orderType || '').trim().toLowerCase() === 'send';
  if (isSend) {
    return { valid: false, reason: 'نوع الشحنة "Send" — شحن أصلي، مش من اختصاص أداة المرتجعات' };
  }

  const { s1, s2, returnStatus } = sOrder;

  // مسار RTO — شحنة أصلية رجعت للمخزن قبل أي استلام
  const s1ShippedOrInReturn = s1 === S1_STATUS.SHIPPED || s1 === S1_STATUS.IN_RETURN;
  const s2Blank             = !s2;
  const isNoReturn          = returnStatus === RETURN_STATUS.NO_RETURN;

  if (s1ShippedOrInReturn && s2Blank && isNoReturn) {
    return { valid: true, machine: 'S1', targetField: 'custom.manual_status', targetValue: S1_STATUS.RETURNED };
  }

  // مسار مرتجع بعد التسليم — مرتجع/استبدال متعمله approve وجاي في الطريق
  const s1Delivered         = s1 === S1_STATUS.DELIVERED;
  const s2ShippedOrInReturn = s2 === S2_STATUS.SHIPPED || s2 === S2_STATUS.IN_RETURN;
  const returnInProgress    = returnStatus === RETURN_STATUS.IN_PROGRESS;

  if (s1Delivered && s2ShippedOrInReturn && returnInProgress) {
    return { valid: true, machine: 'S2', targetField: 'custom.status_2_r_e', targetValue: S2_STATUS.RETURNED };
  }

  // مفيش أي مسار انطبق — سبب مفصّل لكل مسار (order-lifecycle Rule 10)
  const failsRTO = [];
  if (!s1ShippedOrInReturn) failsRTO.push(`S1 لازم يكون Shipped أو In-Return (الحالي: ${s1 || '—'})`);
  if (!s2Blank)             failsRTO.push(`S2 لازم يكون فاضي (الحالي: ${s2 || '—'})`);
  if (!isNoReturn)          failsRTO.push(`returnStatus لازم يكون NO_RETURN (الحالي: ${returnStatus || '—'})`);

  const failsReturn = [];
  if (!s1Delivered)         failsReturn.push(`S1 لازم يكون Delivered (الحالي: ${s1 || '—'})`);
  if (!s2ShippedOrInReturn) failsReturn.push(`S2 لازم يكون Shipped أو In-Return (الحالي: ${s2 || '—'})`);
  if (!returnInProgress) {
    failsReturn.push(
      returnStatus === RETURN_STATUS.RETURN_REQUESTED
        ? 'المرتجع لسه RETURN_REQUESTED — محتاج approve من CS الأول عشان شوبيفاي تنشئ الـ reverse fulfillment order، وإلا المخزون مش هيرجع'
        : `returnStatus لازم يكون IN_PROGRESS (الحالي: ${returnStatus || '—'})`
    );
  }

  return {
    valid: false,
    reason: `[RTO] ${failsRTO.join('، ')} — [مرتجع بعد التسليم] ${failsReturn.join('، ')}`,
  };
}

// ─── §SHOPIFY::writeSingleMetafield ───
// v3.2.0 — بقت نداء مباشر بدل الـ batch helper القديم (الكتابة بقت أوردر أوردر
// من v3.1.0 أصلاً). التأكيد بقى على القيمة نفسها: مش بس "مفيش userErrors"،
// لكن **شوبيفاي رجّعت نفس المالك ونفس القيمة**.
// ⚠️ النوع `Metafield` مفيهوش حقل `ownerId` — الحقل الصحيح `owner` (interface
// HasMetafields) وبنستخرج الـ ID بـ inline fragment على Order.
const METAFIELDS_SET_MUTATION = `
  mutation SetOne($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key value owner { ... on Order { id } } }
      userErrors { field message code }
    }
  }
`;

async function writeSingleMetafield(env, token, ownerId, key, value) {
  const resp = await shopifyGQL(env, token, METAFIELDS_SET_MUTATION, {
    metafields: [{ ownerId, namespace: 'custom', key, type: 'single_line_text_field', value }],
  }, `كتابة الميتافيلد ${key}`);

  const result = resp.data?.metafieldsSet;
  const errs   = result?.userErrors || [];
  if (errs.length) {
    throw new Error(`metafieldsSet: ${errs.map(e => `${e.message}${e.code ? ` (${e.code})` : ''}`).join(' | ')}`);
  }

  const written = (result?.metafields || []).find(
    m => m?.owner?.id === ownerId && m?.key === key   // ← owner.id مش ownerId
  );
  if (!written) throw new Error('metafieldsSet: شوبيفاي ما أكدتش كتابة الميتافيلد');
  if (written.value !== value) {
    throw new Error(`metafieldsSet: القيمة المكتوبة "${written.value}" مش نفس المطلوبة "${value}"`);
  }
  return true;
}

// ─── §SHOPIFY::cancelOrder ───
// ⚠️ IRREVERSIBLE — مفيش ميوتيشن بيلغي إلغاء أوردر.
// بتُستخدم في مسار RTO بس (S1 = Returned): الشحنة عمرها ما وصلت العميل، فالإلغاء
// + الاسترجاع هو الناتج الصحيح.
//
// ⚠️ ملاحظة مهمة: orderCancel بترجّع **job** — يعني الإلغاء بيتنفّذ بعد الرد.
// عشان كده التأكيد النهائي بيتم في verifyCancels() بعد الدفعة، مش من الرد ده.
async function cancelOrder(env, token, orderGid) {
  const resp = await shopifyGQL(env, token, `
    mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!,
                         $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean) {
      orderCancel(orderId: $orderId, reason: $reason, refund: $refund,
                  restock: $restock, notifyCustomer: $notifyCustomer) {
        job { id }
        orderCancelUserErrors { field message code }
      }
    }
  `, {
    orderId: orderGid,
    reason: 'CUSTOMER',
    refund: false,
    restock: true,
    notifyCustomer: false,
  }, 'إلغاء الأوردر');

  const errs = resp.data?.orderCancel?.orderCancelUserErrors || [];
  if (errs.length) {
    throw new Error(`orderCancel: ${errs.map(e => `${e.message}${e.code ? ` (${e.code})` : ''}`).join(' | ')}`);
  }
  const jobId = resp.data?.orderCancel?.job?.id || null;
  if (!jobId) throw new Error('orderCancel: شوبيفاي ما رجّعتش job — الإلغاء مش مضمون');
  return jobId;
}

// ─── §SHOPIFY::fetchOrderReturns ───
// بيجيب بلوك المرتجعات لأوردر واحد **مع الـ dispositions** — دي الإضافة اللي
// بتخلي حساب "الكمية المتبقية" ممكن (راجع disposeReturns).
async function fetchOrderReturns(env, token, orderGid) {
  const resp = await shopifyGQL(env, token, `
    query OrderReturns($id: ID!) {
      order(id: $id) {
        id
        name
        returns(first: 20) {
          nodes {
            id
            name
            status
            reverseFulfillmentOrders(first: 20) {
              nodes {
                id
                status
                lineItems(first: 100) {
                  nodes {
                    id
                    totalQuantity
                    dispositions { id type quantity location { id } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { id: orderGid }, 'قراءة مرتجعات الأوردر');

  return resp.data?.order?.returns?.nodes || [];
}

// ─── §SHOPIFY::summarizeReturns ───
// ملخّص كمّي للمرتجعات: الإجمالي، اللي اترجع للمخزن فعلاً (RESTOCKED على
// اللوكيشن بتاعنا)، واللي اتعمله disposition تاني (تالف/مرفوض…)، والمتبقي.
function summarizeReturns(returns, locationId) {
  const locGid = `gid://shopify/Location/${locationId}`;
  let total = 0, restockedHere = 0, otherDisposed = 0, remaining = 0, openRfos = 0, nonOpenRfos = 0;

  for (const ret of (returns || [])) {
    for (const rfo of (ret.reverseFulfillmentOrders?.nodes || [])) {
      if (rfo.status === 'OPEN') openRfos++; else nonOpenRfos++;
      for (const li of (rfo.lineItems?.nodes || [])) {
        const t = li.totalQuantity || 0;
        total += t;
        let done = 0;
        for (const d of (li.dispositions || [])) {
          const q = d.quantity || 0;
          done += q;
          if (d.type === 'RESTOCKED' && (!d.location?.id || d.location.id === locGid)) restockedHere += q;
          else otherDisposed += q;
        }
        remaining += Math.max(0, t - done);
      }
    }
  }
  return { total, restockedHere, otherDisposed, remaining, openRfos, nonOpenRfos };
}

// ─── §SHOPIFY::disposeReturns ───
// بترجّع للمخزون **الكمية المتبقية فقط** من كل reverse-fulfillment-order مفتوح.
//
// ليه الكمية المتبقية مش totalQuantity؟ سببين اتأكدوا على بيانات حقيقية:
//   ① الـ RFO بيفضل `status: OPEN` حتى بعد ما القطع ترجع بالكامل (اتأكد على
//      #50469 و#48383 و#49231: RFO مفتوح ومعاه disposition RESTOCKED كامل).
//      يعني شرط OPEN لوحده ما بيمنعش الاسترجاع المزدوج.
//   ② لو حد سبقنا (Flow قديم / استلام يدوي من الأدمن) الميوتيشن بترجّع
//      "Invalid disposition quantity" — وهو الخطأ الحقيقي الوحيد اللي ظهر في
//      سجل Order Status Updater (#50243). دلوقتي بنقول "مسترجَع قبل كده" بدل
//      ما نفشل.
//
// بترجّع تفصيل كامل بدل رقم واحد: { requested, confirmed, alreadyDone, remainingAfter, skipped }
async function disposeReturns(env, token, locationId, returns) {
  const locGid = `gid://shopify/Location/${locationId}`;
  const out = { requested: 0, confirmed: 0, alreadyDone: 0, skippedNotOpen: 0, conflicts: 0, calls: 0 };

  for (const ret of (returns || [])) {
    for (const rfo of (ret.reverseFulfillmentOrders?.nodes || [])) {
      if (rfo.status !== 'OPEN') { out.skippedNotOpen++; continue; }

      const inputs = [];
      for (const li of (rfo.lineItems?.nodes || [])) {
        const total = li.totalQuantity || 0;
        const done  = (li.dispositions || []).reduce((s, d) => s + (d.quantity || 0), 0);
        const rest  = total - done;
        if (rest <= 0) { out.alreadyDone += total; continue; }
        inputs.push({
          reverseFulfillmentOrderLineItemId: li.id,
          quantity:        rest,
          locationId:      locGid,
          dispositionType: 'RESTOCKED',
        });
        out.requested += rest;
      }

      if (!inputs.length) continue;

      const resp = await shopifyGQL(env, token, `
        mutation ReverseDispose($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
          reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
            reverseFulfillmentOrderLineItems { id totalQuantity dispositions { id type quantity } }
            userErrors { field message }
          }
        }
      `, { dispositionInputs: inputs }, 'استرجاع المخزون');
      out.calls++;

      const result = resp.data?.reverseFulfillmentOrderDispose;
      const errs   = result?.userErrors || [];
      if (errs.length) {
        const msg = errs.map(e => e.message).join(' | ');
        // ⚠️ v3.3.0 — الحالة دي كانت متوثّقة في التعليق فوق ("بنقول مسترجَع قبل
        // كده بدل ما نفشل") ومكانتش متنفّذة فعليًا. بتحصل لما حد يسبقنا بين
        // القراءة والكتابة (Flow / استلام يدوي) فالكمية المتبقية بتبقى قديمة.
        // مش فشل — القطع رجعت للمخزن فعلاً، بس مش إحنا اللي رجّعناها.
        if (/invalid disposition quantity/i.test(msg)) {
          const q = inputs.reduce((s, i) => s + i.quantity, 0);
          out.requested   -= q;
          out.alreadyDone += q;
          out.conflicts++;
          continue;
        }
        throw new Error(`reverseDispose: ${msg}`);
      }

      // ⚠️ العدّ من رد شوبيفاي — مش من المطلوب. النسخة القديمة كانت
      // `disposed += inputs.length` من غير ما تبص على الرد أصلاً.
      const acked = result?.reverseFulfillmentOrderLineItems || [];
      const ackedIds = new Set(acked.map(li => li.id));
      const missing  = inputs.filter(i => !ackedIds.has(i.reverseFulfillmentOrderLineItemId));
      if (missing.length) {
        throw new Error(`reverseDispose: شوبيفاي أكدت ${acked.length} بند من ${inputs.length} — العملية غير مكتملة`);
      }
      out.confirmed += inputs.reduce((s, i) => s + i.quantity, 0);
    }
  }

  return out;
}

// ─── §SHOPIFY::VERIFY_DELAYS_MS ───
// backoff متصاعد، مجموعه ≈٦ ثوانٍ. الأرقام دي مش اختيار حر — هي النمط المعتمد
// في `ecommoda-worker-builder` Step 5A ③ بعد قياس فعلي على `#53033`.
const VERIFY_DELAYS_MS = [400, 700, 1100, 1600, 2200];

// ─── §SHOPIFY::areJobsDone ───
// فحص حالة أكتر من Job في نداء واحد بالـ aliases (مش نداء لكل أوردر).
// القيمة لكل job: true / false / **null**. و`null` معناها "ما عرفناش" —
// يعني **كمّل واقرا المورد**، مش "لسه شغّال". الفرق ده مهم: لو الاستعلام نفسه
// فشل وحسبناها "لسه شغّال"، هنتخطى القراءة اللي كانت هتأكد الإلغاء فعلاً.
async function areJobsDone(env, token, jobIds) {
  const uniq = [...new Set(jobIds.filter(Boolean))];
  const out  = {};
  for (const id of uniq) out[id] = null;

  for (let i = 0; i < uniq.length; i += 20) {
    const chunk   = uniq.slice(i, i + 20);
    const varDefs = chunk.map((_, idx) => `$id${idx}: ID!`).join(', ');
    const body    = chunk.map((_, idx) => `j${idx}: job(id: $id${idx}) { id done }`).join('\n        ');
    const vars    = {};
    chunk.forEach((id, idx) => { vars[`id${idx}`] = id; });

    try {
      const resp = await shopifyGQL(env, token, `query JobsDone(${varDefs}) {\n        ${body}\n      }`, vars, 'حالة الـ Jobs');
      chunk.forEach((id, idx) => {
        const done = resp.data?.[`j${idx}`]?.done;
        out[id] = typeof done === 'boolean' ? done : null;
      });
    } catch {
      // بنسيبهم null — "ما عرفناش" مش "لسه شغّال"
    }
  }
  return out;
}

// ─── §SHOPIFY::verifyCancels ───
// تحقق مجمّع بعد الدفعة: `orderCancel` بترجّع job، والإلغاء الحقيقي بيحصل بعد
// الرد بثانية أو اتنين. من غير التحقق ده الأداة ممكن تقول "تم" على أوردر
// الإلغاء بتاعه فشل في الخلفية — نفس عائلة الفشل الصامت اللي بنقفلها.
//
// ⚠️ v3.3.0 — "تحقق لاحق" لوحدها **مش كفاية**، والنسخة القديمة هنا كانت مثال
// حي على ده: مدد نوم ثابتة [1200,2000,3000] وقراءة للأوردر من غير أي نظرة على
// الـ Job نفسه. `Order-Cancel` كانت مطبّقة نفس الفكرة حرفيًا وكانت غلط — الدليل
// المقاس (D1 + شوبيفاي، `#53033`، 01-09-2026): الميوتيشن اتقبلت 07:51:25Z،
// الـ Worker قرا 07:51:26.084Z ولقى `cancelledAt = null` وسجّل confirmed:false،
// وشوبيفاي سجّلت `cancelledAt` في 07:51:27Z. النتيجة إن **كل** إلغاء ناجح
// بيظهر أصفر "لسه مش مؤكَّد" — الحالة الاستثنائية بقت الافتراضية، والموظف
// بيتعوّد يتجاهل الأصفر، فلما يحصل إلغاء فعلًا مش مؤكَّد مفيش إشارة.
//
// النمط المعتمد: backoff متصاعد + فحص `job(id){ done }` نفسه، والوقوف على أول
// تأكيد. مفيش نوم ثابت غير مشروط.
//
// بيتأكد من حاجتين لكل أوردر:
//   • cancelledAt اتسجّل فعلاً
//   • فيه دليل استرجاع مخزون (refundLineItems بكمية > 0 اتعملت بعد بداية
//     العملية) — لأن الإلغاء نفسه مش معناه إن المخزون رجع.
//
// وبيسجّل على كل سجل `{ jobDone, attempts, waitedMs }` — انتهاء المهلة من غير
// تأكيد = **`warning`** (مش "تم" ومش "فشل")، والأرقام دي هي اللي بتخلي الأصفر
// قابل للتشخيص بعدين بدل ما يكون مجرد "مش عارفين".
async function verifyCancels(env, token, records) {
  const pending = records.filter(r => r.needsCancelVerify);
  if (!pending.length) return;

  // ⚠️ دمج مش استبدال — النسخة القديمة كانت بتكتب object جديد فوق القديم
  // فبيضيع `jobId` (والـ `verifyError`)، والتحذير بيفضل من غير أي خيط تشخيص.
  pending.forEach(r => {
    r.cancel = { ...(r.cancel || {}), verified: false, jobDone: null, attempts: 0, waitedMs: 0 };
  });

  let waitedMs = 0;

  for (let attempt = 0; attempt < VERIFY_DELAYS_MS.length; attempt++) {
    const left = pending.filter(r => !r.cancel.verified);
    if (!left.length) return;

    await sleep(VERIFY_DELAYS_MS[attempt]);
    waitedMs += VERIFY_DELAYS_MS[attempt];
    left.forEach(r => { r.cancel.attempts = attempt + 1; r.cancel.waitedMs = waitedMs; });

    // ① الـ Job نفسه — نداء واحد مجمّع. اللي لسه شغّال (`false` صريحة)
    //    مانضيّعش عليه نداء قراءة في الجولة دي.
    const jobTargets = left.filter(r => r.cancel.jobId && r.cancel.jobDone !== true);
    if (jobTargets.length) {
      const doneMap = await areJobsDone(env, token, jobTargets.map(r => r.cancel.jobId));
      jobTargets.forEach(r => {
        const d = doneMap[r.cancel.jobId];
        r.cancel.jobDone = (d === undefined ? null : d);
      });
    }

    const toRead = left.filter(r => r.cancel.jobDone !== false);
    if (!toRead.length) continue;

    // ② قراءة المورد نفسه — الدليل النهائي
    for (let i = 0; i < toRead.length; i += 20) {
      const chunk = toRead.slice(i, i + 20);
      let resp;
      try {
        resp = await shopifyGQL(env, token, `
          query VerifyCancel($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Order {
                id
                name
                cancelledAt
                s1: metafield(namespace: "custom", key: "manual_status") { value }
                refunds(first: 20) {
                  id
                  createdAt
                  refundLineItems(first: 100) { nodes { quantity restockType location { id } } }
                }
              }
            }
          }
        `, { ids: chunk.map(r => r.orderGid) }, 'التحقق من الإلغاء');
      } catch (e) {
        // التحقق نفسه فشل — نسجّله كتحذير، مش كفشل للعملية
        chunk.forEach(r => { r.cancel.verifyError = e.message; });
        continue;
      }

      const byGid = {};
      for (const n of (resp.data?.nodes || [])) if (n?.id) byGid[n.id] = n;

      for (const r of chunk) {
        const node = byGid[r.orderGid];
        if (!node) continue;

        // ⚠️ نافذة ٥ ثوانٍ للفرق في الساعات بس — النسخة القديمة كانت ١٢٠ ثانية
        // **قبل** بداية العملية، يعني refund قديم قريب كان بيتحسب دليل استرجاع
        // كاذب على إلغاء النهاردة.
        const restockedUnits = (node.refunds || [])
          .filter(rf => !r.startedAt || new Date(rf.createdAt).getTime() >= new Date(r.startedAt).getTime() - 5000)
          .flatMap(rf => rf.refundLineItems?.nodes || [])
          .filter(li => li.restockType && li.restockType !== 'NO_RESTOCK')
          .reduce((s, li) => s + (li.quantity || 0), 0);

        r.cancel.verified     = !!node.cancelledAt;
        r.cancel.cancelledAt  = node.cancelledAt || null;
        r.cancel.restockedUnits = restockedUnits;
        r.cancel.metafieldNow = node.s1?.value || null;
        if (r.cancel.verified) { r.cancel.jobDone = true; delete r.cancel.verifyError; }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // 1. CORS Preflight — always first
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    // 2. WORKER_SECRET check — always second
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return json({ error: 'Unauthorized' }, 401, request);

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {
      // ─── §AUTH ──────────────────────────────────────────────────────────

      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);
        await writeLog(env.DB, {
          tool:     TOOL_NAME,
          type:     'login',
          employee: username,
          notes:    `دخول: ${displayName}`,
        });
        return json({ ok: true, displayName }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        if (username) {
          await writeLog(env.DB, {
            tool:     TOOL_NAME,
            type:     'logout',
            employee: username,
            notes:    `خروج: ${username.replace(/_/g, ' ')}`,
          });
        }
        return json({ ok: true }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }

      // ─── §CONFIG / §DIAG ────────────────────────────────────────────────

      // get_config — الواجهة بتقارن النسخة دي بنسختها وبتحذّر لو مختلفين.
      // ده بيكشف "الـ deploy نجح والأداة زي ما هي" (Worker شبح) و"السر اتضاف
      // بس النسخة متنشرتش" — الاتنين في `ecommoda-debugger` D5/D6.
      if (action === 'get_config') {
        return json({
          ok: true,
          version:    WORKER_VERSION,
          apiVersion: API_VERSION,
          serverTime: new Date().toISOString(),
        }, 200, request);
      }

      // diag — فحص ذاتي كامل، صفر كتابة، صفر أثر جانبي.
      // الفحص ده كان هيكشف عطل 19→23-08 في ٥ ثواني: صلاحية write_returns.
      if (action === 'diag') return handleDiag(request, env);

      // ─── §LOOKUP / §UPDATE ──────────────────────────────────────────────

      if (action === 'lookup') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        return handleLookup(request, env);
      }

      if (action === 'update') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        return handleUpdate(request, env);
      }

      // ─── §LOG-ENDPOINTS ─────────────────────────────────────────────────

      if (action === 'get_logs') {
        const p = logParamsFrom(url);
        // v3.2.0 — حراسة الأرقام: parseInt على قيمة غلط كان بيدي NaN → D1 error غامض
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '100', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',   10);
        const limit    = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        const offset   = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

        const entries = await getLogs(env.DB, { ...p, limit, offset });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url));
        return json({ ok: true, total }, 200, request);
      }

      // get_logs_export — الصفوف **والحقيقة** مع بعض.
      // ⛔ ممنوع يرجّع `entries` لوحدها: `getLogsExport` بتقص عند LOG_EXPORT_MAX
      // في السكوت، فالواجهة كانت بتقول "تم التصدير ✓" على ملف ناقص والموظف
      // فاكره كامل. `total` بيتحسب **بنفس الفلاتر بالظبط**.
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),
        ]);
        return json({
          ok: true, entries,
          cap: LOG_EXPORT_MAX,
          total,
          truncated: total > LOG_EXPORT_MAX,
        }, 200, request);
      }

      return json({ error: 'Unknown action' }, 404, request);
    } catch (err) {
      return json({ error: err.message }, 500, request);
    }
  },
};

// ─── §DIAG::handleDiag ───
// فحص ذاتي بدون أي كتابة. كل فحص بيرجع { ok, detail } وبنرجّع allOk في الآخر.
//
// ⚠️ ممنوع إرجاع قيمة أي سر — أطوال بس. عرض الأسماء بـ JSON.stringify مقصود:
// بيكشف المسافة المخفية في اسم المتغير (`ecommoda-debugger` A5) اللي مستحيل
// تبان في الداشبورد.
async function handleDiag(request, env) {
  const checks = {};
  const origin = request.headers.get('Origin') || '';

  // 1) المتغيرات والأسرار — الأسماء والأطوال فقط
  const envKeys = Object.keys(env).filter(k => typeof env[k] !== 'object').sort();
  const expected = ['WORKER_SECRET', 'CLIENT_ID', 'CLIENT_SECRET', 'BOSTA_API_KEY', 'SHOP_DOMAIN', 'LOCATION_ID'];
  const missingEnv = expected.filter(k => !(k in env) || String(env[k] ?? '').trim() === '');
  checks.env = {
    ok: missingEnv.length === 0 && !!env.DB,
    missing: missingEnv,
    dbBinding: !!env.DB,
    keys: envKeys.map(k => ({
      name:    JSON.stringify(k),                                      // الـ quotes بتكشف أي مسافة مخفية
      nameLen: k.length,
      valLen:  typeof env[k] === 'string' ? env[k].length : null,      // الطول فقط — أبدًا القيمة
    })),
  };

  // 2) CORS — الـ Origin اللي جاي منه الطلب مسموح ولا لأ
  checks.cors = {
    ok: !origin || ALLOWED_ORIGINS.includes(origin),
    origin: origin || '(بدون Origin — نداء مباشر)',
    allowed: ALLOWED_ORIGINS,
  };

  // 3) D1
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM employees WHERE is_active = 1').first();
    checks.d1 = { ok: true, activeEmployees: row?.n ?? 0 };
  } catch (e) {
    checks.d1 = { ok: false, error: e.message };
  }

  // 4) شوبيفاي: التوكن + المتجر + الصلاحيات + الـ LOCATION_ID
  let token = null;
  try {
    assertEnv(env, 'shopify');
    token = await getAccessToken(env);
    checks.shopifyAuth = { ok: true };
  } catch (e) {
    checks.shopifyAuth = { ok: false, error: e.message };
  }

  // ⚠️ كل فحص في نداء لوحده عن قصد: لو التطبيق ناقصه read_locations مثلاً،
  // فحص الصلاحيات نفسه لازم يفضل شغّال ويقول لنا الناقص — مش يقع معاه.
  if (token) {
    // 4-أ) المتجر + الصلاحيات (مش محتاجة أي scope خاص)
    try {
      const resp = await shopifyGQL(env, token, `
        query DiagScopes {
          shop { name myshopifyDomain }
          currentAppInstallation { id accessScopes { handle } }
        }
      `, {}, 'فحص صلاحيات التطبيق');

      const scopes  = (resp.data?.currentAppInstallation?.accessScopes || []).map(s => s.handle);
      const missing = REQUIRED_SCOPES.filter(s => !scopes.includes(s));

      checks.shop = { ok: true, name: resp.data?.shop?.name, domain: resp.data?.shop?.myshopifyDomain };

      // ⭐ الفحص اللي كان هيكشف عطل 19→23-08 في ٥ ثواني
      checks.scopes = {
        ok: missing.length === 0,
        required: REQUIRED_SCOPES,
        missing,
        granted: scopes,
        hint: missing.includes('write_returns')
          ? 'من غير write_returns الأداة مش هتقدر ترجّع المخزون — Shopify Admin → Settings → Apps and sales channels → Develop apps → التطبيق → Configuration → Admin API scopes → فعّل write_returns ثم Save ثم Install/Update.'
          : null,
      };
    } catch (e) {
      checks.shop   = { ok: false, error: e.message };
      checks.scopes = { ok: false, error: e.message };
    }

    // 4-ب) الـ LOCATION_ID بيتحل لموقع حقيقي؟ (نداء منفصل — محتاج read_locations)
    try {
      const locGid = `gid://shopify/Location/${requireLocationId(env)}`;
      const resp = await shopifyGQL(env, token, `
        query DiagLocation($locId: ID!) { location(id: $locId) { id name isActive } }
      `, { locId: locGid }, 'فحص الـ LOCATION_ID');

      const loc = resp.data?.location;
      checks.location = {
        ok:       !!loc,
        id:       locGid,
        name:     loc?.name || null,
        isActive: loc?.isActive ?? null,
        error:    loc ? null : 'الـ LOCATION_ID مش بيتحل لموقع موجود على المتجر',
      };
    } catch (e) {
      checks.location = { ok: false, error: e.message };
    }
  } else {
    // ⚠️ v3.3.0 — قبل كده المفاتيح دي كانت **بتختفي من الرد خالص** لو OAuth فشل،
    // فالواجهة مابتعرضش أي سطر عنها. "ما اتفحصش" ≠ "تمام" — لازم تبان.
    const notChecked = 'ما اتفحصش — الاتصال بشوبيفاي فشل (شوف فحص OAuth فوق)';
    checks.shop     = { ok: false, error: notChecked };
    checks.scopes   = { ok: false, error: notChecked };
    checks.location = { ok: false, error: notChecked };
  }

  // 5) بوسطة — نداء بحث برقم وهمي: 200 = المفتاح شغال، 401/403 = مفتاح غلط
  try {
    assertEnv(env, 'bosta');
    await searchDeliveries(env, ['0000000000']);
    checks.bosta = { ok: true, detail: 'المفتاح شغّال (بحث تجريبي رجع 200)' };
  } catch (e) {
    checks.bosta = { ok: false, error: e.message };
  }

  const allOk = Object.values(checks).every(c => c.ok !== false);

  return json({
    ok: true,
    allOk,
    version: WORKER_VERSION,
    apiVersion: API_VERSION,
    serverTime: new Date().toISOString(),
    checks,
  }, 200, request);
}

// ─── §LOOKUP::handleLookup ───
// POST body: { trackingNumbers: ["123456", ...] }
// 1) بحث بوسطة (٥٠ في المرة) — v3.2.0 أي فشل في دفعة بيتسجّل ويترجع بدل ما
//    يتبلع ويتحول لـ "غير موجود ببوسطة" مضللة
// 2) جلب S1/S2/returnStatus + الـ orderId الرقمي من شوبيفاي (alias batching)
// 3) التحقق من الانتقال لكل أوردر (validateTransition)
async function handleLookup(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, request); }

  const { trackingNumbers } = body;
  if (!Array.isArray(trackingNumbers) || trackingNumbers.length === 0)
    return json({ error: 'trackingNumbers[] مطلوب' }, 400, request);

  try { assertEnv(env, 'shopify', 'bosta'); }
  catch (e) { return json({ error: e.message }, 500, request); }

  // 1) بحث بوسطة
  const CHUNK = 50;
  const deliveryMap = {};
  const failedTNs   = {};     // trackingNumber → سبب الفشل
  const bostaErrors = [];

  for (let i = 0; i < trackingNumbers.length; i += CHUNK) {
    const chunk = trackingNumbers.slice(i, i + CHUNK);
    try {
      for (const d of await searchDeliveries(env, chunk)) {
        const tn = String(d.trackingNumber || '');
        if (tn) deliveryMap[tn] = d;
      }
    } catch (e) {
      // ⚠️ v3.2.0 — الأرقام دي مش "غير موجودة"، إحنا **ما قدرناش نسأل عنها**
      bostaErrors.push(e.message);
      chunk.forEach(tn => { failedTNs[String(tn)] = e.message; });
    }
  }

  const bostaResults = trackingNumbers.map(tn => {
    const key = String(tn);
    const d   = deliveryMap[key];

    if (!d) {
      const failReason = failedTNs[key] || null;
      return {
        trackingNumber: key, businessRef: null, orderType: null,
        state: null, stateCode: null,
        found: false,
        bostaFailed: !!failReason,
        bostaError:  failReason,
      };
    }

    const orderType = String(d.type?.value || d.type || '');
    return {
      trackingNumber: key,
      businessRef:    String(d.businessReference || ''),
      orderType,
      state:          STATE_MAP[d.state?.code] || d.state?.value || '', // ✅ STATE_MAP[code] — never state.value
      stateCode:      d.state?.code ?? null,                            // معروض كمعلومة بس — لا يؤثر على القرار
      found:          true,
      bostaFailed:    false,
      bostaError:     null,
    };
  });

  // 2) فحص شوبيفاي — للأوردرات اللي بوسطة لاقتها بس
  const foundRefs = [...new Set(bostaResults.filter(r => r.found && r.businessRef).map(r => r.businessRef))];

  let shopifyMap = {};
  let shopifyError = null;
  if (foundRefs.length) {
    try {
      const token = await getAccessToken(env);
      shopifyMap = await fetchShopifyOrdersByNames(env, token, foundRefs);
    } catch (err) {
      shopifyError = err.message;
    }
  }

  // 3) الدمج + التحقق
  const EMPTY = { orderId: null, s1: null, s2: null, returnStatus: null, valid: false, targetField: null, targetValue: null, machine: null };

  const results = bostaResults.map(r => {
    if (!r.found) {
      return {
        ...r, ...EMPTY,
        rejectReason: r.bostaFailed ? `تعذّر الاستعلام من بوسطة: ${r.bostaError}` : null,
      };
    }
    if (shopifyError) {
      return { ...r, ...EMPTY, rejectReason: `تعذر الاتصال بشوبيفاي: ${shopifyError}` };
    }

    // ⚠️ مفتاح الماب منظّف (بدون '#') و businessRef جاي من بوسطة بالـ '#'
    const sOrder = shopifyMap[cleanOrderName(r.businessRef)];
    if (!sOrder) {
      return { ...r, ...EMPTY, rejectReason: 'الأوردر غير موجود على شوبيفاي (أو الاسم الراجع من البحث مش مطابق)' };
    }

    const v = validateTransition(r.orderType, sOrder);
    return {
      ...r,
      orderId:      sOrder.orderId,
      s1:           sOrder.s1,
      s2:           sOrder.s2,
      returnStatus: sOrder.returnStatus,
      valid:        v.valid,
      rejectReason: v.valid ? null : v.reason,
      targetField:  v.valid ? v.targetField  : null,
      targetValue:  v.valid ? v.targetValue  : null,
      machine:      v.valid ? v.machine      : null,
    };
  });

  return json({
    ok: true,
    results,
    bostaErrors,                       // ← الواجهة بتعرضها كبانر أحمر
    shopifyError,
    workerVersion: WORKER_VERSION,
  }, 200, request);
}

// ─── §UPDATE::handleUpdate ───
// POST body: { employee, items: [{ orderName, trackingNumber, orderType }] }
//
// ثلاث مراحل — والتقسيم ده مقصود:
//   (١) تنفيذ: لكل أوردر على حدة — إعادة تحقق من الحالة، ثم
//        S1: orderCancel → metafieldsSet
//        S2: metafieldsSet → disposeReturns → قراءة تحقق
//   (٢) تحقق مجمّع من الإلغاءات (orderCancel = job غير متزامن)
//   (٣) الكتابة في D1 + الرد — **بعد** التحقق، عشان اللي يتسجّل يكون الحقيقة
//       مش النية.
//
// ⚠️ أي أوردر وصل لمرحلة التنفيذ بيتسجّل في D1 دايمًا (نجح أو فشل) — الإلغاء
// لا رجعة فيه، فالفشل الجزئي لازم يبان.
async function handleUpdate(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, request); }

  const { items, employee } = body;
  if (!Array.isArray(items) || items.length === 0)
    return json({ error: 'items[] مطلوب' }, 400, request);

  // ⚠️ التحقق من المتغيرات قبل أي كتابة — LOCATION_ID الناقص كان بيسبب
  // "استرجاع" وهمي في v3.1.0
  let locationId;
  try {
    assertEnv(env, 'shopify', 'stock');
    locationId = requireLocationId(env);
  } catch (e) {
    return json({ error: e.message }, 500, request);
  }

  let token;
  try { token = await getAccessToken(env); }
  catch (err) { return json({ error: err.message }, 500, request); }

  let freshMap;
  try {
    freshMap = await fetchShopifyOrdersByNames(env, token, items.map(it => it.orderName));
  } catch (err) {
    return json({ error: `فشل جلب حالة الأوردرات من شوبيفاي: ${err.message}` }, 500, request);
  }

  const records = [];

  // ⚠️ v3.3.0 — حارس التكرار. `freshMap` بتتقري **مرة واحدة قبل الحلقة**، فلو
  // رقمين تتبع بيرجعوا لنفس الأوردر (وارد فعليًا: شحنة RTO + شحنة مرتجع على
  // نفس الأوردر)، التحقق بيعدّي على نفس اللقطة القديمة مرتين والأوردر بياخد
  // `orderCancel` مرتين + كتابة ميتافيلد مرتين. والإلغاء لا رجعة فيه.
  const seenOrders = new Set();

  // ══ (١) التنفيذ ══════════════════════════════════════════════════════════
  for (const item of items) {
    const cleanName = cleanOrderName(item.orderName);
    const rec = {
      orderName:      cleanName ? `#${cleanName}` : String(item.orderName || ''),
      orderId:        null,
      orderGid:       null,
      trackingNumber: String(item.trackingNumber || ''),
      orderType:      item.orderType || '',
      machine:        null,
      field:          null,
      valueBefore:    null,
      valueAfter:     null,
      actions:        [],
      warnings:       [],
      error:          null,
      restock:        null,
      cancel:         null,
      needsCancelVerify: false,
      startedAt:      new Date().toISOString(),
      executed:       false,      // وصل لمرحلة تنفيذ فعلي على شوبيفاي؟
    };

    if (!cleanName)                 { rec.error = 'اسم الأوردر ناقص'; records.push(rec); continue; }
    if (seenOrders.has(cleanName)) {
      rec.error = 'الأوردر ده اتنفّذ فعلاً في نفس الدفعة (رقم تتبع تاني لنفس الأوردر) — اتخطّيناه عشان مايتلغيش مرتين';
      records.push(rec); continue;
    }
    seenOrders.add(cleanName);

    const sOrder = freshMap[cleanName];
    if (!sOrder)                    { rec.error = 'الأوردر غير موجود على شوبيفاي'; records.push(rec); continue; }

    const v = validateTransition(rec.orderType, sOrder);
    if (!v.valid)                   { rec.error = `الحالة تغيرت قبل التحديث — ${v.reason}`; records.push(rec); continue; }

    rec.orderId     = sOrder.orderId;
    rec.orderGid    = sOrder.orderGid;
    rec.machine     = v.machine;
    rec.field       = v.targetField;
    rec.valueBefore = v.machine === 'S1' ? sOrder.s1 : sOrder.s2;
    rec.valueAfter  = v.targetValue;
    rec.executed    = true;

    const key = v.targetField.split('.')[1];   // 'manual_status' | 'status_2_r_e'

    try {
      // ── مسار RTO (S1): الإلغاء قبل كتابة الميتافيلد — الشحنة عمرها ما وصلت
      // العميل. لو الإلغاء فشل، الميتافيلد ماينكتبش خالص.
      if (v.machine === 'S1') {
        const jobId = await cancelOrder(env, token, sOrder.orderGid);
        rec.actions.push('orderCancel');
        rec.cancel = { jobId, verified: false, restockedUnits: 0 };
        rec.needsCancelVerify = true;
      }

      await writeSingleMetafield(env, token, sOrder.orderGid, key, v.targetValue);
      rec.actions.push(`metafields:${key}`);

      // ── مسار مرتجع بعد التسليم (S2): استرجاع القطع الراجعة فعليًا للمخزون
      if (v.machine === 'S2') {
        const before = await fetchOrderReturns(env, token, sOrder.orderGid);

        if (!before.length) {
          rec.warnings.push('مفيش أي مرتجع مسجَّل على الأوردر — ما اترجعش أي مخزون');
          rec.restock = { requested: 0, confirmed: 0, alreadyDone: 0, skippedNotOpen: 0, verifiedUnits: 0 };
        } else {
          const d = await disposeReturns(env, token, locationId, before);
          rec.restock = { ...d, verifiedUnits: null };

          if (d.confirmed) rec.actions.push(`restock×${d.confirmed}`);

          if (!d.confirmed && d.alreadyDone) {
            rec.warnings.push(`كل القطع (${d.alreadyDone}) كانت مسترجَعة للمخزن قبل كده — ما اتضافش مخزون جديد`);
          } else if (!d.confirmed && !d.alreadyDone) {
            rec.warnings.push(
              'ما اترجعتش أي قطعة — مفيش reverse fulfillment order مفتوح' +
              (d.skippedNotOpen ? ` (اتخطّينا ${d.skippedNotOpen} مقفول/ملغي)` : '')
            );
          }

          // ── قراءة تحقق بعد التنفيذ: الدليل النهائي إن المخزون رجع فعلاً
          try {
            const after = await fetchOrderReturns(env, token, sOrder.orderGid);
            const sum   = summarizeReturns(after, locationId);
            rec.restock.verifiedUnits  = sum.restockedHere;
            rec.restock.remainingAfter = sum.remaining;
            // v3.3.0 — الأرقام دي كانت بتتحسب في summarizeReturns وترمى.
            // بتفرّق وقت التشخيص: RFO مفتوح ومتبقّي صفر ≠ RFO مقفول.
            rec.restock.openRfosAfter  = sum.openRfos;
            rec.restock.otherDisposed  = sum.otherDisposed;
            if (d.confirmed && sum.restockedHere < d.confirmed) {
              rec.warnings.push(`التحقق بعد التنفيذ لقى ${sum.restockedHere} قطعة مسترجَعة بس من ${d.confirmed} — راجع الأوردر يدويًا`);
            }
            if (sum.remaining > 0) {
              rec.warnings.push(`لسه فيه ${sum.remaining} قطعة مش مسترجَعة على الأوردر ده`);
            }
          } catch (e) {
            rec.warnings.push(`ما قدرناش نتأكد من الاسترجاع بعد التنفيذ: ${e.message}`);
          }
        }
      }
    } catch (err) {
      rec.error = err.message;
    }

    records.push(rec);
  }

  // ══ (٢) التحقق المجمّع من الإلغاءات ══════════════════════════════════════
  try {
    await verifyCancels(env, token, records.filter(r => r.executed && !r.error));
  } catch (e) {
    records.filter(r => r.needsCancelVerify).forEach(r => {
      r.warnings.push(`تعذّر التحقق من الإلغاء: ${e.message}`);
    });
  }

  // ══ (٣) الحكم النهائي + السجل + الرد ═════════════════════════════════════
  const results = [];

  for (const rec of records) {
    // تحذيرات ناتجة عن التحقق
    if (rec.needsCancelVerify && !rec.error) {
      if (!rec.cancel?.verified) {
        // انتهاء المهلة من غير تأكيد = warning — مش "تم" ومش "فشل". والأرقام
        // اللي معاها (jobDone/attempts/waitedMs) هي اللي بتخلي الأصفر قابل
        // للتشخيص بدل ما يكون "مش عارفين" مجرّدة.
        const jd = rec.cancel?.jobDone;
        const jobTxt = jd === false ? 'الـ Job لسه شغّال' : (jd === true ? 'الـ Job خلص' : 'حالة الـ Job غير معروفة');
        rec.warnings.push(
          `ما اتأكدناش إن الأوردر اتلغى فعلاً خلال المهلة (${jobTxt} · ` +
          `${rec.cancel?.attempts ?? 0} محاولات · ${rec.cancel?.waitedMs ?? 0}ms)` +
          (rec.cancel?.verifyError ? ` (${rec.cancel.verifyError})` : '') +
          ' — افتح الأوردر على شوبيفاي وتأكد'
        );
      } else if (!rec.cancel.restockedUnits) {
        rec.warnings.push('الأوردر اتلغى لكن مفيش دليل على استرجاع المخزون — راجع المخزون يدويًا');
      } else {
        rec.actions.push(`restock×${rec.cancel.restockedUnits}`);
      }
    }

    const status = rec.error ? 'error' : (rec.warnings.length ? 'warning' : 'success');

    // نص السجل — بيقول اللي حصل بالظبط
    let notes;
    if (rec.error) {
      notes = `فشل: ${rec.error}${rec.actions.length ? ` (تم فعليًا: ${rec.actions.join(', ')})` : ''}`;
    } else {
      const base = `${rec.machine}: ${rec.valueBefore || '—'} → ${rec.valueAfter}`;
      const done = rec.actions.filter(a => a.startsWith('restock×')).join(', ');
      notes = `${base}${done ? ` · ${done}` : ''}${rec.warnings.length ? ` ⚠ ${rec.warnings.join(' | ')}` : ''}`;
    }

    let logged = true, logError = null;
    if (rec.executed || rec.error) {
      try {
        await writeLog(env.DB, {
          tool:        'metafields_change',
          type:        'update',
          employee:    employee || null,
          orderId:     rec.orderId,
          orderName:   rec.orderName,
          valueBefore: rec.valueBefore,
          valueAfter:  status === 'error' ? null : rec.valueAfter,
          notes,
          extra: {
            sourceTool:    SOURCE_TOOL,
            workerVersion: WORKER_VERSION,
            trackingNumber: rec.trackingNumber,
            orderType:      rec.orderType,
            machine:        rec.machine,
            field:          rec.field,
            actions:        rec.actions,
            result:         status,               // success | warning | error
            // تشخيص الانتظار المشروط — البند الكاسر في worker-builder v2.0.0
            // بيطلبها في الرد وفي D1 عشان الحالة الصفرا تبقى قابلة للتشخيص.
            verify: rec.needsCancelVerify ? {
              jobDone:  rec.cancel?.jobDone  ?? null,
              attempts: rec.cancel?.attempts ?? 0,
              waitedMs: rec.cancel?.waitedMs ?? 0,
            } : null,
            error:          rec.error,
            warnings:       rec.warnings,
            restock:        rec.restock,
            cancel:         rec.cancel,
          },
        });
      } catch (e) {
        // ⚠️ v3.2.0 — فشل D1 كان بيتبلع بـ .catch(()=>{}). العملية على شوبيفاي
        // حصلت فعلاً، فمينفعش نرجّع فشل — لكن لازم الموظف يعرف إن مفيش سجل.
        logged   = false;
        logError = e.message;
      }
    }

    results.push({
      orderName:   rec.orderName,
      orderId:     rec.orderId,
      success:     status !== 'error',
      status,                                   // success | warning | error
      machine:     rec.machine,
      field:       rec.field,
      valueBefore: rec.valueBefore,
      valueAfter:  status === 'error' ? null : rec.valueAfter,
      actions:     rec.actions,
      warnings:    rec.warnings,
      error:       rec.error,
      restock:     rec.restock,
      cancel:      rec.cancel ? {
        verified:       rec.cancel.verified,
        restockedUnits: rec.cancel.restockedUnits,
        jobId:          rec.cancel.jobId    ?? null,
        jobDone:        rec.cancel.jobDone  ?? null,
        attempts:       rec.cancel.attempts ?? 0,
        waitedMs:       rec.cancel.waitedMs ?? 0,
      } : null,
      logged,
      logError,
    });
  }

  const succeeded = results.filter(r => r.status === 'success').length;
  const warned    = results.filter(r => r.status === 'warning').length;
  const failed    = results.filter(r => r.status === 'error').length;

  return json({
    ok: true,
    results,
    summary: { total: items.length, succeeded, warned, failed },
    workerVersion: WORKER_VERSION,
  }, 200, request);
}
