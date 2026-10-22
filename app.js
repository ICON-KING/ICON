(() => {
  "use strict";

  const CATEGORIES = ["자유게시판", "질문/답변", "모임/모집", "사진"];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const state = {
    category: "전체",
    posts: [],
    notifications: [],
    selectedFiles: [],
    currentPostId: null,
    installPrompt: null,
    notificationInitialized: false,
    lastNotificationIds: new Set(),
    notificationSeen: new Set(),
    adminAuthed: false,
    isLoading: false
  };

  const els = {
    postGrid: $("#postGrid"),
    feedLabel: $("#feedLabel"),
    feedCount: $("#feedCount"),
    allCount: $("#allCount"),
    searchInput: $("#searchInput"),
    sortSelect: $("#sortSelect"),
    composeDialog: $("#composeDialog"),
    composeForm: $("#composeForm"),
    composeCategory: $("#composeCategory"),
    photoInput: $("#photoInput"),
    photoUploadZone: $("#photoUploadZone"),
    imagePreviewList: $("#imagePreviewList"),
    composeError: $("#composeError"),
    submitPostBtn: $("#submitPostBtn"),
    detailDialog: $("#detailDialog"),
    detailTitle: $("#detailTitle"),
    detailContent: $("#detailContent"),
    commentsList: $("#commentsList"),
    commentCount: $("#commentCount"),
    commentForm: $("#commentForm"),
    commentAuthor: $("#commentAuthor"),
    commentText: $("#commentText"),
    commentError: $("#commentError"),
    adminDialog: $("#adminDialog"),
    adminLoginForm: $("#adminLoginForm"),
    adminPasswordInput: $("#adminPasswordInput"),
    adminLoginError: $("#adminLoginError"),
    adminLoginBtn: $("#adminLoginBtn"),
    adminDashboard: $("#adminDashboard"),
    adminLogoutBtn: $("#adminLogoutBtn"),
    adminPostList: $("#adminPostList"),
    adminPostCount: $("#adminPostCount"),
    totalVisitors: $("#totalVisitors"),
    todayVisitors: $("#todayVisitors"),
    totalPosts: $("#totalPosts"),
    visitorChart: $("#visitorChart"),
    notificationBtn: $("#notificationBtn"),
    notificationBadge: $("#notificationBadge"),
    notificationPanel: $("#notificationPanel"),
    notificationList: $("#notificationList"),
    enableBrowserNotifications: $("#enableBrowserNotifications"),
    installBtn: $("#installBtn"),
    toastRegion: $("#toastRegion"),
    mainNav: $("#mainNav"),
    mobileMenuBtn: $("#mobileMenuBtn")
  };

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }

  function setText(target, value) {
    target.textContent = value == null ? "" : String(value);
  }

  function toast(message, type = "success") {
    const item = node("div", type === "error" ? "toast error" : "toast", message);
    els.toastRegion.append(item);
    window.setTimeout(() => item.remove(), 3800);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data && data.error ? data.error : "요청을 처리하지 못했습니다.";
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function formatDate(value, short = false) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const options = short
      ? { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" }
      : { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" };
    return new Intl.DateTimeFormat("ko-KR", options).format(date);
  }

  function categoryChip(category) {
    return node("span", "category-chip", category || "자유게시판");
  }

  function iconComment() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 5.5h16v11H9l-5 3v-14Z");
    svg.append(path);
    return svg;
  }

  function setActiveCategory(category) {
    state.category = category;
    $$(".nav-item").forEach(button => {
      const active = button.dataset.category === category;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $$(".board-tab").forEach(button => button.classList.toggle("selected", button.dataset.category === category));
    setText(els.feedLabel, category === "전체" ? "전체 게시글" : category);
    loadPosts();
  }

  async function loadPosts() {
    if (state.isLoading) return;
    state.isLoading = true;
    els.postGrid.setAttribute("aria-busy", "true");
    const params = new URLSearchParams();
    if (state.category !== "전체") params.set("category", state.category);
    const query = els.searchInput.value.trim();
    if (query) params.set("q", query);
    if (els.sortSelect.value === "pinned") params.set("sort", "pinned");
    try {
      const data = await api("/api/posts" + (params.toString() ? "?" + params.toString() : ""));
      state.posts = Array.isArray(data.posts) ? data.posts : [];
      renderPosts(state.posts);
      setText(els.feedCount, "게시글 " + state.posts.length + "개");
      const allCount = typeof data.total === "number" ? data.total : state.posts.length;
      setText(els.allCount, allCount);
    } catch (error) {
      renderFeedError(error.message);
      setText(els.feedCount, "불러오기 실패");
    } finally {
      state.isLoading = false;
      els.postGrid.removeAttribute("aria-busy");
    }
  }

  function renderFeedError(message) {
    els.postGrid.replaceChildren();
    const empty = node("div", "empty-state");
    empty.append(node("div", "empty-state-symbol", "!"));
    empty.append(node("h3", "", "게시글을 불러오지 못했어요"));
    empty.append(node("p", "", message || "네트워크 상태를 확인하고 다시 시도해 주세요."));
    const retry = node("button", "button button-outline", "다시 불러오기");
    retry.type = "button";
    retry.addEventListener("click", loadPosts);
    empty.append(retry);
    els.postGrid.append(empty);
  }

  function renderPosts(posts) {
    els.postGrid.replaceChildren();
    if (!posts.length) {
      const empty = node("div", "empty-state");
      empty.append(node("div", "empty-state-symbol", "✦"));
      empty.append(node("h3", "", "아직 이야기가 없어요"));
      empty.append(node("p", "", "첫 번째 글을 남겨 MYTHIC의 이야기를 시작해 보세요."));
      const write = node("button", "button button-gold", "첫 글 작성하기 ↗");
      write.type = "button";
      write.addEventListener("click", () => openCompose());
      empty.append(write);
      els.postGrid.append(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    posts.forEach(post => {
      const card = node("button", "post-card" + (post.is_pinned ? " pinned" : ""));
      card.type = "button";
      card.setAttribute("aria-label", "게시글 열기: " + post.title);
      if (post.cover && post.category === "사진") {
        const cover = node("img", "post-cover");
        cover.src = post.cover;
        cover.alt = post.title + " 사진 미리보기";
        cover.loading = "lazy";
        card.append(cover);
      }
      const head = node("div", "post-card-head");
      head.append(categoryChip(post.category));
      if (post.is_pinned) head.append(node("span", "pinned-label", "✦ 공지"));
      else if (post.category === "사진" && post.image_count) head.append(node("span", "pinned-label", "사진 " + post.image_count + "장"));
      card.append(head);
      card.append(node("h3", "post-title", post.title));
      const excerptText = (post.content || (post.category === "사진" ? "사진으로 오늘의 순간을 기록해 보세요." : "")).trim();
      card.append(node("p", "post-excerpt", excerptText || "내용을 확인해 보세요."));
      const foot = node("div", "post-card-foot");
      const left = node("div", "post-foot-left");
      left.append(node("span", "post-author", post.author || "익명"));
      left.append(node("span", "foot-dot"));
      left.append(node("span", "", formatDate(post.created_at, true)));
      foot.append(left);
      const comments = node("span", "post-comment-count");
      comments.append(iconComment());
      comments.append(document.createTextNode(String(post.comment_count || 0)));
      foot.append(comments);
      card.append(foot);
      card.addEventListener("click", () => openPost(post.id));
      frag.append(card);
    });
    els.postGrid.append(frag);
  }

  function openCompose(category = state.category) {
    els.composeForm.reset();
    els.composeError.textContent = "";
    state.selectedFiles = [];
    els.imagePreviewList.replaceChildren();
    const targetCategory = CATEGORIES.includes(category) ? category : (CATEGORIES.includes(state.category) ? state.category : "자유게시판");
    els.composeCategory.value = targetCategory;
    updatePhotoMode();
    els.composeDialog.showModal();
    window.setTimeout(() => $('input[name="title"]', els.composeForm).focus(), 50);
  }

  function updatePhotoMode() {
    const active = els.composeCategory.value === "사진";
    els.photoUploadZone.hidden = !active;
    els.photoInput.required = active;
    if (!active) {
      state.selectedFiles = [];
      els.photoInput.value = "";
      els.imagePreviewList.replaceChildren();
    }
  }

  function renderImagePreviews() {
    els.imagePreviewList.replaceChildren();
    state.selectedFiles.forEach(file => {
      const wrap = node("div", "image-preview");
      const image = node("img");
      image.alt = file.name;
      image.src = URL.createObjectURL(file);
      image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
      wrap.append(image);
      wrap.append(node("span", "", file.name));
      els.imagePreviewList.append(wrap);
    });
    if (state.selectedFiles.length) {
      const hint = node("p", "upload-hint", state.selectedFiles.length + "장 선택됨 · 등록 시 자동 압축");
      els.imagePreviewList.append(hint);
    }
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("이미지를 압축하지 못했습니다.")), type, quality);
    });
  }

  async function compressImage(file) {
    if (!file.type.startsWith("image/")) throw new Error("이미지 파일만 첨부할 수 있습니다.");
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("이미지를 읽을 수 없습니다. 다른 이미지 파일을 선택해 주세요.");
    }
    try {
      let scale = Math.min(1, 1440 / bitmap.width, 1440 / bitmap.height);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("브라우저에서 이미지 압축 기능을 사용할 수 없습니다.");
      let blob = null;
      for (let resizeAttempt = 0; resizeAttempt < 4; resizeAttempt++) {
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        let quality = 0.82;
        do {
          blob = await canvasBlob(canvas, "image/webp", quality);
          quality -= 0.08;
        } while (blob.size > 430 * 1024 && quality >= 0.5);
        if (blob.size <= 430 * 1024) break;
        scale *= 0.78;
      }
      if (!blob || blob.size > 650 * 1024) throw new Error("사진 용량이 너무 큽니다. 더 작은 이미지를 선택해 주세요.");
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("압축한 사진을 읽을 수 없습니다."));
        reader.readAsDataURL(blob);
      });
      return {
        data_url: dataUrl,
        thumbnail_url: await makeThumbnail(bitmap),
        name: file.name,
        bytes: blob.size
      };
    } finally {
      bitmap.close();
    }
  }

  async function makeThumbnail(bitmap) {
    const scale = Math.min(1, 480 / bitmap.width, 360 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, "image/webp", 0.65);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("사진 미리보기를 만들지 못했습니다."));
      reader.readAsDataURL(blob);
    });
  }

  async function submitPost(event) {
    event.preventDefault();
    els.composeError.textContent = "";
    const formData = new FormData(els.composeForm);
    const category = String(formData.get("category") || "");
    const title = String(formData.get("title") || "").trim();
    const author = String(formData.get("author") || "").trim() || "익명";
    const content = String(formData.get("content") || "").trim();
    if (!CATEGORIES.includes(category)) {
      els.composeError.textContent = "게시판을 선택해 주세요.";
      return;
    }
    if (!title) {
      els.composeError.textContent = "제목을 입력해 주세요.";
      return;
    }
    if (category === "사진" && !state.selectedFiles.length) {
      els.composeError.textContent = "사진 게시판에는 사진을 한 장 이상 첨부해 주세요.";
      return;
    }
    if (!content && category !== "사진") {
      els.composeError.textContent = "내용을 입력해 주세요.";
      return;
    }
    if (state.selectedFiles.length > 8) {
      els.composeError.textContent = "사진은 한 번에 최대 8장까지 등록할 수 있습니다.";
      return;
    }

    els.submitPostBtn.disabled = true;
    setText(els.submitPostBtn, "사진 압축 및 등록 중…");
    try {
      const images = [];
      for (const file of state.selectedFiles) images.push(await compressImage(file));
      await api("/api/posts", {
        method: "POST",
        body: JSON.stringify({ category, title, author, content, images })
      });
      els.composeDialog.close();
      toast("게시글이 등록되었습니다.");
      if (state.category !== category) setActiveCategory(category);
      else await loadPosts();
      await loadNotifications(true);
    } catch (error) {
      els.composeError.textContent = error.message || "게시글을 등록하지 못했습니다.";
    } finally {
      els.submitPostBtn.disabled = false;
      setText(els.submitPostBtn, "게시글 등록 ↗");
    }
  }

  async function openPost(id) {
    state.currentPostId = id;
    els.detailTitle.textContent = "게시글";
    els.detailContent.replaceChildren(node("div", "loading-card", "게시글을 불러오는 중…"));
    els.commentsList.replaceChildren();
    els.commentCount.textContent = "0";
    els.commentError.textContent = "";
    els.commentText.value = "";
    els.detailDialog.showModal();
    try {
      const data = await api("/api/posts/" + encodeURIComponent(id));
      if (!data.post) throw new Error("게시글을 찾을 수 없습니다.");
      renderPostDetail(data.post, data.images || []);
      renderComments(data.comments || []);
    } catch (error) {
      els.detailContent.replaceChildren(node("p", "form-error", error.message));
    }
  }

  function renderPostDetail(post, images) {
    els.detailContent.replaceChildren();
    setText(els.detailTitle, post.title);
    const head = node("div", "detail-post-head");
    head.append(categoryChip(post.category));
    if (post.is_pinned) head.append(node("span", "pinned-label", "✦ 공지"));
    els.detailContent.append(head);
    els.detailContent.append(node("h2", "detail-post-title", post.title));
    const meta = node("div", "detail-post-meta");
    meta.append(node("span", "", post.author || "익명"));
    meta.append(node("span", "", "·"));
    meta.append(node("span", "", formatDate(post.created_at)));
    if (post.updated_at) meta.append(node("span", "", "수정됨"));
    els.detailContent.append(meta);
    if (post.content) els.detailContent.append(node("div", "detail-post-body", post.content));
    if (images.length) {
      const grid = node("div", "detail-image-grid");
      images.forEach((image, index) => {
        const img = node("img");
        img.src = image.data_url;
        img.alt = post.title + " 사진 " + (index + 1);
        img.loading = "lazy";
        img.setAttribute("role", "button");
        img.setAttribute("tabindex", "0");
        img.setAttribute("aria-label", "사진 확대/축소");
        const toggleImageZoom = () => img.classList.toggle("expanded");
        img.addEventListener("click", toggleImageZoom);
        img.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleImageZoom();
          }
        });
        grid.append(img);
      });
      els.detailContent.append(grid);
    }
  }

  function renderComments(comments) {
    els.commentsList.replaceChildren();
    els.commentCount.textContent = String(comments.length);
    if (!comments.length) {
      els.commentsList.append(node("div", "no-comments", "아직 댓글이 없습니다. 첫 댓글을 남겨 보세요."));
      return;
    }
    const frag = document.createDocumentFragment();
    comments.forEach(comment => {
      const item = node("article", "comment-item");
      const top = node("div", "comment-top");
      top.append(node("strong", "", comment.author || "익명"));
      top.append(node("span", "", formatDate(comment.created_at)));
      item.append(top);
      item.append(node("p", "comment-body", comment.content));
      frag.append(item);
    });
    els.commentsList.append(frag);
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!state.currentPostId) return;
    const content = els.commentText.value.trim();
    if (!content) {
      els.commentError.textContent = "댓글 내용을 입력해 주세요.";
      return;
    }
    const button = $("button[type=submit]", els.commentForm);
    button.disabled = true;
    els.commentError.textContent = "";
    try {
      await api("/api/posts/" + encodeURIComponent(state.currentPostId) + "/comments", {
        method: "POST",
        body: JSON.stringify({
          author: els.commentAuthor.value.trim() || "익명",
          content
        })
      });
      els.commentText.value = "";
      toast("댓글이 등록되었습니다.");
      await openPost(state.currentPostId);
      await loadPosts();
    } catch (error) {
      els.commentError.textContent = error.message || "댓글을 등록하지 못했습니다.";
    } finally {
      button.disabled = false;
    }
  }

  function readSeenNotifications() {
    try {
      const stored = JSON.parse(localStorage.getItem("mythic_seen_notifications") || "[]");
      state.notificationSeen = new Set(Array.isArray(stored) ? stored.slice(0, 150) : []);
    } catch {
      state.notificationSeen = new Set();
    }
  }

  function saveSeenNotifications() {
    try {
      localStorage.setItem("mythic_seen_notifications", JSON.stringify(Array.from(state.notificationSeen).slice(-150)));
    } catch {}
  }

  async function loadNotifications(markSeen = false) {
    try {
      const data = await api("/api/notifications");
      const incoming = Array.isArray(data.notifications) ? data.notifications : [];
      const incomingIds = new Set(incoming.map(item => item.id));
      const firstRun = !state.notificationInitialized;
      if (!firstRun) {
        incoming.forEach(item => {
          if (!state.lastNotificationIds.has(item.id) && NotificationPermissionGranted() && document.visibilityState !== "visible") {
            try {
              new Notification("MYTHIC · 새 게시글", {
                body: item.title,
                icon: "/icon.svg",
                tag: "mythic-post-" + item.id
              });
            } catch {}
          }
        });
      } else {
        incoming.forEach(item => state.notificationSeen.add(item.id));
      }
      state.notifications = incoming;
      state.lastNotificationIds = incomingIds;
      state.notificationInitialized = true;
      renderNotifications();
      if (markSeen || !localStorage.getItem("mythic_notif_initialized")) {
        incoming.forEach(item => state.notificationSeen.add(item.id));
        saveSeenNotifications();
        try { localStorage.setItem("mythic_notif_initialized", "1"); } catch {}
        updateNotificationBadge();
      }
    } catch {
      if (!state.notifications.length) {
        els.notificationList.replaceChildren(node("p", "muted-empty", "알림을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."));
      }
    }
  }

  function NotificationPermissionGranted() {
    return "Notification" in window && Notification.permission === "granted";
  }

  function renderNotifications() {
    els.notificationList.replaceChildren();
    if (!state.notifications.length) {
      els.notificationList.append(node("p", "muted-empty", "아직 올라온 게시글이 없습니다."));
      updateNotificationBadge();
      return;
    }
    state.notifications.slice(0, 10).forEach(item => {
      const button = node("button", "notification-item");
      button.type = "button";
      button.append(categoryChip(item.category));
      button.append(node("span", "notification-title", item.title));
      button.append(node("span", "notification-meta", (item.author || "익명") + " · " + formatDate(item.created_at)));
      button.addEventListener("click", () => {
        state.notificationSeen.add(item.id);
        saveSeenNotifications();
        updateNotificationBadge();
        els.notificationPanel.hidden = true;
        openPost(item.id);
      });
      els.notificationList.append(button);
    });
    updateNotificationBadge();
  }

  function updateNotificationBadge() {
    const unread = state.notifications.filter(item => !state.notificationSeen.has(item.id)).length;
    els.notificationBadge.hidden = unread <= 0;
    setText(els.notificationBadge, unread > 9 ? "9+" : unread);
  }

  async function recordVisit() {
    try { await api("/api/visit", { method: "POST", body: "{}" }); } catch {}
  }

  function openNotifications() {
    els.notificationPanel.hidden = !els.notificationPanel.hidden;
    if (!els.notificationPanel.hidden) loadNotifications(true);
  }

  async function enableBrowserNotifications() {
    if (!("Notification" in window)) {
      toast("이 브라우저는 시스템 알림을 지원하지 않습니다.", "error");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        toast("브라우저 알림을 켰습니다. 사이트가 열려 있을 때 새 글 알림을 받을 수 있어요.");
        els.enableBrowserNotifications.textContent = "브라우저 알림 사용 중";
        els.enableBrowserNotifications.disabled = true;
      } else {
        toast("브라우저 설정에서 알림 권한을 허용해 주세요.", "error");
      }
    } catch {
      toast("알림 권한을 요청하지 못했습니다.", "error");
    }
  }

  function openAdmin() {
    els.adminLoginError.textContent = "";
    els.adminDialog.showModal();
    checkAdminSession();
  }

  function showAdminLoggedOut() {
    state.adminAuthed = false;
    els.adminLoginForm.hidden = false;
    els.adminDashboard.hidden = true;
    els.adminPasswordInput.value = "";
  }

  function showAdminLoggedIn() {
    state.adminAuthed = true;
    els.adminLoginForm.hidden = true;
    els.adminDashboard.hidden = false;
    loadAdminData();
  }

  async function checkAdminSession() {
    try {
      const result = await api("/api/admin/session");
      if (result.authenticated) showAdminLoggedIn();
      else showAdminLoggedOut();
    } catch {
      showAdminLoggedOut();
    }
  }

  async function submitAdminLogin(event) {
    event.preventDefault();
    els.adminLoginError.textContent = "";
    els.adminLoginBtn.disabled = true;
    setText(els.adminLoginBtn, "인증 확인 중…");
    try {
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: els.adminPasswordInput.value })
      });
      els.adminPasswordInput.value = "";
      showAdminLoggedIn();
      toast("관리자 모드에 접속했습니다.");
    } catch (error) {
      els.adminLoginError.textContent = error.message || "로그인에 실패했습니다.";
    } finally {
      els.adminLoginBtn.disabled = false;
      setText(els.adminLoginBtn, "안전하게 로그인 ↗");
    }
  }

  async function logoutAdmin() {
    try { await api("/api/admin/logout", { method: "POST", body: "{}" }); } catch {}
    showAdminLoggedOut();
    toast("관리자 모드에서 로그아웃했습니다.");
  }

  async function loadAdminData() {
    if (!state.adminAuthed) return;
    try {
      const [stats, postsData] = await Promise.all([
        api("/api/admin/stats"),
        api("/api/admin/posts")
      ]);
      setText(els.totalVisitors, Number(stats.total_visitors || 0).toLocaleString("ko-KR"));
      setText(els.todayVisitors, Number(stats.today_visitors || 0).toLocaleString("ko-KR"));
      setText(els.totalPosts, Number(stats.total_posts || 0).toLocaleString("ko-KR"));
      renderVisitorChart(stats.days || []);
      renderAdminPosts(postsData.posts || []);
    } catch (error) {
      if (error.status === 401) {
        showAdminLoggedOut();
        els.adminLoginError.textContent = "세션이 만료되었습니다. 다시 로그인해 주세요.";
      } else toast(error.message || "관리자 데이터를 불러오지 못했습니다.", "error");
    }
  }

  function renderVisitorChart(days) {
    els.visitorChart.replaceChildren();
    const max = Math.max(1, ...days.map(day => Number(day.count || 0)));
    days.forEach(day => {
      const barDay = node("div", "chart-day");
      const wrap = node("div", "chart-bar-wrap");
      const bar = node("div", "chart-bar");
      const value = Number(day.count || 0);
      const percentage = Math.min(100, Math.max(4, Math.round(value / max * 100)));
      bar.className = "chart-bar h-" + percentage;
      bar.title = value + "명";
      wrap.append(bar);
      barDay.append(wrap);
      barDay.append(node("strong", "", value.toLocaleString("ko-KR")));
      barDay.append(node("span", "", String(day.label || "").slice(0, 5)));
      els.visitorChart.append(barDay);
    });
  }

  function renderAdminPosts(posts) {
    els.adminPostList.replaceChildren();
    setText(els.adminPostCount, "최근 " + posts.length + "개");
    if (!posts.length) {
      els.adminPostList.append(node("p", "muted-empty", "아직 게시글이 없습니다."));
      return;
    }
    posts.forEach(post => {
      const item = node("div", "admin-post-item");
      const info = node("div", "admin-post-info");
      info.append(node("strong", "", (post.is_pinned ? "✦ " : "") + post.title));
      info.append(node("span", "", (post.category || "") + " · " + (post.author || "익명") + " · " + formatDate(post.created_at, true)));
      item.append(info);
      const pinButton = node("button", "admin-mini-btn", post.is_pinned ? "공지 해제" : "공지 고정");
      pinButton.type = "button";
      pinButton.addEventListener("click", () => togglePin(post.id, !post.is_pinned));
      item.append(pinButton);
      const deleteButton = node("button", "admin-mini-btn danger", "삭제");
      deleteButton.type = "button";
      deleteButton.addEventListener("click", () => deletePost(post.id, post.title));
      item.append(deleteButton);
      els.adminPostList.append(item);
    });
  }

  async function togglePin(id, isPinned) {
    try {
      await api("/api/admin/posts/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ is_pinned: isPinned })
      });
      toast(isPinned ? "게시글을 공지로 고정했습니다." : "공지 고정을 해제했습니다.");
      await Promise.all([loadAdminData(), loadPosts()]);
    } catch (error) {
      toast(error.message || "게시글 상태를 변경하지 못했습니다.", "error");
    }
  }

  async function deletePost(id, title) {
    if (!window.confirm('"' + title + '" 게시글을 삭제할까요? 댓글과 첨부 사진도 함께 삭제됩니다.')) return;
    try {
      await api("/api/admin/posts/" + encodeURIComponent(id), { method: "DELETE" });
      toast("게시글을 삭제했습니다.");
      if (state.currentPostId === id && els.detailDialog.open) els.detailDialog.close();
      await Promise.all([loadAdminData(), loadPosts(), loadNotifications()]);
    } catch (error) {
      toast(error.message || "게시글을 삭제하지 못했습니다.", "error");
    }
  }

  async function installApp() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      const result = await state.installPrompt.userChoice.catch(() => null);
      if (result && result.outcome === "accepted") toast("MYTHIC 앱 설치를 시작했습니다.");
      state.installPrompt = null;
      els.installBtn.textContent = "앱 설치";
      return;
    }
    const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const guidance = isAppleMobile
      ? "Safari의 공유 버튼을 누른 뒤 '홈 화면에 추가'를 선택하면 설치할 수 있어요."
      : "브라우저 메뉴(⋮ 또는 …)에서 '앱 설치' 또는 '홈 화면에 추가'를 선택하세요. HTTPS 환경에서 이용할 수 있습니다.";
    toast(guidance);
  }

  function bindEvents() {
    $$(".nav-item, .board-tab").forEach(button => {
      button.addEventListener("click", () => {
        setActiveCategory(button.dataset.category);
        if (state.category !== "전체" && els.composeDialog.open) els.composeCategory.value = state.category;
        els.mainNav.classList.remove("mobile-open");
        els.mobileMenuBtn.setAttribute("aria-expanded", "false");
      });
    });
    $("#heroWriteBtn").addEventListener("click", () => openCompose());
    $("#writeBtn").addEventListener("click", () => openCompose());
    $("#bottomWriteBtn").addEventListener("click", () => openCompose());
    $("#joinWriteBtn").addEventListener("click", () => openCompose());
    $("#browseBtn").addEventListener("click", () => $("#community").scrollIntoView({ behavior: "smooth" }));
    els.composeCategory.addEventListener("change", updatePhotoMode);
    els.photoInput.addEventListener("change", () => {
      const files = Array.from(els.photoInput.files || []);
      if (files.length > 8) {
        toast("사진은 한 번에 최대 8장까지 선택할 수 있습니다.", "error");
        els.photoInput.value = "";
        state.selectedFiles = [];
      } else {
        state.selectedFiles = files;
      }
      renderImagePreviews();
    });
    els.composeForm.addEventListener("submit", submitPost);
    els.commentForm.addEventListener("submit", submitComment);
    els.searchInput.addEventListener("input", () => {
      if (state.searchTimer) window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(loadPosts, 260);
    });
    els.sortSelect.addEventListener("change", loadPosts);
    $$("[data-close]").forEach(button => button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.close);
      if (dialog && dialog.open) dialog.close();
    }));
    [els.composeDialog, els.detailDialog, els.adminDialog].forEach(dialog => {
      dialog.addEventListener("click", event => {
        if (event.target === dialog) dialog.close();
      });
    });
    els.notificationBtn.addEventListener("click", openNotifications);
    $("#closeNotifications").addEventListener("click", () => { els.notificationPanel.hidden = true; });
    document.addEventListener("click", event => {
      if (!els.notificationPanel.hidden && !els.notificationPanel.contains(event.target) && !els.notificationBtn.contains(event.target)) {
        els.notificationPanel.hidden = true;
      }
    });
    els.enableBrowserNotifications.addEventListener("click", enableBrowserNotifications);
    $("#adminBtn").addEventListener("click", openAdmin);
    $("#footerAdminBtn").addEventListener("click", event => { event.preventDefault(); openAdmin(); });
    els.adminLoginForm.addEventListener("submit", submitAdminLogin);
    els.adminLogoutBtn.addEventListener("click", logoutAdmin);
    els.installBtn.addEventListener("click", installApp);
    els.mobileMenuBtn.addEventListener("click", () => {
      const opened = els.mainNav.classList.toggle("mobile-open");
      els.mobileMenuBtn.setAttribute("aria-expanded", String(opened));
    });
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      state.installPrompt = event;
      els.installBtn.hidden = false;
      els.installBtn.textContent = "앱 설치";
    });
    window.addEventListener("appinstalled", () => {
      state.installPrompt = null;
      toast("MYTHIC 앱이 설치되었습니다.");
    });
  }

  async function init() {
    $("#currentYear").textContent = String(new Date().getFullYear());
    readSeenNotifications();
    bindEvents();
    els.installBtn.hidden = false;
    if ("Notification" in window && Notification.permission === "granted") {
      els.enableBrowserNotifications.textContent = "브라우저 알림 사용 중";
      els.enableBrowserNotifications.disabled = true;
    }
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    await Promise.all([loadPosts(), loadNotifications(), recordVisit()]);
    window.setInterval(() => loadNotifications(), 60000);
  }

  init();
})();
