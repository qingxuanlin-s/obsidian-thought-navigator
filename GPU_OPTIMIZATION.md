# CytoscapeRenderer GPU 性能优化方案

## 问题概述

插件运行时 GPU 占用偏高，根本原因是 **8 个独立的 overlay 系统各自监听相同的 `zoom/pan/drag` 事件，各自调度独立的 `requestAnimationFrame`，在同一帧内全部执行**，导致每帧数百次 DOM 位置重算和 GPU 合成。

---

## 一、8 个独立 rAF 更新循环

每次缩放/平移时，以下系统各自独立触发 `requestAnimationFrame`：

| # | 系统 | 代码位置 | 事件监听 | 每帧更新量 | 去重 |
|---|------|---------|---------|-----------|------|
| 1 | 嵌入预览卡片 | ~L1939-1950 | `zoom pan viewport drag position dragfree` | N 个嵌入节点位置 | 有 |
| 2 | 图片预览卡片 | ~L2310-2321 | `zoom pan viewport drag position dragfree` | N 个图片节点位置 | 有 |
| 3 | 节点徽章（下划线+备注） | ~L2770-2792 | `pan zoom viewport drag position` + 6 个额外事件 | 3×N 个节点 | 有 |
| 4 | 折叠按钮 | ~L2922-2931 | 11 个事件 | N 个父节点 | 有 |
| 5 | 连接手柄 | ~L3073-3093 | `pan zoom viewport drag position dragfree` | N 个非分组节点 | 有 |
| 6 | 边控制点 | ~L3380-3404 | `zoom pan position drag viewport dragfree` | 每条选中边 | 有 |
| 7 | 边端点手柄 | ~L3570-3581 | `zoom pan viewport drag position` | 每条选中边 2 个手柄 | **无** |
| 8 | 分组 resize 手柄 | ~L6642-6653 | `pan zoom viewport position` | 4 个手柄 | **无(同步)** |

**影响**：一次 pan 操作 → 7~8 个独立 rAF 回调 + 同步 DOM 更新。假设图中有 10 个嵌入预览 + 5 个图片 + 50 个节点徽章，单帧内产生 **500+ 次 DOM 位置重算**。

---

## 二、GPU 合成开销大的 CSS 属性

### box-shadow（10+ 处）

每次位置变化都需要重绘阴影：

- 嵌入预览卡片：`box-shadow: 0 10px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)` (~L1651)
- 图片预览卡片：同上 (~L2076)
- 备注徽章：`box-shadow: 0 2px 8px rgba(0,0,0,0.28)` (~L2607)
- 备注 tooltip：`box-shadow: 0 8px 24px rgba(0,0,0,0.32)` (~L2631)
- 连接手柄：`box-shadow: 0 2px 4px rgba(0,0,0,0.3)` (~L3030)
- 边控制点：`box-shadow: 0 2px 6px rgba(0,0,0,0.35)` (~L3343)

### backdrop-filter（1 处）

- 徽章容器：`backdrop-filter: blur(4px)` (~L2730)，强制 GPU 合成层

### linear-gradient（2 处）

- 嵌入/图片预览卡片背景：`background: linear-gradient(180deg, ...)` (~L1648, ~L2073)

### transition 与逐帧更新冲突（6+ 处）

以下 `transition` 属性会在 JS 逐帧写入 `style.left/top` 时产生冲突：

- resize 手柄：`transition: opacity 0.15s ease` (~L1710, ~L2144)
- tooltip：`transition: opacity 0.12s ease, transform 0.12s ease` (~L2637)
- 连接手柄：`transition: opacity 0.2s` (~L3032)

---

## 三、无视口裁剪

所有 overlay 系统的更新循环遍历**全部**元素，包括屏幕外不可见的：

```typescript
badgeUpdaters.forEach(updater => updater());   // 所有徽章，不管是否在视口内
handleUpdaters.forEach(updater => updater());  // 所有手柄，不管是否在视口内
updaters.forEach(fn => fn());                  // 所有预览卡片，不管是否在视口内
```

---

## 四、无共享坐标缓存

每个系统独立查询相同数据：

```typescript
// 系统 1
const zoom = this.cy.zoom();
const bb = node.renderedBoundingBox();

// 系统 2（相同节点，相同帧）
const zoom = this.cy.zoom();
const bb = node.renderedBoundingBox();

// ...系统 3~8 同理
```

---

## 优化方案

### 方案 1：合并为单一 rAF 调度器（优先级：高，收益：大）

将 8 个独立的 `scheduleUpdate` 合并为一个全局调度器：

```typescript
private overlayUpdateScheduled = false;
private overlayUpdaters: Array<() => void> = [];

private scheduleOverlayUpdate(): void {
    if (this.overlayUpdateScheduled) return;
    this.overlayUpdateScheduled = true;
    requestAnimationFrame(() => {
        this.overlayUpdaters.forEach(fn => fn());
        this.overlayUpdateScheduled = false;
    });
}
```

只注册一次事件监听：

