# Bosta Orders Returned Scanner

أداة داخلية لـ EcomModa — سكانر أوردرات المرتجعات (RTO ومرتجع بعد التسليم).
تفاصيل الاستخدام والقواعد في `CLAUDE.md`.

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
