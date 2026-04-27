# MindDeck 评审记录导出 / 导入回灌

## Context

MindDeck 当前的产物只有原型本身 + 散落在 localStorage 的评论。需求是把评审过程的产物（评审结论 + 待确认事项）形成可对外交付的会议纪要文档，并且支持反向：把外部纪要导入原型，由 LLM 匹配到对应页面，自动更新评论与状态，闭环到第一步导出。

目标：
1. **导出评审纪要文档**：以 **HTML 单文件为主**（直观、含截图、点开即看、可发邮件 / 内网共享），**Word .docx 为后备**（正式归档）
2. **导入纪要回灌**：LLM 匹配纪要段落 → 页面，产出 diff，用户审核后写入
3. **顺手优化工具栏**：现在 11 个按钮过于拥挤，归并为下拉菜单结构
4. 改动覆盖 Template + 所有外部副本（hnw-licai、hnw-licai-docx、my-new-project、移动端样例、根目录调试版），standalone 不同步（已脱节）

## 数据模型

**采用「两者结合」方案**：

### 扩展 comments（新增 `kind` 字段）
现有 schema 不动，仅在 comment 对象里加 `kind`：
```js
{
  id, xPct, yPct, text, status: 'open'|'resolved',
  createdAt, updatedAt,
  kind: 'comment' | 'todo'   // 缺省 = 'comment'，向后兼容
}
```
- `comment`：现有自由评论（细节讨论）
- `todo`：待确认事项（带 status 跟踪解决状态）

### 新增 per-node 整页结论
新 localStorage key：`proto:<id>:review_v1`
```js
{
  [uid]: {
    conclusion: string,        // 整页评审结论（自由文本）
    updatedAt: number,
    updatedBy?: 'manual'|'import'  // 区分导入回灌
  }
}
```

向后兼容：旧导出 JSON 没有 `review` 字段时按空对象处理；旧 comment 没有 `kind` 字段时视为 `'comment'`。

## 文件改动

### 1. `Template/app.js` — 核心逻辑（source of truth）

**a. 新增 review storage（评论模块附近，约 615 行后）**
- `loadReview()` / `saveReview()` / `getNodeReview(uid)` / `setNodeReview(uid, conclusion)`
- 复用现有 `LS_PREFIX` 模式

**b. 扩展 `buildExport`（line 356）**
新增字段：
```js
review: loadReview(),
todoCount: { open: ..., resolved: ... }  // 仅元数据，便于纪要文档摘要
```

**c. 扩展 `applyImport`（line 396）**
按相同的 replace / merge-keep / merge-overwrite 策略合并 `review`。

**d. 新增评审纪要文档导出 — `exportReviewDoc(format)`**

`format: 'html' | 'docx'`，遍历 `PROTOTYPE_TREE` 收集每个有内容（含 image 或评论或结论）的节点。

**HTML 单文件版（主交付物）—— 自包含、零外部依赖**

设计要点（一份独立的"评审报告网页"）：
- 单 `.html` 文件，截图全部内嵌为 base64（IDB 取 blob → base64），可直接邮件转发 / 内网放静态服务器
- **左侧目录**（sticky）：树形列出所有页面，标注未解决 todo 数 badge，点击 anchor 滚动
- **顶部摘要栏**：项目标题、导出时间、统计卡片（页面数 / 评论总数 / 未解决 todo / 已确认结论数）
- **每页区块**（`<section id="node-<uid>">`）：
  - 标题 + 路径面包屑
  - 截图缩略图（可点击放大到 lightbox，热点位置以红框标注覆盖）
  - **结论卡片**：醒目色块展示整页 conclusion（无则灰色"未填写"占位）
  - **待确认事项**：带状态徽标的列表（✓ 已解决 / ○ 待解决），未解决的高亮
  - **详细评论**：折叠式列表（默认折叠避免干扰），含 x%/y% 位置说明
- **过滤工具栏**（顶部固定）：仅看未解决 / 仅看有结论 / 全部
- 内联 CSS + 极少量 vanilla JS（折叠 / 过滤 / lightbox），保持零依赖原则
- 顶部加打印样式 `@media print`，可一键 `Ctrl+P` 存 PDF

**Word .docx 版（后备归档）**

策略：**前端只生成结构化 markdown + 提示文案**，告知用户"可拖到 Claude Code 让它用 docx skill 转换"，或后续如确有强需求再引入 docx UMD 库。理由：保持零依赖，docx 主要用于正式归档，节奏不紧。

> 备选：如果用户希望按钮一键拿到 docx，可在 `scripts/` 加个 Python 小工具（`python-docx`，已在 requirements 里），前端 download markdown 后自动 POST 到本地服务转换。当前不做，留作 phase 2。

