// WISP client
(() => {
  const BUBBLE_MS = 7000; // 말풍선 유지 시간 → 이후 글자가 흩어짐
  const SPEED = 260;      // 이동 속도 (논리 좌표/초)

  const $ = (id) => document.getElementById(id);
  const lobby = $("lobby");
  const app = $("app");
  const room = $("room");
  const input = $("chatInput");

  let character = null;
  let socket = null;
  let me = null;
  let ROOM = { w: 1000, h: 600 };
  const els = new Map(); // id -> { root, bubbleTimer }

  // ---------- 몰래 모드 ----------
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const REAL_TITLE = "WISP";
  const QUIET_TITLE = "메모";

  function setStealth(on) {
    document.body.classList.toggle("stealth", on);
    document.title = on ? QUIET_TITLE : REAL_TITLE;
    store.set("wisp:stealth", on ? "1" : "0");
  }
  setStealth(store.get("wisp:stealth") === "1");
  $("stealthBtn").onclick = () => setStealth(!document.body.classList.contains("stealth"));

  // 긴급 가림막: Esc 두 번 빠르게 → 덮기 / 가림막 상태에서 클릭이나 아무 키 → 복귀
  const cover = $("cover");
  let lastEsc = 0;
  let coverShownAt = 0;
  function showCover() {
    cover.classList.remove("hidden");
    document.title = QUIET_TITLE;
    document.activeElement?.blur();
    coverShownAt = Date.now();
  }
  function hideCover() {
    cover.classList.add("hidden");
    document.title = document.body.classList.contains("stealth") ? QUIET_TITLE : REAL_TITLE;
    if (me) input.focus();
  }
  window.addEventListener("keydown", (ev) => {
    if (!cover.classList.contains("hidden")) {
      if (Date.now() - coverShownAt > 300) hideCover();
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    if (ev.altKey && (ev.key === "s" || ev.key === "S" || ev.code === "KeyS")) {
      ev.preventDefault();
      setStealth(!document.body.classList.contains("stealth"));
      return;
    }
    if (ev.key === "Escape") {
      const now = Date.now();
      if (now - lastEsc < 500) showCover();
      lastEsc = now;
    }
  }, true);
  cover.addEventListener("click", hideCover);

  // ---------- Lobby ----------
  async function reroll() {
    character = await fetch("/character").then((r) => r.json());
    const av = $("previewAvatar");
    av.textContent = character.emoji;
    av.style.setProperty("--c", character.color);
    $("previewName").textContent = character.name;
  }
  $("rerollBtn").onclick = reroll;
  reroll();

  $("enterBtn").onclick = (ev) => {
    if (socket) return; // 중복 입장 방지
    ev.currentTarget.disabled = true;
    ev.currentTarget.blur();
    socket = io();
    socket.emit("join", character, (res) => {
      if (!res.ok) {
        $("lobbyError").textContent = res.reason;
        socket.disconnect();
        socket = null;
        $("enterBtn").disabled = false;
        return;
      }
      ROOM = res.room;
      me = { ...res.me, tx: res.me.x, ty: res.me.y };
      res.players.forEach(addPlayer);
      lobby.classList.add("hidden");
      app.classList.remove("hidden");
      input.focus();
      bindSocket();
      requestAnimationFrame(loop);
    });
  };

  // ---------- Rendering ----------
  function place(root, x, y) {
    root.style.left = (x / ROOM.w) * 100 + "%";
    root.style.top = (y / ROOM.h) * 100 + "%";
  }

  function addPlayer(p) {
    if (els.has(p.id)) return;
    const root = document.createElement("div");
    root.className = "player" + (p.id === me?.id ? " me" : "");
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = p.emoji;
    av.style.setProperty("--c", p.color);
    const tag = document.createElement("div");
    tag.className = "nametag";
    tag.textContent = p.id === me?.id ? `${p.name} (나)` : p.name;
    root.append(av, tag);
    place(root, p.x, p.y);
    room.appendChild(root);
    els.set(p.id, { root, walkTimer: null });
  }

  function removePlayer(id) {
    const e = els.get(id);
    if (!e) return;
    e.root.style.transition = "opacity 600ms";
    e.root.style.opacity = "0";
    setTimeout(() => e.root.remove(), 600);
    els.delete(id);
  }

  function markWalking(id) {
    const e = els.get(id);
    if (!e) return;
    e.root.classList.add("walking");
    clearTimeout(e.walkTimer);
    e.walkTimer = setTimeout(() => e.root.classList.remove("walking"), 200);
  }

  function say(id, text) {
    const e = els.get(id);
    if (!e) return;
    e.root.querySelector(".bubble")?.remove();
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    for (const c of text) {
      const s = document.createElement("span");
      s.className = "ch";
      s.textContent = c;
      bubble.appendChild(s);
    }
    e.root.prepend(bubble);
    setTimeout(() => scatter(bubble), BUBBLE_MS);
  }

  // 글자를 한 자씩 흩날려 사라지게 한다
  function scatter(bubble) {
    if (!bubble.isConnected) return;
    bubble.querySelectorAll(".ch").forEach((s) => {
      s.style.setProperty("--dx", (Math.random() - 0.5) * 160 + "px");
      s.style.setProperty("--dy", -(40 + Math.random() * 120) + "px");
      s.style.setProperty("--rot", (Math.random() - 0.5) * 120 + "deg");
      s.style.transitionDelay = Math.random() * 400 + "ms";
    });
    bubble.classList.add("scatter");
    setTimeout(() => bubble.remove(), 2200);
  }

  // ---------- Socket ----------
  function bindSocket() {
    socket.on("player:join", addPlayer);
    socket.on("player:leave", removePlayer);
    socket.on("player:move", ({ id, x, y }) => {
      const e = els.get(id);
      if (!e) return;
      place(e.root, x, y);
      markWalking(id);
    });
    socket.on("player:say", ({ id, text }) => say(id, text));
    socket.on("count", (n) => ($("count").textContent = `지금 ${n}명이 떠돌고 있어요`));
    socket.on("disconnect", () => {
      $("count").textContent = "연결이 끊겼어요. 새로고침해 주세요.";
    });
  }

  // ---------- Movement ----------
  const keys = new Set();
  const KEYMAP = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
  };

  window.addEventListener("keydown", (ev) => {
    if (!me) return;
    const typing = document.activeElement === input;
    // 입력창에 글자가 있으면 방향키는 커서 이동용으로 남겨둔다
    if (typing && (input.value.length > 0 || /^[wasdWASD]$/.test(ev.key))) return;
    if (KEYMAP[ev.key]) {
      keys.add(ev.key);
      me.tx = me.ty = null; // 키 이동 시 클릭 목적지 취소
      ev.preventDefault();
    }
  });
  window.addEventListener("keyup", (ev) => keys.delete(ev.key));
  window.addEventListener("blur", () => keys.clear());

  room.addEventListener("pointerdown", (ev) => {
    if (!me) return;
    const r = room.getBoundingClientRect();
    me.tx = ((ev.clientX - r.left) / r.width) * ROOM.w;
    me.ty = ((ev.clientY - r.top) / r.height) * ROOM.h;
  });

  let last = performance.now();
  let lastSent = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    let dx = 0, dy = 0;
    keys.forEach((k) => { dx += KEYMAP[k][0]; dy += KEYMAP[k][1]; });

    if (!dx && !dy && me.tx != null) {
      const vx = me.tx - me.x, vy = me.ty - me.y;
      const dist = Math.hypot(vx, vy);
      if (dist < 4) { me.tx = me.ty = null; }
      else { dx = vx / dist; dy = vy / dist; }
    }

    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      me.x = Math.max(0, Math.min(ROOM.w, me.x + (dx / len) * SPEED * dt));
      me.y = Math.max(0, Math.min(ROOM.h, me.y + (dy / len) * SPEED * dt));
      place(els.get(me.id).root, me.x, me.y);
      markWalking(me.id);
      if (now - lastSent > 60) {
        socket.emit("move", { x: Math.round(me.x), y: Math.round(me.y) });
        lastSent = now;
      }
    }
    requestAnimationFrame(loop);
  }

  // ---------- Chat ----------
  $("chatForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !socket) return;
    socket.emit("say", text);
    input.value = "";
  });
})();
