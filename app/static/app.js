/* CS2 数据面板 前端 —— 无构建链，直接 ES2020
 * 架构：设置层(theme/settings) → 主题取色 → 两级导航 → 各页面渲染
 * 硬约束：零构建链 / 零 CDN / 零框架；steamid 保持字符串；上传走原始字节流。
 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

/* ================================================================== 设置层 */
const DEFAULTS = { theme: 'dark', compact: '0', tabular: '1', every: '8', radar: 'max', livecolor: '1' };
const LS = 'cs2panel.settings';
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { /* ignore */ }

function saveSettings() {
  try { localStorage.setItem(LS, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
function setSetting(k, v) {
  const prev = settings[k];
  settings[k] = String(v);
  saveSettings();
  applySettings();
  // 主题或图表配色变化：重建 ECharts 主题并重绘，让图表跟随 CSS 变量
  if (k === 'theme' || k === 'livecolor') {
    if (prev !== settings[k]) requestAnimationFrame(rebuildCharts);
  }
}
function applySettings() {
  const prevTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', settings.theme === 'light' ? 'light' : 'dark');
  document.body.classList.toggle('compact', settings.compact === '1');
  document.body.classList.toggle('tabular', settings.tabular !== '0');
  state.replayEvery = Number(settings.every) || 8;
  const btn = $('#btn-theme');
  if (btn) btn.textContent = settings.theme === 'light' ? '深色' : '浅色';
  $('#set-theme').value = settings.theme;
  $('#set-compact').value = settings.compact;
  $('#set-tabular').value = settings.tabular;
  $('#set-every').value = settings.every;
  $('#set-radar').value = settings.radar;
  $('#set-livecolor').value = settings.livecolor;
  $('#r-every').value = state.replayEvery;
  if (prevTheme !== settings.theme) rebuildChartsSafe();
}
/* 主题在启动阶段切换时，图表尚未建立，直接调用会抛错，这里兜一层 */
function rebuildChartsSafe() {
  if (typeof state === 'undefined' || !document.getElementById('page-match')) return;
  requestAnimationFrame(() => { try { rebuildCharts(); } catch (e) { /* 首帧尚未渲染 */ } });
}

/* ============================================================ 主题取色层 */
/* 图表与 canvas 统一从这里取色：换主题时读 CSS 变量即可整体跟随。 */
const cssCache = {};
function cssVar(name) {
  if (cssCache[name]) return cssCache[name];
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache[name] = v || '#888';
  return cssCache[name];
}
function cssRgb(name) {
  const h = cssVar(name).replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
function rgbaVar(name, a) {
  const [r, g, b] = cssRgb(name);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}
function P() {
  return {
    dim: cssVar('--dim'),
    fg: cssVar('--fg'),
    line: cssVar('--line'),
    line2: cssVar('--line-2'),
    accent: cssVar('--accent'),
    ct: cssVar('--ct'),
    t: cssVar('--t'),
    bg: cssVar('--bg'),
    panel: cssVar('--panel'),
  };
}
/* ECharts 坐标轴统一样式。ext 里的设置（如 axisLabel.rotate）优先，不被覆盖。 */
function axisStyle(ext) {
  const c = P();
  const base = {
    axisLine: { lineStyle: { color: c.line } },
    axisLabel: { color: c.dim, fontSize: 11 },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: c.line2 } },
  };
  if (!ext) return base;
  const merged = { ...base, ...ext };
  if (ext.axisLabel) merged.axisLabel = { ...base.axisLabel, ...ext.axisLabel };
  return merged;
}
function legendStyle(bottom) {
  const c = P();
  return { textStyle: { color: c.dim }, ...(bottom ? { bottom: 0 } : {}) };
}

/* ================================================================== 状态 */
const state = {
  matchId: null, match: null, players: [], rounds: [], economy: [], heatType: 'kills',
  matches: [], selected: new Set(),
  heatFilter: { round_num: '', side: '', weapon: '' },
  weapons: [],
  replay: null, replayRound: null, replayFrame: 0, replayTimer: null, replaySpeed: 1,
  replayEvery: 8,
  compare: [],
  sec: 'home', page: 'home',
  tasks: new Map(),
};
const charts = {};

/* ECharts 自定义主题：从 CSS 变量生成，切主题时重新注册并重建实例。 */
let echartsThemeFor = null;
function echartsTheme() {
  if (settings.livecolor !== '1') return 'dark';
  const name = 'panel-' + settings.theme;
  if (echartsThemeFor === name) return name;
  const p = P();
  echarts.registerTheme(name, {
    color: [p.ct, p.t, p.accent, '#3fb950', '#b57edc', '#e06c9f', '#36b9cc'],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: '"Microsoft YaHei","Segoe UI",system-ui,sans-serif' },
    title: { textStyle: { color: p.fg }, subtextStyle: { color: p.dim } },
    legend: { textStyle: { color: p.dim }, inactiveColor: p.line2 },
    tooltip: {
      backgroundColor: p.panel, borderColor: p.line, borderWidth: 1, padding: [8, 12],
      textStyle: { color: p.fg, fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.30);',
    },
    axisPointer: {
      lineStyle: { color: p.line }, crossStyle: { color: p.line },
      shadowStyle: { color: rgbaVar('--accent', .08) },
      label: { backgroundColor: p.panel2, color: p.fg, borderColor: p.line, borderWidth: 1 },
    },
    categoryAxis: axisPointerCat(p),
    valueAxis: axisPointerCat(p),
    logAxis: axisPointerCat(p),
    timeAxis: axisPointerCat(p),
  });
  echartsThemeFor = name;
  return name;
}
function axisPointerCat(p) {
  return {
    axisLine: { lineStyle: { color: p.line } },
    axisTick: { show: false },
    axisLabel: { color: p.dim },
    splitLine: { lineStyle: { color: p.line2 } },
    splitArea: { show: false },
  };
}

function chart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (!charts[id]) charts[id] = echarts.init(el, echartsTheme());
  return charts[id];
}

