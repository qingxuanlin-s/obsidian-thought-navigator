# 自动布局：Preset + 分支级风格 + 拖动学习

## 背景与目标

当前 `relayoutAutoLayoutSiblings`（`src/view/indexView.ts:6134`）：
- 根节点固定 **4 正交方向**（E/W/N/S），`quantizeDirection` 吸附到最近的水平/竖直轴。
- 非根节点继承父方向；无法让某个分支换风格。
- 拖动节点不影响后续自动布局规则。

## 目标

1. 提供 **3 个整树 preset**：`bidirectional`（默认）/ `top-down` / `radial`。
2. **全局设置**有自动风格默认生长方向；**根节点的第一层子代**可覆盖自己分支内部的 preset。
3. **更深层节点强制继承**所在分支的 preset，不可独立覆盖。
4. **拖动 MOC 根的第一层子代，或第一层分支的直接子代** → 学习它相对父节点的方向；量化方向池由当前 preset 决定。
5. 已有 `nodePositions` / `nodeLayoutStyle` / `nodeLayoutOverrides` 不破坏。

---

## 一、Preset 模型

### 定义

```ts
// src/utils/growthDirection.ts（新文件）

export type GrowthDirection = 'E' | 'NE' | 'N' | 'NW' | 'W' | 'SW' | 'S' | 'SE';
export type LayoutPreset = 'bidirectional' | 'top-down' | 'radial';

const R = Math.SQRT1_2; // ≈ 0.7071

export const DIR_VECTORS: Record<GrowthDirection, { x: number; y: number }> = {
    E:  { x:  1, y:  0 },
    NE: { x:  R, y: -R },
    N:  { x:  0, y: -1 },
    NW: { x: -R, y: -R },
    W:  { x: -1, y:  0 },
    SW: { x: -R, y:  R },
    S:  { x:  0, y:  1 },
    SE: { x:  R, y:  R },
};

// 每个 preset 允许的"方向池"
export const PRESET_POOL: Record<LayoutPreset, GrowthDirection[]> = {
    'bidirectional': ['E', 'W'],
    'top-down':      ['S'],
    'radial':        ['NE', 'SE', 'SW', 'NW'],
};

// 堆叠轴 = 方向向量逆时针 90°
export function stackAxisOf(dir: GrowthDirection): { x: number; y: number } {
    const v = DIR_VECTORS[dir];
    return { x: -v.y, y: v.x };
}

// 把任意 (dx, dy) 量化到方向池里最近的方向
export function quantizeToPool(dx: number, dy: number, pool: GrowthDirection[]): GrowthDirection {
    let best = pool[0];
    let bestDot = -Infinity;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    for (const dir of pool) {
        const v = DIR_VECTORS[dir];
        const dot = v.x * ux + v.y * uy;
        if (dot > bestDot) { bestDot = dot; best = dir; }
    }
    return best;
}

// 节点矩形在轴 a 上的投影长度
export function projectSize(size: { width: number; height: number }, axis: { x: number; y: number }): number {
    return Math.abs(size.width * axis.x) + Math.abs(size.height * axis.y);
}
```

### 3 个 preset 的视觉含义

| Preset | 方向池 | 典型用途 | 示意 |
|---|---|---|---|
| `bidirectional`（默认） | `E` / `W` | 经典思维导图 | 根在中间，左右两侧开花 |
| `top-down` | `S` | 流程图、时间轴、组织结构图 | 根在顶，一路向下 |
| `radial` | `NE` / `SE` / `SW` / `NW` | 发散式笔记 / 四斜角张力 | 四象限开花 |

---

## 二、存储 Schema

### 新增字段

```ts
// MOCParseResult 里
layoutPreset?: LayoutPreset;                       // MOC 文件级默认
nodeLayoutPresets?: Record<string, LayoutPreset>;  // 根的第一层子代覆盖
```

### Mermaid `ext:{}` 元数据

```json
{
    "layout_preset": "bidirectional",
    "node_layout_presets": {
        "a": "top-down",
        "b": "radial"
    }
}
```

### 写入校验

