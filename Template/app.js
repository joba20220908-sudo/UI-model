// ===== 全局状态 =====
const TREE = window.PROTOTYPE_TREE;
const META = window.PROJECT_META || {};
const PROJECT_ID = META.id || 'default';
// 所有 localStorage key 都加项目前缀,避免多项目串数据
const LS_PREFIX = 'proto:' + PROJECT_ID + ':';
const nodeIndex = new Map();   // uid -> node
const parentMap = new Map();   // uid -> parentUid
const orderList = [];          // 扁平遍历顺序,用于 上一个/下一个

// 渲染顶部标题 + 副标题
(function applyMeta() {
  const t = document.getElementById('project-title');
  const s = document.getElementById('project-sub');
  if (t && META.title) t.textContent = META.title;
  if (s) {
    // 自动统计节点数 / 截图数 / 要求数
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

// ===== 树层级覆盖：拖拽移动 / 手动新增 / 手动删除 =====
// Schema: { moves: {uid: newParentUid}, adds: [{uid, parentUid, title, image}], deletes: [uid] }
const TREE_OVERRIDES_KEY = LS_PREFIX + 'tree_overrides_v1';
function loadTreeOverrides() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(TREE_OVERRIDES_KEY) || '{}'); }
  catch { raw = {}; }
  // 兼容旧格式（flat {uid: parentUid}）→ 转成 moves
  if (raw && !raw.moves && !raw.adds && !raw.deletes) {
    const isLegacyFlat = Object.values(raw).every(v => v === null || typeof v === 'string');
    if (isLegacyFlat && Object.keys(raw).length) {
      return { moves: raw, adds: [], deletes: [] };
    }
  }
  return {
    moves: raw.moves || {},
    adds: raw.adds || [],
    deletes: raw.deletes || [],
  };
}
function saveTreeOverrides(o) { localStorage.setItem(TREE_OVERRIDES_KEY, JSON.stringify(o)); }
function hasOverrides(o) {
  o = o || loadTreeOverrides();
  return Object.keys(o.moves).length + o.adds.length + o.deletes.length;
}
function newCustomUid() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}
function isInSubtree(root, candidate) {
  if (root === candidate) return true;
  for (const c of root.children) if (isInSubtree(c, candidate)) return true;
  return false;
}
function recomputeDepths(node, d) {
  node.depth = d;
  node.children.forEach(c => recomputeDepths(c, d + 1));
}
function countDescendants(node) {
  let n = 0;
  node.children.forEach(c => { n += 1 + countDescendants(c); });
  return n;
}

// 3 选 1 删除确认：取消 / 仅删本节点（子节点上挂） / 整棵子树删
// 返回 Promise<{ok: false} | {ok: true, withChildren: bool}>
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
    mask.addEventListener('click', e => {
      if (e.target === mask) { mask.remove(); resolve({ ok: false }); }
    });
    mask.appendChild(box);
    document.body.appendChild(mask);
  });
}

// 实际执行删除：写 override + 内存里摘除/重挂
function performDeleteNode(node, withChildren) {
  const overrides = loadTreeOverrides();
  const parentUid = parentMap.get(node.uid);
  const parent = parentUid ? nodeIndex.get(parentUid) : TREE;
  const newParentUidForKids = parent === TREE ? null : parent.uid;

  if (!withChildren) {
    // 子孙上挂到当前节点的 parent
    for (const c of [...node.children]) {
      // 若 child 本身是 add，更新它在 adds 里的 parentUid（保持 add 语义）
      const addEntry = overrides.adds.find(a => a.uid === c.uid);
      if (addEntry) {
        addEntry.parentUid = newParentUidForKids;
      } else {
        overrides.moves[c.uid] = newParentUidForKids;
      }
      // 内存里直接挂
      const idx = node.children.indexOf(c);
      if (idx >= 0) node.children.splice(idx, 1);
      parent.children.push(c);
    }
  } else {
    // 整棵子树要删 → 把子树里所有 add 节点也从 adds 移除（避免 boot 时复活）
    const subtreeUids = new Set();
    (function collect(n) { subtreeUids.add(n.uid); n.children.forEach(collect); })(node);
    overrides.adds = overrides.adds.filter(a => !subtreeUids.has(a.uid));
    // 也清掉指向子树内的 moves
    for (const k of Object.keys(overrides.moves)) {
      if (subtreeUids.has(k)) delete overrides.moves[k];
    }
  }

  // 当前节点本身：是 add → 从 adds 移除；否则 → 进 deletes
  const wasAdd = overrides.adds.some(a => a.uid === node.uid);
  if (wasAdd) {
    overrides.adds = overrides.adds.filter(a => a.uid !== node.uid);
  } else {
    if (!overrides.deletes.includes(node.uid)) overrides.deletes.push(node.uid);
  }
  delete overrides.moves[node.uid];

  // 内存里把节点从 parent.children 摘掉
  const idx = parent.children.indexOf(node);
  if (idx >= 0) parent.children.splice(idx, 1);

  saveTreeOverrides(overrides);
  recomputeDepths(TREE, 0);
  rebuildIndex();
}
(function applyTreeOverridesAtBoot() {
  const o = loadTreeOverrides();
  if (!hasOverrides(o)) return;
  const u2n = new Map(), u2p = new Map();
  (function walk(n, p) {
    u2n.set(n.uid, n);
    if (p) u2p.set(n.uid, p);
    n.children.forEach(c => walk(c, n));
  })(TREE, null);

  // 顺序: adds → moves → deletes
  // 这样"删除节点 X 但保留子孙挂到父级"的语义可由 moves 把子孙先挪走、再 delete X 实现

  // 1. adds
  for (const a of o.adds) {
    const parent = a.parentUid ? u2n.get(a.parentUid) : TREE;
    if (!parent) continue;
    if (u2n.has(a.uid)) continue;  // 防重复
    const node = {
      uid: a.uid,
      depth: 0,  // recomputeDepths 会重新算
      title: a.title || '新页面',
      rawTitle: a.title || '新页面',
      note: null,
      image: a.image || null,
      description: null,
      tables: null,
      nav_targets: null,
      children: [],
    };
    parent.children.push(node);
    u2n.set(a.uid, node);
    u2p.set(a.uid, parent);
  }

  // 2. moves
  for (const [uid, newParentUid] of Object.entries(o.moves)) {
    const node = u2n.get(uid);
    const newParent = newParentUid ? u2n.get(newParentUid) : TREE;
    if (!node || !newParent || isInSubtree(node, newParent)) continue;
    const oldParent = u2p.get(uid) || TREE;
    const idx = oldParent.children.indexOf(node);
    if (idx >= 0) oldParent.children.splice(idx, 1);
    if (!newParent.children.includes(node)) newParent.children.push(node);
    u2p.set(uid, newParent);
  }

  // 3. deletes（含整个剩余子树）
  for (const uid of o.deletes) {
    const node = u2n.get(uid);
    if (!node) continue;
    const parent = u2p.get(uid) || TREE;
    const idx = parent.children.indexOf(node);
    if (idx >= 0) parent.children.splice(idx, 1);
    (function purge(n) {
      u2n.delete(n.uid);
      u2p.delete(n.uid);
      n.children.forEach(purge);
    })(node);
  }

  recomputeDepths(TREE, 0);
})();