/* 主题/配色设置变化后：清色缓存 + 重建全部图表实例 + 重画当前页 */
function rebuildCharts() {
  Object.keys(cssCache).forEach((k) => delete cssCache[k]);
  echartsThemeFor = null;
  Object.values(charts).forEach((c) => { try { c.dispose(); } catch (e) { /* ignore */ } });
  Object.keys(charts).forEach((k) => delete charts[k]);
  HEAT_LUT = buildHeatLUT();
  if (state.matchId && state.players.length) {
    renderEconomy(); renderRounds(); renderPlayers();
    if (state.page === 'map') loadHeat(state.heatType);
    if (state.replay) drawReplay(state.replayFrame);
  }
  if (state.compare.length) {
    renderCompareScore(); renderCompareEconomy(); renderCompareTable(); renderCompareRadar();
  }
  setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 60);
}
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));

/* =============================================================== 两级导航 */
const SECTIONS = ['home', 'import', 'analysis', 'stats', 'settings'];
const SUBPAGES = { analysis: ['match', 'players', 'map', 'replay'], stats: ['compare'] };
const PAGE_OF_SEC = { home: 'home', import: 'import', analysis: 'match', stats: 'compare', settings: 'settings' };

function syncNav() {
  const { sec, page } = state;
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec && !b.dataset.page));
  $$('#nav .nav-subitem').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec && b.dataset.page === page));
  // 一级入口（首页/导入/统计/设置）本身也带 data-page，它就是该 section 的落地页
  $$('#nav > .nav-item[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
  $('#grp-analysis').classList.toggle('open', sec === 'analysis');
  $('#grp-caret').textContent = sec === 'analysis' ? '▾' : '▸';
  $$('#nav [data-page]').forEach((b) => {
    if (b.dataset.sec === 'analysis') b.disabled = !state.matchId;
  });
}

function show(sec, page) {
  sec = SECTIONS.includes(sec) ? sec : 'home';
  page = page || PAGE_OF_SEC[sec];
  if (SUBPAGES[sec] && !SUBPAGES[sec].includes(page)) page = PAGE_OF_SEC[sec];
  state.sec = sec;
  state.page = page;
  // analysis 是唯一的二级区：它本身没有 section 元素，只显示当前子页。
  // stats 的 section 元素 id 是 page-compare（SECTIONS 里用的是语义名 stats）。
  const SEC_EL = { home: 'home', import: 'import', stats: 'compare', settings: 'settings' };
  Object.keys(SEC_EL).forEach((s) => {
    const el = document.getElementById('page-' + SEC_EL[s]);
    if (el) el.classList.toggle('hidden', s !== sec);
  });
  SUBPAGES.analysis.forEach((p) => {
    const el = document.getElementById('page-' + p);
    if (el) el.classList.toggle('hidden', !(sec === 'analysis' && p === page));
  });
  syncNav();
  setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 60);
  closeSidebar();
  writeHash();
}

function go(page) {
  const el = $$('#nav [data-page]').find((b) => b.dataset.page === page);
  if (!el || el.disabled) return;
  show(el.dataset.sec, page);
  if (page === 'map' && state.matchId) loadHeat(state.heatType);
  if (page === 'replay') enterReplayPage();
  if (page === 'compare') { /* 对比结果需手动点「开始对比」 */ }
}

/* 侧边栏交互 */
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'nav-analysis') {                     // 折叠组：点击标题先展开
    const g = $('#grp-analysis');
    if (!state.matchId && !g.classList.contains('open')) { g.classList.add('open'); return; }
  }
  if (b.classList.contains('nav-item') && b.dataset.page) { go(b.dataset.page); return; }
  if (b.classList.contains('nav-item') && !b.dataset.page) {
    const sec = b.dataset.sec;
    if (sec === 'analysis') {
      show('analysis', 'match');
      if (state.matchId && state.page === 'match') { /* 已在概览 */ }
    } else {
      show(sec);
      if (sec === 'home') renderHome();
      if (sec === 'stats') syncCompareBar();
    }
  }
});
$('.content').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (!b || b.disabled) return;
  const sec = b.dataset.go;
  show(sec, b.dataset.page || PAGE_OF_SEC[sec]);
  if (sec === 'analysis' && b.dataset.page === 'map' && state.matchId) loadHeat(state.heatType);
  if (sec === 'analysis' && b.dataset.page === 'replay') enterReplayPage();
  if (sec === 'home') renderHome();
});

