# سكانر أوردرات المرتجعات (`Bosta-Orders-Returned-Scanner`)

**بتعمل إيه:** الموظف بيمسح تراكينج نمبر بوسطة لأوردرات راجعة (RTO أو مرتجع بعد
التسليم)، والأداة بتتحقق من الحالة على شوبيفاي وتحدّث ميتافيلد S1/S2 + تلغي
الأوردر (مسار RTO) أو تسترجع القطع للمخزون (مسار مرتجع بعد التسليم).
**مين بيستخدمها:** مخزن (استلام المرتجعات).
**الإصدار:** Worker `v3.2.0` · الواجهة `v3.2.0`

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Bosta-Orders-Returned-Scanner/
الـ Worker : https://bosta-orders-returned-scanner.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: bosta-orders-returned-scanner   ← لازم يطابق name في wrangler.toml
```

## الـ Endpoints

| `?action=` | بيعمل إيه |
|---|---|
| `check_employee` / `register_pin` / `verify_employee` / `log_logout` / `get_employees` | تسجيل الدخول (D1 Auth القياسي) |
| `get_config` | نسخة الـ Worker + وقت السيرفر — لمطابقة نسخة الواجهة |
| `diag` | فحص ذاتي كامل (env · CORS · D1 · شوبيفاي + الصلاحيات · LOCATION_ID · بوسطة) — صفر كتابة |
| `lookup` | بحث بوسطة بالتراكينج + فحص شوبيفاي (S1/S2/returnStatus) + التحقق من صلاحية الانتقال — بدون كتابة |
| `update` | تنفيذ فعلي: إلغاء الأوردر (RTO) أو استرجاع مخزون (مرتجع بعد التسليم) + تحقق بعد التنفيذ + D1 log |
| `get_logs` / `get_logs_count` / `get_logs_export` | تاب السجل |

## D1

```
tool  : metafields_change   ← تحديثات الحالة الفعلية (extra.sourceTool = "bosta_orders_returned_scanner")
type  : update
tool  : bosta_return        ← login/logout بس (تاريخي: كان فيه type=returned قبل v3.0.0)
type  : login · logout
```

جداول إضافية: لا شيء — `logs` و`employees` القياسيين بس.

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون.

```
Bindings : DB → ecommoda-dev-logs
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET · BOSTA_API_KEY
Vars     : SHOP_DOMAIN · LOCATION_ID   ← من [vars] في wrangler.toml
Build watch paths : * (الافتراضي — لسه ما اتضيّقش)
```

⚠️ **صلاحيات Shopify المطلوبة على التطبيق (WareHouse-App):** `read_orders` ·
`write_orders` · `read_returns` · `write_returns` · `read_inventory` ·
`write_inventory` · `read_locations`. غياب `write_returns` هو السبب اللي أنتج
v3.2.0 (راجع "فخاخ الأداة دي" تحت). شغّل `?action=diag` بعد أي تعديل على
صلاحيات التطبيق للتأكد.

## CORS

`ALLOWED_ORIGINS` صارمة (بدون wildcard) — الأداة دي بتلغي أوردرات وبتحرّك
مخزون، أداة كتابة مش قراءة.

## خط الأساس بعد النقل

> من D1 (الأداة كانت شغّالة من الداشبورد قبل النقل — راجع §0-ب في السكيل):
> **123 صف نجاح** مسجَّل (`tool='metafields_change' AND type='update' AND
> extra LIKE '%"sourceTool":"bosta_orders_returned_scanner"%'`)، آخر واحد
> `2026-08-26T12:51:35.950Z`. بعد النقل قارن بنفس الاستعلام — الرقم لازم
> يكمل يزيد، مش يقف أو يرجع صفر.

## فخاخ الأداة دي

- **`reverseFulfillmentOrderDispose`/`orderCancel` وأخواتهم بيرجّعوا نجاح شكلي
  حتى لو شوبيفاي رفضت العملية فعليًا** (خطأ GraphQL علوي مع `data: null` —
  الـ `userErrors` بترجع `[]` في الحالة دي). ده اللي سبب عطل 19→23-08-2026:
  الأداة سجّلت `reverseDispose` على ٧ أوردرات وكلها كذب لأن التطبيق كان ناقصه
  `write_returns`. `shopifyGQL` (v3.2.0) بتتحقق من HTTP status + GraphQL
  errors علوية قبل ما تعتبر أي رد نجاح — **متلمسش الدالة دي من غير قراءة
  التعليق فوقها كامل**.
- **`orderCancel` بترجّع `job` مش نتيجة نهائية** — الإلغاء بيحصل بعد الرد
  بثانية أو اتنين. التأكيد الحقيقي في `verifyCancels()` بعد الدفعة، مش من رد
  `orderCancel` نفسه.
- **`RETURN_REQUESTED` مش كافي لمسار المرتجع بعد التسليم** (قرار Ahmed
  23-08-2026) — المرتجع لسه محتاج approve من CS الأول، وإلا شوبيفاي لسه ما
  أنشأتش `reverseFulfillmentOrder` والمخزون مش هيرجع حتى لو الميتافيلد اتكتب.
- **`LOCATION_ID` غلط أو ناقص بيتحول لـ GID فاسد** لو ما فيش حراسة —
  `requireLocationId()` بترمي خطأ باسم المتغير صراحة بدل الفشل الصامت.

## استرجاع النسخ القديمة

> ده بديل الـ tags — دفع الـ tags ممنوع من جلسات Claude Code السحابية.

```
النسخ المرقّمة القديمة (2.0.html · 3.0.html · 3.1.1.html · Index.html القديمة)
محفوظة في commit: eed022f1f8bb2a654d8a6b0dd2a9532c7cc27dc0
git show eed022f1f8bb2a654d8a6b0dd2a9532c7cc27dc0:2.0.html
```

## بصمة المهارات

> الصيغة والقواعد والمهارات اللي بتدخل الجدول → `ecommoda-skill-versioning`
> Step 4. مهارة مالهاش رقم إصدار مابتدخلش الجدول.

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v1.0.0 |
| ecommoda-constants | v1.2.0 |
| ecommoda-html-builder | v1.0.0 |

آخر مطابقة: 26-08-2026 · `index.js` v3.2.0 · `index.html` v3.2.0
🔴 معلّقة: — لا شيء

## مسائل مفتوحة

- الأداة اتنقلت من دفعة واحدة (كانت شغّالة من الداشبورد قبل النقل) — الربط في
  Cloudflare (Settings → Build → Connect) والأسرار الأربعة (§Auth) لسه مطلوبين
  من أحمد يدويًا. لحد ما يحصل الربط، الـ Worker المنشور فعليًا مصدره **الرفع
  اليدوي القديم من الداشبورد**، مش الريبو ده.
- Build watch paths لسه على الافتراضي (`*`). ممكن تتضيّق لـ `index.js` +
  `wrangler.toml` بعدين (راجع السكيل §13-ب) — مش عاجل، بس بيقلل ضوضاء الـ
  Version History.