function rebuildIndex() {
  nodeIndex.clear();
  parentMap.clear();
  orderList.length = 0;
  (function buildIndex(node, parentUid) {
    nodeIndex.set(node.uid, node);
    if (parentUid) parentMap.set(node.uid, parentUid);
    orderList.push(node.uid);
    node.children.forEach(c => buildIndex(c, node.uid));
  })(TREE, null);
}
rebuildIndex();

let CURRENT = TREE.uid;
let HOTSPOTS_VISIBLE = true;

// ===== 工具 =====
function getPath(uid) {
  const path = [];
  let cur = uid;
  while (cur) {
    path.unshift(nodeIndex.get(cur));
    cur = parentMap.get(cur);
  }
  return path;
}

// 尝试从 uploads/ 加载真实截图,失败则显示占位符
// 加版本戳避免浏览器缓存早期 404 响应
const SHOT_VER = 'v2';
function imagePath(filename) {
  return filename ? `screenshots/${filename}?${SHOT_VER}` : null;
}

// ===== 图片覆盖层(用户上传/替换的截图) =====
// 存储:
//   localStorage 'proto_img_overrides_v1' = { [nodeUid]: { blobKey, mime, fileName, addedAt, replaced: bool } }
//   IndexedDB  'proto_imgs' / store 'blobs' 按 blobKey -> Blob
// 渲染时:有 override 优先用 override 的 blob URL,否则回落到原 screenshots/ 文件
const IMG_OVERRIDE_KEY = LS_PREFIX + 'img_overrides_v1';
function loadImgOverrides() {
  try { return JSON.parse(localStorage.getItem(IMG_OVERRIDE_KEY) || '{}'); }
  catch { return {}; }
}
function saveImgOverrides(map) {
  localStorage.setItem(IMG_OVERRIDE_KEY, JSON.stringify(map));
}

// ===== IndexedDB 包装 =====
// 按项目分库,避免多项目图片混在一起
const IDB_NAME = 'proto_imgs__' + PROJECT_ID;
const IDB_STORE = 'blobs';
let _idbPromise = null;
function idb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return _idbPromise;
}
async function idbPut(key, blob) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}
async function idbDel(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

// 枚举 IDB 中所有 key(用于完整导出)
async function idbAllEntries() {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    tx.oncomplete = () => {
      const keys = keysReq.result || [];
      const vals = valsReq.result || [];
      const out = [];
      for (let i=0; i<keys.length; i++) out.push({ key: keys[i], blob: vals[i] });
      res(out);
    };
    tx.onerror = () => rej(tx.error);
  });
}

// ===== 导入/导出 =====
const EXPORT_VERSION = 1;

async function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); // data:xxx;base64,...
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function base64ToBlob(dataUrl) {
  const r = await fetch(dataUrl);
  return await r.blob();
}

// 构建导出数据
async function buildExport({ includeImages }) {
  const data = {
    schema: 'minddeck',
    version: EXPORT_VERSION,
    projectId: PROJECT_ID,
    projectTitle: META.title || null,
    exportedAt: new Date().toISOString(),
    includeImages: !!includeImages,
    comments: loadComments(),
    hotspots: loadHotspotPositions(),
    imgOverridesMeta: loadImgOverrides(), // {uid: {blobKey, mime, fileName, addedAt, replaced}}
    review: loadReview(),                 // {uid: {conclusion, updatedAt, updatedBy}}
    current: CURRENT,
    images: {}  // blobKey -> { mime, base64 }  仅 includeImages=true 时填充
  };
  if (includeImages) {
    const all = await idbAllEntries();
    for (const { key, blob } of all) {
      try {
        data.images[key] = {
          mime: blob.type || 'image/png',
          base64: await blobToBase64(blob)
        };
      } catch (err) {
        console.warn('skip blob', key, err);
      }
    }
  }
  return data;
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
}

// 应用导入 — strategy: 'replace'(先清后入) | 'merge-keep'(同 ID 保留本地) | 'merge-overwrite'(同 ID 用导入的)
async function applyImport(data, strategy) {
  if (!data || (data.schema !== 'minddeck' && data.schema !== 'proto-review')) throw new Error('不是有效的 MindDeck 存档文件');
  if (data.version > EXPORT_VERSION) throw new Error(`该存档版本 v${data.version} 比当前工具 v${EXPORT_VERSION} 新,无法导入`);

  // 1. 评论
  const cur = loadComments();
  const inc = data.comments || {};
  let merged;
  if (strategy === 'replace') {
    merged = inc;
  } else {
    merged = { ...cur };
    for (const uid in inc) {
      const localArr = merged[uid] || [];
      const localIds = new Set(localArr.map(c => c.id));
      const keepOverwrite = strategy === 'merge-overwrite';
      const incomingArr = inc[uid];
      if (keepOverwrite) {
        // 按 ID 融合:导入的覆盖本地同 ID,其余保留
        const incIds = new Set(incomingArr.map(c => c.id));
        merged[uid] = [
          ...localArr.filter(c => !incIds.has(c.id)),
          ...incomingArr
        ];
      } else {
        // keep 本地:本地没有的 ID 才加
        merged[uid] = [
          ...localArr,
          ...incomingArr.filter(c => !localIds.has(c.id))
        ];
      }
    }
  }
  saveComments(merged);

  // 1.5 评审结论（按 uid 合并）
  const curRev = loadReview();
  const incRev = data.review || {};
  let mergedRev;
  if (strategy === 'replace') {
    mergedRev = incRev;
  } else if (strategy === 'merge-overwrite') {
    mergedRev = { ...curRev, ...incRev };
  } else {
    mergedRev = { ...curRev };
    for (const uid in incRev) if (!mergedRev[uid]) mergedRev[uid] = incRev[uid];
  }
  saveReview(mergedRev);

  // 2. 热点位置(按 parentUid → childUid 嵌套)
  const curHs = loadHotspotPositions();
  const incHs = data.hotspots || {};
  let mergedHs;
  if (strategy === 'replace') {
    mergedHs = incHs;
  } else if (strategy === 'merge-overwrite') {
    mergedHs = { ...curHs };
    for (const pid in incHs) mergedHs[pid] = { ...(curHs[pid]||{}), ...incHs[pid] };
  } else {
    mergedHs = { ...curHs };
    for (const pid in incHs) mergedHs[pid] = { ...incHs[pid], ...(curHs[pid]||{}) };
  }
  localStorage.setItem(HOTSPOT_STORE_KEY, JSON.stringify(mergedHs));

  // 3. 图片 overrides + Blob(仅 includeImages 时)
  if (data.includeImages && data.images) {
    const curOv = loadImgOverrides();
    const incOv = data.imgOverridesMeta || {};
    let mergedOv;
    if (strategy === 'replace') {
      // 先删除本地所有已存的 blob
      for (const uid in curOv) {
        const bk = curOv[uid] && curOv[uid].blobKey;
        if (bk) { try { await idbDel(bk); } catch {} }
      }
      mergedOv = incOv;
    } else if (strategy === 'merge-overwrite') {
      mergedOv = { ...curOv, ...incOv };
      // 对被覆盖的节点,清掉老 blob
      for (const uid in incOv) {
        if (curOv[uid] && curOv[uid].blobKey && curOv[uid].blobKey !== incOv[uid].blobKey) {
          try { await idbDel(curOv[uid].blobKey); } catch {}
        }
      }
    } else {
      mergedOv = { ...curOv };
      for (const uid in incOv) if (!mergedOv[uid]) mergedOv[uid] = incOv[uid];
    }
    saveImgOverrides(mergedOv);
    // 写入用到的 blob
    const usedKeys = new Set(Object.values(mergedOv).map(o => o && o.blobKey).filter(Boolean));
    for (const bk of usedKeys) {
      if (!data.images[bk]) continue;
      try {
        const blob = await base64ToBlob(data.images[bk].base64);
        await idbPut(bk, blob);
      } catch (err) {
        console.warn('import blob failed', bk, err);
      }
    }
    // 清 URL 缓存,让 resolveNodeImageUrl 重新建 URL
    for (const [k, url] of _blobUrlCache) { URL.revokeObjectURL(url); }
    _blobUrlCache.clear();
  }

  return {
    comments: Object.values(merged).reduce((n, arr) => n + arr.length, 0),
    hotspots: Object.values(mergedHs).reduce((n, o) => n + Object.keys(o||{}).length, 0),
    images: data.includeImages ? Object.keys(data.images||{}).length : 0,
    review: Object.keys(mergedRev || {}).length,
  };
}