```ts
async setNodeLayoutPreset(mocFile, nodeId: string, preset: LayoutPreset | null) {
    await this.modifyMOCData(mocFile, (mocData) => {
        // 只允许根的第一层子代
        if (!this.isFirstLevelChild(mocData, nodeId)) {
            throw new Error(`节点 ${nodeId} 不是根的第一层子代，不能独立 preset`);
        }
        mocData.nodeLayoutPresets ||= {};
        if (preset === null) delete mocData.nodeLayoutPresets[nodeId];
        else mocData.nodeLayoutPresets[nodeId] = preset;
    });
}

private isFirstLevelChild(mocData, nodeId): boolean {
    // 根节点的直接子节点 = ID 只有一段（如 'a'）且有子节点（非叶子）
    // 或从树结构直接判断：该节点的父是某个根节点
    return mocData.nodes.some(root => root.children.some(c => c.nodeID === nodeId));
}
```

### 需要改动的文件

1. `src/utils/utils.ts` → `MOCParseResult` 加 `layoutPreset`, `nodeLayoutPresets`
2. `src/utils/mermaidParser.ts#parseMetadata` → 读 `layout_preset`, `node_layout_presets`
3. `src/utils/mermaidSerializer.ts#serializeMetadata` → 写这两个
4. `src/utils/mocJsonCodec.ts` → schema + 读写
5. `src/view/index/mocHandler.ts` → deepCopy 拷贝 + 新增 `setNodeLayoutPreset`
6. `src/utils/growthDirection.ts`（新文件）→ preset / 方向向量 / 工具函数

---

## 三、Preset 解析算法（每个节点确定自己属于哪个 preset）

```text
resolvePreset(node):
    // 根节点本身：使用文件级默认
    if node 是 MOC 根:
        return mocData.layoutPreset ?? 'bidirectional'

    // 根节点的第一层子代：查 override，没查到则用全局默认
    if node 的父 是 MOC 根:
        return mocData.nodeLayoutPresets[node.id]
            ?? mocData.layoutPreset
            ?? 'bidirectional'

    // 更深层：递归向上，找到所在"第一层分支"的 preset
    return resolvePreset(node.parent)
```

**语义**：
- **MOC 根** 用文件级 preset。
- **第一层**（根的直接子代）是**分支起点**，可以独立选 preset。
- 第一层 preset 控制的是该分支内部子节点的生长方式，不控制该第一层节点自身相对 MOC 根的位置。
- **第一层以下** 全部继承它所在分支的 preset —— 不允许自己选。

---

## 四、方向解析（分三种情况）

对任意节点 `n`，确定它从父节点延伸过来的方向：

```text
resolveDirection(n):
    parent = n 的父节点

    // Case 1: MOC 根的第一层子代 → 用全局默认 preset 分配/学习它在根两侧的位置
    if parent 是 MOC 根 and nodePositions[n.id] 存在 and parent 位置已知:
        pool = PRESET_POOL[globalDefaultPreset]
        dx = nodePositions[n.id].x - parent.x
        dy = nodePositions[n.id].y - parent.y
        return quantizeToPool(dx, dy, pool)

    if parent 是 MOC 根:
        pool = PRESET_POOL[globalDefaultPreset]
        return pool[ indexAmongSiblings(n) % pool.length ]

    // Case 2: 第一层分支的直接子代 → 用该分支 preset 分配/学习分支内部方向
    if parent 是根的第一层子代:
        pool = PRESET_POOL[resolvePreset(parent)]
        if nodePositions[n.id] 存在 and parent 位置已知:
            dx = nodePositions[n.id].x - parent.x
            dy = nodePositions[n.id].y - parent.y
            return quantizeToPool(dx, dy, pool)
        return pool[ indexAmongSiblings(n) % pool.length ]

    // Case 3: 更深层 → 继承父节点方向
    return resolveDirection(parent)
```

### 三种情况为什么是这样

- **Case 1**：用户拖过 MOC 根的第一层子代 = 显式表达该大分支在根周围的位置。
- **Case 2**：用户拖过第一层分支的直接子代 = 显式表达该分支内部方向意图。
- 无保存位置时按兄弟序号轮询分配：
  - `bidirectional`: 子 1 → E, 子 2 → W, 子 3 → E, 子 4 → W …
  - `top-down`: 全 S
  - `radial`: 子 1 → NE, 子 2 → SE, 子 3 → SW, 子 4 → NW, 子 5 → NE …
