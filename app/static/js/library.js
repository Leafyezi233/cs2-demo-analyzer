/* Demo 库：全部比赛的检索、筛选、生命周期（保留回放 / 回收 demo 本体 / 重解析 / 删除）与批量对比入口。 */
'use strict';

async function loadMatches() {
  const list = await api('/api/matches');
  state.matches = list;
  state.selected = new Set([...state.selected].filter((id) => list.some((m) => m.id === id)));
  $('#sf-matches').textContent = list.length;
  renderLibrary();
  renderStatsPicker();
  syncCompareBar();
  return list;
}

async function loadOverview() {
  try { state.overview = await api('/api/stats/overview'); } catch (e) { state.overview = null; }
  renderLibraryOverview();
  return state.overview;
}

function teamScore(m) {
  if (m.team_a_score == null) return '<span class="ct">' + m.ct_score + '</span> : <span class="t">' + m.t_score + '</span>';
  return '<span>' + m.team_a_score + '</span> : <span>' + m.team_b_score + '</span>';
}
function matchTime(m) { return m.played_at || m.created_at; }

function matchCardHtml(m, withPick) {
  return (withPick ? '<input type="checkbox" class="pick" title="加入对比"' + (state.selected.has(m.id) ? ' checked' : '') + '>' : '') +
    '<div class="t" title="' + escapeAttr(m.file_name) + '">' + escapeHtml(m.file_name) + '</div>' +
    '<div class="s">' + teamScore(m) + '</div>' +
    '<div class="d">' + escapeHtml(mapLabel(m.map_name)) + ' · ' + m.round_count + ' 回合 · ' + fmtDate(matchTime(m)) +
    (m.demo_present === false ? ' · <span title="demo 本体已回收，统计数据完整">已回收</span>' : '') + '</div>';
}

/* ---------------------------------------------------------------- 多场对比页的选择器 */
function renderStatsPicker() {
  const box = $('#matches');
  box.innerHTML = '';
  $('#no-matches').classList.toggle('hidden', state.matches.length > 0);
  state.matches.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'match' + (state.selected.has(m.id) ? ' selected' : '');
    div.innerHTML = matchCardHtml(m, true);
    const pick = div.querySelector('.pick');
    const toggle = (on) => {
      if (on) state.selected.add(m.id); else state.selected.delete(m.id);
      pick.checked = on;
      div.classList.toggle('selected', on);
      syncCompareBar();
      renderLibrary();
    };
    pick.addEventListener('click', (e) => { e.stopPropagation(); toggle(pick.checked); });
    div.addEventListener('click', () => toggle(!state.selected.has(m.id)));
    box.appendChild(div);
  });
}
function syncCompareBar() {
  const n = state.selected.size;
  $('#btn-compare').disabled = n < 2;
  $('#sel-hint').textContent = n < 2 ? '勾选 2 场以上可比对' : '已选 ' + n + ' 场';
  $('#sel-count').textContent = n ? '已选 ' + n + ' 场' : '';
}

