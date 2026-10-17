/* 单场分析：概览（队伍比分、回合条、经济、比分走势、高光、回合明细）与玩家记分板。 */
'use strict';

function clearCurrentMatch() {
  if (typeof stopPlayback === 'function') stopPlayback();
  Object.assign(state, { matchId: null, match: null, players: [], rounds: [], roundRows: [], economy: [], highlights: [],
    replay: null, kills: null, mapInfo: null });
  syncNav();
}

async function openMatch(id) {
  const switching = state.matchId !== id;
  if (switching) {
    // 换比赛：回放轨迹、击杀记录与地图筛选必须重置，否则会拿上一场的数据画
    if (typeof stopPlayback === 'function') stopPlayback();
    Object.assign(state, { replay: null, replayFrame: 0, mapInfo: null, kills: null,
      heatFilter: { round_num: '', side: '', weapon: '', steamid: '' } });
    $('#f-side').value = '';
  }
  const [m, r, p, hl] = await Promise.all([
    api('/api/matches/' + id), api('/api/matches/' + id + '/rounds'),
    api('/api/matches/' + id + '/players').catch(() => []), api('/api/matches/' + id + '/highlights').catch(() => []),
  ]);
  state.matchId = id;
  state.match = m;
  state.rounds = r.rounds || [];
  state.roundRows = r.timeline || [];
  state.teams = r.teams || {};
  state.economy = r.economy || [];
  state.players = p || [];
  state.highlights = hl || [];
  renderLibrary();
  renderMatchHeader();
  renderEconomy();
  renderScoreFlow();
  renderMatchHighlights();
  renderRoundsTable();
  renderPlayers();
  await prepareHeatFilters();
  prepareReplayRounds();
  syncNav();
  writeHash();
}

function teamLabel(team) {
  const t = (state.teams || {})[team] || {};
  if (t.name) return t.name;
  const start = team === 'A' ? state.match.team_a_start_side : (state.match.team_a_start_side === 'counter-terrorist' ? 'terrorist' : 'counter-terrorist');
  return '队伍 ' + team + (start ? '（' + SIDE_LABEL[start] + ' 开局）' : '');
}
function renderMatchHeader() {
  const m = state.match;
  $('#match-title').textContent = (m.map_name || '?') + ' · ' + fmtDate(m.played_at || m.created_at, true) + ' · ' + m.file_name;
  const a = m.team_a_score, b = m.team_b_score;
  $('#match-score').innerHTML = a == null
    ? '<span class="dim">派生数据还在后台计算中，稍后刷新即可看到队伍比分。</span>'
    : '<div class="team ' + (a > b ? 'win' : '') + '"><span class="tn">' + escapeHtml(teamLabel('A')) + '</span><span class="ts">' + a + '</span></div>' +
      '<div class="vs">:</div>' +
      '<div class="team right ' + (b > a ? 'win' : '') + '"><span class="ts">' + b + '</span><span class="tn">' + escapeHtml(teamLabel('B')) + '</span></div>';
  $('#match-meta').innerHTML =
    '<span class="pill">' + m.round_count + ' 回合</span>' +
    '<span class="pill" title="按阵营统计的回合胜场（与队伍比分不同：半场换边后同一支队伍会在两个阵营下得分）">CT 方赢 ' + m.ct_score + ' · T 方赢 ' + m.t_score + '</span>' +
    '<span class="pill">' + (m.tick_rate || '?') + ' tick</span>' +
    (m.playback_time ? '<span class="pill">' + Math.round(m.playback_time / 60) + ' 分钟</span>' : '') +
    '<span class="pill" title="demo 本体状态">' + (m.demo_present ? 'demo 在本机' + (m.keep_demo ? ' · 保留回放' : '') : 'demo 已回收') + '</span>' +
    (m.awpy_version ? '<span class="pill" title="解析器版本">awpy ' + escapeHtml(m.awpy_version) + ' · 解析口径 v' + (m.parser_version || '?') + '</span>' : '') +
    (m.server_name ? '<span class="dim fs12">' + escapeHtml(m.server_name) + '</span>' : '');
  const strip = $('#round-strip');
  strip.innerHTML = state.roundRows.map((r) => {
    const aWon = r.winner_side && r.winner_side === r.team_a_side;
    return '<span class="rs ' + (r.winner_side ? (aWon ? 'a' : 'b') : '') + ' ' + (r.winner_side === 'counter-terrorist' ? 'ct' : 't') + '" title="第 ' +
      r.round_num + ' 回合 · ' + (aWon ? teamLabel('A') : teamLabel('B')) + ' 以 ' + (SIDE_LABEL[r.winner_side] || '?') + ' 方获胜 · ' +
      escapeAttr(r.reason_name || '') + ' · 比分 ' + r.score_a + ':' + r.score_b + '">' + r.round_num + '</span>';
  }).join('');
  const runs = (m.runs || []);
  const warn = [];
  (m.warnings || []).forEach((w) => warn.push(w));
  runs.filter((x) => x.kind !== 'derive').slice(0, 1).forEach((x) => {
    Object.entries(x.dataset_errors || {}).forEach(([k, v]) => warn.push('数据集 ' + k + ' 解析失败：' + v));
    (Array.isArray(x.warnings) ? x.warnings : []).forEach((w) => warn.push(w));
  });
  $('#match-warn').innerHTML = warn.map(escapeHtml).join('<br>');
  $('#match-warn').classList.toggle('hidden', !warn.length);
}

