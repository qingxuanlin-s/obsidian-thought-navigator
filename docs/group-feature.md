# 分组功能实现文档

## 功能概述

分组功能允许用户通过 Command/Ctrl + 鼠标拖动创建矩形选择框，将多个节点划分到一个分组中。分组信息会保存到 MOC 文件的 `ext` 对象中。

## 使用方法

### 创建分组

1. 按住 **Command (Mac)** 或 **Ctrl (Windows/Linux)** 键
2. 在图形视图中按住鼠标左键并拖动，创建矩形选择框
3. 释放鼠标后，会弹出对话框要求输入分组名称
4. 输入分组名称后点击"确认"，分组将被创建并保存

### 修改分组名称

1. **双击**分组名称（红色虚线矩形顶部的文字）
2. 在弹出的对话框中输入新的分组名称
3. 点击"确认"保存修改

### 删除分组

1. **右键点击**分组名称
2. 在弹出的菜单中选择"删除分组"
3. 分组将被删除，但节点不会被删除

**或者**：

1. **点击选中**分组（分组边框会高亮）
2. 按 **Delete** 或 **Backspace** 键
3. 分组将被删除

### 分组显示

- 分组会以淡红色虚线边框的矩形显示（`#fca5a5`）
- 分组名称显示在矩形顶部中央（淡红色文字）
- 分组内的节点会自动归属到该分组

## 箭头关系管理

### 编辑关系文本

1. **双击**箭头关系（虚线边）
2. 在边的中点位置会出现一个内联输入框
3. 直接输入新的关系描述（可为空）
4. 按 **Enter** 键或点击其他地方自动保存
5. 按 **Escape** 键取消编辑

**特点**：
- 内联编辑，无需弹窗
- 输入框跟随图形缩放和平移
- 自动聚焦并选中当前文本
- 失去焦点时自动保存

### 删除箭头关系

**方法一：右键菜单**
1. **右键点击**箭头关系（虚线边）
2. 在弹出的菜单中选择"删除箭头关系"
3. 箭头关系将从 MOC 文件中删除

**方法二：键盘快捷键**
1. **点击选中**箭头关系（边会高亮显示）
2. 按 **Delete** 或 **Backspace** 键
3. 箭头关系将从 MOC 文件中删除

**注意**：
- 只能删除箭头关系（虚线），不能删除父子关系（实线）
- 删除箭头关系会从 MOC 文件中移除对应的 `-->` 行
- 删除后自动刷新视图

## 技术实现

### 1. 交互实现 (`CytoscapeRenderer.ts`)

#### 拖动选择框
```typescript
bindGroupCreationEvents(): void
```
- 监听 `mousedown`、`mousemove`、`mouseup` 事件
- 检测 Command/Ctrl 键是否按下
- 创建半透明的蓝色虚线选择框
- 计算矩形内的节点

#### 自定义输入对话框
```typescript
showGroupNameDialog(callback: (name: string | null) => void): void
```
- 替代 Electron 不支持的 `prompt()` 函数
- 使用 Obsidian CSS 变量实现主题适配
- 支持 Enter 确认、Escape 取消
- 点击遮罩层关闭对话框

#### 分组创建
```typescript
createGroupFromNodes(nodes: any[]): void
```
- 生成唯一的分组 ID：`group_${timestamp}`
- 提取节点 ID 列表
- 触发 `group-create` 自定义事件

#### 分组重命名
```typescript
// 双击分组节点触发
cy.on('dbltap', 'node[?isGroup]', ...)
```
- 显示输入对话框，默认值为当前分组名
- 触发 `group-rename` 自定义事件

#### 分组删除
```typescript
// 右键分组节点触发
cy.on('cxttap', 'node[?isGroup]', ...)
```
- 显示右键菜单
- 触发 `group-contextmenu` 自定义事件

### 2. 数据保存 (`indexView.ts`)

#### 事件监听
```typescript
// 创建分组
branchGraphDiv.addEventListener('group-create', async (event: any) => {
    const { groupId, groupLabel, nodeIds } = event.detail;
    await this.saveGroupToMOC(mocFile, { id: groupId, label: groupLabel, nodeIds });
});

// 重命名分组
branchGraphDiv.addEventListener('group-rename', async (event: any) => {
    const { groupId, oldLabel, newLabel } = event.detail;
    await this.renameGroupInMOC(mocFile, groupId, newLabel);
});

// 删除分组
branchGraphDiv.addEventListener('group-contextmenu', async (event: any) => {
    const { groupId, groupLabel, position } = event.detail;
    // 显示右键菜单，提供删除选项
    await this.deleteGroupFromMOC(mocFile, groupId);
});
```

