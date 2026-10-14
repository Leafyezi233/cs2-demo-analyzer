/* CS2 数据面板 前端 —— 无构建链，直接 ES2020 */
'use strict';

const $ = (s) => document.querySelector(s);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) { /* ignore */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
};

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 7000 : 3500);
}

const state = {
  matchId: null, match: null, players: [], rounds: [], economy: [], heatType: 'kills',
  matches: [], selected: new Set(),
  heatFilter: { round_num: '', side: '', weapon: '' },
  weapons: [],
  replay: null, replayRound: null, replayFrame: 0, replayTimer: null, replaySpeed: 1,
  compare: [],
};
const charts = {};

function chart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (!charts[id]) charts[id] = echarts.init(el, 'dark');
  return charts[id];
}
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));

/* ------------------------------------------------------------------ 导航 */
const PAGES = ['home', 'match', 'players', 'map', 'replay', 'compare'];
function show(page) {
  PAGES.forEach((p) => $('#page-' + p).classList.toggle('hidden', p !== page));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 60);
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  if (b.classList.contains('hidden')) return;
  show(b.dataset.page);
  if (b.dataset.page === 'map' && state.matchId) loadHeat(state.heatType);
  if (b.dataset.page === 'replay') enterReplayPage();
  if (b.dataset.page === 'compare') enterComparePage();
}));

/* ------------------------------------------------------------------ 首页 */
async function loadMatches() {
  const list = await api('/api/matches');
  state.matches = list;
  state.selected = new Set([...state.selected].filter((id) => list.some((m) => m.id === id)));
  $('#match-count').textContent = list.length ? '共 ' + list.length + ' 场' : '';
  const box = $('#matches');
  box.innerHTML = '';
  $('#no-matches').classList.toggle('hidden', list.length > 0);
  list.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'match' + (state.selected.has(m.id) ? ' selected' : '');
    div.innerHTML =
      '<input type="checkbox" class="pick" title="加入对比"' + (state.selected.has(m.id) ? ' checked' : '') + '>' +
      '<div class="t" title="' + escapeAttr(m.file_name) + '">' + escapeHtml(m.file_name) + '</div>' +
      '<div class="s"><span class="ct">' + m.ct_score + '</span> : <span class="t">' + m.t_score + '</span></div>' +
      '<div class="dim" style="font-size:12px">' + (m.map_name || '?') + ' · ' + m.round_count + ' 回合' +
      (m.playback_time ? ' · ' + Math.round(m.playback_time / 60) + ' 分钟' : '') + '</div>' +
      '<div class="dim" style="font-size:11px">CT : T</div>';
    div.addEventListener('click', () => openMatch(m.id));
    const pick = div.querySelector('.pick');
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pick.checked) state.selected.add(m.id); else state.selected.delete(m.id);
      div.classList.toggle('selected', pick.checked);
      syncCompareBar();
    });
    box.appendChild(div);
  });
  syncCompareBar();
}

function syncCompareBar() {
  const n = state.selected.size;
  const btn = $('#btn-compare');
  btn.disabled = n < 2;
  $('#sel-hint').textContent = n === 0
    ? '勾选 2 场以上可比对（当前工作区只有 ' + state.matches.length + ' 场，可用同一场验证 UI）'
    : '已选 ' + n + ' 场' + (n < 2 ? '，至少再选 1 场' : '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

/* 上传 / 拖拽 */
const drop = $('#drop');
const fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files.length) upload(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) upload(fileInput.files[0]); });

async function upload(file) {
  if (!/\.dem$/i.test(file.name)) { toast('只接受 .dem 文件', true); return; }
  toast('正在上传 ' + file.name + '（' + (file.size / 1048576).toFixed(0) + ' MB）…');
  try {
    // 后端按原始字节流接收（不依赖 python-multipart），文件名走查询参数
    const r = await api('/api/demos?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    pollTask(r.task_id, file.name);
  } catch (e) { toast('上传失败：' + e.message, true); }
}

function pollTask(taskId, name) {
  const box = $('#task-box');
  box.classList.remove('hidden');
  $('#task-name').textContent = name;
  const tick = async () => {
    let t;
    try { t = await api('/api/tasks/' + taskId); } catch (e) { toast('查询任务失败：' + e.message, true); return; }
    $('#task-stage').textContent = t.stage + '（' + Math.round(t.progress * 100) + '%）';
    $('#task-bar').style.width = (t.progress * 100) + '%';
    if (t.status === 'done') {
      toast('解析完成，用时 ' + t.seconds + ' 秒');
      box.classList.add('hidden');
      await loadMatches();
      openMatch(t.match_id);
    } else if (t.status === 'failed') {
      toast('解析失败：' + t.error, true);
      box.classList.add('hidden');
    } else {
      setTimeout(tick, 800);
    }
  };
  tick();
}

/* 扫描本机录像 */
$('#btn-scan').addEventListener('click', async () => {
  $('#scan-hint').textContent = '扫描中…';
  try {
    const r = await api('/api/demos/scan', { method: 'POST' });
    $('#scan-hint').textContent = '找到 ' + r.total + ' 个 .dem';
    const box = $('#scan-list');
    box.innerHTML = '';
    if (!r.found.length) { box.innerHTML = '<div class="dim">未在常见 Steam 目录找到录像，可直接拖入文件。</div>'; return; }
    r.found.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginBottom = '6px';
      row.innerHTML = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        escapeHtml(f.name) + '</span><span class="dim" style="font-size:12px">' + (f.size / 1048576).toFixed(0) + ' MB</span>';
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '解析';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await api('/api/demos/local?path=' + encodeURIComponent(f.path), { method: 'POST' });
          pollTask(res.task_id, f.name);
        } catch (e) { toast('提交失败：' + e.message, true); btn.disabled = false; }
      });
      row.appendChild(btn);
      box.appendChild(row);
    });
  } catch (e) { $('#scan-hint').textContent = '扫描失败：' + e.message; }
});

