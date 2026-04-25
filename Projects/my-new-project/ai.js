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
async function sliceForModel(img, { targetW = 900, tileH = 900, overlap = 300 } = {}) {
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

// 本地浏览器环境下（window.claude 不存在时）走智谱 glm-5v-turbo 视觉模型
// OpenAI 兼容端点，不是 Anthropic 兼容层（后者不支持多模态视觉）
async function askViaZhipu(tile, prompt) {
  let apiKey = localStorage.getItem('minddeck:zhipu_key');
  if (!apiKey) {
    apiKey = window.prompt('请输入智谱 API Key（只存在本地 localStorage，不会上传）：');
    if (!apiKey) throw new Error('未提供 API Key');
    localStorage.setItem('minddeck:zhipu_key', apiKey.trim());
  }
  const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`
    },
    body: JSON.stringify({
      model: 'glm-5v-turbo',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${tile.b64}` } },
        { type: 'text', text: prompt }
      ]}]
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 401) localStorage.removeItem('minddeck:zhipu_key');
    throw new Error(`Zhipu API ${resp.status}: ${err.error?.message || resp.statusText}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ============================================================
// OCR + LLM 语义匹配定位（服务端架构）
// 流程：
//   1. 浏览器把整图 + targets + zhipu_key POST 到 localhost:8788/ocr-locate
//   2. Python 服务做 OCR + 调智谱 glm-4.6 做语义匹配（不在浏览器里调外网）
//   3. 服务返回最终 results；前端只负责按 results 拼 candidates
// 为何 LLM 调用在服务端：
//   - 浏览器直连 open.bigmodel.cn 经常 ERR_CONNECTION_CLOSED（CORS/SNI/限流断连）
//   - 服务端 urllib 无 CORS 烦恼，更稳
//   - 未来对接文档输入时，把 ocr_items 替换成 doc_elements，匹配层不动
// ============================================================
const OCR_LOCATE_URL = 'http://localhost:8788/ocr-locate';

async function tryOCRLocate(img, targets) {
  // 整图转 base64
  let b64;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    b64 = canvas.toDataURL('image/png').split(',')[1];
  } catch (e) {
    console.warn('[OCR] 图片转 base64 失败:', e.message);
    return null;
  }
  // 把 zhipu_key 一起发给本地服务，由它转发到智谱（服务端无 CORS 问题）
  const zhipuKey = localStorage.getItem('minddeck:zhipu_key') || '';
  let resp;
  try {
    resp = await fetch(OCR_LOCATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: b64, targets, zhipu_key: zhipuKey })
    });
  } catch (e) {
    console.info('[OCR] 本地服务未启动（' + OCR_LOCATE_URL + '），将回退到 vision LLM。要启用 OCR 路径，跑：python3 scripts/ocr-locate-server.py');
    return null;
  }
  if (!resp.ok) { console.warn('[OCR] 服务返回 ' + resp.status); return null; }
  const data = await resp.json().catch(() => null);
  if (!data || !data.ok) return null;

  const matchSource = data.match_source || 'unknown';
  console.info(`[OCR] ${(data.ocr_items || []).length} 条文本，匹配方式: ${matchSource}，fullSize ${data.fullW}×${data.fullH}`);

  const candidates = {};
  let hits = 0, miss = 0;
  for (const r of (data.results || [])) {
    if (r.status !== 'ok' || !r.bbox) { miss++; continue; }
    const [x, y, w, h] = r.bbox;
    if (w <= 0 || h <= 0) { miss++; continue; }
    (candidates[r.label] = candidates[r.label] || []).push({
      xInFull: x, yInFull: y, w, h, conf: r.confidence || 1.0
    });
    hits++;
  }
  console.info(`[OCR/${matchSource}] ${hits}/${targets.length} 命中（miss ${miss}）`);
  return { candidates, fullW: data.fullW, fullH: data.fullH };
}

// 限并发 map：避免触发智谱 QPS 限流（429）
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
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
    if (typeof window.claude !== 'undefined') {
      raw = await window.claude.complete({
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: tile.b64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
    } else {
      raw = await askViaZhipu(tile, prompt);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const arr = extractJsonArray(raw);
  return { ok: true, arr: Array.isArray(arr) ? arr : [], raw };
}

async function autolocateNode(node, { minConf = 0.6, pad = 0.003, dryRun = false } = {}) {
  const url = await resolveNodeImageUrl(node);
  if (!url) return { ok: false, reason: 'no-image' };
  const kids = node.children.filter(c => nodeHasImage(c) || c.children.length > 0);
  if (!kids.length) return { ok: false, reason: 'no-children' };

  let img;
  try { img = await loadImage(url); }
  catch (e) { return { ok: false, reason: 'img-load-fail' }; }

  const targets = kids.map(k => k.title);
  let candidates = null, fullW, fullH, tilesCount = 1, source = 'ocr';

  // 路径 A：优先尝试本地 OCR 服务（精确、免费、无限流）
  const ocrResult = await tryOCRLocate(img, targets);
  if (ocrResult) {
    candidates = ocrResult.candidates;
    fullW = ocrResult.fullW;
    fullH = ocrResult.fullH;
  }

  // 路径 B：OCR 不可用时回退到 vision LLM 切片路径
  if (!candidates) {
    source = 'llm';
    const tiles = await sliceForModel(img);
    tilesCount = tiles.length;
    fullW = tiles[0].fullW;
    fullH = tiles[0].fullH;
    candidates = {};
    // 智谱限流严格，串行 + 429 自动退避重试（精度优先于速度）
    const tileResults = await runWithConcurrency(tiles, 1, tile => askModelForTile(tile, targets).then(res => ({ tile, res })));
    for (const { tile, res } of tileResults) {
      if (!res.ok) continue;
      for (const item of res.arr) {
        if (!item || !Array.isArray(item.bbox) || item.bbox.length !== 4) continue;
        const label = item.label;
        const conf = Number(item.confidence) || 0;
        // 过滤零占位（模型对未识别目标硬塞的 [0,0,0,0]）
        if (conf <= 0) continue;
        let [a, b, c, d] = item.bbox.map(Number);
        if (![a, b, c, d].every(Number.isFinite)) continue;
        if (a === 0 && b === 0 && c === 0 && d === 0) continue;
        // 探测 bbox 格式：[x,y,w,h] 还是 [x1,y1,x2,y2]
        let x = a, y = b, w = c, h = d;
        const exceedsAsXYWH = (a + c) > tile.tileW * 1.1 || (b + d) > tile.tileH * 1.1;
        const validAsXYXY = c > a && d > b && (c - a) > 0 && (d - b) > 0 && (c - a) < tile.tileW && (d - b) < tile.tileH;
        if (exceedsAsXYWH && validAsXYXY) {
          w = c - a;
          h = d - b;
        }
        if (w <= 0 || h <= 0) continue;
        if (w >= tile.tileW * 0.98 && h >= tile.tileH * 0.98) continue;
        (candidates[label] = candidates[label] || []).push({
          xInFull: x,
          yInFull: y + tile.offsetYInFull,
          w, h, conf
        });
      }
    }
  }

  // 为每个 kid 选最佳候选(conf 最高,其次 y 最小)
  const results = [];
  kids.forEach(k => {
    const list = candidates[k.title] || [];
    if (!list.length) {
      results.push({ uid: k.uid, label: k.title, status: 'miss' });
      return;
    }
    list.sort((a, b) => (b.conf - a.conf) || (a.yInFull - b.yInFull));
    const best = list[0];
    if (best.conf < minConf) {
      results.push({ uid: k.uid, label: k.title, status: 'low-conf', conf: best.conf });
      return;
    }
    const xPct = Math.max(0, best.xInFull / fullW * 100 - pad * 100);
    const yPct = Math.max(0, best.yInFull / fullH * 100 - pad * 100);
    const wPct = Math.min(100 - xPct, best.w / fullW * 100 + pad * 200);
    const hPct = Math.min(100 - yPct, best.h / fullH * 100 + pad * 200);
    results.push({ uid: k.uid, label: k.title, status: 'ok', conf: best.conf, pos: { xPct, yPct, wPct, hPct } });
  });

  // ===== 消除热点交叉:若两个热点重叠,沿重叠轴各退一半,直到不相交 =====
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
        if (ix <= 0.1 || iy <= 0.1) continue; // 几乎不相交
        // 沿重叠较小的轴收缩;这样主轴不被破坏
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

  if (!dryRun) {
    ok.forEach(r => saveHotspotPosition(node.uid, r.uid, { ...r.pos, conf: r.conf, manual: false }));
  }

  return { ok: true, results, tiles: tilesCount, source, imageUrl: url, fullW, fullH };
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
  const allBtn = btn;
  // 收集候选
  const allCandidates = [];
  (function walk(n) {
    if (nodeHasImage(n) && n.children.some(c => nodeHasImage(c) || c.children.length > 0)) {
      allCandidates.push(n);
    }
    n.children.forEach(walk);
  })(TREE);

  // 过滤：跳过所有子节点都已 manual=true 微调的父节点（保护用户手工结果，避免重复跑 OCR）
  const hsAll = loadHotspotPositions();
  const candidates = allCandidates.filter(n => {
    const kids = n.children.filter(c => nodeHasImage(c) || c.children.length > 0);
    if (!kids.length) return false;
    const parentHs = hsAll[n.uid] || {};
    const allManual = kids.every(k => parentHs[k.uid]?.manual === true);
    return !allManual;
  });
  const skipped = allCandidates.length - candidates.length;

  const skipMsg = skipped > 0 ? `（跳过 ${skipped} 个已手动微调完成的节点）` : '';
  const confirm = window.confirm(`将对 ${candidates.length} 个父页面批量调用 AI 识别热点${skipMsg}\n约需 ${candidates.length * 3} 秒。确认继续?`);
  if (!confirm) return;

  allBtn.disabled = true;
  const origText = allBtn.textContent;
  let okCount = 0, failCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    const node = candidates[i];
    allBtn.textContent = `${i + 1}/${candidates.length}`;
    try {
      const res = await autolocateNode(node);
      if (res.ok && res.results.some(r => r.status === 'ok')) okCount++;
      else failCount++;
    } catch (e) {
      failCount++;
      console.error('autolocate failed for', node.title, e);
    }
  }
  allBtn.textContent = `✓ ${okCount}/${candidates.length}`;
  // 刷新当前页
  renderScreen(nodeIndex.get(CURRENT));
  setTimeout(() => { allBtn.textContent = origText; allBtn.disabled = false; }, 3000);
}