```typescript
this.cy.on('zoom pan viewport drag position dragfree', () => {
    this.scheduleOverlayUpdate();
});
```

各 overlay 系统只需将自己的 updater 注册到 `this.overlayUpdaters` 中。

**预期效果**：8 个 rAF → 1 个 rAF，事件监听数量减少 80%。

### 方案 2：视口裁剪（优先级：高，收益：大）

在 updater 中增加视口检测，跳过不可见元素：

```typescript
const updatePosition = () => {
    const bb = node.renderedBoundingBox();
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;

    // 不在视口内的元素跳过更新，隐藏 overlay
    if (bb.x2 < 0 || bb.x1 > containerWidth || bb.y2 < 0 || bb.y1 > containerHeight) {
        card.style.display = 'none';
        return;
    }
    card.style.display = '';
    // ...正常更新位置
};
```

**预期效果**：大图中节点数量多时，实际更新量减少 50~80%。

### 方案 3：简化 GPU 开销大的 CSS（优先级：中，收益：中）

| 当前 | 优化后 | 说明 |
|------|--------|------|
| `box-shadow: 0 10px 24px rgba(...)` | `border: 1px solid rgba(...)` | 阴影改为边框，减少合成开销 |
| `backdrop-filter: blur(4px)` | 移除或改为纯色背景 | blur 强制创建 GPU 合成层 |
| `linear-gradient(...)` | 纯色 `background-color` | 减少渐变渲染开销 |
| `transition: opacity 0.15s` (在逐帧更新元素上) | 移除 transition | 避免与 JS 逐帧位置写入冲突 |

### 方案 4：修复无去重的 rAF（优先级：高，收益：中）

**边端点手柄**（~L3570）：添加 `scheduled` 标志防止重复触发

```typescript
let endpointScheduled = false;
const scheduleUpdate = () => {
    if (endpointScheduled) return;
    endpointScheduled = true;
    requestAnimationFrame(() => {
        this.updateEndpointHandlePosition(sourceHandle, sourceNode, edge, 'source');
        if (targetHandle) {
            this.updateEndpointHandlePosition(targetHandle, targetNode, edge, 'target');
        }
        endpointScheduled = false;
    });
};
```

**分组 resize 手柄**（~L6642）：改为 rAF 包裹

```typescript
let groupResizeScheduled = false;
this.cy.on('pan zoom viewport', () => {
    if (!selectedGroup || groupResizeScheduled) return;
    groupResizeScheduled = true;
    requestAnimationFrame(() => {
        updateHandlePositions();
        groupResizeScheduled = false;
    });
});
```

### 方案 5：共享坐标缓存（优先级：低，收益：小）

在统一 rAF 回调开头缓存本帧常用数据：

```typescript
requestAnimationFrame(() => {
    // 帧级缓存，所有 updater 共享
    const frameZoom = this.cy.zoom();
    const framePan = this.cy.pan();
    const frameViewport = {
        width: this.container.clientWidth,
        height: this.container.clientHeight
    };

    this.overlayUpdaters.forEach(fn => fn(frameZoom, framePan, frameViewport));
    this.overlayUpdateScheduled = false;
});
```

**预期效果**：减少重复 API 调用开销，对大节点数量场景有帮助。

---

## 优先级排序

| 优先级 | 方案 | 预期 GPU 降幅 | 改动范围 |
|--------|------|-------------|---------|
| P0 | 修复无去重 rAF（端点手柄 + 分组手柄） | 10~15% | 小（2 处） |
| P1 | 合并为单一 rAF 调度器 | 30~40% | 大（重构 8 个系统） |
| P2 | 视口裁剪 | 20~30% | 中（各 updater 加判断） |
| P3 | 简化 CSS 属性 | 10~15% | 小（样式替换） |
| P4 | 共享坐标缓存 | 5~10% | 中（统一接口） |

---

## 关键代码位置索引

| 代码位置 | 内容 |
|---------|------|
| CytoscapeRenderer.ts ~L1939-1950 | 嵌入预览 rAF 循环 |
| CytoscapeRenderer.ts ~L2310-2321 | 图片预览 rAF 循环 |
| CytoscapeRenderer.ts ~L2770-2792 | 徽章 rAF 循环 |
| CytoscapeRenderer.ts ~L2922-2931 | 折叠按钮 rAF 循环 |
| CytoscapeRenderer.ts ~L3073-3093 | 连接手柄 rAF 循环 |
| CytoscapeRenderer.ts ~L3380-3404 | 边控制点 rAF 循环 |
| CytoscapeRenderer.ts ~L3570-3581 | 边端点手柄 rAF（无去重） |
| CytoscapeRenderer.ts ~L6642-6653 | 分组 resize 手柄（同步更新） |
| CytoscapeRenderer.ts ~L1651, 2076, 2607, 2631, 3030, 3343 | box-shadow |
| CytoscapeRenderer.ts ~L2730 | backdrop-filter: blur |
| CytoscapeRenderer.ts ~L1710, 2144, 2637, 3032 | transition 冲突 |