/* ------------------------------------------------------------------ 比赛页 */
async function openMatch(id) {
  const switching = state.matchId !== id;
  state.matchId = id;
  if (switching) {
    // 换比赛：回放轨迹与地图筛选必须重置，否则会拿上一场的数据画
    stopPlayback();
    state.replay = null;
    state.replayFrame = 0;
    state.mapInfo = null;
    state.heatFilter = { round_num: '', side: '', weapon: '' };
    $('#f-side').value = '';
  }
  const m = await api('/api/matches/' + id);
  state.match = m;
  ['nav-match', 'nav-players', 'nav-map', 'nav-replay', 'nav-compare'].forEach((n) => $('#' + n).classList.remove('hidden'));
  $('#ctx').textContent = (m.map_name || '') + ' · ' + m.file_name;
  $('#match-title').textContent = m.map_name + '  ·  ' + m.ct_score + ' : ' + m.t_score;
  $('#match-meta').innerHTML =
    '<span class="pill ct">CT ' + m.ct_score + '</span><span class="pill t">T ' + m.t_score + '</span>' +
    '<span class="pill">' + m.round_count + ' 回合</span>' +
    '<span class="pill">' + (m.tick_rate || '?') + ' tick</span>' +
    '<span class="pill">解析 ' + (m.parse_seconds || '?') + 's</span>' +
    (m.server_name ? '<span class="dim" style="font-size:12px">' + escapeHtml(m.server_name) + '</span>' : '');

  const [r, p] = await Promise.all([api('/api/matches/' + id + '/rounds'), api('/api/matches/' + id + '/players')]);
  state.rounds = r.rounds || [];
  state.economy = r.economy || [];
  state.players = p || [];
  renderEconomy();
  renderRounds();
  renderRoundsTable();
  renderPlayers();
  await prepareHeatFilters();
  prepareReplayRounds();
  show('match');
}

/* 地图页筛选器：回合下拉 + 武器下拉（武器列表来自后端，已合并 kills/shots 两种前缀） */
async function prepareHeatFilters() {
  const sel = $('#f-round');
  sel.innerHTML = '<option value="">全部</option>' + state.rounds
    .map((r) => '<option value="' + r.round_num + '">第 ' + r.round_num + ' 回合' + (r.is_knife_round ? '（刀局）' : '') + '</option>').join('');
  sel.value = state.heatFilter.round_num;
  try {
    const r = await api('/api/matches/' + state.matchId + '/weapons');
    state.weapons = r.weapons || [];
  } catch (e) { state.weapons = []; }
  const wsel = $('#f-weapon');
  wsel.innerHTML = '<option value="">全部</option>' + state.weapons
    .map((w) => '<option value="' + escapeAttr(w.name) + '">' + escapeHtml(w.name) + '（击杀 ' + w.kills + ' · 射击 ' + w.shots + '）</option>').join('');
  wsel.value = state.heatFilter.weapon;
  // 筛选变化后重画（每次都会重取，点集不大）
  $('#f-round').onchange = () => { state.heatFilter.round_num = $('#f-round').value; loadHeat(state.heatType); };
  $('#f-side').onchange = () => { state.heatFilter.side = $('#f-side').value; loadHeat(state.heatType); };
  $('#f-weapon').onchange = () => { state.heatFilter.weapon = $('#f-weapon').value; loadHeat(state.heatType); };
}

function renderEconomy() {
  const c = chart('chart-economy');
  if (!c) return;
  const rounds = [...new Set(state.economy.map((e) => e.round_num))].sort((a, b) => a - b);
  const pick = (side) => rounds.map((n) => {
    const row = state.economy.find((e) => e.round_num === n && e.side === side);
    return row ? row.equipment_value : null;
  });
  const buy = (side) => rounds.map((n) => {
    const row = state.economy.find((e) => e.round_num === n && e.side === side);
    return row ? row.buy_type : '';
  });
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      formatter: (ps) => '第 ' + ps[0].axisValue + ' 回合<br>' + ps.map((p) =>
        p.marker + p.seriesName + '：$' + (p.value == null ? '-' : p.value)).join('<br>') +
        '<br><span style="opacity:.7">CT 买法 ' + buy('counter-terrorist')[rounds.indexOf(ps[0].axisValue)] +
        ' · T 买法 ' + buy('terrorist')[rounds.indexOf(ps[0].axisValue)] + '</span>',
    },
    legend: { data: ['CT 装备价值', 'T 装备价值'], textStyle: { color: '#8b98a5' } },
    grid: { left: 60, right: 20, top: 40, bottom: 34 },
    xAxis: { type: 'category', data: rounds.map((n) => 'R' + n), axisLine: { lineStyle: { color: '#2a3441' } } },
    yAxis: { type: 'value', name: '装备价值 $', splitLine: { lineStyle: { color: '#212a34' } } },
    series: [
      { name: 'CT 装备价值', type: 'line', smooth: true, data: pick('counter-terrorist'),
        itemStyle: { color: '#4a90d9' }, areaStyle: { opacity: .12 } },
      { name: 'T 装备价值', type: 'line', smooth: true, data: pick('terrorist'),
        itemStyle: { color: '#d9a24a' }, areaStyle: { opacity: .12 } },
    ],
  });
}

