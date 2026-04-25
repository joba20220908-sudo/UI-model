# MindDeck

> **从 XMind 到产品评审的一站式流水线** —
> 把脑图里的产品结构变成可点、可评论、可追踪的交互式评审工具。

![](./screenshots/.brand-placeholder)

---

## 这是什么

MindDeck 是一个**浏览器里运行的评审工具**,只需要一个 HTML 文件就能跑。

它吃一份 XMind 文件 + 一叠截图,吐出一个可以:
- 像翻**原型**一样按节点层级浏览每一页
- 像用**设计稿工具**一样在截图任意位置**打针评论**
- 像在**Jira** 里一样追踪"未解决项"
- 像**发邮件**一样把整个评审过程导出 JSON,发给同事继续接力

**零后端、零部署、零学习成本** —— 打开 HTML 就能用。

---

## 核心功能

| 模块 | 能做什么 |
|---|---|
| 🧭 **节点树导航** | 左侧大纲树,搜索、展开/折叠、层级缩进,跳转数徽章一眼看重点枢纽 |
| 📱 **iOS 原型预览** | 中间带状态栏/刘海的手机框,自动适配窗口缩放 |
| 🎯 **热点跳转** | 子节点自动以可点击热点叠加在父截图上,支持 Shift+拖拽微调位置/大小 |
| 🤖 **AI 自动定位** | 一键让 Claude 识别热点在截图里的像素坐标,长图自动分块识别 |
| 🧲 **对齐吸附** | 拖拽热点时自动匹配其他热点的边/中线,画粉色参考线 |
| 💬 **评论系统** | 点击任意位置打针,支持编辑/解决/删除,可拖动气泡,全局未解决计数 |
| 🔴 **红点追踪** | 左侧树节点有未解决评论自动亮红点,工具栏徽章统计全局总数 |
| 🖼 **截图替换** | 拖拽新图覆盖任意节点,原始图与替换图可一键切换对比 |
| 📤 **导入/导出** | JSON 存档(轻量版 or 含图片 Blob 的完整归档),三种合并策略 |
| 🔀 **多项目隔离** | localStorage 与 IndexedDB 按 project ID 命名空间隔离 |

---

## 快速开始

### 全新项目

1. **复制模板**
   ```
   cp -r Template/ MyProject/
   ```

2. **解析 XMind**
   把 `.xmind` 丢给 Claude 对话,让它:
   - 解压 → 读 `content.json`
   - 按 schema 生成 `data.js` 的 `PROTOTYPE_TREE`
   - 整理所需截图清单

3. **填充元数据**
   编辑 `MyProject/data.js`:
   ```js
   window.PROJECT_META = {
     id: 'my-project',      // 小写英文数字短横,改了等于新项目
     title: '我的项目',
     sub: null              // null 表示自动统计
   };
   window.PROTOTYPE_TREE = { ... };   // XMind 解析产物
   ```

4. **放截图**
   所有截图文件名需与 `node.image` 一致,放到 `MyProject/screenshots/`。

5. **打开 `Prototype.html`** —— 就这样。

---

## 数据结构

### `PROJECT_META`

```js
{
  id: string,       // 项目唯一 ID,是本地数据命名空间的依据
  title: string,    // 顶部标题
  sub?: string      // 副标题(null 则自动用节点/截图/要求数统计)
}
```

### `PROTOTYPE_TREE`(节点)

```js
{
  uid: string,             // 稳定唯一 ID,建议 'n' + 序号
  depth: number,           // 树深度
  title: string,           // 展示用标题
  rawTitle: string,        // XMind 原始标题
  note: string | null,     // 从 rawTitle 提取的"要求/注"文本
  image: string | null,    // screenshots/ 下的文件名(通常是 UUID.png)
  children: Node[]
}
```

---

## 多项目共存

同一浏览器下放多份 MindDeck(不同目录)**完全互不干扰**:
- localStorage key 带前缀 `proto:<PROJECT_ID>:`
- IndexedDB 分库 `proto_imgs__<PROJECT_ID>`

只要 `PROJECT_META.id` 各自独特,就放心并排用。

---

## 协作工作流

```
 ┌────────────┐   导出 light JSON    ┌────────────┐
 │  本地评审  │ ────────────────────▶│  同事导入  │
 │  产品经理  │                      │  UI 设计师 │
 └────────────┘ ◀──────────────────  └────────────┘
                  回传 light JSON
                  (选"以导入为准")
```

- **轻量 JSON**:几十 KB,传 IM / 邮件,双方本地要有相同的截图包
- **完整归档 JSON**:几 MB,含所有图片 Blob,跨设备完整搬迁

---

## 快捷键

| 键 | 作用 |
|---|---|
| `←` / `→` | 上一页 / 下一页 |
| `↑` | 返回父节点 |
| `H` | 切换热点显隐 |
| `C` | 切换评论模式 |
| `Esc` | 关闭弹窗 |
| `Cmd/Ctrl + Enter` | 评论快速保存 |

---

## 文件结构

```
MindDeck 项目/
├── Prototype.html   # 入口页,含所有 CSS + 布局结构
├── app.js           # 主逻辑(~1800 行)
├── data.js          # 本项目的节点树 + 元信息
├── screenshots/     # 本项目所有截图
└── README.md
```

---

**版本:** v1.0
**命名来源:** Mind(XMind 脑图)+ Deck(一叠可翻的卡片屏幕)