function renderEconomy() {
  const c = chart('chart-economy');
  if (!c || !state.match) return;
  const p = P();
  const byRound = {};
  state.economy.forEach((e) => { (byRound[e.round_num] = byRound[e.round_num] || {})[e.side] = e; });
  const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
  const val = (side) => rounds.map((n) => (byRound[n][side] || {}).equipment_value ?? null);
  const buy = (n, side) => (byRound[n][side] || {}).buy_type || '-';
  c.setOption({
    tooltip: {
      trigger: 'axis',
      formatter: (ps) => {
        const n = rounds[ps[0].dataIndex];
        return '第 ' + n + ' 回合<br>' + ps.map((x) => x.marker + x.seriesName + '：$' + (x.value == null ? '-' : x.value)).join('<br>') +
          '<br><span style="opacity:.7">CT ' + buy(n, 'counter-terrorist') + ' · T ' + buy(n, 'terrorist') + '</span>';
      },
    },
    legend: Object.assign({ data: ['CT 装备价值', 'T 装备价值'] }, legendStyle()),
    grid: { left: 60, right: 20, top: 40, bottom: 34 },
    xAxis: Object.assign({ type: 'category', data: rounds.map((n) => 'R' + n) }, axisStyle()),
    yAxis: Object.assign({ type: 'value', name: '装备价值 $', nameTextStyle: { color: p.dim } }, axisStyle()),
    series: [
      { name: 'CT 装备价值', type: 'line', data: val('counter-terrorist'), itemStyle: { color: p.ct }, areaStyle: { opacity: .12 } },
      { name: 'T 装备价值', type: 'line', data: val('terrorist'), itemStyle: { color: p.t }, areaStyle: { opacity: .12 } },
    ],
  }, true);
}

/* 比分走势：两条阶梯线（队伍 A / B 的累计得分），点的颜色表示该回合胜方所在阵营 */
function renderScoreFlow() {
  const c = chart('chart-rounds');
  if (!c || !state.match) return;
  const p = P();
  const rows = state.roundRows;
  const half = rows.findIndex((r, i) => i > 0 && r.team_a_side !== rows[i - 1].team_a_side);
  c.setOption({
    tooltip: {
      trigger: 'axis',
      formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        return '第 ' + r.round_num + ' 回合 · ' + (SIDE_LABEL[r.winner_side] || '?') + ' 方胜（' + escapeHtml(r.reason_name || '') + '）<br>' +
          ps.map((x) => x.marker + escapeHtml(x.seriesName) + '：' + x.value).join('<br>');
      },
    },
    legend: Object.assign({ data: [teamLabel('A'), teamLabel('B')] }, legendStyle()),
    grid: { left: 40, right: 20, top: 40, bottom: 34 },
    xAxis: Object.assign({ type: 'category', data: rows.map((r) => 'R' + r.round_num) }, axisStyle()),
    yAxis: Object.assign({ type: 'value', minInterval: 1 }, axisStyle()),
    series: [
      { name: teamLabel('A'), type: 'line', step: 'end', data: rows.map((r) => r.score_a), itemStyle: { color: CMP_COLORS[0] }, symbolSize: 6,
        markLine: half > 0 ? { silent: true, symbol: 'none', lineStyle: { color: p.dim, type: 'dashed' },
          label: { formatter: '换边', color: p.dim }, data: [{ xAxis: half }] } : undefined },
      { name: teamLabel('B'), type: 'line', step: 'end', data: rows.map((r) => r.score_b), itemStyle: { color: CMP_COLORS[1] }, symbolSize: 6 },
    ],
  }, true);
}

