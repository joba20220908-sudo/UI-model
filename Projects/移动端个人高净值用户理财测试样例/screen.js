// ===== 屏幕渲染 =====
async function renderScreen(node) {
  cleanupCandidates();
  const screen = document.getElementById('screen');
  screen.innerHTML = '';

  const url = await resolveNodeImageUrl(node);
  if (url) {
    const wrap = document.createElement('div');
    wrap.className = 'shot-wrap';
    wrap.style.cssText = 'position:relative;width:100%;';
    const img = document.createElement('img');
    img.className = 'shot';
    img.style.cssText = 'width:100%;display:block;';
    img.src = url;
    img.onerror = () => {
      screen.innerHTML = '';
      screen.appendChild(buildPlaceholder(node));
      addHotspots(screen, node);
    };
    wrap.appendChild(img);
    screen.appendChild(wrap);
    addHotspots(wrap, node);
    addComments(wrap, node);
  } else {
    screen.appendChild(buildPlaceholder(node));
    addHotspots(screen, node);
    addComments(screen, node);
  }
}

function buildPlaceholder(node) {
  const ph = document.createElement('div');
  ph.className = 'screenshot-ph';
  const path = getPath(node.uid);
  ph.innerHTML = `
    <span class="ph-label">${node.image ? '截图待上传' : '结构节点(无截图)'}</span>
    <div class="ph-title">${escapeHtml(node.title)}</div>
    <div class="ph-path">${path.map(p => escapeHtml(p.title)).join(' › ')}</div>
    ${node.image ? `<div class="ph-filename">${node.image}</div>` : ''}
  `;
  return ph;
}

// ===== 面包屑 =====
function renderCrumb(node) {
  const crumb = document.getElementById('crumb');
  const path = getPath(node.uid);
  crumb.innerHTML = path.map((p, i) => {
    const isLast = i === path.length - 1;
    const cls = isLast ? 'cur' : '';
    return `<span class="${cls}" data-uid="${p.uid}" style="cursor:pointer">${escapeHtml(p.title)}</span>`;
  }).join('<span class="sep">›</span>');
  crumb.querySelectorAll('[data-uid]').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.uid));
  });
}

// ===== 右侧面板 =====
function renderInspector(node) {
  const path = getPath(node.uid);
  document.getElementById('ins-kicker').textContent =
    path.length === 1 ? '根节点' : path.slice(0, -1).map(p => p.title).join(' › ');
  document.getElementById('ins-title').textContent = node.title;

  const body = document.getElementById('ins-body');
  body.innerHTML = '';

  // 截图操作
  const overrides = loadImgOverrides();
  const ov = overrides[node.uid];
  const hasOriginal = !!node.image;
  const hasOverride = !!(ov && ov.blobKey);
  const sec0 = document.createElement('div');
  sec0.className = 'ins-section img-actions';
  const status = hasOverride
    ? `<span class="img-status ovr">用户上传 · ${escapeHtml(ov.fileName || '')}</span>`
    : (hasOriginal
        ? `<span class="img-status orig">原始截图</span>`
        : `<span class="img-status none">无截图</span>`);
  sec0.innerHTML = `
    <div class="ins-label">截图 ${status}</div>
    <div class="img-btns">
      <button class="img-btn primary" data-act="upload">${hasOriginal || hasOverride ? '🖼️ 替换截图' : '⬆️ 上传截图'}</button>
      ${hasOverride ? `<button class="img-btn" data-act="revert">↶ 还原</button>` : ''}
    </div>
    <input type="file" accept="image/*" class="img-file-input" hidden>
  `;
  body.appendChild(sec0);

  const fileInput = sec0.querySelector('.img-file-input');
  sec0.querySelector('[data-act="upload"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      await uploadNodeImage(node, f);
      renderTree();
      document.querySelectorAll('.tree-item').forEach(el => el.classList.toggle('active', el.dataset.uid === node.uid));
      await renderScreen(node);
      renderInspector(node);
    } catch (err) {
      alert('上传失败:' + err.message);
    }
  });
  const revertBtn = sec0.querySelector('[data-act="revert"]');
  if (revertBtn) {
    revertBtn.addEventListener('click', async () => {
      if (!confirm('还原为原始截图(或清除上传)?')) return;
      await clearNodeImageOverride(node);
      renderTree();
      document.querySelectorAll('.tree-item').forEach(el => el.classList.toggle('active', el.dataset.uid === node.uid));
      await renderScreen(node);
      renderInspector(node);
    });
  }

  // 要求 / 注
  if (node.note) {
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    const isReq = /^要求/.test(node.note);
    sec.innerHTML = `
      <div class="ins-label">${isReq ? '设计要求' : '备注'} <span class="tag">${isReq ? 'REQ' : 'NOTE'}</span></div>
      <div class="ins-note">${escapeHtml(node.note)}</div>
    `;
    body.appendChild(sec);
  }

  // 子页面列表
  if (node.children.length) {
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    sec.innerHTML = `<div class="ins-label">子页面 · ${node.children.length}</div>`;
    const list = document.createElement('div');
    list.className = 'children-list';
    node.children.forEach(c => {
      const link = document.createElement('div');
      link.className = 'child-link' + (nodeHasImage(c) ? ' has-img' : '');
      link.innerHTML = `
        <span class="dot"></span>
        <span>${escapeHtml(c.title)}</span>
        <span class="arr">→</span>
      `;
      link.addEventListener('click', () => selectNode(c.uid));
      list.appendChild(link);
    });
    sec.appendChild(list);
    body.appendChild(sec);
  }

  // 评论列表
  const comments = getNodeComments(node.uid);
  if (comments.length) {
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    const open = comments.filter(c => c.status === 'open').length;
    sec.innerHTML = `<div class="ins-label">评论 · ${comments.length}${open ? ` <span class="tag">${open} 未解决</span>` : ''}</div>`;
    const list = document.createElement('div');
    list.className = 'cmt-list';
    comments.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'cmt-row' + (c.status === 'resolved' ? ' resolved' : '');
      row.innerHTML = `
        <span class="cmt-num">${i + 1}</span>
        <div class="cmt-body">
          <div class="cmt-text">${escapeHtml(c.text)}</div>
          <div class="cmt-meta">${new Date(c.createdAt).toLocaleString('zh-CN')}${c.status === 'resolved' ? ' · ✓ 已解决' : ''}</div>
        </div>
      `;
      row.addEventListener('click', () => {
        const pin = document.querySelector(`.comment-pin[data-id="${c.id}"]`);
        if (pin) {
          pin.scrollIntoView({ block: 'center', behavior: 'smooth' });
          pin.classList.add('flash');
          setTimeout(() => pin.classList.remove('flash'), 1200);
          pin.click();
        }
      });
      list.appendChild(row);
    });
    sec.appendChild(list);
    body.appendChild(sec);
  }

  // 元信息
  const meta = document.createElement('div');
  meta.className = 'ins-section';
  meta.innerHTML = `
    <div class="ins-label">元信息</div>
    <div class="ins-meta">
      <div class="row"><span class="k">层级</span><span class="v">L${node.depth}</span></div>
      <div class="row"><span class="k">子节点</span><span class="v">${node.children.length}</span></div>
      <div class="row"><span class="k">截图</span><span class="v">${node.image ? '✓ ' + node.image.slice(0, 8) + '...' : '—'}</span></div>
    </div>
  `;
  body.appendChild(meta);

  if (!node.note && !node.children.length && !node.image) {
    const hint = document.createElement('div');
    hint.className = 'empty-note';
    hint.textContent = '该节点暂无额外说明。';
    body.insertBefore(hint, meta);
  }
}