/* ---------------------------------------------------------------- Demo 库表格 */
function libFiltered() {
  const q = state.libQ.trim().toLowerCase();
  const list = state.matches.filter((m) => {
    if (state.libMap && m.map_name !== state.libMap) return false;
    if (state.libDemo === 'present' && !m.demo_present) return false;
    if (state.libDemo === 'missing' && m.demo_present) return false;
    if (state.libDemo === 'keep' && !m.keep_demo) return false;
    if (state.libDemo === 'recyclable' && !m.recyclable) return false;
    if (state.libDemo === 'dup' && !m.duplicate) return false;
    if (!q) return true;
    return [m.file_name, m.server_name, m.map_name].some((x) => String(x || '').toLowerCase().includes(q));
  });
  const by = {
    time: (a, b) => (matchTime(b) || 0) - (matchTime(a) || 0),
    import: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    long: (a, b) => (b.playback_time || 0) - (a.playback_time || 0),
    rounds: (a, b) => (b.round_count || 0) - (a.round_count || 0),
    name: (a, b) => String(a.file_name).localeCompare(String(b.file_name)),
  };
  return list.sort(by[state.libSort] || by.time);
}
function renderLibraryMaps() {
  const sel = $('#lib-map');
  const maps = [...new Set(state.matches.map((m) => m.map_name).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部地图</option>' +
    maps.map((x) => '<option value="' + escapeAttr(x) + '">' + escapeHtml(x) + '</option>').join('');
  sel.value = maps.includes(state.libMap) ? state.libMap : (state.libMap = '');
}
function demoCell(m) {
  if (!m.demo_present) return '<span class="dim" title="demo 本体已回收或不在原路径；统计数据完整，回放只能看已缓存的回合">已回收</span>';
  const tag = m.demo_managed ? '' : ' <span class="dim" title="直接从本机路径解析，程序不会删除这个文件">外部</span>';
  return '<span class="ok-text">在本机</span>' + tag + (m.recyclable ? ' <span class="badge-low" title="超过回收期限且未标记保留">可回收</span>' : '');
}
function renderLibrary() {
  const tbl = $('#tbl-lib');
  renderLibraryMaps();
  const list = libFiltered();
  const total = state.matches.length;
  $('#lib-count').textContent = list.length === total ? total + ' 场' : list.length + ' / ' + total + ' 场';
  /* 空态看的是「筛完剩几条」而不是库里总共几条，否则搜不到时会是一片空白表格 */
  $('#lib-empty').classList.toggle('hidden', list.length > 0);
  $('#lib-empty-text').textContent = total ? '没有符合当前筛选条件的比赛。' : '库里还没有比赛。';
  $('#lib-bar').classList.toggle('hidden', !state.selected.size);
  $('#lib-selhint').textContent = '已选 ' + state.selected.size + ' 场' +
    (state.selected.size >= 2 ? '，可直接对比' : '，再选至少 1 场即可对比');
  $('#lib-compare').disabled = state.selected.size < 2;
  if (!list.length) { tbl.innerHTML = ''; return; }

  let html = '<thead><tr><th class="l">文件名</th><th class="l">地图</th><th>比分</th><th>回合</th><th>时长</th>' +
    '<th>比赛时间</th><th class="l">demo 本体</th><th>保留回放</th><th class="l">操作</th></tr></thead><tbody>';
  list.forEach((m) => {
    const cur = m.id === state.matchId;
    const flags = (m.duplicate ? ' <span class="badge-low" title="与另一场的 demo 文件完全相同">重复</span>' : '') +
      ((m.derive_version || 0) === 0 ? ' <span class="badge-low" title="派生数据正在后台补算">待重算</span>' : '');
    html += '<tr' + (cur ? ' class="cur"' : '') + '>' +
      '<td class="l"><input type="checkbox" class="pick" data-libpick="' + escapeAttr(m.id) + '"' +
        (state.selected.has(m.id) ? ' checked' : '') + '> <span class="' + (cur ? 'accent-text' : '') + '" title="' +
        escapeAttr(m.file_name) + '">' + escapeHtml(m.file_name) + '</span>' + (cur ? ' <span class="pill">分析中</span>' : '') + flags + '</td>' +
      '<td class="l">' + escapeHtml(m.map_name || '?') + '</td>' +
      '<td>' + teamScore(m) + '</td>' +
      '<td>' + (m.round_count || 0) + '</td>' +
      '<td>' + (m.playback_time ? Math.round(m.playback_time / 60) + ' 分' : '-') + '</td>' +
      '<td>' + escapeHtml(fmtDate(matchTime(m), true)) + '</td>' +
      '<td class="l">' + demoCell(m) + '</td>' +
      '<td><input type="checkbox" class="pick" data-libkeep="' + escapeAttr(m.id) + '"' + (m.keep_demo ? ' checked' : '') +
        (m.demo_present ? '' : ' disabled') + ' title="标记后不会出现在「可回收」里"></td>' +
      '<td class="l"><button class="btn ghost sm" data-libopen="' + escapeAttr(m.id) + '">分析</button> ' +
      (m.demo_present && m.demo_managed && !m.keep_demo ? '<button class="btn ghost sm" data-librecycle="' + escapeAttr(m.id) + '" title="删除 demo 本体，保留全部统计">回收</button> ' : '') +
      (m.demo_present ? '<button class="btn ghost sm" data-libreparse="' + escapeAttr(m.id) + '" title="用当前解析器重新解析">重解析</button> ' : '') +
      '<button class="btn ghost sm" data-libdel="' + escapeAttr(m.id) + '">删除</button></td></tr>';
  });
  tbl.innerHTML = html + '</tbody>';
}
function renderLibraryOverview() {
  const ov = state.overview;
  const box = $('#lib-overview');
  if (!ov) { box.innerHTML = ''; return; }
  const s = ov.storage;
  box.innerHTML = [
    ['数据库', fmtBytes(s.db_bytes)], ['demo 本体', fmtBytes(s.demos_bytes) + ' · ' + ov.demos_present + ' 份'],
    ['已回收', ov.demos_missing + ' 场'], ['可回收', ov.recyclable + ' 场'], ['保留回放', ov.kept + ' 场'],
  ].map(([k, v]) => '<span class="pill">' + k + ' ' + v + '</span>').join('') +
    (ov.duplicates.length ? '<span class="pill bad">重复导入 ' + ov.duplicates.length + ' 组</span>' : '') +
    (ov.stale_derive ? '<span class="pill">待重算 ' + ov.stale_derive + ' 场</span>' : '');
}

$('#tbl-lib').addEventListener('change', async (e) => {
  const pick = e.target.dataset.libpick;
  if (pick) {
    if (e.target.checked) state.selected.add(pick); else state.selected.delete(pick);
    renderLibrary(); renderStatsPicker(); syncCompareBar();
    return;
  }
  const keep = e.target.dataset.libkeep;
  if (keep) {
    try {
      await api('/api/matches/' + keep, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_demo: e.target.checked }) });
      await refreshLibrary();
    } catch (er) { toast('设置失败：' + er.message, true); e.target.checked = !e.target.checked; }
  }
});
$('#tbl-lib').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-libopen]');
  if (open) { openMatch(open.dataset.libopen).then(() => go('analysis', 'match')).catch((er) => toast('打开失败：' + er.message, true)); return; }
  const del = e.target.closest('[data-libdel]');
  if (del) { deleteMatchById(del.dataset.libdel); return; }
  const rec = e.target.closest('[data-librecycle]');
  if (rec) { recycleDemo(rec.dataset.librecycle); return; }
  const rep = e.target.closest('[data-libreparse]');
  if (rep) {
    try {
      const r = await api('/api/matches/' + rep.dataset.libreparse + '/reparse', { method: 'POST' });
      const m = state.matches.find((x) => x.id === rep.dataset.libreparse);
      trackTask(r.task_id, (m ? m.file_name : '') + '（重解析）');
      toast('已提交重解析');
    } catch (er) { toast('重解析失败：' + er.message, true); }
  }
});
$('#lib-q').addEventListener('input', (e) => { state.libQ = e.target.value; renderLibrary(); });
$('#lib-map').addEventListener('change', (e) => { state.libMap = e.target.value; renderLibrary(); });
$('#lib-demo').addEventListener('change', (e) => { state.libDemo = e.target.value; renderLibrary(); });
$('#lib-sort').addEventListener('change', (e) => { state.libSort = e.target.value; renderLibrary(); });
$('#lib-clear').addEventListener('click', () => { state.selected.clear(); renderLibrary(); renderStatsPicker(); syncCompareBar(); });
$('#lib-compare').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (ids.length < 2) { toast('至少需要 2 场比赛', true); return; }
  show('stats');
  syncCompareBar();
  await runCompare(ids);
});

