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
  agSelected: new Set(), agRange: '0', agMetric: 'rating',
  primaryId: '', libQ: '', libMap: '', libSort: 'time',
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
  renderHome();   // 首页账号图表同样要跟随主题重建
  setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 60);
}
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));

/* =============================================================== 两级导航 */
const SECTIONS = ['home', 'library', 'import', 'analysis', 'stats', 'settings'];
const SUBPAGES = { analysis: ['match', 'players', 'map', 'replay'], stats: ['compare'] };
const PAGE_OF_SEC = { home: 'home', library: 'library', import: 'import', analysis: 'match', stats: 'compare', settings: 'settings' };

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
  const SEC_EL = { home: 'home', library: 'library', import: 'import', stats: 'compare', settings: 'settings' };
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
  if (sec === 'library') renderLibrary();
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
  /* 比赛列表变了：丢弃已删除场的缓存，默认勾选新加入的账号 */
  const ids = new Set(list.map((m) => m.id));
  [...playerCache.keys()].forEach((id) => { if (!ids.has(id)) playerCache.delete(id); });
  $('#sf-matches').textContent = list.length;
  renderWhoSelect();
  renderLibrary();
  await ensureRoster();          // 名册与聚合都靠 playerCache，这里一次性补齐
  renderHome();
  renderIdentityPanel();
  renderStatsPicker();
  syncCompareBar();
}

/* 顶栏只管「我是谁」：选定后首页统计收敛到该账号；选回空值＝恢复全部账号。
 * 具体看哪场比赛交给 Demo 库与分析区，不再占用顶栏。 */
function renderWhoSelect() {
  const sel = $('#who-select');
  if (!sel) return;
  const ids = getIdentities();
  if (state.primaryId && !ids.some((x) => x.steamid === state.primaryId)) state.primaryId = '';
  sel.innerHTML = '<option value="">' + (ids.length ? '全部账号（' + ids.length + '）' : '未设置账号') + '</option>' +
    ids.map((x) => '<option value="' + escapeAttr(x.steamid) + '">' +
      escapeHtml(identityName(x.steamid)) + '</option>').join('');
  sel.value = state.primaryId || '';
}
$('#who-select').addEventListener('change', (e) => {
  const id = e.target.value;
  state.primaryId = id;
  state.agSelected = new Set(id ? [id] : getIdentities().map((x) => x.steamid));
  state.agDirty = true;
  renderHome();
});
/* 设置页里把某个账号设为默认视角 */
function setPrimary(steamid) {
  /* 深链里的 who 可能已不在清单里，此时退回全部账号而不是保持旧视角 */
  const id = getIdentities().some((x) => x.steamid === steamid) ? steamid : '';
  state.primaryId = id;
  /* 空值 = 全部账号；单选 = 只统计这一个 */
  state.agSelected = new Set(id ? [id] : getIdentities().map((x) => x.steamid));
  renderWhoSelect();
  renderHome();
  renderIdentityPanel();
}

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


/* ================================================================ Demo 库 */
/* 全局「我有什么」：库里全部 demo 的检索、筛选与批量对比入口。
 * 顶栏只管「我是谁」，具体看哪一场由这里决定。 */
