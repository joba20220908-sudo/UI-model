// ===== AI 自动识别热点位置(分块策略) =====
// 长图按高度切块,每块单独送模型识别,再换算回整图百分比坐标。

async function loadImage(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
}

// 把整图切成 tile,返回 [{b64, tileW, tileH, offsetYInFull, fullW, fullH}, ...]
async function sliceForModel(img, { targetW = 600, tileH = 900, overlap = 120 } = {}) {
  const scale = Math.min(1, targetW / img.naturalWidth);
  const fullW = Math.round(img.naturalWidth * scale);
  const fullH = Math.round(img.naturalHeight * scale);

  const full = document.createElement('canvas');
  full.width = fullW; full.height = fullH;
  full.getContext('2d').drawImage(img, 0, 0, fullW, fullH);

  const tiles = [];
  if (fullH <= tileH) {
    tiles.push({ canvas: full, tileW: fullW, tileH: fullH, offsetYInFull: 0, fullW, fullH });
  } else {
    let y = 0;
    while (y < fullH) {
      const h = Math.min(tileH, fullH - y);
      const c = document.createElement('canvas');
      c.width = fullW; c.height = h;
      c.getContext('2d').drawImage(full, 0, y, fullW, h, 0, 0, fullW, h);
      tiles.push({ canvas: c, tileW: fullW, tileH: h, offsetYInFull: y, fullW, fullH });
      if (y + h >= fullH) break;
      y += (tileH - overlap);
    }
  }

  return tiles.map(t => ({
    b64: t.canvas.toDataURL('image/jpeg', 0.8).split(',')[1],
    tileW: t.tileW, tileH: t.tileH,
    offsetYInFull: t.offsetYInFull,
    fullW: t.fullW, fullH: t.fullH
  }));
}

function extractJsonArray(text) {
  let s = (text || '').trim();
  const m = s.match(/\[[\s\S]*\]/);
  if (m) s = m[0];
  try { return JSON.parse(s); } catch { return null; }
}

async function askModelForTile(tile, targets) {
  const prompt = `这是一张移动端 APP 截图的一部分,尺寸 ${tile.tileW}×${tile.tileH} 像素(坐标原点在本切片左上角)。

请在本切片中找以下目标元素对应的可点击区域(按钮/导航项/列表行/卡片/Tab 标签),返回紧贴其外边框的 bbox 像素坐标。

目标元素:
${targets.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

规则:
- 仅返回**本切片内**能看到的元素;完全不在本切片内的目标不要返回
- 短文本 tab/按钮:bbox 覆盖整个按钮容器,不要只框文字
- 列表行:bbox 宽度覆盖整行
- 若同一目标出现多次,取最上面/最醒目那一个
- 忽略状态栏、底部系统 Tab Bar、返回图标等无关元素
- confidence 表示你对定位的把握 (0.0-1.0)

严格返回 JSON 数组,无任何额外文字或代码块标记:
[{"label":"原样复制的目标文字","bbox":[x,y,w,h],"confidence":0.0-1.0}]
如果本切片中一个目标都没找到,返回 []`;

  let raw;
  try {
    raw = await window.claude.complete({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: tile.b64 } },
          { type: 'text', text: prompt }
        ]
      }]
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const arr = extractJsonArray(raw);
  return { ok: true, arr: Array.isArray(arr) ? arr : [], raw };
}

