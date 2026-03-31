const SUITS = ["♠", "♥", "♣", "♦"];

export const SkillId = /** @type {const} */ ({
  PLUS_ONE: "plus_one",
  STEAL_BOTTOM_2: "steal_bottom_2",
});

export function createDeck() {
  /** @type {{id:string, rank:number, suit:string, label:string}[]} */
  const cards = [];
  for (const suit of SUITS) {
    for (let rank = 3; rank <= 15; rank++) {
      cards.push({
        id: `${suit}-${rank}-${Math.random().toString(16).slice(2, 8)}`,
        rank,
        suit,
        label: `${suit}${rankToLabel(rank)}`,
      });
    }
  }
  cards.push({
    id: `JOKER-S-${Math.random().toString(16).slice(2, 8)}`,
    rank: 16,
    suit: "🃏",
    label: "小王",
  });
  cards.push({
    id: `JOKER-B-${Math.random().toString(16).slice(2, 8)}`,
    rank: 17,
    suit: "🃏",
    label: "大王",
  });
  return cards;
}

export function rankToLabel(rank) {
  if (rank <= 10) return String(rank);
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  if (rank === 14) return "A";
  if (rank === 15) return "2";
  if (rank === 16) return "小王";
  if (rank === 17) return "大王";
  return String(rank);
}

export function shuffleInPlace(arr, rnd = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function startNewGame({ players, rnd = Math.random }) {
  // players: [{id,name,isBot}]
  const deck = createDeck();
  shuffleInPlace(deck, rnd);
  const hands = new Map();
  for (const p of players) hands.set(p.id, []);

  // deal 17 each, keep last 3 as bottom
  for (let i = 0; i < 51; i++) {
    const p = players[i % 3];
    hands.get(p.id).push(deck[i]);
  }
  const bottom = deck.slice(51);

  for (const [pid, h] of hands) sortHand(h);

  const biddingTurn = players[Math.floor(rnd() * players.length)].id;

  /** @type {Record<string, {skillId: string|null, used: boolean}>} */
  const skills = {};
  for (const p of players) skills[p.id] = { skillId: null, used: false };

  /** @type {Record<string, number>} */
  const bids = {};
  for (const p of players) bids[p.id] = -1; // -1 means not acted yet

  /** @type {Record<string, boolean>} */
  const doubles = {};
  for (const p of players) doubles[p.id] = false;

  return {
    id: nanoGameId(),
    stage: "choose_skill", // choose_skill -> bidding -> doubling -> bottom -> playing -> ended
    players: players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot })),
    landlord: null,
    bottom,
    bottomGiven: false,
    hands,
    skills,
    bidding: {
      turn: biddingTurn,
      bids,
      highestBid: 0,
      highestBidder: null,
      acted: 0,
    },
    doubling: {
      doubles,
      acted: 0,
    },
    baseScore: 1,
    multiplier: 1,
    turn: null,
    lastPlay: null, // {playerId, cards, kind, rank, len}
    passCountSinceLastPlay: 0,
    winner: null,
    stats: {
      // "hands played" count (not passes)
      playedCountByPlayer: Object.fromEntries(players.map((p) => [p.id, 0])),
      // bomb/rocket events used for doubling
      bombEventCount: 0,
      // for debugging / UI
      bombs: 0,
      rockets: 0,
    },
    // number of players who chose to double in the doubling stage (each true = +1 exponent)
    doublingCount: 0,
  };
}

function nanoGameId() {
  return Math.random().toString(16).slice(2, 10).toUpperCase();
}

export function sortHand(hand) {
  hand.sort((a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit));
}

export function giveBottomToLandlord(game) {
  if (!game.landlord) return;
  if (game.bottomGiven) return;
  const hand = game.hands.get(game.landlord);
  hand.push(...game.bottom);
  game.bottom = [];
  sortHand(hand);
  game.bottomGiven = true;
  if (game.stage === "bottom") {
    game.stage = "playing";
    game.turn = game.landlord;
  }
}

export function canStart(game) {
  // all players picked a skill
  return game.players.every((p) => game.skills[p.id]?.skillId);
}

export function startBidding(game) {
  if (game.stage !== "choose_skill") return false;
  if (!canStart(game)) return false;
  game.stage = "bidding";
  return true;
}

