/* 我的数据：按账号跨场统计。所有数字来自后端聚合接口，前端只负责画。
 * 旧版在前端逐场拉 /players 再用 JS 合并（N+1 请求），胜负还按阵营比分误判，现已全部下沉到后端。 */
'use strict';

const AG_METRICS = [
  ['rating', 'Rating≈'], ['adr', 'ADR'], ['kast', 'KAST'], ['headshot_pct', '爆头率'],
  ['kills', '击杀'], ['opening_kills', '首杀'], ['utility_damage', '道具伤害'],
];
const AG_RADAR = [['rating', 'Rating≈', 1.6], ['adr', 'ADR', 120], ['kast', 'KAST', 100],
  ['headshot_pct', '爆头率', 70], ['kd', 'KD', 2], ['open_pct', '首杀成功率', 100]];
const home = { token: 0, data: null, report: null };

function agSelectedIds() {
  return getIdentities().map((x) => x.steamid).filter((s) => state.agSelected.has(s));
}
function scopeQuery(extra) {
  const q = new URLSearchParams(extra || {});
  if (Number(state.agRange) > 0) q.set('last', state.agRange);
  if (state.agMap) q.set('map', state.agMap);
  return q.toString();
}

async function loadHome() {
  renderHomeLibrary();
  renderAgChips();
  const ids = agSelectedIds();
  const hasIds = getIdentities().length > 0;
  $('#ag-empty').classList.toggle('hidden', hasIds);
  $('#ag-ctrl').classList.toggle('hidden', !ids.length);
  $('#ag-hint').textContent = hasIds ? getIdentities().length + ' 个账号 · 已选 ' + ids.length : '';
  if (!ids.length) { showHomeCards(false); return; }

  const token = ++home.token;
  $('#ag-progress').textContent = '加载中…';
  try {
    const summ = await api('/api/players/summary?' + scopeQuery({ steamids: ids.join(',') }));
    if (token !== home.token) return;
    const shown = summ.accounts.filter((a) => a.games > 0);
    if (!shown.length) {
      showHomeCards(false);
      $('#ag-progress').textContent = '所选账号在当前范围内没有比赛';
      return;
    }
    const focus = shown.find((a) => a.steamid === state.primaryId) || shown[0];
    const mapDim = state.agMapView === 'map_side' ? 'map_side' : 'map';
    const [timelines, maps, weapons, econ, insights, hls] = await Promise.all([
      Promise.all(shown.map((a) => api('/api/players/' + a.steamid + '/timeline?' + scopeQuery()))),
      Promise.all(shown.map((a) => api('/api/players/' + a.steamid + '/breakdown?' + scopeQuery({ dim: mapDim })))),
      api('/api/players/' + focus.steamid + '/breakdown?' + scopeQuery({ dim: 'weapon' })),
      api('/api/players/' + focus.steamid + '/breakdown?' + scopeQuery({ dim: 'economy' })),
      api('/api/players/' + focus.steamid + '/insights?' + scopeQuery()),
      api('/api/players/' + focus.steamid + '/highlights?limit=12&' + scopeQuery()),
    ]);
    if (token !== home.token) return;
    home.data = { summ, shown, focus, timelines, maps, weapons: weapons.rows, econ: econ.rows, insights, hls };
    $('#ag-progress').textContent = '';
    showHomeCards(true);
    renderHomeData();
  } catch (e) {
    if (token === home.token) { $('#ag-progress').textContent = '加载失败：' + e.message; showHomeCards(false); }
  }
}
function showHomeCards(on) {
  ['ag-kpis', 'ag-summary-card', 'ag-map-card', 'ag-trend-card', 'ag-radar-card', 'ag-side-card', 'ag-weapon-card',
    'ag-econ-card', 'ag-insight-card', 'ag-report-card', 'ag-hl-card'].forEach((id) => $('#' + id).classList.toggle('hidden', !on));
}
function renderHomeData() {
  if (!home.data) return;
  renderAgKpis(); renderAgTrend(); renderAgRadar(); renderAgSides(); renderAgMaps(); renderAgWeapons();
  renderAgEcon(); renderFindings(); renderHomeHighlights(); renderAgTable(); renderReport();
}
onRedraw(() => { if (state.sec === 'home') renderHomeData(); });

