const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// 1. 获取页面元素 (注意这里使用了新的 ID)
const dropZone = document.getElementById('drop-zone');
const title = document.getElementById('drop-title');
const mapContainer = document.getElementById('map-container');
const canvas = document.getElementById('heatmap-canvas');
const ctx = canvas.getContext('2d');

// ================= 2. 建立全局地图配置字典 (CS2 核心图池全覆盖) =================
const MAP_CONFIGS = {
    "de_mirage":  { pos_x: -3230, pos_y: 1713, scale: 5.0,  imagePath: "./maps/de_mirage.jpg" },
    "de_inferno": { pos_x: -2087, pos_y: 3870, scale: 4.9,  imagePath: "./maps/de_inferno.jpg" },
    "de_dust2":   { pos_x: -2476, pos_y: 3239, scale: 4.4,  imagePath: "./maps/de_dust2.jpg" },
    "de_nuke":    { pos_x: -3453, pos_y: 2887, scale: 7.0,  imagePath: "./maps/de_nuke.jpg" },
    "de_overpass":{ pos_x: -4831, pos_y: 1781, scale: 5.2,  imagePath: "./maps/de_overpass.jpg" },
    "de_vertigo": { pos_x: -3168, pos_y: 1762, scale: 4.0,  imagePath: "./maps/de_vertigo.jpg" },
    "de_ancient": { pos_x: -2953, pos_y: 2164, scale: 5.0,  imagePath: "./maps/de_ancient.jpg" },
    "de_anubis":  { pos_x: -2796, pos_y: 3328, scale: 5.22, imagePath: "./maps/de_anubis.jpg" },
    "de_train":   { pos_x: -2477, pos_y: 2392, scale: 4.7,  imagePath: "./maps/de_train.jpg" }
};

// 3. 坐标转换公式
function gameToPixel(gameX, gameY, config) {
    return {
        x: (gameX - config.pos_x) / config.scale,
        y: (config.pos_y - gameY) / config.scale
    };
}

// ================= 核心全局状态 =================
let currentDemoData = null; // 记住当前 Demo 数据，复选框切换时秒切

// ================= 动态绘制引擎 =================
function renderDemoData(data) {
    currentDemoData = data;

    title.innerText = "analysizing complete";
    title.style.color = "#4ade80";

    redrawCanvas();

    // 新增：渲染计分板 + 对位/进阶数据
    if (data.timeline) renderTimeline(data.timeline);
    if (data.scoreboard) renderScoreboard(data.scoreboard, data.map_name);
    if (data.advanced) renderAdvanced(data.advanced, data.map_name);
    if (data.economy) renderEconomy(data.economy);
}

function redrawCanvas() {
    if (!currentDemoData) return;

    const mapName = currentDemoData.map_name;
    const currentMapConfig = MAP_CONFIGS[mapName];

    if (!currentMapConfig) {
        alert(`currently we do not support map: ${mapName}`);
        return;
    }

    mapContainer.classList.remove('hidden');
    mapContainer.style.backgroundImage = "url('" + currentMapConfig.imagePath + "')";

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'screen';

    const showKills = document.getElementById('filter-kills').checked;
    const showSmokes = document.getElementById('filter-smokes').checked;
    const showMolotovs = document.getElementById('filter-molotovs').checked;
    const showFlashes = document.getElementById('filter-flashes').checked;
    const showGrenades = document.getElementById('filter-grenades').checked;

    if (showKills) drawPoints(currentDemoData.kills, currentMapConfig, 'rgba(255, 50, 50, 0.9)');
    if (showSmokes) drawPoints(currentDemoData.smokes, currentMapConfig, 'rgba(200, 200, 200, 0.8)');
    if (showMolotovs) drawPoints(currentDemoData.molotovs, currentMapConfig, 'rgba(255, 120, 0, 0.9)');
    if (showFlashes) drawPoints(currentDemoData.flashes, currentMapConfig, 'rgba(100, 255, 255, 0.8)');
    if (showGrenades) drawPoints(currentDemoData.grenades, currentMapConfig, 'rgba(255, 215, 0, 0.9)');
}

