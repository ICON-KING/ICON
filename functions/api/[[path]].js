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

async function createSession(env) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const signature = await hmac("MYTHIC_ADMIN:" + expiry, env.ADMIN_SESSION_SECRET);
  return expiry + "." + signature;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const token = cookieValue(request, SESSION_COOKIE);
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expiry = Number(parts[0]);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac("MYTHIC_ADMIN:" + expiry, env.ADMIN_SESSION_SECRET);
  return equalConstantTime(expected, parts[1]);
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function clientIpHash(request, env) {
  const salt = env.IP_HASH_SALT || env.ADMIN_SESSION_SECRET;
  if (!salt) throw new Error("IP hash secret is not configured");
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

async function handle(request, env) {
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

  if (path.length === 1 && path[0] === "notifications" && method === "GET") {
    const rows = await db.prepare(
      "SELECT id, category, title, author, created_at FROM posts ORDER BY created_at DESC LIMIT 10"
    ).all();
    return json({ notifications: rows.results || [] });
  }

  if (path.length === 1 && path[0] === "visit" && method === "POST") {
    const ipHash = await clientIpHash(request, env);
    const day = koreaDay();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO visitors (ip_hash, first_seen) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(ipHash),
      db.prepare("INSERT OR IGNORE INTO daily_visitors (day, ip_hash, first_seen) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(day, ipHash)
    ]);
    return json({ ok: true });
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
    return json({ ok: true, comment }, 201);
  }

  if (path.length === 2 && path[0] === "admin" && path[1] === "login" && method === "POST") {
    if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
      return json({ error: "관리자 인증 설정이 완료되지 않았습니다." }, 503);
    }
    const ipHash = await clientIpHash(request, env);
    if (!await allowRate(db, ipHash, "admin-login", 6, 300)) {
      return json({ error: "로그인 시도가 많습니다. 5분 후 다시 시도해 주세요." }, 429);
    }
    const parsed = await readJson(request, 20_000);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const password = typeof parsed.body?.password === "string" ? parsed.body.password : "";
    if (password.length > 200 || !equalConstantTime(password, env.ADMIN_PASSWORD)) {
      return json({ error: "비밀번호가 올바르지 않습니다." }, 401);
    }
    const token = await createSession(env);
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(token) });
  }

  if (path.length === 2 && path[0] === "admin" && path[1] === "logout" && method === "POST") {
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
    return await handle(context.request, context.env);
  } catch (error) {
    // Do not log visitor IPs or request bodies.
    console.error("MYTHIC API failure:", error?.message || "unknown");
    return json({ error: "서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 500);
  }
}
