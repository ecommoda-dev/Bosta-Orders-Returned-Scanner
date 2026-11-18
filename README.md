<div dir="rtl" style="text-align: right;">

# Bosta Orders Returned Scanner

> 🗑️ **18-11-2026 — الواجهة المستقلة (`index.html`) اتحذفت** (قرار أحمد). الريبو بقى **Worker فقط**، والواجهة الوحيدة `Bosta-Orders-Returned-Scanner.html` في `Warehouse-Operations-Center`. رابط GitHub Pages القديم بيدّي `404` **بلا إعادة توجيه**، ومفيش نقطة رجوع مستقلة. ⚠️ أي ذكر تحت لـ«الواجهة المستقلة» / `index.html` / «نقطة رجوع» بيوصف الوضع **قبل الحذف** (تاريخي) — وأي تعديل واجهة بيتعمل في الهب بس.

![version](https://img.shields.io/badge/version-v1.1.0-blue)

أداة داخلية لـ EcomModa — سكانر أوردرات المرتجعات (RTO ومرتجع بعد التسليم).
تفاصيل الاستخدام والقواعد في `CLAUDE.md`.

> 🔴 **الأداة دي بقت كمان صفحة `returned.html` في
> [مركز عمليات المخزن](https://ecommoda-dev.github.io/Warehouse-Operations-Center/)**
> (10-09-2026) — نفس المنطق بالحرف، والفرق إن الموظف بيدخل **مرة واحدة**
> وبيتنقّل بين كل أدوات المخزن من غير ما يدخل تاني.

```
الـ Worker : https://bosta-orders-returned-scanner.ecommoda-dev.workers.dev
```

## البنية

```
index.js       ← كود الـ Worker (Cloudflare)
wrangler.toml  ← الاسم + bindings + vars
(index.html اتشالت 18-11-2026 — الواجهة في الهب)
CLAUDE.md      ← قواعد الأداة الكاملة
```

آخر تحديث: 07-09-2026 — 18:30

</div>
