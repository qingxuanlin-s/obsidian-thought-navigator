# 自由节点功能

## 功能概述

在 MOC 索引视图中，可以通过两种方式创建自由节点：
1. **双击空白处**：在分支图空白处双击
2. **点击按钮**：点击右上角的"添加自由节点"按钮

两种方式都会打开相同的对话框，功能完全一致。

**特别说明**：即使思维树中没有任何节点，也可以通过这两种方式创建第一个节点。

## 使用方法

### 方式一：双击空白处创建

1. 打开 MOC 文件（在索引视图中）
2. 在分支图的空白处**双击**
3. 在弹出的对话框中填写节点信息
4. 点击"确定"按钮
5. 节点会创建在你双击的位置

**适用场景**：
- ✅ 思维树为空时，创建第一个节点
- ✅ 在特定位置添加新节点
- ✅ 快速添加多个节点

### 方式二：点击按钮创建

1. 打开 MOC 文件（在索引视图中）
2. 点击右上角的"添加自由节点"按钮（➕图标）
3. 在弹出的对话框中填写节点信息
4. 点击"确定"按钮
5. 节点会创建在默认位置（由布局算法决定）

**适用场景**：
- ✅ 思维树为空时，创建第一个节点
- ✅ 不确定节点应该放在哪里
- ✅ 需要仔细填写节点信息

### 对话框功能

在"添加自由节点"对话框中，你可以：

- **选择或创建笔记**：输入笔记名称，支持自动补全
- **设置节点 ID**：自动生成建议的 ID，也可以手动修改
- **添加关系描述**：可选，描述节点的作用或关系
- **连接到现有节点**：可选，建立与其他节点的关系
- **设置连接关系**：描述连接的类型（如"引出"、"相关"等）

## 功能特点

### 空思维树支持

- ✅ **零节点启动**：即使思维树为空，也可以创建节点
- ✅ **友好提示**：空思维树时会显示提示信息
- ✅ **完整功能**：所有创建功能在空树时都可用

### 双击创建的优势

- **精确定位**：节点会创建在你双击的位置
- **快速操作**：无需移动鼠标到按钮
- **直观交互**：符合图形编辑软件的习惯

### 按钮创建的优势

- **稳定可靠**：不会因为误操作触发
- **功能完整**：可以访问所有高级选项
- **位置灵活**：创建后可以拖动到任意位置

### 共同特点

- **自动保存位置**：位置信息会自动保存到 MOC 文件
- **独立笔记**：每个自由节点对应一个独立的 Markdown 文件
- **唯一 ID**：自动生成唯一的节点 ID
- **关系建立**：可以与其他节点建立关系

## 文件结构

创建自由节点后，会：

1. 在 MOC 文件夹中创建新的笔记文件（如果选择创建新笔记）
2. 在 MOC 文件的思维树列表中添加节点引用
3. 在位置块中保存节点位置（双击创建时）

**示例：**

```markdown
# 思维树
---
node_positions:
  "a": { x: 150.00, y: 100.00 }
  "a.1": { x: 350.00, y: 80.00 }
  "free_node_1": { x: 500.00, y: 300.00 }
---

- [[量子力学基础]] `a` - 核心概念
  - [[波函数]] `a.1` - 引出
- [[新想法]] `free_node_1` - 自由节点
```

## 技术实现

### 事件流程（双击创建）

1. **双击空白处** → 触发 `background-dblclick` 事件
2. **调用方法** → 调用 `addFreeNodeToMOC(position)` 方法
3. **显示对话框** → 打开 `AddFreeNodeModal` 对话框
4. **用户填写** → 用户填写节点信息
5. **保存到 MOC** → 调用 `saveFreeNodeToMOC()` 保存节点
6. **保存位置** → 如果提供了位置，保存到位置块
7. **刷新视图** → 重新渲染图形

### 关键代码

**CytoscapeRenderer.ts** - 监听双击事件：
```typescript
this.cy.on('dbltap', (evt: any) => {
    if (evt.target === this.cy) {
        const position = evt.position;
        this.container?.dispatchEvent(new CustomEvent('background-dblclick', {
            detail: { 
                position: { x: position.x, y: position.y },
                event: evt.originalEvent 
            }
        }));
    }
});
```

**IndexView.ts** - 处理双击事件：
```typescript
branchGraphDiv.addEventListener('background-dblclick', async (event: any) => {
    const { position } = event.detail;
    await this.addFreeNodeToMOC(position);
});
```

**IndexView.ts** - 添加自由节点方法：
```typescript
async addFreeNodeToMOC(position?: { x: number; y: number }) {
    const suggestedID = this.generateNextFreeNodeID();
    
    new AddFreeNodeModal(
        this.app,
        this.plugin,
        this.mocNodes,
        suggestedID,
        async (result) => {
            await this.saveFreeNodeToMOC(result);
            
            // 如果提供了位置信息，保存节点位置
            if (position && result.file) {
                const mocFile = this.app.vault.getFileByPath(mocFilePath);
                if (mocFile && result.nodeID) {
                    await this.saveNodePositionToMOC(mocFile, result.nodeID, position);
                }
            }
            
            await this.refreshBranchMermaid();
        }
    ).open();
}
```

## 注意事项

1. **位置保存**：
   - 双击创建：位置会保存到双击的位置
   - 按钮创建：位置由布局算法决定，可以手动拖动调整

2. **节点 ID**：
   - 自动生成建议的 ID
   - 可以手动修改
   - 确保 ID 唯一性

3. **文件位置**：
   - 新笔记会创建在 MOC 文件夹中
   - 也可以选择现有的笔记

4. **刷新视图**：
   - 创建后会自动刷新视图显示新节点

## 使用建议

### 何时使用双击创建

- 需要精确控制节点位置
- 快速添加多个节点
- 在特定位置补充节点

### 何时使用按钮创建

- 需要仔细填写节点信息
- 建立复杂的节点关系
- 不确定节点应该放在哪里

## 未来改进

- [ ] 支持拖拽连线建立节点关系
- [ ] 支持删除自由节点
- [ ] 支持编辑节点属性
- [ ] 支持节点分组
- [ ] 支持节点样式自定义
- [ ] 支持批量创建节点