// 解析某节点应渲染的图片 URL。优先返回 IDB 中的 blob URL,无则返回文件 URL。
const _blobUrlCache = new Map(); // blobKey -> object URL
async function resolveNodeImageUrl(node) {
  const overrides = loadImgOverrides();
  const ov = overrides[node.uid];
  if (ov && ov.blobKey) {
    if (_blobUrlCache.has(ov.blobKey)) return _blobUrlCache.get(ov.blobKey);
    const blob = await idbGet(ov.blobKey);
    if (blob) {
      const url = URL.createObjectURL(blob);
      _blobUrlCache.set(ov.blobKey, url);
      return url;
    }
  }
  return node.image ? imagePath(node.image) : null;
}

// 节点是否"可被点击查看截图":有原图 OR 有用户上传的 override
function nodeHasImage(node) {
  if (node.image) return true;
  const ov = loadImgOverrides()[node.uid];
  return !!(ov && ov.blobKey);
}

// 上传一张图作为某节点的截图(替换或新增)
async function uploadNodeImage(node, file) {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('请选择图片文件');
  }
  const blobKey = 'img_' + node.uid + '_' + Date.now();
  await idbPut(blobKey, file);
  const overrides = loadImgOverrides();
  // 清掉这个节点上一次的 blob(如有)
  if (overrides[node.uid] && overrides[node.uid].blobKey) {
    try { await idbDel(overrides[node.uid].blobKey); } catch {}
    if (_blobUrlCache.has(overrides[node.uid].blobKey)) {
      URL.revokeObjectURL(_blobUrlCache.get(overrides[node.uid].blobKey));
      _blobUrlCache.delete(overrides[node.uid].blobKey);
    }
  }
  overrides[node.uid] = {
    blobKey,
    mime: file.type,
    fileName: file.name,
    addedAt: Date.now(),
    replaced: !!node.image,  // true=替换原图;false=新增到原本无图节点
  };
  saveImgOverrides(overrides);
}

async function clearNodeImageOverride(node) {
  const overrides = loadImgOverrides();
  const ov = overrides[node.uid];
  if (!ov) return;
  if (ov.blobKey) {
    try { await idbDel(ov.blobKey); } catch {}
    if (_blobUrlCache.has(ov.blobKey)) {
      URL.revokeObjectURL(_blobUrlCache.get(ov.blobKey));
      _blobUrlCache.delete(ov.blobKey);
    }
  }
  delete overrides[node.uid];
  saveImgOverrides(overrides);
}

// ===== 评论系统 =====
// 结构:{ [nodeUid]: [{id, xPct, yPct, text, status, createdAt, updatedAt}, ...] }
const COMMENTS_KEY = LS_PREFIX + 'comments_v1';
let COMMENT_MODE = false;