function libFiltered() {
  const q = state.libQ.trim().toLowerCase();
  let list = state.matches.filter((m) => {
    if (state.libMap && m.map_name !== state.libMap) return false;
    if (!q) return true;
    return [m.file_name, m.server_name, m.map_name].some((x) => String(x || '').toLowerCase().includes(q));
  });
  const by = {
    time: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    long: (a, b) => (b.playback_time || 0) - (a.playback_time || 0),
    rounds: (a, b) => (b.round_count || 0) - (a.round_count || 0),
    score: (a, b) => ((b.ct_score || 0) + (b.t_score || 0)) - ((a.ct_score || 0) + (a.t_score || 0)),
    name: (a, b) => String(a.file_name).localeCompare(String(b.file_name)),
  };
  return list.sort(by[state.libSort] || by.time);
}
function renderLibraryMaps() {
  const sel = $('#lib-map');
  if (!sel) return;
  const maps = [...new Set(state.matches.map((m) => m.map_name).filter(Boolean))].sort();
  const keep = state.libMap;
  sel.innerHTML = '<option value="">全部地图</option>' +
    maps.map((x) => '<option value="' + escapeAttr(x) + '">' + escapeHtml(x) + '</option>').join('');
  sel.value = maps.includes(keep) ? keep : (state.libMap = '');
}
function renderLibrary() {
  const tbl = $('#tbl-lib');
  if (!tbl) return;
  renderLibraryMaps();
  const list = libFiltered();
  const shown = list.length;
  const total = state.matches.length;
  $('#lib-count').textContent = shown === total
    ? total + ' 场' : shown + ' / ' + total + ' 场';
  /* 空态看的是「筛完剩几条」而不是库里总共几条，否则搜不到时会是一片空白表格 */
  $('#lib-empty').classList.toggle('hidden', shown > 0);
  $('#lib-empty-text').textContent = total
    ? '没有匹配「' + (state.libQ || state.libMap) + '」的比赛。' : '库里还没有比赛。';
  const cur = $('#lib-cur');
  if (cur) cur.textContent = state.matchId
    ? '当前分析：' + ((state.match && state.match.map_name || '?') + ' · ' + (state.match && state.match.ct_score) + ':' + (state.match && state.match.t_score))
    : '';
  $('#lib-bar').classList.toggle('hidden', !state.selected.size);
  $('#lib-selhint').textContent = '已选 ' + state.selected.size + ' 场' +
    (state.selected.size >= 2 ? '，可直接对比' : '，再选至少 1 场即可对比');
  $('#lib-compare').disabled = state.selected.size < 2;
  if (!total) { tbl.innerHTML = ''; return; }

  let html = '<thead><tr><th class="l">文件名</th><th class="l">地图</th><th>比分</th>' +
    '<th>回合</th><th>时长</th><th>大小</th><th>解析</th><th>导入时间</th><th class="l">操作</th></tr></thead><tbody>';
  list.forEach((m) => {
    const curRow = m.id === state.matchId;
    html += '<tr' + (curRow ? ' style="background:var(--panel2)"' : '') + '>' +
      '<td class="l"><input type="checkbox" class="pick" data-libpick="' + escapeAttr(m.id) + '"' +
        (state.selected.has(m.id) ? ' checked' : '') + '> ' +
        '<span' + (curRow ? ' style="color:var(--accent);font-weight:600"' : '') + '>' +
        escapeHtml(m.file_name) + '</span>' +
        (curRow ? ' <span class="pill">分析中</span>' : '') + '</td>' +
      '<td class="l">' + escapeHtml(m.map_name || '?') + '</td>' +
      '<td><span class="ct">' + m.ct_score + '</span> : <span class="t">' + m.t_score + '</span></td>' +
      '<td>' + (m.round_count || 0) + '</td>' +
      '<td>' + (m.playback_time ? Math.round(m.playback_time / 60) + ' 分' : '-') + '</td>' +
      '<td>' + (m.file_size ? (m.file_size / 1048576).toFixed(1) + ' MB' : '-') + '</td>' +
      '<td>' + (m.parse_seconds ? Number(m.parse_seconds).toFixed(1) + 's' : '-') + '</td>' +
      '<td>' + escapeHtml(m.created_at ? new Date(m.created_at * 1000).toLocaleString('zh-CN', { hour12: false }) : '-') + '</td>' +
      '<td class="l"><button class="btn ghost sm" data-libopen="' + escapeAttr(m.id) + '">分析</button> ' +
      '<button class="btn ghost sm" data-libdel="' + escapeAttr(m.id) + '">删除</button></td></tr>';
  });
  tbl.innerHTML = html + '</tbody>';
}
$('#tbl-lib').addEventListener('change', (e) => {
  const id = e.target.dataset.libpick;
  if (!id) return;
  if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
  renderLibrary();
  renderStatsPicker();
  syncCompareBar();
});
$('#tbl-lib').addEventListener('click', (e) => {
  const open = e.target.closest('[data-libopen]');
  if (open) { openMatch(open.dataset.libopen).then(() => show('analysis', 'match')).catch((er) => toast('打开失败：' + er.message, true)); return; }
  const del = e.target.closest('[data-libdel]');
  if (del) deleteMatchById(del.dataset.libdel);
});
$('#lib-q').addEventListener('input', (e) => { state.libQ = e.target.value; renderLibrary(); });
$('#lib-map').addEventListener('change', (e) => { state.libMap = e.target.value; renderLibrary(); });
$('#lib-sort').addEventListener('change', (e) => { state.libSort = e.target.value; renderLibrary(); });
$('#lib-clear').addEventListener('click', () => {
  state.selected.clear();
  renderLibrary();
  renderStatsPicker();
  syncCompareBar();
});
$('#lib-compare').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (ids.length < 2) { toast('至少需要 2 场比赛', true); return; }
  show('stats');
  syncCompareBar();
  await runCompare(ids);
});
function deleteMatchById(id) {
  const m = state.matches.find((x) => x.id === id);
  if (!confirm('确定删除比赛「' + (m ? m.file_name : id) + '」？\n该操作不可撤销，同时删除其数据集与轨迹缓存。')) return;
  api('/api/matches/' + id, { method: 'DELETE' }).then(async () => {
    invalidateMatchCache(id);
    state.selected.delete(id);
    if (state.matchId === id) { state.matchId = null; state.match = null; state.replay = null; }
    toast('已删除');
    await loadMatches();
  }).catch((e) => toast('删除失败：' + e.message, true));
}

