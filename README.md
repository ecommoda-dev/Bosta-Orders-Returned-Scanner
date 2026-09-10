<div dir="rtl" style="text-align: right;">

# Bosta Orders Returned Scanner

![version](https://img.shields.io/badge/version-v1.1.0-blue)

أداة داخلية لـ EcomModa — سكانر أوردرات المرتجعات (RTO ومرتجع بعد التسليم).
تفاصيل الاستخدام والقواعد في `CLAUDE.md`.

> 🔴 **الأداة دي بقت كمان صفحة `returned.html` في
> [مركز عمليات المخزن](https://ecommoda-dev.github.io/Warehouse-Operations-Center/)**
> (10-09-2026) — نفس المنطق بالحرف، والفرق إن الموظف بيدخل **مرة واحدة**
> وبيتنقّل بين كل أدوات المخزن من غير ما يدخل تاني.
> **الأداة المستقلة دي لسه شغّالة بقرار** كنقطة رجوع طول التجربة الحيّة.
> ⚠️ الـ Worker **واحد للاتنين** — أي إصلاح في `index.html` هنا لازم يتعمل
> في `returned.html` هناك في نفس التمريرة. التفاصيل في `CLAUDE.md`.

```
الواجهة    : https://ecommoda-dev.github.io/Bosta-Orders-Returned-Scanner/
الـ Worker : https://bosta-orders-returned-scanner.ecommoda-dev.workers.dev
```

## البنية

```
index.js       ← كود الـ Worker (Cloudflare)
wrangler.toml  ← الاسم + bindings + vars
index.html     ← الواجهة (GitHub Pages)
CLAUDE.md      ← قواعد الأداة الكاملة
```

آخر تحديث: 07-09-2026 — 18:30

</div>