function loadComments() {
  try { return JSON.parse(localStorage.getItem(COMMENTS_KEY) || '{}'); }
  catch { return {}; }
}
function saveComments(data) {
  localStorage.setItem(COMMENTS_KEY, JSON.stringify(data));
}
function getNodeComments(uid) {
  return loadComments()[uid] || [];
}
function setNodeComments(uid, list) {
  const all = loadComments();
  if (!list || !list.length) delete all[uid];
  else all[uid] = list;
  saveComments(all);
}
function addComment(uid, xPct, yPct, text) {
  const list = getNodeComments(uid);
  const now = Date.now();
  const c = {
    id: 'c_' + now + '_' + Math.random().toString(36).slice(2, 6),
    xPct, yPct,
    text: String(text || '').trim(),
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  list.push(c);
  setNodeComments(uid, list);
  return c;
}
function updateComment(uid, id, patch) {
  const list = getNodeComments(uid);
  const c = list.find(x => x.id === id);
  if (!c) return;
  Object.assign(c, patch, { updatedAt: Date.now() });
  setNodeComments(uid, list);
}
function deleteComment(uid, id) {
  const list = getNodeComments(uid).filter(x => x.id !== id);
  setNodeComments(uid, list);
}
// 全局未解决评论数
function countOpenComments() {
  const all = loadComments();
  let n = 0;
  for (const uid in all) n += (all[uid] || []).filter(c => c.status === 'open').length;
  return n;
}
function nodeHasOpenComments(uid) {
  return getNodeComments(uid).some(c => c.status === 'open');
}
// 评论 kind：'comment'（默认） | 'todo'（待确认事项）
function commentKind(c) { return (c && c.kind) || 'comment'; }
function getNodeTodos(uid) {
  return getNodeComments(uid).filter(c => commentKind(c) === 'todo');
}
function getNodeFreeComments(uid) {
  return getNodeComments(uid).filter(c => commentKind(c) === 'comment');
}

// ===== 评审结论（per-node 整页结论） =====
// 结构：{ [uid]: { conclusion, updatedAt, updatedBy } }
const REVIEW_KEY = LS_PREFIX + 'review_v1';
function loadReview() {
  try { return JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}'); }
  catch { return {}; }
}
function saveReview(data) {
  localStorage.setItem(REVIEW_KEY, JSON.stringify(data || {}));
}
function getNodeReview(uid) {
  return loadReview()[uid] || null;
}
function setNodeReview(uid, conclusion, source) {
  const all = loadReview();
  const text = String(conclusion || '').trim();
  if (!text) {
    delete all[uid];
  } else {
    all[uid] = {
      conclusion: text,
      updatedAt: Date.now(),
      updatedBy: source || 'manual',
    };
  }
  saveReview(all);
}
function countReviewStats() {
  const r = loadReview();
  const all = loadComments();
  let openTodos = 0, resolvedTodos = 0, totalComments = 0;
  for (const uid in all) {
    for (const c of (all[uid] || [])) {
      if (commentKind(c) === 'todo') {
        if (c.status === 'resolved') resolvedTodos++;
        else openTodos++;
      } else {
        totalComments++;
      }
    }
  }
  return {
    pages: Object.keys(r).length,
    conclusions: Object.keys(r).length,
    openTodos, resolvedTodos,
    comments: totalComments,
  };
}

// ===== 大纲树渲染 =====
function renderTree() {
  const container = document.getElementById('tree');
  container.innerHTML = '';
  // 如有手动调整（移动/新增/删除），顶部显示重置按钮
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

    // 跳转数徽章 — 只统计"有截图的直接子节点"(= 真正可跳转的热点数)
    const hotKids = node.children.filter(c => nodeHasImage(c)).length;
    if (hotKids > 0) {
      const hit = document.createElement('span');
      let tier, icon;
      if (hotKids >= 6)       { tier = 'hot-high';  icon = '🔥'; }
      else if (hotKids >= 3)  { tier = 'hot-mid';   icon = '↗'; }
      else                    { tier = 'hot-low';   icon = '→'; }
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
      // 内存里同步插入
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

    // 拖拽重组层级（HTML5 drag-drop）
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
      // 已经是该 parent 的直接子节点 → 无操作
      if (node.children.includes(moved)) return;
      // 1. 从原 parent 摘掉
      const oldParentUid = parentMap.get(dragUid);
      const oldParent = oldParentUid ? nodeIndex.get(oldParentUid) : TREE;
      const idx = oldParent.children.indexOf(moved);
      if (idx >= 0) oldParent.children.splice(idx, 1);
      // 2. 挂到新 parent
      node.children.push(moved);
      // 3. 持久化 override
      const overrides = loadTreeOverrides();
      overrides.moves[dragUid] = node.uid;
      saveTreeOverrides(overrides);
      // 4. 重算 depth + 重建索引 + 重渲染
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

// ===== 屏幕渲染 =====
async function renderScreen(node) {
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

  // 评论模式:点空白处新建
  if (COMMENT_MODE) {
    wrap.classList.add('comment-mode');
    wrap.addEventListener('click', onWrapClickForNew);
    wrap._commentNode = node;
  }
}

function onWrapClickForNew(e) {
  // 仅对 wrap 本身或图片生效;点 pin/热点不触发
  if (e.target.closest('.comment-pin') || e.target.closest('.hotspot') || e.target.closest('.comment-popover')) return;
  const wrap = e.currentTarget;
  const node = wrap._commentNode;
  if (!node) return;
  const r = wrap.getBoundingClientRect();
  const xPct = (e.clientX - r.left) / r.width * 100;
  const yPct = (e.clientY - r.top) / r.height * 100;
  // 阻止 document 级的 "点外部关闭" 监听把刚创建的 composer 立即干掉
  e.stopPropagation();
  openCommentComposer(wrap, node, xPct, yPct, e.clientX, e.clientY);
}

// ===== popover 基础能力:挂到 body / 定位锚点像素 / 拖动 =====
// 给一个 popover DOM 挂上头部拖拽,并在视口内限定。
function makeDraggable(pop, handle) {
  let startX=0, startY=0, originX=0, originY=0, dragging=false;
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
    // 视口夹紧
    const r = pop.getBoundingClientRect();
    nx = Math.max(4, Math.min(window.innerWidth - r.width - 4, nx));
    ny = Math.max(4, Math.min(window.innerHeight - r.height - 4, ny));
    pop.style.left = nx + 'px';
    pop.style.top = ny + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; pop.classList.remove('dragging'); }
  });
}

// 把 popover 定位到屏幕某个坐标(带视口边界修正)
function positionPopover(pop, anchorPxX, anchorPxY) {
  pop.style.visibility = 'hidden';
  const r = pop.getBoundingClientRect();
  const PAD = 8;
  let x = anchorPxX - r.width / 2; // 默认水平居中于锚点
  let y = anchorPxY + 14;           // 默认出现在锚点下方
  // 右边撞墙 -> 贴右
  if (x + r.width > window.innerWidth - PAD) x = window.innerWidth - r.width - PAD;
  // 左边撞墙
  if (x < PAD) x = PAD;
  // 下方撞墙 -> 翻到上方
  if (y + r.height > window.innerHeight - PAD) {
    y = anchorPxY - r.height - 14;
  }
  if (y < PAD) y = PAD;
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  pop.style.visibility = '';
}

