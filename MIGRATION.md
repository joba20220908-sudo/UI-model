# 搬家到 Claude Code Web 指南

> 这个项目从 Claude.ai 设计 sandbox 迁出来,到 Claude Code Web / 本地环境继续开发。
> **搬家前/后有几件事必须做,否则会丢数据或踩坑。**

---

## ⚠️ 搬家前必做:导出浏览器里的评审数据

MindDeck 的所有**评论、热点微调、截图替换**都存在**当前浏览器**的 localStorage + IndexedDB 里,跟着项目源码走是**不会带过去的**。

### 怎么导

1. 打开 `Projects/hnw-licai/Prototype.html`
2. 点工具栏的 **📤 导出** 按钮
3. 建议导出**"完整归档"(含图片 Blob)** —— 包含:
   - 所有评论(解决/未解决)
   - 所有热点位置微调
   - 所有拖拽替换过的截图
   - 本地 localStorage 的全部状态
4. 把导出的 JSON 存到 `backup/` 目录(不会被 git 追踪,我已经在 `.gitignore` 里排除了)

### 搬家后

到新环境打开 `Prototype.html`,点 **📥 导入**,选刚才的 JSON。三种合并策略:
- **以导入为准**(推荐,相当于完全恢复)
- **以本地为准**
- **智能合并**(按时间戳)

---

## 🐛 已知待修 bug

### 1. `<img>` onerror 误触发(Claude.ai sandbox 环境专属)

**症状**:在 sandbox preview 里打开 Prototype,很多截图明明文件存在、`fetch()` 能拿到,但 `<img>` 标签会触发 `onerror`,显示占位符。

**定位**:怀疑是 sandbox 的 serve 层对 `Content-Type` 或 CORS 的处理跟本地 HTTP server 不一致。

**预期**:**搬到本地 / Claude Code Web 后大概率自动消失**。如果没消失,从这几个方向查:
- Chrome DevTools Network 面板看图片请求的 response headers
- 检查 `app.js` 里构造 `<img>` 的地方,有没有 crossOrigin 属性冲突
- 试试直接用 `python -m http.server 8000` 跑,vs file:// 协议打开,对比表现

### 2. 长图 AI 自动定位准确率

当前用 Claude 视觉 API 识别热点坐标,**超长图(高度 > 3000px)**分块后拼接坐标偶尔偏移几十像素。Shift+拖可以手动微调,但自动定位精度还可以提升。

---

## 🛠 在 Claude Code Web 怎么跑起来

```bash
# 1. clone 下来
git clone https://github.com/joba20220908-sudo/UI-model.git minddeck
cd minddeck

# 2. 起个本地服务(避免 file:// 协议的 CORS 限制)
python -m http.server 8000
# 或者
npx serve .

# 3. 浏览器打开
#    http://localhost:8000/Projects/hnw-licai/Prototype.html
```

**不需要 npm install**,这是纯 HTML + vanilla JS,零依赖。

---

## 📋 接下来可以做的事(给新环境的 Claude Code)

按优先级:

1. **修 `<img>` onerror bug**(如果搬到本地后还存在)
2. **抽离 app.js**(目前 ~1800 行单文件,可以按功能拆成模块:`tree.js` / `hotspots.js` / `comments.js` / `storage.js`)
3. **改造成可部署的 Web App**
   - 加个简单的 Node/Express 后端,支持多人共享同一份评审状态
   - 或者改成 PWA,离线可用
4. **XMind 解析脚本化**
   - 当前靠对话让 Claude 读 `.xmind` 生成 `data.js`
   - 可以写个 `scripts/parse-xmind.js`,一条命令搞定
5. **热点 AI 定位 API 抽象**
   - 现在是直接调 `window.claude.complete`
   - 抽一层 adapter,方便切换到 OpenAI / 本地模型
6. **加测试** —— 至少给 `storage.js` / 热点坐标转换写单测

---

## 🗂 仓库文件地图(搬家后看这里找东西)

| 路径 | 干嘛的 |
|---|---|
| `Template/` | 空壳模板,开新项目复制这个 |
| `Template/README.md` | **工具本体完整文档,先读这份** |
| `Projects/hnw-licai/` | 目前主要在做的评审项目 |
| `debug/tree.json` | XMind 解析出的原始树结构 |
| `debug/upload-match-report.txt` | 上传图 ↔ 树节点的匹配报告 |
| `parsed/` | XMind 解压后的中间文件 |
| `uploads/` | 用户从 sandbox 上传的原始图(可能已 ignore) |

---

## 联系

有问题直接在 Claude Code Web 里问新的 Claude 实例,把这份 MIGRATION.md 和 `Template/README.md` 丢给它,上下文就够了。
