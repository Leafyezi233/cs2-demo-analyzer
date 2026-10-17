/* 地图页：击杀 / 死亡 / 射击的核密度图，可按玩家、回合、阵营、武器筛选。
 * 坐标换算与 awpy.plot.world_to_pixel 一致：(x - pos_x) / scale、(pos_y - y) / scale。 */
'use strict';

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
onRedraw(() => {
  HEAT_LUT = buildHeatLUT();
  if (state.sec === 'analysis' && state.page === 'map') loadHeat(state.heatType);
});

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

async function prepareHeatFilters() {
  const sel = $('#f-round');
  sel.innerHTML = '<option value="">全部</option>' + state.rounds
    .map((r) => '<option value="' + r.round_num + '">第 ' + r.round_num + ' 回合' + (r.is_knife_round ? '（刀局）' : '') + '</option>').join('');
  sel.value = state.heatFilter.round_num;
  const psel = $('#f-player');
  const players = [...state.players].sort((a, b) => String(a.team).localeCompare(String(b.team)) || String(a.name).localeCompare(String(b.name)));
  psel.innerHTML = '<option value="">全部</option>' + players.map((p) => '<option value="' + escapeAttr(p.steamid) + '">' +
    escapeHtml((p.team ? p.team + ' · ' : '') + p.name) + '</option>').join('');
  psel.value = state.heatFilter.steamid;
  try { state.weapons = (await api('/api/matches/' + state.matchId + '/weapons')).weapons || []; }
  catch (e) { state.weapons = []; }
  const wsel = $('#f-weapon');
  wsel.innerHTML = '<option value="">全部</option>' + state.weapons
    .map((w) => '<option value="' + escapeAttr(w.name) + '">' + escapeHtml(w.name) + '（击杀 ' + w.kills + ' · 射击 ' + w.shots + '）</option>').join('');
  wsel.value = state.heatFilter.weapon;
}
const bindFilter = (id, key) => $(id).addEventListener('change', (e) => { state.heatFilter[key] = e.target.value; loadHeat(state.heatType); });
bindFilter('#f-round', 'round_num');
bindFilter('#f-side', 'side');
bindFilter('#f-weapon', 'weapon');
bindFilter('#f-player', 'steamid');

/* 在画布上叠密度图：每个点按高斯核累加，再按最大值取平方根映射到调色板。 */
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

let heatToken = 0;
async function loadHeat(type) {
  if (!state.matchId) return;
  const token = ++heatToken;
  state.heatType = type;
  $$('[data-heat]').forEach((b) => b.classList.toggle('ghost', b.dataset.heat !== type));
  const mapName = state.match ? state.match.map_name : null;
  const f = state.heatFilter;
  const qs = new URLSearchParams({ type });
  if (f.round_num) qs.set('round_num', f.round_num);
  if (f.side) qs.set('side', f.side);
  if (f.weapon) qs.set('weapon', f.weapon);
  if (f.steamid) qs.set('steamid', f.steamid);
  let data;
  try { data = await api('/api/matches/' + state.matchId + '/heatmap?' + qs.toString()); }
  catch (e) { toast('取热力图失败：' + e.message, true); return; }
  const info = mapName ? await ensureMapInfo(mapName) : null;
  if (token !== heatToken) return;   // 连续切筛选时只画最后一次
  const bgOk = !!(info && info.radar);
  const size = (info && Array.isArray(info.radar_size) && info.radar_size.length === 2) ? info.radar_size : [1024, 1024];
  $('#map-name').textContent = mapName || '未知地图';
  const parts = [];
  if (f.steamid) parts.push((state.players.find((p) => p.steamid === f.steamid) || {}).name || f.steamid);
  if (f.round_num) parts.push('第 ' + f.round_num + ' 回合');
  if (f.side) parts.push(f.side === 'ct' ? 'CT' : 'T');
  if (f.weapon) parts.push(f.weapon);
  const active = parts.length > 0;
  $('#heat-count').textContent = data.points.length + ' 个点' + (active ? '（筛选后 ' + data.filtered + '/' + data.total + ' 条记录）' : '');
  $('#heat-filter-note').textContent = active ? '已筛选：' + parts.join(' · ') : '';
  $('#map-note').textContent = bgOk
    ? '底图与坐标表来自 awpy-data。'
    : '没有找到地图资产（mapdata/），下面只显示世界坐标点云；把 awpy-data 资产放进 mapdata/ 即可叠加雷达底图。';
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
  const base = bgOk && mapName ? await loadRadar(mapName) : null;
  if (token !== heatToken) return;
  drawDensity(document.getElementById('map-canvas'), pts, size, base);
  writeHash();
}

pageEnter.map = () => loadHeat(state.heatType);
