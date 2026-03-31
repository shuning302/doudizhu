import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import {
  SkillId,
  analyzePlay,
  applySkillPlusOne,
  applySkillStealBottom2,
  applyBid,
  applyDouble,
  canStart,
  comparePlays,
  giveBottomToLandlord,
  nextPlayerId,
  removeCardsFromHand,
  registerPlay,
  startBidding,
  startNewGame,
  finalizeRound,
} from "./game.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 5179;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

const app = express();
const server = http.createServer(app);
const allowOrigins = CORS_ORIGIN.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // allow same-origin/non-browser clients
      if (!origin) return cb(null, true);
      if (allowOrigins.length === 0) return cb(null, true);
      if (allowOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS_NOT_ALLOWED"), false);
    },
    credentials: true,
  },
});

const webDistDir = path.resolve(__dirname, "../../web");
app.use(express.static(webDistDir));

/**
 * Room model (MVP)
 * - 2 humans + 1 bot (bot is virtual, no socket)
 */
const rooms = new Map();

const TURN_TIMEOUT_MS = process.env.TURN_TIMEOUT_MS
  ? Number(process.env.TURN_TIMEOUT_MS)
  : 15000;

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      players: [
        { id: "bot", name: "机器人", isBot: true, connected: true },
      ],
      stage: "lobby", // lobby | playing | ended
      log: [],
      game: null,
      match: {
        history: [],
        totalsByPlayerId: {},
      },
      turnTimer: null,
    });
  }
  return rooms.get(roomId);
}

function publicRoom(room, viewerId) {
  const game = room.game;
  return {
    id: room.id,
    stage: room.stage,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      connected: p.connected,
    })),
    log: room.log.slice(-50),
    game: game
      ? {
          id: game.id,
          stage: game.stage,
          landlord: game.landlord,
          turn: game.turn,
          turnEndsAt: game.turnEndsAt || null,
          bottomCount: game.bottom.length,
          bottomGiven: game.bottomGiven,
          baseScore: game.baseScore,
          multiplier: game.multiplier,
          bidding: game.bidding
            ? {
                turn: game.bidding.turn,
                highestBid: game.bidding.highestBid,
                highestBidder: game.bidding.highestBidder,
                bids: game.bidding.bids,
              }
            : null,
          doubling: game.doubling
            ? {
                doubles: game.doubling.doubles,
              }
            : null,
          lastPlay: game.lastPlay
            ? {
                playerId: game.lastPlay.playerId,
                kind: game.lastPlay.kind,
                len: game.lastPlay.len,
                rank: game.lastPlay.rank ?? game.lastPlay.mainRank,
              }
            : null,
          winner: game.winner,
          me: viewerId
            ? {
                id: viewerId,
                hand: game.hands.get(viewerId) || [],
                skill: game.skills[viewerId] || null,
              }
            : null,
          skills: Object.fromEntries(
            Object.entries(game.skills).map(([pid, st]) => [
              pid,
              { skillId: st.skillId, used: st.used },
            ])
          ),
          score: game.score || null,
        }
      : null,
  };
}

function addLog(room, msg) {
  room.log.push({ t: Date.now(), msg });
  if (room.log.length > 500) room.log.shift();
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.game) room.game.turnEndsAt = null;
}

function scheduleTurn(room) {
  if (!room?.game) return;
  clearTurnTimer(room);
  const game = room.game;
  if (game.stage !== "playing") return;

  const botId = room.players.find((p) => p.isBot)?.id;
  if (game.turn === botId) return;
  if (!game.turn) return;

  const turnId = game.turn;
  game.turnEndsAt = Date.now() + TURN_TIMEOUT_MS;
  room.turnTimer = setTimeout(() => {
    if (!room.game) return;
    if (room.game.stage !== "playing") return;
    if (room.game.turn !== turnId) return;
    if (!room.game.lastPlay) autoPlaySmallestSingle(room, turnId);
    else autoPass(room, turnId);
  }, TURN_TIMEOUT_MS);
}

