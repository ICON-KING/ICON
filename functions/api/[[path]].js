const VALID_CATEGORIES = new Set(["자유게시판", "질문/답변", "모임/모집", "사진"]);
const SESSION_COOKIE = "mythic_admin";
const SESSION_SECONDS = 4 * 60 * 60;
const MAX_REQUEST_BYTES = 6_000_000;

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...extraHeaders
  });
  return new Response(JSON.stringify(data), { status, headers });
}

function parsePath(url) {
  return url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

function koreaDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return p.year + "-" + p.month + "-" + p.day;
}

function addDays(day, amount) {
  const base = new Date(day + "T00:00:00+09:00");
  base.setTime(base.getTime() + amount * 24 * 60 * 60 * 1000);
  return koreaDay(base);
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function equalConstantTime(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let mismatch = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i++) {
    mismatch |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return mismatch === 0;
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const part = cookie.split(";").map(value => value.trim()).find(value => value.startsWith(name + "="));
  return part ? part.slice(name.length + 1) : "";
}

function setCookie(token) {
  return SESSION_COOKIE + "=" + token + "; Path=/; Max-Age=" + SESSION_SECONDS + "; HttpOnly; Secure; SameSite=Strict";
}

function clearCookie() {
  return SESSION_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

async function sha256Hex(value) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function getAdminConfig(db) {
  const rows = await db.prepare(
    "SELECT key, value FROM admin_config WHERE key IN ('password_salt','password_hash','ip_hash_salt')"
  ).all();
  return Object.fromEntries((rows.results || []).map(row => [row.key, row.value]));
}

async function verifyAdminPassword(password, salt, expectedHash) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const digest = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: new TextEncoder().encode(salt),
    iterations: 210000
  }, key, 256);
  return equalConstantTime(hex(digest), expectedHash);
}

async function createSession(env) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256Hex(token);
  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)"
  ).bind(tokenHash, expiry).run();
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
    .bind(Math.floor(Date.now() / 1000)).run();
  return token;
}

async function isAdmin(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT expires_at FROM admin_sessions WHERE token_hash = ?"
  ).bind(tokenHash).first();
  return !!row && Number(row.expires_at) > Math.floor(Date.now() / 1000);
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function clientIpHash(request, env) {
  const config = await getAdminConfig(env.DB);
  const salt = config.ip_hash_salt;
  if (!salt) throw new Error("IP hash salt is not configured");
  return hmac("visitor-ip:" + clientIp(request), salt);
}

async function allowRate(db, ipHash, action, maxCount, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    "SELECT window_start, count FROM rate_limits WHERE ip_hash = ? AND action = ?"
  ).bind(ipHash, action).first();
  if (!row || now - Number(row.window_start) >= windowSeconds || now < Number(row.window_start)) {
    await db.prepare(
      "INSERT INTO rate_limits (ip_hash, action, window_start, count) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT(ip_hash, action) DO UPDATE SET window_start=excluded.window_start, count=1"
    ).bind(ipHash, action, now).run();
    return true;
  }
  if (Number(row.count) >= maxCount) return false;
  await db.prepare(
    "UPDATE rate_limits SET count = count + 1 WHERE ip_hash = ? AND action = ?"
  ).bind(ipHash, action).run();
  return true;
}

