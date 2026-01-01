# Graph Renderer - Cytoscape.js 集成

这个目录包含了使用 Cytoscape.js 重构的图形渲染系统。

## 文件说明

### 核心文件

- **types.ts** - 类型定义和接口
  - `IGraphRenderer` - 渲染器接口
  - `GraphData` - 图形数据结构
  - `RenderOptions` - 渲染选项
  - `ViewState` - 视图状态

- **CytoscapeRenderer.ts** - Cytoscape.js 渲染器实现
  - 高性能图形渲染
  - 支持增量更新
  - 多种布局算法（dagre, cose, breadthfirst, grid）
  - 状态保持（zoom, pan, selection）

- **GraphDataBuilder.ts** - 图形数据构建器
  - 从现有数据结构构建 GraphData
  - 静态工厂方法简化使用
  - 自动构建节点和边的关系

- **GraphViewIntegration.example.ts** - 集成示例
  - 展示如何在 ZKGraphView 中使用
  - 事件处理示例
  - 增量更新示例

## 快速开始

### 1. 基本使用

```typescript
import { CytoscapeRenderer } from './renderer/CytoscapeRenderer';
import { GraphDataBuilder } from './renderer/GraphDataBuilder';

// 构建图形数据
const graphData = GraphDataBuilder.fromFamilyNodes(nodes, currentFile);

// 创建渲染器
const renderer = new CytoscapeRenderer();

// 渲染
await renderer.render(container, graphData, {
    layoutType: 'dagre',
    direction: 'TB',
    animate: true
});
```

### 2. 监听事件

```typescript
container.addEventListener('node-click', (event) => {
    const { node, ctrlKey, shiftKey, altKey } = event.detail;
    // 处理点击事件
});

container.addEventListener('node-hover', (event) => {
    const { node, event: mouseEvent } = event.detail;
    // 显示预览
});
```

### 3. 增量更新

```typescript
await renderer.update({
    addedNodes: [newNode],
    removedNodes: [oldNode],
    updatedNodes: [],
    addedEdges: [],
    removedEdges: [],
    updatedEdges: []
});
```

### 4. 状态管理

```typescript
// 保存状态
const state = renderer.getState();

// 恢复状态
renderer.setState(state);
```

## 布局算法

### dagre (推荐用于层级结构)
- 适合：家族图、树形结构
- 特点：清晰的层级关系，节点不重叠
- 配置：`layoutType: 'dagre'`

### cose (推荐用于网络结构)
- 适合：入链出链图、复杂关系网络
- 特点：力导向布局，自动优化节点位置
- 配置：`layoutType: 'cose'`

### breadthfirst (简单层级)
- 适合：简单的树形结构
- 特点：按层级广度优先排列
- 配置：`layoutType: 'breadthfirst'`

### grid (网格布局)
- 适合：节点数量较少，需要整齐排列
- 特点：网格状排列
- 配置：`layoutType: 'grid'`

## 性能优化

### 自动优化
- `hideEdgesOnViewport: true` - 视口外隐藏边
- `textureOnViewport: true` - 使用纹理加速
- `wheelSensitivity: 0.2` - 优化滚轮灵敏度

### 增量更新
- 只更新变化的节点和边
- 智能判断是否需要重新布局
- 变化超过 20% 时才重新布局

### 批量操作
- 使用 `cy.batch()` 批量更新
- 减少重绘次数

## 样式定制

渲染器使用 Obsidian 的 CSS 变量，自动适配主题：

- `--interactive-accent` - 节点背景色
- `--text-on-accent` - 节点文字颜色
- `--background-modifier-border` - 边框和连线颜色
- `--font-interface` - 字体

## 与现有代码集成

### 替换 Mermaid 渲染

**之前（Mermaid）：**
```typescript
const mermaid = await loadMermaid();
const { svg } = await mermaid.render('id', mermaidStr);
container.innerHTML = svg;
```

**之后（Cytoscape）：**
```typescript
const graphData = GraphDataBuilder.fromFamilyNodes(nodes, file);
const renderer = new CytoscapeRenderer();
await renderer.render(container, graphData, options);
```

### 保持现有功能

所有现有的交互功能都通过自定义事件保持：
- 节点点击（Ctrl/Shift/Alt 修饰键）
- 节点悬停预览
- 背景点击取消选择

## 下一步

1. 在 ZKGraphView 中集成 CytoscapeRenderer
2. 添加渲染引擎切换选项（Mermaid/Cytoscape）
3. 实现缓存和差异比对
4. 添加性能监控

## 参考

- [Cytoscape.js 文档](https://js.cytoscape.org/)
- [Dagre 布局](https://github.com/cytoscape/cytoscape.js-dagre)
- [CoSE-Bilkent 布局](https://github.com/cytoscape/cytoscape.js-cose-bilkent)
