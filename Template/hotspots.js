// ===== 热点:渲染 + 可拖拽位置调整 =====

function defaultHotspotPos(i, total) {
  const wPct = 26;
  const hPct = Math.min(10, 70 / total);
  const gap = 2;
  const startY = 12;
  return {
    xPct: 74 - 2,
    yPct: startY + i * (hPct + gap),
    wPct,
    hPct
  };
}

function addHotspots(screen, node) {
  const kids = node.children.filter(c => nodeHasImage(c) || c.children.length > 0);
  if (!kids.length) return;

  const store = loadHotspotPositions();
  const saved = store[node.uid] || {};

  kids.forEach((k, i) => {
    const pos = saved[k.uid] || defaultHotspotPos(i, kids.length);
    const btn = document.createElement('div');
    btn.className = 'hotspot';
    if (pos.conf != null && pos.conf < 0.8 && !pos.manual) {
      btn.classList.add('low-conf');
      btn.title = `AI 识别置信度较低 (${pos.conf.toFixed(2)}),建议按住 Shift 人工微调`;
    }
    btn.dataset.childUid = k.uid;
    btn.dataset.parentUid = node.uid;
    btn.dataset.label = k.title;
    btn.style.cssText = `
      position: absolute;
      left: ${pos.xPct}%;
      top: ${pos.yPct}%;
      width: ${pos.wPct}%;
      height: ${pos.hPct}%;
    `;

    const badge = document.createElement('span');
    badge.className = 'hotspot-badge';
    badge.textContent = i + 1;
    btn.appendChild(badge);

    btn.addEventListener('click', (e) => {
      if (btn.dataset.dragging === '1') return;
      selectNode(k.uid);
    });

    enableHotspotDrag(btn, screen);
    screen.appendChild(btn);
  });
}

