/* CS2 数据面板 前端 · 公共层 —— 无构建链，直接 ES2020
 * 文件按页面拆分，用普通 <script> 顺序加载、共享全局作用域：
 *   core → identity → library → home → import → match → map → replay → compare → settings → boot
 * 本文件：工具函数、设置层、主题取色、图表注册、全局状态、两级导航。
 * 硬约束：零构建链 / 零 CDN / 零框架；steamid 一律当字符串；上传走原始字节流。
 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new Error('连不上后端（程序是否已退出？）'); }
  if (!res.ok) {
    let detail = res.status + ' ' + res.statusText;
    try {
      const body = await res.json();
      if (body && body.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch (e) { /* 非 JSON 错误体 */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

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

/* ---------------------------------------------------------------- 格式化 */
function fmt(v, d = 2) {
  if (v == null || v === '' || !isFinite(Number(v))) return '-';
  return Number(v).toFixed(d);
}
function fmtPct(v, d = 0) { return v == null ? '-' : Number(v).toFixed(d) + '%'; }
function fmtRate(v) { return v == null ? '-' : Math.round(v * 100) + '%'; }
function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return x.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtDate(ts, withTime) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    (withTime ? ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : '');
}
function shortDate(ts) {
  if (!ts) return '?';
  const d = new Date(ts * 1000);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
function mapLabel(name) { return String(name || '?').replace(/^de_/, ''); }
const SIDE_LABEL = { 'counter-terrorist': 'CT', terrorist: 'T' };
function sidePill(side) {
  if (side === 'counter-terrorist') return '<span class="pill ct">CT</span>';
  if (side === 'terrorist') return '<span class="pill t">T</span>';
  return '<span class="dim">-</span>';
}
function resultPill(r) {
  if (r === 'W') return '<span class="pill ok">胜</span>';
  if (r === 'L') return '<span class="pill bad">负</span>';
  if (r === 'T') return '<span class="pill">平</span>';
  return '';
}
function lowBadge(row) { return row && row.sample === 'low' ? ' <span class="badge-low" title="样本不足，不下结论">样本少</span>' : ''; }
/* 环比箭头：cur 相对 prev 变化；higherIsBetter=false 时反过来着色 */
function delta(cur, prev, digits = 2, higherIsBetter = true) {
  if (cur == null || prev == null) return '';
  const d = cur - prev;
  if (Math.abs(d) < Math.pow(10, -digits) / 2) return '<span class="delta">±0</span>';
  const good = higherIsBetter ? d > 0 : d < 0;
  return '<span class="delta ' + (good ? 'up' : 'down') + '">' + (d > 0 ? '▲' : '▼') + Math.abs(d).toFixed(digits) + '</span>';
}

/* ================================================================== 设置层 */
const DEFAULTS = { theme: 'dark', compact: '0', tabular: '1', every: '8', radar: 'max', livecolor: '1' };
const LS = 'cs2panel.settings';
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { /* ignore */ }

function saveSettings() {
  try { localStorage.setItem(LS, JSON.stringify(settings)); } catch (e) { /* 隐私模式等 */ }
}
function setSetting(k, v) {
  const prev = settings[k];
  settings[k] = String(v);
  saveSettings();
  applySettings();
  // 主题或图表配色变化：重建 ECharts 主题并重绘，让图表跟随 CSS 变量
  if ((k === 'theme' || k === 'livecolor') && prev !== settings[k]) requestAnimationFrame(rebuildCharts);
  if (k === 'radar') rebuildCharts();
}
function applySettings() {
  document.documentElement.setAttribute('data-theme', settings.theme === 'light' ? 'light' : 'dark');
  document.body.classList.toggle('compact', settings.compact === '1');
  document.body.classList.toggle('tabular', settings.tabular !== '0');
  state.replayEvery = Number(settings.every) || 8;
  $('#btn-theme').textContent = settings.theme === 'light' ? '深色' : '浅色';
  ['theme', 'compact', 'tabular', 'every', 'radar', 'livecolor'].forEach((k) => {
    const el = $('#set-' + k);
    if (el) el.value = settings[k];
  });
  $('#r-every').value = state.replayEvery;
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
    dim: cssVar('--dim'), fg: cssVar('--fg'), line: cssVar('--line'), line2: cssVar('--line-2'),
    accent: cssVar('--accent'), ct: cssVar('--ct'), t: cssVar('--t'), bg: cssVar('--bg'),
    panel: cssVar('--panel'), panel2: cssVar('--panel2'), ok: cssVar('--ok'), bad: cssVar('--bad'),
  };
}
const CMP_COLORS = ['#4a90d9', '#f5a623', '#3fb950', '#b57edc', '#e06c9f', '#36b9cc', '#8bc34a', '#ff7043'];

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
  return { textStyle: { color: P().dim }, type: 'scroll', ...(bottom ? { bottom: 0 } : {}) };
}
function radarStyle(extra) {
  const p = P();
  return Object.assign({
    axisName: { color: p.dim, fontSize: 11 },
    splitLine: { lineStyle: { color: p.line } },
    splitArea: { areaStyle: { color: [rgbaVar('--fg', .015), rgbaVar('--fg', .04)] } },
    axisLine: { lineStyle: { color: p.line } },
  }, extra);
}