/* ==================================================== 我的账号（身份层） */
/* 清单并入 settings.identities，不另开 localStorage 键，避免配置分裂。 */
function getIdentities() {
  const list = settings.identities;
  return Array.isArray(list) ? list.filter((x) => x && x.steamid) : [];
}
function saveIdentities(list) {
  settings.identities = list.map((x) => ({
    steamid: String(x.steamid),
    alias: x.alias == null ? '' : String(x.alias).slice(0, 40),
  }));
  saveSettings();
}
/* 账号候选名册：遍历库里每场比赛的 /players，按 steamid 归并。
 * 结果缓存在 playerCache（matchId → 该场玩家行），名册与聚合共用，一次请求两处用。 */
const playerCache = new Map();

async function loadPlayerRows(matchId) {
  if (playerCache.has(matchId)) return playerCache.get(matchId);
  const rows = (await api('/api/matches/' + matchId + '/players')) || [];
  playerCache.set(matchId, rows);
  return rows;
}
function invalidateMatchCache(matchId) {
  playerCache.delete(matchId);
}
/* 增量补齐名册：已缓存的比赛不再请求 */
async function ensureRoster() {
  const todo = state.matches.map((m) => m.id).filter((id) => !playerCache.has(id));
  for (let i = 0; i < todo.length; i++) {
    try { await loadPlayerRows(todo[i]); }
    catch (e) { playerCache.set(todo[i], []); }   // 单场失败不阻塞其它场
  }
  return roster();
}
function roster() {
  const r = new Map();
  state.matches.forEach((m) => (playerCache.get(m.id) || []).forEach((p) => {
    if (!p || p.steamid == null) return;
    const e = r.get(p.steamid) || { steamid: String(p.steamid), name: null, team: '', count: 0 };
    if (p.name && !e.name) e.name = p.name;
    if (p.team_clan_name) e.team = p.team_clan_name;
    e.count++;
    r.set(String(p.steamid), e);
  }));
  return r;
}
function identityName(steamid, r) {
  const id = getIdentities().find((x) => x.steamid === steamid);
  if (id && id.alias) return id.alias;
  const e = (r || roster()).get(steamid);
  return (e && e.name) || id && id.alias || steamid;
}

/* ==================================================== 聚合层（纯前端） */
/* 场次顺序：state.matches 即后端返回顺序（新的在前）。 */
function matchListForAgg() {
  const n = Number(state.agRange) || 0;
  return n > 0 ? state.matches.slice(0, n) : state.matches;
}
function isSideWin(side, m) {
  if (side === 'counter-terrorist') return m.ct_score > m.t_score ? 1 : (m.ct_score < m.t_score ? 0 : null);
  if (side === 'terrorist') return m.t_score > m.ct_score ? 1 : (m.t_score < m.ct_score ? 0 : null);
  return null;
}
/* 一个账号在统计范围内的逐场记录 */
function aggRows(steamid) {
  const out = [];
  matchListForAgg().forEach((m) => {
    const p = (playerCache.get(m.id) || []).find((x) => String(x.steamid) === String(steamid));
    if (!p) return;
    out.push({ m, p, win: isSideWin(p.side, m) });
  });
  return out;
}
/* 计数类字段求和；比率类字段按 rounds_played 加权平均 */
const AGG_SUM = ['rounds_played', 'kills', 'deaths', 'assists', 'flash_assists', 'headshot_kills',
  'opening_kills', 'opening_deaths', 'traded_deaths', 'multikill_2k', 'multikill_3k',
  'multikill_4k', 'multikill_5k', 'clutches_played', 'clutches_won', 'utility_damage',
  'flashes_thrown', 'enemies_flashed'];
