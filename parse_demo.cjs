const { parseEvent, parseHeader, parsePlayerInfo, parseTicks } = require('@laihoe/demoparser2');

const filePath = process.argv[2];

/* =======================================================================
 * 计分板计算（新增）—— 产出每位玩家 T / CT / both 三个分桶的数据
 *   Op K-D、MKs、KAST、1vsX、K(hs)、A(f)、D(t)、ADR、Swing(近似)、Rating(近似)
 *   说明：Rating / Swing 为近似值，HLTV 真实 3.0 公式为专有，无法精确复现。
 * ===================================================================== */
const TICKRATE = 64;
const TRADE_TICKS = 5 * TICKRATE;

const toId = (v) => (v === null || v === undefined ? null : String(v));
const sideOf = (teamNum) => (teamNum === 2 ? 'T' : teamNum === 3 ? 'CT' : null);

// 容错版 parseEvent：先尝试带 other 字段，失败则逐步退回
function safeEvent(demoPath, name, playerProps, otherProps) {
  try {
    return parseEvent(demoPath, name, playerProps || [], otherProps || []) || [];
  } catch (_) {
    try {
      return parseEvent(demoPath, name, playerProps || [], []) || [];
    } catch (__) {
      try { return parseEvent(demoPath, name) || []; } catch (___) { return []; }
    }
  }
}

// 简化“人数优势胜率表”，仅用于 Swing 近似（非 HLTV 真实概率）
function winProb(self, enemy) {
  if (self <= 0) return 0;
  if (enemy <= 0) return 1;
  const p = 0.5 + 0.18 * (self - enemy);
  return Math.max(0.05, Math.min(0.95, p));
}

function emptySide() {
  return {
    kills: 0, hs: 0, deaths: 0, tradedDeaths: 0,
    assists: 0, flashAssists: 0, damage: 0,
    opK: 0, opD: 0, mkRounds: 0,
    kastRounds: 0, roundsPlayed: 0, clutchWins: 0, swingSum: 0,
  };
}

// 选取真实回合的 round_end：优先取“有有效胜方”的行；都没有时按 tick 过滤掉开局复位行(tick<=320)
function selectRoundEnds(ev) {
  const winSide = (e) => sideOf(typeof e.winner === 'string' ? parseInt(e.winner, 10) : e.winner);
  let ends = (ev.ends || []).filter((e) => winSide(e) !== null).sort((a, b) => a.tick - b.tick);
  if (ends.length === 0) ends = (ev.ends || []).filter((e) => e.tick > 320).sort((a, b) => a.tick - b.tick);
  return ends;
}

// 推断每回合胜方：优先 round_end.winner；为空时用「炸弹爆炸=T / 拆弹=CT / 否则本回合最后一个击杀者的阵营」
function inferWinners(ev) {
  const winSide = (e) => sideOf(typeof e.winner === 'string' ? parseInt(e.winner, 10) : e.winner);
  const ends = selectRoundEnds(ev);
  const endTicks = ends.map((e) => e.tick);
  const ROUNDS = ends.length;
  const roundOf = (tick) => { let r = 0; while (r < endTicks.length && endTicks[r] < tick) r++; return r; };
  const exploded = new Set((ev.explodes || []).map((e) => roundOf(e.tick)));
  const defused = new Set((ev.defuses || []).map((e) => roundOf(e.tick)));
  const planted = new Set((ev.plants || []).map((e) => roundOf(e.tick)));

  // 每回合每位玩家阵营（事件推断 + 前后填充），用于判断回合结束时双方是否都有人活着
  const deaths = (ev.deaths || []).slice().sort((a, b) => a.tick - b.tick);
  const rawSides = Array.from({ length: ROUNDS }, () => new Map());
  const note = (r, id, tn) => { const s = sideOf(tn); if (r >= 0 && r < ROUNDS && id && s) rawSides[r].set(String(id), s); };
  for (const d of deaths) { const r = roundOf(d.tick); note(r, d.attacker_steamid, d.attacker_team_num); note(r, d.user_steamid, d.user_team_num); }
  for (const h of (ev.hurts || [])) { const r = roundOf(h.tick); note(r, h.attacker_steamid, h.attacker_team_num); note(r, h.user_steamid, h.user_team_num); }
  const allIds = new Set(); for (const m of rawSides) for (const id of m.keys()) allIds.add(id);
  const sides = rawSides.map((m) => new Map(m));
  for (const id of allIds) {
    let last = null; for (let r = 0; r < ROUNDS; r++) { if (sides[r].has(id)) last = sides[r].get(id); else if (last !== null) sides[r].set(id, last); }
    let next = null; for (let r = ROUNDS - 1; r >= 0; r--) { if (sides[r].has(id)) next = sides[r].get(id); else if (next !== null) sides[r].set(id, next); }
  }
  // 每回合各方初始人数 与 死亡数 → 结束时存活数
  const tSize = new Array(ROUNDS).fill(0), ctSize = new Array(ROUNDS).fill(0);
  for (let r = 0; r < ROUNDS; r++) for (const s of sides[r].values()) { if (s === 'T') tSize[r]++; else if (s === 'CT') ctSize[r]++; }
  const tDeaths = new Array(ROUNDS).fill(0), ctDeaths = new Array(ROUNDS).fill(0);
  const lastKillSide = new Array(ROUNDS).fill(null);
  for (const d of deaths) {
    const r = roundOf(d.tick); if (r < 0 || r >= ROUNDS) continue;
    const vS = sides[r].get(String(d.user_steamid)) || sideOf(d.user_team_num);
    if (vS === 'T') tDeaths[r]++; else if (vS === 'CT') ctDeaths[r]++;
    const aS = sideOf(d.attacker_team_num), vS2 = sideOf(d.user_team_num);
    if (aS && vS2 && aS !== vS2) lastKillSide[r] = aS;
  }

  const winners = new Array(ROUNDS).fill(null);
  for (let r = 0; r < ROUNDS; r++) {
    const reported = winSide(ends[r]);
    if (reported) { winners[r] = reported; continue; }
    if (exploded.has(r)) { winners[r] = 'T'; continue; }
    if (defused.has(r)) { winners[r] = 'CT'; continue; }
    const tAlive = tSize[r] - tDeaths[r], ctAlive = ctSize[r] - ctDeaths[r];
    if (tAlive > 0 && ctAlive > 0) { winners[r] = planted.has(r) ? 'T' : 'CT'; continue; } // 时间到双方都有人活：无下包→CT守住
    if (tAlive > 0 && ctAlive <= 0) { winners[r] = 'T'; continue; }
    if (ctAlive > 0 && tAlive <= 0) { winners[r] = 'CT'; continue; }
    winners[r] = lastKillSide[r]; // 都没人（极少）→退回最后一刀
  }
  return winners;
}