- **Case 3**：更深层递归继承，保证子树沿直线延伸，视觉稳定。

---

## 五、布局算法（两阶段）

### 阶段 A：buildLayout（自底向上计算子树跨度）

```ts
interface LayoutNode {
    id: string;
    size: { width: number; height: number };
    dir: GrowthDirection | null;  // 只有真实 MOC 根为 null；局部重排起点不一定为 null
    stackAxis: { x: number; y: number } | null;
    preset: LayoutPreset;
    children: LayoutNode[];
    subtreeSpan: number;  // 堆叠轴上的总占用
}

function buildLayout(node, ctx): LayoutNode {
    const preset = resolvePreset(node, mocData);
    const dir = ctx.realMocRootIds.has(node.id)
        ? null
        : resolveDirection(node, mocData, preset);
    const stackAxis = dir ? stackAxisOf(dir) : null;

    const children = node.children.map((c) => buildLayout(c, ctx));
    const childrenSpan = children.reduce((s, c) => s + c.subtreeSpan, 0)
                       + Math.max(0, children.length - 1) * STACK_GAP;
    const selfSpan = stackAxis ? projectSize(node.size, stackAxis) : 0;

    return { id: node.id, size: node.size, dir, stackAxis, preset, children,
             subtreeSpan: Math.max(selfSpan, childrenSpan) };
}
```

### 阶段 B：placeLayout（自顶向下放置）

```ts
function placeLayout(layout, cx, cy) {
    positions[layout.id] = { x: cx, y: cy };
    if (layout.children.length === 0) return;

    const isMocRoot = layout.dir === null;  // 真实 MOC 根（虚拟起点）

    if (isMocRoot) {
        // 根：按方向分组后每组独立铺开
        placeRootGrouped(layout, cx, cy);
        return;
    }

    // 非根：单一方向延伸
    placeDirectedChildren(layout, cx, cy);
}

function placeDirectedChildren(layout, cx, cy) {
    const dirVec = DIR_VECTORS[layout.dir];
    const axis = layout.stackAxis;

    const forward = projectSize(layout.size, dirVec) / 2
                  + FORWARD_GAP
                  + avgChildProjection(layout.children, dirVec) / 2;

    const total = layout.children.reduce((s, c) => s + c.subtreeSpan, 0)
                + Math.max(0, layout.children.length - 1) * STACK_GAP;
    let cursor = -total / 2;

    for (const child of layout.children) {
        const stackOff = cursor + child.subtreeSpan / 2;
        const childX = cx + dirVec.x * forward + axis.x * stackOff;
        const childY = cy + dirVec.y * forward + axis.y * stackOff;
        placeLayout(child, childX, childY);
        cursor += child.subtreeSpan + STACK_GAP;
    }
}

function placeRootGrouped(root, cx, cy) {
    // 按 child.dir 分组
    const groups = new Map<GrowthDirection, LayoutNode[]>();
    for (const child of root.children) {
        if (!child.dir) continue;
        (groups.get(child.dir) ?? groups.set(child.dir, []).get(child.dir)!).push(child);
    }

    for (const [dir, children] of groups) {
        const dirVec = DIR_VECTORS[dir];
        const axis = stackAxisOf(dir);
        const forward = projectSize(root.size, dirVec) / 2
                      + FORWARD_GAP
                      + avgChildProjection(children, dirVec) / 2;

        const total = children.reduce((s, c) => s + c.subtreeSpan, 0)
                    + Math.max(0, children.length - 1) * STACK_GAP;
        let cursor = -total / 2;

        for (const child of children) {
            const stackOff = cursor + child.subtreeSpan / 2;
            const childX = cx + dirVec.x * forward + axis.x * stackOff;
            const childY = cy + dirVec.y * forward + axis.y * stackOff;
            placeLayout(child, childX, childY);
            cursor += child.subtreeSpan + STACK_GAP;
        }
    }
}
```

**参数**（建议默认）：
- `FORWARD_GAP = 150`
- `STACK_GAP = 56`
- 对角方向：`FORWARD_GAP *= 1.2`（斜线视觉上"显得近"，加大间距）

---

## 六、拖动学习（本质：已有位置即已学习）

**核心观察**：拖动学习不需要单独的机制——`nodePositions` 已经存了用户手动拖过的位置。