**e. 新增「导入纪要回灌」入口 — `openReviewImportDialog()`**
- Modal：粘贴纪要文本 / 上传 .md / .txt / .docx 文件
- 提交后调用 `matchReviewToNodes(text)`：
  1. 收集 `PROTOTYPE_TREE` 所有节点的 `{uid, title, rawTitle, note, description}` 作为索引
  2. POST 到本地 OCR 服务的新端点 `/review-match`（见下文 #3）或直连智谱 `glm-4-flash`（实测：长 prompt 下 `glm-4.6` reasoning 通道易"Remote end closed"，已切回 flash）
  3. LLM 输出：
     ```json
     [
       {
         "nodeUid": "n12",
         "matchScore": 0.92,
         "matchReason": "纪要中提到'高净值首页'与节点 title 完全匹配",
         "newConclusion": "...",         // 可选，整页结论
         "newTodos": [{ "text": "...", "status": "open" }],
         "resolveTodoIds": ["c_xxx"],     // 已存在 todo 标记为 resolved
         "newComments": []                // 可选
       }
     ]
     ```
- 进入 **diff 审核 UI**（参考现有 hotspot 候选审核 `showHotspotCandidates` 的交互模式）：
  - 列出每条建议变更，每条带勾选框（默认勾上）+ "跳转到该页"按钮
  - 用户可编辑文本、取消某条、改 nodeUid（下拉选）
  - 「确认提交」批量写入 `comments_v1` + `review_v1`
- 失败保护：未匹配上的纪要段落汇总到「未识别段落」区，可手动指派 nodeUid

**f. 工具栏简化（顺带优化）**

现状（11 个按钮，拥挤）：
```
🔍 识别 | 批量 | 💬 评论 | 🔔 | 热点 | + 热点 | 📤 | 📥 | ↑ | ‹ | ›
```

整改后（5 组 + 导航）：
```
🔍 AI ▾   |   💬 评论 🔔   |   ⊞ 热点 ▾   |   📁 数据 ▾   |   ↑ ‹ ›
```

- **🔍 AI ▾** 下拉：识别当前页 / 批量识别全部
- **💬 评论 🔔**：合并按钮，点击进入评论模式 + 右上角红点显示未解决数（保留快捷键 C），长按或右键弹出"所有未解决评论列表"
- **⊞ 热点 ▾** 下拉：显示/隐藏热点 / 拖框新增热点
- **📁 数据 ▾** 下拉（**主入口扩张点**）：
  - 导出原型数据（JSON）
  - 导入原型数据（JSON）
  - ──────────
  - 📋 导出评审纪要（HTML）
  - 📄 导出评审纪要（Word）
  - 📝 导入会议纪要…
- **导航 ↑ ‹ ›** 保持不变

下拉用纯 CSS + 一个共享的 `.dropdown` 类，点击外部关闭（document click listener），不引入第三方库。

### 2. `Template/Prototype.html` — 工具栏 UI

替换 line 1115–1127 的 `.toolbar-btns` 整体结构为上述 5 组按钮 + dropdown menus。每个 dropdown 用：
```html
<div class="tbtn-group">
  <button class="tbtn" data-dd="data">📁 数据 ▾</button>
  <ul class="tbtn-menu" id="dd-data" hidden>
    <li data-act="export-json">导出原型数据 (JSON)</li>
    <li data-act="import-json">导入原型数据 (JSON)</li>
    <li class="sep"></li>
    <li data-act="export-review-html">📋 导出评审纪要 (HTML)</li>
    <li data-act="export-review-docx">📄 导出评审纪要 (Word)</li>
    <li data-act="import-review">📝 导入会议纪要…</li>
  </ul>
</div>
```
所有 dropdown 共用同一份 CSS（新增到 `<style>` 块），同一份点击外部关闭逻辑。

### 3. `scripts/ocr-locate-server.py` — 新增 `/review-match` 端点
- 复用现有 zhipu 调用代码（参考 OCR 服务里现有的 `glm-4-flash` 语义匹配）
- POST body：`{ nodes: [{uid, title, note, description, hasImage}], reviewText: string }`
- 用 `glm-4-flash`（实测：`glm-4.6` reasoning 通道处理 4K+ 字中文 prompt 时容易触发 "Remote end closed connection without response"；flash 通道稳定，且按章节切分后单段 prompt < 3K 字，匹配质量足够。详见 `scripts/ocr-locate-server.py` 顶部注释）
- 服务不可达时前端 fallback 到直连智谱（复用 `locator.js` 里的 `minddeck:zhipu_key` 用户 key 路径）