export function applyBid(game, playerId, score) {
  if (game.stage !== "bidding") return { ok: false, error: "BAD_STAGE" };
  if (game.bidding.turn !== playerId) return { ok: false, error: "NOT_YOUR_TURN" };
  const s = Number(score);
  if (![0, 1, 2, 3].includes(s)) return { ok: false, error: "BAD_BID" };
  if (game.bidding.bids[playerId] !== -1) return { ok: false, error: "ALREADY_BID" };

  // must beat current highest if bidding (except 0 pass)
  if (s !== 0 && s <= game.bidding.highestBid) return { ok: false, error: "BID_TOO_LOW" };

  game.bidding.bids[playerId] = s;
  game.bidding.acted += 1;

  if (s > game.bidding.highestBid) {
    game.bidding.highestBid = s;
    game.bidding.highestBidder = playerId;
  }

  if (s === 3) {
    // max bid ends immediately
    finalizeBidding(game);
    return { ok: true, done: true };
  }

  if (game.bidding.acted >= 3) {
    finalizeBidding(game);
    return { ok: true, done: true };
  }

  game.bidding.turn = nextPlayerId(game, playerId);
  return { ok: true, done: false };
}

function finalizeBidding(game) {
  const winner = game.bidding.highestBidder;
  if (!winner) {
    // nobody bid -> redeal by resetting game id, hands & bottom should be replaced by caller
    game.stage = "ended";
    game.winner = null;
    return;
  }
  game.landlord = winner;
  game.baseScore = game.bidding.highestBid;
  game.stage = "doubling";
  game.doubling.acted = 0;
}

export function applyDouble(game, playerId, on) {
  if (game.stage !== "doubling") return { ok: false, error: "BAD_STAGE" };
  if (!(playerId in game.doubling.doubles)) return { ok: false, error: "NOT_IN_GAME" };
  // Each player can decide once; default false
  if (game.doubling._actedSet?.has(playerId)) return { ok: false, error: "ALREADY_DOUBLED" };
  if (!game.doubling._actedSet) game.doubling._actedSet = new Set();

  game.doubling.doubles[playerId] = !!on;
  game.doubling._actedSet.add(playerId);
  game.doubling.acted += 1;

  if (game.doubling.acted >= 3) {
    // compute doubling exponent from doubles
    const n = Object.values(game.doubling.doubles).filter(Boolean).length;
    game.doublingCount = n;
    game.multiplier = 2 ** n; // for UI/debug (final total multiplier is computed at round end)
    game.stage = "bottom";
  }
  return { ok: true, done: game.stage !== "doubling" };
}

export function registerPlay(game, playerId, analysis) {
  if (!game.stats?.playedCountByPlayer) return;
  game.stats.playedCountByPlayer[playerId] =
    (game.stats.playedCountByPlayer[playerId] || 0) + 1;

  if (!analysis || !analysis.kind) return;
  if (analysis.kind === "bomb") {
    game.stats.bombEventCount += 1;
    game.stats.bombs += 1;
  }
  if (analysis.kind === "rocket") {
    game.stats.bombEventCount += 1;
    game.stats.rockets += 1;
  }
}

export function finalizeRound(game) {
  const landlordId = game.landlord;
  const winnerId = game.winner;
  if (!landlordId || !winnerId) return { ok: false };

  const players = game.players.map((p) => p.id);
  const farmers = players.filter((x) => x !== landlordId);

  const landlordPlayed = game.stats.playedCountByPlayer?.[landlordId] || 0;
  const farmersPlayed = farmers.map((pid) => game.stats.playedCountByPlayer?.[pid] || 0);

  const isSpring = winnerId === landlordId && farmersPlayed.every((c) => c === 0);
  // Anti-spring: landlord only played one hand, then farmers take over and win
  const isAntiSpring = winnerId !== landlordId && landlordPlayed === 1;

  const specialEventCount = isSpring || isAntiSpring ? 1 : 0;

  const totalEventExponent = game.doublingCount + game.stats.bombEventCount + specialEventCount;
  const cappedExponent = Math.min(4, totalEventExponent);

  const unit = game.baseScore * 2 ** cappedExponent;
  const deltaByPlayer = Object.fromEntries(
    players.map((pid) => {
      if (pid === landlordId) {
        return [
          pid,
          winnerId === landlordId ? 2 * unit : -2 * unit,
        ];
      }
      return [pid, winnerId === landlordId ? -unit : unit];
    }),
  );

  game.score = {
    landlordId,
    winnerId,
    isSpring,
    isAntiSpring,
    specialEventCount,
    doublingCount: game.doublingCount,
    bombEventCount: game.stats.bombEventCount,
    eventExponent: totalEventExponent,
    cappedExponent,
    unit,
    deltaByPlayer,
  };

  return { ok: true, score: game.score };
}