// 新建评论的浮层(未保存前不入库)
function openCommentComposer(wrap, node, xPct, yPct, anchorPxX, anchorPxY) {
  closeAllPopovers();
  const pop = document.createElement('div');
  pop.className = 'comment-popover composer floating';
  pop.innerHTML = `
    <div class="pop-head">
      <span class="pop-title">新增评论</span>
      <span class="pop-drag-hint">拖动移动</span>
    </div>
    <div class="kind-tabs" style="display:flex;gap:4px;margin:4px 0 8px">
      <button type="button" class="kind-tab active" data-kind="comment" style="flex:1;padding:4px 8px;font-size:11px;border:1px solid var(--accent-dim);background:color-mix(in oklch,var(--accent) 18%,var(--bg-2));color:var(--fg);border-radius:4px;cursor:pointer">💬 评论</button>
      <button type="button" class="kind-tab" data-kind="todo" style="flex:1;padding:4px 8px;font-size:11px;border:1px solid var(--line);background:var(--bg-2);color:var(--fg-dim);border-radius:4px;cursor:pointer">✅ 待确认事项</button>
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
  ['mousedown','click','pointerdown'].forEach(ev => {
    pop.addEventListener(ev, e => e.stopPropagation());
  });
  const ta = pop.querySelector('textarea');
  ta.focus();
  // kind 切换
  let kind = 'comment';
  pop.querySelectorAll('.kind-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      kind = tab.dataset.kind;
      pop.querySelectorAll('.kind-tab').forEach(t => {
        const active = t.dataset.kind === kind;
        t.classList.toggle('active', active);
        t.style.borderColor = active ? 'var(--accent-dim)' : 'var(--line)';
        t.style.background = active ? 'color-mix(in oklch,var(--accent) 18%,var(--bg-2))' : 'var(--bg-2)';
        t.style.color = active ? 'var(--fg)' : 'var(--fg-dim)';
      });
      ta.placeholder = kind === 'todo' ? '描述待确认事项 (Cmd/Ctrl+Enter 保存)' : '写一条评论… (Cmd/Ctrl+Enter 保存)';
    });
  });
  pop.querySelector('[data-act="cancel"]').addEventListener('click', () => pop.remove());
  pop.querySelector('[data-act="save"]').addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const c = addComment(node.uid, xPct, yPct, text);
    if (kind === 'todo') updateComment(node.uid, c.id, { kind: 'todo' });
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
  positionPopover(pop, pinRect.left + pinRect.width/2, pinRect.top + pinRect.height);
  makeDraggable(pop, pop.querySelector('.pop-head'));
  ['mousedown','click','pointerdown'].forEach(ev => {
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
// 点屏幕其它位置时关掉 popover
document.addEventListener('click', (e) => {
  if (!e.target.closest('.comment-popover') && !e.target.closest('.comment-pin')) {
    closeAllPopovers();
  }
});

// 更新工具栏小徽章
function updateCommentBadge() {
  const el = document.getElementById('comment-badge');
  if (!el) return;
  const n = countOpenComments();
  if (n > 0) { el.textContent = n; el.classList.add('on'); }
  else { el.textContent = ''; el.classList.remove('on'); }
}

// 全局评论列表弹窗:列出所有页面的所有评论,可筛选/跳转
function openCommentListPanel() {
  closeAllPopovers();
  // 关掉已有列表
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
          if (pin) { pin.scrollIntoView({ block: 'center', behavior: 'smooth' }); pin.classList.add('flash'); setTimeout(() => pin.classList.remove('flash'), 1200); }
        }, 120);
      });
      body.appendChild(row);
    });
  }
  panel.querySelectorAll('input[name="cflt"]').forEach(r => r.addEventListener('change', render));
  panel.querySelector('.cmt-panel-close').addEventListener('click', () => panel.remove());
  render();
}

// ===== 热点:可拖拽 + 持久化位置 =====
const HOTSPOT_STORE_KEY = LS_PREFIX + 'hotspots_v1';
function loadHotspotPositions() {
  try { return JSON.parse(localStorage.getItem(HOTSPOT_STORE_KEY) || '{}'); }
  catch { return {}; }
}
function saveHotspotPosition(parentUid, childUid, pos) {
  const store = loadHotspotPositions();
  store[parentUid] = store[parentUid] || {};
  // 合并(保留已有 conf 等元数据,除非调用方显式覆盖)
  const prev = store[parentUid][childUid] || {};
  store[parentUid][childUid] = { ...prev, ...pos };
  localStorage.setItem(HOTSPOT_STORE_KEY, JSON.stringify(store));
}

// 默认位置:如果没有保存过,按序号堆叠在右侧边缘(这样不挡主内容)
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
    if (w < 8 || h < 8) {
      showToast('框选区域太小，已取消');
      cleanup();
      return;
    }
    const xPct = l / rect.width * 100;
    const yPct = t / rect.height * 100;
    const wPct = w / rect.width * 100;
    const hPct = h / rect.height * 100;
    const title = window.prompt('新页面标题：', '新页面');
    if (!title || !title.trim()) { cleanup(); return; }
    const newUid = newCustomUid();
    // 1. 写 add override
    const overrides = loadTreeOverrides();
    overrides.adds.push({ uid: newUid, parentUid: node.uid, title: title.trim(), image: null });
    saveTreeOverrides(overrides);
    // 2. 内存里挂上
    const newNode = {
      uid: newUid, depth: node.depth + 1,
      title: title.trim(), rawTitle: title.trim(),
      note: null, image: null, description: null, tables: null, nav_targets: null,
      children: [],
    };
    node.children.push(newNode);
    // 3. 保存 hotspot 位置（manual=true，避免被 AI 重定位覆盖）
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

function addHotspots(screen, node) {
  const kids = node.children.filter(c => nodeHasImage(c) || c.children.length > 0);
  if (!kids.length) return;

  const store = loadHotspotPositions();
  const saved = store[node.uid] || {};

  kids.forEach((k, i) => {
    const pos = saved[k.uid] || defaultHotspotPos(i, kids.length);
    const btn = document.createElement('div');
    btn.className = 'hotspot';
    // 低置信度(AI 识别结果 < 0.8 且未经人工调整)→ 橙色警示
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

    // 序号徽章
    const badge = document.createElement('span');
    badge.className = 'hotspot-badge';
    badge.textContent = i + 1;
    btn.appendChild(badge);

    // 删除按钮（hover 显示）— 删 child 节点 + 删 hotspot 位置
    const delBtn = document.createElement('span');
    delBtn.className = 'hotspot-del';
    delBtn.textContent = '×';
    delBtn.title = '删除热点（含对应子页面）';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const choice = await confirmDeleteNode(k);
      if (!choice.ok) return;
      // 1. 删 hotspot position
      const store = loadHotspotPositions();
      if (store[node.uid]) {
        delete store[node.uid][k.uid];
        if (!Object.keys(store[node.uid]).length) delete store[node.uid];
        localStorage.setItem(HOTSPOT_STORE_KEY, JSON.stringify(store));
      }
      // 2. 删 child 节点（含子孙处理）
      performDeleteNode(k, choice.withChildren);
      renderTree();
      renderScreen(node);
      renderInspector(node);
      const tag = choice.withChildren ? '及子孙' : '(子孙已上挂)';
      showToast(`已删除热点 "${k.title}" ${tag}`);
    });
    btn.appendChild(delBtn);

    btn.addEventListener('click', (e) => {
      if (btn.dataset.dragging === '1') return;  // drag 刚结束,忽略这次 click
      selectNode(k.uid);
    });

    enableHotspotDrag(btn, screen);
    screen.appendChild(btn);
  });
}

// 拖拽:按住 Shift 拖动调整位置和大小。普通 click 进入子页。
// - Shift + 按住 + 拖动 → 移动
// - Shift + 按住右下角手柄 + 拖动 → 调整尺寸
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

    // 收集场上其它热点的对齐候选线(像素坐标,相对 screen)
    const vLines = [];  // 垂直候选:x 坐标
    const hLines = [];  // 水平候选:y 坐标
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

    // 判断命中区域
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

    const SNAP = 6; // 像素

    // 找离 target 像素最近的候选线;命中返回 {line, diff};否则 null
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

    // 在 screen 下画一条参考线
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

      // 先按原逻辑计算新框位置(像素)
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

      // 尝试吸附:
      // move 模式 → 6 条候选(l/r/cx/t/b/cy)中选最近的 1 条 x + 1 条 y
      // edge-* 模式 → 只吸附对应那一条边
      // resize 模式 → 吸附右边和下边
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

      // 应用最终位置
      btn.style.left = (nl / rect.width * 100) + '%';
      btn.style.top = (nt / rect.height * 100) + '%';
      btn.style.width = (nw / rect.width * 100) + '%';
      btn.style.height = (nh / rect.height * 100) + '%';

      // 画参考线
      if (snapV) {
        const from = Math.min(snapV.from, nt);
        const to = Math.max(snapV.to, nt + nh);
        showGuide('v', snapV.x, from, to);
      }
      if (snapH) {
        const from = Math.min(snapH.from, nl);
        const to = Math.max(snapH.to, nl + nw);
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
        const finalRect = btn.getBoundingClientRect();
        const screenRect = screen.getBoundingClientRect();
        saveHotspotPosition(btn.dataset.parentUid, btn.dataset.childUid, {
          xPct: (finalRect.left - screenRect.left) / screenRect.width * 100,
          yPct: (finalRect.top - screenRect.top) / screenRect.height * 100,
          wPct: finalRect.width / screenRect.width * 100,
          hPct: finalRect.height / screenRect.height * 100,
          manual: true,
        });
        // 人工调整过 → 立刻移除 low-conf 视觉
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

  // ===== 截图操作 =====
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
      // 重渲染:树+屏幕+面板
      renderTree();
      // 重新选中并应用搜索的展开
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

  // 需求描述（Word 路径填充；xmind 路径无）
  if (node.description) {
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    sec.innerHTML = `
      <div class="ins-label">需求描述 <span class="tag">DESC</span></div>
      <div class="ins-note" style="max-height:260px;overflow-y:auto;white-space:pre-wrap;font-size:12px;line-height:1.55">${escapeHtml(node.description)}</div>
    `;
    body.appendChild(sec);
  }

  // 表格（Word 路径填充）
  if (node.tables && node.tables.length) {
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    sec.innerHTML = `<div class="ins-label">表格 · ${node.tables.length}</div>`;
    node.tables.forEach(t => {
      const tbl = document.createElement('table');
      tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;margin-top:6px';
      const thead = (t.headers || []).map(h => `<th style="border:1px solid var(--line);padding:4px 6px;background:var(--bg-2);text-align:left;font-weight:600">${escapeHtml(h)}</th>`).join('');
      const tbody = (t.rows || []).map(r =>
        `<tr>${(r || []).map(c => `<td style="border:1px solid var(--line);padding:4px 6px;vertical-align:top">${escapeHtml(c).replace(/\n/g,'<br>')}</td>`).join('')}</tr>`
      ).join('');
      tbl.innerHTML = `<thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody>`;
      sec.appendChild(tbl);
    });
    body.appendChild(sec);
  }

  // 声明跳转（Word + LLM 抽取填充）
  if (node.nav_targets && node.nav_targets.length) {
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    sec.innerHTML = `<div class="ins-label">声明跳转 · ${node.nav_targets.length} <span class="tag">AI</span></div>`;
    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px';
    node.nav_targets.forEach(nt => {
      const chip = document.createElement('span');
      const clickable = !!nt.uid;
      chip.style.cssText = `padding:3px 8px;border:1px solid var(--line);border-radius:12px;font-size:11px;cursor:${clickable?'pointer':'default'};background:var(--bg-2);${clickable?'':'opacity:0.6'}`;
      chip.textContent = '→ ' + (nt.label || '?');
      if (clickable) chip.addEventListener('click', () => selectNode(nt.uid));
      if (nt.trigger) chip.title = nt.trigger;
      chips.appendChild(chip);
    });
    sec.appendChild(chips);
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

  // ===== 评审结论（per-node 整页结论）=====
  {
    const review = getNodeReview(node.uid);
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    sec.innerHTML = `
      <div class="ins-label">评审结论 <span class="tag" style="background:color-mix(in oklch,var(--accent) 18%,transparent);border-color:var(--accent-dim);color:var(--fg)">REVIEW</span></div>
      <textarea class="review-conclusion" rows="3" placeholder="本页评审结论 / 决议… (Cmd/Ctrl+Enter 保存)" style="width:100%;background:var(--bg-2);border:1px solid var(--line);border-radius:4px;color:var(--fg);font-size:12px;padding:6px 8px;resize:vertical;font-family:inherit;line-height:1.5"></textarea>
      <div class="review-meta" style="margin-top:4px;font-size:10px;color:var(--fg-mute);display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span class="review-status">${review ? `${review.updatedBy === 'import' ? '🤖 ' : ''}更新于 ${new Date(review.updatedAt).toLocaleString('zh-CN')}` : '尚未填写'}</span>
        <span class="review-hint" style="opacity:0.7"></span>
      </div>
    `;
    body.appendChild(sec);
    const ta = sec.querySelector('.review-conclusion');
    const status = sec.querySelector('.review-status');
    const hint = sec.querySelector('.review-hint');
    ta.value = review ? review.conclusion : '';
    let saveTimer;
    const persist = () => {
      const text = ta.value.trim();
      const before = review ? review.conclusion : '';
      if (text === before) return;
      setNodeReview(node.uid, text, 'manual');
      const now = getNodeReview(node.uid);
      status.textContent = now ? `更新于 ${new Date(now.updatedAt).toLocaleString('zh-CN')}` : '尚未填写';
      hint.textContent = '已保存 ✓';
      setTimeout(() => { hint.textContent = ''; }, 1200);
    };
    ta.addEventListener('blur', persist);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        ta.blur();
      }
    });
    ta.addEventListener('input', () => {
      hint.textContent = '编辑中…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 1500);
    });
  }

  // ===== 待确认事项（kind = todo）=====
  const todos = getNodeTodos(node.uid);
  if (todos.length) {
    const sec = document.createElement('div');
    sec.className = 'ins-section';
    const openTodo = todos.filter(c => c.status === 'open').length;
    sec.innerHTML = `<div class="ins-label">待确认事项 · ${todos.length}${openTodo ? ` <span class="tag" style="background:#7a3a00;border-color:#a55;color:#fdc">${openTodo} 待解决</span>` : ` <span class="tag">全部已解决</span>`}</div>`;
    const list = document.createElement('div');
    list.className = 'cmt-list';
    todos.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'cmt-row' + (c.status === 'resolved' ? ' resolved' : '');
      row.innerHTML = `
        <span class="cmt-num">${c.status === 'resolved' ? '✓' : '○'}</span>
        <div class="cmt-body">
          <div class="cmt-text">${escapeHtml(c.text)}</div>
          <div class="cmt-meta">${new Date(c.createdAt).toLocaleString('zh-CN')}${c.status === 'resolved' ? ' · 已解决' : ''}</div>
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

  // 评论列表（kind = comment 或缺省）
  const comments = getNodeFreeComments(node.uid);
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
        // 滚动到对应 pin 并高亮
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

  if (!node.note && !node.children.length && !node.image && !node.description && !(node.tables && node.tables.length) && !(node.nav_targets && node.nav_targets.length)) {
    const hint = document.createElement('div');
    hint.className = 'empty-note';
    hint.textContent = '该节点暂无额外说明。';
    body.insertBefore(hint, meta);
  }
}

