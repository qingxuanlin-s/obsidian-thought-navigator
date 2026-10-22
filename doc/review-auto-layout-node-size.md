# 自动布局与节点框大小 Code Review

- 日期：2026-10-22
- 分支：`review/auto-layout-node-size`（基于 `master` 的 8cf3848）

## 概览

一共发现 3 个应该优先修复的问题：

- 只有一个子节点时，父节点会被挪到子节点上。
- 文件级的布局 preset 从来没有被读取。
- 二级及以下文件节点的框宽和文字换行宽度不一致。

其余问题主要是两类：各处的尺寸口径不统一；文本节点异步测出真实高度后，没有触发重排。

| 模块 | 关键文件 |
| --- | --- |
| 自动布局引擎 | `src/utils/autoLayoutEngine.ts`、`src/utils/growthDirection.ts` |
| 视图侧重排与后处理 | `src/view/indexView.ts`（`relayoutAutoLayoutSiblings` 10542、`resolveSiblingBranchInfluenceCollisions` 8789、`resolveAutoSiblingVerticalOverlaps` 10371） |
| Headless 布局 | `src/view/index/mocHandler.ts`（`applyHeadlessAutoLayout`、`measureTextNodeBox`） |
| 节点尺寸 | `src/renderer/stylesheet.ts`、`src/renderer/renderPipeline.ts`、`src/renderer/domTextMeasurer.ts`、`src/renderer/nodeBadges.ts`（`applySizes`） |

---

## 一、自动布局

### 高优先级

#### A1. 只有一个子节点时，父节点被"居中"到子节点身上

位置：`src/view/indexView.ts:10854`

```ts
nodePositions[id] = (maxY - minY) >= (maxX - minX)
    ? { x: cur.x, y: round2((minY + maxY) / 2) }
    : { x: round2((minX + maxX) / 2), y: cur.y };
```

只有一个子节点时，两个跨度都是 0，`0 >= 0` 成立，所以总是去对齐 y：

- **top-down**：子节点在父节点正下方，父节点的 y 被改成子节点的 y，两个节点完全重叠。
- **radial**：父节点被拉到斜向子节点所在的那一行，离开了原来的对角线。即使有多个子节点，这一步也只沿 x 或 y 中的一条轴移动，和对角线方向的堆叠轴不一致。

建议：把居中这一步移进 `computeAutoLayout`，沿引擎已知的 `layout.stackAxis` 取子节点投影的中点，不要再靠跨度大小去猜轴。

#### A2. 文件级布局 preset 从来没有被读取，布局一直用全局设置

位置：

- `indexView.ts:10814`、`indexView.ts:3525`、`mocHandler.ts:507` 都直接用 `settings.autoLayoutDefaultGrowthDirection`。
- `mocData.layoutPreset` 只在创建时写入（`mocHandler.ts:162/534`）。全库搜不到布局时读取它的地方。

后果：

- 修改全局设置后，所有旧文件在下一次重排时都会换成新方向。这和"创建时锁定"的设计相反。
- 用户的选择会被丢掉。场景：文件 preset 是 `bidirectional`，全局设置后来改成了 `radial`，用户把某个分支设成 `bidirectional`。
  - `setNodeLayoutPreset`（`mocHandler.ts:1704`）发现它等于文件 preset，于是删掉了这个覆盖。
  - 视图（`indexView.ts:10242`）发现它不等于全局值，于是在内存里保留了覆盖。
  - 结果文件里没有这个覆盖，重排时仍按 `radial` 来排，用户的设置没有生效，刷新后也不会恢复。

建议：`currentLayoutPreset` 和传给引擎的 `layoutPreset` 都改用 `mocParseResult.layoutPreset`，没有时才回退到全局设置。

### 中优先级

#### A3. 反方向的子节点组会压回父节点一侧

位置：`autoLayoutEngine.ts:205-207`、`267-279`

在深层节点下，如果有子节点被 SIDE_PINNED 固定到对侧，会触发分组放置：W 组以父节点为中心往回铺开。但 `subtreeSpan` 只统计了堆叠轴上各组的最大值，没有考虑这组往回延伸会侵入祖父节点和兄弟分支的区域。

最后由 `resolveSiblingBranchInfluenceCollisions` 兜底。但它只按"相对父节点的方向"给兄弟分组，处理不到这种跨层的覆盖。

#### A4. `resolveAutoSiblingVerticalOverlaps` 默认堆叠方向是竖直的

位置：`indexView.ts:10371`

它固定按 y 排序、往下推，只适用于 bidirectional：

- top-down 下，y 是生长方向，往下推会把兄弟节点推进下一层。
- radial 下同样不对。

另外它只检查节点自身的矩形、不看子树，被推开的兄弟的子树仍可能和别的节点相交。

建议：改用 `getAutoStackAxis(direction, preset)`，沿堆叠轴推开，并按子树范围检测碰撞。

#### A5. 碰撞消解只往一个方向推，会破坏对称