/* 移动端抽屉 */
function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }
$('#btn-menu').addEventListener('click', openSidebar);
$('#scrim').addEventListener('click', closeSidebar);
$('#btn-theme').addEventListener('click', () => setSetting('theme', settings.theme === 'light' ? 'dark' : 'light'));

/* ================================================================ 比赛列表 */
async function loadMatches() {
  const list = await api('/api/matches');
  state.matches = list;
  state.selected = new Set([...state.selected].filter((id) => list.some((m) => m.id === id)));
  $('#sf-matches').textContent = list.length;
  renderMatchSelect();
  renderHome();
  renderStatsPicker();
  syncCompareBar();
}

function renderMatchSelect() {
  const sel = $('#match-select');
  const cur = state.matchId || '';
  sel.innerHTML = '<option value="">未选择比赛</option>' + state.matches.map((m) =>
    '<option value="' + escapeAttr(m.id) + '">' + escapeHtml((m.map_name || '?') + ' · ' + m.ct_score + ':' + m.t_score + ' · ' + m.file_name) + '</option>'
  ).join('');
  sel.value = cur && state.matches.some((m) => m.id === cur) ? cur : '';
}
$('#match-select').addEventListener('change', (e) => {
  const id = e.target.value;
  if (id) openMatch(id);
});

function matchCardHtml(m, withPick) {
  return (withPick ? '<input type="checkbox" class="pick" title="加入对比"' + (state.selected.has(m.id) ? ' checked' : '') + '>' : '') +
    '<div class="t" title="' + escapeAttr(m.file_name) + '">' + escapeHtml(m.file_name) + '</div>' +
    '<div class="s"><span class="ct">' + m.ct_score + '</span> : <span class="t">' + m.t_score + '</span></div>' +
    '<div class="d">' + (m.map_name || '?') + ' · ' + m.round_count + ' 回合' +
    (m.playback_time ? ' · ' + Math.round(m.playback_time / 60) + ' 分钟' : '') + '</div>';
}

function renderStatsPicker() {
  const box = $('#matches');
  if (!box) return;
  box.innerHTML = '';
  $('#no-matches').classList.toggle('hidden', state.matches.length > 0);
  state.matches.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'match' + (state.selected.has(m.id) ? ' selected' : '');
    div.innerHTML = matchCardHtml(m, true);
    const pick = div.querySelector('.pick');
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pick.checked) state.selected.add(m.id); else state.selected.delete(m.id);
      div.classList.toggle('selected', pick.checked);
      syncCompareBar();
    });
    box.appendChild(div);
  });
}

function syncCompareBar() {
  const n = state.selected.size;
  const btn = $('#btn-compare');
  if (!btn) return;
  btn.disabled = n < 2;
  $('#sel-hint').textContent = n < 2 ? '勾选 2 场以上可比对' : '已选 ' + n + ' 场';
  $('#sel-count').textContent = n ? '已选 ' + n + ' 场' : '';
}

/* ================================================================== 首页 */
function renderHome() {
  const box = $('#home-matches');
  if (!box) return;
  const list = state.matches.slice(0, 4);
  box.innerHTML = '';
  list.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'match';
    div.innerHTML = matchCardHtml(m, false);
    div.addEventListener('click', () => openMatch(m.id).then(() => show('analysis', 'match')));
    box.appendChild(div);
  });
  $('#home-no-matches').classList.toggle('hidden', state.matches.length > 0);

  const totalRounds = state.matches.reduce((s, m) => s + (m.round_count || 0), 0);
  const totalMin = Math.round(state.matches.reduce((s, m) => s + (m.playback_time || 0), 0) / 60);
  const running = [...state.tasks.values()].filter((t) => t.status === 'pending' || t.status === 'running').length;
  const last = state.matches[0];
  $('#kpis').innerHTML = [
    ['比赛总数', state.matches.length, state.matches.length ? '本机已解析' : '去「导入」添加'],
    ['总回合数', totalRounds, '全部比赛合计'],
    ['总时长', totalMin + ' 分', '按 playback_time 累计'],
    ['解析中', running, running ? '队列运行中' : '队列空闲'],
  ].map(([k, v, s]) =>
    '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'
  ).join('') + (last
    ? '<div class="kpi"><div class="k">最近导入</div><div class="v" style="font-size:15px">' +
      escapeHtml(last.map_name || '?') + '</div><div class="s">' + last.ct_score + ' : ' + last.t_score + '</div></div>'
    : '');
}

