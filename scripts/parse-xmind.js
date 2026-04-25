#!/usr/bin/env node
/**
 * parse-xmind.js — 把 .xmind 解析为 MindDeck 项目骨架
 *
 * 用法：
 *   node scripts/parse-xmind.js <input.xmind> <output-project-dir> [--id <project-id>]
 *
 * 例：
 *   node scripts/parse-xmind.js my.xmind Projects/my-new-project --id my-new-project
 *
 * 行为：
 *   1) 用系统 `unzip` 解压 .xmind（零 npm 依赖）
 *   2) 读 content.json，walk 整棵树
 *   3) 生成 <output>/data.js（PROJECT_META + PROTOTYPE_TREE）
 *   4) 把所有被引用的 resources/<uuid>.<ext> 复制到 <output>/screenshots/
 *   5) 已存在的同名截图不覆盖（保留手工替换的图）
 *
 * 限制：
 *   - notes 字段当前一律生成 null（xmind 的富文本笔记结构待支持）
 *   - title 的 "\n" → 空格；rawTitle 保留原文
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { positional: [], id: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') out.id = args[++i];
    else if (args[i].startsWith('--')) die(`未知参数: ${args[i]}`);
    else out.positional.push(args[i]);
  }
  if (out.positional.length !== 2) {
    console.error('用法: node scripts/parse-xmind.js <input.xmind> <output-project-dir> [--id <project-id>]');
    process.exit(1);
  }
  return { input: out.positional[0], output: out.positional[1], id: out.id };
}

function unzipToTemp(xmindPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xmind-'));
  try {
    execFileSync('unzip', ['-q', '-o', xmindPath, '-d', tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (e) {
    die(`解压失败: ${e.message}`);
  }
  return tmp;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function readContentJson(tmpDir) {
  const p = path.join(tmpDir, 'content.json');
  if (!fs.existsSync(p)) die(`content.json 不存在于 ${tmpDir}（不是有效的 .xmind？）`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 从 "xap:resources/abc.png" 提取 "abc.png"
function imageFilenameFromSrc(src) {
  if (!src || typeof src !== 'string') return null;
  const m = src.match(/resources\/([^/]+)$/);
  return m ? m[1] : null;
}

function sanitizeId(name) {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')        // 去扩展名
    .replace(/[^a-z0-9]+/g, '-')    // 非字母数字 → 短横
    .replace(/^-+|-+$/g, '')        // 去首尾短横
    || 'project';
}

let uidCounter = 0;
const usedImages = new Set();

function walk(topic, depth) {
  const rawTitle = topic.title || '';
  const title = rawTitle.replace(/\n/g, ' ');
  const imageFile = imageFilenameFromSrc(topic.image && topic.image.src);
  if (imageFile) usedImages.add(imageFile);

  const node = {
    uid: 'n' + (uidCounter++),
    depth,
    title,
    rawTitle,
    note: null,                         // TODO: 解析 topic.notes（结构复杂，留空）
    image: imageFile,
    children: [],
  };

  const attached = (topic.children && topic.children.attached) || [];
  for (const child of attached) {
    node.children.push(walk(child, depth + 1));
  }
  return node;
}

function copyImages(tmpDir, screenshotsDir) {
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  let copied = 0, skipped = 0, missing = 0;
  for (const fname of usedImages) {
    const src = path.join(tmpDir, 'resources', fname);
    const dst = path.join(screenshotsDir, fname);
    if (!fs.existsSync(src)) { missing++; console.warn(`⚠️  resources/${fname} 不存在，跳过`); continue; }
    if (fs.existsSync(dst)) { skipped++; continue; }
    fs.copyFileSync(src, dst);
    copied++;
  }
  return { copied, skipped, missing, total: usedImages.size };
}

function renderDataJs(meta, tree) {
  return (
    `window.PROJECT_META = ${JSON.stringify(meta)};\n` +
    `window.PROTOTYPE_TREE = ${JSON.stringify(tree, null, 2)};\n`
  );
}

function main() {
  const { input, output, id: idFlag } = parseArgs(process.argv);

  if (!fs.existsSync(input)) die(`输入文件不存在: ${input}`);
  if (!input.toLowerCase().endsWith('.xmind')) console.warn(`⚠️  ${input} 不是 .xmind 后缀，仍然按 zip 处理`);

  const tmp = unzipToTemp(input);
  try {
    const content = readContentJson(tmp);
    if (!Array.isArray(content) || !content[0] || !content[0].rootTopic) {
      die('content.json 没有 rootTopic（xmind 文件可能用了不支持的格式版本）');
    }
    const root = content[0].rootTopic;

    uidCounter = 0;
    usedImages.clear();
    const tree = walk(root, 0);

    const projectId = idFlag || sanitizeId(path.basename(input));
    const meta = { id: projectId, title: root.title || projectId, sub: null };

    if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });
    const dataJsPath = path.join(output, 'data.js');
    fs.writeFileSync(dataJsPath, renderDataJs(meta, tree));

    const stats = copyImages(tmp, path.join(output, 'screenshots'));

    console.log(`✓ 解析完成`);
    console.log(`  项目 ID    : ${projectId}`);
    console.log(`  节点数     : ${uidCounter}`);
    console.log(`  截图引用   : ${stats.total}`);
    console.log(`  → 复制     : ${stats.copied}`);
    console.log(`  → 已存在   : ${stats.skipped}`);
    console.log(`  → 缺失     : ${stats.missing}`);
    console.log(`  data.js    : ${dataJsPath}`);
    console.log('');
    console.log('下一步：拷贝 Template/Prototype.html + Template/app.js 到该目录，然后浏览器打开。');
  } finally {
    rmrf(tmp);
  }
}

main();