function autoPass(room, seatId) {
  const game = room.game;
  if (!game || game.stage !== "playing") return;
  if (game.turn !== seatId) return;
  if (!game.lastPlay) return;

  game.turn = nextPlayerId(game, seatId);
  game.passCountSinceLastPlay += 1;
  addLog(room, `托管：${nameOf(room, seatId)} 过`);

  if (game.passCountSinceLastPlay >= 2) {
    addLog(room, `本轮结束，由 ${nameOf(room, game.lastPlay.playerId)} 重新出牌`);
    game.turn = game.lastPlay.playerId;
    game.lastPlay = null;
    game.passCountSinceLastPlay = 0;
  }

  emitRoom(room.id);
  tryBotAct(room);
  scheduleTurn(room);
}

function autoPlaySmallestSingle(room, seatId) {
  const game = room.game;
  if (!game || game.stage !== "playing") return;
  if (game.turn !== seatId) return;

  const hand = game.hands.get(seatId) || [];
  if (hand.length === 0) return;

  const card = hand[0];
  const removed = removeCardsFromHand(hand, [card.id]);
  if (!removed.ok) return;
  const analysis = analyzePlay(removed.picked);
  if (!analysis.ok) {
    hand.push(...removed.picked);
    return;
  }

  registerPlay(game, seatId, analysis);
  game.lastPlay = {
    playerId: seatId,
    cards: removed.picked,
    kind: analysis.kind,
    mainRank: analysis.mainRank,
    seqLen: analysis.seqLen,
    wings: analysis.wings,
    len: analysis.len,
  };
  game.passCountSinceLastPlay = 0;
  addLog(room, `托管：${nameOf(room, seatId)} 出牌：${removed.picked.map((c) => c.label).join(" ")}`);

  if (hand.length === 0) {
    game.stage = "ended";
    game.winner = seatId;
    room.stage = "ended";
    addLog(room, `游戏结束：${nameOf(room, seatId)} 获胜`);
    const res = finalizeRound(game);
    if (res?.ok) {
      const score = res.score;
      for (const [pid, delta] of Object.entries(score.deltaByPlayer)) {
        room.match.totalsByPlayerId[pid] =
          (room.match.totalsByPlayerId[pid] || 0) + delta;
      }
      room.match.history.push({
        gameId: game.id,
        winnerId: score.winnerId,
        landlordId: score.landlordId,
        isSpring: score.isSpring,
        isAntiSpring: score.isAntiSpring,
        unit: score.unit,
        cappedExponent: score.cappedExponent,
        deltaByPlayer: score.deltaByPlayer,
        t: Date.now(),
      });
    }
    emitRoom(room.id);
    return;
  }

  game.turn = nextPlayerId(game, seatId);
  emitRoom(room.id);
  tryBotAct(room);
  scheduleTurn(room);
}

function emitRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const socket of io.in(roomId).sockets.values()) {
    const viewerSeatId = socket.data.seatId || socket.id;
    socket.emit("room:update", publicRoom(room, viewerSeatId));
  }
}

function maybeStartGame(room) {
  const players = room.players;
  if (players.filter((p) => !p.isBot).length !== 2) return;
  if (players.length !== 3) return;
  room.game = startNewGame({
    players: players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot })),
  });
  room.stage = "playing";
  // Bot auto-picks a skill so humans don't get stuck
  const bot = players.find((p) => p.isBot);
  if (bot && room.game.skills[bot.id]) {
    room.game.skills[bot.id].skillId = SkillId.PLUS_ONE;
  }
  addLog(room, `新一局开始：请每位玩家选择 1 个技能（每局限用 1 次）`);
}

function nameOf(room, pid) {
  return room.players.find((p) => p.id === pid)?.name || pid;
}