function drawPoints(pointsArray, config, centerColor) {
    if (!pointsArray || pointsArray.length === 0) return;
    const colorBase = centerColor.substring(0, centerColor.lastIndexOf(','));
    const transparentEdge = colorBase + ', 0)';
    pointsArray.forEach(point => {
        const pos = gameToPixel(point.x, point.y, config);
        const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 18);
        gradient.addColorStop(0, centerColor);
        gradient.addColorStop(1, transparentEdge);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 18, 0, Math.PI * 2);
        ctx.fill();
    });
}

// ================= 绑定左侧复选框 =================
const checkboxes = ['filter-kills', 'filter-smokes', 'filter-molotovs', 'filter-flashes', 'filter-grenades'];
checkboxes.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
        redrawCanvas();
    });
});


/* =======================================================================
 * 新增：计分板（底部可拉动抽屉）
 * ===================================================================== */
let SCOREBOARD = null;   // { rounds, players: [...] }
let TIMELINE = null;     // { rounds, items, halfSplits, score }
let ADVANCED = null;     // { map, players, duels }
let ECONOMY = null;      // { rounds, players:[{...equip[],startMoney[],earned[]}], teams:{A,B} }
let ECO_SHOWN = { teamEquip: null, playerEquip: null, teamMoney: null, playerMoney: null };
let SIDE = 'both';       // 'both' | 'T' | 'CT'
let ACTIVE_TAB = 'scoreboard'; // 'scoreboard' | 'matchups' | 'economy'

const drawer = document.getElementById('scoreboard-drawer');
const drawerHandle = document.getElementById('drawer-handle');
const drawerToggle = document.getElementById('drawer-toggle');
const sbEmpty = document.getElementById('sb-empty');
const sbContent = document.getElementById('sb-content');
const ratingChart = document.getElementById('rating-chart');
const roundTimeline = document.getElementById('round-timeline');
const sbTables = document.getElementById('sb-tables');
const sbMeta = document.getElementById('sb-meta');
const sideToggle = document.getElementById('side-toggle');
const drawerTabs = document.getElementById('drawer-tabs');
const advContent = document.getElementById('adv-content');
const mapSummary = document.getElementById('map-summary');
const duelMatrix = document.getElementById('duel-matrix');
const hthExtra = document.getElementById('hth-extra');
const advTables = document.getElementById('adv-tables');
const ecoContent = document.getElementById('eco-content');
const ECO_EL = {
  teamEquip:   { toggles: document.getElementById('eco-team-equip-toggles'),   chart: document.getElementById('eco-team-equip-chart') },
  playerEquip: { toggles: document.getElementById('eco-player-equip-toggles'), chart: document.getElementById('eco-player-equip-chart') },
  teamMoney:   { toggles: document.getElementById('eco-team-money-toggles'),   chart: document.getElementById('eco-team-money-chart') },
  playerMoney: { toggles: document.getElementById('eco-player-money-toggles'), chart: document.getElementById('eco-player-money-chart') },
};

let lastHeight = 360; // 记住展开高度

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ratingClass = (r) => (r >= 1.0 ? 'good' : 'bad');
const signedPct = (x) => (x > 0 ? `+${x}%` : `${x}%`);

// 列定义：表头 + 取值函数
const COLUMNS = [
  { head: 'Op. K-D', cell: (s) => `${s.opK} : ${s.opD}` },
  { head: 'MKs',     cell: (s) => s.mk },
  { head: 'KAST',    cell: (s) => `${s.kast}%` },
  { head: '1vsX',    cell: (s) => s.clutches },
  { head: 'K (hs)',  cell: (s) => `${s.kills} <span class="sub">(${s.hs})</span>` },
  { head: 'A (f)',   cell: (s) => `${s.assists} <span class="sub">(${s.flashAssists})</span>` },
  { head: 'D (t)',   cell: (s) => `${s.deaths} <span class="sub">(${s.tradedDeaths})</span>` },
  { head: 'ADR',     cell: (s) => s.adr.toFixed(1) },
  { head: 'Swing',   cell: (s) => `<span class="swing ${s.swing >= 0 ? 'pos' : 'neg'}">${signedPct(s.swing)}</span>` },
  { head: 'Rating',  cell: (s) => `<span class="rating ${ratingClass(s.rating)}">${s.rating.toFixed(2)}</span>` },
];