/* ================================================================== 状态 */
const state = {
  matchId: null, match: null, players: [], rounds: [], roundRows: [], economy: [], heatType: 'kills',
  highlights: [], matches: [], selected: new Set(),
  heatFilter: { round_num: '', side: '', weapon: '', steamid: '' },
  weapons: [],
  replay: null, replayRound: null, replayFrame: 0, replayTimer: null, replaySpeed: 1, replayEvery: 8,
  kills: null,
  compare: [],
  sec: 'home', page: 'home',
  tasks: new Map(),
  agSelected: new Set(), agRange: '0', agMap: '', agMetric: 'rating', agMapView: 'map',
  primaryId: '', libQ: '', libMap: '', libDemo: '', libSort: 'time',
  overview: null,
};
const charts = {};

/* ECharts 自定义主题：从 CSS 变量生成，切主题时重新注册并重建实例。 */
let echartsThemeFor = null;
function echartsTheme() {
  if (settings.livecolor !== '1') return 'dark';
  const name = 'panel-' + settings.theme;
  if (echartsThemeFor === name) return name;
  const p = P();
  const axis = {
    axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false }, axisLabel: { color: p.dim },
    splitLine: { lineStyle: { color: p.line2 } }, splitArea: { show: false },
  };
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
    categoryAxis: axis, valueAxis: axis, logAxis: axis, timeAxis: axis,
  });
  echartsThemeFor = name;
  return name;
}

function chart(id) {
  const el = document.getElementById(id);
  if (!el || typeof echarts === 'undefined') return null;
  if (!charts[id]) charts[id] = echarts.init(el, echartsTheme());
  return charts[id];
}
function resizeCharts() { Object.values(charts).forEach((c) => { try { c.resize(); } catch (e) { /* 隐藏中 */ } }); }

/* 各页面注册自己的「主题变化后重画」回调，避免公共层知道每个页面的细节 */
const redrawHooks = [];
function onRedraw(fn) { redrawHooks.push(fn); }
function rebuildCharts() {
  Object.keys(cssCache).forEach((k) => delete cssCache[k]);
  echartsThemeFor = null;
  Object.values(charts).forEach((c) => { try { c.dispose(); } catch (e) { /* ignore */ } });
  Object.keys(charts).forEach((k) => delete charts[k]);
  redrawHooks.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  setTimeout(resizeCharts, 60);
}
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resizeCharts, 120); });

/* =============================================================== 两级导航 */
const SECTIONS = ['home', 'library', 'import', 'analysis', 'stats', 'settings'];
const SUBPAGES = { analysis: ['match', 'players', 'map', 'replay'], stats: ['compare'] };
const PAGE_OF_SEC = { home: 'home', library: 'library', import: 'import', analysis: 'match', stats: 'compare', settings: 'settings' };
const SEC_OF_PAGE = { home: 'home', library: 'library', import: 'import', match: 'analysis', players: 'analysis', map: 'analysis', replay: 'analysis', compare: 'stats', settings: 'settings' };
/* 进入页面时的加载动作（各页面文件里登记） */
const pageEnter = {};

