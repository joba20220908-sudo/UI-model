// ===== 评论 UI =====
let COMMENT_MODE = false;

// ===== 评论 pin 渲染 + 新建 =====
function addComments(wrap, node) {
  const list = getNodeComments(node.uid);
  list.forEach((c, i) => {
    const pin = document.createElement('div');
    pin.className = 'comment-pin' + (c.status === 'resolved' ? ' resolved' : '');
    pin.dataset.id = c.id;
    pin.style.cssText = `position:absolute;left:${c.xPct}%;top:${c.yPct}%;`;
    pin.textContent = i + 1;
    pin.title = c.text.slice(0, 80) + (c.text.length > 80 ? '…' : '');
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      openCommentPopover(wrap, node, c, pin);
    });
    wrap.appendChild(pin);
  });

  if (COMMENT_MODE) {
    wrap.classList.add('comment-mode');
    wrap.addEventListener('click', onWrapClickForNew);
    wrap._commentNode = node;
  }
}

function onWrapClickForNew(e) {
  if (e.target.closest('.comment-pin') || e.target.closest('.hotspot') || e.target.closest('.comment-popover')) return;
  const wrap = e.currentTarget;
  const node = wrap._commentNode;
  if (!node) return;
  const r = wrap.getBoundingClientRect();
  const xPct = (e.clientX - r.left) / r.width * 100;
  const yPct = (e.clientY - r.top) / r.height * 100;
  e.stopPropagation();
  openCommentComposer(wrap, node, xPct, yPct, e.clientX, e.clientY);
}

// ===== popover 基础能力:挂到 body / 定位锚点 / 拖动 =====
function makeDraggable(pop, handle) {
  let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.pv-btn') || e.target.tagName === 'INPUT') return;
    dragging = true;
    const r = pop.getBoundingClientRect();
    originX = r.left; originY = r.top;
    startX = e.clientX; startY = e.clientY;
    pop.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let nx = originX + (e.clientX - startX);
    let ny = originY + (e.clientY - startY);
    const r = pop.getBoundingClientRect();
    nx = Math.max(4, Math.min(window.innerWidth  - r.width  - 4, nx));
    ny = Math.max(4, Math.min(window.innerHeight - r.height - 4, ny));
    pop.style.left = nx + 'px';
    pop.style.top  = ny + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; pop.classList.remove('dragging'); }
  });
}

function positionPopover(pop, anchorPxX, anchorPxY) {
  pop.style.visibility = 'hidden';
  const r = pop.getBoundingClientRect();
  const PAD = 8;
  let x = anchorPxX - r.width / 2;
  let y = anchorPxY + 14;
  if (x + r.width > window.innerWidth  - PAD) x = window.innerWidth  - r.width  - PAD;
  if (x < PAD) x = PAD;
  if (y + r.height > window.innerHeight - PAD) y = anchorPxY - r.height - 14;
  if (y < PAD) y = PAD;
  pop.style.left = x + 'px';
  pop.style.top  = y + 'px';
  pop.style.visibility = '';
}

// 新建评论浮层
function openCommentComposer(wrap, node, xPct, yPct, anchorPxX, anchorPxY) {
  closeAllPopovers();
  const pop = document.createElement('div');
  pop.className = 'comment-popover composer floating';
  pop.innerHTML = `
    <div class="pop-head">
      <span class="pop-title">新增评论</span>
      <span class="pop-drag-hint">拖动移动</span>
    </div>
    <textarea placeholder="写一条评论… (Cmd/Ctrl+Enter 保存)" rows="3"></textarea>
    <div class="popover-btns">
      <button class="pv-btn ghost" data-act="cancel">取消</button>
      <button class="pv-btn primary" data-act="save">保存</button>
    </div>
  `;
  document.body.appendChild(pop);
  positionPopover(pop, anchorPxX, anchorPxY);
  makeDraggable(pop, pop.querySelector('.pop-head'));
  ['mousedown', 'click', 'pointerdown'].forEach(ev => {
    pop.addEventListener(ev, e => e.stopPropagation());
  });
  const ta = pop.querySelector('textarea');
  ta.focus();
  pop.querySelector('[data-act="cancel"]').addEventListener('click', () => pop.remove());
  pop.querySelector('[data-act="save"]').addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    addComment(node.uid, xPct, yPct, text);
    pop.remove();
    renderScreen(node);
    renderInspector(node);
    updateCommentBadge();
    renderTree();
    document.querySelectorAll('.tree-item').forEach(el => el.classList.toggle('active', el.dataset.uid === node.uid));
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') pop.querySelector('[data-act="save"]').click();
    if (e.key === 'Escape') pop.remove();
  });
}

