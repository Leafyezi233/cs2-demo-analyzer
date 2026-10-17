/* 多场对比：按 steamid 跨场对齐玩家（旧版按名字对齐，改名就对不上）。 */
'use strict';

async function runCompare(ids) {
  if (!ids || ids.length < 2) { toast('至少需要 2 场比赛', true); return; }
  $('#cmp-summary').innerHTML = '<span class="dim">加载中…</span>';
  let data;
  try { data = await api('/api/compare?ids=' + ids.map(encodeURIComponent).join(',')); }
  catch (e) { $('#cmp-summary').innerHTML = ''; toast('对比失败：' + e.message, true); return; }
  state.compare = data.matches || [];
  $('#cmp-result').classList.remove('hidden');
  renderCompareAll();
  writeHash();
  setTimeout(resizeCharts, 60);
}
function renderCompareAll() {
  if (!state.compare.length) return;
  renderCompareSummary(); renderCompareScore(); renderCompareEconomy(); renderCompareTable(); renderCompareRadar();
}
onRedraw(() => { if (state.sec === 'stats') renderCompareAll(); });

function cmpLabel(m, i) { return '#' + (i + 1) + ' ' + mapLabel(m.map_name) + ' ' + shortDate(m.played_at || m.created_at); }

function renderCompareSummary() {
  $('#cmp-summary').innerHTML = state.compare.map((m, i) =>
    '<span class="pill">' + escapeHtml(cmpLabel(m, i)) + ' · ' + (m.team_a_score ?? '?') + ':' + (m.team_b_score ?? '?') + ' · ' + m.round_count + ' 回合</span>').join('') +
    '<span class="dim fs12">共 ' + state.compare.length + ' 场</span>';
}
function renderCompareScore() {
  const c = chart('chart-cmp-score');
  if (!c) return;
  const p = P();
  c.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: Object.assign({ data: ['队伍 A', '队伍 B'] }, legendStyle()),
    grid: { left: 50, right: 20, top: 40, bottom: 40 },
    xAxis: Object.assign({ type: 'category', data: state.compare.map(cmpLabel) }, axisStyle()),
    yAxis: Object.assign({ type: 'value', name: '回合', nameTextStyle: { color: p.dim } }, axisStyle()),
    series: [
      { name: '队伍 A', type: 'bar', data: state.compare.map((m) => m.team_a_score), itemStyle: { color: CMP_COLORS[0] }, label: { show: true, color: p.fg } },
      { name: '队伍 B', type: 'bar', data: state.compare.map((m) => m.team_b_score), itemStyle: { color: CMP_COLORS[1] }, label: { show: true, color: p.fg } },
    ],
  }, true);
}
function renderCompareEconomy() {
  const c = chart('chart-cmp-economy');
  if (!c) return;
  const maxRounds = Math.max(0, ...state.compare.map((m) => m.round_count || 0));
  c.setOption({
    tooltip: { trigger: 'axis', formatter: (ps) => '第 ' + (ps[0].dataIndex + 1) + ' 回合<br>' + ps.map((x) =>
      x.marker + escapeHtml(x.seriesName) + '：' + (x.value == null ? '-' : '$' + x.value)).join('<br>') },
    legend: Object.assign({ data: state.compare.map(cmpLabel) }, legendStyle()),
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: Object.assign({ type: 'category', data: Array.from({ length: maxRounds }, (_, k) => 'R' + (k + 1)) }, axisStyle()),
    yAxis: Object.assign({ type: 'value', name: '双方装备价值 $', nameTextStyle: { color: P().dim } }, axisStyle()),
    series: state.compare.map((m, i) => {
      const byRound = {};
      (m.economy || []).forEach((e) => { byRound[e.round_num] = (byRound[e.round_num] || 0) + (e.equipment_value || 0); });
      return { name: cmpLabel(m, i), type: 'line', smooth: true, symbolSize: 5, itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] },
        data: Array.from({ length: maxRounds }, (_, k) => byRound[k + 1] ?? null) };
    }),
  }, true);
}