function computeScoreboard(ev) {
  const roster = ev.roster || [];
  const deaths = ev.deaths || [];
  const hurts = ev.hurts || [];

  const liveDeaths = deaths.slice().sort((a, b) => a.tick - b.tick);
  const liveHurts = hurts;
  const ends = selectRoundEnds(ev);

  // 用 round_end 的 tick 给所有事件划回合
  const endTicks = ends.map((e) => e.tick);
  const winners = inferWinners(ev); // 每回合胜方（round_end.winner 为空时自动推断）
  const ROUNDS = winners.length;
  const roundOf = (tick) => {
    let r = 0;
    while (r < endTicks.length && endTicks[r] < tick) r++;
    return r;
  };

  // ---- 每回合每位玩家的阵营（事件推断 + 前后填充补缺）----
  const rawSides = Array.from({ length: ROUNDS }, () => new Map());
  const noteSide = (round, id, teamNum) => {
    const s = sideOf(teamNum);
    if (round >= 0 && round < ROUNDS && id && s) rawSides[round].set(id, s);
  };
  for (const d of liveDeaths) {
    const r = roundOf(d.tick);
    noteSide(r, toId(d.attacker_steamid), d.attacker_team_num);
    noteSide(r, toId(d.user_steamid), d.user_team_num);
  }
  for (const h of liveHurts) {
    const r = roundOf(h.tick);
    noteSide(r, toId(h.attacker_steamid), h.attacker_team_num);
    noteSide(r, toId(h.user_steamid), h.user_team_num);
  }

  const allIds = new Set();
  const names = new Map();
  for (const p of roster) {
    const id = toId(p.steamid);
    if (!id) continue;
    allIds.add(id);
    names.set(id, p.name);
  }
  // 名字兜底：从事件里补
  for (const d of liveDeaths) {
    const a = toId(d.attacker_steamid), v = toId(d.user_steamid);
    if (a && !names.has(a) && d.attacker_name) names.set(a, d.attacker_name);
    if (v && !names.has(v) && d.user_name) names.set(v, d.user_name);
  }
  for (const m of rawSides) for (const id of m.keys()) allIds.add(id);

  const sides = rawSides.map((m) => new Map(m));
  for (const id of allIds) {
    let last = null;
    for (let r = 0; r < ROUNDS; r++) {
      if (sides[r].has(id)) last = sides[r].get(id);
      else if (last !== null) sides[r].set(id, last);
    }
    let next = null;
    for (let r = ROUNDS - 1; r >= 0; r--) {
      if (sides[r].has(id)) next = sides[r].get(id);
      else if (next !== null) sides[r].set(id, next);
    }
  }
  const sideAt = (round, id) =>
    round >= 0 && round < ROUNDS ? sides[round].get(id) || null : null;

  // ---- 累加器 ----
  const stats = new Map();
  const bag = (id) => {
    if (!stats.has(id)) stats.set(id, { T: emptySide(), CT: emptySide() });
    return stats.get(id);
  };
  const add = (id, side, field, n = 1) => {
    if (!id || !side) return;
    bag(id)[side][field] += n;
  };

  const deathsByRound = Array.from({ length: ROUNDS }, () => []);
  for (const d of liveDeaths) {
    const r = roundOf(d.tick);
    if (r >= 0 && r < ROUNDS) deathsByRound[r].push(d);
  }

  // 伤害（ADR）：排除自伤与友伤
  for (const h of liveHurts) {
    const r = roundOf(h.tick);
    const aId = toId(h.attacker_steamid);
    const vId = toId(h.user_steamid);
    if (!aId || aId === vId) continue;
    const aSide = sideAt(r, aId);
    const vSide = sideAt(r, vId);
    if (aSide && vSide && aSide === vSide) continue;
    add(aId, aSide, 'damage', h.dmg_health || 0);
  }

  // ---- 逐回合：击杀/首杀/多杀/交换/残局/Swing/KAST ----
  for (let r = 0; r < ROUNDS; r++) {
    const rd = deathsByRound[r].slice().sort((a, b) => a.tick - b.tick);

    const alive = { T: new Set(), CT: new Set() };
    for (const [id, s] of sides[r].entries()) if (s === 'T' || s === 'CT') alive[s].add(id);

    const roundKills = new Map();
    const gotKill = new Set();
    const gotAssist = new Set();
    const died = new Set();
    const tradedDeath = new Set();
    let openingDone = false;
    const clutchFlag = { T: null, CT: null };

    // 标记“被交换的死亡”
    const enemyKills = rd.filter((d) => {
      const aId = toId(d.attacker_steamid);
      const vId = toId(d.user_steamid);
      if (!aId || aId === vId) return false;
      const aS = sideAt(r, aId), vS = sideAt(r, vId);
      return aS && vS && aS !== vS;
    });
    for (let i = 0; i < enemyKills.length; i++) {
      const k = enemyKills[i];
      const killerId = toId(k.attacker_steamid);
      const victimId = toId(k.user_steamid);
      const victimSide = sideAt(r, victimId);
      for (let j = i + 1; j < enemyKills.length; j++) {
        const k2 = enemyKills[j];
        if (k2.tick - k.tick > TRADE_TICKS) break;
        const avengerId = toId(k2.attacker_steamid);
        const k2VictimId = toId(k2.user_steamid);
        if (k2VictimId === killerId && sideAt(r, avengerId) === victimSide) {
          tradedDeath.add(victimId);
          break;
        }
      }
    }

    for (const d of rd) {
      const aId = toId(d.attacker_steamid);
      const vId = toId(d.user_steamid);
      const aSide = sideAt(r, aId);
      const vSide = sideAt(r, vId);
      const isEnemyKill = aId && aId !== vId && aSide && vSide && aSide !== vSide;

      if (isEnemyKill) {
        const selfK = alive[aSide].size;
        const enemyK = alive[vSide].size;
        add(aId, aSide, 'swingSum', winProb(selfK, enemyK - 1) - winProb(selfK, enemyK));
        const vdelta = winProb(enemyK - 1, selfK) - winProb(enemyK, selfK);
        add(vId, vSide, 'swingSum', vdelta);

        add(aId, aSide, 'kills');
        if (d.headshot) add(aId, aSide, 'hs');
        gotKill.add(aId);
        roundKills.set(aId, (roundKills.get(aId) || 0) + 1);

        if (!openingDone) {
          openingDone = true;
          add(aId, aSide, 'opK');
          add(vId, vSide, 'opD');
        }

        const asId = toId(d.assister_steamid);
        if (asId && asId !== vId) {
          const asSide = sideAt(r, asId);
          if (asSide && asSide !== vSide) {
            add(asId, asSide, 'assists');
            gotAssist.add(asId);
            if (d.assistedflash) add(asId, asSide, 'flashAssists');
          }
        }
      }

      if (vId) {
        if (vSide) add(vId, vSide, 'deaths');
        died.add(vId);
        if (vSide && alive[vSide].has(vId)) alive[vSide].delete(vId);
        if (tradedDeath.has(vId) && vSide) add(vId, vSide, 'tradedDeaths');
      }

      for (const s of ['T', 'CT']) {
        const other = s === 'T' ? 'CT' : 'T';
        if (!clutchFlag[s] && alive[s].size === 1 && alive[other].size >= 1) {
          clutchFlag[s] = { id: [...alive[s]][0], X: alive[other].size };
        }
      }
    }

    const winner = winners[r];
    for (const s of ['T', 'CT']) {
      if (clutchFlag[s] && winner === s) add(clutchFlag[s].id, s, 'clutchWins');
    }

    for (const [id, n] of roundKills.entries()) {
      if (n >= 2) add(id, sideAt(r, id), 'mkRounds');
    }

    for (const [id, s] of sides[r].entries()) {
      if (s !== 'T' && s !== 'CT') continue;
      add(id, s, 'roundsPlayed');
      const credit = gotKill.has(id) || gotAssist.has(id) || !died.has(id) || tradedDeath.has(id);
      if (credit) add(id, s, 'kastRounds');
    }
  }

  // ---- 派生比率 + 近似 Rating/Swing ----
  const round1 = (x) => Math.round(x * 10) / 10;
  const round2 = (x) => Math.round(x * 100) / 100;

  function derive(s) {
    const rp = s.roundsPlayed;
    const kpr = rp ? s.kills / rp : 0;
    const dpr = rp ? s.deaths / rp : 0;
    const apr = rp ? s.assists / rp : 0;
    const adr = rp ? s.damage / rp : 0;
    const kast = rp ? (s.kastRounds / rp) * 100 : 0;
    const impact = 2.13 * kpr + 0.42 * apr - 0.41;             // 社区逆向 Impact
    const rating = rp
      ? 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587
      : 0;                                                      // ≈ HLTV 2.0 逆向模型（非 3.0）
    const swing = rp ? (s.swingSum / rp) * 100 : 0;
    return {
      opK: s.opK, opD: s.opD, mk: s.mkRounds,
      kast: round1(kast), clutches: s.clutchWins,
      kills: s.kills, hs: s.hs,
      assists: s.assists, flashAssists: s.flashAssists,
      deaths: s.deaths, tradedDeaths: s.tradedDeaths,
      adr: round1(adr), swing: round1(swing), rating: round2(rating),
      roundsPlayed: rp,
    };
  }

  function combine(t, c) {
    const both = emptySide();
    for (const f of Object.keys(both)) both[f] = t[f] + c[f];
    return both;
  }

  const teamOf = (id) => {
    const s0 = sideAt(0, id);
    return s0 === 'T' ? 'A' : s0 === 'CT' ? 'B' : null;
  };

  const players = [];
  for (const id of allIds) {
    const s = stats.get(id) || { T: emptySide(), CT: emptySide() };
    const both = combine(s.T, s.CT);
    if (both.roundsPlayed === 0) continue;
    players.push({
      steamid: id,
      name: names.get(id) || id,
      team: teamOf(id),
      stats: { both: derive(both), T: derive(s.T), CT: derive(s.CT) },
    });
  }
  players.sort((a, b) => b.stats.both.rating - a.stats.both.rating);

  return { rounds: ROUNDS, players };
}