function renderHomeLibrary() {
  const box = $('#home-matches');
  box.innerHTML = '';
  state.matches.slice(0, 4).forEach((m) => {
    const div = document.createElement('div');
    div.className = 'match';
    div.innerHTML = matchCardHtml(m, false);
    div.addEventListener('click', () => openMatch(m.id).then(() => go('analysis', 'match')));
    box.appendChild(div);
  });
  $('#home-no-matches').classList.toggle('hidden', state.matches.length > 0);
  $('#home-lib-count').textContent = state.matches.length;
  const running = [...state.tasks.values()].filter((t) => t.status === 'queued' || t.status === 'running').length;
  $('#home-meta').innerHTML = [
    ['比赛', state.matches.length],
    ['总回合', state.matches.reduce((s, m) => s + (m.round_count || 0), 0)],
    ['总时长', Math.round(state.matches.reduce((s, m) => s + (m.playback_time || 0), 0) / 3600) + ' 小时'],
  ].map(([k, v]) => '<span class="pill">' + k + ' ' + v + '</span>').join('') +
    (running ? '<span class="pill">解析中 ' + running + '</span>' : '') +
    (state.primaryId ? '<span class="pill">视角 ' + escapeHtml(identityName(state.primaryId)) + '</span>' : '');
  const maps = [...new Set(state.matches.map((m) => m.map_name).filter(Boolean))].sort();
  const sel = $('#ag-map');
  sel.innerHTML = '<option value="">全部地图</option>' + maps.map((x) => '<option value="' + escapeAttr(x) + '">' + escapeHtml(x) + '</option>').join('');
  sel.value = maps.includes(state.agMap) ? state.agMap : (state.agMap = '');
  const ov = state.overview;
  const banner = $('#home-banner');
  const notes = [];
  if (ov && ov.stale_derive) notes.push('有 ' + ov.stale_derive + ' 场比赛的派生数据正在后台重算，统计暂时不完整。');
  if (ov && ov.duplicates && ov.duplicates.length) notes.push('库里有 ' + ov.duplicates.length + ' 组重复导入的比赛，会让汇总数字重复计算，可以在 Demo 库里筛选「重复导入」处理。');
  banner.innerHTML = notes.map(escapeHtml).join('<br>');
  banner.classList.toggle('hidden', !notes.length);
}

function renderAgChips() {
  const box = $('#ag-chips');
  const ids = getIdentities();
  box.innerHTML = ids.map((x) => {
    const on = state.agSelected.has(x.steamid);
    const acc = home.data && home.data.summ.accounts.find((a) => a.steamid === x.steamid);
    const info = acc && on ? acc.games + ' 场 <span class="win">' + acc.w + '-' + acc.l + (acc.t ? '-' + acc.t : '') + '</span>'
      : ((rosterCache.get(x.steamid) || {}).count || 0) + ' 场';
    return '<span class="chip' + (on ? ' on' : '') + '" data-sid="' + escapeAttr(x.steamid) + '">' +
      '<span class="cn">' + escapeHtml(identityName(x.steamid)) + '</span><span class="cs">' + info + '</span>' +
      '<button class="x" title="从清单移除" data-rm="' + escapeAttr(x.steamid) + '">×</button></span>';
  }).join('');
}
$('#ag-chips').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { removeIdentity(rm.dataset.rm); return; }
  const chip = e.target.closest('[data-sid]');
  if (!chip) return;
  if (state.agSelected.has(chip.dataset.sid)) state.agSelected.delete(chip.dataset.sid);
  else state.agSelected.add(chip.dataset.sid);
  loadHome();
});
(function initAgControls() {
  const sel = $('#ag-metric');
  sel.innerHTML = AG_METRICS.map((m) => '<option value="' + m[0] + '">' + m[1] + '</option>').join('');
  sel.value = state.agMetric;
  sel.addEventListener('change', (e) => { state.agMetric = e.target.value; renderAgTrend(); });
  $('#ag-range').addEventListener('change', (e) => { state.agRange = e.target.value; loadHome(); });
  $('#ag-map').addEventListener('change', (e) => { state.agMap = e.target.value; loadHome(); });
  $$('[data-mapview]').forEach((b) => b.addEventListener('click', () => {
    state.agMapView = b.dataset.mapview;
    $$('[data-mapview]').forEach((x) => x.classList.toggle('ghost', x !== b));
    loadHome();
  }));
})();