位置：`indexView.ts:8890-8902`

有重叠时，排在后面的分支会沿轴正方向推开，之后父节点和根节点都不会重新居中。插入几次之后，一级分支会越来越偏向一边，根节点不再居中。

建议：推完后把整组平移 `-distance/2`，或者在消解之后再做一次居中。

#### A6. 文本节点高度是异步才定下来的，但布局在那之前就读取了尺寸

位置：`nodeBadges.ts:1975`（`applySizes`）、`indexView.ts:10590`（`getNodeSize`）

`applySizes` 会在 Markdown overlay、MathJax 渲染完成后才把节点撑到真实高度，而布局用的是当时的 `outerHeight()`。节点变高之后不会触发重排，多段落或带公式的文本节点就会和兄弟重叠。

建议：在 `applySizes` 里检测到高度变化超过阈值时，发一个防抖的重排事件。

#### A7. 判断节点是否被收起，用的是 ID 前缀

位置：`indexView.ts:10631`

`nodeId.startsWith(collapsedId + '.')` 对自由节点无效：自由节点的 ID 是扁平的，父子关系只记录在边上。收起一个自由节点后，它下面的 auto 子岛仍会参与布局，而且尺寸会被压到 80×44 的保底值。另外它对每个节点都要遍历一遍收起集合，复杂度是 O(N·C)。

建议：直接用渲染层已有的 `node.hasClass('zk-collapsed-hidden')`。

### 低优先级与清理项

- **最小尺寸有三套标准**：`getNodeSize` 是 80×44（`indexView.ts:10591`），`getLayoutNodeSize` 是 160×64（`indexView.ts:8755`），占位符是 100×80（`stylesheet.ts`）。引擎和碰撞检测看到的节点大小不一致，建议统一成一个函数。
- **同一次新建会写两次文件**：`reflowNewAutoNodeSubtree` 先在 relayout 里落盘一次，`resolveAutoSiblingVerticalOverlaps` 再落盘一次。如果每次落盘都会生成一个撤销快照（尚未核实），一次新建就会占掉 7 步撤销里的 2 步。
- **两段上溯循环几乎一样**（`indexView.ts:10725-10763`）：唯一区别是"有保存位置就停"这一条，可以合成一个循环，用一个标志控制。
- **魔法数重复**：`applyNewSiblingSide` 里硬编码了 `315`，`events.ts:964` 也手动同步了一份 `150`。建议从引擎导出 `forwardGap` 和 `stackGap`。
- **`buildLayout` 和 `getDirection` 是递归实现**：树很深时理论上有栈溢出风险，目前的使用场景可以接受。

---

## 二、节点框大小

### 高优先级

#### S1. 二级及以下文件节点：框宽不设上限，但文字在 280px 处换行

位置：`stylesheet.ts:193`、`211-228`、`99-122`

- 基础 `node` 规则设置了 `text-max-width: 280px` 和 `text-wrap: wrap`。
- 框宽来自 `measureSingleLineFileNode`，等于"一行文字的全宽 + padding"，没有上限。
- 框高只按 `\n` 的行数计算。

标题超过 280px（字号 20px 时大约 14 个汉字）时，框是一个很宽的单行框，里面的文字却折成了两三行。左右会空出很多，行数多了文字还会溢出框外。一级节点和根节点都正确设置了 `text-max-width = wrapWidth`，只有这一层漏了。

建议二选一：

- 给这一层补上 `'text-max-width': measureSingleLineFileNode(...).wrapWidth`；
- 或者给框宽设一个上限，并按换行后的行数计算高度。

### 中优先级

#### S2. 测量和渲染用的字体不一样

| 用途 | 字体 |
| --- | --- |
| canvas 测宽（`renderPipeline.ts:623`） | `system-ui, -apple-system, sans-serif` |
| Cytoscape 渲染（stylesheet 没有设置 `font-family`） | 默认的 `Helvetica Neue, Helvetica, sans-serif` |
| 文本节点的 DOM 测量和 overlay | `var(--font-text)` |

文件节点是用 A 字体测量、B 字体渲染，长标题会出现截断或多余的空白；`safetyPx = 8` 只能盖住短标题的误差。

建议：在 stylesheet 里显式设置 `font-family`，并和 canvas 测宽保持一致。

#### S3. headless（CLI）布局的尺寸和视图对不上

位置：`mocHandler.ts:12-34`、`466`

- `sizeOf(n.target, depth)` 对所有节点都套用文本节点的公式。但视图里文件节点用的是 `measureSingleLineFileNode`，padding 不同（40/57 对 72/44），而且不换行。
- `target` 是链接路径，不是显示标题。
- 字号写死成 `24` 和 `20`，没有引用 `FIRST_LEVEL_NODE_FONT_SIZE`。注释也承认需要手动同步。

建议：把 `computeAutoTextMetrics` 和 `measureSingleLineFileNode` 抽成一个独立的纯函数模块，让 stylesheet 和 mocHandler 共用。