/* ================================================================ 导入页 */
const drop = $('#drop');
const fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  [...e.dataTransfer.files].forEach(upload);
});
fileInput.addEventListener('change', () => { [...fileInput.files].forEach(upload); fileInput.value = ''; });

async function upload(file) {
  if (!/\.dem$/i.test(file.name)) { toast('只接受 .dem 文件：' + file.name, true); return; }
  try {
    // 后端按原始字节流接收（不依赖 python-multipart），文件名走查询参数
    const r = await api('/api/demos?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    toast('已提交 ' + file.name + '（' + (file.size / 1048576).toFixed(0) + ' MB）');
    pollTask(r.task_id, file.name);
  } catch (e) { toast('上传失败：' + e.message, true); }
}

function renderTasks() {
  const box = $('#task-list');
  const list = [...state.tasks.values()];
  $('#no-task').classList.toggle('hidden', list.length > 0);
  $('#task-count').textContent = list.length ? list.length + ' 个' : '';
  box.innerHTML = list.map((t) => {
    const done = t.status === 'done';
    const failed = t.status === 'failed';
    const stage = done ? ('完成 · ' + (t.seconds || 0) + 's') : (failed ? '失败' : (t.stage || '排队中') + '（' + Math.round((t.progress || 0) * 100) + '%）');
    return '<div class="task' + (failed ? ' err' : '') + '">' +
      '<div class="th"><span class="nm" title="' + escapeAttr(t.name) + '">' + escapeHtml(t.name) + '</span>' +
      '<span class="st">' + escapeHtml(stage) + '</span></div>' +
      '<div class="bar"><i style="width:' + (failed ? 100 : (t.progress || 0) * 100) + '%"></i></div>' +
      (failed ? '<div class="st" style="margin-top:6px;color:var(--bad)">' + escapeHtml(t.error || '') + '</div>' : '') +
      '</div>';
  }).join('');
}

function pollTask(taskId, name) {
  state.tasks.set(taskId, { id: taskId, name, status: 'pending', stage: '排队中', progress: 0 });
  renderTasks();
  if (state.sec === 'home') renderHome();
  const tick = async () => {
    let t;
    try { t = await api('/api/tasks/' + taskId); }
    catch (e) { state.tasks.delete(taskId); renderTasks(); return; }
    const rec = state.tasks.get(taskId);
    if (!rec) return;
    rec.status = t.status; rec.stage = t.stage; rec.progress = t.progress;
    rec.seconds = t.seconds; rec.error = t.error;
    renderTasks();
    if (t.status === 'done') {
      toast(name + ' 解析完成，用时 ' + t.seconds + ' 秒');
      await loadMatches();
      state.tasks.delete(taskId);
      renderTasks();
      if (state.tasks.size === 0 && t.match_id) {
        await openMatch(t.match_id);
        show('analysis', 'match');
      }
    } else if (t.status === 'failed') {
      toast('解析失败：' + t.error, true);
      setTimeout(() => { state.tasks.delete(taskId); renderTasks(); }, 6000);
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
      row.className = 'scan-row';
      row.innerHTML = '<span class="nm" title="' + escapeAttr(f.path) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="dim" style="font-size:12px">' + (f.size / 1048576).toFixed(0) + ' MB</span>';
      const btn = document.createElement('button');
      btn.className = 'btn sm';
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

/* ================================================================ 比赛页 */
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
  renderMatchSelect();
  $('#match-title').textContent = (m.map_name || '?') + '  ·  ' + m.ct_score + ' : ' + m.t_score + ' · ' + m.file_name;
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
  if (state.sec === 'analysis' || state.page === 'match') syncNav();
  writeHash();
}

/* 地图页筛选器 */
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
  sel.onchange = () => { state.heatFilter.round_num = sel.value; loadHeat(state.heatType); };
  $('#f-side').onchange = () => { state.heatFilter.side = $('#f-side').value; loadHeat(state.heatType); };
  wsel.onchange = () => { state.heatFilter.weapon = wsel.value; loadHeat(state.heatType); };
}

function renderEconomy() {
  const c = chart('chart-economy');
  if (!c) return;
  const p = P();
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
      formatter: (ps) => '第 ' + ps[0].axisValue + ' 回合<br>' + ps.map((x) =>
        x.marker + x.seriesName + '：$' + (x.value == null ? '-' : x.value)).join('<br>') +
        '<br><span style="opacity:.7">CT 买法 ' + buy('counter-terrorist')[rounds.indexOf(ps[0].axisValue)] +
        ' · T 买法 ' + buy('terrorist')[rounds.indexOf(ps[0].axisValue)] + '</span>',
    },
    legend: Object.assign({ data: ['CT 装备价值', 'T 装备价值'] }, legendStyle()),
    grid: { left: 60, right: 20, top: 40, bottom: 34 },
    xAxis: Object.assign({ type: 'category', data: rounds.map((n) => 'R' + n) }, axisStyle()),
    yAxis: Object.assign({ type: 'value', name: '装备价值 $', nameTextStyle: { color: p.dim } }, axisStyle()),
    series: [
      { name: 'CT 装备价值', type: 'line', smooth: true, data: pick('counter-terrorist'),
        itemStyle: { color: p.ct }, areaStyle: { opacity: .12 } },
      { name: 'T 装备价值', type: 'line', smooth: true, data: pick('terrorist'),
        itemStyle: { color: p.t }, areaStyle: { opacity: .12 } },
    ],
  });
}