Case 1/2（§四）的实现就是："如果可学习层级有保存位置，用它相对父节点的向量量化到 preset 方向池"。

```text
用户拖节点 → 触发 'node-position-changed' → nodePositions[id] 更新
下次 autolayout → resolveDirection 在可学习层级检测到 nodePositions[id] 存在
              → quantizeToPool(dx, dy, PRESET_POOL[preset])
              → 该节点相对父节点的方向"学"到了
```

**两个关键约束**（防混乱）：
1. 拖动学习只作用于两类节点：MOC 根的第一层子代、第一层分支的直接子代。更深层依旧走"继承父方向"，即使被拖过也不学习（它的位置只用于视觉微调，下次 autolayout 会根据父方向重算）。
2. 拖动产生的方向必须**落在 preset 的方向池里**：
   - `bidirectional` 下拖到上方 → 量化结果还是 E 或 W（选夹角小的那个）
   - `top-down` 下拖任何地方 → 都量化到 S
   - `radial` 下拖任何地方 → 量化到最近的斜角

**不需要额外模块**：改进 `resolveDirection` 的可学习层级判断就够了。实现时必须显式判断 `parent 是 MOC 根` 或 `parent 是第一层分支`，不能让更深层节点从 `nodePositions` 学方向。

---

## 六点五、局部重排边界

当前 `relayoutAutoLayoutSiblings(parentNodeId)` 可能从任意节点开始重排，而不是总从真实 MOC 根开始。因此实现必须区分：

- **真实 MOC 根**：`mocData.nodes` 里的顶层节点。只有它们的 `dir` 是 `null`，子节点按方向分组铺开。
- **当前重排起点**：本次调用传入的 `parentNodeId`。如果它不是真实 MOC 根，就必须先通过真实父链解析自己的 `preset` 和 `dir`，再把它的子树按该方向继续排布。

`computeAutoLayout` 的输入不应只包含 `tree + rootPos`，还应包含：

- `relayoutRootId`：本次重排起点。
- `realMocRootIds`：真实 MOC 根集合。
- `parentById` / `childrenById`：完整父子关系，不只局部子树。
- `nodeSizes` / `currentPositions`：来自 Cytoscape 的尺寸与当前位置。
- `nodePositions`：来自 MOC metadata 的已保存位置，用于第一层拖动学习。
- `isAutoNode(id)`：保留 `nodeLayoutStyle` / `nodeLayoutOverrides` 的 auto/free 继承语义。

这样可以避免局部重排时把普通分支误当成 MOC 根，导致布局方向突然重置。

---

## 七、UI 交互

### 1. MOC 文件级 preset 切换

**位置**：索引视图顶部工具栏或 MOC 设置弹窗。
**控件**：下拉或 3 选 1 按钮组：`经典双向` / `上下结构` / `四斜角发散`。
**触发**：调 `mocHandler.setMocLayoutPreset(mocFile, preset)` → 清除 `nodeLayoutPresets` 里和新默认冲突的项（可选）→ relayout。

### 2. 第一层子代 preset 覆盖

**位置**：节点右键菜单，**只在节点是根的第一层子代时显示**该项。
**控件**：子菜单 "本分支布局" → 3 选 1 + "使用默认"。

```ts
// 右键菜单追加（仅当 isFirstLevelChild 时）
if (isFirstLevelChild(node)) {
    menu.addItem(item => item.setTitle('本分支布局').setIcon('layout')
        .setSubmenu()
        .addItem(i => i.setTitle('经典双向').onClick(() => setPreset(node.IDStr, 'bidirectional')))
        .addItem(i => i.setTitle('上下结构').onClick(() => setPreset(node.IDStr, 'top-down')))
        .addItem(i => i.setTitle('四斜角').onClick(() => setPreset(node.IDStr, 'radial')))
        .addSeparator()
        .addItem(i => i.setTitle('使用默认').onClick(() => setPreset(node.IDStr, null)))
    );
}
```

### 3. 拖动学习

**自动发生**，无 UI。用户不需要知道"学习"概念 —— 拖完位置就固化了，下次 autolayout 沿用。

---

## 八、实现步骤

### Step 1: 数据层 & 工具函数（无 UI 风险，可先落地）

