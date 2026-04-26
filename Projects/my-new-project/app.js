// ===== 全局可变状态(依赖 storage.js 中的 TREE) =====
const nodeIndex = new Map();   // uid -> node
const parentMap = new Map();   // uid -> parentUid
const orderList = [];          // 扁平遍历顺序

let CURRENT = TREE.uid;
let HOTSPOTS_VISIBLE = true;

// 渲染顶部标题 + 副标题
(function applyMeta() {
  const t = document.getElementById('project-title');
  const s = document.getElementById('project-sub');
  if (t && META.title) t.textContent = META.title;
  if (s) {
    let nodeN = 0, shotN = 0, reqN = 0;
    (function count(n) {
      nodeN++;
      if (n.image) shotN++;
      if (n.note && /要求/.test(n.note)) reqN++;
      n.children.forEach(count);
    })(TREE);
    const parts = [`${nodeN} 节点`, `${shotN} 截图`];
    if (reqN) parts.push(`${reqN} 项要求`);
    s.textContent = META.sub || parts.join(' · ');
  }
  if (META.title && document.title) document.title = META.title + ' · MindDeck';
})();

// 构建 uid 索引（可重建，因层级覆盖会重组 TREE）
function rebuildIndex() {
  nodeIndex.clear();
  parentMap.clear();
  orderList.length = 0;
  (function walk(node, parentUid) {
    nodeIndex.set(node.uid, node);
    if (parentUid) parentMap.set(node.uid, parentUid);
    orderList.push(node.uid);
    node.children.forEach(c => walk(c, node.uid));
  })(TREE, null);
}
rebuildIndex();

// 3 选 1 删除确认
function confirmDeleteNode(node) {
  const kidCount = countDescendants(node);
  if (!kidCount) {
    return Promise.resolve(confirm(`删除 "${node.title}"？`) ? { ok: true, withChildren: true } : { ok: false });
  }
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-1);color:var(--fg);padding:18px 20px;border-radius:8px;border:1px solid var(--line);min-width:320px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,0.4)';
    box.innerHTML = `
      <div style="font-size:14px;font-weight:600;margin-bottom:10px">删除 "${escapeHtml(node.title)}"</div>
      <div style="font-size:12px;color:var(--fg-dim);margin-bottom:16px;line-height:1.6">该节点下有 ${kidCount} 个子孙节点。</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button data-act="keep" style="padding:8px 12px;border:1px solid var(--accent);background:transparent;color:var(--fg);border-radius:6px;cursor:pointer;text-align:left">仅删除本节点<div style="font-size:11px;color:var(--fg-dim);margin-top:2px">子孙节点上挂到父级</div></button>
        <button data-act="cascade" style="padding:8px 12px;border:1px solid #d44;background:transparent;color:var(--fg);border-radius:6px;cursor:pointer;text-align:left">整棵子树删除<div style="font-size:11px;color:var(--fg-dim);margin-top:2px">连同 ${kidCount} 个子孙一并移除</div></button>
        <button data-act="cancel" style="padding:8px 12px;border:1px solid var(--line);background:transparent;color:var(--fg-dim);border-radius:6px;cursor:pointer">取消</button>
      </div>
    `;
    box.addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      mask.remove();
      if (act === 'keep') resolve({ ok: true, withChildren: false });
      else if (act === 'cascade') resolve({ ok: true, withChildren: true });
      else resolve({ ok: false });
    });
    mask.addEventListener('click', e => { if (e.target === mask) { mask.remove(); resolve({ ok: false }); } });
    mask.appendChild(box);
    document.body.appendChild(mask);
  });
}