export function analyzePlay(cards) {
  /**
   * Standard 斗地主牌型识别（常见规则）
   * Ranks: 3..15(2), 16小王, 17大王
   *
   * Returns:
   * - {ok:true, kind, mainRank, len, seqLen?, wings?, isBomb?}
   */
  const len = cards.length;
  if (len === 0) return { ok: false, error: "EMPTY" };
  const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
  const { counts, uniq } = countRanks(ranks);

  // rocket
  if (len === 2 && ranks[0] === 16 && ranks[1] === 17) {
    return { ok: true, kind: "rocket", mainRank: 17, len, isBomb: true };
  }

  // bomb
  if (len === 4 && uniq.length === 1 && counts.get(uniq[0]) === 4) {
    return { ok: true, kind: "bomb", mainRank: uniq[0], len, isBomb: true };
  }

  // single/pair/triple
  if (len === 1) return { ok: true, kind: "single", mainRank: ranks[0], len };
  if (len === 2 && uniq.length === 1 && counts.get(uniq[0]) === 2) {
    return { ok: true, kind: "pair", mainRank: uniq[0], len };
  }
  if (len === 3 && uniq.length === 1 && counts.get(uniq[0]) === 3) {
    return { ok: true, kind: "triple", mainRank: uniq[0], len };
  }

  // triple + single / pair
  if (len === 4) {
    const tripleRank = findRankWithCount(counts, 3);
    if (tripleRank != null) {
      return { ok: true, kind: "triple1", mainRank: tripleRank, len };
    }
  }
  if (len === 5) {
    const tripleRank = findRankWithCount(counts, 3);
    if (tripleRank != null) {
      const pairRank = findRankWithCount(counts, 2);
      if (pairRank != null) {
        return { ok: true, kind: "triple2", mainRank: tripleRank, len };
      }
    }
  }

  // straight (>=5), cannot include 2 or jokers
  if (len >= 5 && uniq.length === len && isConsecutive(uniq) && uniq[uniq.length - 1] <= 14) {
    return { ok: true, kind: "straight", mainRank: uniq[uniq.length - 1], len, seqLen: len };
  }

  // double straight (>=3 pairs)
  if (len >= 6 && len % 2 === 0) {
    const pairRanks = uniq.filter((r) => counts.get(r) === 2);
    if (pairRanks.length === len / 2 && isConsecutive(pairRanks) && pairRanks[pairRanks.length - 1] <= 14) {
      return {
        ok: true,
        kind: "doubleStraight",
        mainRank: pairRanks[pairRanks.length - 1],
        len,
        seqLen: pairRanks.length,
      };
    }
  }

  // airplane (consecutive triples >=2) with or without wings
  // - pure: n*3
  // - with singles: n*4
  // - with pairs: n*5
  const tripleRanks = uniq.filter((r) => counts.get(r) === 3).sort((a, b) => a - b);
  if (tripleRanks.length >= 2 && isConsecutive(tripleRanks) && tripleRanks[tripleRanks.length - 1] <= 14) {
    const n = tripleRanks.length;
    const rest = [];
    for (const r of uniq) {
      const c = counts.get(r);
      if (c === 3) continue;
      for (let i = 0; i < c; i++) rest.push(r);
    }

    if (rest.length === 0 && len === n * 3) {
      return { ok: true, kind: "airplane", mainRank: tripleRanks[n - 1], len, seqLen: n, wings: "none" };
    }
    if (len === n * 4 && rest.length === n) {
      // wings: n singles (cannot reuse triple ranks, already removed)
      return { ok: true, kind: "airplane", mainRank: tripleRanks[n - 1], len, seqLen: n, wings: "single" };
    }
    if (len === n * 5) {
      // wings: n pairs
      const { counts: restCounts, uniq: restUniq } = countRanks(rest);
      const okPairs = restUniq.every((r) => restCounts.get(r) === 2) && restUniq.length === n;
      if (okPairs) {
        return { ok: true, kind: "airplane", mainRank: tripleRanks[n - 1], len, seqLen: n, wings: "pair" };
      }
    }
  }

  // four with two (single or pair)
  const fourRank = findRankWithCount(counts, 4);
  if (fourRank != null) {
    if (len === 6) {
      // 4 + 2 singles (could be same rank? not possible because four already uses all)
      return { ok: true, kind: "four2", mainRank: fourRank, len };
    }
    if (len === 8) {
      // 4 + 2 pairs
      const others = uniq.filter((r) => r !== fourRank);
      const ok = others.length === 2 && others.every((r) => counts.get(r) === 2);
      if (ok) return { ok: true, kind: "four2pair", mainRank: fourRank, len };
    }
  }

  return { ok: false, error: "UNSUPPORTED" };
}