let cmpSort = { key: 'count', asc: false };
function renderCompareTable() {
  // 行 = 玩家（steamid），列 = 每场；单元格为 Rating≈ · K/D/A · ADR
  const people = new Map();
  state.compare.forEach((m, idx) => (m.players || []).forEach((p) => {
    const e = people.get(p.steamid) || { steamid: p.steamid, name: p.name, cells: {}, count: 0 };
    e.name = p.name || e.name;
    e.cells[idx] = p;
    e.count++;
    people.set(p.steamid, e);
  }));
  const rows = [...people.values()];
  const val = (r, key) => key === 'name' ? String(r.name) : key === 'count' ? r.count : (r.cells[key] ? Number(r.cells[key].rating) || 0 : -1);
  rows.sort((a, b) => {
    const av = val(a, cmpSort.key), bv = val(b, cmpSort.key);
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return (cmpSort.asc ? c : -c) || String(a.name).localeCompare(String(b.name));
  });
  const arrow = (k) => cmpSort.key === k ? (cmpSort.asc ? ' ▲' : ' ▼') : '';
  let html = '<thead><tr><th class="l" data-k="name">玩家' + arrow('name') + '</th><th data-k="count">出场' + arrow('count') + '</th>' +
    state.compare.map((m, i) => '<th class="l" data-k="' + i + '">' + escapeHtml(cmpLabel(m, i)) + arrow(i) + '</th>').join('') + '</tr></thead><tbody>';
  rows.forEach((r) => {
    html += '<tr' + (identityMatch(r.steamid) ? ' class="me"' : '') + '><td class="l" title="' + escapeAttr(r.steamid) + '">' + escapeHtml(r.name) +
      (identityMatch(r.steamid) ? ' <span class="pill">我</span>' : '') + '</td><td>' + r.count + '</td>' +
      state.compare.map((_m, idx) => {
        const p = r.cells[idx];
        if (!p) return '<td class="l cmp-cell dim">未参赛</td>';
        const rt = Number(p.rating);
        const cls = rt >= 1.1 ? 'win' : (rt < 0.9 ? 'lose' : '');
        return '<td class="l cmp-cell">' + resultPill(p.result) + '<span class="' + cls + '"> ' + fmt(rt) + '</span><br>' +
          '<span class="dim">' + (p.kills || 0) + '/' + (p.deaths || 0) + '/' + (p.assists || 0) + ' · ADR ' + fmt(p.adr, 1) + '</span></td>';
      }).join('') + '</tr>';
  });
  const tbl = $('#tbl-compare');
  tbl.innerHTML = html + '</tbody>';
  tbl.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const raw = th.dataset.k;
    const key = raw === 'name' || raw === 'count' ? raw : Number(raw);
    if (cmpSort.key === key) cmpSort.asc = !cmpSort.asc; else { cmpSort.key = key; cmpSort.asc = false; }
    renderCompareTable();
  }));
}
function renderCompareRadar() {
  const c = chart('chart-cmp-radar');
  if (!c) return;
  const top = state.compare.map((m) => (m.players || [])[0]).filter(Boolean);
  if (!top.length) { c.clear(); return; }
  const maxOf = radarNorm(top);
  c.setOption({
    tooltip: {},
    legend: Object.assign({ data: top.map((x, i) => cmpLabel(state.compare[i], i) + ' · ' + x.name) }, legendStyle(true)),
    radar: radarStyle({ indicator: RADAR_DIMS.map((d) => ({ name: d[1], max: 1 })), radius: '58%', center: ['50%', '46%'] }),
    series: [{
      type: 'radar',
      data: top.map((x, i) => ({
        value: RADAR_DIMS.map((d) => Math.min(1, (Number(x[d[0]]) || 0) / maxOf(d[0])).toFixed(3)),
        name: cmpLabel(state.compare[i], i) + ' · ' + x.name,
        itemStyle: { color: CMP_COLORS[i % CMP_COLORS.length] }, areaStyle: { opacity: 0.12 },
      })),
    }],
  }, true);
}

$('#btn-compare').addEventListener('click', () => runCompare([...state.selected]));
$('#btn-clear-sel').addEventListener('click', () => { state.selected.clear(); renderStatsPicker(); syncCompareBar(); renderLibrary(); });