async function readJson(request, maxBytes = MAX_REQUEST_BYTES) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > maxBytes) return { error: "전송 용량이 너무 큽니다. 사진 수나 크기를 줄여 주세요.", status: 413 };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { error: "전송 용량이 너무 큽니다. 사진 수나 크기를 줄여 주세요.", status: 413 };
  }
  try {
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { error: "요청 형식이 올바르지 않습니다.", status: 400 };
  }
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function requireAdmin(request, env) {
  const ok = await isAdmin(request, env);
  return ok ? null : json({ error: "관리자 인증이 필요합니다. 다시 로그인해 주세요." }, 401);
}
async function getVapidConfig(db) {
  let row = await db.prepare("SELECT value FROM admin_config WHERE key = 'vapid_keys'").first();
  if (row?.value) {
    try { return JSON.parse(row.value); } catch {}
  }
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const publicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const candidate = JSON.stringify({ private_key: privateKey, public_key: publicKey });
  await db.prepare("INSERT OR IGNORE INTO admin_config (key, value) VALUES ('vapid_keys', ?)")
    .bind(candidate).run();
  row = await db.prepare("SELECT value FROM admin_config WHERE key = 'vapid_keys'").first();
  if (!row?.value) throw new Error("Could not initialize VAPID keys");
  return JSON.parse(row.value);
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const normalized = padded + "=".repeat((4 - padded.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).split("=").join("").split("+").join("-").split("/").join("_");
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function hmacRaw(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

async function hkdfExtract(salt, inputKeyMaterial) {
  return hmacRaw(salt, inputKeyMaterial);
}

async function hkdfExpand(pseudorandomKey, info, length) {
  const blocks = [];
  let previous = new Uint8Array(0);
  let outputLength = 0;
  for (let counter = 1; outputLength < length; counter++) {
    previous = await hmacRaw(
      pseudorandomKey,
      concatBytes(previous, info, new Uint8Array([counter]))
    );
    blocks.push(previous);
    outputLength += previous.length;
  }
  return concatBytes(...blocks).slice(0, length);
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

async function createVapidToken(endpoint, vapidConfig) {
  if (!vapidConfig?.private_key || !vapidConfig?.public_key) throw new Error("VAPID keys are not configured");
  const endpointUrl = new URL(endpoint);
  const header = bytesToBase64Url(textBytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = {
    aud: endpointUrl.origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: "https://mythic-community.mythic-hub-2026.workers.dev"
  };
  const payload = bytesToBase64Url(textBytes(JSON.stringify(claims)));
  const signingInput = header + "." + payload;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlToBytes(vapidConfig.private_key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    textBytes(signingInput)
  ));
  return signingInput + "." + bytesToBase64Url(signature);
}

async function encryptWebPush(subscription, payload) {
  const userPublicKey = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth_secret);
  if (userPublicKey.length !== 65 || userPublicKey[0] !== 4 || authSecret.length !== 16) {
    throw new Error("Invalid Web Push subscription keys");
  }
  const userKey = await crypto.subtle.importKey(
    "raw",
    userPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: userKey },
    serverKeyPair.privateKey,
    256
  ));
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeyPair.publicKey));
  const authPrk = await hkdfExtract(authSecret, sharedSecret);
  const keyInfo = concatBytes(textBytes("WebPush: info"), new Uint8Array([0]), userPublicKey, serverPublicKey);
  const inputKeyMaterial = await hkdfExpand(authPrk, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, inputKeyMaterial);
  const contentEncryptionKey = await hkdfExpand(
    prk,
    concatBytes(textBytes("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16
  );
  const nonce = await hkdfExpand(
    prk,
    concatBytes(textBytes("Content-Encoding: nonce"), new Uint8Array([0])),
    12
  );
  const plaintext = concatBytes(textBytes(JSON.stringify(payload)), new Uint8Array([2]));
  if (plaintext.length > 3900) throw new Error("Web Push payload is too large");
  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    aesKey,
    plaintext
  ));
  return concatBytes(
    salt,
    new Uint8Array([0, 0, 16, 0]),
    new Uint8Array([serverPublicKey.length]),
    serverPublicKey,
    ciphertext
  );
}

function isSupportedPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === "fcm.googleapis.com" ||
      host === "updates.push.services.mozilla.com" ||
      host.endsWith(".push.services.mozilla.com") ||
      host === "web.push.apple.com" ||
      host.endsWith(".push.apple.com") ||
      host.endsWith(".notify.windows.com");
  } catch {
    return false;
  }
}

async function sendOnePush(db, subscription, payload, vapidConfig) {
  const token = await createVapidToken(subscription.endpoint, vapidConfig);
  const encryptedBody = await encryptWebPush(subscription, payload);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": "vapid t=" + token + ", k=" + vapidConfig.public_key,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Urgency": "normal"
    },
    body: encryptedBody
  });
  if (response.status === 404 || response.status === 410) {
    await db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?")
      .bind(subscription.endpoint_hash).run();
  }
  return response.ok;
}

