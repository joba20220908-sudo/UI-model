// ===== 大纲树渲染 =====
function renderTree() {
  const container = document.getElementById('tree');
  container.innerHTML = '';
  // 顶部：层级调整 banner
  const overrides = loadTreeOverrides();
  const total = hasOverrides(overrides);
  if (total) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:6px 10px;margin:4px 6px 8px;background:color-mix(in oklch,var(--accent) 12%,transparent);border-radius:6px;font-size:11px;display:flex;align-items:center;justify-content:space-between;gap:8px';
    const detail = [];
    if (Object.keys(overrides.moves).length) detail.push(`${Object.keys(overrides.moves).length} 移动`);
    if (overrides.adds.length) detail.push(`${overrides.adds.length} 新增`);
    if (overrides.deletes.length) detail.push(`${overrides.deletes.length} 删除`);
    banner.innerHTML = `<span>已调整 ${detail.join(' · ')}</span><button style="padding:2px 8px;font-size:11px;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:4px;cursor:pointer">↺ 重置</button>`;
    banner.querySelector('button').addEventListener('click', () => {
      if (!confirm('清除所有手动调整（移动/新增/删除），恢复 data.js 原始结构？')) return;
      localStorage.removeItem(TREE_OVERRIDES_KEY);
      location.reload();
    });
    container.appendChild(banner);
  }
  renderTreeNodes(TREE.children, container, 0);
}

function renderTreeNodes(nodes, container, depth) {
  nodes.forEach(node => {
    const hasKids = node.children.length > 0;
    const item = document.createElement('div');
    item.className = 'tree-item' + (nodeHasImage(node) ? ' has-img' : '');
    item.style.paddingLeft = (depth * 14 + 8) + 'px';
    item.dataset.uid = node.uid;

    const chev = document.createElement('span');
    chev.className = 'chev' + (hasKids ? '' : ' empty');
    chev.textContent = '▼';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.title;
    label.title = node.title;

    item.append(chev, dot, label);

    // 跳转数徽章
    const hotKids = node.children.filter(c => nodeHasImage(c)).length;
    if (hotKids > 0) {
      const hit = document.createElement('span');
      let tier, icon;
      if (hotKids >= 6)      { tier = 'hot-high'; icon = '🔥'; }
      else if (hotKids >= 3) { tier = 'hot-mid';  icon = '↗'; }
      else                   { tier = 'hot-low';  icon = '→'; }
      hit.className = 'hit ' + tier;
      hit.innerHTML = `<span class="hit-icon">${icon}</span><span class="hit-num">${hotKids}</span>`;
      hit.title = `${hotKids} 个跳转` + (hotKids >= 6 ? '(重点关注)' : '');
      item.appendChild(hit);
    }

    // 未解决评论红点
    if (nodeHasOpenComments(node.uid)) {
      const cm = document.createElement('span');
      cm.className = 'cmt-dot';
      cm.title = '有未解决评论';
      item.appendChild(cm);
    }

    // hover 时显示 + / × 操作按钮
    const ops = document.createElement('span');
    ops.className = 'tree-ops';
    ops.innerHTML = `<button class="tree-op-add" title="新增子节点">+</button><button class="tree-op-del" title="删除节点">×</button>`;
    ops.querySelector('.tree-op-add').addEventListener('click', (e) => {
      e.stopPropagation();
      const title = window.prompt('新页面标题：', '新页面');
      if (!title) return;
      const overrides = loadTreeOverrides();
      const newUid = newCustomUid();
      overrides.adds.push({ uid: newUid, parentUid: node.uid, title: title.trim(), image: null });
      saveTreeOverrides(overrides);
      const newNode = {
        uid: newUid, depth: node.depth + 1,
        title: title.trim(), rawTitle: title.trim(),
        note: null, image: null, description: null, tables: null, nav_targets: null,
        children: [],
      };
      node.children.push(newNode);
      rebuildIndex();
      renderTree();
      showToast(`已新增 "${title.trim()}"`);
    });
    ops.querySelector('.tree-op-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const choice = await confirmDeleteNode(node);
      if (!choice.ok) return;
      const parentUid = parentMap.get(node.uid);
      const parent = parentUid ? nodeIndex.get(parentUid) : TREE;
      performDeleteNode(node, choice.withChildren);
      renderTree();
      if (CURRENT === node.uid && parent.uid) selectNode(parent.uid);
      const tag = choice.withChildren ? '及子孙' : '(子孙已上挂)';
      showToast(`已删除 "${node.title}" ${tag}`);
    });
    item.appendChild(ops);

    item.addEventListener('click', (e) => {
      if (e.target === chev && hasKids) {
        item.classList.toggle('collapsed');
        const childWrap = item.nextElementSibling;
        if (childWrap) childWrap.classList.toggle('hidden');
        return;
      }
      selectNode(node.uid);
    });

    // 拖拽重组层级
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/uid', node.uid);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const dragUid = e.dataTransfer.getData('text/uid');
      if (!dragUid || dragUid === node.uid) return;
      const moved = nodeIndex.get(dragUid);
      if (!moved) return;
      if (isInSubtree(moved, node)) {
        showToast('不能挂到自己的后代下');
        return;
      }
      if (node.children.includes(moved)) return;
      const oldParentUid = parentMap.get(dragUid);
      const oldParent = oldParentUid ? nodeIndex.get(oldParentUid) : TREE;
      const idx = oldParent.children.indexOf(moved);
      if (idx >= 0) oldParent.children.splice(idx, 1);
      node.children.push(moved);
      const overrides = loadTreeOverrides();
      overrides.moves[dragUid] = node.uid;
      saveTreeOverrides(overrides);
      recomputeDepths(TREE, 0);
      rebuildIndex();
      renderTree();
      showToast(`"${moved.title}" 已挂到 "${node.title}" 下`);
    });

    container.appendChild(item);

    if (hasKids) {
      const childWrap = document.createElement('div');
      childWrap.className = 'tree-children';
      renderTreeNodes(node.children, childWrap, depth + 1);
      container.appendChild(childWrap);
    }
  });
}