function renderRounds() {
  const c = chart('chart-rounds');
  if (!c) return;
  const p = P();
  const reasons = [...new Set(state.rounds.map((r) => r.reason_name))];
  const ct = reasons.map((rn) => state.rounds.filter((r) => r.reason_name === rn && r.winner_side === 'counter-terrorist').length);
  const t = reasons.map((rn) => state.rounds.filter((r) => r.reason_name === rn && r.winner_side === 'terrorist').length);
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: Object.assign({ data: ['CT 获胜', 'T 获胜'] }, legendStyle()),
    grid: { left: 60, right: 20, top: 40, bottom: 60 },
    xAxis: axisStyle({ type: 'category', data: reasons, axisLabel: { rotate: 30, fontSize: 11, color: p.dim } }),
    yAxis: Object.assign({ type: 'value' }, axisStyle()),
    series: [
      { name: 'CT 获胜', type: 'bar', stack: 'w', data: ct, itemStyle: { color: p.ct } },
      { name: 'T 获胜', type: 'bar', stack: 'w', data: t, itemStyle: { color: p.t } },
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

/* ================================================================ 玩家页 */
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
    html += '<tr data-sid="' + escapeAttr(p.steamid) + '">' + PLAYER_COLS.map((c) => {
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

/* 雷达归一上限：按全场最大值 or 固定上限（跨场可比） */
const RADAR_CAPS = { kills: 35, adr: 120, kast: 100, headshot_pct: 60, opening_kills: 10, utility_damage: 250 };
const RADAR_DIMS = [['kills', '击杀'], ['adr', 'ADR'], ['kast', 'KAST'], ['headshot_pct', '爆头率'],
  ['opening_kills', '首杀'], ['utility_damage', '道具伤害']];

function radarNorm(list) {
  return (k) => settings.radar === 'fixed'
    ? RADAR_CAPS[k]
    : Math.max(1, ...list.map((p) => Number(p[k]) || 0));
}

function renderRadar(player) {
  const c = chart('chart-radar');
  if (!c || !player) return;
  const p = P();
  $('#radar-title').textContent = '雷达图 · ' + (player.name == null ? '(未知)' : player.name);
  const maxOf = radarNorm(state.players);
  const mine = RADAR_DIMS.map((d) => ({ value: Math.min(1, (Number(player[d[0]]) || 0) / maxOf(d[0])) }));
  const best = RADAR_DIMS.map((d) => ({ value: Math.min(1, Math.max(...state.players.map((x) => (Number(x[d[0]]) || 0) / maxOf(d[0])))) }));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: {},
    legend: Object.assign({ data: [player.name, '全场最高'] }, legendStyle(true)),
    radar: {
      indicator: RADAR_DIMS.map((d) => ({ name: d[1], max: 1 })),
      radius: '62%', center: ['50%', '48%'],
      axisName: { color: p.dim, fontSize: 11 },
      splitLine: { lineStyle: { color: p.line } },
      splitArea: { areaStyle: { color: [rgbaVar('--fg', .015), rgbaVar('--fg', .04)] } },
      axisLine: { lineStyle: { color: p.line } },
    },
    series: [{
      type: 'radar',
      data: [
        { value: mine.map((m) => m.value.toFixed(3)), name: player.name, itemStyle: { color: p.accent },
          areaStyle: { color: rgbaVar('--accent', .28) } },
        { value: best.map((m) => m.value.toFixed(3)), name: '全场最高', lineStyle: { type: 'dashed' },
          itemStyle: { color: p.ct }, areaStyle: { opacity: 0 } },
      ],
    }],
  }, true);
}

function renderAdrChart() {
  const c = chart('chart-adr');
  if (!c) return;
  const p = P();
  const rows = [...state.players].sort((a, b) => (b.adr || 0) - (a.adr || 0));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: Object.assign({ data: ['ADR', 'KAST'] }, legendStyle()),
    grid: { left: 50, right: 55, top: 40, bottom: 70 },
    xAxis: axisStyle({ type: 'category', data: rows.map((x) => x.name),
      axisLabel: { rotate: 32, fontSize: 11, color: p.dim, interval: 0, hideOverlap: false } }),
    yAxis: [
      Object.assign({ type: 'value', name: 'ADR', nameTextStyle: { color: p.dim } }, axisStyle()),
      Object.assign({ type: 'value', name: 'KAST%', max: 100, nameTextStyle: { color: p.dim }, splitLine: { show: false }, axisLine: { show: false }, axisLabel: { color: p.dim, fontSize: 11 } }),
    ],
    series: [
      { name: 'ADR', type: 'bar', data: rows.map((x) => x.adr), itemStyle: { color: p.accent } },
      { name: 'KAST', type: 'line', yAxisIndex: 1, smooth: true, data: rows.map((x) => x.kast),
        itemStyle: { color: p.ct }, symbolSize: 7 },
    ],
  }, true);
}

