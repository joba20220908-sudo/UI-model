// ===== 大纲树渲染 =====
function renderTree() {
  const container = document.getElementById('tree');
  container.innerHTML = '';
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

    item.addEventListener('click', (e) => {
      if (e.target === chev && hasKids) {
        item.classList.toggle('collapsed');
        const childWrap = item.nextElementSibling;
        if (childWrap) childWrap.classList.toggle('hidden');
        return;
      }
      selectNode(node.uid);
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
