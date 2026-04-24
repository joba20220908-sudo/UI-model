#!/usr/bin/env node
// parse-xmind.js  —  XMind → MindDeck data.js converter
// Usage: node scripts/parse-xmind.js <input.xmind> [output-dir]
//
// Zero npm dependencies. Uses only Node.js built-ins + system unzip + python3.
// Supports XMind 2020+ (content.json) and XMind 8 legacy (content.xml).

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── UID counter (module-global, reset per parse) ──────────────────────────────
let uidCounter = 0;
function nextUid() { return 'n' + uidCounter++; }

// ── Args ─────────────────────────────────────────────────────────────────────
const [,, xmindFile, outputDir] = process.argv;
if (!xmindFile) {
  console.error('Usage: node scripts/parse-xmind.js <input.xmind> [output-dir]');
  process.exit(1);
}
if (!fs.existsSync(xmindFile)) {
  console.error(`File not found: ${xmindFile}`);
  process.exit(1);
}

// ── Temp dir ─────────────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmind-'));
try {
  main();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  // 1. Extract the XMind ZIP
  const result = spawnSync('unzip', ['-q', '-o', path.resolve(xmindFile), '-d', tmpDir]);
  if (result.status !== 0) {
    console.error('unzip failed:', result.stderr?.toString() || '');
    process.exit(1);
  }

  // 2. Determine project ID from filename
  const baseName = path.basename(xmindFile, path.extname(xmindFile));
  const projectId = baseName
    .toLowerCase()
    .replace(/[\s　]+/g, '-')
    .replace(/[^\w\-]/g, '')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '') || 'project';

  // 3. Parse: try content.json first, then content.xml
  let tree;
  const jsonFile = path.join(tmpDir, 'content.json');
  const xmlFile  = path.join(tmpDir, 'content.xml');

  if (fs.existsSync(jsonFile)) {
    console.log('Format: content.json (XMind 2020+)');
    tree = parseJson(jsonFile);
  } else if (fs.existsSync(xmlFile)) {
    console.log('Format: content.xml (XMind 8 legacy)');
    tree = parseXml(xmlFile);
  } else {
    console.error('Neither content.json nor content.xml found inside the XMind file.');
    process.exit(1);
  }

  // 4. Build PROJECT_META
  const rootTitle = tree.title.replace(/\n/g, ' ').trim();
  const meta = {
    id:    projectId,
    title: rootTitle,
    sub:   null,
  };

  // 5. Write data.js
  const outDir = outputDir || '.';
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'data.js');

  const js = [
    `window.PROJECT_META = ${JSON.stringify(meta)};`,
    `window.PROTOTYPE_TREE = ${JSON.stringify(tree, null, 2)};`,
  ].join('\n') + '\n';

  fs.writeFileSync(outFile, js, 'utf8');

  // 6. Report
  let nodeCount = 0;
  (function count(n) { nodeCount++; n.children.forEach(count); })(tree);
  console.log(`Parsed ${nodeCount} nodes  →  ${outFile}`);
  console.log(`Project ID: ${meta.id}`);
  console.log(`Root title: ${meta.title}`);
}

// ── content.json parser ───────────────────────────────────────────────────────
function parseJson(file) {
  uidCounter = 0;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  // XMind 2020+ wraps everything in an array of sheets
  const sheets = Array.isArray(raw) ? raw : [raw];
  const sheet = sheets[0];

  // Root topic: sheet.rootTopic  (XMind 2021+)
  // Some versions: sheet.rootTopic inside sheet.rootTopic
  const rootTopic = sheet.rootTopic || sheet;
  return walkJsonTopic(rootTopic, 0);
}

function walkJsonTopic(topic, depth) {
  const uid      = nextUid();  // pre-order: parent before children
  const rawTitle = (topic.title || '').trim();
  const title    = rawTitle.replace(/\n/g, ' ');

  // Note: may be topic.notes?.plain?.content  or  topic.note
  let note = null;
  if (topic.notes) {
    if (typeof topic.notes === 'string') {
      note = topic.notes.trim() || null;
    } else if (topic.notes.plain) {
      note = (topic.notes.plain.content || '').trim() || null;
    } else if (topic.notes.realHTML || topic.notes.html) {
      const html = topic.notes.realHTML || topic.notes.html || '';
      note = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() || null;
    }
  }
  if (!note && topic.note) {
    note = String(topic.note).trim() || null;
  }

  const attached = topic.children?.attached || topic.children || [];
  const childArr = Array.isArray(attached) ? attached : Object.values(attached).flat();
  const children = childArr.map(c => walkJsonTopic(c, depth + 1));

  return { uid, depth, title, rawTitle, note, image: null, children };
}

// ── content.xml parser (via python3) ─────────────────────────────────────────
function parseXml(file) {
  uidCounter = 0;

  // Use python3 to parse the XML and emit a simple JSON we can consume
  const pyScript = `
import sys, json, xml.etree.ElementTree as ET

NS = 'urn:xmind:xmap:xmlns:content:2.0'

def tag(local):
    return '{' + NS + '}' + local

def get_note(topic):
    # XMind 8 stores notes in <richcontent type="NOTE"> or <notes>
    for child in topic:
        local = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if local in ('notes', 'richcontent'):
            texts = []
            for t in child.iter():
                if t.text and t.text.strip():
                    texts.append(t.text.strip())
            return ' '.join(texts) or None
    return None

def walk(topic, depth):
    title_el = topic.find(tag('title'))
    raw = (title_el.text or '').strip() if title_el is not None else ''
    note = get_note(topic)
    kids = []
    children_el = topic.find(tag('children'))
    if children_el is not None:
        topics_el = children_el.find(tag('topics'))
        if topics_el is not None:
            for child in topics_el.findall(tag('topic')):
                kids.append(walk(child, depth + 1))
    return {'rawTitle': raw, 'note': note, 'depth': depth, 'children': kids}

tree = ET.parse(sys.argv[1])
root = tree.getroot()

# Find the first sheet
sheet = None
for child in root:
    local = child.tag.split('}')[-1] if '}' in child.tag else child.tag
    if local == 'sheet':
        sheet = child
        break

if sheet is None:
    # Try without namespace
    sheet = root.find('sheet') or root

root_topic = None
for child in sheet:
    local = child.tag.split('}')[-1] if '}' in child.tag else child.tag
    if local == 'topic':
        root_topic = child
        break

if root_topic is None:
    print('{}')
    sys.exit(0)

print(json.dumps(walk(root_topic, 0)))
`;

  const res = spawnSync('python3', ['-c', pyScript, file], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error('python3 XML parse failed:', res.stderr || '');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch (e) {
    console.error('Could not parse python3 output:', res.stdout);
    process.exit(1);
  }

  return assignUids(parsed, 0);
}

function assignUids(node, depth) {
  const uid      = nextUid();  // pre-order: parent before children
  const rawTitle = (node.rawTitle || '').trim();
  return {
    uid,
    depth,
    title:    rawTitle.replace(/\n/g, ' '),
    rawTitle,
    note:     node.note || null,
    image:    null,
    children: (node.children || []).map(c => assignUids(c, depth + 1)),
  };
}