async function sendPushNotifications(env, payload) {
  try {
    const vapidConfig = await getVapidConfig(env.DB);
    const rows = await env.DB.prepare(
      "SELECT endpoint_hash, endpoint, p256dh, auth_secret FROM push_subscriptions ORDER BY created_at DESC LIMIT 40"
    ).all();
    await Promise.all((rows.results || []).map(async subscription => {
      try {
        await sendOnePush(env.DB, subscription, payload, vapidConfig);
      } catch (error) {
        console.warn("MYTHIC push delivery failed; endpoint details omitted.");
      }
    }));
  } catch (error) {
    console.warn("MYTHIC push dispatch failed; details omitted.");
  }
}


async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = parsePath(url);
  const db = env.DB;

  if (!db) return json({ error: "데이터베이스 연결이 설정되지 않았습니다." }, 503);

  if (!["GET", "HEAD"].includes(method)) {
    const origin = request.headers.get("Origin");
    if (!origin || origin !== url.origin) {
      return json({ error: "요청 출처를 확인할 수 없습니다." }, 403);
    }
  }

  if (path.length === 1 && path[0] === "posts" && method === "GET") {
    const category = url.searchParams.get("category") || "";
    const q = cleanText(url.searchParams.get("q") || "", 80);
    const sort = url.searchParams.get("sort") || "latest";
    const conditions = [];
    const values = [];
    if (category && VALID_CATEGORIES.has(category)) {
      conditions.push("p.category = ?");
      values.push(category);
    }
    if (q) {
      const escaped = q.replace(/[\\%_]/g, character => "\\" + character);
      conditions.push("(p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\' OR p.author LIKE ? ESCAPE '\\')");
      values.push("%" + escaped + "%", "%" + escaped + "%", "%" + escaped + "%");
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const order = sort === "pinned" ? "p.is_pinned DESC, p.created_at DESC" : "p.created_at DESC";
    const [rows, total] = await Promise.all([
      db.prepare(
        "SELECT p.id, p.category, p.title, p.author, p.content, p.created_at, p.updated_at, p.is_pinned, p.image_count, " +
        "(SELECT pi.thumbnail_url FROM post_images pi WHERE pi.post_id=p.id ORDER BY pi.sort_order LIMIT 1) AS cover, " +
        "(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count " +
        "FROM posts p " + where + " ORDER BY " + order + " LIMIT 60"
      ).bind(...values).all(),
      db.prepare("SELECT COUNT(*) AS count FROM posts").first()
    ]);
    return json({ posts: rows.results || [], total: Number(total?.count || 0) });
  }

  if (path.length === 2 && path[0] === "push" && path[1] === "public-key" && method === "GET") {
    const vapidConfig = await getVapidConfig(db);
    return json({ public_key: vapidConfig.public_key });
  }

  if (path.length === 2 && path[0] === "push" && path[1] === "subscribe" && method === "POST") {
    await getVapidConfig(db);
    const ipHash = await clientIpHash(request, env);
    if (!await allowRate(db, ipHash, "push-subscribe", 12, 3600)) {
      return json({ error: "알림 설정 변경이 너무 잦습니다. 잠시 후 다시 시도해 주세요." }, 429);
    }
    const parsed = await readJson(request, 20_000);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const subscription = parsed.body || {};
    const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint : "";
    const p256dh = typeof subscription.keys?.p256dh === "string" ? subscription.keys.p256dh : "";
    const authSecret = typeof subscription.keys?.auth === "string" ? subscription.keys.auth : "";
    if (!endpoint || endpoint.length > 2048 || !isSupportedPushEndpoint(endpoint)) {
      return json({ error: "지원되는 브라우저 푸시 주소가 아닙니다." }, 400);
    }
    try {
      if (base64UrlToBytes(p256dh).length !== 65 || base64UrlToBytes(authSecret).length !== 16) {
        return json({ error: "브라우저 알림 구독 정보가 올바르지 않습니다." }, 400);
      }
    } catch {
      return json({ error: "브라우저 알림 구독 정보가 올바르지 않습니다." }, 400);
    }
    const endpointHash = await sha256Hex(endpoint);
    await db.prepare(
      "INSERT INTO push_subscriptions (endpoint_hash, endpoint, p256dh, auth_secret, created_at) " +
      "VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
      "ON CONFLICT(endpoint_hash) DO UPDATE SET endpoint=excluded.endpoint, p256dh=excluded.p256dh, " +
      "auth_secret=excluded.auth_secret, created_at=excluded.created_at"
    ).bind(endpointHash, endpoint, p256dh, authSecret).run();
    return json({ ok: true });
  }

  if (path.length === 2 && path[0] === "push" && path[1] === "unsubscribe" && method === "POST") {
    const parsed = await readJson(request, 20_000);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const endpoint = typeof parsed.body?.endpoint === "string" ? parsed.body.endpoint : "";
    const p256dh = typeof parsed.body?.keys?.p256dh === "string" ? parsed.body.keys.p256dh : "";
    if (!endpoint || endpoint.length > 2048 || !isSupportedPushEndpoint(endpoint) || !p256dh) {
      return json({ error: "알림 구독 정보가 올바르지 않습니다." }, 400);
    }
    const endpointHash = await sha256Hex(endpoint);
    await db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND p256dh = ?")
      .bind(endpointHash, p256dh).run();
    return json({ ok: true });
  }

  if (path.length === 1 && path[0] === "notifications" && method === "GET") {
    const rows = await db.prepare(
      "SELECT id, category, title, author, created_at FROM posts ORDER BY created_at DESC LIMIT 10"
    ).all();
    return json({ notifications: rows.results || [] });
  }

  if (path.length === 1 && path[0] === "visit" && method === "POST") {
    const ipHash = await clientIpHash(request, env);
    const day = koreaDay();
    const firstVisit = await db.prepare(
      "INSERT OR IGNORE INTO visitors (ip_hash, first_seen) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    ).bind(ipHash).run();
    if (Number(firstVisit.meta?.changes || 0) > 0) {
      await db.prepare(
        "INSERT OR IGNORE INTO daily_visitors (day, ip_hash, first_seen) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      ).bind(day, ipHash).run();
    }
    return json({ ok: true, new_visitor: Number(firstVisit.meta?.changes || 0) > 0 });
  }

  if (path.length === 1 && path[0] === "posts" && method === "POST") {
    const ipHash = await clientIpHash(request, env);
    if (!await allowRate(db, ipHash, "new-post", 6, 120)) {
      return json({ error: "게시글 등록이 잠시 많습니다. 2분 후 다시 시도해 주세요." }, 429);
    }
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const body = parsed.body || {};
    const category = cleanText(body.category, 20);
    const title = cleanText(body.title, 100);
    const author = cleanText(body.author, 24) || "익명";
    const content = cleanText(body.content, 6000);
    const images = Array.isArray(body.images) ? body.images : [];
    if (!VALID_CATEGORIES.has(category)) return json({ error: "유효한 게시판을 선택해 주세요." }, 400);
    if (!title) return json({ error: "제목을 입력해 주세요." }, 400);
    if (!content && category !== "사진") return json({ error: "내용을 입력해 주세요." }, 400);
    if (category === "사진" && images.length < 1) return json({ error: "사진 게시판에는 사진을 한 장 이상 첨부해 주세요." }, 400);
    if (images.length > 8) return json({ error: "사진은 한 번에 최대 8장까지 등록할 수 있습니다." }, 400);
    if (category !== "사진" && images.length) return json({ error: "사진 첨부는 사진 게시판에서만 사용할 수 있습니다." }, 400);
    let totalImageChars = 0;
    for (const image of images) {
      const dataUrl = typeof image?.data_url === "string" ? image.data_url : "";
      const thumbnailUrl = typeof image?.thumbnail_url === "string" ? image.thumbnail_url : "";
      if (!/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl) || dataUrl.length > 650_000) {
        return json({ error: "압축된 사진 데이터가 올바르지 않습니다. 사진을 다시 선택해 주세요." }, 400);
      }
      if (!/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(thumbnailUrl) || thumbnailUrl.length > 90_000) {
        return json({ error: "사진 미리보기 데이터가 올바르지 않습니다. 다시 선택해 주세요." }, 400);
      }
      totalImageChars += dataUrl.length + thumbnailUrl.length;
    }
    if (totalImageChars > 5_200_000) return json({ error: "사진 전체 용량이 큽니다. 사진 수를 줄이거나 크기를 낮춰 주세요." }, 413);

    const id = crypto.randomUUID();
    const queries = [
      db.prepare(
        "INSERT INTO posts (id, category, title, author, content, created_at, image_count) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)"
      ).bind(id, category, title, author, content, images.length)
    ];
    images.forEach((image, index) => {
      queries.push(db.prepare(
        "INSERT INTO post_images (id, post_id, data_url, thumbnail_url, sort_order) VALUES (?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), id, image.data_url, image.thumbnail_url, index));
    });
    await db.batch(queries);
    const pushPayload = {
      title: "MYTHIC · 새 게시글",
      body: title,
      url: "/?post=" + encodeURIComponent(id),
      tag: "mythic-post-" + id
    };
    const pushTask = sendPushNotifications(env, pushPayload);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(pushTask);
    else await pushTask;
    return json({ ok: true, id }, 201);
  }

  if (path.length === 2 && path[0] === "posts" && method === "GET") {
    const id = path[1];
    const post = await db.prepare(
      "SELECT p.id, p.category, p.title, p.author, p.content, p.created_at, p.updated_at, p.is_pinned, p.image_count, " +
      "(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count " +
      "FROM posts p WHERE p.id = ?"
    ).bind(id).first();
    if (!post) return json({ error: "게시글을 찾을 수 없습니다." }, 404);
    const [images, comments] = await Promise.all([
      db.prepare("SELECT id, data_url, sort_order FROM post_images WHERE post_id = ? ORDER BY sort_order").bind(id).all(),
      db.prepare("SELECT id, author, content, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC LIMIT 200").bind(id).all()
    ]);
    return json({ post, images: images.results || [], comments: comments.results || [] });
  }

  if (path.length === 3 && path[0] === "posts" && path[2] === "comments" && method === "POST") {
    const postId = path[1];
    const exists = await db.prepare("SELECT id FROM posts WHERE id = ?").bind(postId).first();
    if (!exists) return json({ error: "게시글을 찾을 수 없습니다." }, 404);
    const ipHash = await clientIpHash(request, env);
    if (!await allowRate(db, ipHash, "new-comment", 15, 120)) {
      return json({ error: "댓글을 너무 자주 작성했습니다. 잠시 후 다시 시도해 주세요." }, 429);
    }
    const parsed = await readJson(request, 100_000);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const author = cleanText(parsed.body?.author, 24) || "익명";
    const content = cleanText(parsed.body?.content, 1500);
    if (!content) return json({ error: "댓글 내용을 입력해 주세요." }, 400);
    const id = crypto.randomUUID();
    await db.prepare(
      "INSERT INTO comments (id, post_id, author, content, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    ).bind(id, postId, author, content).run();
    const comment = await db.prepare("SELECT id, author, content, created_at FROM comments WHERE id = ?").bind(id).first();
    const pushPayload = {
      title: "MYTHIC · 새 댓글",
      body: author + ": " + content.slice(0, 110),
      url: "/?post=" + encodeURIComponent(postId),
      tag: "mythic-comment-" + id
    };
    const pushTask = sendPushNotifications(env, pushPayload);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(pushTask);
    else await pushTask;
    return json({ ok: true, comment }, 201);
  }

  if (path.length === 2 && path[0] === "admin" && path[1] === "login" && method === "POST") {
    const config = await getAdminConfig(db);
    if (!config.password_salt || !config.password_hash || !config.ip_hash_salt) {
      return json({ error: "관리자 인증 설정이 완료되지 않았습니다." }, 503);
    }
    const ipHash = await clientIpHash(request, env);
    if (!await allowRate(db, ipHash, "admin-login", 6, 300)) {
      return json({ error: "로그인 시도가 많습니다. 5분 후 다시 시도해 주세요." }, 429);
    }
    const parsed = await readJson(request, 20_000);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const password = typeof parsed.body?.password === "string" ? parsed.body.password : "";
    if (password.length > 200 || !await verifyAdminPassword(password, config.password_salt, config.password_hash)) {
      return json({ error: "비밀번호가 올바르지 않습니다." }, 401);
    }
    const token = await createSession(env);
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(token) });
  }

  if (path.length === 2 && path[0] === "admin" && path[1] === "logout" && method === "POST") {
    const token = cookieValue(request, SESSION_COOKIE);
    if (/^[a-f0-9]{64}$/.test(token)) {
      await db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
        .bind(await sha256Hex(token)).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  if (path.length === 2 && path[0] === "admin" && path[1] === "session" && method === "GET") {
    return json({ authenticated: await isAdmin(request, env) });
  }

  if (path.length === 2 && path[0] === "admin" && path[1] === "stats" && method === "GET") {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    const today = koreaDay();
    const weekStart = addDays(today, -6);
    const [totalVisitors, todayVisitors, totalPosts, dailyRows] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM visitors").first(),
      db.prepare("SELECT COUNT(*) AS count FROM daily_visitors WHERE day = ?").bind(today).first(),
      db.prepare("SELECT COUNT(*) AS count FROM posts").first(),
      db.prepare("SELECT day, COUNT(*) AS count FROM daily_visitors WHERE day >= ? AND day <= ? GROUP BY day").bind(weekStart, today).all()
    ]);
    const dailyMap = new Map((dailyRows.results || []).map(row => [row.day, Number(row.count || 0)]));
    const days = [];
    for (let offset = -6; offset <= 0; offset++) {
      const day = addDays(today, offset);
      const parts = day.split("-");
      days.push({ day, label: parts[1] + "/" + parts[2], count: dailyMap.get(day) || 0 });
    }
    return json({
      total_visitors: Number(totalVisitors?.count || 0),
      today_visitors: Number(todayVisitors?.count || 0),
      total_posts: Number(totalPosts?.count || 0),
      days
    });
  }

  if (path.length === 2 && path[0] === "admin" && path[1] === "posts" && method === "GET") {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    const rows = await db.prepare(
      "SELECT id, category, title, author, created_at, is_pinned FROM posts ORDER BY created_at DESC LIMIT 40"
    ).all();
    return json({ posts: rows.results || [] });
  }

  if (path.length === 3 && path[0] === "admin" && path[1] === "posts" && method === "PATCH") {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    const parsed = await readJson(request, 20_000);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    if (typeof parsed.body?.is_pinned !== "boolean") return json({ error: "공지 설정값이 올바르지 않습니다." }, 400);
    const result = await db.prepare(
      "UPDATE posts SET is_pinned = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).bind(parsed.body.is_pinned ? 1 : 0, path[2]).run();
    if (!result.meta?.changes) return json({ error: "게시글을 찾을 수 없습니다." }, 404);
    return json({ ok: true });
  }

  if (path.length === 3 && path[0] === "admin" && path[1] === "posts" && method === "DELETE") {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    const id = path[2];
    await db.batch([
      db.prepare("DELETE FROM post_images WHERE post_id = ?").bind(id),
      db.prepare("DELETE FROM comments WHERE post_id = ?").bind(id),
      db.prepare("DELETE FROM posts WHERE id = ?").bind(id)
    ]);
    return json({ ok: true });
  }

  if (path.length === 3 && path[0] === "admin" && path[1] === "comments" && method === "DELETE") {
    const authError = await requireAdmin(request, env);
    if (authError) return authError;
    await db.prepare("DELETE FROM comments WHERE id = ?").bind(path[2]).run();
    return json({ ok: true });
  }

  return json({ error: "요청한 API 경로가 없습니다." }, 404);
}

export async function onRequest(context) {
  try {
    return await handle(context.request, context.env, context);
  } catch (error) {
    // Do not log visitor IPs or request bodies.
    console.error("MYTHIC API failure:", error?.message || "unknown");
    return json({ error: "서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 500);
  }
}