// 查看/编辑已有评论
function openCommentPopover(wrap, node, c, pin) {
  closeAllPopovers();
  const pop = document.createElement('div');
  pop.className = 'comment-popover floating';
  pop.innerHTML = `
    <div class="pop-head">
      <span class="pop-title">评论 · ${c.status === 'resolved' ? '已解决' : '未解决'}</span>
      <span class="pop-drag-hint">拖动移动</span>
    </div>
    <textarea rows="3"></textarea>
    <div class="popover-meta">${new Date(c.createdAt).toLocaleString('zh-CN')}</div>
    <div class="popover-btns">
      <button class="pv-btn ghost" data-act="delete">删除</button>
      <button class="pv-btn ghost" data-act="toggle">${c.status === 'resolved' ? '重新打开' : '标为已解决'}</button>
      <button class="pv-btn primary" data-act="save">保存</button>
    </div>
  `;
  document.body.appendChild(pop);
  const pinRect = pin.getBoundingClientRect();
  positionPopover(pop, pinRect.left + pinRect.width / 2, pinRect.top + pinRect.height);
  makeDraggable(pop, pop.querySelector('.pop-head'));
  ['mousedown', 'click', 'pointerdown'].forEach(ev => {
    pop.addEventListener(ev, e => e.stopPropagation());
  });
  const ta = pop.querySelector('textarea');
  ta.value = c.text;
  ta.focus();
  pop.querySelector('[data-act="save"]').addEventListener('click', () => {
    const t = ta.value.trim();
    if (!t) return;
    updateComment(node.uid, c.id, { text: t });
    pop.remove();
    renderScreen(node); renderInspector(node);
  });
  pop.querySelector('[data-act="toggle"]').addEventListener('click', () => {
    updateComment(node.uid, c.id, { status: c.status === 'resolved' ? 'open' : 'resolved' });
    pop.remove();
    renderScreen(node); renderInspector(node); updateCommentBadge(); renderTree();
    document.querySelectorAll('.tree-item').forEach(el => el.classList.toggle('active', el.dataset.uid === node.uid));
  });
  pop.querySelector('[data-act="delete"]').addEventListener('click', () => {
    if (!confirm('确定删除这条评论?')) return;
    deleteComment(node.uid, c.id);
    pop.remove();
    renderScreen(node); renderInspector(node); updateCommentBadge(); renderTree();
    document.querySelectorAll('.tree-item').forEach(el => el.classList.toggle('active', el.dataset.uid === node.uid));
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') pop.querySelector('[data-act="save"]').click();
    if (e.key === 'Escape') pop.remove();
  });
}

function closeAllPopovers() {
  document.querySelectorAll('.comment-popover').forEach(p => p.remove());
}

// 点屏幕其它位置关闭 popover
document.addEventListener('click', (e) => {
  if (!e.target.closest('.comment-popover') && !e.target.closest('.comment-pin')) {
    closeAllPopovers();
  }
});

// 工具栏评论徽章
function updateCommentBadge() {
  const el = document.getElementById('comment-badge');
  if (!el) return;
  const n = countOpenComments();
  if (n > 0) { el.textContent = n; el.classList.add('on'); }
  else { el.textContent = ''; el.classList.remove('on'); }
}

// 全局评论列表面板
function openCommentListPanel() {
  closeAllPopovers();
  document.querySelectorAll('.cmt-list-panel').forEach(p => p.remove());
  const all = loadComments();
  const entries = [];
  for (const uid in all) {
    const node = nodeIndex.get(uid);
    if (!node) continue;
    all[uid].forEach(c => entries.push({ node, c }));
  }
  entries.sort((a, b) => (a.c.status === b.c.status ? b.c.updatedAt - a.c.updatedAt : a.c.status === 'open' ? -1 : 1));

  const panel = document.createElement('div');
  panel.className = 'cmt-list-panel';
  panel.innerHTML = `
    <div class="cmt-panel-header">
      <span class="cmt-panel-title">全部评论 · ${entries.length}</span>
      <div class="cmt-panel-filter">
        <label><input type="radio" name="cflt" value="open" checked> 未解决</label>
        <label><input type="radio" name="cflt" value="all"> 全部</label>
      </div>
      <button class="cmt-panel-close" title="关闭">✕</button>
    </div>
    <div class="cmt-panel-body"></div>
  `;
  document.body.appendChild(panel);
  const body = panel.querySelector('.cmt-panel-body');

  function render() {
    const f = panel.querySelector('input[name="cflt"]:checked').value;
    const shown = f === 'open' ? entries.filter(e => e.c.status === 'open') : entries;
    if (!shown.length) {
      body.innerHTML = '<div class="cmt-empty">暂无评论</div>';
      return;
    }
    body.innerHTML = '';
    shown.forEach(({ node, c }) => {
      const row = document.createElement('div');
      row.className = 'cmt-row global' + (c.status === 'resolved' ? ' resolved' : '');
      row.innerHTML = `
        <div class="cmt-body">
          <div class="cmt-page">${escapeHtml(node.title)}</div>
          <div class="cmt-text">${escapeHtml(c.text)}</div>
          <div class="cmt-meta">${new Date(c.createdAt).toLocaleString('zh-CN')}${c.status === 'resolved' ? ' · ✓ 已解决' : ''}</div>
        </div>
      `;
      row.addEventListener('click', () => {
        panel.remove();
        selectNode(node.uid);
        setTimeout(() => {
          const pin = document.querySelector(`.comment-pin[data-id="${c.id}"]`);
          if (pin) {
            pin.scrollIntoView({ block: 'center', behavior: 'smooth' });
            pin.classList.add('flash');
            setTimeout(() => pin.classList.remove('flash'), 1200);
          }
        }, 120);
      });
      body.appendChild(row);
    });
  }

  panel.querySelectorAll('input[name="cflt"]').forEach(r => r.addEventListener('change', render));
  panel.querySelector('.cmt-panel-close').addEventListener('click', () => panel.remove());
  render();
}