function renderRounds() {
  const c = chart('chart-rounds');
  if (!c) return;
  const reasons = [...new Set(state.rounds.map((r) => r.reason_name))];
  const ct = reasons.map((rn) => state.rounds.filter((r) => r.reason_name === rn && r.winner_side === 'counter-terrorist').length);
  const t = reasons.map((rn) => state.rounds.filter((r) => r.reason_name === rn && r.winner_side === 'terrorist').length);
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['CT 获胜', 'T 获胜'], textStyle: { color: '#8b98a5' } },
    grid: { left: 60, right: 20, top: 40, bottom: 60 },
    xAxis: { type: 'category', data: reasons, axisLabel: { rotate: 30, fontSize: 11 }, axisLine: { lineStyle: { color: '#2a3441' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#212a34' } } },
    series: [
      { name: 'CT 获胜', type: 'bar', stack: 'w', data: ct, itemStyle: { color: '#4a90d9' } },
      { name: 'T 获胜', type: 'bar', stack: 'w', data: t, itemStyle: { color: '#d9a24a' } },
    ],
  });
}

function renderRoundsTable() {
  const cols = [['round_num', '回合'], ['winner_side', '胜方'], ['reason_name', '结束原因'],
    ['start_tick', '开始 tick'], ['end_tick', '结束 tick'], ['is_knife_round', '刀局']];
  let html = '<thead><tr>' + cols.map((c) => '<th class="l">' + c[1] + '</th>').join('') + '</tr></thead><tbody>';
  state.rounds.forEach((r) => {
    html += '<tr>' + cols.map((c) => {
      let v = r[c[0]];
      if (c[0] === 'winner_side') v = v === 'counter-terrorist' ? '<span class="pill ct">CT</span>' : '<span class="pill t">T</span>';
      else v = escapeHtml(v);
      return '<td class="l">' + v + '</td>';
    }).join('') + '</tr>';
  });
  $('#tbl-rounds').innerHTML = html + '</tbody>';
}

/* ------------------------------------------------------------------ 玩家页 */
const PLAYER_COLS = [
  ['name', '玩家', 's'], ['side', '阵营', 's'], ['rating', 'Rating≈', 'n'], ['kills', 'K', 'n'],
  ['deaths', 'D', 'n'], ['assists', 'A', 'n'], ['adr', 'ADR', 'n'], ['kast', 'KAST', 'n'],
  ['headshot_pct', '爆头%', 'n'], ['opening_kills', '首杀', 'n'], ['opening_deaths', '首死', 'n'],
  ['clutches_won', '残局胜', 'n'], ['multikill_3k', '3K', 'n'], ['multikill_4k', '4K', 'n'],
  ['multikill_5k', '5K', 'n'], ['utility_damage', '道具伤害', 'n'],
];
let sortKey = 'rating', sortAsc = false;

function renderPlayers() {
  renderPlayerTable();
  renderRadar(state.players[0]);
  renderAdrChart();
}

function renderPlayerTable() {
  const rows = [...state.players].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string' || typeof bv === 'string') return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    return sortAsc ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
  });
  let html = '<thead><tr>' + PLAYER_COLS.map((c) =>
    '<th data-k="' + c[0] + '" class="' + (c[2] === 's' ? 'l' : '') + '">' + c[1] +
    (sortKey === c[0] ? (sortAsc ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr></thead><tbody>';
  rows.forEach((p) => {
    html += '<tr data-sid="' + p.steamid + '">' + PLAYER_COLS.map((c) => {
      let v = p[c[0]];
      if (c[0] === 'side') v = v === 'counter-terrorist' ? '<span class="pill ct">CT</span>' : (v === 'terrorist' ? '<span class="pill t">T</span>' : '-');
      else if (typeof v === 'number') v = (c[0] === 'rating' || c[0] === 'adr' || c[0] === 'kast' || c[0] === 'headshot_pct') ? v.toFixed(2) : v;
      else v = escapeHtml(v == null ? '-' : v);
      return '<td class="' + (c[2] === 's' ? 'l' : '') + '">' + v + '</td>';
    }).join('') + '</tr>';
  });
  const tbl = $('#tbl-players');
  tbl.innerHTML = html + '</tbody>';
  tbl.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
    renderPlayerTable();
  }));
  tbl.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    const p = state.players.find((x) => x.steamid === tr.dataset.sid);
    if (p) renderRadar(p);
  }));
}

