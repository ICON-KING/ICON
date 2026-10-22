# MYTHIC Community

A responsive Korean-language community site using Cloudflare Pages Functions and D1. No account registration is required to post. Board filters share the same data source: 자유게시판, 질문/답변, 모임/모집, 사진.

## Included

- White-and-gold MYTHIC branding; one golden sigil is used for the logo, favicon, and PWA app icon.
- Anonymous posting, comments, search, board/category filtering, pinning and admin deletion.
- Multi-image uploads (up to 8 images) with browser-side WebP compression and thumbnails.
- Recent-post notification panel and optional browser notifications while the site is open.
- Installable PWA shell and basic offline fallback for static UI files.
- Admin dashboard with total unique IPs, daily unique IPs (Asia/Seoul date), post totals, and a 7-day chart.
- Security headers, same-origin checks, parameterized SQL, admin session cookie, and per-IP-hash rate limits.

## Cloudflare bindings / secrets

Bind the D1 database as DB (database name: mythic-community-db).

Set these variables in the Pages project's production and preview environments as secret text:

- ADMIN_PASSWORD — administrator password.
- ADMIN_SESSION_SECRET — long, random session signing key.
- IP_HASH_SALT — independent, long, random salt for one-way IP hashes.

Do not add any of these secrets to Git. The administrator password is stored as a Cloudflare secret, not in the client JavaScript.

## Important deployment behavior

- This project uses serverless Pages Functions and D1; no VM or self-managed server is required. Free-plan allowances and features are controlled by Cloudflare and may change.
- A Pages project must be connected to a Git provider and built/deployed before its pages.dev URL becomes live.
- Browsers must use HTTPS for the PWA install prompt and secure admin cookie.
- IP addresses are used only in-memory to compute a salted HMAC and are never persisted as raw addresses. Lifetime counts are unique IP hashes; daily counts are unique IP hashes per Korea-local date.
- The notification panel shows recent community posts. Browser notifications can appear while this website is open and permission is granted; this is not a background push-notification service.
- Photo data is compressed in the browser and stored in D1. Keep uploads moderate to stay within request and database limits.

## Local schema

schema.sql records the D1 schema. The production D1 database is initialized separately during setup. Do not expose secret values in a client bundle or commit them to Git.