/* =======================================================================
 * 进阶 / 对位数据（新增，独立函数，不改动 computeScoreboard）
 *   - duels: 两队选手互相击杀次数矩阵
 *   - players: 首杀、多杀分布(2K~5K)、残局(1v1~1v5)、交换、道具伤害、致盲、常用武器…
 *   - map: T/CT 各赢多少回合、下包/拆包/爆炸、首杀转化率
 * ===================================================================== */
function computeAdvanced(ev) {
  const deaths = ev.deaths || [];
  const hurts = ev.hurts || [];
  const plants = ev.plants || [];
  const defuses = ev.defuses || [];
  const explodes = ev.explodes || [];

  const liveDeaths = deaths.slice().sort((a, b) => a.tick - b.tick);
  const liveHurts = hurts;
  const ends = selectRoundEnds(ev);

  const endTicks = ends.map((e) => e.tick);
  const winners = inferWinners(ev);
  const ROUNDS = winners.length;
  const roundOf = (tick) => { let r = 0; while (r < endTicks.length && endTicks[r] < tick) r++; return r; };

  // 每回合每位玩家阵营（事件推断 + 前后填充）
  const rawSides = Array.from({ length: ROUNDS }, () => new Map());
  const names = new Map();
  const noteSide = (round, id, tn) => { const s = sideOf(tn); if (round >= 0 && round < ROUNDS && id && s) rawSides[round].set(id, s); };
  for (const d of liveDeaths) {
    const r = roundOf(d.tick);
    noteSide(r, toId(d.attacker_steamid), d.attacker_team_num);
    noteSide(r, toId(d.user_steamid), d.user_team_num);
    const a = toId(d.attacker_steamid), v = toId(d.user_steamid);
    if (a && d.attacker_name && !names.has(a)) names.set(a, d.attacker_name);
    if (v && d.user_name && !names.has(v)) names.set(v, d.user_name);
  }
  for (const h of liveHurts) {
    const r = roundOf(h.tick);
    noteSide(r, toId(h.attacker_steamid), h.attacker_team_num);
    noteSide(r, toId(h.user_steamid), h.user_team_num);
  }
  const allIds = new Set();
  for (const m of rawSides) for (const id of m.keys()) allIds.add(id);
  const sides = rawSides.map((m) => new Map(m));
  for (const id of allIds) {
    let last = null;
    for (let r = 0; r < ROUNDS; r++) { if (sides[r].has(id)) last = sides[r].get(id); else if (last !== null) sides[r].set(id, last); }
    let next = null;
    for (let r = ROUNDS - 1; r >= 0; r--) { if (sides[r].has(id)) next = sides[r].get(id); else if (next !== null) sides[r].set(id, next); }
  }
  const sideAt = (round, id) => (round >= 0 && round < ROUNDS ? sides[round].get(id) || null : null);
  const teamOf = (id) => { const s0 = sideAt(0, id); return s0 === 'T' ? 'A' : s0 === 'CT' ? 'B' : null; };

  // 累加器
  const P = new Map();
  const pl = (id) => {
    if (!P.has(id)) P.set(id, {
      kills: 0, hs: 0, opK: 0, opD: 0, m2: 0, m3: 0, m4: 0, m5: 0,
      tradeKills: 0, tradedDeaths: 0, utilDmg: 0, flashed: 0,
      shots: 0, hits: 0, nades: 0,
      clutchW: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, clutchA: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      weapons: new Map(),
    });
    return P.get(id);
  };

  // 对位击杀矩阵 killer -> Map(victim -> n)
  const duel = new Map();
  const addDuel = (k, v) => { if (!duel.has(k)) duel.set(k, new Map()); const m = duel.get(k); m.set(v, (m.get(v) || 0) + 1); };

  const dbr = Array.from({ length: ROUNDS }, () => []);
  for (const d of liveDeaths) { const r = roundOf(d.tick); if (r >= 0 && r < ROUNDS) dbr[r].push(d); }

  // 道具伤害（HE + 燃烧），排除自伤/友伤
  for (const h of liveHurts) {
    const aId = toId(h.attacker_steamid), vId = toId(h.user_steamid), r = roundOf(h.tick);
    if (!aId || aId === vId) continue;
    const aS = sideAt(r, aId), vS = sideAt(r, vId);
    if (aS && vS && aS === vS) continue;
    const w = String(h.weapon || '');
    if (w.includes('hegrenade') || w.includes('inferno') || w.includes('molotov') || w.includes('inc')) {
      pl(aId).utilDmg += h.dmg_health || 0;
    }
  }
  // 投出的闪光数（该版本无 player_blind 事件，改用 flashbang_detonate 的投掷者统计）
  for (const f of (ev.flashes || [])) {
    const tid = toId(f.user_steamid);
    if (tid) pl(tid).flashed += 1;
  }
  // 开火次数（weapon_fire）/ 命中次数（对敌 player_hurt）→ 命中率
  for (const f of (ev.fires || [])) {
    const sid = toId(f.user_steamid);
    if (sid) pl(sid).shots += 1;
  }
  for (const h of liveHurts) {
    const aId = toId(h.attacker_steamid), vId = toId(h.user_steamid), r = roundOf(h.tick);
    if (!aId || aId === vId) continue;
    const aS = sideAt(r, aId), vS = sideAt(r, vId);
    if (aS && vS && aS === vS) continue; // 排除友伤
    pl(aId).hits += 1;
  }
  // 投掷物总数（grenade_thrown）
  for (const g of (ev.nades || [])) {
    const tid = toId(g.user_steamid);
    if (tid) pl(tid).nades += 1;
  }

  for (let r = 0; r < ROUNDS; r++) {
    const rd = dbr[r].slice().sort((a, b) => a.tick - b.tick);
    const alive = { T: new Set(), CT: new Set() };
    for (const [id, s] of sides[r].entries()) if (s === 'T' || s === 'CT') alive[s].add(id);
    const roundKills = new Map();
    let openingDone = false;
    const clutchFlag = { T: null, CT: null };

    const enemyKills = rd.filter((d) => {
      const aId = toId(d.attacker_steamid), vId = toId(d.user_steamid);
      if (!aId || aId === vId) return false;
      const aS = sideAt(r, aId), vS = sideAt(r, vId);
      return aS && vS && aS !== vS;
    });
    // 交换：5 秒内回杀凶手 -> 复仇者得 tradeKill，被害者得 tradedDeath
    for (let i = 0; i < enemyKills.length; i++) {
      const k = enemyKills[i];
      const killerId = toId(k.attacker_steamid), victimId = toId(k.user_steamid), vSide = sideAt(r, victimId);
      for (let j = i + 1; j < enemyKills.length; j++) {
        const k2 = enemyKills[j];
        if (k2.tick - k.tick > TRADE_TICKS) break;
        const avengerId = toId(k2.attacker_steamid), k2v = toId(k2.user_steamid);
        if (k2v === killerId && sideAt(r, avengerId) === vSide) { pl(avengerId).tradeKills++; pl(victimId).tradedDeaths++; break; }
      }
    }

    for (const d of rd) {
      const aId = toId(d.attacker_steamid), vId = toId(d.user_steamid);
      const aS = sideAt(r, aId), vS = sideAt(r, vId);
      const enemy = aId && aId !== vId && aS && vS && aS !== vS;
      if (enemy) {
        const a = pl(aId); a.kills++; if (d.headshot) a.hs++;
        roundKills.set(aId, (roundKills.get(aId) || 0) + 1);
        addDuel(aId, vId);
        const w = String(d.weapon || ''); a.weapons.set(w, (a.weapons.get(w) || 0) + 1);
        if (!openingDone) { openingDone = true; a.opK++; pl(vId).opD++; }
      }
      if (vId && vS && alive[vS].has(vId)) alive[vS].delete(vId);
      for (const s of ['T', 'CT']) {
        const o = s === 'T' ? 'CT' : 'T';
        if (!clutchFlag[s] && alive[s].size === 1 && alive[o].size >= 1) clutchFlag[s] = { id: [...alive[s]][0], X: alive[o].size };
      }
    }
    for (const [id, n] of roundKills.entries()) {
      const p = pl(id);
      if (n === 2) p.m2++; else if (n === 3) p.m3++; else if (n === 4) p.m4++; else if (n >= 5) p.m5++;
    }
    const winner = winners[r];
    for (const s of ['T', 'CT']) {
      if (clutchFlag[s]) {
        const X = Math.min(5, clutchFlag[s].X), p = pl(clutchFlag[s].id);
        p.clutchA[X]++; if (winner === s) p.clutchW[X]++;
      }
    }
  }

  const stripW = (w) => w.replace(/^weapon_/, '') || '-';
  const players = [];
  for (const id of allIds) {
    const p = P.get(id); if (!p) continue;
    if (p.kills === 0 && p.opD === 0 && p.utilDmg === 0 && p.flashed === 0) continue;
    let favW = '-', favN = 0;
    for (const [w, n] of p.weapons.entries()) if (n > favN) { favN = n; favW = w; }
    players.push({
      steamid: id, name: names.get(id) || id, team: teamOf(id),
      kills: p.kills, hsPct: p.kills ? Math.round((p.hs / p.kills) * 100) : 0,
      opK: p.opK, opD: p.opD, opWinPct: (p.opK + p.opD) ? Math.round((p.opK / (p.opK + p.opD)) * 100) : 0,
      multi: { '2k': p.m2, '3k': p.m3, '4k': p.m4, '5k': p.m5 },
      clutchW: p.clutchW, clutchA: p.clutchA,
      tradeKills: p.tradeKills, tradedDeaths: p.tradedDeaths,
      utilDmg: Math.round(p.utilDmg), flashed: p.flashed,
      shots: p.shots, hits: p.hits, acc: p.shots ? Math.round((p.hits / p.shots) * 100) : 0, nades: p.nades,
      favWeapon: stripW(favW), favWeaponKills: favN,
    });
  }
  players.sort((a, b) => b.kills - a.kills);

  const kills = {};
  for (const [k, m] of duel.entries()) { kills[k] = {}; for (const [v, n] of m.entries()) kills[k][v] = n; }

  const tWins = winners.filter((w) => w === 'T').length;
  const ctWins = winners.filter((w) => w === 'CT').length;
  // 按队伍(A/B)统计每回合胜场：找出本回合胜方阵营对应的是哪支队伍
  let aWins = 0, bWins = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const w = winners[r]; if (!w) continue;
    let teamWon = null;
    for (const [id, s] of sides[r].entries()) { if (s === w) { teamWon = teamOf(id); break; } }
    if (teamWon === 'A') aWins++; else if (teamWon === 'B') bWins++;
  }
  let okWin = 0, okTot = 0;
  const okTeam = { A: [0, 0], B: [0, 0] }; // [win, total]
  for (let r = 0; r < ROUNDS; r++) {
    const rd = dbr[r].slice().sort((a, b) => a.tick - b.tick);
    const first = rd.find((d) => {
      const aId = toId(d.attacker_steamid), vId = toId(d.user_steamid);
      if (!aId || aId === vId) return false;
      const aS = sideAt(r, aId), vS = sideAt(r, vId);
      return aS && vS && aS !== vS;
    });
    if (first) {
      okTot++;
      const aId = toId(first.attacker_steamid);
      const won = sideAt(r, aId) === winners[r];
      if (won) okWin++;
      const tm = teamOf(aId);
      if (tm === 'A' || tm === 'B') { okTeam[tm][1]++; if (won) okTeam[tm][0]++; }
    }
  }
  const pct = (w, t) => (t ? Math.round((w / t) * 100) : 0);

  return {
    map: {
      rounds: ROUNDS, tWins, ctWins, teamAWins: aWins, teamBWins: bWins,
      bombPlanted: plants.length, bombDefused: defuses.length, bombExploded: explodes.length,
      openingKillWinPct: pct(okWin, okTot),
      openingKillWinPctA: pct(okTeam.A[0], okTeam.A[1]),
      openingKillWinPctB: pct(okTeam.B[0], okTeam.B[1]),
    },
    players,
    duels: { players: players.map((p) => ({ steamid: p.steamid, name: p.name, team: p.team })), kills },
  };
}

