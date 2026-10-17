/* 回放页：按 snapshots 重建的走位轨迹 + 本回合击杀记录 + 高光跳转。 */
'use strict';

function sideColor(side) {
  return side === 'counter-terrorist' ? cssVar('--ct') : (side === 'terrorist' ? cssVar('--t') : cssVar('--dim'));
}

function prepareReplayRounds() {
  const sel = $('#r-round');
  sel.innerHTML = state.rounds
    .map((r) => '<option value="' + r.round_num + '">第 ' + r.round_num + ' 回合 · ' + (SIDE_LABEL[r.winner_side] || '?') + ' 胜</option>').join('');
  if (!state.rounds.some((r) => r.round_num === state.replayRound)) state.replayRound = state.rounds.length ? state.rounds[0].round_num : null;
  sel.value = state.replayRound;
  const hsel = $('#r-hl');
  hsel.innerHTML = '<option value="">— 跳到高光（' + state.highlights.length + '）—</option>' + state.highlights
    .map((h, i) => '<option value="' + i + '">R' + h.round_num + ' · ' + escapeHtml(h.title) + ' · ' + escapeHtml(h.name || '') + '</option>').join('');
}
$('#r-round').addEventListener('change', (e) => { state.replayRound = Number(e.target.value); loadReplay(); });
$('#r-hl').addEventListener('change', (e) => {
  const h = state.highlights[Number(e.target.value)];
  e.target.value = '';
  if (h) jumpToHighlight(state.matchId, h.round_num, h.tick_start);
});

/* 从任意页面跳到某场某回合的某个 tick（高光列表、回合明细、趋势图都走这里） */
async function jumpToHighlight(matchId, roundNum, tick) {
  try {
    if (matchId !== state.matchId) await openMatch(matchId);
    if (state.replayRound !== roundNum) { state.replayRound = roundNum; state.replay = null; }
    $('#r-round').value = roundNum;
    go('analysis', 'replay', { startTick: tick });
  } catch (e) { toast('跳转失败：' + e.message, true); }
}

function frameOfTick(tick) {
  const ticks = state.replay ? state.replay.ticks : [];
  if (tick == null || !ticks.length) return 0;
  let lo = 0, hi = ticks.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ticks[mid] < tick) lo = mid + 1; else hi = mid; }
  return lo;
}

async function enterReplayPage(opts) {
  opts = opts || {};
  if (!state.matchId) return;
  if (!state.replay || state.replay.round_num !== state.replayRound) await loadReplay();
  if (!state.replay) return;
  if (opts.startTick != null) state.replayFrame = frameOfTick(opts.startTick);
  else if (opts.frame != null) state.replayFrame = Math.max(0, Math.min(state.replay.ticks.length - 1, Number(opts.frame) || 0));
  $('#r-seek').value = state.replayFrame;
  drawReplay(state.replayFrame);
}

function stopPlayback() {
  if (state.replayTimer) { clearInterval(state.replayTimer); state.replayTimer = null; }
  $('#btn-play').textContent = '播放';
}

async function ensureKills() {
  if (state.kills) return state.kills;
  try { state.kills = await api('/api/matches/' + state.matchId + '/dataset/kills'); } catch (e) { state.kills = []; }
  return state.kills;
}

let replayToken = 0;
async function loadReplay() {
  if (!state.matchId || state.replayRound == null) return;
  const token = ++replayToken;
  stopPlayback();
  $('#r-info').textContent = '加载中…（第一次打开某回合需要从 demo 解码，约 1 秒）';
  $('#replay-note').textContent = '';
  let data;
  try {
    data = await api('/api/matches/' + state.matchId + '/replay/' + state.replayRound + '?every=' + (state.replayEvery || 8));
  } catch (e) {
    if (token !== replayToken) return;
    state.replay = null;
    $('#r-info').textContent = '';
    $('#replay-note').innerHTML = '<span class="bad-text">回放不可用：' + escapeHtml(e.message) + '</span>';
    const cv = $('#replay-canvas');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = cssVar('--bg'); ctx.fillRect(0, 0, cv.width, cv.height);
    await ensureKills();   // 击杀记录来自数据库，demo 不在也能看
    if (token === replayToken) renderKillfeed();
    return;
  }
  if (token !== replayToken) return;
  state.replay = data;
  state.replayFrame = 0;
  const seek = $('#r-seek');
  seek.max = Math.max(0, data.ticks.length - 1);
  seek.value = 0;
  const secs = data.tick_rate ? (data.ticks.length * data.every / data.tick_rate) : null;
  $('#r-info').textContent = data.ticks.length + ' 帧 · ' + data.players.length + ' 名玩家' +
    (secs ? ' · 约 ' + secs.toFixed(0) + ' 秒' : '') + (data.cached ? ' · 缓存命中' : ' · 刚生成 ' + data.build_seconds + 's');
  $('#replay-note').textContent = '每 ' + data.every + ' tick 采样一帧；光晕越大血量越高，死亡后消失；红色 × 是最近 3 秒内的阵亡位置。';
  const mapName = state.match ? state.match.map_name : null;
  state.mapInfo = await ensureMapInfo(mapName);
  if (mapName && state.mapInfo && state.mapInfo.radar) await loadRadar(mapName);
  await ensureKills();
  if (token !== replayToken) return;
  renderReplayLegend();
  renderKillfeed();
  drawReplay(state.replayFrame);
  writeHash();
}

