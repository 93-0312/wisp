// WISP client
(() => {
  const BUBBLE_MS = 7000;  // 말풍선 유지 시간 → 이후 글자가 흩어짐
  const NOTE_MS = 9000;    // 귓속말 쪽지 유지 시간
  const SPEED = 260;       // 이동 속도 (논리 좌표/초)
  const IDLE_MS = 60000;   // 이만큼 가만히 있으면 졸기
  const DEFAULT_PH = "속삭이기… (Enter · Shift+Enter = 연기로 뿜기)";

  const $ = (id) => document.getElementById(id);
  const lobby = $("lobby");
  const app = $("app");
  const room = $("room");
  const input = $("chatInput");
  const hint = $("hint");

  let character = null;
  let socket = null;
  let me = null;           // 내 캐릭터 데이터 (els의 data와 같은 객체)
  let ROOM = { w: 1000, h: 600 };
  const els = new Map();   // id -> { root, av, face, tag, data, dir, hidden }
  const soaps = new Map(); // 비눗방울 id -> element

  const rand = (a, b) => a + Math.random() * (b - a);
  const div = (cls) => {
    const d = document.createElement("div");
    d.className = cls;
    return d;
  };

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
      me = { id: res.me.id };
      res.players.forEach(addPlayer);
      me = els.get(res.me.id).data;
      me.tx = me.ty = null;
      lobby.classList.add("hidden");
      app.classList.remove("hidden");
      input.placeholder = DEFAULT_PH;
      input.focus();
      bindSocket();
      requestAnimationFrame(loop);
    });
  };

  // ---------- Players ----------
  function place(e) {
    e.root.style.left = (e.data.x / ROOM.w) * 100 + "%";
    e.root.style.top = (e.data.y / ROOM.h) * 100 + "%";
  }

  function addPlayer(p) {
    if (els.has(p.id)) return els.get(p.id);
    const isMe = p.id === me?.id;
    const root = div("player" + (isMe ? " me" : ""));
    const av = div("avatar");
    av.style.setProperty("--c", p.color);
    const face = document.createElement("span");
    face.className = "face";
    face.textContent = p.emoji;
    av.appendChild(face);
    const tag = div("nametag");
    tag.textContent = isMe ? `${p.name} (나)` : p.name;
    root.append(av, tag);
    room.appendChild(root);
    const e = { root, av, face, tag, data: { ...p }, dir: 0, hidden: null, walkTimer: null };
    els.set(p.id, e);
    place(e);
    if (p.hidden) applyHide(e, p.hidden, false);
    if (p.sleep) applySleep(e, true);
    return e;
  }

  function removePlayer(id) {
    const e = els.get(id);
    if (!e) return;
    e.root.style.transition = "opacity 600ms";
    e.root.style.opacity = "0";
    setTimeout(() => e.root.remove(), 600);
    els.delete(id);
    if (whisperTo === id) clearWhisper();
  }

  function markWalking(e) {
    e.root.classList.add("walking");
    clearTimeout(e.walkTimer);
    e.walkTimer = setTimeout(() => e.root.classList.remove("walking"), 200);
  }

  // 고개 돌리기: -1 왼쪽, 0 정면, 1 오른쪽
  function setFace(e, d) {
    if (!e || e.dir === d) return;
    e.dir = d;
    e.face.style.transform = d ? `translateX(${d * 4}px) rotate(${d * 8}deg)` : "";
  }

  function nearest(x, y, range) {
    let best = null;
    let bestD = range;
    els.forEach((e, id) => {
      if (id === me.id) return;
      const d = Math.hypot(e.data.x - x, e.data.y - y);
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }

  // ---------- 말풍선 / 쪽지 ----------
  function say(id, text, opts = {}) {
    const e = els.get(id);
    if (!e) return;
    e.root.querySelector(".bubble")?.remove();
    const bubble = div("bubble" + (opts.cls ? " " + opts.cls : ""));
    if (opts.title) {
      const t = div("note-title");
      t.textContent = opts.title;
      bubble.appendChild(t);
    }
    for (const c of text) {
      const s = document.createElement("span");
      s.className = "ch";
      s.textContent = c;
      bubble.appendChild(s);
    }
    e.root.prepend(bubble);
    setTimeout(() => scatter(bubble), opts.ms || BUBBLE_MS);
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

  // ---------- 이펙트 도우미 ----------
  function toPx(x, y) {
    return [(x / ROOM.w) * room.clientWidth, (y / ROOM.h) * room.clientHeight];
  }
  function mouth(e) {
    const [x, y] = toPx(e.data.x, e.data.y);
    return [x + (e.dir || 0) * 10, y - 12];
  }
  // 방 위에 떠다니는 이펙트 (제자리에 남는 것: 연기, 방울, 비행기)
  function fx(cls, x, y, text) {
    const el = div("fx " + cls);
    if (text != null) el.textContent = text;
    el.style.left = x + "px";
    el.style.top = y + "px";
    room.appendChild(el);
    return el;
  }
  // 캐릭터에 붙어 다니는 이펙트 (커피, 김)
  function attach(e, cls, text) {
    const el = div("fx-attached " + cls);
    if (text != null) el.textContent = text;
    e.root.appendChild(el);
    return el;
  }
  function anim(el, frames, opts) {
    const a = el.animate(frames, { easing: "ease-out", fill: "both", ...opts });
    a.onfinish = () => el.remove();
    return a;
  }
  const T = (x, y, extra = "") => `translate(-50%, -50%) translate(${x}px, ${y}px) ${extra}`;

  // ---------- 액션: 💨 연기 뿜기 ----------
  function doPuff(e, power, text) {
    const [mx, my] = mouth(e);
    const dir = e.dir || (Math.random() < 0.5 ? -1 : 1);
    const rings = 2 + Math.round(power * 3);
    for (let i = 0; i < rings; i++) {
      const size = 12 + power * 22 + i * 3;
      const el = fx("ring", mx, my);
      el.style.width = el.style.height = size + "px";
      const rise = 60 + power * 150 + i * 18;
      const drift = dir * (10 + power * 40) + rand(-12, 12);
      anim(el, [
        { transform: T(0, 0, "scale(.3)"), opacity: 0 },
        { transform: T(drift * 0.3, -rise * 0.3, "scale(1)"), opacity: 0.85, offset: 0.2 },
        { transform: T(drift, -rise, `scale(${2 + power * 2})`), opacity: 0 },
      ], { duration: 1800 + power * 1400, delay: i * 140, easing: "cubic-bezier(.2,.7,.3,1)" });
    }
    const haze = fx("haze", mx, my);
    anim(haze, [
      { transform: T(0, 0, "scale(.5)"), opacity: 0.5 },
      { transform: T(dir * 30, -40, "scale(3)"), opacity: 0 },
    ], { duration: 1600 });
    if (text) smokeText(mx, my, text, dir);
    e.av.animate([{ scale: "1.15" }, { scale: "0.92 1.04" }, { scale: "1" }], { duration: 500 });
  }

  // 글자가 연기에 섞여 나왔다가 흩어진다
  function smokeText(mx, my, text, dir) {
    const chars = [...text];
    const perRow = Math.min(chars.length, 14);
    const rows = Math.ceil(chars.length / perRow);
    chars.forEach((c, i) => {
      if (c === " ") return;
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x1 = (col - (perRow - 1) / 2) * 16 + dir * 20;
      const y1 = -70 - (rows - 1 - row) * 20;
      const el = fx("smoke-ch", mx, my, c);
      anim(el, [
        { transform: T(0, 0, "scale(.3)"), opacity: 0, filter: "blur(4px)", easing: "ease-out" },
        { transform: T(x1, y1, "scale(1)"), opacity: 1, filter: "blur(0px)", offset: 0.1, easing: "linear" },
        { transform: T(x1 + rand(-4, 4), y1 - 30, "scale(1)"), opacity: 0.9, filter: "blur(0px)", offset: 0.6, easing: "ease-in" },
        { transform: T(x1 + rand(-90, 90), y1 - 90 - rand(0, 80), `rotate(${rand(-90, 90)}deg) scale(1.4)`), opacity: 0, filter: "blur(5px)" },
      ], { duration: 6000, delay: i * 45, easing: "linear" });
    });
  }

  // ---------- 액션: 😮‍💨 한숨 ----------
  function doSigh(e) {
    e.av.animate([
      { scale: "1" },
      { scale: "1.1 0.8", translate: "0 5px", offset: 0.3 },
      { scale: "1.05 0.88", translate: "0 3px", offset: 0.7 },
      { scale: "1", translate: "0 0" },
    ], { duration: 1300, easing: "ease-in-out" });
    const [mx, my] = mouth(e);
    const dir = e.dir || 1;
    for (let i = 0; i < 3; i++) {
      const el = fx("cloud", mx + dir * 8, my + 6);
      anim(el, [
        { transform: T(0, 0, "scale(.4)"), opacity: 0 },
        { transform: T(dir * (20 + i * 6), -4 - i * 4, "scale(1)"), opacity: 0.8, offset: 0.3 },
        { transform: T(dir * (60 + i * 12), -20 - i * 8, "scale(1.8)"), opacity: 0 },
      ], { duration: 1600, delay: 200 + i * 120 });
    }
  }

  // ---------- 액션: 🫧 비눗방울 (누구나 클릭해서 터뜨릴 수 있음) ----------
  function sendBubbles() {
    const stamp = Date.now().toString(36);
    const list = Array.from({ length: 6 }, (_, i) => ({
      bid: `${me.id}-${stamp}-${i}`,
      dx: rand(-170, 170),
      rise: rand(120, 380),
      size: rand(16, 38),
      dur: rand(5000, 9000),
    }));
    socket.emit("act", { type: "bubbles", list });
  }

  function doBubbles(e, list) {
    const [mx, my] = mouth(e);
    list.forEach((b, i) => {
      const el = fx("soap", mx, my);
      el.style.width = el.style.height = b.size + "px";
      el.appendChild(div("soap-in"));
      el.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        socket.emit("act", { type: "pop", bid: b.bid });
      });
      soaps.set(b.bid, el);
      const wob = (k) => Math.sin(k * Math.PI * 3) * 18;
      const frames = [0, 0.1, 0.35, 0.6, 0.85, 1].map((k) => ({
        transform: T(b.dx * k + wob(k), -b.rise * k),
        opacity: k === 0 || k === 1 ? 0 : 1,
        offset: k,
      }));
      const a = el.animate(frames, { duration: b.dur, delay: i * 150, easing: "linear", fill: "both" });
      a.onfinish = () => { el.remove(); soaps.delete(b.bid); };
    });
  }

  function doPop(bid) {
    const el = soaps.get(bid);
    if (!el) return;
    soaps.delete(bid);
    el.getAnimations().forEach((a) => a.pause());
    el.style.pointerEvents = "none";
    el.firstChild.animate(
      [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.9)", opacity: 0 }],
      { duration: 260, fill: "forwards" },
    ).onfinish = () => el.remove();
  }

  // ---------- 액션: ☕ 커피 홀짝 ----------
  function doCoffee(e) {
    const side = -(e.dir || 1);
    const cx = side * 30;
    const cup = attach(e, "cup", "☕");
    anim(cup, [
      { opacity: 0, transform: `translate(${cx}px, 8px) scale(.5)` },
      { opacity: 1, transform: `translate(${cx}px, 4px) scale(1)`, offset: 0.1 },
      { opacity: 1, transform: `translate(${cx}px, 4px) scale(1)`, offset: 0.9 },
      { opacity: 0, transform: `translate(${cx}px, 8px) scale(.6)` },
    ], { duration: 5000 });
    for (let i = 0; i < 8; i++) {
      setTimeout(() => {
        if (!cup.isConnected) return;
        const s = attach(e, "steam");
        const x = cx + rand(-4, 4);
        anim(s, [
          { opacity: 0, transform: `translate(${x}px, -6px) scale(.5)` },
          { opacity: 0.7, transform: `translate(${x + rand(-6, 6)}px, -20px) scale(1)`, offset: 0.3 },
          { opacity: 0, transform: `translate(${x + rand(-10, 10)}px, -46px) scale(1.6)` },
        ], { duration: 1400 });
      }, 300 + i * 500);
    }
    [1200, 3000].forEach((t) => setTimeout(() => {
      e.av.animate([{ rotate: "0deg" }, { rotate: `${side * -12}deg`, offset: 0.4 }, { rotate: "0deg" }], { duration: 700 });
    }, t));
  }

  // ---------- 액션: 👉 쿡 찌르기 ----------
  function doPoke(e, t) {
    if (!t) return;
    const dx = t.data.x - e.data.x;
    const dy = t.data.y - e.data.y;
    const d = Math.hypot(dx, dy) || 1;
    setFace(e, Math.sign(dx));
    e.av.animate([
      { translate: "0 0" },
      { translate: `${(dx / d) * 18}px ${(dy / d) * 18}px`, offset: 0.4 },
      { translate: "0 0" },
    ], { duration: 350 });
    setTimeout(() => {
      t.av.animate([
        { translate: "0 0", rotate: "0deg" },
        { translate: "-5px 0", rotate: "-10deg" },
        { translate: "5px 0", rotate: "10deg" },
        { translate: "-3px 0", rotate: "-6deg" },
        { translate: "0 0", rotate: "0deg" },
      ], { duration: 450 });
      setFace(t, -Math.sign(dx) || 0);
      const [x, y] = toPx(t.data.x, t.data.y);
      popMark(x + 16, y - 32, "!");
    }, 150);
  }

  function popMark(x, y, text) {
    const m = fx("mark", x, y, text);
    anim(m, [
      { transform: T(0, 6, "scale(.4)"), opacity: 0 },
      { transform: T(0, 0, "scale(1.2)"), opacity: 1, offset: 0.25 },
      { transform: T(0, -8, "scale(1)"), opacity: 0 },
    ], { duration: 900 });
  }

  // ---------- 액션: ✈️ 종이비행기 귓속말 ----------
  function doPlane(e, t, a) {
    const [sx, sy] = mouth(e);
    let [ex, ey] = toPx(t.data.x, t.data.y);
    ey -= 22;
    const dist = Math.hypot(ex - sx, ey - sy);
    const lift = Math.min(120, dist * 0.35);
    const N = 10;
    const pts = [];
    for (let k = 0; k <= N; k++) {
      const s = k / N;
      pts.push([sx + (ex - sx) * s, sy + (ey - sy) * s - Math.sin(Math.PI * s) * lift]);
    }
    const el = fx("plane", sx, sy, "✈️");
    const frames = pts.map(([x, y], k) => {
      const [ax, ay] = pts[Math.max(0, k - 1)];
      const [bx, by] = pts[Math.min(N, k + 1)];
      const ang = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI + 45; // ✈️ 글리프는 오른쪽 위(-45°)를 향함
      return { transform: T(x - sx, y - sy, `rotate(${ang}deg)`), offset: k / N, opacity: k === N ? 0 : 1 };
    });
    anim(el, frames, { duration: 700 + dist * 1.2, easing: "ease-in-out" }).finished.then(() => {
      t.av.animate([{ translate: "0 0" }, { translate: "0 -6px" }, { translate: "0 0" }], { duration: 300 });
      if (t.data.id === me.id && a.text) {
        say(me.id, a.text, { cls: "note", title: `✉ ${a.fromName}의 귓속말`, ms: NOTE_MS });
      } else {
        const [x, y] = toPx(t.data.x, t.data.y);
        popMark(x + 16, y - 32, "✉");
      }
    }).catch(() => {});
  }

  // ---------- 액션: 🪴 변신 숨기 ----------
  function applyHide(e, prop, poof = true) {
    e.hidden = prop || null;
    if (poof) {
      const [x, y] = toPx(e.data.x, e.data.y);
      for (let i = 0; i < 7; i++) {
        const c = fx("cloud", x, y);
        const ang = (i / 7) * Math.PI * 2;
        anim(c, [
          { transform: T(0, 0, "scale(.6)"), opacity: 0.9 },
          { transform: T(Math.cos(ang) * 34, Math.sin(ang) * 24, "scale(1.6)"), opacity: 0 },
        ], { duration: 700 });
      }
    }
    e.root.classList.toggle("disguised", !!prop);
    e.face.textContent = prop || e.data.emoji;
  }

  // ---------- 💤 졸기 (자동) ----------
  function applySleep(e, on) {
    e.root.classList.toggle("sleeping", on);
    e.root.querySelector(".zzz")?.remove();
    if (on) {
      const z = div("zzz");
      z.innerHTML = "<span>z</span><span>z</span><span>Z</span>";
      e.root.appendChild(z);
    }
  }

  let lastActive = Date.now();
  let asleep = false;
  function activity() {
    lastActive = Date.now();
    if (asleep && socket) {
      asleep = false;
      socket.emit("act", { type: "sleep", on: false });
    }
  }
  setInterval(() => {
    if (me && socket && !asleep && Date.now() - lastActive > IDLE_MS) {
      asleep = true;
      socket.emit("act", { type: "sleep", on: true });
    }
  }, 5000);

  // ---------- 액션 실행 ----------
  const KEY_ACTIONS = { 1: "sigh", 2: "bubbles", 3: "plane", 4: "coffee", 5: "poke", 6: "hide" };

  function runAction(name) {
    if (!me || !socket) return;
    activity();
    switch (name) {
      case "sigh":
      case "coffee":
        socket.emit("act", { type: name });
        break;
      case "bubbles":
        sendBubbles();
        break;
      case "plane":
        startAim();
        break;
      case "poke": {
        const t = nearest(me.x, me.y, 200);
        if (t) socket.emit("act", { type: "poke", target: t.data.id });
        else {
          const [x, y] = toPx(me.x, me.y);
          popMark(x + 16, y - 32, "?");
          setHint("👉 가까이 있는 사람이 없어요", 1500);
        }
        break;
      }
      case "hide":
        socket.emit("act", { type: "hide", on: !els.get(me.id).hidden });
        break;
    }
  }

  // 힌트 문구
  const DEFAULT_HINT = hint.textContent;
  let hintTimer = null;
  function setHint(text, ms) {
    clearTimeout(hintTimer);
    hint.textContent = text || DEFAULT_HINT;
    hint.classList.toggle("active", !!text);
    if (text && ms) hintTimer = setTimeout(() => setHint(null), ms);
  }

  // 종이비행기 조준 → 귓속말 모드
  let aiming = false;
  let whisperTo = null;
  function startAim() {
    if (els.size < 2) {
      setHint("✈️ 날릴 사람이 없어요", 1500);
      return;
    }
    aiming = true;
    room.classList.add("aiming");
    setHint("✈️ 받을 사람을 클릭 (Esc 취소)");
  }
  function endAim() {
    aiming = false;
    room.classList.remove("aiming");
    setHint(null);
  }
  function setWhisper(id) {
    whisperTo = id;
    const e = els.get(id);
    const name = e.hidden ? "수상한 소품" : e.data.name;
    input.placeholder = `✈️ ${name}에게 귓속말… (Enter, Esc 취소)`;
    input.classList.add("whisper");
    input.focus();
  }
  function clearWhisper() {
    whisperTo = null;
    input.placeholder = DEFAULT_PH;
    input.classList.remove("whisper");
  }

  // 💨 길게 눌렀다 떼면 연기
  let inhaleStart = 0;
  function startInhale() {
    if (!me || inhaleStart) return;
    inhaleStart = performance.now();
    activity();
  }
  function releasePuff() {
    if (!inhaleStart) return;
    const power = Math.min(1, (performance.now() - inhaleStart) / 1500);
    inhaleStart = 0;
    els.get(me.id).av.style.scale = "";
    socket.emit("act", { type: "puff", power });
  }

  // 액션 버튼 바
  const bar = $("actions");
  bar.addEventListener("mousedown", (ev) => ev.preventDefault()); // 입력창 포커스 유지
  bar.querySelectorAll("[data-act]").forEach((b) => {
    b.addEventListener("click", () => runAction(b.dataset.act));
  });
  const puffBtn = bar.querySelector("[data-hold=puff]");
  puffBtn.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    puffBtn.setPointerCapture(ev.pointerId);
    startInhale();
  });
  puffBtn.addEventListener("pointerup", releasePuff);
  puffBtn.addEventListener("pointercancel", releasePuff);

  // ---------- Socket ----------
  function bindSocket() {
    socket.on("player:join", (p) => {
      addPlayer(p);
      // 다들 새로 온 사람 쪽으로 고개를 슥
      els.forEach((e, id) => {
        if (id !== p.id) setFace(e, Math.sign(p.x - e.data.x) || 0);
      });
    });
    socket.on("player:leave", removePlayer);
    socket.on("player:move", ({ id, x, y }) => {
      const e = els.get(id);
      if (!e) return;
      const d = Math.sign(x - e.data.x);
      if (d) setFace(e, d);
      e.data.x = x;
      e.data.y = y;
      place(e);
      markWalking(e);
    });
    socket.on("player:say", ({ id, text }) => say(id, text));
    socket.on("player:act", (a) => {
      const e = els.get(a.id);
      if (!e) return;
      const t = a.target ? els.get(a.target) : null;
      switch (a.type) {
        case "puff": doPuff(e, a.power, a.text); break;
        case "sigh": doSigh(e); break;
        case "bubbles": doBubbles(e, a.list); break;
        case "pop": doPop(a.bid); break;
        case "coffee": doCoffee(e); break;
        case "poke": doPoke(e, t); break;
        case "plane": if (t) doPlane(e, t, a); break;
        case "hide": applyHide(e, a.prop); break;
        case "sleep": applySleep(e, a.on); break;
      }
    });
    socket.on("count", (n) => ($("count").textContent = `지금 ${n}명이 떠돌고 있어요`));
    socket.on("disconnect", () => {
      $("count").textContent = "연결이 끊겼어요. 새로고침해 주세요.";
    });
  }

  // ---------- 키보드 ----------
  const keys = new Set();
  const KEYMAP = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
  };

  window.addEventListener("keydown", (ev) => {
    if (!me) return;
    activity();
    if (ev.key === "Escape") {
      if (aiming) endAim();
      else if (whisperTo) clearWhisper();
      return;
    }
    const focused = document.activeElement === input;
    // 입력창에 글자가 있으면 키는 전부 타이핑용
    if (focused && input.value.length > 0) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;

    if (ev.code === "Space") {
      ev.preventDefault();
      if (!ev.repeat) startInhale();
      return;
    }
    if (KEY_ACTIONS[ev.key]) {
      ev.preventDefault();
      runAction(KEY_ACTIONS[ev.key]);
      return;
    }
    // 입력창 포커스 중엔 WASD는 글자로 남겨둔다
    if (focused && /^[wasdWASD]$/.test(ev.key)) return;
    if (KEYMAP[ev.key]) {
      keys.add(ev.key);
      me.tx = me.ty = null; // 키 이동 시 클릭 목적지 취소
      ev.preventDefault();
    }
  });
  window.addEventListener("keyup", (ev) => {
    keys.delete(ev.key);
    if (ev.code === "Space") releasePuff();
  });
  window.addEventListener("blur", () => {
    keys.clear();
    releasePuff();
  });

  // Shift+Enter: 글자를 연기로 뿜기
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.shiftKey) {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit("act", { type: "puff", power: 0.6, text });
      input.value = "";
    }
  });

  // ---------- 클릭 이동 / 조준 ----------
  room.addEventListener("pointerdown", (ev) => {
    if (!me) return;
    activity();
    const r = room.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * ROOM.w;
    const y = ((ev.clientY - r.top) / r.height) * ROOM.h;
    if (aiming) {
      const t = nearest(x, y, 80);
      endAim();
      if (t) setWhisper(t.data.id);
      return;
    }
    me.tx = x;
    me.ty = y;
  });

  // ---------- 루프 ----------
  let last = performance.now();
  let lastSent = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const mine = els.get(me.id);

    if (inhaleStart) {
      const p = Math.min(1, (now - inhaleStart) / 1500);
      mine.av.style.scale = String(1 + p * 0.28);
    }

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
      if (Math.abs(dx) > 0.2) setFace(mine, Math.sign(dx));
      place(mine);
      markWalking(mine);
      if (now - lastSent > 60) {
        socket.emit("move", { x: Math.round(me.x), y: Math.round(me.y) });
        lastSent = now;
        activity();
      }
    }
    requestAnimationFrame(loop);
  }

  // ---------- Chat ----------
  $("chatForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!socket) return;
    if (whisperTo) {
      socket.emit("act", { type: "plane", target: whisperTo, text });
      clearWhisper();
      input.value = "";
      return;
    }
    if (!text) return;
    socket.emit("say", text);
    input.value = "";
  });
})();