/* =======================================================================
 * 逐回合胜负进度条（新增）：每回合谁赢 + 两队当时各打 T/CT
 *   输出 { rounds, items:[{round,winnerTeam,teamASide,teamBSide}], halfSplits:[], score:{A:[h1,h2..],B:[...]} }
 *   - winnerTeam: 'A'|'B'（按首回合阵营固定的两队）
 *   - teamASide/teamBSide: 该回合各队所在阵营 'T'|'CT'（前端据此涂黄/蓝）
 *   - halfSplits: 发生换边的回合下标（用于画半场分隔线 / 分段比分）
 * ===================================================================== */
function computeRoundTimeline(ev) {
  const winners = inferWinners(ev); // 每回合胜方阵营 'T'/'CT'
  const ends = selectRoundEnds(ev);
  const endTicks = ends.map((e) => e.tick);
  const ROUNDS = winners.length;
  if (!ROUNDS) return null;
  const roundOf = (tick) => { let r = 0; while (r < endTicks.length && endTicks[r] < tick) r++; return r; };

  // 每回合每位玩家阵营（事件推断 + 前后填充）
  const rawSides = Array.from({ length: ROUNDS }, () => new Map());
  const note = (r, id, tn) => { const s = sideOf(tn); if (r >= 0 && r < ROUNDS && id && s) rawSides[r].set(String(id), s); };
  for (const d of (ev.deaths || [])) { const r = roundOf(d.tick); note(r, d.attacker_steamid, d.attacker_team_num); note(r, d.user_steamid, d.user_team_num); }
  for (const h of (ev.hurts || [])) { const r = roundOf(h.tick); note(r, h.attacker_steamid, h.attacker_team_num); note(r, h.user_steamid, h.user_team_num); }
  const allIds = new Set(); for (const m of rawSides) for (const id of m.keys()) allIds.add(id);
  const sides = rawSides.map((m) => new Map(m));
  for (const id of allIds) {
    let last = null; for (let r = 0; r < ROUNDS; r++) { if (sides[r].has(id)) last = sides[r].get(id); else if (last !== null) sides[r].set(id, last); }
    let next = null; for (let r = ROUNDS - 1; r >= 0; r--) { if (sides[r].has(id)) next = sides[r].get(id); else if (next !== null) sides[r].set(id, next); }
  }
  const teamOf = (id) => { const s0 = sides[0] && sides[0].get(id); return s0 === 'T' ? 'A' : s0 === 'CT' ? 'B' : null; };

  // 每回合 A 队所在阵营（B 队取相反）
  const teamASideAt = (r) => {
    for (const [id, s] of sides[r].entries()) { if (teamOf(id) === 'A') return s; }
    // 兜底：若该回合没看到 A 队玩家，用 B 的反面
    for (const [id, s] of sides[r].entries()) { if (teamOf(id) === 'B') return s === 'T' ? 'CT' : 'T'; }
    return null;
  };
  const winnerTeamAt = (r) => {
    const w = winners[r]; if (!w) return null;
    for (const [id, s] of sides[r].entries()) { if (s === w) return teamOf(id); }
    return null;
  };

  const items = [];
  for (let r = 0; r < ROUNDS; r++) {
    const aSide = teamASideAt(r);
    const bSide = aSide === 'T' ? 'CT' : aSide === 'CT' ? 'T' : null;
    items.push({ round: r + 1, winnerTeam: winnerTeamAt(r), teamASide: aSide, teamBSide: bSide });
  }

  // 换边点：A 队阵营从上一回合发生翻转的位置
  const halfSplits = [];
  for (let r = 1; r < ROUNDS; r++) {
    if (items[r].teamASide && items[r - 1].teamASide && items[r].teamASide !== items[r - 1].teamASide) halfSplits.push(r);
  }

  // 分段（半场）比分：用 halfSplits 把回合切段，统计每段 A/B 各赢几局
  const bounds = [0, ...halfSplits, ROUNDS];
  const score = { A: [], B: [] };
  for (let i = 0; i < bounds.length - 1; i++) {
    let a = 0, b = 0;
    for (let r = bounds[i]; r < bounds[i + 1]; r++) { if (items[r].winnerTeam === 'A') a++; else if (items[r].winnerTeam === 'B') b++; }
    score.A.push(a); score.B.push(b);
  }
  return { rounds: ROUNDS, items, halfSplits, score };
}

