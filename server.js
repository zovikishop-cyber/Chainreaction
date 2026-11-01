const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));
app.get("/ice", (q, res) => {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL)
    list.push({ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  res.json(list);
});
const srv = http.createServer(app);
const io = new Server(srv);

const SIZES = { Small: [5, 9], Classic: [6, 12], Large: [7, 14] };
const rooms = new Map();

/* ---------- helpers ---------- */
function newCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c;
  do {
    c = Array.from({ length: 4 }, () => a[Math.floor(Math.random() * a.length)]).join("");
  } while (rooms.has(c));
  return c;
}
function nb(r, i) {
  const { cols, rows } = r, x = i % cols, y = (i / cols) | 0, a = [];
  if (x > 0) a.push(i - 1);
  if (x < cols - 1) a.push(i + 1);
  if (y > 0) a.push(i - cols);
  if (y < rows - 1) a.push(i + cols);
  return a;
}
function initGame(r) {
  r.max = r.players.length;
  r.cells = Array.from({ length: r.cols * r.rows }, () => ({ o: -1, c: 0 }));
  r.turn = 0;
  r.moved = Array(r.max).fill(false);
  r.alive = Array(r.max).fill(true);
  r.over = false;
  r.winner = null;
  r.started = true;
}
function pub(r) {
  return {
    code: r.code, max: r.max, cols: r.cols, rows: r.rows,
    players: r.players.map((p) => ({ id: p.id, connected: p.connected, voice: !!p.voice })),
    started: r.started, cells: r.cells, turn: r.turn, alive: r.alive,
    over: r.over, winner: r.winner,
  };
}
function check(r) {
  const own = new Set(r.cells.filter((c) => c.o >= 0).map((c) => c.o));
  r.players.forEach((_, p) => { if (r.moved[p] && !own.has(p)) r.alive[p] = false; });
  const al = r.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
  if (r.moved.every(Boolean) && al.length === 1) { r.over = true; r.winner = al[0]; }
}
function nextTurn(r) {
  do { r.turn = (r.turn + 1) % r.players.length; } while (!r.alive[r.turn]);
}
function resolve(r, i, p) {
  const c = r.cells[i];
  c.o = p; c.c++; r.moved[p] = true;
  const waves = [];
  for (let g = 0; g < 1000; g++) {
    const hot = [];
    r.cells.forEach((cl, k) => { if (cl.c >= nb(r, k).length) hot.push(k); });
    if (!hot.length) break;
    const w = [];
    hot.forEach((k) => {
      const cl = r.cells[k], ns = nb(r, k), own = cl.o;
      cl.c -= ns.length;
      if (cl.c <= 0) { cl.c = 0; cl.o = -1; }
      ns.forEach((n) => w.push({ from: k, to: n, own }));
    });
    w.forEach((x) => { const t = r.cells[x.to]; t.c++; t.o = x.own; });
    waves.push(w);
    const own = new Set(r.cells.filter((c) => c.o >= 0).map((c) => c.o));
    if (r.moved.every(Boolean) && own.size === 1) break;
  }
  check(r);
  if (!r.over) nextTurn(r);
  return waves;
}
function eliminate(r, p) {
  r.cells.forEach((c) => { if (c.o === p) { c.o = -1; c.c = 0; } });
  r.alive[p] = false;
  r.moved[p] = true;
  check(r);
  if (!r.over && r.turn === p) nextTurn(r);
}