function renderMatchHighlights() {
  const list = state.highlights.map((h) => ({ ...h, match_id: state.matchId }));
  $('#match-hl').innerHTML = list.slice(0, 12).map((h) => hlItemHtml(h, false)).join('');
  $('#match-hl-empty').classList.toggle('hidden', list.length > 0);
}

function renderRoundsTable() {
  const BUY = { pistol: '手枪', eco: '经济', force: '强起', full: '长枪' };
  let html = '<thead><tr><th class="l">回合</th><th class="l">胜方</th><th class="l">结束原因</th><th>比分</th>' +
    '<th>CT 装备</th><th>T 装备</th><th class="l">买法 CT / T</th><th class="l">操作</th></tr></thead><tbody>';
  state.roundRows.forEach((r) => {
    const aWon = r.winner_side === r.team_a_side;
    html += '<tr><td class="l">' + r.round_num + '</td>' +
      '<td class="l">' + sidePill(r.winner_side) + ' <span class="dim">' + escapeHtml(aWon ? teamLabel('A') : teamLabel('B')) + '</span></td>' +
      '<td class="l">' + escapeHtml(r.reason_name || '-') + '</td>' +
      '<td>' + r.score_a + ' : ' + r.score_b + '</td>' +
      '<td>' + (r.ct_equipment == null ? '-' : '$' + r.ct_equipment) + '</td>' +
      '<td>' + (r.t_equipment == null ? '-' : '$' + r.t_equipment) + '</td>' +
      '<td class="l">' + (BUY[r.ct_buy] || r.ct_buy || '-') + ' / ' + (BUY[r.t_buy] || r.t_buy || '-') + '</td>' +
      '<td class="l"><button class="btn ghost sm" data-goround="' + r.round_num + '">回放</button></td></tr>';
  });
  $('#tbl-rounds').innerHTML = html + '</tbody>';
}
$('#tbl-rounds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-goround]');
  if (b) jumpToHighlight(state.matchId, Number(b.dataset.goround), null);
});
onRedraw(() => { if (state.matchId) { renderEconomy(); renderScoreFlow(); renderPlayers(); } });

/* ================================================================ 玩家页 */
const PLAYER_COLS = [
  ['team', '队', 's', (v) => '<span class="team-dot ' + (v === 'A' ? 'a' : 'b') + '">' + escapeHtml(v || '-') + '</span>'],
  ['name', '玩家', 's', (v, r) => escapeHtml(v) + (identityMatch(r.steamid) ? ' <span class="pill">我</span>' : '')],
  ['rating', 'Rating≈', 'n', (v) => fmt(v)], ['kills', 'K', 'n'], ['deaths', 'D', 'n'], ['assists', 'A', 'n'],
  ['adr', 'ADR', 'n', (v) => fmt(v, 1)], ['kast', 'KAST', 'n', (v) => fmtPct(v, 1)], ['headshot_pct', '爆头', 'n', (v) => fmtPct(v)],
  ['ct_rating', 'CT Rt', 'n', (v) => fmt(v)], ['t_rating', 'T Rt', 'n', (v) => fmt(v)],
  ['ct_adr', 'CT ADR', 'n', (v) => fmt(v, 0)], ['t_adr', 'T ADR', 'n', (v) => fmt(v, 0)],
  ['opening_kills', '首杀', 'n'], ['opening_deaths', '首死', 'n'], ['clutches_won', '残局胜', 'n'],
  ['mk_3k', '3K', 'n'], ['mk_4k', '4K', 'n'], ['mk_5k', '5K', 'n'], ['utility_damage', '道具伤害', 'n'],
];
let playerSort = { key: 'rating', asc: false };
function identityMatch(sid) { return getIdentities().some((x) => x.steamid === sid); }
function playerRows() {
  return state.players.map((p) => ({
    ...p,
    ct_rating: (p.split.ct || {}).rating, t_rating: (p.split.t || {}).rating,
    ct_adr: (p.split.ct || {}).adr, t_adr: (p.split.t || {}).adr,
  }));
}
function renderPlayers() {
  if (!state.players.length) { $('#tbl-players').innerHTML = '<tbody><tr><td class="l dim">这场的派生数据还没准备好。</td></tr></tbody>'; return; }
  sortableTable($('#tbl-players'), playerRows(), PLAYER_COLS, playerSort, renderPlayers,
    (r) => 'data-sid="' + escapeAttr(r.steamid) + '" class="' + (identityMatch(r.steamid) ? 'me' : '') + '"');
  $('#tbl-players').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    const p = state.players.find((x) => x.steamid === tr.dataset.sid);
    if (p) renderRadar(p);
  }));
  const me = state.players.find((x) => x.steamid === state.primaryId) || state.players.find((x) => identityMatch(x.steamid));
  renderRadar(me || state.players[0]);
  renderAdrChart();
}