/* =======================================================================
 * 经济（扩展）：在每回合 freeze 结束(买枪完成)那一刻采样每位玩家的
 *   - 装备价值（after-buy）
 *   - 剩余金钱（after-buy）+ 本回合花费 → 开局金钱(before-buy) = 剩余 + 花费
 *   - 上回合收入 earned[r] = 开局金钱[r+1] − 剩余金钱[r]
 *   字段名各版本可能不同，逐个探测候选名，取第一个可用的；缺失的指标降级为 0。
 * ===================================================================== */
function computeEconomy(ev, demoPath) {
  const ends = selectRoundEnds(ev);
  const endTicks = ends.map((e) => e.tick);
  const ROUNDS = ends.length;
  if (!ROUNDS) return null;
  const roundOf = (tick) => { let r = 0; while (r < endTicks.length && endTicks[r] < tick) r++; return r; };

  const freezes = (ev.freezeEnds || []).slice().sort((a, b) => a.tick - b.tick);
  const tickOfRound = new Array(ROUNDS).fill(null);
  for (const f of freezes) { const r = roundOf(f.tick); if (r >= 0 && r < ROUNDS && tickOfRound[r] === null) tickOfRound[r] = f.tick; }
  const sampleTicks = tickOfRound.filter((t) => t !== null);
  if (!sampleTicks.length) return null;
  const tickToRound = new Map();
  tickOfRound.forEach((t, r) => { if (t !== null) tickToRound.set(t, r); });

  // 逐个探测字段是否可用（用一个 tick 试解析，不抛错且有数据即采用）
  const probe = sampleTicks.slice(0, 1);
  const resolve = (cands) => {
    for (const f of cands) { try { const r = parseTicks(demoPath, [f], probe); if (r && r.length) return f; } catch (_) {} }
    return null;
  };
  const equipField = resolve(['current_equip_value', 'equipment_value', 'total_value', 'round_start_equip_value']);
  const moneyField = resolve(['balance', 'account', 'money', 'cash']);
  const spentField = resolve(['cash_spent_this_round', 'total_cash_spent', 'cash_spent']);
  if (!equipField && !moneyField) return null;

  const fields = [equipField, moneyField, spentField, 'team_num'].filter(Boolean);
  let rows = [];
  try { rows = parseTicks(demoPath, fields, sampleTicks) || []; } catch (_) { return null; }
  if (!rows.length) return null;

  // 每位玩家每回合的三组原始数据
  const byId = new Map();
  const teamNumAtR0 = new Map();
  const blank = () => new Array(ROUNDS).fill(0);
  for (const t of rows) {
    const id = toId(t.steamid); if (!id) continue;
    const r = tickToRound.get(t.tick); if (r === undefined) continue;
    if (!byId.has(id)) byId.set(id, { name: t.name || id, equip: blank(), afterMoney: blank(), spent: blank() });
    const o = byId.get(id);
    if (equipField) o.equip[r] = Math.round(t[equipField] || 0);
    if (moneyField) o.afterMoney[r] = Math.round(t[moneyField] || 0);
    if (spentField) o.spent[r] = Math.round(t[spentField] || 0);
    if (r === 0 && t.team_num != null) teamNumAtR0.set(id, t.team_num);
  }
  const teamOf = (id) => { const s = sideOf(teamNumAtR0.get(id)); return s === 'T' ? 'A' : s === 'CT' ? 'B' : null; };

  const players = [];
  const teams = { A: { equip: blank(), startMoney: blank(), earned: blank() }, B: { equip: blank(), startMoney: blank(), earned: blank() } };
  for (const [id, o] of byId.entries()) {
    const team = teamOf(id);
    // 开局金钱(买枪前) = 买枪后剩余 + 本回合花费
    const startMoney = o.afterMoney.map((m, r) => m + (o.spent[r] || 0));
    // 上回合收入：earned[r] = 开局金钱[r+1] − 买枪后剩余[r]
    const earned = blank();
    for (let r = 0; r < ROUNDS - 1; r++) earned[r] = startMoney[r + 1] - o.afterMoney[r];
    players.push({ steamid: id, name: o.name, team, equip: o.equip, startMoney, earned });
    if (team === 'A' || team === 'B') {
      o.equip.forEach((v, r) => { teams[team].equip[r] += v; });
      startMoney.forEach((v, r) => { teams[team].startMoney[r] += v; });
      earned.forEach((v, r) => { teams[team].earned[r] += v; });
    }
  }
  players.sort((a, b) => (a.team || '').localeCompare(b.team || ''));
  return {
    rounds: ROUNDS,
    equipField, moneyField, spentField,
    hasMoney: !!moneyField,
    players, teams,
  };
}


