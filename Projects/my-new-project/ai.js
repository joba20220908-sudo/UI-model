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
// AI 定位逻辑已抽到 locator.js（provider 链：ocrServer → windowClaude → zhipuVision）
// 这里只保留 autolocateNode：调用 window.locateHotspots → 选择最佳候选 → 消除重叠。
// 加新 provider 看 locator.js。

async function autolocateNode(node, { minConf = 0.6, pad = 0.003, dryRun = false } = {}) {
  const url = await resolveNodeImageUrl(node);
  if (!url) return { ok: false, reason: 'no-image' };
  const kids = node.children.filter(c => nodeHasImage(c) || c.children.length > 0);
  if (!kids.length) return { ok: false, reason: 'no-children' };

  let img;
  try { img = await loadImage(url); }
  catch (e) { return { ok: false, reason: 'img-load-fail' }; }

  const targets = kids.map(k => k.title);

  // 调 locator 链：ocrServer → windowClaude → zhipuVision，第一个命中的赢
  if (typeof window.locateHotspots !== 'function') {
    return { ok: false, reason: 'locator-missing', error: 'locator.js 未加载（检查 Prototype.html）' };
  }
  const located = await window.locateHotspots({ img, targets });
  if (!located) return { ok: false, reason: 'no-candidates' };
  const { candidates, fullW, fullH, source } = located;

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

  return { ok: true, results, source, imageUrl: url, fullW, fullH };
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
    btn.textContent = `✓ ${okCount}/${total}${res.source ? ` · ${res.source}` : ''}`;
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
