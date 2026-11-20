// WISP — 흔적 없이 흩어지는 익명 채팅 공간
// 메시지는 받은 즉시 접속자에게 전달만 하고, 어디에도 저장하거나 로그로 남기지 않는다.

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MAX_USERS = 10;
const MAX_MSG_LEN = 200;
const ROOM_W = 1000;
const ROOM_H = 600;
const MIN_Y = 140; // 뒷벽(문/바 카운터) 앞까지만 걸어갈 수 있다

// 공간: 처음엔 광장, 문으로 들어가면 술집
const ROOMS = {
  plaza: { spawn: () => ({ x: 300 + Math.random() * 400, y: 300 + Math.random() * 150 }) },
  bar: { spawn: () => ({ x: 130, y: 520 }) },
};
const ARRIVE = {
  bar: () => ({ x: 130 + Math.random() * 40, y: 510 + Math.random() * 30 }), // 출구 매트 옆
  plaza: () => ({ x: 470 + Math.random() * 60, y: 215 }),                      // 술집 문 앞
};

const ANIMALS = [
  ["🐱", "고양이"], ["🐶", "강아지"], ["🦊", "여우"], ["🐻", "곰"],
  ["🐼", "판다"], ["🐰", "토끼"], ["🐸", "개구리"], ["🐧", "펭귄"],
  ["🦉", "부엉이"], ["🐙", "문어"], ["🦔", "고슴도치"], ["🐨", "코알라"],
  ["🦦", "수달"], ["🐹", "햄스터"], ["🦥", "나무늘보"], ["🐳", "고래"],
];
const ADJECTIVES = [
  "졸린", "수상한", "조용한", "떠도는", "배고픈", "몽롱한",
  "투명한", "느긋한", "엉뚱한", "반짝이는", "익명의", "길 잃은",
];
const PROPS = ["🪑", "🛢️", "🪴", "📦", "🍾", "🗿", "🧺"];
const ACTS = new Set([
  "puff", "sigh", "bubbles", "pop", "coffee", "poke", "plane", "hide", "sleep",
  "order", "sip", "cheers", "treat",
]);
// 술 종류 → 한 모금당 취기
const DRINKS = { beer: 0.1, soju: 0.18, wine: 0.13, cocktail: 0.13, whisky: 0.22 };
const SIPS_PER_GLASS = 4;
const SOBER_PER_SEC = 1 / 300; // 취기 1.0이 5분에 걸쳐 깬다
const CHEERS_RANGE = 170;
const COLORS = ["#ff8fab", "#ffd166", "#06d6a0", "#4cc9f0", "#b388ff", "#ff9e6d", "#90e0ef", "#c5f277"];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function soberUp(p) {
  const now = Date.now();
  p.tipsy = Math.max(0, p.tipsy - ((now - p.tipsyAt) / 1000) * SOBER_PER_SEC);
  p.tipsyAt = now;
  return p.tipsy;
}

