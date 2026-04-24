#!/usr/bin/env node
// Integration test: loads all modules in a mocked browser environment
// and verifies that all expected globals (functions) are defined and key logic works.
//
// Note: top-level `const`/`let` in Node.js VM scripts are NOT exposed in the sandbox
// object — unlike in browser classic scripts. Functions declared with `function` ARE
// exposed. We test const/let values indirectly through the functions that use them.

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '../Projects/hnw-licai');

// ── Minimal browser mock ──────────────────────────────────────────────
const lsStore = {};
const localStorage = {
  getItem: k => lsStore[k] ?? null,
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: k => { delete lsStore[k]; },
};

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    className: '', innerHTML: '', textContent: '',
    style: {}, dataset: {}, _t: null,
    classList: {
      add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
    },
    appendChild: () => {},
    append: () => {},
    removeEventListener: () => {},
    addEventListener: () => {},
    querySelector: () => makeEl('div'),
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }),
    click: () => {},
    remove: () => {},
    focus: () => {},
    get value() { return ''; },
    set value(v) {},
    disabled: false,
    files: null,
    checked: false,
  };
  return el;
}

const mockDoc = {
  getElementById: () => makeEl('div'),
  querySelector: () => makeEl('div'),
  querySelectorAll: () => ({ forEach: () => {} }),
  createElement: tag => makeEl(tag),
  addEventListener: () => {},
  body: { appendChild: () => {} },
  title: '',
};

const sandbox = vm.createContext({
  window: {
    PROTOTYPE_TREE: null,
    PROJECT_META: null,
    innerWidth: 1280,
    innerHeight: 800,
    confirm: () => true,
    addEventListener: () => {},
    claude: { complete: async () => '[]' },
  },
  document: mockDoc,
  localStorage,
  indexedDB: {
    open: () => {
      const req = {};
      setTimeout(() => {}, 0);
      return req;
    }
  },
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  FileReader: class { readAsDataURL() {} },
  fetch: async () => ({ blob: async () => new Blob() }),
  Blob: class Blob { constructor(p, o) { this.type = o?.type || ''; } },
  Image: class { set src(v) { setTimeout(() => this.onload?.(), 0); } },
  console,
  setTimeout: (fn) => { try { fn(); } catch {} },
  clearTimeout: () => {},
});

// ── Data stub ─────────────────────────────────────────────────────────
const dataStub = `
window.PROJECT_META = { id: 'test-project', title: 'Test Project' };
window.PROTOTYPE_TREE = {
  uid: 'n0', depth: 0, title: 'Root', rawTitle: 'Root', note: null, image: null,
  children: [
    { uid: 'n1', depth: 1, title: 'Page A', rawTitle: 'Page A', note: null,
      image: 'abc123.png', children: [
        { uid: 'n2', depth: 2, title: 'Sub 1', rawTitle: 'Sub 1', note: null,
          image: 'def456.png', children: [] },
      ]
    },
    { uid: 'n3', depth: 1, title: 'Page B', rawTitle: 'Page B',
      note: '要求:必须支持暗黑模式', image: null, children: [] },
  ]
};
`;

// ── Load order (mirrors Prototype.html) ──────────────────────────────
const modules = [
  { name: 'data.js [stub]', code: dataStub },
  { name: 'storage.js',     code: fs.readFileSync(path.join(BASE, 'storage.js'),     'utf8') },
  { name: 'tree.js',        code: fs.readFileSync(path.join(BASE, 'tree.js'),        'utf8') },
  { name: 'hotspots.js',    code: fs.readFileSync(path.join(BASE, 'hotspots.js'),    'utf8') },
  { name: 'comments-ui.js', code: fs.readFileSync(path.join(BASE, 'comments-ui.js'),'utf8') },
  { name: 'screen.js',      code: fs.readFileSync(path.join(BASE, 'screen.js'),      'utf8') },
  { name: 'export-ui.js',   code: fs.readFileSync(path.join(BASE, 'export-ui.js'),  'utf8') },
  { name: 'ai.js',          code: fs.readFileSync(path.join(BASE, 'ai.js'),          'utf8') },
  { name: 'app.js',         code: fs.readFileSync(path.join(BASE, 'app.js'),         'utf8') },
];

let failed = 0;
console.log('── Module load ──');
for (const { name, code } of modules) {
  try {
    vm.runInContext(code, sandbox, { filename: name });
    console.log(`  LOAD  ${name}`);
  } catch (e) {
    console.error(`  ERROR ${name}: ${e.message}`);
    failed++;
  }
}

// ── Function presence checks ──────────────────────────────────────────
// Note: const/let top-level are NOT in sandbox in Node VM (browser classic scripts ARE).
// We check functions (hoisted via `function` keyword) and test behavior instead.
const expectedFunctions = [
  // storage.js
  'imagePath', 'loadImgOverrides', 'saveImgOverrides',
  'idbPut', 'idbGet', 'idbDel', 'idbAllEntries',
  'buildExport', 'downloadJSON', 'applyImport',
  'resolveNodeImageUrl', 'nodeHasImage', 'uploadNodeImage', 'clearNodeImageOverride',
  'loadComments', 'saveComments', 'getNodeComments', 'setNodeComments',
  'addComment', 'updateComment', 'deleteComment',
  'countOpenComments', 'nodeHasOpenComments',
  'loadHotspotPositions', 'saveHotspotPosition',
  // tree.js
  'renderTree', 'renderTreeNodes',
  // hotspots.js
  'defaultHotspotPos', 'addHotspots', 'enableHotspotDrag',
  // comments-ui.js
  'addComments', 'openCommentComposer', 'openCommentPopover',
  'closeAllPopovers', 'updateCommentBadge', 'openCommentListPanel',
  // screen.js
  'renderScreen', 'buildPlaceholder', 'renderCrumb', 'renderInspector',
  // export-ui.js
  'openExportDialog', 'openImportDialog', 'showToast',
  // ai.js
  'loadImage', 'sliceForModel', 'extractJsonArray',
  'autolocateNode', 'autolocateCurrent', 'autolocateAll',
  // app.js
  'getPath', 'escapeHtml', 'selectNode', 'setupSearch', 'setupToolbar',
];