function performDeleteNode(node, withChildren) {
  const overrides = loadTreeOverrides();
  const parentUid = parentMap.get(node.uid);
  const parent = parentUid ? nodeIndex.get(parentUid) : TREE;
  const newParentUidForKids = parent === TREE ? null : parent.uid;

  if (!withChildren) {
    for (const c of [...node.children]) {
      const addEntry = overrides.adds.find(a => a.uid === c.uid);
      if (addEntry) addEntry.parentUid = newParentUidForKids;
      else overrides.moves[c.uid] = newParentUidForKids;
      const idx = node.children.indexOf(c);
      if (idx >= 0) node.children.splice(idx, 1);
      parent.children.push(c);
    }
  } else {
    const subtreeUids = new Set();
    (function collect(n) { subtreeUids.add(n.uid); n.children.forEach(collect); })(node);
    overrides.adds = overrides.adds.filter(a => !subtreeUids.has(a.uid));
    for (const k of Object.keys(overrides.moves)) {
      if (subtreeUids.has(k)) delete overrides.moves[k];
    }
  }

  const wasAdd = overrides.adds.some(a => a.uid === node.uid);
  if (wasAdd) overrides.adds = overrides.adds.filter(a => a.uid !== node.uid);
  else if (!overrides.deletes.includes(node.uid)) overrides.deletes.push(node.uid);
  delete overrides.moves[node.uid];

  const idx = parent.children.indexOf(node);
  if (idx >= 0) parent.children.splice(idx, 1);

  saveTreeOverrides(overrides);
  recomputeDepths(TREE, 0);
  rebuildIndex();
}

// 新增热点画框模式
function enterAddHotspotMode() {
  const node = nodeIndex.get(CURRENT);
  if (!node || !node.image) {
    showToast('当前节点无截图，无法添加热点');
    return;
  }
  const screen = document.querySelector('.device-screen');
  if (!screen) return;
  showToast('在截图上拖框确定热点区域 · Esc 取消', 5000);
  screen.classList.add('add-hotspot-mode');
  let startX = 0, startY = 0, drawing = false;
  const overlay = document.createElement('div');
  overlay.className = 'add-hotspot-rect';
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    screen.classList.remove('add-hotspot-mode');
    overlay.remove();
    screen.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') cleanup(); }
  function onDown(e) {
    if (e.target.closest('.hotspot') || e.target.closest('.comment-pin')) return;
    e.preventDefault();
    drawing = true;
    const rect = screen.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    overlay.style.cssText = `position:absolute;left:${startX}px;top:${startY}px;width:0;height:0;border:2px dashed var(--accent);background:color-mix(in oklch,var(--accent) 18%,transparent);pointer-events:none;z-index:10`;
    screen.appendChild(overlay);
  }
  function onMove(e) {
    if (!drawing) return;
    const rect = screen.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const l = Math.min(startX, x), t = Math.min(startY, y);
    const w = Math.abs(x - startX), h = Math.abs(y - startY);
    overlay.style.left = l + 'px';
    overlay.style.top = t + 'px';
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
  }
  function onUp(e) {
    if (!drawing) { cleanup(); return; }
    drawing = false;
    const rect = screen.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const l = Math.min(startX, x), t = Math.min(startY, y);
    const w = Math.abs(x - startX), h = Math.abs(y - startY);
    if (w < 8 || h < 8) { showToast('框选区域太小，已取消'); cleanup(); return; }
    const xPct = l / rect.width * 100;
    const yPct = t / rect.height * 100;
    const wPct = w / rect.width * 100;
    const hPct = h / rect.height * 100;
    const title = window.prompt('新页面标题：', '新页面');
    if (!title || !title.trim()) { cleanup(); return; }
    const newUid = newCustomUid();
    const overrides = loadTreeOverrides();
    overrides.adds.push({ uid: newUid, parentUid: node.uid, title: title.trim(), image: null });
    saveTreeOverrides(overrides);
    const newNode = {
      uid: newUid, depth: node.depth + 1,
      title: title.trim(), rawTitle: title.trim(),
      note: null, image: null, description: null, tables: null, nav_targets: null,
      children: [],
    };
    node.children.push(newNode);
    saveHotspotPosition(node.uid, newUid, { xPct, yPct, wPct, hPct, manual: true });
    rebuildIndex();
    renderTree();
    renderScreen(node);
    renderInspector(node);
    showToast(`已新增热点 "${title.trim()}"`);
    cleanup();
  }
  screen.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey);
}