// ===== 导入/导出 UI =====
function openExportDialog() {
  closeAllPopovers();
  document.querySelectorAll('.modal-overlay').forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span>导出评审数据</span>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="export-summary" id="export-summary">统计中…</div>
        <label class="opt-row">
          <input type="radio" name="exp-mode" value="light" checked>
          <div>
            <div class="opt-title">轻量(推荐)</div>
            <div class="opt-desc">只含评论、热点位置、图片映射。<b>不包含图片 Blob</b>。体积小,适合多人同步评审结果;接收方需有相同的本地截图文件。</div>
          </div>
        </label>
        <label class="opt-row">
          <input type="radio" name="exp-mode" value="full">
          <div>
            <div class="opt-title">完整归档</div>
            <div class="opt-desc">包含所有上传/替换过的图片 Blob(base64 编码)。<b>体积大</b>(可能十几 MB),但可跨设备完整搬迁。</div>
          </div>
        </label>
      </div>
      <div class="modal-footer">
        <button class="pv-btn ghost" data-act="cancel">取消</button>
        <button class="pv-btn primary" data-act="export">导出下载</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());

  // 统计
  (async () => {
    const c = loadComments();
    const h = loadHotspotPositions();
    const o = loadImgOverrides();
    const cN = Object.values(c).reduce((n, a) => n + a.length, 0);
    const hN = Object.values(h).reduce((n, o) => n + Object.keys(o||{}).length, 0);
    const oN = Object.keys(o).length;
    let idbN = 0;
    try { idbN = (await idbAllEntries()).length; } catch {}
    overlay.querySelector('#export-summary').innerHTML =
      `<b>${cN}</b> 条评论 · <b>${hN}</b> 项热点位置 · <b>${oN}</b> 张替换截图(IDB 中共 ${idbN} 个 Blob)`;
  })();

  overlay.querySelector('[data-act="export"]').addEventListener('click', async () => {
    const mode = overlay.querySelector('input[name="exp-mode"]:checked').value;
    const btn = overlay.querySelector('[data-act="export"]');
    btn.disabled = true; btn.textContent = '打包中…';
    try {
      const data = await buildExport({ includeImages: mode === 'full' });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const suffix = mode === 'full' ? 'full' : 'light';
      const pid = (META.title || PROJECT_ID).replace(/[\s\/\\:]/g, '-');
      downloadJSON(`MindDeck-${pid}-${suffix}-${ts}.json`, data);
      overlay.remove();
    } catch (err) {
      alert('导出失败:' + (err.message || err));
      btn.disabled = false; btn.textContent = '导出下载';
    }
  });
}