function renderScoreboard(sb, mapName) {
  SCOREBOARD = sb;
  if (sb && sb.players && sb.players.length) {
    sbMeta.textContent = `${mapName || ''}  ·  ${sb.rounds} rounds`;
    renderRatingChart();
    renderTables();
    openDrawer(); // 解析完自动展开
  }
  showActivePanel();
}

function renderScoreboardInner() {
  if (!SCOREBOARD) return;
  renderRatingChart();
  renderTables();
}

/* ---------- 逐回合胜负进度条（CS Tab 风格） ---------- */
function renderTimeline(tl) {
  TIMELINE = tl;
  if (!tl || !tl.items || !tl.items.length) { roundTimeline.innerHTML = ''; return; }
  const splits = new Set(tl.halfSplits || []);
  const sideClass = (s) => (s === 'T' ? 'tl-t' : s === 'CT' ? 'tl-ct' : '');

  const cell = (team, it) => {
    const idx = it.round - 1;
    const split = splits.has(idx) ? ' tl-split' : '';
    const won = it.winnerTeam === team;
    const side = team === 'A' ? it.teamASide : it.teamBSide;
    if (won) return `<div class="tl-cell ${sideClass(side)}${split}" title="回合 ${it.round} · Team ${team} 胜 (${side || '?'})"></div>`;
    return `<div class="tl-cell tl-empty${split}" title="回合 ${it.round} · Team ${team} 负"></div>`;
  };
  const tick = (it) => {
    const split = splits.has(it.round - 1) ? ' tl-split' : '';
    return `<div class="tl-tick${split}">${it.round % 5 === 0 ? it.round : ''}</div>`;
  };
  const rowCells = (team) => tl.items.map((it) => cell(team, it)).join('');
  const ticks = tl.items.map(tick).join('');

  const label = (team) => `
    <div class="tl-label">
      <span class="tl-team">Team ${team}</span>
      <span class="tl-halfscore" title="各半场胜场 (1st · 2nd · ...)">${tl.score[team].join(' · ')}</span>
    </div>`;

  roundTimeline.innerHTML = `
    <div class="tl-line">${label('A')}<div class="tl-cells">${rowCells('A')}</div></div>
    <div class="tl-line">${label('B')}<div class="tl-cells">${rowCells('B')}</div></div>
    <div class="tl-line"><div class="tl-label"></div><div class="tl-cells tl-ticks">${ticks}</div></div>`;
}

// 根据当前 tab + 数据，决定显示哪个面板
function showActivePanel() {
  const hasSb = SCOREBOARD && SCOREBOARD.players && SCOREBOARD.players.length;
  const hasAdv = ADVANCED && ADVANCED.players && ADVANCED.players.length;
  const hasEco = ECONOMY && ECONOMY.players && ECONOMY.players.length;
  const tab = ACTIVE_TAB;
  sideToggle.style.display = tab === 'scoreboard' ? '' : 'none'; // Side 切换只对计分板有意义

  sbContent.classList.toggle('hidden', !(tab === 'scoreboard' && hasSb));
  advContent.classList.toggle('hidden', !(tab === 'matchups' && hasAdv));
  ecoContent.classList.toggle('hidden', !(tab === 'economy' && hasEco));

  const has = { scoreboard: hasSb, matchups: hasAdv, economy: hasEco };
  const empty = !has[tab];
  sbEmpty.classList.toggle('hidden', !empty);
  if (empty) {
    const msg = {
      scoreboard: '拖入 demo 后这里会显示计分板',
      matchups: '拖入 demo 后这里会显示对位 / 进阶数据',
      economy: '拖入 demo 后这里会显示经济曲线（若为空，可能是装备价值字段名需确认）',
    };
    sbEmpty.textContent = msg[tab];
  }
}

