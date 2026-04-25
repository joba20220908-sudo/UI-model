# MindDeck 使用说明

> 面向使用者：从拿到一个 `.xmind` 文件 + 一叠截图，到打开浏览器评审、导出结果给同事，全流程怎么做。
>
> 想知道项目架构 / 二次开发，看 [`CLAUDE.md`](CLAUDE.md) 和 [`Template/README.md`](Template/README.md)。

---

## 1. 你需要准备什么

| 输入 | 说明 |
|---|---|
| `.xmind` 文件 | 产品功能脑图，每个节点对应一屏 |
| 截图若干张 | PNG/JPG，每张对应脑图里**有截图的节点**（叶子或中间节点都行） |
| macOS（可选） | 想用本地 AI 自动定位热点需要 macOS（依赖系统 Vision Framework）；只点点评论可跳过 |
| 智谱 API Key（可选） | AI 语义匹配用，没有也能跑（仅字符串匹配） |

**输出**：一个浏览器里能打开的交互式原型，可以打针评论、追未解决项、导出 JSON 给同事接力。

---

## 2. 启动服务

### 2.1 一键启动（推荐，含 AI 识图）

```bash
cd /path/to/UI-model
bash scripts/start.sh
```

启动后两个端口同时在跑：
- `http://localhost:8000` — 静态服务（页面）
- `http://localhost:8788` — OCR + LLM 定位服务

脚本会自动从 `~/.claude/settings.json` 读 `ANTHROPIC_AUTH_TOKEN` 当智谱 key。没读到也能跑，只是 AI 语义匹配会跳过（仍能字符串匹配）。

**Ctrl+C 退出**，自动清理两个进程。

**前置依赖（仅一次）**：

```bash
pip3 install --user ocrmac pillow
```

### 2.2 仅静态服务（不用 AI 识图）

```bash
python3 -m http.server 8000
```

### 2.3 端口冲突排查

`start.sh` 启动报 `❌ 端口 8000 / 8788 被占用`：

```bash
lsof -ti :8000 | xargs kill -9
lsof -ti :8788 | xargs kill -9
```

---

## 3. 打开页面

浏览器直接访问每个项目的 `Prototype.html`：

```
http://localhost:8000/Projects/hnw-licai/Prototype.html
http://localhost:8000/Projects/移动端个人高净值用户理财测试样例/Prototype.html
```

⚠️ **不要用 `file://` 协议双击打开** —— 会有 CORS 问题，截图加载会失败。

---

## 4. 新建一个评审项目

### 4.1 复制模板

```bash
cp -r Template/ Projects/my-new-project/
```

### 4.2 让 Claude 解析 XMind 生成 `data.js`

当前没有 CLI 解析脚本（`scripts/parse-xmind.js` 未实现）。约定做法：