/* ================================================================ 地图页 */
$$('[data-heat]').forEach((b) => b.addEventListener('click', () => loadHeat(b.dataset.heat)));

/* 调色板：直接读 CSS 变量 --heat-1..4，与 style.css 的图例渐变同源 */
let HEAT_LUT = null;
function buildHeatLUT() {
  const stops = [cssRgb('--heat-1'), cssRgb('--heat-2'), cssRgb('--heat-3'), cssRgb('--heat-4')];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = stops[k][ch] + (stops[k + 1][ch] - stops[k][ch]) * f;
  }
  return lut;
}

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

/* 在 1024x1024 画布上叠密度图：每个点按高斯核累加，再按最大值取平方根映射到调色板。 */
function drawDensity(cv, pts, size, baseImg) {
  const W = size[0], H = size[1];
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--bg');
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
  $$('[data-heat]').forEach((b) => {
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
    for (const pt of data.points) pts.push([(pt.x - info.offset_x) / info.scale, (info.offset_y - pt.y) / info.scale]);
  } else if (data.points.length) {
    // 无底图：把世界坐标等比缩放铺满画布
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of data.points) {
      if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
    }
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    const k = Math.min(size[0] / spanX, size[1] / spanY) * 0.9;
    const ox = (size[0] - spanX * k) / 2, oy = (size[1] - spanY * k) / 2;
    for (const pt of data.points) pts.push([ox + (pt.x - minX) * k, size[1] - (oy + (pt.y - minY) * k)]);
  }

  const cv = document.getElementById('map-canvas');
  const base = bgOk && mapName ? await loadRadar(mapName) : null;
  drawDensity(cv, pts, size, base);
  $('#heat-legend-row').style.display = 'flex';
}

/* ================================================================ 回放页 */
const SIDE_LABEL = { 'counter-terrorist': 'CT', terrorist: 'T' };
function sideColor(side) {
  return side === 'counter-terrorist' ? cssVar('--ct') : (side === 'terrorist' ? cssVar('--t') : cssVar('--dim'));
}

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
    '<span class="lg"><span class="sw" style="background:' + sideColor(s) + '"></span>' +
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
  const bg = cssVar('--bg');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = bg;
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
    const side = sideColor(p.side);
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
    ctx.lineWidth = 1.5; ctx.strokeStyle = bg; ctx.stroke();
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
      ctx.fillStyle = cssVar('--accent');
      ctx.textAlign = 'center';
      ctx.fillText(badge, px, py - r - 5);
    }
    if (flags & 8) {   // 被闪
      ctx.strokeStyle = cssVar('--fg'); ctx.lineWidth = 2;
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
  const base = data.tick_rate ? 1000 / data.tick_rate : 16;
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
$('#r-every').addEventListener('change', () => {
  setSetting('every', $('#r-every').value);
  state.replay = null;      // 采样粒度变了，旧帧不再适用
  if (state.sec === 'analysis' && state.page === 'replay') loadReplay();
});

/* ================================================================ 统计页 */
async function runCompare(ids) {
  if (!ids || ids.length < 2) { toast('至少需要 2 场比赛', true); return; }
  $('#cmp-summary').innerHTML = '<span class="dim">加载中…</span>';
  let data;
  try { data = await api('/api/compare?ids=' + ids.map(encodeURIComponent).join(',')); }
  catch (e) { $('#cmp-summary').innerHTML = ''; toast('对比失败：' + e.message, true); return; }
  state.compare = data.matches || [];
  $('#cmp-result').classList.remove('hidden');
  renderCompareSummary();
  renderCompareScore();
  renderCompareEconomy();
  renderCompareTable();
  renderCompareRadar();
  setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 60);
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
  const p = P();
  const labels = state.compare.map((m, i) => cmpLabel(m, i));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: Object.assign({ data: ['CT 获胜回合', 'T 获胜回合'] }, legendStyle()),
    grid: { left: 50, right: 20, top: 40, bottom: 40 },
    xAxis: Object.assign({ type: 'category', data: labels, axisLabel: { fontSize: 11, color: p.dim } }, axisStyle()),
    yAxis: Object.assign({ type: 'value', name: '回合', nameTextStyle: { color: p.dim } }, axisStyle()),
    series: [
      { name: 'CT 获胜回合', type: 'bar', stack: 'r', data: state.compare.map((m) => m.ct_score),
        itemStyle: { color: p.ct }, label: { show: true, color: p.fg } },
      { name: 'T 获胜回合', type: 'bar', stack: 'r', data: state.compare.map((m) => m.t_score),
        itemStyle: { color: p.t }, label: { show: true, color: p.fg } },
    ],
  }, true);
}

