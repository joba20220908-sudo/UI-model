# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

**MindDeck** — converts XMind mind maps into interactive browser-based product review tools. Pure HTML5 + Vanilla JS, zero npm dependencies. Each project under `Projects/<name>/` is self-contained: `Prototype.html` + `data.js` + screenshots, optionally split into modular `.js` files.

## Key Commands

```bash
# 一键启动：静态服务 :8000 + 本地 OCR 服务 :8788
bash scripts/start.sh

# 仅静态服务（不用 AI 识图时）
python3 -m http.server 8000

# 仅 OCR 服务（手动启动 / 调试）
python3 scripts/ocr-locate-server.py [port]
```

**浏览器入口**（无项目选择页，直接访问每个项目的 Prototype.html）：

```
http://localhost:8000/Projects/hnw-licai/Prototype.html
http://localhost:8000/Projects/移动端个人高净值用户理财测试样例/Prototype.html
```

**一次性依赖**：`pip3 install --user ocrmac pillow`（OCR 服务用 macOS Vision Framework，仅 macOS）

## Architecture

### Project Layout

```
UI-model/
  Template/              # 模板（开新项目时复制）
    Prototype.html, app.js, data.js, screenshots/, README.md
  Projects/
    hnw-licai/           # 单文件版（Prototype + app.js + data.js）
    my-new-project/      # 模块化版（含 MindDeck-standalone.html 内嵌单文件版）
    移动端个人高净值用户理财测试样例/  # 模块化版（含 .xmind 源文件）
  scripts/
    start.sh             # 一键启动两服务
    ocr-locate-server.py # macOS Vision OCR + 智谱 glm-4-flash 语义匹配
    vision-proxy.js      # 备用 vision LLM 代理（已被 OCR 服务取代）
  Prototype.html, app.js, data.js   # 根目录调试版（独立单文件）
  MIGRATION.md           # 迁移指南 + AI 识图本地运行说明
```

无 `index.html` / `projects.json`：通过完整 URL 直接访问每个项目。

### Two Frontend Variants Coexist

| 变体 | 特征 | 项目 |
|---|---|---|
| **Single-file** | `<script>` 加载顺序 `data.js → locator.js → app.js` | `Template/`、`Projects/hnw-licai/`、根目录调试版、`Projects/移动端个人高净值用户理财测试样例/` |
| **Modular** | 拆成多个 `.js`，加载顺序见下；`ai.js` 负责 `autolocate*`，AI 内部走 `locator.js` | `Projects/my-new-project/` |
| **Standalone HTML** | 单文件 HTML 内嵌全部脚本（含 locator.js IIFE 副本，保持自包含）| `Projects/my-new-project/MindDeck-standalone.html` |

模块化版本的 `<script>` 加载顺序（在 `Projects/my-new-project/Prototype.html` 里）：

```
data.js → storage.js → tree.js → hotspots.js → comments-ui.js
       → screen.js → export-ui.js → locator.js → ai.js → app.js
```

`storage.js` 第一个跑，建立全局常量 `TREE` / `META` / `PROJECT_ID` / `LS_PREFIX`，后续模块依赖。`locator.js` 必须在 `ai.js` 之前加载（`ai.js#autolocateNode` 调用 `window.locateHotspots`）。

### AI Hotspot Localization (Provider Chain)

所有 AI 定位逻辑集中在 `Template/locator.js`（其他 5 个变体共享同一份 source）。统一入口：

```js
window.locateHotspots({ img, targets }) → { candidates, fullW, fullH, source } | null
```

按 `window.LocatorChain` 顺序尝试，第一个返回非空 candidates 的赢：

1. **`ocrServer`** — POST 整图到本地 `localhost:8788/ocr-locate`
   - 服务端：macOS Vision 切片并行 OCR + 图级缓存
   - 服务端匹配：字符串精确匹配命中部分 → 漏掉的交给智谱 `glm-4-flash` 语义补漏
   - 服务不可达 / 命中 0 时返回 null，进入下一 provider

