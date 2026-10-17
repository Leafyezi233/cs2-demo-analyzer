/* 设置页：外观（浏览器本地）、数据与存储、AI 复盘配置（本机数据库）、当前比赛操作、关于。 */
'use strict';

['theme', 'compact', 'tabular', 'radar', 'livecolor'].forEach((k) =>
  $('#set-' + k).addEventListener('change', (e) => setSetting(k, e.target.value)));
$('#set-every').addEventListener('change', (e) => {
  setSetting('every', e.target.value);
  state.replay = null;
});

const AI_DESC = {
  none: '不调用任何模型，用模板把规则发现拼成文字。完全离线。',
  manual: '生成复盘时把提示词复制到剪贴板，你可以粘贴到任何聊天工具里。',
  openai: '任何兼容 OpenAI /chat/completions 的接口：中转服务、DeepSeek、本地 ollama（http://127.0.0.1:11434/v1）等。',
  anthropic: '使用 Claude 官方 SDK（需要在运行环境里 pip install anthropic）。被安全策略拒答时由服务端自动换模型重试。',
};
let aiDefaults = {};
function syncAiForm() {
  const prov = $('#ai-provider').value;
  $('#ai-provider-desc').textContent = AI_DESC[prov] || '';
  $$('.ai-remote').forEach((el) => el.classList.toggle('hidden', prov === 'none' || prov === 'manual'));
  $('#ai-model').placeholder = aiDefaults[prov] || '';
  $('#ai-model-desc').textContent = aiDefaults[prov] ? '留空使用默认：' + aiDefaults[prov] : '';
}
$('#ai-provider').addEventListener('change', syncAiForm);