const CMP_COLORS = ['#4a90d9', '#f5a623', '#3fb950', '#b57edc', '#e06c9f', '#36b9cc'];

function renderCompareEconomy() {
  const c = chart('chart-cmp-economy');
  if (!c) return;
  const p = P();
  const maxRounds = Math.max(0, ...state.compare.map((m) => m.round_count || 0));
  const series = state.compare.map((m, i) => {
    const byRound = {};
    (m.economy || []).forEach((e) => { byRound[e.round_num] = (byRound[e.round_num] || 0) + (e.equipment_value || 0); });
    const data = [];
    for (let r = 1; r <= maxRounds; r++) data.push(byRound[r] == null ? null : byRound[r]);
    return { name: cmpLabel(m, i), type: 'line', smooth: true, connectNulls: false, data, symbolSize: 5,
      itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] } };
  });
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', formatter: (ps) => '第 ' + ps[0].axisValue + ' 回合<br>' + ps.map((x) =>
      x.marker + x.seriesName + '：' + (x.value == null ? '-' : '$' + x.value)).join('<br>') },
    legend: Object.assign({ data: state.compare.map((m, i) => cmpLabel(m, i)) }, legendStyle()),
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: Object.assign({ type: 'category', data: Array.from({ length: maxRounds }, (_, k) => 'R' + (k + 1)) }, axisStyle()),
    yAxis: Object.assign({ type: 'value', name: '双方装备价值 $', nameTextStyle: { color: p.dim } }, axisStyle()),
    series,
  }, true);
}

let cmpSort = { key: 'name', asc: true };

function renderCompareTable() {
  // 行 = 玩家名（跨场同名对齐），列 = 每场；单元格为 Rating≈ · K/D/A · ADR
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
  const p = P();
  const top = state.compare.map((m) => (m.players || [])[0]).filter(Boolean);
  if (!top.length) { c.clear(); return; }
  const maxOf = radarNorm(top);
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: {},
    legend: Object.assign({ data: state.compare.map((m, i) => cmpLabel(m, i) + (top[i] ? ' · ' + top[i].name : '')) }, legendStyle(true)),
    radar: {
      indicator: RADAR_DIMS.map((d) => ({ name: d[1], max: 1 })),
      radius: '58%', center: ['50%', '46%'],
      axisName: { color: p.dim, fontSize: 11 },
      splitLine: { lineStyle: { color: p.line } },
      splitArea: { areaStyle: { color: [rgbaVar('--fg', .015), rgbaVar('--fg', .04)] } },
      axisLine: { lineStyle: { color: p.line } },
    },
    series: [{
      type: 'radar',
      data: top.map((x, i) => ({
        value: RADAR_DIMS.map((d) => Math.min(1, (Number(x[d[0]]) || 0) / maxOf(d[0])).toFixed(3)),
        name: cmpLabel(state.compare[i], i) + ' · ' + x.name,
        itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] },
        areaStyle: { opacity: 0.12 },
      })),
    }],
  }, true);
}

$('#btn-compare').addEventListener('click', () => runCompare([...state.selected]));
$('#btn-clear-sel').addEventListener('click', () => {
  state.selected.clear();
  renderStatsPicker();
  syncCompareBar();
});

/* ================================================================ 设置页 */
$('#set-theme').addEventListener('change', (e) => setSetting('theme', e.target.value));
$('#set-compact').addEventListener('change', (e) => setSetting('compact', e.target.value));
$('#set-tabular').addEventListener('change', (e) => setSetting('tabular', e.target.value));
$('#set-radar').addEventListener('change', (e) => setSetting('radar', e.target.value));
$('#set-livecolor').addEventListener('change', (e) => setSetting('livecolor', e.target.value));
$('#set-every').addEventListener('change', (e) => {
  setSetting('every', e.target.value);
  state.replay = null;
  if (state.sec === 'analysis' && state.page === 'replay') loadReplay();
});

$('#btn-clear-cache').addEventListener('click', async () => {
  const targets = state.matchId ? [state.matchId] : state.matches.map((m) => m.id);
  if (!targets.length) { toast('没有可清理的比赛', true); return; }
  let n = 0;
  for (const id of targets) {
    try { await api('/api/matches/' + id + '/replay', { method: 'DELETE' }); n++; } catch (e) { /* 忽略单场失败 */ }
  }
  state.replay = null;
  toast('已清理 ' + n + ' 场的回放轨迹缓存');
});

$('#btn-reload').addEventListener('click', async () => {
  try {
    await loadMatches();
    if (state.matchId) await openMatch(state.matchId);
    toast('已重载全部数据');
  } catch (e) { toast('重载失败：' + e.message, true); }
});