> 把 `.xmind` 文件丢给 Claude 对话，告诉它：
> - 解压并读 `content.json`
> - 按 [`Template/README.md`](Template/README.md#数据结构) 里的 schema 生成 `Projects/my-new-project/data.js`
> - 列出所需截图清单（每个 `node.image` 字段对应一个文件名）

生成后 `data.js` 大致长这样：

```js
window.PROJECT_META = {
  id: 'my-new-project',  // 小写英文+短横，全局唯一（本地存储靠它隔离）
  title: '我的评审项目',
  sub: null              // null = 自动统计节点数/截图数
};
window.PROTOTYPE_TREE = {
  uid: 'n0', depth: 0,
  title: '首页',
  rawTitle: '首页',
  note: null,
  image: 'home.png',     // 文件名要和 screenshots/ 里实际文件一致
  children: [ /* ... */ ]
};
```

### 4.3 把截图放进去

所有截图扔到 `Projects/my-new-project/screenshots/`，**文件名必须和 `node.image` 字段完全一致**。

### 4.4 打开浏览器

```
http://localhost:8000/Projects/my-new-project/Prototype.html
```

---

## 5. 在浏览器里怎么用

### 5.1 浏览

- **左侧树** — 点节点跳转、搜索、展开/折叠。红点 = 该子树有未解决评论。
- **中间手机框** — 当前节点的截图，子节点自动以**热点**形式叠加。
- **右上工具栏** — 评论模式、热点显隐、导入导出、AI 定位等。

### 5.2 快捷键

| 键 | 作用 |
|---|---|
| `←` / `→` | 上一屏 / 下一屏 |
| `↑` | 返回父节点 |
| `H` | 切换热点显隐 |
| `C` | 切换评论模式 |
| `Esc` | 关闭弹窗 |
| `Cmd/Ctrl + Enter` | 评论快速保存 |

### 5.3 AI 自动定位热点

子节点的热点位置一开始是默认值（堆在右下角），需要定位到截图里对应的按钮/文字上：

1. 打开父节点（有截图、有子节点的那种）
2. 点工具栏 **🤖 自动定位** —— 单节点
3. 弹出审核 UI，看每个候选热点是否对齐 → 确认 → 保存
4. 不准的用 **Shift+拖拽** 手动微调（标记为 `manual: true`）
5. 想批量跑 → **🤖 全部自动定位**，会**自动跳过所有子节点都已手动微调的父节点**（保护手动结果）

**定位走的链路**（按优先级）：
1. 本地 OCR 服务（`localhost:8788`）— macOS Vision OCR + 字符串匹配 + 智谱 glm-4-flash 语义补漏
2. Claude Code Web 内置 `window.claude`（仅在 Claude Code Web 预览环境下可用）
3. 直连智谱视觉 LLM（兜底，限流严、精度一般）

**只要 `start.sh` 起着，链路 1 就生效**，性能：

| 场景 | 耗时 |
|---|---|
| 单图首次（5 切片并行 OCR + LLM 匹配）| ~8 秒 |
| 同一张图重跑（OCR 缓存命中）| <100 ms |

### 5.4 评论

- 进入评论模式（`C` 键或工具栏按钮）→ 点截图任意位置打针
- 评论可拖动、编辑、解决、删除
- 未解决评论：左侧树节点亮红点，工具栏徽章显示全局总数

### 5.5 替换截图

直接把新图**拖拽**到手机框上 —— 覆盖当前节点的截图。原图随时可一键切回对比。

---

## 6. 导出与分享

工具栏 **📤 导出** 给两种格式：

| 格式 | 大小 | 适合场景 |
|---|---|---|
| **轻量 JSON** | 几十 KB | 双方本地有相同截图包 → 通过 IM/邮件传 |
| **完整归档 JSON** | 几 MB | 跨设备完整搬迁，含所有截图 Blob |

同事拿到 JSON → **📥 导入** → 选合并策略：

- **以导入为准**（推荐）— 完全用对方的状态覆盖本地
- **以本地为准** — 保留本地，仅补充对方独有的项
- **智能合并** — 按时间戳逐项合并

---

## 7. 数据存在哪

所有评论 / 热点位置 / 替换截图都在**当前浏览器**的：

- **localStorage** — `proto:<PROJECT_ID>:comments_v1` / `hs_positions_v1` / `img_overrides_v1`
- **IndexedDB** — 库 `proto_imgs__<PROJECT_ID>`，存截图 Blob

⚠️ **换浏览器 / 清缓存 / 换设备会丢**。重要状态记得**导出 JSON 备份**。

多项目通过 `PROJECT_META.id` 命名空间完全隔离，不会互相污染。

---

## 8. 常见问题

| 问题 | 解决 |
|---|---|
| 截图全部加载失败 | 用 `http://localhost:8000/...` 访问，别用 `file://` |
| AI 定位按钮一直转圈 | 检查 `start.sh` 是否还在跑、`localhost:8788/health` 能否访问 |
| AI 定位返回 429 | 智谱被限流了，等几分钟重试；批量跑时已默认串行 |
| AI 定位精度差 | 截图过长（>3000px）可能切片拼接偏移几十像素，用 Shift+拖手动微调 |
| 导出弹 prompt 被浏览器拦截 | Chrome 在非前台 tab 拦截 prompt，切到前台再操作 |
| 想换 AI 模型 | `export ZHIPU_MATCH_MODEL=glm-4-plus` 后再 `start.sh`。**不要用 reasoning 模型如 glm-4.6，长 prompt 会被智谱断连** |

---

## 9. 相关文档

- [`README.md`](README.md) — 项目顶层介绍
- [`Template/README.md`](Template/README.md) — 工具本体完整文档（schema、快捷键细节、协作流程图）
- [`MIGRATION.md`](MIGRATION.md) — AI 识图架构详解、环境变量、性能特性
- [`CLAUDE.md`](CLAUDE.md) — 给 Claude Code 看的架构与陷阱说明