function openImportDialog() {
  closeAllPopovers();
  document.querySelectorAll('.modal-overlay').forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span>导入评审数据</span>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="import-drop" id="import-drop">
          <div class="drop-icon">📥</div>
          <div class="drop-hint">点击选择文件,或拖拽 JSON 到这里</div>
          <div class="drop-filename" id="drop-filename">尚未选择</div>
          <input type="file" id="import-file" accept=".json,application/json" hidden>
        </div>
        <div class="import-preview" id="import-preview"></div>
        <div class="opt-group-title">合并策略</div>
        <label class="opt-row compact">
          <input type="radio" name="imp-strategy" value="merge-keep" checked>
          <div>
            <div class="opt-title">合并(保留本地)</div>
            <div class="opt-desc small">同 ID 的评论/热点以<b>本地为准</b>,只把新数据加进来。最安全。</div>
          </div>
        </label>
        <label class="opt-row compact">
          <input type="radio" name="imp-strategy" value="merge-overwrite">
          <div>
            <div class="opt-title">合并(以导入为准)</div>
            <div class="opt-desc small">同 ID 用<b>导入的</b>覆盖本地,本地独有的数据保留。</div>
          </div>
        </label>
        <label class="opt-row compact">
          <input type="radio" name="imp-strategy" value="replace">
          <div>
            <div class="opt-title">全量替换(危险)</div>
            <div class="opt-desc small">清空本地所有评审数据,完全替换为导入内容。<b style="color:#ef4444">不可撤销</b>。</div>
          </div>
        </label>
      </div>
      <div class="modal-footer">
        <button class="pv-btn ghost" data-act="cancel">取消</button>
        <button class="pv-btn primary" data-act="import" disabled>导入</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());

  const drop = overlay.querySelector('#import-drop');
  const fileInput = overlay.querySelector('#import-file');
  const filename = overlay.querySelector('#drop-filename');
  const preview = overlay.querySelector('#import-preview');
  const importBtn = overlay.querySelector('[data-act="import"]');
  let loadedData = null;

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) loadFile(f);
  });

  async function loadFile(file) {
    filename.textContent = file.name + ' (' + (file.size/1024).toFixed(1) + ' KB)';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.schema !== 'minddeck' && data.schema !== 'proto-review') throw new Error('不是 MindDeck 存档格式');
      loadedData = data;
      const cN = Object.values(data.comments||{}).reduce((n,a)=>n+a.length, 0);
      const hN = Object.values(data.hotspots||{}).reduce((n,o)=>n+Object.keys(o||{}).length, 0);
      const iN = Object.keys(data.images||{}).length;
      preview.innerHTML = `
        <div class="preview-ok">✓ 已读取 · v${data.version} · 导出于 ${new Date(data.exportedAt).toLocaleString('zh-CN')}</div>
        <div class="preview-stats">
          <span><b>${cN}</b> 评论</span>
          <span><b>${hN}</b> 热点位置</span>
          <span><b>${Object.keys(data.imgOverridesMeta||{}).length}</b> 截图映射</span>
          ${data.includeImages ? `<span><b>${iN}</b> 图片 Blob</span>` : '<span class="muted">不含图片 Blob</span>'}
        </div>
      `;
      importBtn.disabled = false;
    } catch (err) {
      loadedData = null;
      preview.innerHTML = `<div class="preview-err">✗ 读取失败:${escapeHtml(err.message || String(err))}</div>`;
      importBtn.disabled = true;
    }
  }

  importBtn.addEventListener('click', async () => {
    if (!loadedData) return;
    const strategy = overlay.querySelector('input[name="imp-strategy"]:checked').value;
    if (strategy === 'replace' && !confirm('确认要清空本地所有评审数据,并用导入文件完全替换吗?此操作不可撤销。')) return;
    importBtn.disabled = true; importBtn.textContent = '导入中…';
    try {
      const stats = await applyImport(loadedData, strategy);
      overlay.remove();
      // 刷新视图
      const node = nodeIndex.get(CURRENT);
      if (node) { renderScreen(node); renderInspector(node); }
      renderTree();
      updateCommentBadge();
      showToast(`导入完成 · ${stats.comments} 评论 · ${stats.hotspots} 热点${stats.images ? ' · ' + stats.images + ' 图片' : ''}`);
    } catch (err) {
      alert('导入失败:' + (err.message || err));
      importBtn.disabled = false; importBtn.textContent = '导入';
    }
  });
}

// 简易 toast
function showToast(msg, duration = 2600) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

// ===== 选择节点 =====
function selectNode(uid) {
  const node = nodeIndex.get(uid);
  if (!node) return;
  CURRENT = uid;

  // 更新左侧选中状态
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.dataset.uid === uid);
  });
  // 展开所有祖先
  const ancestors = getPath(uid).slice(0, -1);
  ancestors.forEach(a => {
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
      // 命中时展开祖先
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
// 下拉菜单 action 路由
const TOOLBAR_ACTIONS = {
  'ai-current':         () => autolocateCurrent(),
  'ai-batch':           () => autolocateAll(),
  'hs-toggle':          () => toggleHotspots(),
  'hs-add':             () => enterAddHotspotMode(),
  'export-json':        () => openExportDialog(),
  'import-json':        () => openImportDialog(),
  'export-review-html': () => alert('评审纪要 (HTML) 导出 — 开发中'),
  'export-review-docx': () => alert('评审纪要 (Word) 导出 — 开发中'),
  'import-review':      () => alert('会议纪要导入 — 开发中'),
};

let HOTSPOTS_VISIBLE_STATE_INITED = false;
function toggleHotspots() {
  HOTSPOTS_VISIBLE = !HOTSPOTS_VISIBLE;
  document.getElementById('stage').classList.toggle('hotspots-hidden', !HOTSPOTS_VISIBLE);
}

function setupDropdown(buttonId, menuId) {
  const btn = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 关闭其他下拉
    document.querySelectorAll('.tbtn-menu').forEach(m => { if (m !== menu) m.hidden = true; });
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-act]');
    if (!li) return;
    if (li.classList.contains('disabled')) return;
    const act = li.dataset.act;
    menu.hidden = true;
    const fn = TOOLBAR_ACTIONS[act];
    if (fn) fn();
  });
}