async function autolocateNode(node, { minConf = 0.6, pad = 0.003 } = {}) {
  const url = await resolveNodeImageUrl(node);
  if (!url) return { ok: false, reason: 'no-image' };
  const kids = node.children.filter(c => nodeHasImage(c) || c.children.length > 0);
  if (!kids.length) return { ok: false, reason: 'no-children' };

  let img;
  try { img = await loadImage(url); }
  catch (e) { return { ok: false, reason: 'img-load-fail' }; }

  const tiles = await sliceForModel(img);
  const fullW = tiles[0].fullW, fullH = tiles[0].fullH;
  const targets = kids.map(k => k.title);

  const candidates = {};
  for (const tile of tiles) {
    const res = await askModelForTile(tile, targets);
    if (!res.ok) continue;
    for (const item of res.arr) {
      if (!item || !Array.isArray(item.bbox) || item.bbox.length !== 4) continue;
      const label = item.label;
      const conf = Number(item.confidence) || 0;
      const [x, y, w, h] = item.bbox.map(Number);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      if (w <= 0 || h <= 0) continue;
      if (w >= tile.tileW * 0.98 && h >= tile.tileH * 0.98) continue;
      (candidates[label] = candidates[label] || []).push({
        xInFull: x, yInFull: y + tile.offsetYInFull, w, h, conf
      });
    }
  }

  const results = [];
  kids.forEach(k => {
    const list = candidates[k.title] || [];
    if (!list.length) { results.push({ uid: k.uid, label: k.title, status: 'miss' }); return; }
    list.sort((a, b) => (b.conf - a.conf) || (a.yInFull - b.yInFull));
    const best = list[0];
    if (best.conf < minConf) { results.push({ uid: k.uid, label: k.title, status: 'low-conf', conf: best.conf }); return; }
    const xPct = Math.max(0, best.xInFull / fullW * 100 - pad * 100);
    const yPct = Math.max(0, best.yInFull / fullH * 100 - pad * 100);
    const wPct = Math.min(100 - xPct, best.w / fullW * 100 + pad * 200);
    const hPct = Math.min(100 - yPct, best.h / fullH * 100 + pad * 200);
    results.push({ uid: k.uid, label: k.title, status: 'ok', conf: best.conf, pos: { xPct, yPct, wPct, hPct } });
  });

  // 消除热点交叉
  const ok = results.filter(r => r.status === 'ok');
  function overlap(a, b) {
    const ax2 = a.xPct + a.wPct, ay2 = a.yPct + a.hPct;
    const bx2 = b.xPct + b.wPct, by2 = b.yPct + b.hPct;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.xPct, b.xPct));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.yPct, b.yPct));
    return { ix, iy };
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) {
        const a = ok[i].pos, b = ok[j].pos;
        const { ix, iy } = overlap(a, b);
        if (ix <= 0.1 || iy <= 0.1) continue;
        if (ix < iy) {
          const half = ix / 2 + 0.2;
          if (a.xPct < b.xPct) { a.wPct = Math.max(3, a.wPct - half); b.xPct += half; b.wPct = Math.max(3, b.wPct - half); }
          else { b.wPct = Math.max(3, b.wPct - half); a.xPct += half; a.wPct = Math.max(3, a.wPct - half); }
        } else {
          const half = iy / 2 + 0.2;
          if (a.yPct < b.yPct) { a.hPct = Math.max(2, a.hPct - half); b.yPct += half; b.hPct = Math.max(2, b.hPct - half); }
          else { b.hPct = Math.max(2, b.hPct - half); a.yPct += half; a.hPct = Math.max(2, a.hPct - half); }
        }
        changed = true;
      }
    }
    if (!changed) break;
  }

  ok.forEach(r => saveHotspotPosition(node.uid, r.uid, { ...r.pos, conf: r.conf, manual: false }));
  return { ok: true, results, tiles: tiles.length };
}

async function autolocateCurrent() {
  const btn = document.getElementById('btn-autolocate');
  const node = nodeIndex.get(CURRENT);
  if (!node) return;
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '识别中…';
  try {
    const res = await autolocateNode(node);
    if (!res.ok) {
      btn.textContent = '✗ ' + (
        res.reason === 'no-children'   ? '无子页' :
        res.reason === 'no-image'      ? '无截图' :
        res.reason === 'img-load-fail' ? '图加载失败' : '失败'
      );
      setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
      return;
    }
    const okCount = res.results.filter(r => r.status === 'ok').length;
    const total = res.results.length;
    btn.textContent = `✓ ${okCount}/${total}${res.tiles > 1 ? ` · ${res.tiles}块` : ''}`;
    renderScreen(node);
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2500);
  } catch (e) {
    btn.textContent = '✗ 异常';
    console.error(e);
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
  }
}

// 批量:遍历所有有截图+子节点的父页,依次识别
async function autolocateAll() {
  const btn = document.getElementById('btn-autolocate-all');
  const candidates = [];
  (function walk(n) {
    if (nodeHasImage(n) && n.children.some(c => nodeHasImage(c) || c.children.length > 0)) {
      candidates.push(n);
    }
    n.children.forEach(walk);
  })(TREE);

  if (!window.confirm(`将对 ${candidates.length} 个父页面批量调用 AI 识别热点(约需 ${candidates.length * 3} 秒)。确认继续?`)) return;

  btn.disabled = true;
  const origText = btn.textContent;
  let okCount = 0, failCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    const node = candidates[i];
    btn.textContent = `${i + 1}/${candidates.length}`;
    try {
      const res = await autolocateNode(node);
      if (res.ok && res.results.some(r => r.status === 'ok')) okCount++;
      else failCount++;
    } catch (e) {
      failCount++;
      console.error('autolocate failed for', node.title, e);
    }
  }
  btn.textContent = `✓ ${okCount}/${candidates.length}`;
  renderScreen(nodeIndex.get(CURRENT));
  setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 3000);
}