async function loadSettingsPage() {
  refreshHealth();
  try {
    const s = await api('/api/settings');
    aiDefaults = s.ai_default_models || {};
    $('#ai-provider').value = s.ai.provider;
    $('#ai-base').value = s.ai.base_url || '';
    $('#ai-model').value = s.ai.model || '';
    $('#ai-key').value = '';
    $('#ai-key').placeholder = s.ai.api_key_set ? '已设置（' + s.ai.api_key_hint + '）' : '未设置';
    $('#ai-key-desc').textContent = s.ai.api_key_set ? '已保存；留空表示不修改' : '本地模型可以不填';
    syncAiForm();
    $('#set-recycle').value = s.lifecycle.recycle_days;
    $('#set-scan-dirs').value = (s.lifecycle.scan_dirs || []).join('\n');
  } catch (e) { toast('读取设置失败：' + e.message, true); }
  await loadOverview();
  renderStorage();
  await loadRoster().catch(() => {});
  renderIdentityPanel();
}
function renderStorage() {
  const ov = state.overview;
  if (!ov) { $('#store-kpis').innerHTML = ''; return; }
  const s = ov.storage;
  $('#store-kpis').innerHTML = [
    ['数据库', fmtBytes(s.db_bytes), ov.matches + ' 场 · ' + ov.players + ' 名玩家'],
    ['demo 本体', fmtBytes(s.demos_bytes), ov.demos_present + ' 份在本机' + (s.external_demos ? '（' + s.external_demos + ' 份在外部目录）' : '')],
    ['可回收', ov.recyclable + ' 场', '超过 ' + ov.recycle_days + ' 天且未标记保留'],
    ['回放缓存', fmtBytes(s.replay_cache_bytes), '看过的回合轨迹'],
    ['备份', fmtBytes(s.backups_bytes), '数据/backups/'],
  ].map(([k, v, sub]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + escapeHtml(sub) + '</div></div>').join('');
  const notes = [];
  if (ov.stale_derive) notes.push(ov.stale_derive + ' 场的派生数据口径过期（后台会自动重算）');
  if (ov.reparse_candidates) notes.push(ov.reparse_candidates + ' 场可以用新解析器重解析（在 Demo 库里点「重解析」）');
  if (ov.duplicates.length) notes.push(ov.duplicates.length + ' 组重复导入');
  if (ov.import_failures.length) notes.push('最近 ' + ov.import_failures.length + ' 次导入失败，最近一次：' + (ov.import_failures[0].file_name || '') + '：' + (ov.import_failures[0].error || ''));
  $('#store-detail').innerHTML = notes.map(escapeHtml).join('<br>') || '库状态正常。';
  $('#store-note').textContent = '解析口径 v' + ov.versions.parser + ' · 派生口径 v' + ov.versions.derive;
}

$('#btn-save-lifecycle').addEventListener('click', async () => {
  try {
    await api('/api/settings/lifecycle', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recycle_days: Number($('#set-recycle').value) || 30, scan_dirs: $('#set-scan-dirs').value }) });
    toast('已保存');
    await loadOverview(); renderStorage(); renderLibrary();
  } catch (e) { toast('保存失败：' + e.message, true); }
});
$('#btn-recycle').addEventListener('click', async () => {
  const n = state.overview ? state.overview.recyclable : 0;
  if (!n) { toast('没有可回收的 demo'); return; }
  if (!confirm('回收 ' + n + ' 份 demo 本体？\n统计数据全部保留，只是这些比赛之后不能再生成新的回放、不能重解析。')) return;
  try {
    const r = await api('/api/maintenance/recycle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    toast('已回收 ' + r.recycled + ' 份，释放 ' + fmtBytes(r.freed_bytes));
    await refreshLibrary(); renderStorage();
  } catch (e) { toast('回收失败：' + e.message, true); }
});
$('#btn-export').addEventListener('click', () => { window.location.href = '/api/export/db'; });
$('#btn-backup').addEventListener('click', async () => {
  try {
    const r = await api('/api/maintenance/backup', { method: 'POST' });
    toast('已备份到 ' + r.path + '（' + fmtBytes(r.bytes) + '）');
    await loadOverview(); renderStorage();
  } catch (e) { toast('备份失败：' + e.message, true); }
});
$('#btn-rederive').addEventListener('click', async () => {
  if (!confirm('用库里存档的原始数据，把全部比赛的派生数据重算一遍？\n不需要 demo 本体，比赛多时需要一点时间，在后台进行。')) return;
  try {
    const r = await api('/api/maintenance/rederive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    trackTask(r.task_id, '重算派生数据', 'rederive');
    toast(r.already_running ? '已经在重算中' : '已开始重算');
  } catch (e) { toast('提交失败：' + e.message, true); }
});
$('#btn-clear-cache').addEventListener('click', async () => {
  const targets = state.matches.map((m) => m.id);
  if (!targets.length) { toast('没有可清理的比赛', true); return; }
  if (!confirm('清空全部回放缓存？\ndemo 已回收的比赛，清空后就再也看不了回放了。')) return;
  let n = 0;
  for (const id of targets) {
    try { await api('/api/matches/' + id + '/replay', { method: 'DELETE' }); n++; } catch (e) { /* 忽略单场失败 */ }
  }
  state.replay = null;
  toast('已清理 ' + n + ' 场的回放缓存');
  await loadOverview(); renderStorage();
});

$('#btn-ai-save').addEventListener('click', async () => {
  const body = { provider: $('#ai-provider').value, base_url: $('#ai-base').value.trim(), model: $('#ai-model').value.trim() };
  if ($('#ai-key').value.trim()) body.api_key = $('#ai-key').value.trim();
  try {
    await api('/api/settings/ai', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('AI 设置已保存');
    loadSettingsPage();
  } catch (e) { toast('保存失败：' + e.message, true); }
});
$('#btn-ai-clear').addEventListener('click', async () => {
  try {
    await api('/api/settings/ai', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear_key: true }) });
    toast('已清除 API key');
    loadSettingsPage();
  } catch (e) { toast('清除失败：' + e.message, true); }
});

$('#btn-reload').addEventListener('click', async () => {
  try {
    await afterDataChange();
    if (state.matchId) await openMatch(state.matchId);
    toast('已重载全部数据');
  } catch (e) { toast('重载失败：' + e.message, true); }
});
$('#btn-delete-match').addEventListener('click', () => {
  if (!state.matchId) { toast('没有打开的比赛', true); return; }
  deleteMatchById(state.matchId).then(() => { if (!state.matchId) go('home'); });
});

async function refreshHealth() {
  const el = $('#about-health');
  try {
    const h = await api('/api/health');
    el.textContent = 'v' + h.version + ' · 地图资产' + (h.mapdata ? '就绪' : '缺失');
    $('#about-ver').textContent = '数据库 v' + h.schema_version + ' · 解析口径 v' + h.parser_version + ' · 派生口径 v' + h.derive_version +
      (h.awpy_version ? ' · awpy ' + h.awpy_version : ' · 未检测到 awpy') + (h.migration_note ? ' · ' + h.migration_note : '');
    return h;
  } catch (e) { el.textContent = '后端未连接'; return null; }
}

pageEnter.settings = () => loadSettingsPage();
