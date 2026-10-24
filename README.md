# MYTHIC Community

A responsive Korean-language community site deployed as a Cloudflare Worker with D1. No account registration is required to post. Board filters share the same data source: 자유게시판, 질문/답변, 모임/모집, 사진.

## Included

- Unified MYTHIC identity: one bold geometric M monogram for the SVG logo, ICO/PNG favicons, Apple touch icon, Safari pinned-tab icon, social preview, and PWA icons. Deep navy and ivory create high contrast at small sizes; no orbit rings or fine details.
- Anonymous posting, comments, search, board/category filtering, pinning and admin deletion.
- Multi-image uploads (up to 8 images) with browser-side WebP compression and thumbnails.
- In-site notification panel plus standards-based background Web Push for new posts and comments after users explicitly opt in, including notification click-through to the related post.
- Installable PWA shell and basic offline fallback for static UI files.
- Admin dashboard with total unique IPs, daily unique IPs (Asia/Seoul date), post totals, and a 7-day chart.
- Security headers, same-origin checks, parameterized SQL, admin session cookie, and per-IP-hash rate limits.

## Deployment

The live Worker is named `mythic-community` and uses the D1 binding `DB` (`mythic-community-db`). The Worker entrypoint `worker.js` bundles the frontend assets and API and is deployed directly to Cloudflare Workers. The admin password is checked server-side using a PBKDF2 hash and salt stored in the private D1 `admin_config` table; the plain password is not present in the browser code or public repository. Session tokens are random, stored hashed in D1, and sent only in Secure, HttpOnly, SameSite cookies. The IP hash salt is stored server-side in D1 and no raw visitor IP is persisted.

## Important deployment behavior

- This project uses serverless Pages Functions and D1; no VM or self-managed server is required. Free-plan allowances and features are controlled by Cloudflare and may change.
- The Cloudflare Pages project is not the live target; direct Worker deployment avoids the unavailable Git integration.
- Browsers must use HTTPS for the PWA install prompt and secure admin cookie.
- IP addresses are used only in-memory to compute a salted HMAC and are never persisted as raw addresses. Lifetime counts store each IP hash once. The daily counter includes only IP hashes first seen by the site on that Korea-local date; a returning IP from any earlier date is not counted again.
- Background Web Push uses VAPID, P-256 ECDH, HKDF-SHA-256 and AES-128-GCM. The VAPID key pair is generated on the server on first opt-in and stored in the private D1 admin_config table; the private key is never included in frontend assets or committed to Git. Users must opt in in each browser/device. Actual delivery timing depends on the browser push service and device network state.
- Photo data is compressed in the browser and stored in D1. Keep uploads moderate to stay within request and database limits.

## Local schema

schema.sql records the D1 schema. The production D1 database is initialized separately during setup. Do not expose secret values in a client bundle or commit them to Git.