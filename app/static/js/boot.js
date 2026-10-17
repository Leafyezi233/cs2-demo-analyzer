/* 深链与启动。
 * 新格式：#s=<section>&p=<page>&m=<match>&heat=&round=&side=&weapon=&player=&r=&frame=&sel=&who=
 * 旧格式：#match=<id>&page=<page>&...  —— 仍可解析，旧书签不失效。 */
'use strict';

let hashLock = false;
function writeHash() {
  if (hashLock) return;
  const { sec, page } = state;
  const q = new URLSearchParams();
  if (!(sec === 'home' && !state.primaryId)) q.set('s', sec);
  if (SUBPAGES[sec] && page !== PAGE_OF_SEC[sec]) q.set('p', page);
  if (state.matchId && sec === 'analysis') q.set('m', state.matchId);
  if (sec === 'analysis' && page === 'map') {
    const f = state.heatFilter;
    if (state.heatType !== 'kills') q.set('heat', state.heatType);
    if (f.round_num) q.set('round', f.round_num);
    if (f.side) q.set('side', f.side);
    if (f.weapon) q.set('weapon', f.weapon);
    if (f.steamid) q.set('player', f.steamid);
  }
  if (sec === 'analysis' && page === 'replay') {
    if (state.replayRound != null) q.set('r', state.replayRound);
    if (state.replayFrame) q.set('frame', state.replayFrame);
  }
  if (state.primaryId && sec === 'home') q.set('who', state.primaryId);
  if (sec === 'stats' && state.selected.size) q.set('sel', [...state.selected].join(','));
  const h = q.toString();
  history.replaceState(null, '', h ? '#' + h : location.pathname);
}

async function applyHash() {
  const h = location.hash.replace(/^#/, '');
  const q = new URLSearchParams(h);
  let sec = q.get('s');
  let page = q.get('p');
  const id = q.get('m') || q.get('match');     // 兼容旧格式 match=
  if (!sec && q.get('page')) { page = q.get('page'); sec = SEC_OF_PAGE[page] || 'home'; }
  if (!sec) sec = id ? 'analysis' : 'home';
  if (!SECTIONS.includes(sec)) sec = 'home';
  if (page && SUBPAGES[sec] && !SUBPAGES[sec].includes(page)) page = PAGE_OF_SEC[sec];

  hashLock = true;
  try {
    /* 视角账号要在页面加载前定下来，否则统计会先按全部账号算一遍 */
    setPrimary(q.get('who') || state.primaryId || '');
    if (id) {
      try { await openMatch(id); }
      catch (e) { toast('深链里的比赛已不存在：' + e.message, true); if (sec === 'analysis') sec = 'library'; }
    }
    const sel = (q.get('sel') || '').split(',').filter(Boolean);
    if (sel.length) { state.selected = new Set(sel); renderStatsPicker(); syncCompareBar(); }

    if (sec === 'analysis' && page === 'map') {
      state.heatFilter = { round_num: q.get('round') || '', side: q.get('side') || '', weapon: q.get('weapon') || '', steamid: q.get('player') || '' };
      $('#f-round').value = state.heatFilter.round_num;
      $('#f-side').value = state.heatFilter.side;
      $('#f-weapon').value = state.heatFilter.weapon;
      $('#f-player').value = state.heatFilter.steamid;
      state.heatType = q.get('heat') || 'kills';
      go(sec, page);
    } else if (sec === 'analysis' && page === 'replay') {
      if (q.get('r')) { state.replayRound = Number(q.get('r')); $('#r-round').value = state.replayRound; }
      go(sec, page, { frame: q.get('frame') });
    } else if (sec === 'stats') {
      go(sec, page);
      if (sel.length >= 2) await runCompare(sel);
    } else {
      go(sec, page);
    }
  } finally {
    hashLock = false;
    writeHash();
  }
}
window.addEventListener('hashchange', () => { if (!hashLock) applyHash(); });

/* ================================================================== 启动 */
(async function boot() {
  applySettings();
  HEAT_LUT = buildHeatLUT();
  /* 默认统计所有已添加账号（可在「我的数据」的 chips 上取消勾选） */
  state.agSelected = new Set(getIdentities().map((x) => x.steamid));
  try {
    await Promise.all([loadMatches(), loadRoster().catch(() => {}), loadOverview()]);
  } catch (e) {
    toast('加载比赛列表失败：' + e.message, true);
  }
  renderIdentityPanel();
  resumeTasks();
  await applyHash();
  refreshHealth();
  /* 后台任务（启动时的派生补算、别的标签页提交的解析）：定期看一眼，有新任务就接上 */
  setInterval(() => { if (!document.hidden) resumeTasks(); }, 15000);
})();