console.log('\n── Function presence ──');
for (const name of expectedFunctions) {
  if (typeof sandbox[name] === 'function') {
    console.log(`  OK    ${name}`);
  } else {
    console.error(`  MISS  ${name} (type: ${typeof sandbox[name]})`);
    failed++;
  }
}

// ── Unit tests for pure / data-layer functions ────────────────────────
console.log('\n── Unit tests ──');
function assert(label, condition) {
  if (condition) { console.log(`  PASS  ${label}`); }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

// escapeHtml
assert('escapeHtml: & → &amp;',  sandbox.escapeHtml('a & b') === 'a &amp; b');
assert('escapeHtml: < > →',      sandbox.escapeHtml('<div>') === '&lt;div&gt;');
assert('escapeHtml: null safe',   sandbox.escapeHtml(null) === '');

// imagePath
assert('imagePath: correct path', sandbox.imagePath('foo.png') === 'screenshots/foo.png?v2');
assert('imagePath: null → null',  sandbox.imagePath(null) === null);

// getPath
const rootPath = sandbox.getPath('n0');
assert('getPath: root → 1 item',       rootPath.length === 1);
assert('getPath: root uid',            rootPath[0].uid === 'n0');
const deepPath = sandbox.getPath('n2');
assert('getPath: nested n2 depth 3',  deepPath.length === 3);
assert('getPath: n2 leaf title',       deepPath[2].title === 'Sub 1');

// nodeHasImage
const n1 = sandbox.getNodeComments('n1'); // indirect — tests storage works
const nodeA = { uid: 'n1', image: 'abc123.png', children: [] };
const nodeB = { uid: 'n3', image: null, children: [] };
assert('nodeHasImage: has original',  sandbox.nodeHasImage(nodeA));
assert('nodeHasImage: no image',      !sandbox.nodeHasImage(nodeB));

// Comments data layer
sandbox.addComment('n1', 10, 20, 'Test comment');
const cmts = sandbox.getNodeComments('n1');
assert('addComment: 1 stored',        cmts.length === 1);
assert('addComment: text',            cmts[0].text === 'Test comment');
assert('addComment: status open',     cmts[0].status === 'open');
assert('addComment: xPct',           cmts[0].xPct === 10);
assert('countOpenComments: 1',        sandbox.countOpenComments() === 1);
assert('nodeHasOpenComments: true',   sandbox.nodeHasOpenComments('n1'));

sandbox.updateComment('n1', cmts[0].id, { status: 'resolved' });
assert('updateComment: resolved',     sandbox.getNodeComments('n1')[0].status === 'resolved');
assert('countOpenComments after resolve: 0', sandbox.countOpenComments() === 0);

sandbox.deleteComment('n1', cmts[0].id);
assert('deleteComment: 0 remaining',  sandbox.getNodeComments('n1').length === 0);

// Hotspot data layer
sandbox.saveHotspotPosition('n1', 'n2', { xPct: 15, yPct: 25, wPct: 30, hPct: 5 });
const hs = sandbox.loadHotspotPositions();
assert('saveHotspotPosition: stored', hs['n1'] && hs['n1']['n2'] !== undefined);
assert('saveHotspotPosition: xPct',   hs['n1']['n2'].xPct === 15);
// merge: subsequent save merges, doesn't overwrite
sandbox.saveHotspotPosition('n1', 'n2', { conf: 0.9 });
const hs2 = sandbox.loadHotspotPositions();
assert('saveHotspotPosition: merge keeps xPct', hs2['n1']['n2'].xPct === 15);
assert('saveHotspotPosition: merge adds conf',  hs2['n1']['n2'].conf === 0.9);

// defaultHotspotPos
const pos1 = sandbox.defaultHotspotPos(0, 5);
const pos2 = sandbox.defaultHotspotPos(2, 5);
assert('defaultHotspotPos: has all keys', ['xPct','yPct','wPct','hPct'].every(k => typeof pos1[k] === 'number'));
assert('defaultHotspotPos: later index lower y', pos2.yPct > pos1.yPct);

// extractJsonArray
assert('extractJsonArray: valid',        Array.isArray(sandbox.extractJsonArray('[{"a":1}]')));
assert('extractJsonArray: nested text',  sandbox.extractJsonArray('text [1,2] end')[0] === 1);
assert('extractJsonArray: bad input',    sandbox.extractJsonArray('not json') === null);
assert('extractJsonArray: null input',   sandbox.extractJsonArray(null) === null);

// imgOverrides data layer
sandbox.saveImgOverrides({ n1: { blobKey: 'img_n1_1', mime: 'image/png', fileName: 'test.png' } });
const ov = sandbox.loadImgOverrides();
assert('imgOverrides: round-trip',  ov['n1'] && ov['n1'].blobKey === 'img_n1_1');
const nodeWithOverride = { uid: 'n1', image: null, children: [] };
assert('nodeHasImage: override only', sandbox.nodeHasImage(nodeWithOverride));

// ── Summary ───────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(44));
if (failed === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.error(`${failed} TEST(S) FAILED`);
  process.exit(1);
}
