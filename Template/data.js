// ============================================================================
// 数据文件 · data.js
// ----------------------------------------------------------------------------
// 这个文件描述本次评审的节点树(由 XMind 解析而来)。每次换新项目,
// 你需要:
//   1. 替换 PROJECT_META 里的 id / title / sub
//   2. 替换 PROTOTYPE_TREE 为新的节点树(由解析脚本自动生成)
//   3. 把对应的截图文件(以 node.image 的 UUID 为文件名)放进 screenshots/
// ============================================================================

// 项目元信息 — 用于顶部标题、localStorage 命名空间
// 注意:id 必须稳定唯一,修改它会让本地已有的评论/热点位置全部失联
window.PROJECT_META = {
  id: 'demo',                       // 项目唯一 ID,小写英文数字短横,改了等于新项目
  title: '示例项目',                // 顶部大标题
  sub: null                         // 副标题(null = 自动用节点/截图数统计)
};

// 节点树 — 标准结构:
//   {
//     uid: 'nXXX',         // 稳定唯一 ID,建议 'n' + 序号
//     depth: 0,            // 树深度
//     title: '展示用标题',
//     rawTitle: '原始标题(可带 要求/注 等)',
//     note: null | '要求:...' | '注:...',  // 从 rawTitle 抽出的备注,可选
//     image: null | 'uuid.png',             // 对应 screenshots/ 下的文件名,可选
//     children: [...]                        // 子节点,同结构递归
//   }
window.PROTOTYPE_TREE = {
  uid: 'n0',
  depth: 0,
  title: '示例项目',
  rawTitle: '示例项目',
  note: null,
  image: null,
  children: [
    {
      uid: 'n1', depth: 1,
      title: '首页',
      rawTitle: '首页',
      note: null,
      image: null,
      children: [
        {
          uid: 'n2', depth: 2,
          title: '功能入口 A',
          rawTitle: '功能入口 A',
          note: '要求:需要加上红点提示',
          image: null,
          children: []
        }
      ]
    },
    {
      uid: 'n3', depth: 1,
      title: '设置',
      rawTitle: '设置',
      note: null,
      image: null,
      children: []
    }
  ]
};