const AGG_RATE = ['rating', 'adr', 'kast', 'headshot_pct'];

function aggSummary(rows) {
  const s = { games: rows.length, rounds: 0, kills: 0, deaths: 0, assists: 0, w: 0, l: 0, u: 0, maps: {} };
  /* rounds 是 rounds_played 的别名，KPI「总回合」直接读它 */
  AGG_SUM.forEach((k) => { s[k] = 0; });
  AGG_RATE.forEach((k) => { s[k] = 0; });
  const wr = rows.reduce((a, r) => a + (r.p.rounds_played || 0), 0) || 1;
  rows.forEach((r) => {
    AGG_SUM.forEach((k) => { s[k] += Number(r.p[k]) || 0; });
    AGG_RATE.forEach((k) => { s[k] += (Number(r.p[k]) || 0) * (r.p.rounds_played || 0); });
    if (r.win == null) s.u++; else if (r.win) s.w++; else s.l++;
    const mk = r.m.map_name || '未知';
    s.maps[mk] = s.maps[mk] || { map: mk, games: 0, rounds: 0, kills: 0, deaths: 0, assists: 0, rating: 0, adr: 0, kast: 0, w: 0, l: 0 };
    const g = s.maps[mk];
    g.games++; g.rounds += Number(r.p.rounds_played) || 0;
    g.kills += Number(r.p.kills) || 0; g.deaths += Number(r.p.deaths) || 0; g.assists += Number(r.p.assists) || 0;
    const rw = r.p.rounds_played || 1;
    g.rating += (Number(r.p.rating) || 0) * rw;
    g.adr += (Number(r.p.adr) || 0) * rw;
    g.kast += (Number(r.p.kast) || 0) * rw;
    if (r.win == null) { /* 无阵营信息不记胜负 */ } else if (r.win) g.w++; else g.l++;
  });
  AGG_RATE.forEach((k) => { s[k] /= wr; });
  s.rounds = s.rounds_played;   // KPI「总回合」读 rounds，AGG_SUM 求和的字段名是 rounds_played
  Object.values(s.maps).forEach((g) => {
    const w = g.rounds || 1;
    g.rating /= w; g.adr /= w; g.kast /= w;
    g.kd = g.deaths ? g.kills / g.deaths : g.kills;
  });
  s.kd = s.deaths ? s.kills / s.deaths : s.kills;
  s.winRate = s.w + s.l ? s.w / (s.w + s.l) : null;
  return s;
}

/* ================================================ 首页：按账号聚合渲染 */
/* 保留库里级信息（最近比赛 / 解析队列），主体改为账号维度。 */
const AG_METRICS = [
  ['rating', 'Rating≈'], ['adr', 'ADR'], ['kast', 'KAST'], ['headshot_pct', '爆头率'],
  ['opening_kills', '首杀'], ['utility_damage', '道具伤害'],
];

