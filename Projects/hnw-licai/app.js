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

// 构建 uid 索引
(function buildIndex(node, parentUid) {
  nodeIndex.set(node.uid, node);
  if (parentUid) parentMap.set(node.uid, parentUid);
  orderList.push(node.uid);
  node.children.forEach(c => buildIndex(c, node.uid));
})(TREE, null);

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