function renderAgKpis() {
  const { summ, shown } = home.data;
  const s = shown.length === 1 ? shown[0] : summ.combined;
  const prev = shown.length === 1 ? shown[0].prev : null;
  const openAtt = s.opening_kills + s.opening_deaths;
  const kpis = [
    ['场次', s.games, (shown.length > 1 ? shown.length + ' 个账号合计 · ' : '') + s.rounds + ' 回合'],
    ['胜率', fmtRate(s.win_rate), s.w + ' 胜 ' + s.l + ' 负' + (s.t ? ' ' + s.t + ' 平' : '') + ' ' + (prev ? delta(s.win_rate * 100, prev.win_rate * 100, 0) : '')],
    ['Rating≈', fmt(s.rating), '按回合加权 ' + (prev ? delta(s.rating, prev.rating) : '')],
    ['ADR', fmt(s.adr, 1), '每回合伤害 ' + (prev ? delta(s.adr, prev.adr, 1) : '')],
    ['KAST', fmtPct(s.kast, 1), '有贡献的回合占比 ' + (prev ? delta(s.kast, prev.kast, 1) : '')],
    ['KD', fmt(s.kd), s.kills + ' 杀 / ' + s.deaths + ' 死'],
    ['爆头率', fmtPct(s.headshot_pct, 1), s.headshot_kills + ' 次爆头击杀'],
    ['首杀成功率', openAtt ? fmtPct(100 * s.opening_kills / openAtt) : '-', s.opening_kills + ' 胜 / ' + s.opening_deaths + ' 负'],
  ];
  $('#ag-kpis').innerHTML = kpis.map(([k, v, sub]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v +
    '</div><div class="s">' + sub + '</div></div>').join('') +
    (s.sample === 'low' ? '<div class="kpi low"><div class="k">提示</div><div class="v">样本少</div><div class="s">不到 3 场，数字只供参考</div></div>' : '');
}

function renderAgTrend() {
  const c = chart('chart-ag-trend');
  if (!c || !home.data) return;
  const key = state.agMetric || 'rating';
  const { shown, timelines } = home.data;
  const label = (AG_METRICS.find((x) => x[0] === key) || ['', key])[1];
  const n = timelines.reduce((a, t) => a + t.length, 0);
  $('#ag-trend-note').textContent = label + ' · 共 ' + n + ' 个数据点 · 横轴为比赛时间';
  c.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (p) => escapeHtml(p.seriesName) + '<br>' + fmtDate(p.value[0] / 1000, true) + ' · ' +
        escapeHtml(p.data.map) + ' ' + escapeHtml(p.data.score) + '<br>' + label + '：' + fmt(p.value[1]),
    },
    legend: Object.assign({ data: shown.map((a) => identityName(a.steamid)) }, legendStyle(true)),
    grid: { left: 46, right: 24, top: 30, bottom: 56 },
    xAxis: Object.assign({ type: 'time' }, axisStyle({ axisLabel: { formatter: (v) => shortDate(v / 1000) } })),
    yAxis: Object.assign({ type: 'value', scale: true }, axisStyle()),
    series: shown.map((a, i) => ({
      name: identityName(a.steamid), type: 'line', symbolSize: 7,   // 不做平滑：点少时曲线会冲出真实数据范围
      itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] },
      data: timelines[i].map((t) => ({ value: [t.played_at * 1000, t[key] == null ? null : Number(t[key])], map: mapLabel(t.map_name),
        score: t.team_score + ':' + t.opp_score + ' ' + (t.result === 'W' ? '胜' : t.result === 'L' ? '负' : '平'), id: t.match_id })),
    })),
  }, true);
  c.off('click');
  c.on('click', (p) => { if (p.data && p.data.id) openMatch(p.data.id).then(() => go('analysis', 'match')); });
}

