# Plugin External API 使用文档

## 前置条件

1. Obsidian 已运行，并加载 `thought-navigator` 插件
2. Obsidian CLI 已启用（Settings → General → Command line interface → Register CLI）
3. 插件版本 ≥ 0.0.9（API 功能在此版本引入）

---

## 快速验证

```bash
# 确认插件已加载且 API 可用
obsidian eval code="app.plugins.plugins['thought-navigator'].api.version()"
# 输出: "0.0.9"

# 列出所有 MOC 文件
obsidian eval code="app.plugins.plugins['thought-navigator'].api.listMOCFiles()"
```

---

## API 使用方式

### 简化写法（推荐）

```bash
# 定义别名，减少重复输入
alias zkapi="obsidian eval code=\"app.plugins.plugins['thought-navigator'].api"

# 使用
obsidian eval code="const api = app.plugins.plugins['thought-navigator'].api; await api.generateMOCFromNote('Notes/1a.md')"
```

---

## 核心功能示例

### 1. 根据笔记生成 MOC

```bash
# 为笔记生成 MOC 文件（自动写入同目录）
obsidian eval code="await app.plugins.plugins['thought-navigator'].api.generateMOCFromNote('Notes/1a.md')"
# 输出: "Notes/1a.moc.md"（生成的 MOC 文件路径）

# 指定选项
obsidian eval code="
  const api = app.plugins.plugins['thought-navigator'].api;
  await api.generateMOCFromNote('Notes/1a.md', {
    depth: 3,
    layout: 'TB',
    includeBacklinks: false
  })
"
```

### 2. 解析已有 MOC

```bash
# 读取 MOC 结构（返回 JSON）
obsidian eval code="
  const api = app.plugins.plugins['thought-navigator'].api;
  const result = await api.parseMOC('Notes/1a.moc.md');
  JSON.stringify({ nodes: result.nodes.length, edges: result.edges.length })
"
# 输出: {"nodes":12,"edges":11}
```

### 3. 查询笔记所在的所有 MOC

```bash
# 查看一篇笔记被哪些 MOC 引用
obsidian eval code="
  const api = app.plugins.plugins['thought-navigator'].api;
  JSON.stringify(api.getNoteMOCLocations('Notes/1a2b.md'))
"
# 输出: [{"mocPath":"Notes/1a.moc.md","nodeID":"a.2"},{"mocPath":"MOC/main.moc.md","nodeID":"b.3"}]
```

### 4. 节点操作

```bash
# 添加子节点
obsidian eval code="
  const api = app.plugins.plugins['thought-navigator'].api;
  await api.addNode('Notes/1a.moc.md', 'a.1', 'a.1.a', '[[1a1a]]')
"

# 更新节点内容
obsidian eval code="
  const api = app.plugins.plugins['thought-navigator'].api;
  await api.updateNode('Notes/1a.moc.md', 'a.2', '[[新笔记名]]')
"

# 删除节点
obsidian eval code="
  const api = app.plugins.plugins['thought-navigator'].api;
  await api.deleteNode('Notes/1a.moc.md', 'a.3')
"
```

---

## Claude Code Skill 示例

在 `.claude/skills/` 下创建 skill，让 Claude 自动生成 MOC：

```markdown
# generate-moc skill

根据用户指定的笔记路径，调用 thought-navigator 插件 API 生成 MOC 文件。

步骤：
1. 确认笔记路径存在
2. 调用: obsidian eval code="await app.plugins.plugins['thought-navigator'].api.generateMOCFromNote('{notePath}')"
3. 输出生成的 MOC 文件路径
```

调用方式：
```
/generate-moc Notes/1a.md
```

---

## Shell 脚本示例

批量为多篇笔记生成 MOC：

```bash
#!/bin/bash
# generate-all-mocs.sh

NOTES=("Notes/1a.md" "Notes/2b.md" "Notes/3c.md")

for note in "${NOTES[@]}"; do
  echo "Generating MOC for: $note"
  obsidian eval code="await app.plugins.plugins['thought-navigator'].api.generateMOCFromNote('$note')"
done
```

---

## 返回值规范

| 方法 | 返回类型 | 说明 |
|------|---------|------|
| `listMOCFiles()` | `string[]` | MOC 文件路径列表 |
| `parseMOC(path)` | `Promise<MOCParseResult \| null>` | 解析结果，文件不存在返回 null |
| `generateMOCFromNote(path, opts?)` | `Promise<string>` | 生成的 MOC 文件路径 |
| `generateMOCFromFolder(path, opts?)` | `Promise<string>` | 生成的 MOC 文件路径 |
| `createMOC(path, content)` | `Promise<void>` | 无返回值 |
| `addNode(...)` | `Promise<void>` | 无返回值 |
| `updateNode(...)` | `Promise<void>` | 无返回值 |
| `deleteNode(...)` | `Promise<void>` | 无返回值 |
| `getNoteMOCLocations(path)` | `MOCLocation[]` | 同步返回，引用列表 |
| `version()` | `string` | 插件版本号 |

---

## 错误排查

```bash
# 插件未加载
obsidian eval code="Object.keys(app.plugins.plugins)"
# 确认 'thought-navigator' 在列表中

# API 未注册（旧版本）
obsidian eval code="typeof app.plugins.plugins['thought-navigator'].api"
# 应输出 'object'，若输出 'undefined' 则需升级插件

# 文件不存在
# generateMOCFromNote 会 throw，eval 会输出错误信息
```

---

## generateMOCFromNote 生成规则说明

给定笔记 `Notes/1a2b.md`（Luhmann ID: `1a2b`），生成的 MOC 结构：

```
根节点: 1a2b ["[[1a2b]]"]
  ├─ 直接 outlinks (depth=1)
  │    1a2b.1 ["[[linkedNote1]]"]
  │    1a2b.2 ["[[linkedNote2]]"]
  └─ backlinks (可选, includeBacklinks=true)
       free.1 ["[[backlinkNote]]"]  ← 作为自由节点
```

生成文件默认路径：与源笔记同目录，文件名为 `{原文件名}.moc.md`。
