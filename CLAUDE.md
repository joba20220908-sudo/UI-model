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
  - 用户输入的智谱 key：`minddeck:zhipu_key`（前端 fallback 路径用，全局 key）
- **IndexedDB** per-project：库名 `proto_imgs__<id>`，store `blobs` 存截图 Blob
- 多项目通过 `PROJECT_ID = META.id` 前缀完全隔离

### `data.js` Schema

```js
window.PROJECT_META = { id: string, title: string, sub: string|null };
window.PROTOTYPE_TREE = {
  uid: 'n0',          // sequential pre-order: n0, n1, n2...
  depth: 0,
  title: string,      // rawTitle with \n → space
  rawTitle: string,   // original XMind title
  note: string|null,
  image: string|null, // filename only, e.g. "abc123.png" → screenshots/abc123.png?v2
  children: [...]
};
```

**`data.js` 怎么生成**：

```bash
node scripts/parse-xmind.js <input.xmind> Projects/<new-project> [--id <project-id>]
```

会读 `.xmind` 内的 `content.json` 生成 `data.js`，并把所有引用的截图从内嵌 `resources/` 抽到 `screenshots/`（用 UUID 文件名，跟 `node.image` 字段对齐）。然后从 `Template/` 复制 `Prototype.html` / `app.js` / `locator.js` 即可打开。

也可以让 Claude 直接在对话里读 `.xmind` 生成 —— 适合需要做 title 清洗、note 提取等手工调整的场景。

## Common Pitfalls

- **多变体同步**：现在 AI 逻辑统一走 `Template/locator.js`，6 个变体都用同一份 source。改 AI 只需要：
  - 编辑 `Template/locator.js`
  - `cp` 到所有 5 个外部副本（root、hnw-licai、移动端样例、my-new-project）
  - 同步内嵌副本：`my-new-project/MindDeck-standalone.html` 里的 IIFE 块
  - 非 AI 的逻辑改动仍需手工同步到各 `app.js`（Template 是 source of truth）
- **`scripts/start.sh` 必须 ports 8000 + 8788 都空闲**：脚本会做端口冲突检查并报错；遗留进程用 `lsof -ti :8788 | xargs kill -9` 清。
- **`scripts/start.sh` 自动从 `~/.claude/settings.json` 读 `ANTHROPIC_AUTH_TOKEN` 当智谱 key**：跨用户使用时要么自己 `export ZHIPU_API_KEY`，要么改脚本。
- **导入/导出 schema**：`buildExport` / `applyImport` 只接受 JSON 含 `schema: 'minddeck'` 或 `'proto-review'`。
- **不存在的命令**：曾经的 CLAUDE.md 描述了 `scripts/launch.sh`、`scripts/gen-manifest.js`、`scripts/test-modules.js`、`scripts/verify-images.sh` —— 这些**都未实现**。当前 `scripts/` 有 `start.sh` / `ocr-locate-server.py` / `parse-xmind.js` / `vision-proxy.js`。

## Reference Docs

- [`README.md`](README.md) — 项目顶层介绍 + 仓库结构
- [`USAGE.md`](USAGE.md) — 端到端使用流程（输入 → 启动 → 评审 → 导出）
- [`Template/README.md`](Template/README.md) — 工具本体完整使用文档（schema、快捷键、协作流程）
- [`MIGRATION.md`](MIGRATION.md) — 搬家指南 + AI 识图本地运行（OCR + LLM 架构详解、依赖、环境变量、性能特性）