/* ---------- sockets ---------- */
io.on("connection", (socket) => {
  const roomOf = () => rooms.get(socket.data.code);
  const attach = (r, idx) => {
    socket.data.code = r.code;
    socket.data.idx = idx;
    socket.join(r.code);
    r.players[idx].sid = socket.id;
    r.players[idx].connected = true;
    r.touched = Date.now();
    socket.emit("joined", { you: idx, id: r.players[idx].id, token: r.players[idx].token, state: pub(r) });
    io.to(r.code).emit("presence", pub(r).players);
  };
  const token = () => Math.random().toString(36).slice(2);

  socket.on("create", ({ n, size }) => {
    const [cols, rows] = SIZES[size] || SIZES.Classic;
    const r = {
      code: newCode(), max: Math.min(8, Math.max(2, n | 0)), cols, rows,
      players: [{ token: token(), id: token().slice(0, 6), connected: true }],
      started: false, cells: [], turn: 0, moved: [], alive: [], over: false, winner: null,
      touched: Date.now(),
    };
    rooms.set(r.code, r);
    attach(r, 0);
  });

  socket.on("join", (code) => {
    const r = rooms.get(String(code || "").toUpperCase());
    if (!r) return socket.emit("err", "No room with that code.");
    if (r.started) return socket.emit("err", "That game has already started.");
    if (r.players.length >= r.max) return socket.emit("err", "That room is full.");
    r.players.push({ token: token(), id: token().slice(0, 6), connected: true });
    attach(r, r.players.length - 1);
  });

  socket.on("rejoin", ({ code, token: t }) => {
    const r = rooms.get(code);
    const idx = r ? r.players.findIndex((p) => p.token === t) : -1;
    if (idx < 0) return socket.emit("err", "Session expired.", true);
    attach(r, idx);
  });

  socket.on("start", () => {
    const r = roomOf();
    if (!r || socket.data.idx !== 0 || r.started || r.players.length < 2) return;
    initGame(r);
    io.to(r.code).emit("state", pub(r));
  });

  socket.on("rematch", () => {
    const r = roomOf();
    if (!r || socket.data.idx !== 0 || !r.over) return;
    initGame(r);
    io.to(r.code).emit("state", pub(r));
  });

  socket.on("move", (i) => {
    const r = roomOf();
    if (!r || !r.started || r.over || socket.data.idx !== r.turn) return;
    const c = r.cells[i];
    if (!c || (c.o !== -1 && c.o !== socket.data.idx)) return;
    r.touched = Date.now();
    const p = socket.data.idx;
    const waves = resolve(r, i, p);
    io.to(r.code).emit("move", { i, p, waves, cells: r.cells, turn: r.turn, alive: r.alive, winner: r.winner });
  });

  /* ---- voice: WebRTC signalling relay ---- */
  socket.on("voice-join", () => {
    const r = roomOf();
    const me = r && r.players[socket.data.idx];
    if (!me) return;
    socket.emit("voice-peers", r.players.filter((p) => p.voice && p.id !== me.id && p.connected).map((p) => p.id));
    me.voice = true;
    io.to(r.code).emit("presence", pub(r).players);
  });
  socket.on("voice-leave", () => {
    const r = roomOf();
    const me = r && r.players[socket.data.idx];
    if (!me) return;
    me.voice = false;
    io.to(r.code).emit("presence", pub(r).players);
  });
  socket.on("signal", ({ to, data }) => {
    const r = roomOf();
    const from = r && r.players[socket.data.idx];
    const t = r && r.players.find((p) => p.id === to);
    if (from && t && t.sid && t.connected) io.to(t.sid).emit("signal", { from: from.id, data });
  });

  socket.on("leave", () => {
    const r = roomOf();
    if (!r) return;
    const idx = socket.data.idx;
    if (r.players[idx]) r.players[idx].voice = false;
    socket.leave(r.code);
    socket.data.code = null;
    if (!r.started) {
      if (idx === 0) {
        io.to(r.code).emit("closed");
        rooms.delete(r.code);
      } else {
        r.players.splice(idx, 1);
        r.players.forEach((p, k) => { if (p.sid) io.to(p.sid).emit("you", k); });
        io.to(r.code).emit("presence", pub(r).players);
      }
    } else {
      r.players[idx].connected = false;
      if (!r.over) { eliminate(r, idx); io.to(r.code).emit("state", pub(r)); }
      else io.to(r.code).emit("presence", pub(r).players);
    }
  });

  socket.on("disconnect", () => {
    const r = roomOf();
    if (!r || !r.players[socket.data.idx]) return;
    r.players[socket.data.idx].connected = false;
    r.players[socket.data.idx].voice = false;
    io.to(r.code).emit("presence", pub(r).players);
  });
});

setInterval(() => {
  const cutoff = Date.now() - 3 * 3600 * 1000;
  for (const [c, r] of rooms) if (r.touched < cutoff) rooms.delete(c);
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log("Chain Reaction on :" + PORT));