function syncNav() {
  const { sec, page } = state;
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec && !b.dataset.page));
  $$('#nav .nav-subitem').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec && b.dataset.page === page));
  // 一级入口本身也带 data-page，它就是该 section 的落地页
  $$('#nav > .nav-item[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
  $('#grp-analysis').classList.toggle('open', sec === 'analysis');
  $('#grp-caret').textContent = sec === 'analysis' ? '▾' : '▸';
  $$('#nav [data-page]').forEach((b) => { if (b.dataset.sec === 'analysis') b.disabled = !state.matchId; });
  $('#nav-analysis').title = state.matchId ? '' : '先在 Demo 库里打开一场比赛';
}

function show(sec, page) {
  sec = SECTIONS.includes(sec) ? sec : 'home';
  page = page || PAGE_OF_SEC[sec];
  if (SUBPAGES[sec] && !SUBPAGES[sec].includes(page)) page = PAGE_OF_SEC[sec];
  if (sec === 'analysis' && !state.matchId) { sec = 'library'; page = 'library'; }
  const leaving = state.page;
  state.sec = sec;
  state.page = page;
  // analysis 是唯一的二级区：它本身没有 section 元素，只显示当前子页。stats 的 section 元素 id 是 page-compare。
  const SEC_EL = { home: 'home', library: 'library', import: 'import', stats: 'compare', settings: 'settings' };
  Object.keys(SEC_EL).forEach((s) => {
    const el = document.getElementById('page-' + SEC_EL[s]);
    if (el) el.classList.toggle('hidden', s !== sec);
  });
  SUBPAGES.analysis.forEach((p) => {
    const el = document.getElementById('page-' + p);
    if (el) el.classList.toggle('hidden', !(sec === 'analysis' && p === page));
  });
  if (leaving === 'replay' && page !== 'replay' && typeof stopPlayback === 'function') stopPlayback();
  syncNav();
  setTimeout(resizeCharts, 60);
  closeSidebar();
  writeHash();
}

/* 导航并触发该页的加载动作。opts.silent=true 时只切页面不加载（深链恢复时用）。 */
function go(sec, page, opts) {
  show(sec, page);
  const fn = pageEnter[state.page];
  if (fn && !(opts && opts.silent)) Promise.resolve(fn(opts || {})).catch((e) => toast(e.message, true));
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  go(b.dataset.sec, b.dataset.page || PAGE_OF_SEC[b.dataset.sec]);
});
$('.content').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (!b || b.disabled) return;
  go(b.dataset.go, b.dataset.page || PAGE_OF_SEC[b.dataset.go]);
});

/* 移动端抽屉 */
function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }
$('#btn-menu').addEventListener('click', openSidebar);
$('#scrim').addEventListener('click', closeSidebar);
$('#btn-theme').addEventListener('click', () => setSetting('theme', settings.theme === 'light' ? 'dark' : 'light'));

/* 通用：表头点击排序的表格渲染。cols = [[key, 标题, 'n'|'s', 格式化函数?]] */
function sortableTable(tbl, rows, cols, sortState, rerender, rowAttr) {
  const key = sortState.key;
  const sorted = [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    const c = (typeof av === 'string' || typeof bv === 'string')
      ? String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv))
      : (Number(av) || 0) - (Number(bv) || 0);
    return sortState.asc ? c : -c;
  });
  let html = '<thead><tr>' + cols.map((c) => '<th data-k="' + c[0] + '" class="' + (c[2] === 's' ? 'l' : '') + '">' +
    c[1] + (key === c[0] ? (sortState.asc ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr></thead><tbody>';
  sorted.forEach((r) => {
    html += '<tr' + (rowAttr ? ' ' + rowAttr(r) : '') + '>' + cols.map((c) => {
      const v = c[3] ? c[3](r[c[0]], r) : (typeof r[c[0]] === 'number' ? r[c[0]] : escapeHtml(r[c[0]] == null ? '-' : r[c[0]]));
      return '<td class="' + (c[2] === 's' ? 'l' : '') + '">' + v + '</td>';
    }).join('') + '</tr>';
  });
  tbl.innerHTML = html + '</tbody>';
  tbl.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (sortState.key === k) sortState.asc = !sortState.asc; else { sortState.key = k; sortState.asc = false; }
    rerender();
  }));
}
