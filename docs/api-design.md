# Plugin External API 设计文档

## 概述

通过在插件实例上暴露 `api` 对象，允许外部工具（Obsidian CLI `eval`、其他插件、脚本）以编程方式操作 MOC 数据，无需依赖 UI 交互。

---

## 架构决策

### 为何选择 `plugin.api` 而非 Obsidian Command

| 方案 | 优点 | 缺点 |
|------|------|------|
| `obsidian://command?id=...` | 简单 | 无参数传递，无返回值 |
| `plugin.api.*` via `eval` | 可传参、有返回值、可组合 | 需要 Obsidian 运行 |
| REST API（Local REST API 插件） | 无需 Obsidian 运行 | 需安装第三方插件 |

**选择 `plugin.api`**：最小侵入、利用现有 `MOCHandler` 逻辑、支持异步返回、可用 `obsidian eval` 直接调用。

---

## API 接口定义

### 访问路径

```javascript
app.plugins.plugins['thought-navigator'].api
```

### 接口结构

```typescript
interface ZKNavigationAPI {
    // === MOC 查询 ===
    listMOCFiles(): string[];
    parseMOC(mocPath: string): Promise<MOCParseResult | null>;
    
    // === MOC 生成 ===
    generateMOCFromNote(notePath: string, options?: GenerateMOCOptions): Promise<string>;
    generateMOCFromFolder(folderPath: string, options?: GenerateMOCOptions): Promise<string>;
    createMOC(mocPath: string, content: string): Promise<void>;
    
    // === 节点操作 ===
    addNode(mocPath: string, parentID: string, nodeID: string, content: string): Promise<void>;
    updateNode(mocPath: string, nodeID: string, content: string): Promise<void>;
    deleteNode(mocPath: string, nodeID: string): Promise<void>;
    
    // === 反向索引查询 ===
    getNoteMOCLocations(notePath: string): MOCLocation[];
    
    // === 工具方法 ===
    version(): string;
}

interface GenerateMOCOptions {
    depth?: number;           // 递归深度，默认 2
    includeBacklinks?: boolean; // 是否包含 backlinks，默认 true
    layout?: 'LR' | 'RL' | 'TB' | 'BT'; // 默认 'LR'
    rootNodeID?: string;      // 根节点 ID，默认用文件名
}
```

---

## 核心实现：generateMOCFromNote

这是最核心的 API，逻辑如下：

```
输入: notePath (笔记路径)
  ↓
1. 读取笔记 frontmatter → 获取 Luhmann ID
2. 读取笔记的 outgoing links（[[wikilinks]]）
3. 读取 backlinks（通过 MOCReverseIndex 或 app.metadataCache）
4. 按 Luhmann ID 层级构建树结构
5. 用 JSON codec 序列化为 .moc/.moc.md 格式
  ↓
输出: JSON 字符串 → 写入 xxx.moc.md
```

### Luhmann ID 提取策略（复用现有 settings）

根据 `settings.IDFieldOption`：
- `filename`：从文件名提取（如 `1a2b.md` → ID 为 `1a2b`）
- `metadata`：从 frontmatter 字段读取
- `prefix`：从标题前缀提取

---

## 数据流

```
CLI eval
  └─→ plugin.api.generateMOCFromNote(notePath)
        └─→ app.metadataCache.getFileCache(file)  // 读取 links
        └─→ MOCReverseIndex.getLocations(notePath) // 读取反向引用
        └─→ serializeMOCJson(mocData)              // 序列化
        └─→ app.vault.create/modify(mocFile)       // 写入文件
        └─→ return mocFilePath
```

---

## 注册位置

在 `main.ts` 的 `onload()` 末尾注册，确保所有依赖已初始化：

```typescript
// main.ts - onload() 末尾
this.api = new ZKNavigationExternalAPI(this);
```

`ZKNavigationExternalAPI` 独立为 `src/api/externalAPI.ts`，依赖注入 `plugin` 实例获取：
- `plugin.settings`
- `plugin.app`
- `plugin.mocReverseIndex`（需在 main.ts 中保存引用）

---

## 错误处理规范

所有 API 方法：
- 返回 `Promise`，异步操作
- 失败时 `throw Error` 带描述性消息（CLI `eval` 会输出异常）
- 不直接调用 `new Notice()`（UI 副作用，CLI 场景无意义）

---

## 安全边界

- API 仅在 Obsidian 运行时可用（不支持 headless）
- 写操作通过 `app.vault` 完成，受 Obsidian 沙箱保护
- 不暴露插件内部状态（renderer、undoStack 等 UI 状态）

---

## 文件结构

```
src/
  api/
    externalAPI.ts      ← API 实现类
    types.ts            ← GenerateMOCOptions 等类型定义
main.ts                 ← this.api = new ZKNavigationExternalAPI(this)
docs/
  api-design.md         ← 本文档
  api-usage.md          ← 使用文档
```

---

## 版本规划

| 阶段 | 功能 |
|------|------|
| v1（MVP） | `generateMOCFromNote`、`listMOCFiles`、`parseMOC` |
| v2 | `generateMOCFromFolder`、`addNode`、`deleteNode` |
| v3 | 事件钩子（`on('moc-changed', cb)`）、批量操作 |