function radarValues(a) {
  const att = a.opening_kills + a.opening_deaths;
  return { rating: a.rating, adr: a.adr, kast: a.kast, headshot_pct: a.headshot_pct, kd: a.kd, open_pct: att ? 100 * a.opening_kills / att : 0 };
}
function renderAgRadar() {
  const c = chart('chart-ag-radar');
  if (!c || !home.data) return;
  const vals = home.data.shown.map(radarValues);
  /* 只有一个账号时「按账号间最大值」会让每条轴都是满格，没有信息量，改用固定上限 */
  const fixed = settings.radar === 'fixed' || vals.length < 2;
  const cap = (k, fixedCap) => fixed ? fixedCap : Math.max(0.0001, ...vals.map((v) => Number(v[k]) || 0));
  $('#ag-radar-note').textContent = fixed ? '按固定上限归一（Rating 1.6 · ADR 120 · KD 2 为满格）' : '按账号间最大值归一';
  c.setOption({
    tooltip: {},
    legend: Object.assign({ data: home.data.shown.map((a) => identityName(a.steamid)) }, legendStyle(true)),
    radar: radarStyle({ indicator: AG_RADAR.map((d) => ({ name: d[1], max: 1 })), radius: '60%', center: ['50%', '46%'] }),
    series: [{
      type: 'radar',
      data: home.data.shown.map((a, i) => ({
        name: identityName(a.steamid),
        value: AG_RADAR.map((d) => Math.min(1, (Number(vals[i][d[0]]) || 0) / cap(d[0], d[2])).toFixed(3)),
        itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] }, areaStyle: { opacity: 0.12 },
      })),
    }],
  }, true);
}

const SIDE_COLS = [['name', '账号', 's'], ['side', '阵营', 's', (v) => sidePill(v)], ['rounds', '回合', 'n'],
  ['rating', 'Rating≈', 'n', (v) => fmt(v)], ['adr', 'ADR', 'n', (v) => fmt(v, 1)], ['kast', 'KAST', 'n', (v) => fmtPct(v, 1)],
  ['kd', 'KD', 'n', (v) => fmt(v)], ['round_win_pct', '回合胜率', 'n', (v) => fmtPct(v, 1)],
  ['opening_success', '首杀成功率', 'n', (v) => fmtPct(v)], ['headshot_pct', '爆头率', 'n', (v) => fmtPct(v, 1)],
  ['clutches_won', '残局胜', 'n', (v, r) => v + '/' + r.clutches]];
let sideSort = { key: 'name', asc: true };
function renderAgSides() {
  const rows = [];
  home.data.shown.forEach((a) => ['counter-terrorist', 'terrorist'].forEach((s) => {
    const r = a.sides[s];
    if (r) rows.push({ ...r, name: identityName(a.steamid) });
  }));
  sortableTable($('#tbl-ag-side'), rows, SIDE_COLS.map((c, i) => i === 0 ? [c[0], c[1], c[2], (v, r) => escapeHtml(v) + lowBadge(r)] : c),
    sideSort, renderAgSides);
}

let mapSort = { key: 'games', asc: false };
function renderAgMaps() {
  const view = state.agMapView;
  const rows = [];
  home.data.shown.forEach((a, i) => (home.data.maps[i].rows || []).forEach((r) => rows.push({ ...r, name: identityName(a.steamid) })));
  const cols = view === 'map_side'
    ? [['name', '账号', 's'], ['map_name', '地图', 's', (v, r) => escapeHtml(v) + lowBadge(r)], ['side', '阵营', 's', (v) => sidePill(v)],
      ['rounds', '回合', 'n'], ['rating', 'Rating≈', 'n', (v) => fmt(v)], ['adr', 'ADR', 'n', (v) => fmt(v, 1)],
      ['kast', 'KAST', 'n', (v) => fmtPct(v, 1)], ['round_win_pct', '回合胜率', 'n', (v) => fmtPct(v, 1)], ['kd', 'KD', 'n', (v) => fmt(v)]]
    : [['name', '账号', 's'], ['map_name', '地图', 's', (v, r) => escapeHtml(v) + lowBadge(r)], ['games', '场次', 'n'],
      ['w', '胜', 'n'], ['l', '负', 'n'], ['win_rate', '胜率', 'n', (v) => fmtRate(v)], ['rating', 'Rating≈', 'n', (v) => fmt(v)],
      ['adr', 'ADR', 'n', (v) => fmt(v, 1)], ['kast', 'KAST', 'n', (v) => fmtPct(v, 1)], ['kd', 'KD', 'n', (v) => fmt(v)]];
  if (!cols.some((c) => c[0] === mapSort.key)) mapSort = { key: view === 'map_side' ? 'rounds' : 'games', asc: false };
  sortableTable($('#tbl-ag-map'), rows, cols, mapSort, renderAgMaps);
}