function renderReplayLegend() {
  const sides = [...new Set(state.replay.players.map((p) => p.side))];
  $('#replay-legend').innerHTML = sides.map((s) =>
    '<span class="lg"><span class="sw" style="background:' + sideColor(s) + '"></span>' + escapeHtml(SIDE_LABEL[s] || s) + '</span>').join('') +
    '<span class="lg dim">C4 = 带包 · 拆 = 正在拆包 · 白圈 = 被闪</span>';
}

function roundKills() {
  const r = state.rounds.find((x) => x.round_num === state.replayRound);
  if (!r || !state.kills) return [];
  const end = r.official_end_tick || r.end_tick;
  return state.kills.filter((k) => k.tick >= r.start_tick && k.tick <= end).sort((a, b) => a.tick - b.tick);
}
function renderKillfeed() {
  const box = $('#killfeed');
  const list = roundKills();
  const r = state.rounds.find((x) => x.round_num === state.replayRound) || {};
  const rate = (state.match && state.match.tick_rate) || 64;
  const t0 = r.freeze_end_tick || r.start_tick || 0;
  box.innerHTML = list.length ? list.map((k) => {
    const sec = (k.tick - t0) / rate;
    const clock = sec < 0 ? '冻结' : Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
    const flags = [k.headshot ? '爆头' : '', k.thrusmoke ? '穿烟' : '', k.penetrated ? '穿墙' : '', k.noscope ? '盲狙' : ''].filter(Boolean).join(' ');
    return '<button class="kf" data-kftick="' + k.tick + '"><span class="kt">' + clock + '</span>' +
      '<span style="color:' + sideColor(k.attacker_side) + '">' + escapeHtml(k.attacker_name || '世界') + '</span>' +
      ' <span class="dim">[' + escapeHtml(String(k.weapon || '').replace(/^weapon_/, '')) + ']</span> ' +
      '<span style="color:' + sideColor(k.victim_side) + '">' + escapeHtml(k.victim_name || '?') + '</span>' +
      (flags ? ' <span class="dim fs12">' + flags + '</span>' : '') + '</button>';
  }).join('') : '<div class="dim fs12">这一回合没有击杀记录。</div>';
}
$('#killfeed').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kftick]');
  if (!b || !state.replay) return;
  stopPlayback();
  // 跳到击杀前 2 秒，方便看清交火过程
  const rate = state.replay.tick_rate || 64;
  state.replayFrame = frameOfTick(Number(b.dataset.kftick) - 2 * rate);
  $('#r-seek').value = state.replayFrame;
  drawReplay(state.replayFrame);
});

