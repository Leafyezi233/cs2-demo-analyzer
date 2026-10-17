/* 导入页：拖拽上传、扫描本机录像、后台任务队列（解析 / 重解析 / 重算）。 */
'use strict';

const drop = $('#drop');
const fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  uploadAll([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => { uploadAll([...fileInput.files]); fileInput.value = ''; });

/* 逐个上传：同时上传多个 200MB 文件会互相抢带宽，也会让「重复文件」的判断更难懂 */
async function uploadAll(files) {
  for (const f of files) await upload(f);
}
async function upload(file) {
  if (!/\.dem$/i.test(file.name)) { toast('只接受 .dem 文件：' + file.name, true); return; }
  const local = 'up-' + Math.random().toString(36).slice(2);
  state.tasks.set(local, { id: local, name: file.name, status: 'running', stage: '上传中', progress: 0, kind: 'upload' });
  renderTasks();
  try {
    // 后端按原始字节流接收（不依赖 python-multipart）；mtime 是文件修改时间，用作比赛时间
    const qs = 'name=' + encodeURIComponent(file.name) + '&mtime=' + (file.lastModified || 0);
    const r = await api('/api/demos?' + qs, { method: 'POST', body: file });
    state.tasks.delete(local);
    if (r.duplicate) {
      toast(file.name + ' 已经导入过（与「' + r.file_name + '」是同一个文件），不再重复解析');
      renderTasks();
      return;
    }
    toast('已提交 ' + file.name + '（' + (file.size / 1048576).toFixed(0) + ' MB）');
    trackTask(r.task_id, file.name);
  } catch (e) {
    state.tasks.delete(local);
    renderTasks();
    toast('上传失败：' + file.name + '：' + e.message, true);
  }
}

const KIND_LABEL = { parse: '解析', reparse: '重解析', rederive: '重算', upload: '上传' };
function renderTasks() {
  const box = $('#task-list');
  const list = [...state.tasks.values()];
  $('#no-task').classList.toggle('hidden', list.length > 0);
  $('#task-count').textContent = list.length ? list.length + ' 个' : '';
  box.innerHTML = list.map((t) => {
    const done = t.status === 'done';
    const failed = t.status === 'failed';
    const stage = done ? (t.duplicate ? '已存在，未重复解析' : '完成 · ' + (t.seconds || 0) + 's')
      : (failed ? '失败' : (t.stage || '排队中') + '（' + Math.round((t.progress || 0) * 100) + '%）');
    return '<div class="task' + (failed ? ' err' : '') + '">' +
      '<div class="th"><span class="pill">' + (KIND_LABEL[t.kind] || '任务') + '</span><span class="nm" title="' + escapeAttr(t.name) + '">' +
      escapeHtml(t.name) + '</span><span class="st">' + escapeHtml(stage) + '</span></div>' +
      '<div class="bar"><i style="width:' + (failed ? 100 : (t.progress || 0) * 100) + '%"></i></div>' +
      (failed ? '<div class="st" style="margin-top:6px;color:var(--bad);white-space:normal">' + escapeHtml(t.error || '') + '</div>' : '') +
      '</div>';
  }).join('');
  const running = list.filter((t) => t.status === 'queued' || t.status === 'running').length;
  $('#top-jobs').classList.toggle('hidden', !running);
  $('#top-jobs').textContent = '后台任务 ' + running;
  $('#sf-jobs').textContent = running ? '· 解析中 ' + running : '';
}

/* 轮询一个后台任务直到结束。页面刷新后由 resumeTasks() 重新接上还在跑的任务。 */
function trackTask(taskId, name, kind) {
  if (state.tasks.has(taskId)) return;
  state.tasks.set(taskId, { id: taskId, name, kind: kind || 'parse', status: 'queued', stage: '排队中', progress: 0 });
  renderTasks();
  const tick = async () => {
    let t;
    try { t = await api('/api/tasks/' + taskId); }
    catch (e) { state.tasks.delete(taskId); renderTasks(); return; }   // 后端重启后任务表已清空
    const rec = state.tasks.get(taskId);
    if (!rec) return;
    Object.assign(rec, { status: t.status, stage: t.stage, progress: t.progress, seconds: t.seconds, error: t.error,
      kind: t.kind, duplicate: t.duplicate });
    renderTasks();
    if (t.status === 'done') {
      if (t.duplicate) toast(name + ' 已经导入过，已跳过');
      else if (t.kind === 'rederive') toast('派生数据重算完成：' + ((t.result || {}).done || 0) + ' 场');
      else toast(name + ' 处理完成，用时 ' + t.seconds + ' 秒');
      await afterDataChange();
      setTimeout(() => { state.tasks.delete(taskId); renderTasks(); }, t.duplicate ? 4000 : 1500);
      const busy = [...state.tasks.values()].some((x) => x.status === 'queued' || x.status === 'running');
      if (!busy && t.match_id && t.kind === 'parse' && state.sec === 'import') {
        await openMatch(t.match_id);
        go('analysis', 'match');
      }
    } else if (t.status === 'failed') {
      toast('处理失败：' + name + '：' + t.error, true);
      setTimeout(() => { state.tasks.delete(taskId); renderTasks(); }, 15000);
    } else {
      setTimeout(tick, 800);
    }
  };
  tick();
}
async function resumeTasks() {
  try {
    const list = await api('/api/tasks');
    list.filter((t) => t.status === 'queued' || t.status === 'running').forEach((t) => trackTask(t.id, t.file_name, t.kind));
  } catch (e) { /* 后端未就绪 */ }
}
/* 库里的数据变了（导入 / 重算 / 删除）：刷新列表、名册与当前页 */
async function afterDataChange() {
  await Promise.all([loadMatches(), loadOverview(), loadRoster().catch(() => {})]);
  renderIdentityPanel();
  if (state.sec === 'home') loadHome();
  if (state.matchId && state.sec === 'analysis') openMatch(state.matchId).catch(() => {});
}

/* 扫描本机录像 */
let scanFound = [];
$('#btn-scan').addEventListener('click', async () => {
  $('#scan-hint').textContent = '扫描中…';
  try {
    const r = await api('/api/demos/scan', { method: 'POST' });
    scanFound = r.found;
    const fresh = r.found.filter((f) => !f.match_id);
    $('#scan-hint').textContent = '在 ' + r.existing.length + ' 个目录里找到 ' + r.total + ' 个 .dem，其中 ' + fresh.length + ' 个还没导入';
    $('#btn-scan-all').classList.toggle('hidden', !fresh.length);
    renderScanList(r);
  } catch (e) { $('#scan-hint').textContent = '扫描失败：' + e.message; }
});
function renderScanList(r) {
  const box = $('#scan-list');
  box.innerHTML = '';
  if (!r.found.length) {
    box.innerHTML = '<div class="dim fs12">没有在 Steam 库里找到录像，可以直接拖入文件，或在「设置 › 数据与存储」里添加额外扫描目录。<br>检查过：' +
      r.roots_checked.slice(0, 6).map(escapeHtml).join('；') + (r.roots_checked.length > 6 ? ' 等' : '') + '</div>';
    return;
  }
  r.found.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'scan-row';
    row.innerHTML = '<span class="nm" title="' + escapeAttr(f.path) + '">' + escapeHtml(f.name) + '</span>' +
      '<span class="dim fs12">' + fmtDate(f.mtime, true) + ' · ' + (f.size / 1048576).toFixed(0) + ' MB</span>';
    const btn = document.createElement('button');
    btn.className = 'btn sm' + (f.match_id ? ' ghost' : '');
    btn.textContent = f.match_id ? '已导入 · 打开' : '解析';
    btn.addEventListener('click', async () => {
      if (f.match_id) { openMatch(f.match_id).then(() => go('analysis', 'match')); return; }
      btn.disabled = true;
      await parseLocal(f);
    });
    row.appendChild(btn);
    box.appendChild(row);
  });
}
async function parseLocal(f) {
  try {
    const res = await api('/api/demos/local?path=' + encodeURIComponent(f.path), { method: 'POST' });
    trackTask(res.task_id, f.name);
  } catch (e) { toast('提交失败：' + e.message, true); }
}
$('#btn-scan-all').addEventListener('click', async () => {
  const fresh = scanFound.filter((f) => !f.match_id);
  if (!fresh.length) return;
  if (!confirm('解析 ' + fresh.length + ' 个尚未导入的录像？\n后台同时最多跑 2 个，其余排队。')) return;
  $('#btn-scan-all').classList.add('hidden');
  for (const f of fresh) await parseLocal(f);
});

pageEnter.import = () => renderTasks();
