# MOC 渲染问题调试指南

## 问题描述

当 MOC 文件新建时没有思维树标题，后面添加标题后不会自动渲染。

## 影响范围

- **Index View（分支视图）**: MOC 模式下的主视图
- **Graph View（局部关系视图）**: 
  - 直接打开 MOC 文件时的视图
  - 打开 MOC 树中节点时的上下文视图

## 根本原因

1. **解析失败**: 当文件没有指定标题时，`parseMOCStructure` 返回空结果
2. **视图提前返回**: 代码检测到空结果后 `return`，显示错误提示
3. **监听器触发**: 当用户添加标题后，MOC 文件监听器会触发
4. **重新解析**: 视图重新调用 `parseMOCStructure`
5. **可能的问题**: 
   - 标题名称不匹配
   - 文件内容缓存（已排除，每次都重新读取）
   - 监听器未触发

## 已实施的解决方案

### 1. 详细日志记录

#### parseMOCStructure 函数
```typescript
console.log(`parseMOCStructure: Parsing file ${filePath}, total lines: ${lines.length}`);
console.log(`parseMOCStructure: Found heading at line ${i}: "${line}"`);
console.log(`parseMOCStructure: Target heading found at line ${i}`);
console.warn(`parseMOCStructure: Target heading "# ${headingTitle}" not found in file`);
```

#### Index View
```typescript
console.log(`Index View: Parsing MOC file: ${mocFilePath}, heading: ${headingTitle}`);
console.log(`Index View: Parse result - nodes: ${mocParseResult.nodes.length}, metadata:`, mocParseResult.metadata);
console.warn(`Index View: ${errorMsg}`);
```

#### Graph View
```typescript
console.log(`Graph View: Parsing MOC file: ${mocFile.path}, heading: ${headingTitle}`);
console.log(`Graph View: Parse result - nodes: ${mocParseResult.nodes.length}, metadata:`, mocParseResult.metadata);
console.log(`Graph View: Searching for file ${file.path} in ${mocFiles.length} MOC files`);
console.warn(`Graph View: No tree structure found for heading: ${headingTitle}`);
```

### 2. 用户友好的调试信息

当找不到标题时，视图会显示：

```
未找到树结构: # 思维树

解析耗时: 5ms
文件路径: MOC/生存法则.md
查找标题: 思维树
提示: 请确保 MOC 文件中存在一级标题 "# 思维树"
```

### 3. 扩展的元数据

`MOCParseResult` 现在包含：
- `totalNodes`: 总节点数
- `maxDepth`: 最大深度
- `hasReverseRelations`: 是否包含反向关系
- `parseTime`: 解析耗时（毫秒）
- `filePath`: MOC 文件路径
- `headingTitle`: 标题名称

## 调试步骤

### 1. 打开开发者控制台
- Windows/Linux: `Ctrl + Shift + I`
- macOS: `Cmd + Option + I`

### 2. 重现问题

#### 场景 A: Index View
1. 创建新的 MOC 文件（没有标题）
2. 打开 Index View，选择该 MOC 文件
3. 观察错误提示和调试信息
4. 在 MOC 文件中添加标题 `# 思维树`
5. 保存文件
6. 查看控制台日志

#### 场景 B: Graph View（直接打开 MOC 文件）
1. 创建新的 MOC 文件（没有标题）
2. 打开该 MOC 文件
3. 打开 Graph View
4. 观察错误提示和调试信息
5. 在 MOC 文件中添加标题 `# 思维树`
6. 保存文件
7. 查看控制台日志

#### 场景 C: Graph View（打开 MOC 树中的节点）
1. 创建新的 MOC 文件（没有标题）
2. 打开 MOC 树中的某个节点文件
3. 打开 Graph View
4. 观察是否显示"思维树上下文"
5. 在 MOC 文件中添加标题 `# 思维树`
6. 保存文件
7. 查看控制台日志

### 3. 分析日志

#### 正常流程
```
parseMOCStructure: Parsing file MOC/生存法则.md, total lines: 15
parseMOCStructure: Found heading at line 3: "# 思维树"
parseMOCStructure: Target heading found at line 3
parseMOCStructure: Parsing content from line 4 to 15
Index View: Parse result - nodes: 5, metadata: {...}
MOC Monitor: Content changed, refreshing views for MOC/生存法则.md
Index View: MOC file changed, refreshing view for MOC/生存法则.md
```