#### S4. 手动尺寸在不同层级的处理规则不一样

- 根节点文本：有 `manualHeightModel` 就直接返回，内容超出时会被裁剪。其他层级用的都是 `max(manual, auto)`。
- 一级文件节点：遵守手动高度，但忽略手动宽度。
- 二级及以下文件节点：手动宽度和高度都忽略。

拖动调整大小后，各层级的表现不一致。

### 低优先级

- **`renderPipeline.ts:616` 里有两个真实的 NUL 字节**：在 `cacheKey` 模板字符串里被当作分隔符。这会让 `file` 把它识别为 `data`，grep 和 `git diff` 也会把整个文件当成二进制，以后改这个文件时看不到 diff。改成 `'|'` 或转义写法 `\u0000` 即可。
- **换行宽度有三种口径**：文本节点的 `text-max-width` 分别是 `w-48`、`w-52`、`w-76`，而测量用的 paddingX 是 72、72、88。overlay 可见时 canvas 文字是隐藏的，所以平时影响不大，但 overlay 出来之前的第一帧会不一致。
- **`measureNodeLabel` 的兜底估算不看字号**：`charWidth` 默认是 8，不随 `fontSize` 变化（`mocHandler.ts:30`、`CytoscapeRenderer.ts:1528`）。20px 的字按 8px 估算，宽度会严重偏小。
- **根节点文本仍用 `charWidth: 18` 估算宽度**：没有用 DOM 实测，中英文混排时误差比较大。高度之后会被 `applySizes` 修正，宽度不会。

---

## 算法评估

现有引擎是"子树包围盒堆叠"：自底向上累计子树跨度，再自顶向下分槽位。理论上更紧凑的方案是 non-layered tidy tree（van der Ploeg 2014，支持可变节点尺寸的 Reingold–Tilford），它按子树轮廓压缩。但思维导图（例如 XMind 的逻辑图）通常也用包围盒堆叠，结果规整、可预期。这次发现的都是实现缺陷，算法本身没问题；换算法要同时重写引擎、碰撞消解和 headless 三处。**结论：保留现有算法，只修实现缺陷。**

## 结论修正

- **A2**：设置项的说明是"当自动布局分支没有单独设置生长方向时使用"，所以全局设置实时作用于未单独设置的分支，这是设计如此。真正的 bug 只有一个：`setNodeLayoutPreset` 拿过时的 `mocData.layoutPreset` 来比较，导致用户的选择被误删。`mocData.layoutPreset` 目前是不会被读取的元数据。
- **A7**：渲染层本身也是按 ID 前缀收起节点（`layoutAdapter.ts:294`），布局和渲染表现一致，不算 bug。如果以后要让自由节点也能收起子节点，两处需要一起改。

## 修复记录（分支 `review/auto-layout-node-size`）

| 编号 | 状态 | 改动 |
| --- | --- | --- |
| A1 | 已修复 | `computeAutoLayout` 新增 `recenterParents` / `recenterSkipIds`，沿 `layout.stackAxis` 把父节点移到子节点投影区间的中点；删除视图里按 x/y 跨度猜轴的后处理。跳过根节点、分支起点，以及子节点方向不一致的节点 |
| A2 | 已修复 | `mocHandler.setNodeLayoutPreset` 改为和全局默认生长方向比较 |
| A4 | 已修复 | `resolveAutoSiblingVerticalOverlaps` 改为沿 preset 对应的堆叠轴排序和推开 |
| S1 | 已修复 | 基础 `node` 规则的 `text-max-width` 改为和 `measureSingleLineFileNode` 的框宽同源；文本节点和占位节点保持 280 |
| NUL 字节 | 已修复 | `renderPipeline.ts` 的缓存 key 分隔符改为 `\|`，文件恢复为文本文件 |
| A3、A5、A6 | 未修 | 涉及碰撞模型，以及渲染层和布局层之间的事件联动，需要单独设计 |
| S2、S3、S4 | 未修 | 换字体会改变所有节点的外观；抽取尺寸模块是重构；手动尺寸的规则需要先定产品语义 |

验证：`npm run build` 通过。另外把引擎单独打包，用脚本跑了 top-down、bidirectional、radial 三种 preset，分别测 1 个和 3 个子节点：父节点只沿堆叠轴移动，不再和子节点重叠。

## 建议修复顺序

1. **A1**：单子节点时父节点重叠。改动小，用户能直接看到。
2. **A2**：读取文件级 preset，同时修掉分支 preset 被丢弃的问题。
3. **S1**：补上二级文件节点的 `text-max-width`。
4. **S2 + S3**：统一字体和尺寸计算，抽成一个共享模块。
5. **A6**：`applySizes` 改变高度后触发重排。
6. **A4 / A5**：碰撞消解改为沿堆叠轴，并保持对称。
7. 其余低优先级项可以顺手清理。