#### 保存到 MOC 文件
```typescript
saveGroupToMOC(mocFile: TFile, group: GroupInfo): Promise<void>
```
- 读取 MOC 文件内容
- 查找 `# 思维树` 标题范围
- 解析现有的 `ext` 对象
- 添加或更新分组信息
- 保存格式：`%% ext:{"node_positions":{...},"groups":[...]} %%`

#### 重命名分组
```typescript
renameGroupInMOC(mocFile: TFile, groupId: string, newLabel: string): Promise<void>
```
- 查找指定 ID 的分组
- 更新分组的 label 字段
- 保存回 MOC 文件

#### 删除分组
```typescript
deleteGroupFromMOC(mocFile: TFile, groupId: string): Promise<void>
```
- 查找指定 ID 的分组
- 从 groups 数组中移除
- 保存回 MOC 文件
- 注意：只删除分组，不删除节点

### 3. 数据解析 (`utils.ts`)

#### MOC 解析结果
```typescript
interface MOCParseResult {
    nodes: MOCTreeNode[];
    reverseRelations: Map<string, ReverseRelation>;
    nodePositions: Record<string, { x: number; y: number }>;
    groups: GroupInfo[];  // 新增：分组信息
    metadata: { ... };
}
```

#### 分组信息结构
```typescript
interface GroupInfo {
    id: string;           // 分组 ID，如 "group_1735824000000"
    label: string;        // 分组标签，如 "量子力学基础"
    nodeIds: string[];    // 包含的节点 ID 列表，如 ["a", "a.1", "a.2"]
    color?: string;       // 分组颜色（可选）
}
```

### 4. 渲染实现 (`CytoscapeRenderer.ts`)

#### 转换为 Cytoscape 元素
```typescript
convertToElementsWithGroups(data: GraphData): cytoscape.ElementDefinition[]
```
- 创建分组节点（compound nodes）
- 为分组内的节点设置 `parent` 属性
- 返回包含分组节点、普通节点和边的数组

#### 分组样式
```css
.group-node {
    background-color: transparent;
    background-opacity: 0;
    border-width: 2px;
    border-color: #ef4444;  /* 红色 */
    border-style: dashed;   /* 虚线 */
    label: data(label);
    text-valign: top;
    text-halign: center;
    padding: 20px;
}
```

## 数据格式示例

### MOC 文件中的 ext 对象
```markdown
# 思维树

- [[20251214-波函数]] `a` - 基础概念
  - [[20251215-薛定谔方程]] `a.1` - 核心方程
  - [[20251216-波函数坍缩]] `a.2` - 测量问题

%% ext:{"node_positions":{"a":{"x":100,"y":100},"a.1":{"x":300,"y":50},"a.2":{"x":300,"y":150}},"groups":[{"id":"group_1735824000000","label":"量子力学基础","nodeIds":["a","a.1","a.2"]}]} %%
```

### 解析后的数据结构
```typescript
{
    nodes: [...],
    reverseRelations: Map {},
    nodePositions: {
        "a": { x: 100, y: 100 },
        "a.1": { x: 300, y: 50 },
        "a.2": { x: 300, y: 150 }
    },
    groups: [
        {
            id: "group_1735824000000",
            label: "量子力学基础",
            nodeIds: ["a", "a.1", "a.2"]
        }
    ],
    metadata: { ... }
}
```

## 已知问题和限制

1. **Electron 环境限制**
   - 原生 `prompt()` 不可用，已使用自定义对话框替代
   - 自定义对话框使用 Obsidian CSS 变量，确保主题兼容

2. **分组编辑**
   - ✅ 支持创建分组
   - ✅ 支持重命名分组（双击分组名）
   - ✅ 支持删除分组（右键分组名）
   - ❌ 暂不支持添加/移除分组成员

3. **分组样式**
   - 分组颜色固定为红色
   - 暂不支持自定义分组颜色

## 未来改进方向

1. **分组管理**
   - ✅ 删除分组功能（已实现）
   - ✅ 编辑分组名称（已实现）
   - ⏳ 分组成员管理（添加/移除节点）

2. **交互优化**
   - 支持点击分组边框选中整个分组
   - 支持拖动分组移动所有成员节点
   - 支持折叠/展开分组

3. **视觉优化**
   - 支持自定义分组颜色
   - 支持分组图标
   - 支持分组描述

4. **数据管理**
   - 支持分组导出/导入
   - 支持分组模板
   - 支持分组统计信息

## 相关文件

- `src/renderer/CytoscapeRenderer.ts` - 分组创建交互和渲染
- `src/view/indexView.ts` - 分组保存和事件监听
- `src/utils/utils.ts` - 分组数据解析
- `src/renderer/GraphDataBuilder.ts` - 分组数据传递
- `src/renderer/types.ts` - 类型定义