let weaponSort = { key: 'kills', asc: false };
function renderAgWeapons() {
  $('#ag-weapon-note').textContent = identityName(home.data.focus.steamid) + ' · 命中 = 造成伤害的子弹数 / 开火数';
  sortableTable($('#tbl-ag-weapon'), home.data.weapons.slice(0, 30), [
    ['weapon', '武器', 's', (v, r) => escapeHtml(v) + lowBadge(r)], ['kills', '击杀', 'n'], ['headshot_pct', '爆头率', 'n', (v) => fmtPct(v)],
    ['shots', '开火', 'n'], ['accuracy', '命中率', 'n', (v) => fmtPct(v, 1)], ['shots_per_kill', '发/杀', 'n', (v) => fmt(v, 1)],
    ['damage', '伤害', 'n'], ['games', '场次', 'n'],
  ], weaponSort, renderAgWeapons);
}
const BUY_LABEL = { pistol: '手枪局', eco: '经济局', force: '强起', full: '长枪局' };
function renderAgEcon() {
  sortableTable($('#tbl-ag-econ'), home.data.econ, [
    ['buy_type', '买法', 's', (v, r) => escapeHtml(BUY_LABEL[v] || v || '未知') + lowBadge(r)], ['rounds', '回合', 'n'],
    ['round_win_pct', '回合胜率', 'n', (v) => fmtPct(v, 1)], ['adr', 'ADR', 'n', (v) => fmt(v, 1)],
    ['kast', 'KAST', 'n', (v) => fmtPct(v, 1)], ['kd', 'KD', 'n', (v) => fmt(v)],
  ], { key: 'buy_type', asc: true }, renderAgEcon);
}

const SEV_LABEL = { bad: '问题', warn: '注意', good: '亮点', info: '信息' };
function renderFindings() {
  const ins = home.data.insights;
  $('#ag-insight-note').textContent = identityName(home.data.focus.steamid) + ' · ' + ins.scope.games + ' 场 · 规则引擎 v' + ins.engine_version;
  $('#ag-findings').innerHTML = ins.findings.length
    ? ins.findings.map((f) => '<div class="finding ' + f.severity + '"><span class="sev">' + SEV_LABEL[f.severity] + '</span>' +
        '<div><div class="ft">' + escapeHtml(f.title) + '</div><div class="fd">' + escapeHtml(f.detail) + '</div></div></div>').join('')
    : '<div class="dim">统计范围内没有明显的强项或问题。</div>';
}