function renderRatingChart() {
  const players = [...SCOREBOARD.players].sort(
    (a, b) => b.stats[SIDE].rating - a.stats[SIDE].rating);
  const maxR = Math.max(1.5,
    Math.ceil(Math.max(...players.map((p) => p.stats[SIDE].rating)) * 10) / 10 + 0.05);
  const badEnd = (0.85 / maxR) * 100;
  const avgEnd = (1.15 / maxR) * 100;
  ratingChart.style.setProperty('--bad-end', `${badEnd}%`);
  ratingChart.style.setProperty('--avg-end', `${avgEnd}%`);

  ratingChart.innerHTML = players.map((p) => {
    const r = p.stats[SIDE].rating;
    const w = Math.max(2, (r / maxR) * 100);
    const teamCls = p.team === 'A' ? 'a' : 'b';
    return `
      <div class="chart-row">
        <div class="who" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="track">
          <div class="bar ${teamCls}" style="width:${w}%"></div>
          <div class="bar-val" style="left:${w}%">${r.toFixed(2)}</div>
        </div>
      </div>`;
  }).join('');
}

function renderTables() {
  const teams = ['A', 'B'].filter((t) => SCOREBOARD.players.some((p) => p.team === t));
  const headCells = COLUMNS.map((c) => `<th>${c.head}</th>`).join('');
  const sections = teams.map((team) => {
    const rows = SCOREBOARD.players
      .filter((p) => p.team === team)
      .sort((a, b) => b.stats[SIDE].rating - a.stats[SIDE].rating);
    const dot = team === 'A' ? 'a' : 'b';
    const teamRow = `<tr class="team-row"><td class="team-name" colspan="${COLUMNS.length + 1}">Team ${team}</td></tr>`;
    const body = rows.map((p) => {
      const s = p.stats[SIDE];
      const cells = COLUMNS.map((c) => `<td>${c.cell(s)}</td>`).join('');
      return `<tr><td class="player"><span class="dot ${dot}"></span>${escapeHtml(p.name)}</td>${cells}</tr>`;
    }).join('');
    return teamRow + body;
  }).join('');
  sbTables.innerHTML = `
    <table class="sb-table">
      <thead><tr><th class="hdr-name">Player</th>${headCells}</tr></thead>
      <tbody>${sections}</tbody>
    </table>`;
}

/* ---------- 对位 / 进阶数据渲染 ---------- */
function renderAdvanced(adv, mapName) {
  ADVANCED = adv;
  if (adv && adv.players && adv.players.length) {
    renderMapSummary(adv.map, mapName);
    renderDuelMatrix(adv.duels);
    renderFirepower(adv.players);
    renderAdvTables(adv.players);
  }
  showActivePanel();
}

function renderMapSummary(m, mapName) {
  if (!m) { mapSummary.innerHTML = ''; return; }
  const cards = [
    ['Map', mapName || '-'],
    ['Rounds', m.rounds],
    ['T wins', m.tWins],
    ['CT wins', m.ctWins],
    ['Team A wins', m.teamAWins ?? 0],
    ['Team B wins', m.teamBWins ?? 0],
    ['Bomb plants', m.bombPlanted],
    ['Defuses', m.bombDefused],
    ['Explosions', m.bombExploded],
    ['Open→Win', m.openingKillWinPct + '%'],
    ['A Open→Win', (m.openingKillWinPctA ?? 0) + '%'],
    ['B Open→Win', (m.openingKillWinPctB ?? 0) + '%'],
  ];
  mapSummary.innerHTML = cards.map(([k, v]) =>
    `<div class="stat-card"><div class="sc-val">${escapeHtml(String(v))}</div><div class="sc-key">${k}</div></div>`).join('');
}

