# Design Document - MOC Real-time Sync

## Overview

本设计文档描述如何实现MOC文件的实时同步功能。基于现有代码分析和性能要求，我们采用**方案5（混合方案）**：内容哈希检测 + 防抖机制。

## Architecture

### 1. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Obsidian Vault Events                     │
│                  (modify, rename, create, delete)            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              MOC File Change Detector                        │
│  - isMOCFile() 检查                                          │
│  - 防抖处理 (500ms)                                          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Content Hash Validator                          │
│  - 计算文件内容哈希                                          │
│  - 与缓存对比                                                │
│  - 跳过无变化的更新                                          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              View Refresh Coordinator                        │
│  - Index View (refreshBranchMermaidMOC)                     │
│  - Graph View (refreshLocalGraphMOC/MOCNode)                │
└─────────────────────────────────────────────────────────────┘
```

### 2. 数据流

```
用户编辑MOC文件
    ↓
Vault 'modify' 事件触发
    ↓
isMOCFile() 检查 → 非MOC文件，忽略
    ↓ MOC文件
防抖等待 500ms
    ↓
计算内容哈希
    ↓
哈希对比 → 无变化，跳过
    ↓ 有变化
更新哈希缓存
    ↓
触发视图刷新
    ↓
重新解析 MOC 结构
    ↓
更新 Mermaid 图
```

## Component Design

### 1. MOC File Monitor (新增)

**位置**: `src/utils/mocMonitor.ts` (新文件)

**职责**: 
- 监听 MOC 文件变化
- 管理内容哈希缓存
- 协调视图刷新

**接口**:
```typescript
export class MOCFileMonitor {
    private plugin: ZKNavigationPlugin;
    private contentHashCache: Map<string, string>;
    private debounceTimers: Map<string, NodeJS.Timeout>;
    
    constructor(plugin: ZKNavigationPlugin);
    
    // 初始化监听器
    initialize(): void;
    
    // 检查是否是 MOC 文件
    isMOCFile(file: TFile): boolean;
    
    // 计算文件内容哈希
    private async calculateHash(content: string): Promise<string>;
    
    // 检查内容是否变化
    private async hasContentChanged(file: TFile): Promise<boolean>;
    
    // 处理 MOC 文件变化（带防抖）
    private handleMOCFileChange(file: TFile): void;
    
    // 刷新相关视图
    private async refreshViews(file: TFile): Promise<void>;
    
    // 清理资源
    cleanup(): void;
}
```

### 2. Index View 修改

**文件**: `src/view/indexView.ts`

**修改点**:
- 移除现有的 `metadataCache.on("changed")` 监听（已存在但会触发所有文件）
- 依赖 MOCFileMonitor 触发的自定义事件
- 优化 `refreshBranchMermaidMOC()` 方法，添加加载状态

**新增方法**:
```typescript
// 显示加载指示器
private showLoadingIndicator(container: HTMLElement): HTMLElement;

// 隐藏加载指示器
private hideLoadingIndicator(indicator: HTMLElement): void;

// 平滑更新视图（避免闪烁）
private async smoothUpdateView(container: HTMLElement, updateFn: () => Promise<void>): Promise<void>;
```

### 3. Graph View 修改

**文件**: `src/view/graphView.ts`

**修改点**:
- 移除现有的 `metadataCache.on("changed")` 监听（已注释掉）
- 依赖 MOCFileMonitor 触发的自定义事件
- 优化 `refreshLocalGraphMOC()` 和 `refreshLocalGraphMOCNode()` 方法

**新增方法**:
```typescript
// 检查当前显示的是否是指定的 MOC 文件
private isDisplayingMOCFile(mocFile: TFile): boolean;