- [ ] 新建 `src/utils/growthDirection.ts`
  - `GrowthDirection`, `LayoutPreset` 类型
  - `DIR_VECTORS`, `PRESET_POOL`, `stackAxisOf`, `quantizeToPool`, `projectSize`
- [ ] `src/utils/utils.ts`：`MOCParseResult` 加 `layoutPreset?`, `nodeLayoutPresets?`
- [ ] `src/utils/mermaidParser.ts#parseMetadata`：读 `layout_preset`, `node_layout_presets`
- [ ] `src/utils/mermaidSerializer.ts#serializeMetadata`：写这两个
- [ ] `src/utils/mocJsonCodec.ts`：schema + 读写
- [ ] `src/view/index/mocHandler.ts`：
  - `deepCopyMOCResult` 拷贝新字段
  - 新增 `setMocLayoutPreset(mocFile, preset)`
  - 新增 `setNodeLayoutPreset(mocFile, nodeId, preset | null)`（带 `isFirstLevelChild` 校验）

### Step 2: 算法层（纯函数可单测）

- [ ] 在 `src/utils/growthDirection.ts` 或新文件 `src/utils/autoLayoutEngine.ts` 写：
  - `computeAutoLayout(input): Record<nodeId, {x, y}>`
  - 内部的 `resolvePreset` / `resolveDirection` / `buildLayout` / `placeLayout`
- [ ] 老 `relayoutAutoLayoutSiblings` 重写为薄包装：
  - 从 cy 里拿完整父子关系、节点树、节点大小、当前位置
  - 调 `computeAutoLayout`
  - 把结果写回 `cy.position()` + `mocData.nodePositions`

### Step 3: UI 层

- [ ] 顶部工具栏 preset 切换按钮组
- [ ] 节点右键菜单（仅第一层子代显示"本分支布局"）
- [ ] 触发 autolayout 后刷新视图

### Step 4: 迁移测试

- [ ] 老 MOC 无 `layout_preset` 时默认 `bidirectional` → 语义上最接近经典思维导图；原先已有 N/S 第一层方向会被归并到 E/W
- [ ] `nodeLayoutStyle: 'free'` 的 MOC 完全不跑 autolayout，无影响
- [ ] 自由节点、箭头关系节点、跨领域节点继续跳过

---

## 九、关键决策记录

### D1. 为什么 preset 只能覆盖到第一层？

**避免嵌套混乱**。允许任意深度等于回到了 per-node 方向覆盖的心智复杂度。第一层 = "大分支" 粒度足以表达 "同一 MOC 里不同分支不同风格"。

### D2. 拖动学习的方向池是否应该等于"preset 池 ∪ 其他"？

**不**。方向池严格等于 preset 池。理由：
- 如果拖到池外还能学，用户体验上就是 preset 失效
- 想要换方向 = 切 preset，语义清晰

### D3. 拖动学习是否作用于所有层级？

**否，只第一层**。深层节点即使被拖过，下次 autolayout 也按父方向继承重算（位置会被覆盖）。这是"直线延伸"视觉稳定性的保证。
- **例外**：自由布局模式（`nodeLayoutStyle: 'free'`）下，所有位置都保留。

### D4. 默认 preset 是 `bidirectional` 还是 `radial`？

**`bidirectional`**。理由：
- 最接近现行 4 正交的视觉（至少 E/W 两个方向一致）
- 符合经典思维导图认知
- 用户想要斜角效果，主动切 `radial` 即可

### D5. 不同 preset 分支空间打架怎么办？

**第一期不管**。观察：
- 不同 preset 通常走不同象限（E/W vs S vs 四斜角），打架概率较低
- 真打架时用户可以切 preset 或手动微调拖开
- 第二期再考虑象限隔离或碰撞检测

---

## 十、估算

| 模块 | 改动量 | 风险 |
|---|---|---|
| `growthDirection.ts` 新文件 | ~90 行 | 低（纯函数） |
| 数据层（Parser/Serializer/Codec/Handler） | ~80 行 | 低 |
| `computeAutoLayout` 重写 | ~200 行（替换 `indexView.ts:6134-6373`） | 中（核心逻辑） |
| UI（工具栏 + 右键菜单） | ~60 行 | 低 |
| **合计** | **~430 行** | |

预计 2-3 个下午。