function renderRadar(player) {
  const c = chart('chart-radar');
  if (!c || !player) return;
  $('#radar-title').textContent = '雷达图 · ' + player.name;
  const dims = [['kills', '击杀'], ['adr', 'ADR'], ['kast', 'KAST'], ['headshot_pct', '爆头率'],
    ['opening_kills', '首杀'], ['utility_damage', '道具伤害']];
  const maxOf = (k) => Math.max(1, ...state.players.map((p) => Number(p[k]) || 0));
  const mine = dims.map((d, i) => ({ name: d[1], value: (Number(player[d[0]]) || 0) / maxOf(d[0]) }));
  const best = dims.map((d) => ({ name: d[1], value: Math.max(...state.players.map((p) => (Number(p[d[0]]) || 0) / maxOf(d[0]))) }));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: {},
    legend: { data: [player.name, '全场最高'], textStyle: { color: '#8b98a5' }, bottom: 0 },
    radar: {
      indicator: dims.map((d) => ({ name: d[1], max: 1 })),
      radius: '62%', center: ['50%', '48%'],
      axisName: { color: '#8b98a5', fontSize: 11 },
      splitLine: { lineStyle: { color: '#2a3441' } },
      splitArea: { areaStyle: { color: ['rgba(255,255,255,0.015)', 'rgba(255,255,255,0.04)'] } },
      axisLine: { lineStyle: { color: '#2a3441' } },
    },
    series: [{
      type: 'radar',
      data: [
        { value: mine.map((m) => m.value.toFixed(3)), name: player.name, itemStyle: { color: '#f5a623' },
          areaStyle: { color: 'rgba(245,166,35,0.28)' } },
        { value: best.map((m) => m.value.toFixed(3)), name: '全场最高', lineStyle: { type: 'dashed' },
          itemStyle: { color: '#4a90d9' }, areaStyle: { opacity: 0 } },
      ],
    }],
  }, true);
}

function renderAdrChart() {
  const c = chart('chart-adr');
  if (!c) return;
  const rows = [...state.players].sort((a, b) => (b.adr || 0) - (a.adr || 0));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['ADR', 'KAST'], textStyle: { color: '#8b98a5' } },
    grid: { left: 50, right: 55, top: 40, bottom: 70 },
    xAxis: { type: 'category', data: rows.map((p) => p.name), axisLabel: { rotate: 32, fontSize: 11, color: '#8b98a5' } },
    yAxis: [
      { type: 'value', name: 'ADR', splitLine: { lineStyle: { color: '#212a34' } } },
      { type: 'value', name: 'KAST%', max: 100, splitLine: { show: false } },
    ],
    series: [
      { name: 'ADR', type: 'bar', data: rows.map((p) => p.adr), itemStyle: { color: '#f5a623' } },
      { name: 'KAST', type: 'line', yAxisIndex: 1, smooth: true, data: rows.map((p) => p.kast),
        itemStyle: { color: '#4a90d9' }, symbolSize: 7 },
    ],
  }, true);
}

/* ------------------------------------------------------------------ 地图页 */
document.querySelectorAll('[data-heat]').forEach((b) => b.addEventListener('click', () => loadHeat(b.dataset.heat)));

// 调色板：与图例渐变一致（#2f5d8a → #3fb950 → #f5a623 → #f85149）
const HEAT_STOPS = [[47, 93, 138], [63, 185, 80], [245, 166, 35], [248, 81, 73]];
const HEAT_LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (HEAT_STOPS.length - 1);
    const k = Math.min(HEAT_STOPS.length - 2, Math.floor(t));
    const f = t - k;
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = HEAT_STOPS[k][ch] + (HEAT_STOPS[k + 1][ch] - HEAT_STOPS[k][ch]) * f;
  }
  return lut;
})();
const mapInfoCache = {};
async function ensureMapInfo(mapName) {
  if (!mapName) return null;
  if (mapInfoCache[mapName] !== undefined) return mapInfoCache[mapName];
  let info = null;
  try { info = await api('/api/maps/' + encodeURIComponent(mapName) + '/info'); } catch (e) { info = null; }
  mapInfoCache[mapName] = info;
  return info;
}

const radarCache = {};
function loadRadar(mapName) {
  if (radarCache[mapName]) return Promise.resolve(radarCache[mapName]);
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { radarCache[mapName] = im; resolve(im); };
    im.onerror = () => resolve(null);
    im.src = '/api/maps/' + encodeURIComponent(mapName) + '/radar.png';
  });
}

// 在 1024x1024 画布上叠密度图：每个点按高斯核累加，再按最大值取平方根映射到调色板。
function drawDensity(cv, pts, size, baseImg) {
  const W = size[0], H = size[1];
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);
  if (baseImg) { ctx.globalAlpha = 0.9; ctx.drawImage(baseImg, 0, 0, W, H); ctx.globalAlpha = 1; }

  if (!pts.length) return;
  const R = Math.max(9, Math.round(W / 52));
  const fall = new Float32Array(2 * R + 1);
  const sigma = R * 0.5;
  for (let d = -R; d <= R; d++) fall[d + R] = Math.exp(-(d * d) / (2 * sigma * sigma));

  const acc = new Float32Array(W * H);
  for (const p of pts) {
    const cx = Math.round(p[0]), cy = Math.round(p[1]);
    if (cx < -R || cy < -R || cx > W + R || cy > H + R) continue;
    const x0 = Math.max(0, cx - R), x1 = Math.min(W - 1, cx + R);
    const y0 = Math.max(0, cy - R), y1 = Math.min(H - 1, cy + R);
    for (let y = y0; y <= y1; y++) {
      const fy = fall[y - cy + R];
      const row = y * W;
      for (let x = x0; x <= x1; x++) acc[row + x] += fy * fall[x - cx + R];
    }
  }
  let max = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
  if (max <= 0) return;

  const layer = document.createElement('canvas');
  layer.width = W; layer.height = H;
  const lctx = layer.getContext('2d');
  const img = lctx.createImageData(W, H);
  const d = img.data;
  const inv = 1 / max;
  for (let i = 0; i < acc.length; i++) {
    const v = Math.sqrt(acc[i] * inv);            // 平方根压缩，避免单点被热点淹没
    if (v < 0.04) continue;
    const idx = Math.min(255, (v * 255) | 0) * 3;
    const o = i * 4;
    d[o] = HEAT_LUT[idx]; d[o + 1] = HEAT_LUT[idx + 1]; d[o + 2] = HEAT_LUT[idx + 2];
    d[o + 3] = Math.min(215, 40 + v * 200);
  }
  lctx.putImageData(img, 0, 0);
  ctx.drawImage(layer, 0, 0);
}

