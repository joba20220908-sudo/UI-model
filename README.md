# MindDeck

> 从 XMind 到产品评审的一站式流水线 —— 把脑图里的产品结构变成可点、可评论、可追踪的交互式评审工具。

本仓库是 **MindDeck 工具本体** + **一个实际评审项目 (hnw-licai)** 的集合。

---

## 仓库结构

```
.
├── Template/                # 📦 MindDeck 工具模板(空壳,用来开新项目)
│   ├── Prototype.html       #    入口页(含所有 CSS + 布局)
│   ├── app.js               #    主逻辑 (~1800 行)
│   ├── data.js              #    节点树 + 项目元信息
│   ├── screenshots/         #    截图目录
│   └── README.md            #    工具本体的详细文档(推荐先看这份)
│
├── Projects/                # 🗂 实际评审项目
│   └── hnw-licai/           #    高净值理财评审(当前主要工作内容)
│       ├── Prototype.html
│       ├── app.js
│       ├── data.js
│       ├── screenshots/     #    24 张截图
│       └── README.md
│
├── Prototype.html           # 🧪 根目录的调试版(可能与 Template 不同步)
├── app.js
├── data.js
├── screenshots/             # 共 133 张图(根目录旧版本遗留)
│
├── debug/                   # 调试脚本、中间产物、对照表
├── parsed/                  # XMind 解析中间文件
├── uploads/                 # 用户上传的图(从 sandbox 导进来的)
│
├── MIGRATION.md             # ⚠️ 搬家到 Claude Code Web 前必读
└── README.md                # (本文件)
```

---

## 快速开始

**先开哪个**:打开 `Projects/hnw-licai/Prototype.html`,这是目前最完整的实例。

**工具本体用法**:见 `Template/README.md`,里面有完整的 schema、快捷键、协作流程说明。

**搬家到本地/Claude Code Web**:**先读 `MIGRATION.md`**,里面列出了必须导出的 localStorage 数据、已知 bug、后续开发线索。

---

## 主要功能一览

- 🧭 节点树导航(搜索 / 展开折叠 / 层级缩进)
- 📱 iOS 原型预览(带状态栏/刘海,自动缩放)
- 🎯 子节点热点自动叠加在父截图上(Shift+拖拽微调)
- 🤖 Claude 视觉辅助自动定位热点坐标
- 🧲 热点拖拽时边/中线自动吸附
- 💬 任意位置打针评论,支持编辑/解决/删除
- 🔴 未解决评论全局红点追踪
- 🖼 拖拽替换截图,原始图可一键切换对比
- 📤 JSON 导入/导出(轻量版 vs 含 Blob 完整版)
- 🔀 多项目 localStorage / IndexedDB 隔离

---

## 项目起源

- **Mind** = XMind 脑图
- **Deck** = 一叠可翻的卡片屏幕

在 Claude.ai 的设计 sandbox 环境里迭代了 ~20 轮后,达到当前状态。
现在迁移到 Claude Code Web / 本地,寻求更顺手的长期维护环境。

---

**当前版本**: v1.0