export function comparePlays(prev, next) {
  // returns true if next beats prev
  if (!prev) return true;

  if (next.kind === "rocket") return true;
  if (prev.kind === "rocket") return false;

  if (next.kind === "bomb" && prev.kind !== "bomb") return true;
  if (prev.kind === "bomb" && next.kind !== "bomb") return false;

  if (prev.kind !== next.kind) return false;
  if (prev.len !== next.len) return false;

  // For airplane need same wings/seqLen
  if (next.kind === "airplane") {
    if (prev.wings !== next.wings) return false;
    if (prev.seqLen !== next.seqLen) return false;
  }
  if (next.kind === "straight" || next.kind === "doubleStraight") {
    if (prev.seqLen !== next.seqLen) return false;
  }

  return next.mainRank > prev.mainRank;
}

function countRanks(ranks) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const uniq = [...counts.keys()].sort((a, b) => a - b);
  return { counts, uniq };
}

function findRankWithCount(counts, n) {
  for (const [r, c] of counts.entries()) {
    if (c === n) return r;
  }
  return null;
}

function isConsecutive(sortedUniq) {
  if (sortedUniq.length <= 1) return true;
  for (let i = 1; i < sortedUniq.length; i++) {
    if (sortedUniq[i] !== sortedUniq[i - 1] + 1) return false;
  }
  return true;
}

export function removeCardsFromHand(hand, cardIds) {
  const set = new Set(cardIds);
  const picked = [];
  const remaining = [];
  for (const c of hand) {
    if (set.has(c.id)) picked.push(c);
    else remaining.push(c);
  }
  if (picked.length !== cardIds.length) return { ok: false };
  hand.length = 0;
  hand.push(...remaining);
  return { ok: true, picked };
}

export function applySkillPlusOne(game, playerId, cardId) {
  const st = game.skills[playerId];
  if (!st || st.skillId !== SkillId.PLUS_ONE || st.used) {
    return { ok: false, error: "SKILL_NOT_AVAILABLE" };
  }
  const hand = game.hands.get(playerId);
  const card = hand.find((c) => c.id === cardId);
  if (!card) return { ok: false, error: "CARD_NOT_FOUND" };
  if (card.rank >= 15) return { ok: false, error: "CARD_NOT_ELIGIBLE" };
  card.rank += 1;
  card.label = `${card.suit}${rankToLabel(card.rank)}`;
  sortHand(hand);
  st.used = true;
  return { ok: true };
}

export function applySkillStealBottom2(game, playerId, rnd = Math.random) {
  const st = game.skills[playerId];
  if (!st || st.skillId !== SkillId.STEAL_BOTTOM_2 || st.used) {
    return { ok: false, error: "SKILL_NOT_AVAILABLE" };
  }
  if (game.bottomGiven) return { ok: false, error: "BOTTOM_ALREADY_GIVEN" };
  if (game.bottom.length < 2) return { ok: false, error: "BOTTOM_NOT_ENOUGH" };
  // choose 2 random cards from bottom
  const idxs = [];
  while (idxs.length < 2) {
    const i = Math.floor(rnd() * game.bottom.length);
    if (!idxs.includes(i)) idxs.push(i);
  }
  idxs.sort((a, b) => b - a); // remove from end
  const taken = [];
  for (const i of idxs) taken.push(game.bottom.splice(i, 1)[0]);
  const hand = game.hands.get(playerId);
  hand.push(...taken);
  sortHand(hand);
  st.used = true;
  return { ok: true, taken };
}

export function nextPlayerId(game, playerId) {
  const idx = game.players.findIndex((p) => p.id === playerId);
  const next = game.players[(idx + 1) % 3];
  return next.id;
}