async function loadHeat(type) {
  if (!state.matchId) return;
  state.heatType = type;
  document.querySelectorAll('[data-heat]').forEach((b) => {
    b.classList.toggle('btn', b.dataset.heat === type);
    b.classList.toggle('ghost', b.dataset.heat !== type);
  });
  const mapName = state.match ? state.match.map_name : null;
  const f = state.heatFilter;
  const qs = new URLSearchParams({ type });
  if (f.round_num) qs.set('round_num', f.round_num);
  if (f.side) qs.set('side', f.side);
  if (f.weapon) qs.set('weapon', f.weapon);
  let data, info = null;
  try { data = await api('/api/matches/' + state.matchId + '/heatmap?' + qs.toString()); }
  catch (e) { toast('取热力图失败：' + e.message, true); return; }
  if (mapName) info = await ensureMapInfo(mapName);
  const bgOk = !!(info && info.radar);
  const size = (info && Array.isArray(info.radar_size) && info.radar_size.length === 2) ? info.radar_size : [1024, 1024];
  $('#map-name').textContent = mapName || '未知地图';
  const parts = [];
  if (f.round_num) parts.push('第 ' + f.round_num + ' 回合');
  if (f.side) parts.push(f.side === 'ct' ? 'CT' : 'T');
  if (f.weapon) parts.push(f.weapon);
  const active = parts.length > 0;
  $('#heat-count').textContent = data.points.length + ' 个点' + (active ? '（筛选后 ' + data.filtered + '/' + data.total + ' 条记录）' : '');
  $('#heat-filter-note').textContent = active ? '已筛选：' + parts.join(' · ') : '';
  $('#map-note').textContent = bgOk
    ? '世界坐标按 awpy 的 (x - pos_x) / scale、(pos_y - y) / scale 换算为雷达图像素，底图与坐标表来自 awpy-data。'
    : '未找到地图资产（mapdata/），下面只显示世界坐标点云；把 awpy-data 资产放进 mapdata/ 即可叠加雷达底图。';

  const pts = [];
  if (bgOk) {
    for (const p of data.points) pts.push([(p.x - info.offset_x) / info.scale, (info.offset_y - p.y) / info.scale]);
  } else if (data.points.length) {
    // 无底图：把世界坐标等比缩放铺满画布
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of data.points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    const k = Math.min(size[0] / spanX, size[1] / spanY) * 0.9;
    const ox = (size[0] - spanX * k) / 2, oy = (size[1] - spanY * k) / 2;
    for (const p of data.points) pts.push([ox + (p.x - minX) * k, size[1] - (oy + (p.y - minY) * k)]);
  }

  const cv = document.getElementById('map-canvas');
  const base = bgOk && mapName ? await loadRadar(mapName) : null;
  drawDensity(cv, pts, size, base);
  $('#heat-legend-row').style.display = 'flex';
}

/* ------------------------------------------------------------------ 回放页 */
const SIDE_COLOR = { 'counter-terrorist': '#4a90d9', terrorist: '#d9a24a' };
const SIDE_LABEL = { 'counter-terrorist': 'CT', terrorist: 'T' };

function prepareReplayRounds() {
  const sel = $('#r-round');
  sel.innerHTML = state.rounds
    .map((r) => '<option value="' + r.round_num + '">第 ' + r.round_num + ' 回合 · ' + (r.winner_side === 'counter-terrorist' ? 'CT' : 'T') + ' 胜</option>').join('');
  state.replayRound = state.rounds.length ? state.rounds[0].round_num : null;
  sel.value = state.replayRound;
  sel.onchange = () => { state.replayRound = Number(sel.value); loadReplay(); };
}

function enterReplayPage(startFrame) {
  if (!state.matchId) return;
  if (!state.replay) { loadReplay(startFrame); return; }
  resizeReplayCanvas();
  if (startFrame != null && state.replay) {
    state.replayFrame = Math.max(0, Math.min(state.replay.ticks.length - 1, Number(startFrame) || 0));
    $('#r-seek').value = state.replayFrame;
  }
  drawReplay(state.replayFrame);
}

function stopPlayback() {
  if (state.replayTimer) { clearInterval(state.replayTimer); state.replayTimer = null; }
  $('#btn-play').textContent = '播放';
}