function randomCharacter() {
  const [emoji, animal] = pick(ANIMALS);
  return { emoji, name: `${pick(ADJECTIVES)} ${animal}`, color: pick(COLORS) };
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/character", (_req, res) => res.json(randomCharacter()));

const server = http.createServer(app);
const io = new Server(server);

// 현재 접속자 위치/외형만 메모리에 둔다. 대화 내용은 보관하지 않는다.
const players = new Map();

const inRoom = (room) => [...players.values()].filter((p) => p.room === room);
function sendCounts() {
  io.emit("count", { plaza: inRoom("plaza").length, bar: inRoom("bar").length });
}
function snapshot(room) {
  const list = inRoom(room);
  list.forEach(soberUp);
  return list;
}
const roomInfo = (room) => ({ id: room, w: ROOM_W, h: ROOM_H, minY: MIN_Y });

io.on("connection", (socket) => {
  let lastMsgAt = 0;
  let lastActAt = 0;

  socket.on("join", (character, ack) => {
    if (players.has(socket.id)) return;
    if (players.size >= MAX_USERS) {
      ack?.({ ok: false, reason: "방이 가득 찼어요." });
      return;
    }
    const base = randomCharacter();
    const valid = character && ANIMALS.some(([e]) => e === character.emoji);
    const pos = ROOMS.plaza.spawn();
    const player = {
      id: socket.id,
      room: "plaza",
      emoji: valid ? character.emoji : base.emoji,
      name: valid ? String(character.name).slice(0, 20) : base.name,
      color: valid && COLORS.includes(character.color) ? character.color : base.color,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      hidden: null, // 변신 중인 소품 이모지
      sleep: false,
      drink: null,  // { kind, left }
      tipsy: 0,
      tipsyAt: Date.now(),
    };
    players.set(socket.id, player);
    socket.join(player.room);
    ack?.({ ok: true, me: player, players: snapshot(player.room), room: roomInfo(player.room) });
    socket.to(player.room).emit("player:join", player);
    sendCounts();
  });

  // 문을 지나 다른 공간으로
  socket.on("go", (room, ack) => {
    const p = players.get(socket.id);
    if (!p || !ROOMS[room] || p.room === room) return;
    socket.to(p.room).emit("player:leave", p.id);
    socket.leave(p.room);
    p.room = room;
    const pos = ARRIVE[room]();
    p.x = Math.round(pos.x);
    p.y = Math.round(pos.y);
    p.hidden = null;
    p.sleep = false;
    socket.join(room);
    ack?.({ me: p, players: snapshot(room), room: roomInfo(room) });
    socket.to(room).emit("player:join", p);
    sendCounts();
  });

  socket.on("move", (pos) => {
    const p = players.get(socket.id);
    if (!p || !pos) return;
    p.x = clamp(Number(pos.x) || 0, 0, ROOM_W);
    p.y = clamp(Number(pos.y) || 0, MIN_Y, ROOM_H);
    socket.to(p.room).emit("player:move", { id: p.id, x: p.x, y: p.y });
  });

  socket.on("say", (text) => {
    const p = players.get(socket.id);
    if (!p || typeof text !== "string") return;
    const now = Date.now();
    if (now - lastMsgAt < 400) return; // 도배 방지
    lastMsgAt = now;
    const msg = text.trim().slice(0, MAX_MSG_LEN);
    if (!msg) return;
    // 같은 공간에 있는 사람에게 전달만 하고 끝. 저장/로그 없음.
    io.to(p.room).emit("player:say", { id: p.id, text: msg });
  });

  // 캐릭터 액션
  socket.on("act", (a) => {
    const p = players.get(socket.id);
    if (!p || !a || !ACTS.has(a.type)) return;
    if (a.type !== "pop" && a.type !== "sleep") {
      const now = Date.now();
      if (now - lastActAt < 250) return;
      lastActAt = now;
    }
    const out = { id: p.id, type: a.type };
    const text = typeof a.text === "string" ? a.text.trim().slice(0, MAX_MSG_LEN) : "";
    const target = players.get(a.target);
    const sameRoomTarget = target && target.id !== p.id && target.room === p.room;

    switch (a.type) {
      case "puff":
        out.power = clamp(Number(a.power) || 0, 0, 1);
        if (text) out.text = text;
        break;
      case "bubbles":
        out.list = (Array.isArray(a.list) ? a.list : []).slice(0, 8).map((b) => ({
          bid: String(b?.bid).slice(0, 60),
          dx: clamp(Number(b?.dx) || 0, -220, 220),
          rise: clamp(Number(b?.rise) || 0, 40, 500),
          size: clamp(Number(b?.size) || 20, 10, 60),
          dur: clamp(Number(b?.dur) || 6000, 2000, 12000),
        }));
        break;
      case "pop":
        out.bid = String(a.bid).slice(0, 60);
        break;
      case "poke":
        if (!sameRoomTarget) return;
        out.target = target.id;
        break;
      case "plane": {
        if (!sameRoomTarget) return;
        out.target = target.id;
        // 비행기는 같은 공간 모두에게 보이지만, 귓속말 내용은 받는 사람에게만
        socket.to(p.room).except(target.id).emit("player:act", out);
        io.to(target.id).emit("player:act", { ...out, text, fromName: p.name });
        socket.emit("player:act", out);
        return;
      }
      case "hide":
        p.hidden = a.on ? pick(PROPS) : null;
        out.prop = p.hidden;
        break;
      case "sleep":
        p.sleep = !!a.on;
        out.on = p.sleep;
        break;
      case "order":
        if (p.room !== "bar" || !DRINKS[a.drink]) return;
        p.drink = { kind: a.drink, left: SIPS_PER_GLASS };
        out.drink = p.drink;
        break;
      case "sip":
        if (!p.drink || p.drink.left <= 0) return;
        p.drink.left -= 1;
        soberUp(p);
        p.tipsy = Math.min(1, p.tipsy + DRINKS[p.drink.kind]);
        out.drink = p.drink;
        out.tipsy = p.tipsy;
        break;
      case "cheers":
        if (!p.drink) return;
        out.targets = inRoom(p.room)
          .filter((q) => q.id !== p.id && q.drink && Math.hypot(q.x - p.x, q.y - p.y) < CHEERS_RANGE)
          .map((q) => q.id);
        break;
      case "treat":
        if (!sameRoomTarget || !DRINKS[a.drink]) return;
        target.drink = { kind: a.drink, left: SIPS_PER_GLASS };
        out.target = target.id;
        out.drink = target.drink;
        break;
    }
    io.to(p.room).emit("player:act", out);
  });

  socket.on("disconnect", () => {
    const p = players.get(socket.id);
    if (!p) return;
    players.delete(socket.id);
    io.to(p.room).emit("player:leave", socket.id);
    sendCounts();
  });
});

server.listen(PORT, () => {
  console.log(`WISP is drifting on http://localhost:${PORT}`);
});
