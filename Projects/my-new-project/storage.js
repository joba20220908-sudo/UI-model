// ===== 项目全局常量(所有模块共享) =====
const TREE = window.PROTOTYPE_TREE;
const META = window.PROJECT_META || {};
const PROJECT_ID = META.id || 'default';
const LS_PREFIX = 'proto:' + PROJECT_ID + ':';

// ===== 图片路径工具 =====
const SHOT_VER = 'v2';
function imagePath(filename) {
  return filename ? `screenshots/${filename}?${SHOT_VER}` : null;
}

// ===== 图片覆盖层(用户上传) =====
const IMG_OVERRIDE_KEY = LS_PREFIX + 'img_overrides_v1';
function loadImgOverrides() {
  try { return JSON.parse(localStorage.getItem(IMG_OVERRIDE_KEY) || '{}'); }
  catch { return {}; }
}
function saveImgOverrides(map) {
  localStorage.setItem(IMG_OVERRIDE_KEY, JSON.stringify(map));
}

// ===== IndexedDB 包装(按项目分库) =====
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
      for (let i = 0; i < keys.length; i++) out.push({ key: keys[i], blob: vals[i] });
      res(out);
    };
    tx.onerror = () => rej(tx.error);
  });
}

// ===== 导入/导出数据层 =====
const EXPORT_VERSION = 1;

async function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function base64ToBlob(dataUrl) {
  const r = await fetch(dataUrl);
  return await r.blob();
}

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
    imgOverridesMeta: loadImgOverrides(),
    current: CURRENT,
    images: {}
  };
  if (includeImages) {
    const all = await idbAllEntries();
    for (const { key, blob } of all) {
      try {
        data.images[key] = { mime: blob.type || 'image/png', base64: await blobToBase64(blob) };
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

async function applyImport(data, strategy) {
  if (!data || (data.schema !== 'minddeck' && data.schema !== 'proto-review'))
    throw new Error('不是有效的 MindDeck 存档文件');
  if (data.version > EXPORT_VERSION)
    throw new Error(`该存档版本 v${data.version} 比当前工具 v${EXPORT_VERSION} 新,无法导入`);

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
      const incomingArr = inc[uid];
      if (strategy === 'merge-overwrite') {
        const incIds = new Set(incomingArr.map(c => c.id));
        merged[uid] = [...localArr.filter(c => !incIds.has(c.id)), ...incomingArr];
      } else {
        merged[uid] = [...localArr, ...incomingArr.filter(c => !localIds.has(c.id))];
      }
    }
  }
  saveComments(merged);

  // 2. 热点位置
  const curHs = loadHotspotPositions();
  const incHs = data.hotspots || {};
  let mergedHs;
  if (strategy === 'replace') {
    mergedHs = incHs;
  } else if (strategy === 'merge-overwrite') {
    mergedHs = { ...curHs };
    for (const pid in incHs) mergedHs[pid] = { ...(curHs[pid] || {}), ...incHs[pid] };
  } else {
    mergedHs = { ...curHs };
    for (const pid in incHs) mergedHs[pid] = { ...incHs[pid], ...(curHs[pid] || {}) };
  }
  localStorage.setItem(HOTSPOT_STORE_KEY, JSON.stringify(mergedHs));

  // 3. 图片 overrides + Blob
  if (data.includeImages && data.images) {
    const curOv = loadImgOverrides();
    const incOv = data.imgOverridesMeta || {};
    let mergedOv;
    if (strategy === 'replace') {
      for (const uid in curOv) {
        const bk = curOv[uid] && curOv[uid].blobKey;
        if (bk) { try { await idbDel(bk); } catch {} }
      }
      mergedOv = incOv;
    } else if (strategy === 'merge-overwrite') {
      mergedOv = { ...curOv, ...incOv };
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
    for (const [k, url] of _blobUrlCache) { URL.revokeObjectURL(url); }
    _blobUrlCache.clear();
  }

  return {
    comments: Object.values(merged).reduce((n, arr) => n + arr.length, 0),
    hotspots: Object.values(mergedHs).reduce((n, o) => n + Object.keys(o || {}).length, 0),
    images: data.includeImages ? Object.keys(data.images || {}).length : 0,
  };
}

// ===== 图片 URL 解析 =====
const _blobUrlCache = new Map();
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

function nodeHasImage(node) {
  if (node.image) return true;
  const ov = loadImgOverrides()[node.uid];
  return !!(ov && ov.blobKey);
}

async function uploadNodeImage(node, file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('请选择图片文件');
  const blobKey = 'img_' + node.uid + '_' + Date.now();
  await idbPut(blobKey, file);
  const overrides = loadImgOverrides();
  if (overrides[node.uid] && overrides[node.uid].blobKey) {
    try { await idbDel(overrides[node.uid].blobKey); } catch {}
    if (_blobUrlCache.has(overrides[node.uid].blobKey)) {
      URL.revokeObjectURL(_blobUrlCache.get(overrides[node.uid].blobKey));
      _blobUrlCache.delete(overrides[node.uid].blobKey);
    }
  }
  overrides[node.uid] = {
    blobKey, mime: file.type, fileName: file.name,
    addedAt: Date.now(), replaced: !!node.image,
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

// ===== 评论数据层 =====
const COMMENTS_KEY = LS_PREFIX + 'comments_v1';

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
function countOpenComments() {
  const all = loadComments();
  let n = 0;
  for (const uid in all) n += (all[uid] || []).filter(c => c.status === 'open').length;
  return n;
}
function nodeHasOpenComments(uid) {
  return getNodeComments(uid).some(c => c.status === 'open');
}

// ===== 热点位置数据层 =====
const HOTSPOT_STORE_KEY = LS_PREFIX + 'hotspots_v1';
function loadHotspotPositions() {
  try { return JSON.parse(localStorage.getItem(HOTSPOT_STORE_KEY) || '{}'); }
  catch { return {}; }
}
function saveHotspotPosition(parentUid, childUid, pos) {
  const store = loadHotspotPositions();
  store[parentUid] = store[parentUid] || {};
  const prev = store[parentUid][childUid] || {};
  store[parentUid][childUid] = { ...prev, ...pos };
  localStorage.setItem(HOTSPOT_STORE_KEY, JSON.stringify(store));
}

// ===== 树层级覆盖：拖拽移动 / 手动新增 / 手动删除 =====
// Schema: { moves: {uid: newParentUid}, adds: [{uid, parentUid, title, image}], deletes: [uid] }
const TREE_OVERRIDES_KEY = LS_PREFIX + 'tree_overrides_v1';
function loadTreeOverrides() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(TREE_OVERRIDES_KEY) || '{}'); }
  catch { raw = {}; }
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
(function applyTreeOverridesAtBoot() {
  const o = loadTreeOverrides();
  if (!hasOverrides(o)) return;
  const u2n = new Map(), u2p = new Map();
  (function walk(n, p) {
    u2n.set(n.uid, n);
    if (p) u2p.set(n.uid, p);
    n.children.forEach(c => walk(c, n));
  })(TREE, null);

  for (const a of o.adds) {
    const parent = a.parentUid ? u2n.get(a.parentUid) : TREE;
    if (!parent) continue;
    if (u2n.has(a.uid)) continue;
    const node = {
      uid: a.uid, depth: 0,
      title: a.title || '新页面', rawTitle: a.title || '新页面',
      note: null, image: a.image || null,
      description: null, tables: null, nav_targets: null,
      children: [],
    };
    parent.children.push(node);
    u2n.set(a.uid, node);
    u2p.set(a.uid, parent);
  }

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