async function loadReplay(startFrame) {
  if (!state.matchId || state.replayRound == null) return;
  stopPlayback();
  $('#r-info').textContent = '加载中…';
  let data;
  try {
    data = await api('/api/matches/' + state.matchId + '/replay/' + state.replayRound + '?every=' + (state.replayEvery || 8));
  } catch (e) {
    state.replay = null;
    $('#r-info').textContent = '';
    $('#replay-note').textContent = '回放不可用：' + e.message;
    return;
  }
  state.replay = data;
  state.replayFrame = (startFrame == null)
    ? 0
    : Math.max(0, Math.min(data.ticks.length - 1, Number(startFrame) || 0));
  const seek = $('#r-seek');
  seek.max = Math.max(0, data.ticks.length - 1);
  seek.value = state.replayFrame;
  const secs = data.tick_rate ? (data.ticks.length * data.every / data.tick_rate) : null;
  $('#r-info').textContent = data.ticks.length + ' 帧 · ' + data.players.length + ' 名玩家' +
    (secs ? ' · 约 ' + secs.toFixed(0) + ' 秒' : '') + (data.cached ? ' · 缓存命中' : ' · 刚生成 ' + data.build_seconds + 's');
  $('#replay-note').textContent = '轨迹来自 awpy 的 snapshots（每 ' + data.every + ' tick 采样一次）；' +
    '世界坐标按 (x - pos_x)/scale、(pos_y - y)/scale 换算到雷达图像素。';
  const mapName = state.match ? state.match.map_name : null;
  state.mapInfo = await ensureMapInfo(mapName);
  if (mapName && state.mapInfo && state.mapInfo.radar) await loadRadar(mapName);
  renderReplayLegend();
  resizeReplayCanvas();
  drawReplay(state.replayFrame);
}

function renderReplayLegend() {
  const box = $('#replay-legend');
  const sides = [...new Set(state.replay.players.map((p) => p.side))];
  box.innerHTML = sides.map((s) =>
    '<span class="lg"><span class="sw" style="background:' + (SIDE_COLOR[s] || '#888') + '"></span>' +
    escapeHtml(SIDE_LABEL[s] || s) + '</span>').join('') +
    '<span class="lg dim">光晕越大血量越高 · 死亡后消失</span>';
}

function resizeReplayCanvas() {
  const cv = $('#replay-canvas');
  if (cv && state.replay) { cv.width = 1024; cv.height = 1024; }
}

function drawReplay(frame) {
  const data = state.replay;
  const cv = $('#replay-canvas');
  if (!data || !cv) return;
  const W = cv.width, H = cv.height;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const info = state.mapInfo;
  const base = state.match && state.match.map_name ? radarCache[state.match.map_name] : null;
  if (base && info && info.radar) { ctx.globalAlpha = 0.9; ctx.drawImage(base, 0, 0, W, H); ctx.globalAlpha = 1; }

  const toPx = (x, y) => (info && info.scale)
    ? [(x - info.offset_x) / info.scale, (info.offset_y - y) / info.scale]
    : [x, y];

  const i = Math.max(0, Math.min(data.ticks.length - 1, frame));
  const trail = Math.min(6, i);   // 拖尾帧数
  for (const p of data.players) {
    const side = SIDE_COLOR[p.side] || '#888';
    // 先画拖尾（由远及近，透明度递增）
    for (let t = trail; t >= 1; t--) {
      const prev = p.frames[i - t];
      if (!prev || prev[2] <= 0) continue;
      const [px, py] = toPx(prev[0], prev[1]);
      ctx.globalAlpha = 0.10 * (1 - t / (trail + 1));
      ctx.fillStyle = side;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const cur = p.frames[i];
    if (!cur || cur[2] <= 0) continue;
    const [px, py] = toPx(cur[0], cur[1]);
    const health = cur[2];
    const r = 6 + (health / 100) * 4;
    const flags = cur[3] || 0;
    // 光晕：血量越高越亮
    const grad = ctx.createRadialGradient(px, py, 0, px, py, r * 2.6);
    grad.addColorStop(0, side);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.25 + (health / 100) * 0.4;
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(px, py, r * 2.6, 0, Math.PI * 2); ctx.fill();
    // 本体
    ctx.globalAlpha = 0.55 + (health / 100) * 0.45;
    ctx.fillStyle = side;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0d1117'; ctx.stroke();
    // 朝向（yaw：CS2 里 0 度朝 +x）
    const yaw = cur[4];
    if (yaw != null) {
      const rad = yaw * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(rad) * r * 2.2, py - Math.sin(rad) * r * 2.2);
      ctx.strokeStyle = side; ctx.lineWidth = 2; ctx.stroke();
    }
    // 状态标记
    let badge = '';
    if (flags & 32) badge = 'C4';
    if (flags & 16) badge = '拆';
    if (badge) {
      ctx.font = 'bold 13px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#f5a623';
      ctx.textAlign = 'center';
      ctx.fillText(badge, px, py - r - 5);
    }
    if (flags & 8) {   // 被闪
      ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, r + 4, 0, Math.PI * 2); ctx.stroke();
    }
  }

  const tick = data.ticks[i];
  const sec = data.tick_rate ? (tick - (data.start_tick || 0)) / data.tick_rate : null;
  $('#r-clock').textContent = '帧 ' + (i + 1) + '/' + data.ticks.length +
    (sec != null ? ' · ' + sec.toFixed(1) + 's' : '') + ' · tick ' + tick;
}

function startPlayback() {
  const data = state.replay;
  if (!data) return;
  if (state.replayTimer) { stopPlayback(); return; }
  if (state.replayFrame >= data.ticks.length - 1) state.replayFrame = 0;
  const base = data.tick_rate ? 1000 / data.tick_rate : 16;   // 每帧真实毫秒（按 every 步进）
  const step = Math.max(16, base * data.every / state.replaySpeed);
  $('#btn-play').textContent = '暂停';
  state.replayTimer = setInterval(() => {
    if (state.replayFrame >= data.ticks.length - 1) { stopPlayback(); return; }
    state.replayFrame += 1;
    $('#r-seek').value = state.replayFrame;
    drawReplay(state.replayFrame);
  }, step);
}