/* =======================================================================
 * 统一解析层：每种事件只解析一次，所有功能共用（加速版）
 *   - 想加新功能：写 computeXxx(EV) 从 EV 取事件即可；用到新事件只需在 EV 加一行
 * ===================================================================== */
const _eventCache = new Map();
function getEvent(name, playerProps = [], otherProps = []) {
  if (_eventCache.has(name)) return _eventCache.get(name);     // 命中缓存：不再解析
  const rows = safeEvent(filePath, name, playerProps, otherProps);
  _eventCache.set(name, rows);
  return rows;
}

try {
  // 地图名 / 名单：各只解析一次
  let header = {};
  try { header = parseHeader(filePath) || {}; } catch (e) {}
  const mapName = (header && header.map_name) ? header.map_name : "DefaultMap";
  let roster = [];
  try { roster = parsePlayerInfo(filePath) || []; } catch (e) {}

  // 所有事件：每种只解析一次（props 取各功能所需字段的并集）
  const EV = {
    roster,
    deaths:   getEvent('player_death',        ['X', 'Y', 'team_num'], ['total_rounds_played', 'is_warmup_period']),
    hurts:    getEvent('player_hurt',         ['team_num'],           ['total_rounds_played', 'is_warmup_period']),
    ends:     getEvent('round_end',           [],                     ['total_rounds_played', 'is_warmup_period']),
    plants:   getEvent('bomb_planted',        [],                     ['is_warmup_period']),
    defuses:  getEvent('bomb_defused',        [],                     ['is_warmup_period']),
    explodes: getEvent('bomb_exploded',       [],                     ['is_warmup_period']),
    smokes:   getEvent('smokegrenade_detonate'),
    molotovs: getEvent('inferno_startburn'),
    flashes:  getEvent('flashbang_detonate'),
    grenades: getEvent('hegrenade_detonate'),
    fires:    getEvent('weapon_fire'),        // 开火次数
    nades:    getEvent('grenade_thrown'),     // 投掷物总数
    freezeEnds: getEvent('round_freeze_end'), // 每回合买枪结束时刻（用于经济采样）
  };

  // 坐标提取（玩家死亡 user_X / 道具爆炸 x）—— 复用 EV.deaths，不再单独解析
  function extractCoords(events, fallbackX = 'x', fallbackY = 'y') {
    const points = [];
    events.forEach(e => {
      const px = e.user_X !== undefined ? e.user_X : e[fallbackX];
      const py = e.user_Y !== undefined ? e.user_Y : e[fallbackY];
      if (px !== undefined && py !== undefined && !isNaN(px) && !isNaN(py)) {
        points.push({ x: px, y: py });
      }
    });
    return points;
  }

  // 三个功能共用同一份 EV，互不重复解析
  let scoreboard = { rounds: 0, players: [] };
  try { scoreboard = computeScoreboard(EV); } catch (e) { /* 忽略，仍返回其它结果 */ }

  let advanced = null;
  try { advanced = computeAdvanced(EV); } catch (e) { advanced = null; }

  let economy = null;
  try { economy = computeEconomy(EV, filePath); } catch (e) { economy = null; }

  let timeline = null;
  try { timeline = computeRoundTimeline(EV); } catch (e) { timeline = null; }

  const result = {
    map_name: mapName,
    kills: extractCoords(EV.deaths, "X", "Y"),
    smokes: extractCoords(EV.smokes),
    molotovs: extractCoords(EV.molotovs),
    flashes: extractCoords(EV.flashes),
    grenades: extractCoords(EV.grenades),
    scoreboard, // ← 计分板：{ rounds, players: [...] }
    advanced,   // ← 对位/进阶：{ map, players, duels }
    economy,    // ← 经济：{ rounds, field, players:[{...,values[]}], teams:{A[],B[]} }
    timeline,   // ← 逐回合进度条：{ rounds, items, halfSplits, score }
  };

  console.log(JSON.stringify(result));

} catch (e) {
  console.error("解析脚本发生错误:", e.message);
  process.exit(1);
}