function tryBotAct(room) {
  const game = room.game;
  if (!game) return;
  const botId = room.players.find((p) => p.isBot)?.id;
  if (!botId) return;
  if (game.stage === "bidding" && game.bidding.turn === botId) {
    // Simple bid: if no one bid yet, bid 1; else pass
    const canBid1 = game.bidding.highestBid === 0;
    const score = canBid1 ? 1 : 0;
    const r = applyBid(game, botId, score);
    addLog(room, `机器人 叫分：${score}`);
    if (r.ok && r.done) {
      if (game.stage === "ended" && !game.landlord) {
        addLog(room, `无人叫分，本局作废（后续会自动重开）`);
      } else {
        addLog(room, `叫分结束：地主为 ${nameOf(room, game.landlord)}，底分 ${game.baseScore}`);
        addLog(room, `进入加倍阶段`);
      }
    }
    emitRoom(room.id);
    setTimeout(() => tryBotAct(room), 400);
    return;
  }

  if (game.stage === "doubling") {
    // Bot never doubles
    const r = applyDouble(game, botId, false);
    addLog(room, `机器人 加倍：不加倍`);
    if (r.ok && r.done) {
      addLog(room, `加倍结束，进入发底牌阶段`);
      // if bot is landlord, auto-take bottom after a short delay
      if (room.players.find((p) => p.id === game.landlord)?.isBot) {
        setTimeout(() => {
          if (!room.game) return;
          if (room.game.stage !== "bottom") return;
          giveBottomToLandlord(room.game);
          addLog(room, `地主 机器人 获得底牌，开始出牌`);
          emitRoom(room.id);
          tryBotAct(room);
        }, 1200);
      }
    }
    emitRoom(room.id);
    setTimeout(() => tryBotAct(room), 400);
    return;
  }

  if (game.stage !== "playing") return;
  if (game.turn !== botId) return;

  // Bot: choose the smallest legal move that beats `game.lastPlay`.
  // Strategy:
  // - Prefer using the same pattern type as `prev`
  // - If none exists, try bomb/rocket
  const hand = game.hands.get(botId) || [];
  if (hand.length === 0) return;
  let candidate = null; // cards[]

  const byRank = new Map();
  for (const c of hand) {
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  for (const [r, arr] of byRank) {
    arr.sort((a, b) => a.suit.localeCompare(b.suit));
  }
  const ranksAsc = [...byRank.keys()].sort((a, b) => a - b);
  const pickSmallestFromRank = (rank, n) => {
    const arr = byRank.get(rank) || [];
    return arr.slice(0, n);
  };

  const hasRocket = byRank.has(16) && (byRank.get(16) || []).length >= 1 && byRank.has(17) && (byRank.get(17) || []).length >= 1;
  const rocketCards = hasRocket ? [byRank.get(16)[0], byRank.get(17)[0]] : null;

  const findSmallestBomb = (minRankExclusive = -1) => {
    for (const r of ranksAsc) {
      if (r <= minRankExclusive) continue;
      if ((byRank.get(r) || []).length >= 4) {
        return pickSmallestFromRank(r, 4);
      }
    }
    return null;
  };

  if (!game.lastPlay) {
    // Open with smallest single.
    candidate = [hand[0]];
  } else {
    const prev = game.lastPlay;

    const trySameKind = () => {
      const kind = prev.kind;
      const seqLen = prev.seqLen;
      const wings = prev.wings;

      if (kind === "single") {
        for (const c of hand) {
          if (c.rank > prev.mainRank) return [c];
        }
        return null;
      }

      if (kind === "pair") {
        for (const r of ranksAsc) {
          if (r <= prev.mainRank) continue;
          if ((byRank.get(r) || []).length >= 2) return pickSmallestFromRank(r, 2);
        }
        return null;
      }

      if (kind === "triple") {
        for (const r of ranksAsc) {
          if (r <= prev.mainRank) continue;
          if ((byRank.get(r) || []).length >= 3) return pickSmallestFromRank(r, 3);
        }
        return null;
      }

      if (kind === "triple1") {
        // mainRank = tripleRank, len=4
        for (const r of ranksAsc) {
          if (r <= prev.mainRank) continue;
          if ((byRank.get(r) || []).length < 3) continue;
          const triple = pickSmallestFromRank(r, 3);
          const kicker = hand.find((c) => c.rank !== r);
          if (!kicker) continue;
          return [...triple, kicker];
        }
        return null;
      }

      if (kind === "triple2") {
        // mainRank = tripleRank, len=5
        for (const r of ranksAsc) {
          if (r <= prev.mainRank) continue;
          if ((byRank.get(r) || []).length < 3) continue;
          const triple = pickSmallestFromRank(r, 3);
          // smallest pair not equal triple rank
          for (const pr of ranksAsc) {
            if (pr === r) continue;
            if ((byRank.get(pr) || []).length >= 2) {
              const pair = pickSmallestFromRank(pr, 2);
              return [...triple, ...pair];
            }
          }
        }
        return null;
      }

      if (kind === "straight") {
        // seqLen = number of ranks in straight
        const n = seqLen || 0;
        if (n < 5) return null;
        for (let high = prev.mainRank + 1; high <= 14; high++) {
          const start = high - n + 1;
          if (start < 3) continue;
          const cards = [];
          let ok = true;
          for (let rr = start; rr <= high; rr++) {
            const arr = byRank.get(rr) || [];
            if (arr.length < 1) {
              ok = false;
              break;
            }
            cards.push(arr[0]);
          }
          if (ok) return cards;
        }
        return null;
      }

      if (kind === "doubleStraight") {
        const n = seqLen || 0; // number of pairs
        if (n < 3) return null;
        for (let high = prev.mainRank + 1; high <= 14; high++) {
          const start = high - n + 1;
          if (start < 3) continue;
          const cards = [];
          let ok = true;
          for (let rr = start; rr <= high; rr++) {
            const arr = byRank.get(rr) || [];
            if (arr.length < 2) {
              ok = false;
              break;
            }
            cards.push(arr[0], arr[1]);
          }
          if (ok) return cards;
        }
        return null;
      }

      if (kind === "airplane") {
        const n = seqLen || 0; // number of consecutive triples
        if (n < 2) return null;
        for (let high = prev.mainRank + 1; high <= 14; high++) {
          const start = high - n + 1;
          if (start < 3) continue;

          const triples = [];
          let ok = true;
          for (let rr = start; rr <= high; rr++) {
            const arr = byRank.get(rr) || [];
            if (arr.length < 3) {
              ok = false;
              break;
            }
            triples.push(arr[0], arr[1], arr[2]);
          }
          if (!ok) continue;

          const usedIds = new Set(triples.map((c) => c.id));
          const restCards = hand.filter((c) => !usedIds.has(c.id));

          if (wings === "none") return triples;

          if (wings === "single") {
            if (restCards.length < n) continue;
            // smallest n singles from rest
            return [...triples, ...restCards.slice(0, n)];
          }

          if (wings === "pair") {
            const pairRanks = ranksAsc
              .filter((r) => r < start || r > high || (byRank.get(r) || []).length >= 2)
              .filter((r) => r !== start && r !== high); // just to reduce; will re-check below
            const candidates = [];
            for (const r of ranksAsc) {
              if ((byRank.get(r) || []).length < 2) continue;
              // don't allow using triple ranks for wings if their remaining count is insufficient
              const inTriple = r >= start && r <= high;
              // remove cards used by triples for this rank
              const usedInTriple = inTriple ? 3 : 0;
              const remain = (byRank.get(r) || []).length - usedInTriple;
              if (remain < 2) continue;
              const arr = byRank.get(r);
              // pick first two remaining (approx)
              candidates.push(...arr.slice(usedInTriple, usedInTriple + 2));
            }
            if (candidates.length < n * 2) continue;
            return [...triples, ...candidates.slice(0, n * 2)];
          }
        }
        return null;
      }

      if (kind === "four2") {
        // quadRank > prev.mainRank
        for (const r of ranksAsc) {
          if (r <= prev.mainRank) continue;
          if ((byRank.get(r) || []).length < 4) continue;
          const quad = pickSmallestFromRank(r, 4);
          const rest = hand.filter((c) => c.rank !== r);
          if (rest.length < 2) continue;
          return [...quad, rest[0], rest[1]];
        }
        return null;
      }

      if (kind === "four2pair") {
        for (const r of ranksAsc) {
          if (r <= prev.mainRank) continue;
          if ((byRank.get(r) || []).length < 4) continue;
          const quad = pickSmallestFromRank(r, 4);
          const restPairs = [];
          for (const pr of ranksAsc) {
            if (pr === r) continue;
            if ((byRank.get(pr) || []).length >= 2) restPairs.push(pr);
          }
          if (restPairs.length < 2) continue;
          const pair1 = pickSmallestFromRank(restPairs[0], 2);
          const pair2 = pickSmallestFromRank(restPairs[1], 2);
          return [...quad, ...pair1, ...pair2];
        }
        return null;
      }

      return null;
    };

    candidate = trySameKind();

    if (!candidate && prev.kind !== "bomb" && prev.kind !== "rocket") {
      // try bomb (any bomb beats non-bomb)
      candidate = findSmallestBomb(-1);
    }
    if (!candidate && prev.kind === "bomb") {
      candidate = findSmallestBomb(prev.mainRank);
      if (!candidate) candidate = rocketCards;
    }
    if (!candidate && prev.kind !== "rocket") {
      // rocket always beats
      candidate = rocketCards;
    }

    // Final legality check using analyzePlay + comparePlays
    if (candidate) {
      const removedAnalysis = analyzePlay(candidate);
      if (!removedAnalysis.ok) candidate = null;
      else {
        const next = {
          kind: removedAnalysis.kind,
          mainRank: removedAnalysis.mainRank,
          seqLen: removedAnalysis.seqLen,
          wings: removedAnalysis.wings,
          len: removedAnalysis.len,
        };
        if (!comparePlays(prev, next)) candidate = null;
      }
    }
  }

  if (!candidate) {
    game.turn = nextPlayerId(game, botId);
    game.passCountSinceLastPlay += 1;
    addLog(room, `机器人 过`);
    // reset trick if everyone else passed
    if (game.lastPlay && game.passCountSinceLastPlay >= 2) {
      addLog(room, `本轮结束，由 ${nameOf(room, game.lastPlay.playerId)} 重新出牌`);
      game.turn = game.lastPlay.playerId;
      game.lastPlay = null;
      game.passCountSinceLastPlay = 0;
    }
    emitRoom(room.id);
    scheduleTurn(room);
    setTimeout(() => tryBotAct(room), 250);
    return;
  }

  const ids = candidate.map((c) => c.id);
  const removed = removeCardsFromHand(hand, ids);
  if (!removed.ok) return;
  const analysis = analyzePlay(removed.picked);
  if (!analysis.ok) return;
  game.lastPlay = {
    playerId: botId,
    cards: removed.picked,
    kind: analysis.kind,
    mainRank: analysis.mainRank,
    seqLen: analysis.seqLen,
    wings: analysis.wings,
    len: analysis.len,
  };
  game.passCountSinceLastPlay = 0;
  addLog(room, `机器人 出牌：${removed.picked.map((c) => c.label).join(" ")}`);
  registerPlay(game, botId, analysis);
  if (hand.length === 0) {
    game.stage = "ended";
    game.winner = botId;
    room.stage = "ended";
    addLog(room, `游戏结束：机器人 获胜`);
    clearTurnTimer(room);
    const res = finalizeRound(game);
    if (res?.ok) {
      const score = res.score;
      for (const [pid, delta] of Object.entries(score.deltaByPlayer)) {
        room.match.totalsByPlayerId[pid] =
          (room.match.totalsByPlayerId[pid] || 0) + delta;
      }
      room.match.history.push({
        gameId: game.id,
        winnerId: score.winnerId,
        landlordId: score.landlordId,
        isSpring: score.isSpring,
        isAntiSpring: score.isAntiSpring,
        unit: score.unit,
        cappedExponent: score.cappedExponent,
        deltaByPlayer: score.deltaByPlayer,
        t: Date.now(),
      });
    }
  } else {
    game.turn = nextPlayerId(game, botId);
  }
  emitRoom(room.id);
  scheduleTurn(room);
  setTimeout(() => tryBotAct(room), 250);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name } = {}, cb) => {
    const roomId = nanoid(6).toUpperCase();
    const room = getOrCreateRoom(roomId);
    const seatId = nanoid(10);
    const player = {
      id: seatId,
      name: (name && String(name).slice(0, 12)) || "玩家",
      isBot: false,
      connected: true,
    };
    room.players.push(player);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.seatId = player.id;
    socket.data.playerId = player.id;
    addLog(room, `${player.name} 创建并加入房间`);
    emitRoom(roomId);
    cb?.({ roomId, token: seatId });
  });

  socket.on("room:join", ({ roomId, name, token } = {}, cb) => {
    const id = String(roomId || "").toUpperCase().trim();
    if (!id) return cb?.({ ok: false, error: "ROOM_ID_REQUIRED" });
    const room = getOrCreateRoom(id);

    const humans = room.players.filter((p) => !p.isBot);
    const requestedToken = token ? String(token) : "";
    const existing = requestedToken
      ? room.players.find((p) => !p.isBot && p.id === requestedToken)
      : null;

    if (existing) {
      existing.name = (name && String(name).slice(0, 12)) || existing.name;
      existing.connected = true;
      socket.join(id);
      socket.data.roomId = id;
      socket.data.seatId = existing.id;
      socket.data.playerId = existing.id;
      addLog(room, `${existing.name} 重连房间`);
      emitRoom(id);
      tryBotAct(room);
      cb?.({ ok: true, roomId: id, token: existing.id });
      return;
    }

    if (humans.length >= 2) return cb?.({ ok: false, error: "ROOM_FULL" });

    const seatId = nanoid(10);
    const player = {
      id: seatId,
      name: (name && String(name).slice(0, 12)) || "玩家",
      isBot: false,
      connected: true,
    };
    room.players.push(player);
    socket.join(id);
    socket.data.roomId = id;
    socket.data.seatId = seatId;
    socket.data.playerId = player.id;
    addLog(room, `${player.name} 加入房间`);
    maybeStartGame(room);
    emitRoom(id);
    tryBotAct(room);
    cb?.({ ok: true, roomId: id, token: seatId });
  });

  socket.on("room:leave", (_ = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: true });
    const room = rooms.get(roomId);
    if (room) {
      const seatId = socket.data.seatId;
      if (seatId) {
        const p = room.players.find((x) => x.id === seatId);
        if (p) {
          p.connected = false;
          addLog(room, `${p.name} 离开房间`);
        }
      }
      emitRoom(roomId);
    }
    socket.leave(roomId);
    socket.data.roomId = undefined;
    socket.data.seatId = undefined;
    cb?.({ ok: true });
  });

  socket.on("chat:send", ({ text } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.data.seatId);
    if (!player) return;
    const msg = String(text || "").trim().slice(0, 200);
    if (!msg) return;
    addLog(room, `${player.name}: ${msg}`);
    emitRoom(roomId);
  });

  socket.on("game:skillSelect", ({ skillId } = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: false, error: "NO_ROOM" });
    const room = rooms.get(roomId);
    if (!room?.game) return cb?.({ ok: false, error: "NO_GAME" });
    const game = room.game;
    if (game.stage !== "choose_skill") return cb?.({ ok: false, error: "BAD_STAGE" });
    const seatId = socket.data.seatId;
    const st = game.skills[seatId];
    if (!st) return cb?.({ ok: false, error: "NOT_IN_GAME" });
    if (![SkillId.PLUS_ONE, SkillId.STEAL_BOTTOM_2].includes(skillId)) {
      return cb?.({ ok: false, error: "BAD_SKILL" });
    }
    st.skillId = skillId;
    addLog(room, `${nameOf(room, seatId)} 选择技能：${skillId === SkillId.PLUS_ONE ? "点数+1" : "底牌抽2"}`);
    if (startBidding(game)) {
      addLog(room, `技能选择完成，开始叫分（0/1/2/3）`);
    }
    emitRoom(roomId);
    tryBotAct(room);
    cb?.({ ok: true });
  });

  socket.on("game:giveBottom", (_ = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: false, error: "NO_ROOM" });
    const room = rooms.get(roomId);
    if (!room?.game) return cb?.({ ok: false, error: "NO_GAME" });
    const game = room.game;
    if (game.stage !== "bottom") return cb?.({ ok: false, error: "BAD_STAGE" });
    const seatId = socket.data.seatId;
    if (seatId !== game.landlord) return cb?.({ ok: false, error: "NOT_LANDLORD" });
    giveBottomToLandlord(game);
    addLog(room, `地主 ${nameOf(room, game.landlord)} 获得底牌，开始出牌`);
    emitRoom(roomId);
    tryBotAct(room);
    scheduleTurn(room);
    cb?.({ ok: true });
  });

  socket.on("game:skillUse", ({ kind, cardId } = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: false, error: "NO_ROOM" });
    const room = rooms.get(roomId);
    if (!room?.game) return cb?.({ ok: false, error: "NO_GAME" });
    const game = room.game;
    const seatId = socket.data.seatId;
    if (!game.skills[seatId]) return cb?.({ ok: false, error: "NOT_IN_GAME" });

    if (kind === SkillId.PLUS_ONE) {
      if (game.stage !== "playing") return cb?.({ ok: false, error: "BAD_STAGE" });
      if (game.turn !== seatId) return cb?.({ ok: false, error: "NOT_YOUR_TURN" });
      const r = applySkillPlusOne(game, seatId, String(cardId || ""));
      if (!r.ok) return cb?.(r);
      addLog(room, `${nameOf(room, seatId)} 使用技能：点数+1`);
      emitRoom(roomId);
      cb?.({ ok: true });
      return;
    }
    if (kind === SkillId.STEAL_BOTTOM_2) {
      if (game.stage !== "bottom") return cb?.({ ok: false, error: "BAD_STAGE" });
      const r = applySkillStealBottom2(game, seatId);
      if (!r.ok) return cb?.(r);
      addLog(room, `${nameOf(room, seatId)} 从底牌抽走两张`);
      emitRoom(roomId);
      cb?.({ ok: true });
      return;
    }
    cb?.({ ok: false, error: "UNKNOWN_SKILL" });
  });

  socket.on("game:bid", ({ score } = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: false, error: "NO_ROOM" });
    const room = rooms.get(roomId);
    if (!room?.game) return cb?.({ ok: false, error: "NO_GAME" });
    const game = room.game;
    const seatId = socket.data.seatId;
    const r = applyBid(game, seatId, score);
    if (!r.ok) return cb?.(r);
    addLog(room, `${nameOf(room, seatId)} 叫分：${Number(score)}`);
    if (r.done) {
      if (!game.landlord) {
        addLog(room, `无人叫分，本局作废（后续会自动重开）`);
      } else {
        addLog(room, `叫分结束：地主为 ${nameOf(room, game.landlord)}，底分 ${game.baseScore}`);
        addLog(room, `进入加倍阶段`);
      }
    }
    emitRoom(roomId);
    tryBotAct(room);
    cb?.({ ok: true });
  });

  socket.on("game:double", ({ on } = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: false, error: "NO_ROOM" });
    const room = rooms.get(roomId);
    if (!room?.game) return cb?.({ ok: false, error: "NO_GAME" });
    const game = room.game;
    const seatId = socket.data.seatId;
    const r = applyDouble(game, seatId, !!on);
    if (!r.ok) return cb?.(r);
    addLog(room, `${nameOf(room, seatId)} 加倍：${on ? "加倍" : "不加倍"}`);
    if (r.done) {
      addLog(room, `加倍结束，进入发底牌阶段`);
    }
    emitRoom(roomId);
    tryBotAct(room);
    cb?.({ ok: true });
  });

  socket.on("game:play", ({ cardIds } = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: false, error: "NO_ROOM" });
    const room = rooms.get(roomId);
    if (!room?.game) return cb?.({ ok: false, error: "NO_GAME" });
    const game = room.game;
    if (game.stage !== "playing") return cb?.({ ok: false, error: "BAD_STAGE" });
    const seatId = socket.data.seatId;
    if (game.turn !== seatId) return cb?.({ ok: false, error: "NOT_YOUR_TURN" });

    const ids = Array.isArray(cardIds) ? cardIds.map(String) : [];
    const hand = game.hands.get(seatId) || [];
    const removed = removeCardsFromHand(hand, ids);
    if (!removed.ok) return cb?.({ ok: false, error: "BAD_CARDS" });
    const analysis = analyzePlay(removed.picked);
    if (!analysis.ok) {
      // restore
      hand.push(...removed.picked);
      hand.sort((a, b) => a.rank - b.rank);
      return cb?.({ ok: false, error: analysis.error });
    }
    const prev = game.lastPlay;
    const next = {
      kind: analysis.kind,
      mainRank: analysis.mainRank,
      seqLen: analysis.seqLen,
      wings: analysis.wings,
      len: analysis.len,
    };
    if (!comparePlays(prev, next)) {
      hand.push(...removed.picked);
      hand.sort((a, b) => a.rank - b.rank);
      return cb?.({ ok: false, error: "NOT_BEAT" });
    }

    registerPlay(game, seatId, analysis);
    game.lastPlay = {
      playerId: seatId,
      cards: removed.picked,
      kind: analysis.kind,
      mainRank: analysis.mainRank,
      seqLen: analysis.seqLen,
      wings: analysis.wings,
      len: analysis.len,
    };
    game.passCountSinceLastPlay = 0;
    addLog(room, `${nameOf(room, seatId)} 出牌：${removed.picked.map((c) => c.label).join(" ")}`);

    if (hand.length === 0) {
      game.stage = "ended";
      game.winner = seatId;
      room.stage = "ended";
      addLog(room, `游戏结束：${nameOf(room, seatId)} 获胜`);
      clearTurnTimer(room);
      const res = finalizeRound(game);
      if (res?.ok) {
        const score = res.score;
        for (const [pid, delta] of Object.entries(score.deltaByPlayer)) {
          room.match.totalsByPlayerId[pid] =
            (room.match.totalsByPlayerId[pid] || 0) + delta;
        }
        room.match.history.push({
          gameId: game.id,
          winnerId: score.winnerId,
          landlordId: score.landlordId,
          isSpring: score.isSpring,
          isAntiSpring: score.isAntiSpring,
          unit: score.unit,
          cappedExponent: score.cappedExponent,
          deltaByPlayer: score.deltaByPlayer,
          t: Date.now(),
        });
      }
      emitRoom(roomId);
      cb?.({ ok: true });
      return;
    }

    game.turn = nextPlayerId(game, seatId);
    emitRoom(roomId);
    tryBotAct(room);
    scheduleTurn(room);
    cb?.({ ok: true });
  });

  socket.on("game:pass", (_ = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb?.({ ok: false, error: "NO_ROOM" });
    const room = rooms.get(roomId);
    if (!room?.game) return cb?.({ ok: false, error: "NO_GAME" });
    const game = room.game;
    if (game.stage !== "playing") return cb?.({ ok: false, error: "BAD_STAGE" });
    const seatId = socket.data.seatId;
    if (game.turn !== seatId) return cb?.({ ok: false, error: "NOT_YOUR_TURN" });
    if (!game.lastPlay) return cb?.({ ok: false, error: "CANNOT_PASS_FIRST" });

    game.turn = nextPlayerId(game, seatId);
    game.passCountSinceLastPlay += 1;
    addLog(room, `${nameOf(room, seatId)} 过`);

    if (game.passCountSinceLastPlay >= 2) {
      addLog(room, `本轮结束，由 ${nameOf(room, game.lastPlay.playerId)} 重新出牌`);
      game.turn = game.lastPlay.playerId;
      game.lastPlay = null;
      game.passCountSinceLastPlay = 0;
    }
    emitRoom(roomId);
    tryBotAct(room);
    scheduleTurn(room);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const seatId = socket.data.seatId;
    const p = room.players.find((x) => x.id === seatId);
    if (!p) return;
    p.connected = false;
    addLog(room, `${p.name} 断线`);
    emitRoom(roomId);
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});