### 4. 多变体同步
改完 `Template/` 后，按 CLAUDE.md 「多变体同步」流程：
- `cp Template/app.js` → 5 个外部副本
- `cp Template/Prototype.html` 工具栏对应改动 → 5 个外部副本（手动 patch，因为各项目可能有自己的标题）
- standalone HTML 不同步（已脱节）

## 实现策略：HTML & docx

**HTML**：浏览器端原生组装字符串 + base64 内联截图，零依赖。模板分三部分：
- `<style>` 内联（cards / 折叠 / lightbox / print 媒体查询）
- `<aside>` 目录 + `<section>` 内容（服务端渲染，纯静态）
- `<script>` 末尾少量交互（折叠 / 过滤 / lightbox 打开）

**docx**：当前阶段不在浏览器内实现。点击"导出评审纪要 (Word)"实际下载等价的 markdown 文件，弹窗提示"可拖到 Claude Code 让其用 docx skill 转换为正式 .docx"。等真有强诉求时 phase 2 加一个 `scripts/md-to-docx.py`（python-docx，本地 8788 邻居端口）。

## 关键文件

- [Template/app.js](Template/app.js) — 主要改动（storage、export、import、UI handlers）
- [Template/Prototype.html](Template/Prototype.html:1122) — 工具栏按钮
- [scripts/ocr-locate-server.py](scripts/ocr-locate-server.py) — 新增 `/review-match` 端点
- 5 个副本同步：
  - `Projects/hnw-licai/app.js`
  - `Projects/hnw-licai-docx/app.js`
  - `Projects/my-new-project/app.js`（注意：模块化版本可能在 `comments-ui.js` / `export-ui.js` 拆分，需对应到模块）
  - `Projects/移动端个人高净值用户理财测试样例/app.js`
  - 根目录 `app.js`

## 复用的现有能力

- `loadComments` / `saveComments` / `addComment` / `updateComment`（[Template/app.js:564-601](Template/app.js:564)）— 直接给 todo 复用
- `buildExport` / `applyImport` 现有 schema 和 merge 策略（[Template/app.js:356/396](Template/app.js:356)）— 扩展即可，不破坏现有 JSON 兼容性
- `showHotspotCandidates` 的审核 UI 模式 — 复制为 `showReviewMatchCandidates`
- `locator.js` 里的智谱 key 取数路径（`minddeck:zhipu_key` localStorage）
- OCR 服务的 zhipu 调用与重试逻辑

## 验证

1. **导出 HTML 纪要路径**
   - 启动 `bash scripts/start.sh`
   - 在 hnw-licai 项目里加 2-3 条评论 + 1 条 todo + 1 条整页结论
   - 📁 数据 ▾ → 导出评审纪要 (HTML)，下载文件，离线打开：
     - 左侧目录 / 顶部摘要正确
     - 截图 base64 内嵌、点击放大 lightbox 工作
     - 结论卡片、todo 状态徽标显示无误
     - 顶部过滤"仅看未解决"能正确隐藏其他区块
     - `Ctrl+P` 打印预览样式合理
2. **导出 Word 占位**
   - 点击 Word 按钮 → 下载 markdown + 弹窗提示文案出现

3. **工具栏简化**
   - 检查 5 组按钮 + 导航布局，所有 dropdown 点外部关闭、键盘 Esc 关闭
   - 原有所有功能（评论模式 / 未解决列表 / 热点 / AI 识别 / 导出导入）都能从新菜单触达

4. **导入纪要回灌**
   - 准备一份手写纪要：包含 2 个明确页面的结论 + 1 个 todo 已解决的描述
   - 📁 数据 ▾ → 导入会议纪要…，粘贴文本，提交
   - 验证 LLM 匹配：每条建议命中正确 nodeUid，可勾选 / 编辑 / 跳页确认
   - 提交后回到原型，确认评论 / 结论已写入；再次导出 HTML，确认结论部分包含新内容

5. **向后兼容**
   - 用旧版 export JSON（无 `review` / 无 `kind`）执行导入，确认不报错且行为符合预期
   - 用新 schema 导入，确认 review 与 kind 都被正确合并（按 merge-keep / merge-overwrite / replace 三种策略）

6. **多项目隔离**
   - 在 hnw-licai 写入纪要后切到另一个项目，确认 `proto:<id>:review_v1` 只属于本项目，未泄漏

7. **服务降级**
   - 关闭 OCR 服务（kill :8788），导入纪要，确认前端 fallback 到直连智谱（需用户 key），有清晰错误提示