2. **`windowClaude`** — Claude Code Web 预览注入的 `window.claude.complete`（仅云端预览环境）
   - 走 `sliceForModel` 切片 + 串行调用

3. **`zhipuVision`** — 直连智谱 `glm-5v-turbo`（兜底，限流严）
   - 内置 429 指数退避重试（4 次，2/4/8/16s）
   - 含 `[x,y,w,h]` vs `[x1,y1,x2,y2]` 格式探测、零占位过滤

加新 provider（OpenAI / 本地模型）只需在 `locator.js` 里写一个对象 `{name, locate({img, targets, opts})}`，push 到 `LocatorChain` 即可，`autolocateNode` 不用改。

⚠️ **OCR 服务的 LLM 模型选型**：不能用 reasoning 模型（`glm-4.6` 长 prompt 会被智谱断连 `Remote end closed connection`）。默认 `glm-4-flash`，可通过 `ZHIPU_MATCH_MODEL` 环境变量覆盖。

### Hotspot Save Flow

- `autolocateCurrent` → `autolocateNode(dryRun=true)` → `showHotspotCandidates` 审核 UI → 用户确认 → `commitResults` 保存
- `autolocateAll` 批量：**自动跳过所有子节点已 `manual: true` 的父节点**（保护用户手动微调）
- `saveHotspotPosition(parentUid, childUid, pos)` 写 localStorage

### Storage Layout

- **localStorage**（每个 key 都加 `PROJECT_ID` 前缀）：
  - `proto:<id>:comments_v1` — 评论
  - `proto:<id>:hs_positions_v1` — 热点位置
  - `proto:<id>:img_overrides_v1` — 截图替换 metadata
  - `proto:<id>:tree_overrides_v1` — 树层级覆盖（手动调整：移动 / 新增 / 删除）
  - 用户输入的智谱 key：`minddeck:zhipu_key`（前端 fallback 路径用，全局 key）
- **IndexedDB** per-project：库名 `proto_imgs__<id>`，store `blobs` 存截图 Blob
- 多项目通过 `PROJECT_ID = META.id` 前缀完全隔离

### Tree Overrides（用户手动调整树形）

`tree_overrides_v1` 在 boot 时被读取并 mutate `TREE`（在 `app.js` / 模块化版 `storage.js` 顶部的 IIFE）：

```js
{
  moves: { uid: newParentUid|null },     // 拖拽 re-parent；null = 挂根
  adds: [{ uid: 'c_xxx', parentUid, title, image }],  // 用户新增
  deletes: [uid, ...]                    // 用户删除（含子树）
}
```

**Apply 顺序**：`adds` → `moves` → `deletes`。这个顺序保证"删除节点 X 但保留子孙"语义正确（先把 X 的 kids 用 moves 挪走、再 delete X）。

UI 入口：
- 拖拽 `.tree-item` 触发 `moves`
- 节点 hover 显示 `+ ×` 按钮触发 `adds` / `deletes`
- 工具栏「+ 热点」进入画框模式，框选 + 命名 → 同时 `adds` 子节点 + 写 `hs_positions`
- 热点 hover 显示红色 ×，删除 = `deletes`（带 3 选 1 对话框：取消 / 仅删本节点子孙上挂 / 整棵删）

兼容旧扁平格式 `{uid: parentUid}`：自动迁移到 `moves`。

### `data.js` Schema

```js
window.PROJECT_META = { id: string, title: string, sub: string|null };
window.PROTOTYPE_TREE = {
  uid: 'n0',                  // sequential pre-order: n0, n1, n2...
  depth: 0,
  title: string,              // rawTitle with \n → space
  rawTitle: string,           // original title (XMind / Word heading)
  note: string|null,
  image: string|null,         // filename only, e.g. "abc123.png" → screenshots/abc123.png?v2
  description: string|null,   // Word 路径填充：H3 段落 + 列表项（• 前缀）
  tables: array|null,         // Word 路径填充：[{headers:[], rows:[[]]}]
  nav_targets: array|null,    // Word 路径 LLM 抽取：[{label, trigger, uid?}]
  children: [...]
};
```

