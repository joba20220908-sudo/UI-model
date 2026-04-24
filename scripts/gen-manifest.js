#!/usr/bin/env node
// gen-manifest.js — 扫描 Projects/ 生成 projects.json
// 用法: node scripts/gen-manifest.js <root-dir>

'use strict';

const fs   = require('fs');
const path = require('path');

const rootDir = process.argv[2] || path.join(__dirname, '..');
const projectsDir = path.join(rootDir, 'Projects');

if (!fs.existsSync(projectsDir)) {
  fs.writeFileSync(path.join(rootDir, 'projects.json'), '[]', 'utf8');
  process.exit(0);
}

const manifest = [];

for (const name of fs.readdirSync(projectsDir).sort()) {
  const dir     = path.join(projectsDir, name);
  const htmlFile = path.join(dir, 'Prototype.html');
  const dataFile = path.join(dir, 'data.js');

  if (!fs.statSync(dir).isDirectory()) continue;
  if (!fs.existsSync(htmlFile) || !fs.existsSync(dataFile)) continue;

  try {
    const raw = fs.readFileSync(dataFile, 'utf8');

    // Extract JSON by string matching — no eval
    const metaMatch = raw.match(/window\.PROJECT_META\s*=\s*(\{[\s\S]*?\});/);
    const treeMatch = raw.match(/window\.PROTOTYPE_TREE\s*=\s*(\{[\s\S]+\});\s*$/);
    if (!metaMatch || !treeMatch) continue;

    const meta = JSON.parse(metaMatch[1]);
    const tree = JSON.parse(treeMatch[1]);

    let nodeCount = 0, shotCount = 0, thumbnail = null;
    (function walk(n) {
      nodeCount++;
      if (n.image) {
        shotCount++;
        if (!thumbnail) {
          const imgPath = path.join(dir, 'screenshots', n.image);
          if (fs.existsSync(imgPath)) {
            // Relative to rootDir so it works as a URL from index.html
            thumbnail = 'Projects/' + name + '/screenshots/' + n.image;
          }
        }
      }
      (n.children || []).forEach(walk);
    })(tree);

    manifest.push({
      name,
      title:     meta.title || name,
      nodeCount,
      shotCount,
      thumbnail,
      url:       'Projects/' + name + '/Prototype.html',
      updatedAt: Math.floor(fs.statSync(dataFile).mtimeMs),
    });
  } catch (e) {
    // Skip malformed projects silently
  }
}

fs.writeFileSync(
  path.join(rootDir, 'projects.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);

console.log(`Manifest: ${manifest.length} project(s) → projects.json`);