// 智能刷新（只刷新当前显示的 MOC）
private async smartRefreshMOC(mocFile: TFile): Promise<void>;
```

## Implementation Details

### 1. 内容哈希计算

使用简单的字符串哈希算法（FNV-1a），性能优秀：

```typescript
private async calculateHash(content: string): Promise<string> {
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        hash *= 16777619; // FNV prime
    }
    return hash.toString(36);
}
```

**优点**:
- 快速：O(n) 时间复杂度，n 为文件长度
- 轻量：无需外部库
- 足够准确：碰撞概率极低

### 2. 防抖机制

使用 Obsidian 内置的 `debounce` 函数：

```typescript
private handleMOCFileChange(file: TFile): void {
    // 清除旧的定时器
    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }
    
    // 设置新的定时器
    const timer = setTimeout(async () => {
        if (await this.hasContentChanged(file)) {
            await this.refreshViews(file);
        }
        this.debounceTimers.delete(file.path);
    }, 500);
    
    this.debounceTimers.set(file.path, timer);
}
```

**参数选择**:
- 500ms 延迟：平衡响应速度和性能
- 用户打字速度通常 < 200ms/字符
- 500ms 足够避免频繁触发，又不会感觉延迟

### 3. 视图刷新策略

**智能刷新**:
- 只刷新当前显示的 MOC 相关视图
- 使用自定义事件通知视图更新
- 视图自行判断是否需要刷新

```typescript
private async refreshViews(file: TFile): Promise<void> {
    // 触发自定义事件，携带 MOC 文件信息
    this.plugin.app.workspace.trigger(
        "zk-navigation:moc-file-changed",
        file
    );
}
```

**Index View 响应**:
```typescript
this.registerEvent(
    this.app.workspace.on("zk-navigation:moc-file-changed", async (mocFile: TFile) => {
        // 检查当前是否显示该 MOC
        if (this.isDisplayingMOC(mocFile)) {
            await this.smoothUpdateView(
                this.indexMermaidContainer,
                () => this.refreshBranchMermaidMOC(this.indexMermaidContainer)
            );
        }
    })
);
```

**Graph View 响应**:
```typescript
this.registerEvent(
    this.app.workspace.on("zk-navigation:moc-file-changed", async (mocFile: TFile) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && this.isMOCFile(activeFile) && activeFile.path === mocFile.path) {
            // 当前显示的就是变化的 MOC 文件
            await this.refreshLocalGraph();
        } else if (activeFile) {
            // 检查当前文件是否在变化的 MOC 树中
            const result = await this.findNodeInMOCTrees(activeFile);
            if (result && result.mocFile.path === mocFile.path) {
                await this.refreshLocalGraph();
            }
        }
    })
);
```

### 4. 加载指示器

使用 CSS 动画实现平滑的加载效果：

```typescript
private showLoadingIndicator(container: HTMLElement): HTMLElement {
    const indicator = container.createDiv("zk-loading-indicator");
    indicator.innerHTML = `
        <div class="zk-spinner"></div>
        <span>${t("Updating...")}</span>
    `;
    indicator.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: var(--background-primary);
        padding: 20px;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        z-index: 1000;
        display: flex;
        align-items: center;
        gap: 10px;
    `;
    return indicator;
}

private async smoothUpdateView(container: HTMLElement, updateFn: () => Promise<void>): Promise<void> {
    // 显示加载指示器
    const indicator = this.showLoadingIndicator(container);
    
    // 添加淡出效果
    container.style.opacity = '0.5';
    container.style.transition = 'opacity 0.2s ease-in-out';
    
    try {
        // 执行更新
        await updateFn();
        
        // 淡入效果
        container.style.opacity = '1';
    } finally {
        // 移除加载指示器
        setTimeout(() => {
            indicator.remove();
        }, 200);
    }
}
```

### 5. 错误处理

```typescript
private async refreshViews(file: TFile): Promise<void> {
    try {
        this.plugin.app.workspace.trigger(
            "zk-navigation:moc-file-changed",
            file
        );
    } catch (error) {
        console.error(`Failed to refresh views for MOC file: ${file.path}`, error);
        new Notice(`MOC 文件更新失败: ${error.message}`);
    }
}
```

## Performance Considerations

### 1. 性能指标

| 指标 | 目标值 | 测量方法 |
|------|--------|----------|
| 更新延迟 | < 500ms | 从文件保存到视图更新完成 |
| CPU 占用 | < 5% | 空闲时的平均 CPU 使用率 |
| 内存增加 | < 10MB | 哈希缓存占用的内存 |
| 哈希计算 | < 10ms | 1000 行 MOC 文件的哈希计算时间 |

### 2. 优化策略

**哈希缓存管理**:
- 使用 Map 存储，O(1) 查找
- 限制缓存大小（最多 100 个文件）
- LRU 策略清理旧缓存

```typescript
private contentHashCache: Map<string, {hash: string, timestamp: number}> = new Map();
private readonly MAX_CACHE_SIZE = 100;

private updateCache(filePath: string, hash: string): void {
    // 如果缓存已满，删除最旧的条目
    if (this.contentHashCache.size >= this.MAX_CACHE_SIZE) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        
        for (const [key, value] of this.contentHashCache.entries()) {
            if (value.timestamp < oldestTime) {
                oldestTime = value.timestamp;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            this.contentHashCache.delete(oldestKey);
        }
    }
    
    this.contentHashCache.set(filePath, {
        hash,
        timestamp: Date.now()
    });
}
```

**防抖优化**:
- 每个文件独立的防抖定时器
- 避免多个文件同时变化时的冲突

**视图更新优化**:
- 只更新当前可见的视图
- 使用 CSS 过渡动画，避免闪烁
- 异步更新，不阻塞 UI

### 3. 内存管理

**哈希缓存大小估算**:
- 每个哈希值：~10 bytes
- 文件路径：~100 bytes
- 时间戳：8 bytes
- 总计：~120 bytes/文件
- 100 个文件：~12 KB

**防抖定时器**:
- 每个定时器：~100 bytes
- 最多同时存在的定时器：~10 个
- 总计：~1 KB

**总内存占用**: < 20 KB（远低于 10MB 目标）

## Testing Strategy

### 1. 单元测试

**测试用例**:
1. `isMOCFile()` 正确识别 MOC 文件
2. `calculateHash()` 对相同内容返回相同哈希
3. `hasContentChanged()` 正确检测内容变化
4. 防抖机制在快速编辑时只触发一次

### 2. 集成测试

**测试场景**:
1. 添加新节点后视图自动更新
2. 删除节点后视图自动更新
3. 修改节点 ID 后视图自动更新
4. 修改节点层级后视图自动更新
5. 快速连续编辑时不会频繁刷新
6. 非 MOC 文件变化时不触发更新
7. 多个 MOC 文件同时变化时正确处理

### 3. 性能测试

**测试数据**:
- 小文件：< 100 行
- 中文件：100-500 行
- 大文件：> 500 行

**测试指标**:
- 哈希计算时间
- 视图刷新时间
- 内存占用
- CPU 占用

## Migration Plan

### 阶段 1: 基础实现（2-3 天）

**目标**: 实现基本的文件监听和视图刷新

**任务**:
1. 创建 `MOCFileMonitor` 类
2. 实现 `isMOCFile()` 方法
3. 实现基础的文件监听
4. 实现防抖机制
5. 在 Index View 和 Graph View 中注册事件监听

**验收标准**:
- MOC 文件变化后视图能自动刷新
- 防抖机制正常工作
- 无明显性能问题

### 阶段 2: 哈希优化（1-2 天）

**目标**: 添加内容哈希检测，避免不必要的更新

**任务**:
1. 实现 `calculateHash()` 方法
2. 实现 `hasContentChanged()` 方法
3. 添加哈希缓存管理
4. 集成到文件监听流程

**验收标准**:
- 内容未变化时不触发更新
- 哈希计算时间 < 10ms
- 缓存正常工作

### 阶段 3: 用户体验优化（1-2 天）

**目标**: 添加加载指示器和平滑过渡

**任务**:
1. 实现加载指示器
2. 添加 CSS 过渡动画
3. 优化错误处理
4. 添加用户提示

**验收标准**:
- 更新时有清晰的视觉反馈
- 无闪烁现象
- 错误能正确提示

### 阶段 4: 测试和优化（1 天）

**目标**: 全面测试和性能优化

**任务**:
1. 编写单元测试
2. 执行集成测试
3. 性能测试和优化
4. 文档更新

**验收标准**:
- 所有测试通过
- 性能指标达标
- 文档完整

## Rollback Plan

如果实现过程中遇到严重问题，可以按以下步骤回滚：

1. **禁用 MOC 监听器**: 在设置中添加开关，允许用户禁用实时同步
2. **保留手动刷新**: 保留现有的手动刷新机制作为备选
3. **降级到简单方案**: 如果哈希检测有问题，可以降级到纯防抖方案

## Future Enhancements

### 1. 增量更新（v2.0）

- 实现差异检测算法
- 只更新变化的节点
- 添加动画过渡效果

### 2. 多视图同步（v2.1）

- 同时打开多个视图时保持同步
- 跨窗口同步支持

### 3. 性能监控（v2.2）

- 添加性能监控面板
- 显示更新频率、耗时等指标
- 帮助用户优化 MOC 结构

## Conclusion

本设计采用混合方案（内容哈希 + 防抖），在性能和用户体验之间达到最佳平衡：

**优点**:
- ✅ 用户无感知（500ms 延迟几乎察觉不到）
- ✅ 性能优秀（哈希检测避免不必要的更新）
- ✅ 实现可行（中等难度，4-6 天完成）
- ✅ 易于维护（代码清晰，职责分离）
- ✅ 可扩展（为未来增量更新打下基础）

**风险**:
- ⚠️ 哈希计算可能在超大文件（> 10000 行）时有性能问题
  - 缓解：限制 MOC 文件大小，添加警告提示
- ⚠️ 多个视图同时打开时可能重复刷新
  - 缓解：添加全局刷新锁，避免并发更新

**下一步**: 开始阶段 1 的实现，创建 `MOCFileMonitor` 类。