`description` / `tables` / `nav_targets` 在 xmind 路径下永远为 `null`，前端短路渲染。

**`data.js` 怎么生成**：

XMind 输入：
```bash
node scripts/parse-xmind.js <input.xmind> Projects/<new-project> [--id <id>]
```

Word PRD 输入：
```bash
python3 scripts/parse-docx.py <input.docx> Projects/<new-project> [--id <id>] [--entry "APP首页"] [--no-llm]
```

- `--entry "<H2 标题>"` 启用 LLM 重构：调智谱 `glm-4-flash` 扫每个 H3 描述里的"进入 X / 跳到 X"语句，把被引用的 H2 整体挂到对应 H3 下。被引用的目标也会写入 `nav_targets`。
- `--no-llm` 跳过 LLM 步骤，仅按 doc 标题层级输出
- ZHIPU_API_KEY 优先环境变量，其次 `~/.claude/settings.json` 里的 `ANTHROPIC_AUTH_TOKEN`

依赖（一次性）：`pip3 install --user python-docx`

两条解析器都把截图（xmind 的 `resources/<uuid>.png` 或 docx 的 `word/media/`）抽到 `screenshots/`，按内容 sha1 / uuid 命名去重。然后从 `Template/` 复制 `Prototype.html` / `app.js` / `locator.js` 即可打开。

也可以让 Claude 直接在对话里读源文件生成 `data.js` —— 适合需要做 title 清洗、note 提取等手工调整的场景。

## Common Pitfalls

- **多变体同步**：现在 AI 逻辑统一走 `Template/locator.js`，6 个变体都用同一份 source。改 AI 只需要：
  - 编辑 `Template/locator.js`
  - `cp` 到所有 5 个外部副本（root、hnw-licai、移动端样例、my-new-project）
  - 同步内嵌副本：`my-new-project/MindDeck-standalone.html` 里的 IIFE 块
  - 非 AI 的逻辑改动仍需手工同步到各 `app.js`（Template 是 source of truth）
- **`scripts/start.sh` 必须 ports 8000 + 8788 都空闲**：脚本会做端口冲突检查并报错；遗留进程用 `lsof -ti :8788 | xargs kill -9` 清。
- **`scripts/start.sh` 自动从 `~/.claude/settings.json` 读 `ANTHROPIC_AUTH_TOKEN` 当智谱 key**：跨用户使用时要么自己 `export ZHIPU_API_KEY`，要么改脚本。
- **导入/导出 schema**：`buildExport` / `applyImport` 只接受 JSON 含 `schema: 'minddeck'` 或 `'proto-review'`。
- **不存在的命令**：曾经的 CLAUDE.md 描述了 `scripts/launch.sh`、`scripts/gen-manifest.js`、`scripts/test-modules.js`、`scripts/verify-images.sh` —— 这些**都未实现**。当前 `scripts/` 有 `start.sh` / `ocr-locate-server.py` / `parse-xmind.js` / `parse-docx.py` / `vision-proxy.js`。
- **`MindDeck-standalone.html` 跟主线脱节**：内嵌的 app.js / locator.js 是早期快照副本，新加的 tree overrides / 拖拽 / 节点编辑 / 热点编辑都没同步进去。需要时从 `Template/app.js` 重新拷贝整段，或干脆当成只读样本。

## Reference Docs

- [`README.md`](README.md) — 项目顶层介绍 + 仓库结构
- [`USAGE.md`](USAGE.md) — 端到端使用流程（输入 → 启动 → 评审 → 导出）
- [`Template/README.md`](Template/README.md) — 工具本体完整使用文档（schema、快捷键、协作流程）
- [`MIGRATION.md`](MIGRATION.md) — 搬家指南 + AI 识图本地运行（OCR + LLM 架构详解、依赖、环境变量、性能特性）