function drawReplay(frame) {
  const data = state.replay;
  const cv = $('#replay-canvas');
  if (!data || !cv) return;
  cv.width = 1024; cv.height = 1024;
  const W = cv.width, H = cv.height;
  const ctx = cv.getContext('2d');
  const bg = cssVar('--bg');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const info = state.mapInfo;
  const base = state.match && state.match.map_name ? radarCache[state.match.map_name] : null;
  if (base && info && info.radar) { ctx.globalAlpha = 0.9; ctx.drawImage(base, 0, 0, W, H); ctx.globalAlpha = 1; }
  const toPx = (x, y) => (info && info.scale) ? [(x - info.offset_x) / info.scale, (info.offset_y - y) / info.scale] : [x, y];

  const i = Math.max(0, Math.min(data.ticks.length - 1, frame));
  const tick = data.ticks[i];
  const rate = data.tick_rate || 64;

  // 最近 3 秒内的阵亡位置
  const recent = roundKills().filter((k) => k.tick <= tick && tick - k.tick <= 3 * rate);
  for (const k of recent) {
    if (k.victim_x == null) continue;
    const [px, py] = toPx(k.victim_x, k.victim_y);
    ctx.strokeStyle = cssVar('--bad'); ctx.lineWidth = 3;
    ctx.globalAlpha = 1 - (tick - k.tick) / (3 * rate) * 0.7;
    ctx.beginPath(); ctx.moveTo(px - 7, py - 7); ctx.lineTo(px + 7, py + 7); ctx.moveTo(px + 7, py - 7); ctx.lineTo(px - 7, py + 7); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const trail = Math.min(6, i);   // 拖尾帧数
  for (const p of data.players) {
    const side = sideColor(p.side);
    for (let t = trail; t >= 1; t--) {   // 先画拖尾（由远及近，透明度递增）
      const prev = p.frames[i - t];
      if (!prev || prev[2] <= 0) continue;
      const [px, py] = toPx(prev[0], prev[1]);
      ctx.globalAlpha = 0.10 * (1 - t / (trail + 1));
      ctx.fillStyle = side;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const cur = p.frames[i];
    if (!cur || cur[2] <= 0) continue;
    const [px, py] = toPx(cur[0], cur[1]);
    const health = cur[2];
    const r = 6 + (health / 100) * 4;
    const flags = cur[3] || 0;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, r * 2.6);
    grad.addColorStop(0, side);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.25 + (health / 100) * 0.4;
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(px, py, r * 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.55 + (health / 100) * 0.45;
    ctx.fillStyle = side;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5; ctx.strokeStyle = bg; ctx.stroke();
    const yaw = cur[4];   // 朝向：CS2 里 0 度朝 +x
    if (yaw != null) {
      const rad = yaw * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(rad) * r * 2.2, py - Math.sin(rad) * r * 2.2);
      ctx.strokeStyle = side; ctx.lineWidth = 2; ctx.stroke();
    }
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
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = cssVar('--fg');
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.8;
    ctx.fillText(String(p.name || '').slice(0, 12), px, py + r + 13);
    ctx.globalAlpha = 1;
  }

  const sec = data.tick_rate ? (tick - (data.start_tick || 0)) / data.tick_rate : null;
  $('#r-clock').textContent = '帧 ' + (i + 1) + '/' + data.ticks.length + (sec != null ? ' · ' + sec.toFixed(1) + 's' : '') + ' · tick ' + tick;
  $$('#killfeed .kf').forEach((b) => b.classList.toggle('past', Number(b.dataset.kftick) <= tick));
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
    if (state.replayFrame >= data.ticks.length - 1) { stopPlayback(); writeHash(); return; }
    state.replayFrame += 1;
    $('#r-seek').value = state.replayFrame;
    drawReplay(state.replayFrame);
  }, step);
}
function seekBy(frames) {
  if (!state.replay) return;
  stopPlayback();
  state.replayFrame = Math.max(0, Math.min(state.replay.ticks.length - 1, state.replayFrame + frames));
  $('#r-seek').value = state.replayFrame;
  drawReplay(state.replayFrame);
}

$('#btn-play').addEventListener('click', startPlayback);
$('#btn-replay-reset').addEventListener('click', () => { stopPlayback(); state.replayFrame = 0; $('#r-seek').value = 0; drawReplay(0); });
$('#r-seek').addEventListener('input', () => { stopPlayback(); state.replayFrame = Number($('#r-seek').value); drawReplay(state.replayFrame); });
$('#r-seek').addEventListener('change', () => writeHash());
$('#r-speed').addEventListener('change', () => {
  state.replaySpeed = Number($('#r-speed').value);
  if (state.replayTimer) { stopPlayback(); startPlayback(); }
});
$('#r-every').addEventListener('change', () => {
  setSetting('every', $('#r-every').value);
  state.replay = null;      // 采样粒度变了，旧帧不再适用
  if (state.sec === 'analysis' && state.page === 'replay') loadReplay();
});
document.addEventListener('keydown', (e) => {
  if (state.page !== 'replay' || !state.replay) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName) &&
      document.activeElement.type !== 'range') return;
  const fiveSec = Math.round(5 * (state.replay.tick_rate || 64) / state.replay.every);
  if (e.code === 'Space') { e.preventDefault(); startPlayback(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seekBy(e.shiftKey ? fiveSec : 1); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekBy(e.shiftKey ? -fiveSec : -1); }
});
onRedraw(() => { if (state.replay) drawReplay(state.replayFrame); });

pageEnter.replay = (opts) => enterReplayPage(opts);