const RADAR_CAPS = { kills: 35, adr: 120, kast: 100, headshot_pct: 60, opening_kills: 10, utility_damage: 250 };
const RADAR_DIMS = [['kills', '击杀'], ['adr', 'ADR'], ['kast', 'KAST'], ['headshot_pct', '爆头率'],
  ['opening_kills', '首杀'], ['utility_damage', '道具伤害']];
function radarNorm(list) {
  return (k) => settings.radar === 'fixed' ? RADAR_CAPS[k] : Math.max(1, ...list.map((p) => Number(p[k]) || 0));
}
function renderRadar(player) {
  const c = chart('chart-radar');
  if (!c || !player) return;
  const p = P();
  $('#radar-title').textContent = '雷达图 · ' + (player.name == null ? '(未知)' : player.name);
  const maxOf = radarNorm(state.players);
  const mine = RADAR_DIMS.map((d) => Math.min(1, (Number(player[d[0]]) || 0) / maxOf(d[0])));
  const best = RADAR_DIMS.map((d) => Math.min(1, Math.max(...state.players.map((x) => (Number(x[d[0]]) || 0) / maxOf(d[0])))));
  c.setOption({
    tooltip: {},
    legend: Object.assign({ data: [player.name, '全场最高'] }, legendStyle(true)),
    radar: radarStyle({ indicator: RADAR_DIMS.map((d) => ({ name: d[1], max: 1 })), radius: '62%', center: ['50%', '48%'] }),
    series: [{
      type: 'radar',
      data: [
        { value: mine.map((v) => v.toFixed(3)), name: player.name, itemStyle: { color: p.accent }, areaStyle: { color: rgbaVar('--accent', .28) } },
        { value: best.map((v) => v.toFixed(3)), name: '全场最高', lineStyle: { type: 'dashed' }, itemStyle: { color: p.ct }, areaStyle: { opacity: 0 } },
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
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: Object.assign({ data: ['ADR', 'KAST'] }, legendStyle()),
    grid: { left: 50, right: 55, top: 40, bottom: 70 },
    xAxis: axisStyle({ type: 'category', data: rows.map((x) => x.name), axisLabel: { rotate: 32, interval: 0, hideOverlap: false } }),
    yAxis: [
      Object.assign({ type: 'value', name: 'ADR', nameTextStyle: { color: p.dim } }, axisStyle()),
      Object.assign({ type: 'value', name: 'KAST%', max: 100, nameTextStyle: { color: p.dim } }, axisStyle({ splitLine: { show: false } })),
    ],
    series: [
      { name: 'ADR', type: 'bar', data: rows.map((x) => ({ value: x.adr, itemStyle: { color: x.team === 'A' ? CMP_COLORS[0] : CMP_COLORS[1] } })) },
      { name: 'KAST', type: 'line', yAxisIndex: 1, smooth: true, data: rows.map((x) => x.kast), itemStyle: { color: p.accent }, symbolSize: 7 },
    ],
  }, true);
}

pageEnter.match = () => { if (state.matchId) { renderEconomy(); renderScoreFlow(); } };
pageEnter.players = () => { if (state.matchId) renderPlayers(); };
