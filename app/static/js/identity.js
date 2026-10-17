/* 我的账号（身份层）：清单存在 settings.identities（浏览器本地），名册来自后端 /api/roster。
 * 旧版为了拼名册会逐场请求 /players（N 场 = N 个请求），现在一次请求拿全。 */
'use strict';

let rosterCache = new Map();

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
async function loadRoster() {
  const rows = await api('/api/roster');
  rosterCache = new Map(rows.map((r) => [String(r.steamid), r]));
  return rosterCache;
}
function identityName(steamid) {
  const id = getIdentities().find((x) => x.steamid === steamid);
  if (id && id.alias) return id.alias;
  const e = rosterCache.get(steamid);
  return (e && e.name) || steamid;
}

/* 顶栏只管「我是谁」：选定后「我的数据」收敛到该账号；空值＝全部账号。 */
function renderWhoSelect() {
  const sel = $('#who-select');
  const ids = getIdentities();
  if (state.primaryId && !ids.some((x) => x.steamid === state.primaryId)) state.primaryId = '';
  sel.innerHTML = '<option value="">' + (ids.length ? '全部账号（' + ids.length + '）' : '未设置账号') + '</option>' +
    ids.map((x) => '<option value="' + escapeAttr(x.steamid) + '">' + escapeHtml(identityName(x.steamid)) + '</option>').join('');
  sel.value = state.primaryId || '';
}
$('#who-select').addEventListener('change', (e) => setPrimary(e.target.value, true));

function setPrimary(steamid, rerender) {
  /* 深链里的 who 可能已不在清单里，此时退回全部账号而不是保持旧视角 */
  const id = getIdentities().some((x) => x.steamid === steamid) ? steamid : '';
  state.primaryId = id;
  state.agSelected = new Set(id ? [id] : getIdentities().map((x) => x.steamid));
  renderWhoSelect();
  renderIdentityPanel();
  if (rerender) { writeHash(); if (state.sec === 'home') loadHome(); }
}

/* --------------------------------------------------- 设置页：我的账号面板 */
function renderIdentityPanel() {
  const box = $('#id-chips');
  const ids = getIdentities();
  $('#id-count').textContent = ids.length ? ids.length + ' 个' : '';
  $('#id-none').classList.toggle('hidden', ids.length > 0);
  box.innerHTML = ids.map((x) => {
    const e = rosterCache.get(x.steamid);
    const star = state.primaryId === x.steamid;
    return '<span class="chip on" title="' + escapeAttr(x.steamid) + '">' +
      '<button class="sw-star' + (star ? ' on' : '') + '" title="' + (star ? '当前视角账号' : '设为顶栏默认视角') +
      '" data-idstar="' + escapeAttr(x.steamid) + '">★</button>' +
      '<span class="cn">' + escapeHtml(x.alias || identityName(x.steamid)) + '</span>' +
      '<span class="cs">' + (e ? e.count + ' 场' : '库中无记录') + (e && e.team ? ' · ' + escapeHtml(e.team) : '') + '</span>' +
      '<button class="x" title="移除" data-idrm="' + escapeAttr(x.steamid) + '">×</button></span>';
  }).join('');
  /* 候选下拉：库中出现过的全部玩家（出场多的在前），已添加的排除 */
  const sel = $('#id-add');
  const cand = [...rosterCache.values()].filter((e) => !ids.some((x) => x.steamid === e.steamid));
  const keep = sel.value;
  sel.innerHTML = cand.length
    ? cand.map((e) => '<option value="' + escapeAttr(e.steamid) + '">' +
        escapeHtml((e.name || '(未知)') + ' · ' + e.count + ' 场' + (e.team ? ' · ' + e.team : '')) + '</option>').join('')
    : '<option value="">名册为空，先导入比赛</option>';
  if (cand.some((e) => e.steamid === keep)) sel.value = keep;
  renderWhoSelect();
}
$('#id-chips').addEventListener('click', (e) => {
  const star = e.target.closest('[data-idstar]');
  if (star) { setPrimary(state.primaryId === star.dataset.idstar ? '' : star.dataset.idstar, true); return; }
  const rm = e.target.closest('[data-idrm]');
  if (!rm) return;
  removeIdentity(rm.dataset.idrm);
});
function removeIdentity(steamid) {
  saveIdentities(getIdentities().filter((x) => x.steamid !== steamid));
  state.agSelected.delete(steamid);
  if (state.primaryId === steamid) state.primaryId = '';
  renderIdentityPanel();
  if (state.sec === 'home') loadHome();
}
$('#btn-id-add').addEventListener('click', () => {
  const steamid = $('#id-add').value;
  if (!steamid) { toast('没有可添加的玩家', true); return; }
  const alias = $('#id-alias').value.trim();
  const list = getIdentities();
  if (list.some((x) => x.steamid === steamid)) { toast('已经在清单里了', true); return; }
  list.push({ steamid, alias });
  saveIdentities(list);
  $('#id-alias').value = '';
  state.agSelected.add(steamid);
  renderIdentityPanel();
  toast('已添加 ' + identityName(steamid));
});
$('#btn-id-refresh').addEventListener('click', async () => {
  $('#id-count').textContent = '刷新中…';
  try {
    await loadRoster();
    renderIdentityPanel();
    toast('名册已刷新：' + rosterCache.size + ' 名玩家');
  } catch (e) { toast('刷新失败：' + e.message, true); }
});
$('#id-add').addEventListener('change', () => { $('#id-alias').value = ''; });