function agSelected() {
  return getIdentities().filter((x) => state.agSelected.has(x.steamid));
}
function agToggle(steamid) {
  if (state.agSelected.has(steamid)) state.agSelected.delete(steamid);
  else state.agSelected.add(steamid);
  state.agDirty = true;
  renderHome();
}
function renderHome() {
  renderHomeLibrary();
  renderAgChips();
  const ids = agSelected();
  const rows = ids.map((x) => ({ id: x, rows: aggRows(x.steamid) }));
  const shown = rows.filter((r) => r.rows.length);
  $('#ag-empty').classList.toggle('hidden', getIdentities().length > 0);
  $('#ag-hint').textContent = getIdentities().length
    ? getIdentities().length + ' 个账号 · 已选 ' + ids.length : '';
  const ctrl = $('#ag-ctrl');
  if (ctrl) ctrl.classList.toggle('hidden', !ids.length);
  const have = shown.length > 0;
  ['ag-kpis', 'ag-summary-card', 'ag-map-card', 'ag-trend-card', 'ag-radar-card'].forEach((id) => {
    $('#' + id).classList.toggle('hidden', !have);
  });
  if (!have) {
    $('#ag-kpis').innerHTML = '';
    ['chart-ag-trend', 'chart-ag-radar'].forEach((id) => { const c = charts[id]; if (c) c.clear(); });
    return;
  }
  renderAgKpis(shown);
  renderAgTrend(shown);
  renderAgRadar(shown);
  renderAgTable(shown);
  renderAgMap(shown);
}
function renderHomeLibrary() {
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
  const lc = $('#home-lib-count');
  if (lc) lc.textContent = state.matches.length;
  const last = state.matches[0];
  const meta = $('#home-meta');
  if (meta) {
    meta.innerHTML = [
      ['比赛', state.matches.length],
      ['总回合', state.matches.reduce((s, m) => s + (m.round_count || 0), 0)],
      ['总时长', Math.round(state.matches.reduce((s, m) => s + (m.playback_time || 0), 0) / 60) + ' 分'],
    ].map(([k, v]) => '<span class="pill">' + k + ' ' + v + '</span>').join('') +
      ([...state.tasks.values()].filter((t) => t.status === 'pending' || t.status === 'running').length
        ? '<span class="pill">解析中 ' + [...state.tasks.values()].filter((t) => t.status === 'pending' || t.status === 'running').length + '</span>' : '') +
      (state.primaryId ? '<span class="pill">视角 ' + escapeHtml(identityName(state.primaryId)) + '</span>' : '') +
      (last ? '<span class="pill">最近 ' + escapeHtml(last.map_name || '?') + ' ' + last.ct_score + ':' + last.t_score + '</span>' : '');
  }
}
/* 账号 chips：显示该账号在统计范围内的出场数与胜负，点击切换是否统计 */
function renderAgChips() {
  const box = $('#ag-chips');
  if (!box) return;
  const r = roster();
  const ids = getIdentities();
  if (!ids.length) { box.innerHTML = ''; return; }
  box.innerHTML = ids.map((x) => {
    const on = state.agSelected.has(x.steamid);
    const rows = on ? aggRows(x.steamid) : [];
    const w = rows.filter((r2) => r2.win).length, l = rows.filter((r2) => r2.win === 0).length;
    return '<span class="chip' + (on ? ' on' : '') + '" data-sid="' + escapeAttr(x.steamid) + '">' +
      '<span class="cn">' + escapeHtml(identityName(x.steamid, r)) + '</span>' +
      '<span class="cs">' + rows.length + ' 场' + (l ? ' <span class="win">' + w + '-' + l + '</span>' : '') + '</span>' +
      '<button class="x" title="从清单移除" data-rm="' + escapeAttr(x.steamid) + '">×</button>' +
      '</span>';
  }).join('');
}
$('#ag-chips') && $('#ag-chips').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  const chip = e.target.closest('[data-sid]');
  if (rm) {
    saveIdentities(getIdentities().filter((x) => x.steamid !== rm.dataset.rm));
    state.agSelected.delete(rm.dataset.rm);
    renderHome();
    renderIdentityPanel();
    return;
  }
  if (chip) agToggle(chip.dataset.sid);
});
(function initAgMetric() {
  const sel = $('#ag-metric');
  sel.innerHTML = AG_METRICS.map((m) => '<option value="' + m[0] + '">' + m[1] + '</option>').join('');
  sel.value = state.agMetric;
  sel.addEventListener('change', (e) => { state.agMetric = e.target.value; renderHome(); });
  $('#ag-range').value = state.agRange;
})();
$('#ag-range').addEventListener('change', (e) => {
  state.agRange = e.target.value;
  renderHome();
});
function renderAgKpis(shown) {
  const n = shown.length;
  const agg = shown.map((r) => aggSummary(r.rows));
  const tot = agg.reduce((a, s) => ({
    games: a.games + s.games, rounds: a.rounds + s.rounds, kills: a.kills + s.kills,
    deaths: a.deaths + s.deaths, w: a.w + s.w, l: a.l + s.l,
  }), { games: 0, rounds: 0, kills: 0, deaths: 0, w: 0, l: 0 });
  const wr = tot.w + tot.l ? Math.round(tot.w / (tot.w + tot.l) * 100) : null;
  const kd = tot.deaths ? (tot.kills / tot.deaths).toFixed(2) : '-';
  const avg = (k) => (agg.reduce((a, s) => a + s[k], 0) / (n || 1)).toFixed(2);
  $('#ag-kpis').innerHTML = [
    ['账号', n, '已选账号中参与过比赛的'],
    ['场次', tot.games, '所选账号出场合计'],
    ['总回合', tot.rounds, 'rounds_played 合计'],
    ['胜率', wr == null ? '-' : wr + '%', tot.w + ' 胜 ' + tot.l + ' 负'],
    ['平均 Rating', avg('rating'), '按回合加权'],
    ['平均 ADR', avg('adr'), '按回合加权'],
    ['平均 KAST', avg('kast'), '按回合加权'],
    ['KD', kd, tot.kills + ' 杀 / ' + tot.deaths + ' 死'],
  ].map(([k, v, s]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v +
    '</div><div class="s">' + s + '</div></div>').join('');
}
/* 库里若只有同一份 demo 的多次解析，折线会退化成一条水平线 —— 这是数据事实，
 * 不在这里伪造跨度掩盖它；等导入不同 demo 后自然展开。 */
function renderAgTrend(shown) {
  const c = chart('chart-ag-trend');
  if (!c) return;
  const key = state.agMetric || 'rating';
  const labels = shown.map((r) => identityName(r.id.steamid));
  /* 序列按场次（state.matches 顺序，最新在右）逐点；账号缺场则跳过 */
  const ms = matchListForAgg().map((m) => m).reverse();
  const series = shown.map((r, i) => ({
    name: labels[i],
    type: 'line', smooth: true, connectNulls: true, symbolSize: 6,
    data: ms.map((m) => {
      const hit = r.rows.find((x) => x.m.id === m.id);
      return hit ? Number(hit.p[key]) || 0 : null;
    }),
    itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] },
  }));
  $('#ag-trend-note').textContent = (AG_METRICS.find((x) => x[0] === key) || ['', key])[1] + ' · 共 ' + ms.length + ' 场';
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: Object.assign({ data: labels }, legendStyle(true)),
    grid: { left: 46, right: 24, top: 36, bottom: 52 },
    xAxis: Object.assign({ type: 'category', data: ms.map((m) => (m.map_name || '?') + ' ' + (m.round_count || 0)) + 'R' },
      axisStyle({ boundaryGap: false })),
    yAxis: Object.assign({ type: 'value', name: key, scale: true, nameTextStyle: { color: P().dim } }, axisStyle()),
    series,
  }, true);
}
function renderAgRadar(shown) {
  const c = chart('chart-ag-radar');
  if (!c) return;
  const r = roster();
  /* 归一：跨账号取最大值（比场间混合更可比），仍可用固定上限 */
  const caps = (k) => settings.radar === 'fixed' ? RADAR_CAPS[k]
    : Math.max(1, ...shown.map((x) => aggSummary(x.rows)[k]));
  const vals = shown.map((x) => aggSummary(x.rows));
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: {},
    legend: Object.assign({ data: shown.map((x, i) => identityName(x.id.steamid, r)) }, legendStyle(true)),
    radar: {
      indicator: RADAR_DIMS.map((d) => ({ name: d[1], max: 1 })),
      radius: '60%', center: ['50%', '46%'],
      axisName: { color: P().dim, fontSize: 11 },
      splitLine: { lineStyle: { color: P().line } },
      splitArea: { areaStyle: { color: [rgbaVar('--fg', .015), rgbaVar('--fg', .04)] } },
      axisLine: { lineStyle: { color: P().line } },
    },
    series: [{
      type: 'radar',
      data: shown.map((x, i) => ({
        value: RADAR_DIMS.map((d) => Math.min(1, (Number(vals[i][d[0]]) || 0) / caps(d[0]))),
        name: identityName(x.id.steamid, r),
        itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] },
        areaStyle: { opacity: 0.12 },
      })),
    }],
  }, true);
}
const AG_COLS = [
  ['name', '账号', 's'], ['games', '场次', 'n'], ['rounds', '回合', 'n'], ['w', '胜', 'n'], ['l', '负', 'n'],
  ['winRate', '胜率', 'n'], ['rating', 'Rating≈', 'n'], ['kills', 'K', 'n'], ['deaths', 'D', 'n'],
  ['assists', 'A', 'n'], ['kd', 'KD', 'n'], ['adr', 'ADR', 'n'], ['kast', 'KAST', 'n'],
  ['headshot_pct', '爆头', 'n'], ['opening_kills', '首杀', 'n'], ['opening_deaths', '首死', 'n'],
  ['clutches_won', '残局胜', 'n'], ['utility_damage', '道具伤害', 'n'],
];
let agSort = { key: 'rating', asc: false };
function renderAgTable(shown) {
  const r = roster();
  const rows = shown.map((x) => {
    const s = aggSummary(x.rows);
    s.name = identityName(x.id.steamid, r);
    s.steamid = x.id.steamid;
    return s;
  });
  rows.sort((a, b) => {
    const av = a[agSort.key], bv = b[agSort.key];
    const c = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (Number(av) || 0) - (Number(bv) || 0);
    return agSort.asc ? c : -c;
  });
  const arrow = (k) => agSort.key === k ? (agSort.asc ? ' ▲' : ' ▼') : '';
  let html = '<thead><tr>' + AG_COLS.map((c) => '<th data-k="' + c[0] + '" class="' + (c[2] === 's' ? 'l' : '') + '">' +
    c[1] + arrow(c[0]) + '</th>').join('') + '</tr></thead><tbody>';
  rows.forEach((x) => {
    html += '<tr>' + AG_COLS.map((c) => {
      let v = x[c[0]];
      if (c[0] === 'name') v = escapeHtml(v);
      else if (c[0] === 'winRate') v = v == null ? '-' : Math.round(v * 100) + '%';
      else if (typeof v === 'number') v = (c[0] === 'rating' || c[0] === 'adr' || c[0] === 'kast' ||
        c[0] === 'headshot_pct' || c[0] === 'kd') ? v.toFixed(2) : v;
      else v = escapeHtml(v == null ? '-' : v);
      return '<td class="' + (c[2] === 's' ? 'l' : '') + '">' + v + '</td>';
    }).join('') + '</tr>';
  });
  const tbl = $('#tbl-ag');
  tbl.innerHTML = html + '</tbody>';
  tbl.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (agSort.key === k) agSort.asc = !agSort.asc; else { agSort.key = k; agSort.asc = false; }
    renderAgTable(shown);
  }));
}
function renderAgMap(shown) {
  const r = roster();
  /* 行 = 账号 × 地图，列 = 同一组指标 */
  const rows = [];
  shown.forEach((x) => {
    const s = aggSummary(x.rows);
    Object.values(s.maps).forEach((g) => {
      g.name = identityName(x.id.steamid, r);
      g.steamid = x.id.steamid;
      g.winRate = g.w + g.l ? g.w / (g.w + g.l) : null;
      rows.push(g);
    });
  });
  rows.sort((a, b) => (b.rounds || 0) - (a.rounds || 0));
  const cols = [['name', '账号', 's'], ['map', '地图', 's'], ['games', '场次', 'n'], ['rounds', '回合', 'n'],
    ['w', '胜', 'n'], ['l', '负', 'n'], ['winRate', '胜率', 'n'], ['rating', 'Rating≈', 'n'],
    ['kills', 'K', 'n'], ['deaths', 'D', 'n'], ['kd', 'KD', 'n'], ['adr', 'ADR', 'n'], ['kast', 'KAST', 'n']];
  let html = '<thead><tr>' + cols.map((c) => '<th class="' + (c[2] === 's' ? 'l' : '') + '">' + c[1] + '</th>').join('') +
    '</tr></thead><tbody>';
  rows.forEach((x) => {
    html += '<tr>' + cols.map((c) => {
      let v = x[c[0]];
      if (c[0] === 'name') v = escapeHtml(v);
      else if (c[0] === 'map') v = escapeHtml(v);
      else if (c[0] === 'winRate') v = v == null ? '-' : Math.round(v * 100) + '%';
      else if (typeof v === 'number') v = (c[0] === 'rating' || c[0] === 'adr' || c[0] === 'kast' || c[0] === 'kd')
        ? v.toFixed(2) : v;
      else v = escapeHtml(v == null ? '-' : v);
      return '<td class="' + (c[2] === 's' ? 'l' : '') + '">' + v + '</td>';
    }).join('') + '</tr>';
  });
  $('#tbl-ag-map').innerHTML = html + '</tbody>';
}