$('#btn-delete-match').addEventListener('click', async () => {
  if (!state.matchId) { toast('没有选中的比赛', true); return; }
  const m = state.matches.find((x) => x.id === state.matchId);
  const name = m ? m.file_name : state.matchId;
  if (!confirm('确定删除比赛「' + name + '」？\n该操作不可撤销，同时删除其数据集与轨迹缓存。')) return;
  try {
    await api('/api/matches/' + state.matchId, { method: 'DELETE' });
    state.matchId = null;
    state.match = null;
    state.replay = null;
    toast('已删除');
    await loadMatches();
    show('home');
  } catch (e) { toast('删除失败：' + e.message, true); }
});

async function refreshHealth() {
  const el = $('#about-health');
  try {
    const h = await api('/api/health');
    el.textContent = 'v' + (h.version || '?') + ' · 地图资产 ' + (h.mapdata ? '就绪' : '缺失');
  } catch (e) { el.textContent = '后端未连接'; }
}

/* ================================================================ 深链 */
/* 新格式：#s=<section>&p=<page>&m=<match>&heat=&round=&side=&weapon=&frame=&sel=
 * 旧格式：#match=<id>&page=<page>&...  —— 仍可解析，旧书签不失效。 */
const SEC_OF_PAGE = { home: 'home', import: 'import', match: 'analysis', players: 'analysis', map: 'analysis', replay: 'analysis', compare: 'stats', settings: 'settings' };

function writeHash() {
  const { sec, page } = state;
  if (sec === 'home' && !state.matchId) { history.replaceState(null, '', location.pathname); return; }
  const q = new URLSearchParams();
  q.set('s', sec);
  if (SUBPAGES[sec] && page !== PAGE_OF_SEC[sec]) q.set('p', page);
  if (state.matchId) q.set('m', state.matchId);
  if (sec === 'analysis' && page === 'map') {
    const f = state.heatFilter;
    if (state.heatType !== 'kills') q.set('heat', state.heatType);
    if (f.round_num) q.set('round', f.round_num);
    if (f.side) q.set('side', f.side);
    if (f.weapon) q.set('weapon', f.weapon);
  }
  if (sec === 'analysis' && page === 'replay' && state.replayFrame) q.set('frame', state.replayFrame);
  if (sec === 'stats' && state.selected.size) q.set('sel', [...state.selected].join(','));
  history.replaceState(null, '', '#' + q.toString());
}

let hashLock = false;
async function applyHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return false;
  const q = new URLSearchParams(h);
  let sec = q.get('s');
  let page = q.get('p');
  let id = q.get('m') || q.get('match');     // 兼容旧格式 match=
  if (!sec && page) sec = null;              // 旧格式只有 page=
  if (!sec) {
    const legacy = q.get('page');
    if (legacy) { sec = SEC_OF_PAGE[legacy] || 'home'; page = legacy; }
  }
  if (!sec) { if (!id) return false; sec = 'analysis'; page = 'match'; }

  if (!SECTIONS.includes(sec)) sec = 'home';
  if (page && SUBPAGES[sec] && !SUBPAGES[sec].includes(page)) page = PAGE_OF_SEC[sec];
  if (!id) id = state.matchId;

  hashLock = true;
  try {
    if (id) await openMatch(id); else syncNav();

    const sel = (q.get('sel') || '').split(',').filter(Boolean);
    if (sel.length) { state.selected = new Set(sel); renderStatsPicker(); syncCompareBar(); }

    if (sec === 'analysis' && page === 'map') {
      state.heatFilter = { round_num: q.get('round') || '', side: q.get('side') || '', weapon: q.get('weapon') || '' };
      show(sec, page);
      if (state.heatFilter.round_num) $('#f-round').value = state.heatFilter.round_num;
      $('#f-side').value = state.heatFilter.side;
      if (state.heatFilter.weapon) $('#f-weapon').value = state.heatFilter.weapon;
      await loadHeat(q.get('heat') || state.heatType);
    } else if (sec === 'analysis' && page === 'replay') {
      show(sec, page);
      await enterReplayPage(q.get('frame'));
    } else if (sec === 'stats') {
      show(sec, page);
      if (sel.length >= 2) await runCompare(sel);
      else $('#cmp-result').classList.add('hidden');
    } else if (sec === 'home') {
      show('home');
      renderHome();
    } else {
      show(sec, page);
      if (sec === 'settings') refreshHealth();
      if (sec === 'stats') $('#cmp-result').classList.toggle('hidden', state.compare.length === 0);
    }
  } catch (e) {
    toast('打开失败：' + e.message, true);
  } finally {
    hashLock = false;
  }
  return true;
}

window.addEventListener('hashchange', () => {
  if (!hashLock) applyHash();
});

/* ================================================================== 启动 */
applySettings();
HEAT_LUT = buildHeatLUT();
applyHash();   // 先同步 UI，避免旧 hash 时闪一下首页
loadMatches().catch((e) => toast('加载比赛列表失败：' + e.message, true));