function setupToolbar() {
  setupDropdown('btn-ai-menu', 'dd-ai');
  setupDropdown('btn-hotspot-menu', 'dd-hotspot');
  setupDropdown('btn-data-menu', 'dd-data');

  // 评论模式切换
  document.getElementById('btn-comment-mode').addEventListener('click', (e) => {
    COMMENT_MODE = !COMMENT_MODE;
    e.currentTarget.classList.toggle('active', COMMENT_MODE);
    const node = nodeIndex.get(CURRENT);
    if (node) renderScreen(node);
  });
  // 全局评论列表弹窗
  document.getElementById('btn-comment-list').addEventListener('click', openCommentListPanel);
  updateCommentBadge();

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

  // 点击外部关闭所有下拉
  document.addEventListener('click', () => {
    document.querySelectorAll('.tbtn-menu').forEach(m => { m.hidden = true; });
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') document.getElementById('btn-prev').click();
    else if (e.key === 'ArrowRight') document.getElementById('btn-next').click();
    else if (e.key === 'ArrowUp') document.getElementById('btn-parent').click();
    else if (e.key === 'h' || e.key === 'H') toggleHotspots();
    else if (e.key === 'c' || e.key === 'C') document.getElementById('btn-comment-mode').click();
    else if (e.key === 'Escape') {
      document.querySelectorAll('.tbtn-menu').forEach(m => { m.hidden = true; });
      closeAllPopovers();
    }
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ===== AI 自动识别热点位置(分块策略) =====
// 思路:长图按高度切成若干块,每块宽度不压缩(或轻度压缩到 <= 600px),高度 <= 900px。
// 每块单独送模型识别所有目标元素,得到某块命中了哪几个目标 + 块内像素坐标,
// 再换算回整图百分比。这样避免模型在超长图上对小元素的像素漂移。

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

function commitResults(parentNode, results) {
  results.filter(r => r.status === 'ok').forEach(r => {
    saveHotspotPosition(parentNode.uid, r.uid, { ...r.pos, conf: r.conf, manual: false });
  });
}

function showHotspotCandidates(node, res) {
  document.querySelectorAll('.modal-overlay').forEach(n => n.remove());

  const okCount = res.results.filter(r => r.status === 'ok').length;
  const total = res.results.length;

  const statusLabel = s => s === 'ok' ? '✓ 识别成功' : s === 'low-conf' ? '⚠ 置信度低' : '✗ 未找到';
  const statusColor = s => s === 'ok' ? '#4caf50' : s === 'low-conf' ? '#ff9800' : '#f44336';

  const rowsHtml = res.results.map(r => `
    <tr>
      <td style="padding:5px 8px;font-size:12px;color:var(--fg)">${r.label}</td>
      <td style="padding:5px 8px;font-size:12px;color:${statusColor(r.status)}">${statusLabel(r.status)}</td>
      <td style="padding:5px 8px;font-size:12px;color:var(--fg-dim)">${r.conf != null ? (r.conf * 100).toFixed(0) + '%' : '—'}</td>
    </tr>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:640px;max-width:95vw">
      <div class="modal-header">
        <span>热点识别结果 · ${node.title}</span>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body" style="gap:12px">
        <div style="position:relative;display:inline-block;align-self:center;max-width:100%">
          <img id="cand-img" src="${res.imageUrl}" style="display:block;max-width:100%;max-height:45vh;border-radius:6px;border:1px solid var(--line)">
          <div id="cand-boxes"></div>
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:var(--bg-2)">
              <th style="padding:6px 8px;font-size:11px;text-align:left;color:var(--fg-dim)">节点</th>
              <th style="padding:6px 8px;font-size:11px;text-align:left;color:var(--fg-dim)">状态</th>
              <th style="padding:6px 8px;font-size:11px;text-align:left;color:var(--fg-dim)">置信度</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p style="font-size:12px;color:var(--fg-dim);margin:0">识别到 ${okCount}/${total} 个热点。应用后可用 Shift+拖拽微调位置。</p>
      </div>
      <div class="modal-footer">
        <button data-act="cancel" style="padding:6px 16px;background:var(--bg-2);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--fg);font-size:13px">取消</button>
        <button data-act="apply" style="padding:6px 16px;background:var(--accent);border:none;border-radius:6px;cursor:pointer;color:#fff;font-size:13px" ${okCount === 0 ? 'disabled' : ''}>应用 ${okCount} 个热点</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // 图片加载完后绘制候选框
  const img = overlay.querySelector('#cand-img');
  const boxContainer = overlay.querySelector('#cand-boxes');
  const drawBoxes = () => {
    boxContainer.innerHTML = '';
    const rect = img.getBoundingClientRect();
    const iw = img.offsetWidth, ih = img.offsetHeight;
    res.results.filter(r => r.status === 'ok' || r.status === 'low-conf').forEach(r => {
      const box = document.createElement('div');
      const color = statusColor(r.status);
      box.style.cssText = `position:absolute;pointer-events:none;box-sizing:border-box;
        left:${r.pos.xPct}%;top:${r.pos.yPct}%;
        width:${r.pos.wPct}%;height:${r.pos.hPct}%;
        border:2px solid ${color};border-radius:3px`;
      const label = document.createElement('span');
      label.textContent = r.label;
      label.style.cssText = `position:absolute;top:-18px;left:0;
        font-size:10px;white-space:nowrap;padding:1px 4px;border-radius:3px;
        background:${color};color:#fff;line-height:16px`;
      box.appendChild(label);
      boxContainer.appendChild(box);
    });
    boxContainer.style.cssText = `position:absolute;inset:0;pointer-events:none`;
  };
  if (img.complete) drawBoxes(); else img.addEventListener('load', drawBoxes);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-act="apply"]').addEventListener('click', () => {
    commitResults(node, res.results);
    renderScreen(nodeIndex.get(CURRENT));
    overlay.remove();
  });
}

async function autolocateCurrent() {
  const btn = document.getElementById('btn-ai-menu');
  const node = nodeIndex.get(CURRENT);
  if (!node) return;
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '识别中…';
  try {
    const res = await autolocateNode(node, { dryRun: true });
    if (!res.ok) {
      btn.textContent = '✗ ' + (res.reason === 'no-children' ? '无子页' : res.reason === 'no-image' ? '无截图' : res.reason === 'img-load-fail' ? '图加载失败' : '失败');
      setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
      return;
    }
    const ok = res.results.filter(r => r.status === 'ok').length;
    const total = res.results.length;
    btn.textContent = `${ok}/${total}${res.source ? ` · ${res.source}` : ''} 待确认`;
    showHotspotCandidates(node, res);
  } catch (e) {
    btn.textContent = '✗ 异常';
    console.error(e);
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
  } finally {
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 3000);
  }
}

// 批量:遍历所有有截图+子节点的父页,依次识别
async function autolocateAll() {
  const btn = document.getElementById('btn-ai-menu');
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

// ===== 初始化 =====
renderTree();
setupSearch();
setupToolbar();

const restored = (() => {
  try { return localStorage.getItem(LS_PREFIX + 'current'); } catch { return null; }
})();
selectNode(restored && nodeIndex.has(restored) ? restored : TREE.uid);