$('#btn-play').addEventListener('click', startPlayback);
$('#btn-replay-reset').addEventListener('click', () => {
  stopPlayback();
  state.replayFrame = 0;
  $('#r-seek').value = 0;
  drawReplay(0);
});
$('#r-seek').addEventListener('input', () => {
  stopPlayback();
  state.replayFrame = Number($('#r-seek').value);
  drawReplay(state.replayFrame);
});
$('#r-speed').addEventListener('change', () => {
  state.replaySpeed = Number($('#r-speed').value);
  if (state.replayTimer) { stopPlayback(); startPlayback(); }
});

/* ------------------------------------------------------------------ 对比页 */
function enterComparePage() {
  if (state.selected.size < 2) { show('home'); toast('至少勾选 2 场比赛', true); return; }
  runCompare([...state.selected]);
}

async function runCompare(ids) {
  if (!ids || ids.length < 2) { show('home'); toast('至少需要 2 场比赛', true); return; }
  $('#cmp-summary').innerHTML = '<span class="dim">加载中…</span>';
  let data;
  try { data = await api('/api/compare?ids=' + ids.map(encodeURIComponent).join(',')); }
  catch (e) { $('#cmp-summary').innerHTML = ''; toast('对比失败：' + e.message, true); return; }
  state.compare = data.matches || [];
  show('compare');
  renderCompareSummary();
  renderCompareScore();
  renderCompareEconomy();
  renderCompareTable();
  renderCompareRadar();
}

function cmpLabel(m, i) {
  return '#' + (i + 1) + ' ' + (m.map_name || '?');
}

function renderCompareSummary() {
  $('#cmp-summary').innerHTML = state.compare.map((m, i) =>
    '<span class="pill">' + escapeHtml(cmpLabel(m, i)) + '</span>' +
    '<span class="pill ct">CT ' + m.ct_score + '</span><span class="pill t">T ' + m.t_score + '</span>' +
    '<span class="pill">' + m.round_count + ' 回合</span>').join('') +
    '<span class="dim" style="font-size:12px">共 ' + state.compare.length + ' 场</span>';
}

function renderCompareScore() {
  const c = chart('chart-cmp-score');
  if (!c) return;
  const labels = state.compare.map((m, i) => cmpLabel(m, i));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['CT 获胜回合', 'T 获胜回合'], textStyle: { color: '#8b98a5' } },
    grid: { left: 50, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 11, color: '#8b98a5' }, axisLine: { lineStyle: { color: '#2a3441' } } },
    yAxis: { type: 'value', name: '回合', splitLine: { lineStyle: { color: '#212a34' } } },
    series: [
      { name: 'CT 获胜回合', type: 'bar', stack: 'r', data: state.compare.map((m) => m.ct_score),
        itemStyle: { color: '#4a90d9' }, label: { show: true, color: '#e6edf3' } },
      { name: 'T 获胜回合', type: 'bar', stack: 'r', data: state.compare.map((m) => m.t_score),
        itemStyle: { color: '#d9a24a' }, label: { show: true, color: '#e6edf3' } },
    ],
  }, true);
}

function renderCompareEconomy() {
  const c = chart('chart-cmp-economy');
  if (!c) return;
  const maxRounds = Math.max(0, ...state.compare.map((m) => m.round_count || 0));
  const series = state.compare.map((m, i) => {
    const byRound = {};
    (m.economy || []).forEach((e) => { byRound[e.round_num] = (byRound[e.round_num] || 0) + (e.equipment_value || 0); });
    const data = [];
    for (let r = 1; r <= maxRounds; r++) data.push(byRound[r] == null ? null : byRound[r]);
    return { name: cmpLabel(m, i), type: 'line', smooth: true, connectNulls: false, data, symbolSize: 5 };
  });
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', formatter: (ps) => '第 ' + ps[0].axisValue + ' 回合<br>' + ps.map((p) =>
      p.marker + p.seriesName + '：' + (p.value == null ? '-' : '$' + p.value)).join('<br>') },
    legend: { data: state.compare.map((m, i) => cmpLabel(m, i)), textStyle: { color: '#8b98a5' } },
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'category', data: Array.from({ length: maxRounds }, (_, k) => 'R' + (k + 1)),
      axisLine: { lineStyle: { color: '#2a3441' } } },
    yAxis: { type: 'value', name: '双方装备价值 $', splitLine: { lineStyle: { color: '#212a34' } } },
    series,
  }, true);
}

let cmpSort = { key: 'name', asc: true };   // key: 'name' 或比赛下标