/* --------------------------------------------------- 设置页：我的账号面板 */
function renderIdentityPanel() {
  const box = $('#id-chips');
  if (!box) return;
  const r = roster();
  const ids = getIdentities();
  $('#id-count').textContent = ids.length ? ids.length + ' 个' : '';
  $('#id-none').classList.toggle('hidden', ids.length > 0);
  box.innerHTML = ids.map((x) => {
    const e = r.get(x.steamid);
    return '<span class="chip on" title="' + escapeAttr(x.steamid) + '">' +
      '<button class="sw-star" title="' + (state.primaryId === x.steamid ? '当前视角账号' : '设为顶栏默认视角') + '" data-idstar="' +
      escapeAttr(x.steamid) + '" style="background:' + (state.primaryId === x.steamid ? 'var(--accent)' : 'transparent') +
      ';border-color:' + (state.primaryId === x.steamid ? 'var(--accent)' : 'var(--line)') + '">★</button>' +
      '<span class="cn">' + escapeHtml(x.alias || identityName(x.steamid, r)) + '</span>' +
      '<span class="cs">' + (e ? e.count + ' 场' : '库中无记录') + (e && e.team ? ' · ' + escapeHtml(e.team) : '') + '</span>' +
      '<button class="x" title="移除" data-idrm="' + escapeAttr(x.steamid) + '">×</button></span>';
  }).join('');
  /* 候选下拉：库中出现过的全部玩家，已添加的排除 */
  const sel = $('#id-add');
  const cand = [...r.values()].filter((e) => !ids.some((x) => x.steamid === e.steamid))
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
  const keep = sel.value;
  sel.innerHTML = cand.length
    ? cand.map((e) => '<option value="' + escapeAttr(e.steamid) + '">' +
        escapeHtml((e.name || '(未知)') + ' · ' + e.count + ' 场' + (e.team ? ' · ' + e.team : '')) +
        '</option>').join('')
    : '<option value="">名册为空，先导入比赛</option>';
  if (cand.some((e) => e.steamid === keep)) sel.value = keep;
  renderWhoSelect();
}
$('#id-chips').addEventListener('click', (e) => {
  const star = e.target.closest('[data-idstar]');
  if (star) { setPrimary(state.primaryId === star.dataset.idstar ? '' : star.dataset.idstar); return; }
  const rm = e.target.closest('[data-idrm]');
  if (!rm) return;
  saveIdentities(getIdentities().filter((x) => x.steamid !== rm.dataset.idrm));
  state.agSelected.delete(rm.dataset.idrm);
  renderIdentityPanel();
  renderHome();
});
$('#btn-id-add').addEventListener('click', () => {
  const steamid = $('#id-add').value;
  if (!steamid) { toast('没有可添加的玩家', true); return; }
  const alias = $('#id-alias').value.trim();
  const list = getIdentities();
  if (list.some((x) => x.steamid === steamid)) { toast('已经在清单里了', true); return; }
  list.push({ steamid, alias });
  saveIdentities(list);
  $('#id-alias').value = '';
  if (!state.agSelected.has(steamid)) state.agSelected.add(steamid);
  renderIdentityPanel();
  renderHome();
  toast('已添加 ' + identityName(steamid));
});
$('#btn-id-refresh').addEventListener('click', async () => {
  [...playerCache.keys()].forEach((k) => playerCache.delete(k));
  $('#id-count').textContent = '刷新中…';
  await ensureRoster();
  renderIdentityPanel();
  renderHome();
  toast('名册已刷新：' + roster().size + ' 名玩家');
});
$('#id-add').addEventListener('change', () => { $('#id-alias').value = ''; });

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
  /* 名册缓存同步这一场的玩家行（刚解析完的比赛要能立即进统计） */
  loadPlayerRows(id).then(() => { if (state.sec === 'home') renderHome(); }).catch(() => {});
  /* 当前比赛变了：库表格要标出正在分析的那一行 */
  renderLibrary();
  const cur = $('#lib-cur');
  if (cur) cur.textContent = m.map_name + ' · ' + m.ct_score + ':' + m.t_score + ' · ' + m.file_name;
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
const SEC_OF_PAGE = { home: 'home', library: 'library', import: 'import', match: 'analysis', players: 'analysis', map: 'analysis', replay: 'analysis', compare: 'stats', settings: 'settings' };

function writeHash() {
  const { sec, page } = state;
  if (sec === 'home' && !state.matchId && !state.primaryId) { history.replaceState(null, '', location.pathname); return; }
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
  if (state.primaryId && (sec === 'home' || sec === 'library')) q.set('who', state.primaryId);
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

  /* 视角账号要在 show() 之前定下来：show() 内部会调 writeHash()，
   * 那时 state.primaryId 必须已是最终值，否则深链的 who= 会被自己抹掉。 */
  setPrimary(q.get('who') || '');

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
/* 默认统计所有已添加账号（用户可在首页 chips 上取消勾选） */
if (getIdentities().length) state.agSelected = new Set(getIdentities().map((x) => x.steamid));
if (state.agMetric) $('#ag-metric').value = state.agMetric;
applyHash();   // 先同步 UI，避免旧 hash 时闪一下首页
loadMatches().catch((e) => toast('加载比赛列表失败：' + e.message, true));
