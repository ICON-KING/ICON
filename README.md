# MYTHIC Community

A responsive Korean-language community site deployed as a Cloudflare Worker with D1. No account registration is required to post. Board filters share the same data source: 자유게시판, 질문/답변, 모임/모집, 사진.

## Included

- White-and-gold MYTHIC branding; one golden sigil is used for the logo, favicon, and PWA app icon.
- Anonymous posting, comments, search, board/category filtering, pinning and admin deletion.
- Multi-image uploads (up to 8 images) with browser-side WebP compression and thumbnails.
- Recent-post notification panel and optional browser notifications while the site is open.
- Installable PWA shell and basic offline fallback for static UI files.
- Admin dashboard with total unique IPs, daily unique IPs (Asia/Seoul date), post totals, and a 7-day chart.
- Security headers, same-origin checks, parameterized SQL, admin session cookie, and per-IP-hash rate limits.

## Deployment

The live Worker is named `mythic-community` and uses the D1 binding `DB` (`mythic-community-db`). The Worker entrypoint `worker.js` bundles the frontend assets and API and is deployed directly to Cloudflare Workers. The admin password is checked server-side using a PBKDF2 hash and salt stored in the private D1 `admin_config` table; the plain password is not present in the browser code or public repository. Session tokens are random, stored hashed in D1, and sent only in Secure, HttpOnly, SameSite cookies. The IP hash salt is stored server-side in D1 and no raw visitor IP is persisted.

## Important deployment behavior

- This project uses serverless Pages Functions and D1; no VM or self-managed server is required. Free-plan allowances and features are controlled by Cloudflare and may change.
- The Cloudflare Pages project is not the live target; direct Worker deployment avoids the unavailable Git integration.
- Browsers must use HTTPS for the PWA install prompt and secure admin cookie.
- IP addresses are used only in-memory to compute a salted HMAC and are never persisted as raw addresses. Lifetime counts are unique IP hashes; daily counts are unique IP hashes per Korea-local date.
- The notification panel shows recent community posts. Browser notifications can appear while this website is open and permission is granted; this is not a background push-notification service.
- Photo data is compressed in the browser and stored in D1. Keep uploads moderate to stay within request and database limits.

## Local schema

schema.sql records the D1 schema. The production D1 database is initialized separately during setup. Do not expose secret values in a client bundle or commit them to Git.