// Shift+拖动调整位置和大小,支持边/中线吸附对齐
function enableHotspotDrag(btn, screen) {
  let moved = false;
  btn.addEventListener('pointerdown', (e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    moved = false;
    btn.setPointerCapture(e.pointerId);
    const rect = screen.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = btn.offsetLeft, startTop = btn.offsetTop;
    const startW = btn.offsetWidth, startH = btn.offsetHeight;

    const vLines = [];
    const hLines = [];
    screen.querySelectorAll('.hotspot').forEach(other => {
      if (other === btn) return;
      const l = other.offsetLeft, t = other.offsetTop;
      const w = other.offsetWidth, h = other.offsetHeight;
      vLines.push({ x: l, fromY: t, toY: t + h, kind: 'L' });
      vLines.push({ x: l + w, fromY: t, toY: t + h, kind: 'R' });
      vLines.push({ x: l + w / 2, fromY: t, toY: t + h, kind: 'CX' });
      hLines.push({ y: t, fromX: l, toX: l + w, kind: 'T' });
      hLines.push({ y: t + h, fromX: l, toX: l + w, kind: 'B' });
      hLines.push({ y: t + h / 2, fromX: l, toX: l + w, kind: 'CY' });
    });

    const bRect = btn.getBoundingClientRect();
    const localX = e.clientX - bRect.left;
    const localY = e.clientY - bRect.top;
    const EDGE = 12;
    const nearL = localX <= EDGE;
    const nearR = localX >= startW - EDGE;
    const nearT = localY <= EDGE;
    const nearB = localY >= startH - EDGE;
    let mode;
    if (nearR && nearB) mode = 'resize';
    else if (nearL) mode = 'edge-l';
    else if (nearR) mode = 'edge-r';
    else if (nearT) mode = 'edge-t';
    else if (nearB) mode = 'edge-b';
    else mode = 'move';
    btn.classList.add('dragging');
    btn.dataset.mode = mode;

    const SNAP = 6;

    function findSnap(lines, target) {
      let best = null;
      for (const ln of lines) {
        const key = 'x' in ln ? 'x' : 'y';
        const d = ln[key] - target;
        if (Math.abs(d) <= SNAP && (!best || Math.abs(d) < Math.abs(best.diff))) {
          best = { line: ln, diff: d };
        }
      }
      return best;
    }

    function showGuide(axis, coord, from, to) {
      const g = document.createElement('div');
      g.className = 'align-guide ' + (axis === 'v' ? 'vertical' : 'horizontal');
      if (axis === 'v') {
        g.style.left = (coord / rect.width * 100) + '%';
        g.style.top = (Math.min(from, to) / rect.height * 100) + '%';
        g.style.height = (Math.abs(to - from) / rect.height * 100) + '%';
      } else {
        g.style.top = (coord / rect.height * 100) + '%';
        g.style.left = (Math.min(from, to) / rect.width * 100) + '%';
        g.style.width = (Math.abs(to - from) / rect.width * 100) + '%';
      }
      screen.appendChild(g);
    }
    function clearGuides() {
      screen.querySelectorAll('.align-guide').forEach(g => g.remove());
    }

    function onMove(ev) {
      moved = true;
      btn.dataset.dragging = '1';
      clearGuides();
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      let nl = startLeft, nt = startTop, nw = startW, nh = startH;
      if (mode === 'move') {
        nl = startLeft + dx; nt = startTop + dy;
      } else if (mode === 'resize') {
        nw = Math.max(20, startW + dx); nh = Math.max(14, startH + dy);
      } else if (mode === 'edge-l') {
        nl = Math.min(startLeft + startW - 20, startLeft + dx);
        nw = Math.max(20, startW - dx);
      } else if (mode === 'edge-r') {
        nw = Math.max(20, startW + dx);
      } else if (mode === 'edge-t') {
        nt = Math.min(startTop + startH - 14, startTop + dy);
        nh = Math.max(14, startH - dy);
      } else if (mode === 'edge-b') {
        nh = Math.max(14, startH + dy);
      }

      let snapV = null, snapH = null;
      if (mode === 'move') {
        const cands = [
          { key: 'l', v: nl },
          { key: 'r', v: nl + nw },
          { key: 'cx', v: nl + nw / 2 },
        ].map(c => ({ ...c, snap: findSnap(vLines, c.v) })).filter(c => c.snap);
        if (cands.length) {
          cands.sort((a, b) => Math.abs(a.snap.diff) - Math.abs(b.snap.diff));
          const c = cands[0];
          nl += c.snap.diff;
          snapV = { x: c.snap.line.x, from: c.snap.line.fromY, to: c.snap.line.toY };
        }
        const candsH = [
          { key: 't', v: nt },
          { key: 'b', v: nt + nh },
          { key: 'cy', v: nt + nh / 2 },
        ].map(c => ({ ...c, snap: findSnap(hLines, c.v) })).filter(c => c.snap);
        if (candsH.length) {
          candsH.sort((a, b) => Math.abs(a.snap.diff) - Math.abs(b.snap.diff));
          const c = candsH[0];
          nt += c.snap.diff;
          snapH = { y: c.snap.line.y, from: c.snap.line.fromX, to: c.snap.line.toX };
        }
      } else if (mode === 'edge-l') {
        const s = findSnap(vLines, nl);
        if (s) { const d = s.diff; nl += d; nw -= d; snapV = { x: s.line.x, from: s.line.fromY, to: s.line.toY }; }
      } else if (mode === 'edge-r' || mode === 'resize') {
        const s = findSnap(vLines, nl + nw);
        if (s) { nw += s.diff; snapV = { x: s.line.x, from: s.line.fromY, to: s.line.toY }; }
      }
      if (mode === 'edge-t') {
        const s = findSnap(hLines, nt);
        if (s) { const d = s.diff; nt += d; nh -= d; snapH = { y: s.line.y, from: s.line.fromX, to: s.line.toX }; }
      } else if (mode === 'edge-b' || mode === 'resize') {
        const s = findSnap(hLines, nt + nh);
        if (s) { nh += s.diff; snapH = { y: s.line.y, from: s.line.fromX, to: s.line.toX }; }
      }

      btn.style.left   = (nl / rect.width  * 100) + '%';
      btn.style.top    = (nt / rect.height * 100) + '%';
      btn.style.width  = (nw / rect.width  * 100) + '%';
      btn.style.height = (nh / rect.height * 100) + '%';

      if (snapV) {
        const from = Math.min(snapV.from, nt);
        const to   = Math.max(snapV.to,   nt + nh);
        showGuide('v', snapV.x, from, to);
      }
      if (snapH) {
        const from = Math.min(snapH.from, nl);
        const to   = Math.max(snapH.to,   nl + nw);
        showGuide('h', snapH.y, from, to);
      }
    }

    function onUp() {
      btn.removeEventListener('pointermove', onMove);
      btn.removeEventListener('pointerup', onUp);
      btn.classList.remove('dragging');
      clearGuides();
      delete btn.dataset.mode;
      if (moved) {
        const finalRect  = btn.getBoundingClientRect();
        const screenRect = screen.getBoundingClientRect();
        saveHotspotPosition(btn.dataset.parentUid, btn.dataset.childUid, {
          xPct: (finalRect.left - screenRect.left) / screenRect.width  * 100,
          yPct: (finalRect.top  - screenRect.top)  / screenRect.height * 100,
          wPct: finalRect.width  / screenRect.width  * 100,
          hPct: finalRect.height / screenRect.height * 100,
          manual: true,
        });
        btn.classList.remove('low-conf');
        btn.removeAttribute('title');
      }
      setTimeout(() => { btn.dataset.dragging = '0'; }, 10);
    }
    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerup', onUp);
  });

  // 光标反馈
  btn.addEventListener('pointermove', (e) => {
    if (!e.shiftKey || btn.classList.contains('dragging')) return;
    const r = btn.getBoundingClientRect();
    const lx = e.clientX - r.left, ly = e.clientY - r.top;
    const EDGE = 12;
    const nL = lx <= EDGE, nR = lx >= r.width - EDGE;
    const nT = ly <= EDGE, nB = ly >= r.height - EDGE;
    let cur = 'move';
    if (nR && nB) cur = 'nwse-resize';
    else if (nL || nR) cur = 'ew-resize';
    else if (nT || nB) cur = 'ns-resize';
    btn.style.cursor = cur;
  });
  btn.addEventListener('pointerleave', () => { btn.style.cursor = ''; });
}