function renderCompareTable() {
  // 行 = 玩家名（跨场同名对齐），列 = 每场；单元格为 K/D/A · Rating≈
  const names = [];
  const seen = new Set();
  state.compare.forEach((m) => (m.players || []).forEach((p) => {
    const n = p.name == null ? '(未知)' : String(p.name);
    if (!seen.has(n)) { seen.add(n); names.push(n); }
  }));
  const lookup = state.compare.map((m) => {
    const map = {};
    (m.players || []).forEach((p) => { map[p.name == null ? '(未知)' : String(p.name)] = p; });
    return map;
  });
  const ratingOf = (name, idx) => {
    const p = lookup[idx] && lookup[idx][name];
    return p ? (Number(p.rating) || 0) : -1;
  };
  names.sort((a, b) => {
    const cmp = (cmpSort.key === 'name')
      ? String(a).localeCompare(String(b))
      : ratingOf(a, cmpSort.key) - ratingOf(b, cmpSort.key);
    return cmpSort.asc ? cmp : -cmp;
  });

  const arrow = (key) => cmpSort.key === key ? (cmpSort.asc ? ' ▲' : ' ▼') : '';
  let html = '<thead><tr><th class="l" data-k="name">玩家' + arrow('name') + '</th>' +
    state.compare.map((m, i) =>
      '<th class="l" data-k="' + i + '">' + escapeHtml(cmpLabel(m, i)) + arrow(i) +
      '<br><span class="dim" style="font-weight:400">' + (m.map_name || '?') + '</span></th>').join('') +
    '</tr></thead><tbody>';
  names.forEach((n) => {
    html += '<tr><td class="l">' + escapeHtml(n) + '</td>' + lookup.map((map) => {
      const p = map[n];
      if (!p) return '<td class="l cmp-cell dim">未参赛</td>';
      const side = p.side === 'counter-terrorist' ? '<span class="pill ct">CT</span>' : (p.side === 'terrorist' ? '<span class="pill t">T</span>' : '');
      const r = Number(p.rating);
      const cls = r >= 1.1 ? 'win' : (r < 0.9 ? 'lose' : '');
      return '<td class="l cmp-cell">' + side +
        '<span class="' + cls + '"> ' + (isFinite(r) ? r.toFixed(2) : '-') + '</span><br>' +
        '<span class="dim">' + (p.kills || 0) + '/' + (p.deaths || 0) + '/' + (p.assists || 0) +
        ' · ADR ' + (p.adr == null ? '-' : Number(p.adr).toFixed(1)) + '</span></td>';
    }).join('') + '</tr>';
  });
  const tbl = $('#tbl-compare');
  tbl.innerHTML = html + '</tbody>';
  tbl.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const raw = th.dataset.k;
    const key = raw === 'name' ? 'name' : Number(raw);
    if (cmpSort.key === key) cmpSort.asc = !cmpSort.asc; else { cmpSort.key = key; cmpSort.asc = false; }
    renderCompareTable();
  }));
}

function renderCompareRadar() {
  const c = chart('chart-cmp-radar');
  if (!c) return;
  const dims = [['kills', '击杀'], ['adr', 'ADR'], ['kast', 'KAST'], ['headshot_pct', '爆头率'],
    ['opening_kills', '首杀'], ['utility_damage', '道具伤害']];
  const top = state.compare.map((m) => (m.players || [])[0]).filter(Boolean);
  if (!top.length) { c.clear(); return; }
  const maxOf = (k) => Math.max(1, ...top.map((p) => Number(p[k]) || 0));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: {},
    legend: { data: state.compare.map((m, i) => cmpLabel(m, i) + (top[i] ? ' · ' + top[i].name : '')), textStyle: { color: '#8b98a5' }, bottom: 0 },
    radar: {
      indicator: dims.map((d) => ({ name: d[1], max: 1 })),
      radius: '58%', center: ['50%', '46%'],
      axisName: { color: '#8b98a5', fontSize: 11 },
      splitLine: { lineStyle: { color: '#2a3441' } },
      splitArea: { areaStyle: { color: ['rgba(255,255,255,0.015)', 'rgba(255,255,255,0.04)'] } },
      axisLine: { lineStyle: { color: '#2a3441' } },
    },
    series: [{
      type: 'radar',
      data: top.map((p, i) => ({
        value: dims.map((d) => ((Number(p[d[0]]) || 0) / maxOf(d[0])).toFixed(3)),
        name: cmpLabel(state.compare[i], i) + ' · ' + p.name,
        areaStyle: { opacity: 0.12 },
      })),
    }],
  }, true);
}

$('#btn-compare').addEventListener('click', enterComparePage);
$('#btn-clear-sel').addEventListener('click', () => {
  state.selected.clear();
  loadMatches();
});

/* ------------------------------------------------------------------ 深链（#match=<id>&page=players） */
function applyHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return false;
  const q = new URLSearchParams(h);
  const id = q.get('match');
  if (!id) return false;
  const page = q.get('page') || 'match';
  openMatch(id).then(() => {
    const sel = (q.get('sel') || '').split(',').filter(Boolean);
    if (page === 'compare') {
      if (sel.length >= 2) { show('compare'); runCompare(sel); }
      else if (state.selected.size >= 2) runCompare([...state.selected]);
      else show('compare');
      return;
    }
    if (PAGES.includes(page)) show(page);
    if (page === 'map') {
      state.heatFilter = { round_num: q.get('round') || '', side: q.get('side') || '', weapon: q.get('weapon') || '' };
      const rsel = $('#f-round');
      if (state.heatFilter.round_num) rsel.value = state.heatFilter.round_num;
      $('#f-side').value = state.heatFilter.side;
      const wsel = $('#f-weapon');
      if (state.heatFilter.weapon) wsel.value = state.heatFilter.weapon;
      loadHeat(q.get('heat') || state.heatType);
    }
    if (page === 'replay') enterReplayPage(q.get('frame'));
  }).catch((e) => toast('打开比赛失败：' + e.message, true));
  return true;
}
window.addEventListener('hashchange', () => applyHash());

/* ------------------------------------------------------------------ 启动 */
loadMatches()
  .then(() => { if (!applyHash()) show('home'); })
  .catch((e) => toast('加载比赛列表失败：' + e.message, true));