async function refreshLibrary() {
  await loadMatches();
  await loadOverview();
}

async function recycleDemo(id) {
  const m = state.matches.find((x) => x.id === id);
  if (!confirm('回收「' + (m ? m.file_name : id) + '」的 demo 本体？\n\n统计、趋势、高光、AI 复盘全部保留；之后不能生成新的回放（已看过的回合仍可播放），也不能重解析。')) return;
  try {
    const r = await api('/api/matches/' + id + '/demo', { method: 'DELETE' });
    toast('已回收，释放 ' + fmtBytes(r.freed_bytes));
    await refreshLibrary();
  } catch (e) { toast('回收失败：' + e.message, true); }
}

async function deleteMatchById(id) {
  const m = state.matches.find((x) => x.id === id);
  if (!confirm('确定删除比赛「' + (m ? m.file_name : id) + '」？\n\n不可撤销：统计数据、回放缓存与程序保存的 demo 副本一起删除。\n（直接从 Steam 目录解析的原始录像不会被删除。）')) return;
  try {
    await api('/api/matches/' + id, { method: 'DELETE' });
    state.selected.delete(id);
    if (state.matchId === id) clearCurrentMatch();
    toast('已删除');
    await refreshLibrary();
    await loadRoster().catch(() => {});
  } catch (e) { toast('删除失败：' + e.message, true); }
}

pageEnter.library = () => refreshLibrary();
pageEnter.compare = () => { renderStatsPicker(); syncCompareBar(); };