function hlItemHtml(h, withMatch) {
  const ev = h.evidence || {};
  const tags = [];
  if (ev.headshots) tags.push(ev.headshots + ' 爆头');
  if (ev.weapons && ev.weapons.length) tags.push(ev.weapons.slice(0, 3).join('/'));
  if (ev.span_seconds != null && ev.kills >= 2) tags.push(ev.span_seconds + ' 秒内');
  return '<button class="hl" data-hlmatch="' + escapeAttr(h.match_id) + '" data-hlround="' + h.round_num + '" data-hltick="' + h.tick_start + '">' +
    '<span class="hl-score">' + Math.round(h.score * 100) + '</span>' +
    '<span class="hl-body"><span class="hl-title">' + escapeHtml(h.title) + ' · ' + escapeHtml(h.name || '') + '</span>' +
    '<span class="hl-sub">第 ' + h.round_num + ' 回合' + (withMatch ? ' · ' + escapeHtml(mapLabel(h.map_name)) + ' · ' + fmtDate(h.played_at) : '') +
    (tags.length ? ' · ' + escapeHtml(tags.join(' · ')) : '') + '</span></span></button>';
}
function renderHomeHighlights() {
  const list = home.data.hls;
  $('#ag-hl').innerHTML = list.length ? list.map((h) => hlItemHtml(h, true)).join('')
    : '<div class="dim">统计范围内还没有识别到高光（多杀、残局或特殊击杀）。</div>';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-hlmatch]');
  if (!b) return;
  jumpToHighlight(b.dataset.hlmatch, Number(b.dataset.hlround), Number(b.dataset.hltick));
});

const AG_COLS = [
  ['name', '账号', 's', (v, r) => escapeHtml(v) + lowBadge(r)], ['games', '场次', 'n'], ['rounds', '回合', 'n'], ['w', '胜', 'n'], ['l', '负', 'n'],
  ['win_rate', '胜率', 'n', (v) => fmtRate(v)], ['rating', 'Rating≈', 'n', (v) => fmt(v)], ['kills', 'K', 'n'], ['deaths', 'D', 'n'],
  ['assists', 'A', 'n'], ['kd', 'KD', 'n', (v) => fmt(v)], ['adr', 'ADR', 'n', (v) => fmt(v, 1)], ['kast', 'KAST', 'n', (v) => fmtPct(v, 1)],
  ['headshot_pct', '爆头', 'n', (v) => fmtPct(v, 1)], ['opening_kills', '首杀', 'n'], ['opening_deaths', '首死', 'n'],
  ['clutches_won', '残局胜', 'n'], ['mk_4k', '4K', 'n'], ['mk_5k', 'ACE', 'n'], ['utility_damage', '道具伤害', 'n'],
];
let agSort = { key: 'rating', asc: false };
function renderAgTable() {
  const rows = home.data.shown.map((a) => ({ ...a, name: identityName(a.steamid) }));
  sortableTable($('#tbl-ag'), rows, AG_COLS, agSort, renderAgTable);
}

/* ---------------------------------------------------------------- AI 复盘 */
function renderReport() {
  const r = home.report;
  const box = $('#report-text');
  const focus = home.data && home.data.focus;
  $('#ag-report-note').textContent = focus ? identityName(focus.steamid) : '';
  if (!r || !focus || r.steamid !== focus.steamid) { box.textContent = ''; $('#report-status').textContent = ''; return; }
  if (r.error) {
    $('#report-status').textContent = '模型调用失败：' + r.error + '（下面是离线模板生成的版本）';
    box.textContent = r.fallback || '';
  } else if (r.provider === 'manual') {
    $('#report-status').textContent = '手动模式：提示词已复制，粘贴到任意聊天工具即可。';
    box.textContent = r.prompt;
  } else {
    $('#report-status').textContent = (r.provider === 'none' ? '离线模板' : (r.model || r.provider)) + ' · ' + fmtDate(Date.now() / 1000, true);
    box.textContent = r.narrative || '';
  }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
async function generateReport(providerOverride) {
  if (!home.data) return;
  const steamid = home.data.focus.steamid;
  $('#btn-report').disabled = true;
  $('#report-status').textContent = '生成中…（调用模型可能需要几十秒）';
  try {
    const body = { last: Number(state.agRange) || 0 };
    if (providerOverride) body.provider = providerOverride;
    const r = await api('/api/players/' + steamid + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    home.report = { ...r, steamid };
    if (r.provider === 'manual' || providerOverride === 'manual') await copyText(r.system_prompt + '\n\n' + r.prompt);
    renderReport();
  } catch (e) { $('#report-status').textContent = '生成失败：' + e.message; }
  finally { $('#btn-report').disabled = false; }
}
$('#btn-report').addEventListener('click', () => generateReport());
$('#btn-report-prompt').addEventListener('click', () => generateReport('manual'));

pageEnter.home = () => loadHome();
