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
const COLORS = ["#ff8fab", "#ffd166", "#06d6a0", "#4cc9f0", "#b388ff", "#ff9e6d", "#90e0ef", "#c5f277"];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

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

io.on("connection", (socket) => {
  let lastMsgAt = 0;

  socket.on("join", (character, ack) => {
    if (players.has(socket.id)) return;
    if (players.size >= MAX_USERS) {
      ack?.({ ok: false, reason: "방이 가득 찼어요." });
      return;
    }
    const base = randomCharacter();
    const valid = character && ANIMALS.some(([e]) => e === character.emoji);
    const player = {
      id: socket.id,
      emoji: valid ? character.emoji : base.emoji,
      name: valid ? String(character.name).slice(0, 20) : base.name,
      color: valid && COLORS.includes(character.color) ? character.color : base.color,
      x: Math.round(ROOM_W * (0.2 + Math.random() * 0.6)),
      y: Math.round(ROOM_H * (0.3 + Math.random() * 0.4)),
    };
    players.set(socket.id, player);
    ack?.({ ok: true, me: player, players: [...players.values()], room: { w: ROOM_W, h: ROOM_H } });
    socket.broadcast.emit("player:join", player);
    io.emit("count", players.size);
  });

  socket.on("move", (pos) => {
    const p = players.get(socket.id);
    if (!p || !pos) return;
    p.x = clamp(Number(pos.x) || 0, 0, ROOM_W);
    p.y = clamp(Number(pos.y) || 0, 0, ROOM_H);
    socket.broadcast.emit("player:move", { id: p.id, x: p.x, y: p.y });
  });

  socket.on("say", (text) => {
    const p = players.get(socket.id);
    if (!p || typeof text !== "string") return;
    const now = Date.now();
    if (now - lastMsgAt < 400) return; // 도배 방지
    lastMsgAt = now;
    const msg = text.trim().slice(0, MAX_MSG_LEN);
    if (!msg) return;
    // 전달만 하고 끝. 저장/로그 없음.
    io.emit("player:say", { id: p.id, text: msg });
  });

  socket.on("disconnect", () => {
    if (players.delete(socket.id)) {
      io.emit("player:leave", socket.id);
      io.emit("count", players.size);
    }
  });
});

server.listen(PORT, () => {
  console.log(`WISP is drifting on http://localhost:${PORT}`);
});