#### 问题流程（标题不匹配）
```
parseMOCStructure: Parsing file MOC/生存法则.md, total lines: 15
parseMOCStructure: Found heading at line 3: "# 错误标题"
parseMOCStructure: Target heading "# 思维树" not found in file
Index View: Parse result - nodes: 0, metadata: {...}
```

#### 问题流程（监听器未触发）
```
parseMOCStructure: Parsing file MOC/生存法则.md, total lines: 15
parseMOCStructure: Target heading "# 思维树" not found in file
Index View: Parse result - nodes: 0, metadata: {...}
// 添加标题后，没有看到 "MOC Monitor: Content changed" 日志
```

## 常见问题排查

### 问题 1: 标题名称不匹配

**症状**: 添加标题后仍然显示"未找到树结构"

**检查**:
1. 查看调试信息中的"查找标题"
2. 打开 MOC 文件，确认标题完全一致
3. 注意空格、标点符号、大小写

**解决**:
- 确保标题格式为 `# 思维树`（一个 `#` 加空格）
- 标题名称与设置中的 `mocHeadingTitle` 完全一致

### 问题 2: MOC 监听器未触发

**症状**: 添加标题后，控制台没有 "MOC Monitor: Content changed" 日志

**检查**:
1. 确认文件在 MOC 文件夹中
2. 查看 MOC 监听器是否初始化成功
3. 检查文件是否真的保存了

**解决**:
- 确保文件路径以 `mocFolderPath` 开头
- 尝试手动刷新视图（切换视图或重新打开）
- 重启 Obsidian

### 问题 3: 文件不在 MOC 文件夹中

**症状**: Graph View 搜索日志显示 "Searching for file ... in 0 MOC files"

**检查**:
1. 确认 `mocFolderPath` 设置正确
2. 确认文件在该文件夹中

**解决**:
- 移动文件到正确的 MOC 文件夹
- 或更新 `mocFolderPath` 设置

### 问题 4: 解析耗时过长

**症状**: 调试信息显示解析耗时 > 100ms

**检查**:
1. MOC 文件是否过大
2. 是否有大量节点

**解决**:
- 优化 MOC 文件结构
- 分割大型 MOC 文件

## 临时解决方案

如果问题仍然存在，可以尝试：

### 方案 1: 手动刷新
1. 切换到其他视图再切回来
2. 或关闭并重新打开视图

### 方案 2: 重新加载插件
1. 打开命令面板（Ctrl/Cmd + P）
2. 运行 "Reload app without saving"

### 方案 3: 清除缓存
1. 关闭 Obsidian
2. 删除 `.obsidian/workspace` 文件
3. 重新打开 Obsidian

## 性能监控

通过元数据可以监控解析性能：

```typescript
const result = await parseMOCStructure(app, filePath, headingTitle);
console.log(`解析 ${result.metadata.totalNodes} 个节点，耗时 ${result.metadata.parseTime}ms`);

if (result.metadata.parseTime > 100) {
    console.warn(`解析耗时过长: ${result.metadata.parseTime}ms`);
}
```

## 未来改进

1. **自动重试**: 如果解析失败，延迟后自动重试
2. **标题建议**: 如果找不到标题，列出文件中所有可用的标题
3. **实时预览**: 在编辑 MOC 文件时实时预览解析结果
4. **性能优化**: 缓存解析结果，只在内容变化时重新解析
5. **错误恢复**: 提供"强制刷新"按钮

## 相关文件

- `src/utils/utils.ts` - `parseMOCStructure` 函数
- `src/view/indexView.ts` - Index View 渲染逻辑
- `src/view/graphView.ts` - Graph View 渲染逻辑
- `src/utils/mocMonitor.ts` - MOC 文件监听器

## 测试清单

- [ ] 新建 MOC 文件（无标题）→ 添加标题 → 自动渲染
- [ ] 修改标题名称 → 自动更新
- [ ] 删除标题 → 显示错误提示
- [ ] 多个 MOC 文件同时编辑 → 正确刷新
- [ ] 大型 MOC 文件（100+ 节点）→ 性能正常
- [ ] 标题名称包含特殊字符 → 正确解析
- [ ] 文件重命名 → 正确更新
- [ ] 文件移动到其他文件夹 → 正确处理