// ===== 工具函数 =====
function getPath(uid) {
  const path = [];
  let cur = uid;
  while (cur) {
    path.unshift(nodeIndex.get(cur));
    cur = parentMap.get(cur);
  }
  return path;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ===== 节点选择 =====
function selectNode(uid) {
  const node = nodeIndex.get(uid);
  if (!node) return;
  CURRENT = uid;

  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.dataset.uid === uid);
  });
  // 展开所有祖先
  getPath(uid).slice(0, -1).forEach(a => {
    const el = document.querySelector(`.tree-item[data-uid="${a.uid}"]`);
    if (el) {
      el.classList.remove('collapsed');
      const next = el.nextElementSibling;
      if (next) next.classList.remove('hidden');
    }
  });
  // 滚动到可见
  const activeEl = document.querySelector(`.tree-item[data-uid="${uid}"]`);
  if (activeEl) {
    const rect = activeEl.getBoundingClientRect();
    const containerRect = document.getElementById('tree').getBoundingClientRect();
    if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
      activeEl.scrollIntoView({ block: 'center' });
    }
  }

  renderCrumb(node);
  renderScreen(node);
  renderInspector(node);

  try { localStorage.setItem(LS_PREFIX + 'current', uid); } catch {}
}

// ===== 搜索 =====
function setupSearch() {
  const input = document.getElementById('search');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('.tree-item').forEach(el => {
      const node = nodeIndex.get(el.dataset.uid);
      if (!node) return;
      const hit = !q || node.title.toLowerCase().includes(q);
      el.style.display = hit ? '' : 'none';
      if (hit && q) {
        getPath(node.uid).slice(0, -1).forEach(a => {
          const ael = document.querySelector(`.tree-item[data-uid="${a.uid}"]`);
          if (ael) {
            ael.style.display = '';
            const wrap = ael.nextElementSibling;
            if (wrap) wrap.classList.remove('hidden');
          }
        });
      }
    });
  });
}

// ===== 工具条按钮 =====
function setupToolbar() {
  document.getElementById('btn-autolocate').addEventListener('click', autolocateCurrent);
  document.getElementById('btn-autolocate-all').addEventListener('click', autolocateAll);
  const btnAdd = document.getElementById('btn-add-hotspot');
  if (btnAdd) btnAdd.addEventListener('click', enterAddHotspotMode);
  document.getElementById('btn-hotspots').addEventListener('click', (e) => {
    HOTSPOTS_VISIBLE = !HOTSPOTS_VISIBLE;
    document.getElementById('stage').classList.toggle('hotspots-hidden', !HOTSPOTS_VISIBLE);
    e.currentTarget.classList.toggle('active', HOTSPOTS_VISIBLE);
  });
  document.getElementById('btn-hotspots').classList.add('active');

  document.getElementById('btn-comment-mode').addEventListener('click', (e) => {
    COMMENT_MODE = !COMMENT_MODE;
    e.currentTarget.classList.toggle('active', COMMENT_MODE);
    const node = nodeIndex.get(CURRENT);
    if (node) renderScreen(node);
  });
  document.getElementById('btn-comment-list').addEventListener('click', openCommentListPanel);
  updateCommentBadge();

  document.getElementById('btn-export').addEventListener('click', openExportDialog);
  document.getElementById('btn-import').addEventListener('click', openImportDialog);

  document.getElementById('btn-parent').addEventListener('click', () => {
    const p = parentMap.get(CURRENT);
    if (p) selectNode(p);
  });
  document.getElementById('btn-prev').addEventListener('click', () => {
    const idx = orderList.indexOf(CURRENT);
    if (idx > 0) selectNode(orderList[idx - 1]);
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    const idx = orderList.indexOf(CURRENT);
    if (idx < orderList.length - 1) selectNode(orderList[idx + 1]);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft')  document.getElementById('btn-prev').click();
    else if (e.key === 'ArrowRight') document.getElementById('btn-next').click();
    else if (e.key === 'ArrowUp') document.getElementById('btn-parent').click();
    else if (e.key === 'h' || e.key === 'H') document.getElementById('btn-hotspots').click();
    else if (e.key === 'c' || e.key === 'C') document.getElementById('btn-comment-mode').click();
    else if (e.key === 'Escape') closeAllPopovers();
  });
}

// ===== 初始化 =====
renderTree();
setupSearch();
setupToolbar();

const restored = (() => {
  try { return localStorage.getItem(LS_PREFIX + 'current'); } catch { return null; }
})();
selectNode(restored && nodeIndex.has(restored) ? restored : TREE.uid);