// Head-to-head 右侧的火力 / 投掷物小表
function renderFirepower(players) {
  if (!hthExtra) return;
  const teams = ['A', 'B'].filter((t) => players.some((p) => p.team === t));
  const head = `<th class="hdr-name">Player</th><th>Shots</th><th>Acc%</th><th>Nades</th>`;
  const sections = teams.map((team) => {
    const dot = team === 'A' ? 'a' : 'b';
    const rows = players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills);
    const teamRow = `<tr class="team-row"><td class="team-name" colspan="4">Team ${team}</td></tr>`;
    const body = rows.map((p) =>
      `<tr><td class="player"><span class="dot ${dot}"></span>${escapeHtml(p.name)}</td>` +
      `<td>${p.shots ?? 0}</td><td>${p.acc ?? 0}%</td><td>${p.nades ?? 0}</td></tr>`).join('');
    return teamRow + body;
  }).join('');
  hthExtra.innerHTML = `
    <div class="panel-title small">Firepower / Utility</div>
    <table class="sb-table"><thead><tr>${head}</tr></thead><tbody>${sections}</tbody></table>`;
}

function renderDuelMatrix(duels) {
  if (!duels) { duelMatrix.innerHTML = ''; return; }
  const A = duels.players.filter((p) => p.team === 'A');
  const B = duels.players.filter((p) => p.team === 'B');
  const k = duels.kills || {};
  const get = (x, y) => (k[x] && k[x][y]) ? k[x][y] : 0;
  if (!A.length || !B.length) { duelMatrix.innerHTML = '<div class="sb-empty">无法分出两队，无对位数据</div>'; return; }

  const head = '<th class="corner"></th>' + B.map((b) => `<th title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</th>`).join('');
  const rows = A.map((a) => {
    const cells = B.map((b) => {
      const aw = get(a.steamid, b.steamid), bw = get(b.steamid, a.steamid);
      const cls = aw > bw ? 'win' : aw < bw ? 'lose' : '';
      return `<td class="${cls}">${aw} : ${bw}</td>`;
    }).join('');
    return `<tr><th class="rowname" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</th>${cells}</tr>`;
  }).join('');
  duelMatrix.innerHTML = `<table class="duel-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

const clutchStr = (w) => [1, 2, 3, 4, 5].map((x) => w[x] || 0).join('/');
const ADV_COLUMNS = [
  { head: 'K', cell: (p) => p.kills },
  { head: 'HS%', cell: (p) => p.hsPct + '%' },
  { head: 'Op K-D', cell: (p) => `${p.opK} : ${p.opD}` },
  { head: 'Op%', cell: (p) => p.opWinPct + '%' },
  { head: '2K', cell: (p) => p.multi['2k'] },
  { head: '3K', cell: (p) => p.multi['3k'] },
  { head: '4K', cell: (p) => p.multi['4k'] },
  { head: '5K', cell: (p) => p.multi['5k'] },
  { head: 'Clutch 1-5', cell: (p) => `<span class="sub" title="1v1~1v5 残局胜">${clutchStr(p.clutchW)}</span>` },
  { head: 'TK', cell: (p) => p.tradeKills },
  { head: 'TD', cell: (p) => p.tradedDeaths },
  { head: 'Util dmg', cell: (p) => p.utilDmg },
  { head: 'Flashes', cell: (p) => p.flashed },
  { head: 'Fav wpn', cell: (p) => `${escapeHtml(p.favWeapon)} <span class="sub">(${p.favWeaponKills})</span>` },
];

function renderAdvTables(players) {
  const teams = ['A', 'B'].filter((t) => players.some((p) => p.team === t));
  const head = ADV_COLUMNS.map((c) => `<th>${c.head}</th>`).join('');
  const sections = teams.map((team) => {
    const rows = players.filter((p) => p.team === team);
    const dot = team === 'A' ? 'a' : 'b';
    const teamRow = `<tr class="team-row"><td class="team-name" colspan="${ADV_COLUMNS.length + 1}">Team ${team}</td></tr>`;
    const body = rows.map((p) => {
      const cells = ADV_COLUMNS.map((c) => `<td>${c.cell(p)}</td>`).join('');
      return `<tr><td class="player"><span class="dot ${dot}"></span>${escapeHtml(p.name)}</td>${cells}</tr>`;
    }).join('');
    return teamRow + body;
  }).join('');
  advTables.innerHTML = `
    <table class="sb-table">
      <thead><tr><th class="hdr-name">Player</th>${head}</tr></thead>
      <tbody>${sections}</tbody>
    </table>`;
}

/* ---------- 经济渲染（4 张图：装备价值折线 ×2 + 开局金钱柱状 ×2） ---------- */
const ECO_COLORS = ['#e0913a', '#4f93d6', '#7bbf3a', '#d75f5f', '#b07be0', '#46c7c7', '#e6c84f', '#e07ab0', '#7a8cff', '#8fbf6b'];
const TEAM_COLOR = { A: '#e0913a', B: '#4f93d6' };
const money = (v) => '$' + Math.round(v).toLocaleString('en-US');

function renderEconomy(eco) {
  ECONOMY = eco;
  if (!eco || !eco.players || !eco.players.length) { showActivePanel(); return; }
  const allIds = eco.players.map((p) => p.steamid);
  ECO_SHOWN.teamEquip = new Set(['A', 'B']);
  ECO_SHOWN.teamMoney = new Set(['A', 'B']);
  ECO_SHOWN.playerEquip = new Set(allIds);
  ECO_SHOWN.playerMoney = new Set(allIds);
  drawTeamEquip(); drawPlayerEquip(); drawTeamMoney(); drawPlayerMoney();
  showActivePanel();
}

// 通用勾选框：items=[{id,name,color}]；切换后调用 redraw()
function buildToggles(container, items, shownSet, redraw) {
  container.innerHTML = items.map((it) =>
    `<label class="eco-toggle"><input type="checkbox" data-id="${it.id}" ${shownSet.has(it.id) ? 'checked' : ''}>
      <span class="eco-swatch" style="background:${it.color}"></span>${escapeHtml(it.name)}</label>`).join('');
  container.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) shownSet.add(cb.dataset.id); else shownSet.delete(cb.dataset.id);
      redraw();
    });
  });
}

// 通用折线图：series=[{name,color,values[]}]，悬停圆点显示数值（valFmt 控制单位）
function lineChartSVG(series, rounds, valFmt) {
  if (!series.length || !rounds) return '<div class="sb-empty">未选择 / 无数据</div>';
  const W = Math.max(720, 64 + rounds * 46), H = 250;
  const padL = 64, padR = 18, padT = 16, padB = 28;
  const allVals = series.flatMap((s) => s.values.filter((v) => v != null));
  const maxY = Math.max(1000, Math.ceil((Math.max(...allVals, 0) + 1) / 1000) * 1000);
  const x = (r) => padL + (rounds <= 1 ? 0 : (r / (rounds - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);
  let grid = '';
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = (maxY / steps) * i, yy = y(val);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#2a2a2a"/>`;
    grid += `<text x="${padL - 8}" y="${yy + 3}" text-anchor="end" fill="#888" font-size="10">${valFmt(val)}</text>`;
  }
  let xlabels = '';
  for (let r = 0; r < rounds; r++) xlabels += `<text x="${x(r)}" y="${H - 9}" text-anchor="middle" fill="#888" font-size="10">${r + 1}</text>`;
  const paths = series.map((s) => {
    const pts = s.values.map((v, r) => (v == null ? null : `${x(r)},${y(v)}`)).filter(Boolean);
    const d = pts.length ? 'M' + pts.join(' L') : '';
    const dots = s.values.map((v, r) => v == null ? '' :
      `<circle cx="${x(r)}" cy="${y(v)}" r="3" fill="${s.color}"><title>${escapeHtml(s.name)} · 回合${r + 1}: ${valFmt(v)}</title></circle>`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="eco-svg">${grid}${xlabels}${paths}</svg>`;
}

// 通用分组柱状图：series=[{name,color,values[],extra[]?}]；柱顶显示数值(series≤4时)，悬停显示数值(含 extra)
function barChartSVG(series, rounds, valFmt, extraLabel) {
  if (!series.length || !rounds) return '<div class="sb-empty">未选择 / 无数据</div>';
  const n = series.length;
  const barW = n <= 2 ? 14 : n <= 5 ? 8 : 5;
  const groupInner = n * barW + (n - 1) * 2;
  const groupW = groupInner + 18;
  const W = Math.max(720, 64 + rounds * groupW), H = 250;
  const padL = 64, padT = 18, padB = 28;
  const allVals = series.flatMap((s) => s.values.filter((v) => v != null));
  const maxY = Math.max(1000, Math.ceil((Math.max(...allVals, 0) + 1) / 1000) * 1000);
  const plotH = H - padT - padB;
  const y = (v) => padT + (1 - v / maxY) * plotH;
  const showTop = n <= 4;
  let grid = '';
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = (maxY / steps) * i, yy = y(val);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - 12}" y2="${yy}" stroke="#2a2a2a"/>`;
    grid += `<text x="${padL - 8}" y="${yy + 3}" text-anchor="end" fill="#888" font-size="10">${valFmt(val)}</text>`;
  }
  let bars = '', xlabels = '';
  for (let r = 0; r < rounds; r++) {
    const gx = padL + r * groupW + 9;
    xlabels += `<text x="${gx + groupInner / 2}" y="${H - 9}" text-anchor="middle" fill="#888" font-size="10">${r + 1}</text>`;
    series.forEach((s, i) => {
      const v = s.values[r] || 0;
      const bx = gx + i * (barW + 2);
      const by = y(v), bh = padT + plotH - by;
      const extra = s.extra ? `；${extraLabel} ${valFmt(s.extra[r] || 0)}` : '';
      bars += `<rect x="${bx}" y="${by}" width="${barW}" height="${Math.max(0, bh)}" fill="${s.color}" rx="1">
        <title>${escapeHtml(s.name)} · 回合${r + 1}: ${valFmt(v)}${extra}</title></rect>`;
      if (showTop && v > 0) bars += `<text x="${bx + barW / 2}" y="${by - 3}" text-anchor="middle" fill="#bbb" font-size="8">${Math.round(v / 100) / 10}k</text>`;
    });
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="eco-svg">${grid}${xlabels}${bars}</svg>`;
}

// —— 四张图各自的绘制 ——
function teamItems() { return ['A', 'B'].filter((t) => ECONOMY.teams[t]).map((t) => ({ id: t, name: 'Team ' + t, color: TEAM_COLOR[t] })); }
function playerItems() { return ECONOMY.players.map((p, i) => ({ id: p.steamid, name: p.name, color: ECO_COLORS[i % ECO_COLORS.length] })); }

function drawTeamEquip() {
  buildToggles(ECO_EL.teamEquip.toggles, teamItems(), ECO_SHOWN.teamEquip, drawTeamEquip);
  const series = teamItems().filter((it) => ECO_SHOWN.teamEquip.has(it.id))
    .map((it) => ({ name: it.name, color: it.color, values: ECONOMY.teams[it.id].equip }));
  ECO_EL.teamEquip.chart.innerHTML = lineChartSVG(series, ECONOMY.rounds, money);
}
function drawPlayerEquip() {
  buildToggles(ECO_EL.playerEquip.toggles, playerItems(), ECO_SHOWN.playerEquip, drawPlayerEquip);
  const series = ECONOMY.players.map((p, i) => ({ id: p.steamid, name: p.name, color: ECO_COLORS[i % ECO_COLORS.length], values: p.equip }))
    .filter((s) => ECO_SHOWN.playerEquip.has(s.id));
  ECO_EL.playerEquip.chart.innerHTML = lineChartSVG(series, ECONOMY.rounds, money);
}
function drawTeamMoney() {
  buildToggles(ECO_EL.teamMoney.toggles, teamItems(), ECO_SHOWN.teamMoney, drawTeamMoney);
  const series = teamItems().filter((it) => ECO_SHOWN.teamMoney.has(it.id))
    .map((it) => ({ name: it.name, color: it.color, values: ECONOMY.teams[it.id].startMoney, extra: ECONOMY.teams[it.id].earned }));
  ECO_EL.teamMoney.chart.innerHTML = barChartSVG(series, ECONOMY.rounds, money, '上回合收入');
}
function drawPlayerMoney() {
  buildToggles(ECO_EL.playerMoney.toggles, playerItems(), ECO_SHOWN.playerMoney, drawPlayerMoney);
  const series = ECONOMY.players.map((p, i) => ({ id: p.steamid, name: p.name, color: ECO_COLORS[i % ECO_COLORS.length], values: p.startMoney, extra: p.earned }))
    .filter((s) => ECO_SHOWN.playerMoney.has(s.id));
  ECO_EL.playerMoney.chart.innerHTML = barChartSVG(series, ECONOMY.rounds, money, '上回合收入');
}

// ----- 抽屉：展开 / 收起 -----
function openDrawer(h) {
  drawer.classList.remove('collapsed');
  drawer.style.height = (h || lastHeight) + 'px';
  drawerToggle.textContent = '▼';
}
function collapseDrawer() {
  drawer.classList.add('collapsed');
  drawer.style.height = '';
  drawerToggle.textContent = '▲';
}
drawerToggle.addEventListener('click', () => {
  if (drawer.classList.contains('collapsed')) openDrawer(lastHeight);
  else collapseDrawer();
});

// ----- 抽屉：拖动顶部边缘调整高度 -----
let dragging = false;
drawerHandle.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return; // 避开按钮，不触发拖拽
  dragging = true;
  drawerHandle.setPointerCapture(e.pointerId);
  drawer.classList.add('dragging');
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const h = Math.min(window.innerHeight * 0.85, Math.max(120, window.innerHeight - e.clientY));
  drawer.classList.remove('collapsed');
  drawer.style.height = h + 'px';
  lastHeight = h;
  drawerToggle.textContent = '▼';
});
window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  drawer.classList.remove('dragging');
});

// ----- Side 切换（Both / T / CT），只重渲染不重新解析 -----
document.getElementById('side-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-side]');
  if (!btn) return;
  SIDE = btn.dataset.side;
  document.querySelectorAll('#side-toggle button')
    .forEach((b) => b.classList.toggle('active', b === btn));
  if (SCOREBOARD) renderScoreboardInner();
});

// ----- Tab 切换（Scoreboard / Matchups & Stats） -----
drawerTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  ACTIVE_TAB = btn.dataset.tab;
  drawerTabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  if (drawer.classList.contains('collapsed')) openDrawer();
  showActivePanel();
});


// ================= 系统拖拽事件监听 =================
listen('tauri://drag-enter', () => dropZone.classList.add('dragover'));
listen('tauri://drag-leave', () => dropZone.classList.remove('dragover'));

listen('tauri://drag-drop', (event) => {
  dropZone.classList.remove('dragover');
  const filePaths = event.payload.paths ? event.payload.paths : event.payload;

  if (filePaths && filePaths.length > 0) {
    const filePath = filePaths[0];

    if (filePath.endsWith('.dem')) {
      title.innerText = "🔄 analysing...";
      title.style.color = "#eab308";

      console.log("正在发送给 Rust:", filePath);

      invoke('parse_demo_file', { filePath: filePath })
        .then((response) => {
            const parsedData = JSON.parse(response);
            renderDemoData(parsedData);
        })
        .catch((error) => {
            console.error("call Rust failed:", error);
            title.innerText = "analysis failed";
            title.style.color = "#f87171";
        });
    } else {
      title.innerText = "format error";
      title.style.color = "#f87171";
    }
  }
});

console.log("💥 main.js 已加载完毕（含计分板）。");
