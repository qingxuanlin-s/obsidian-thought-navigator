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

---

## 通过 URI 创建 .moc 文件（已实现）

> 与上文 `plugin.api`（设计中、尚未实现）不同，下面的 `obsidian://zk-navigation?action=create` 协议**已经实现**，可直接用于脚本化创建。需 Obsidian 正在运行（非真无头；Linux 服务器需 xvfb）。

### URI 参数

```
obsidian://zk-navigation?action=create
  &name=<文件名,不含后缀,可选;默认 前缀+时间戳>
  &folder=<目标目录,可选;默认 vault 根。目录不存在会报错,不会自动创建>
  &title=<根节点文本,可选;默认插件默认标题>
  &layout=<free|auto,可选;默认取设置 nodeLayoutStyle>
  &overwrite=<true|false,可选;默认 false。已存在且非 true 时报错>
  &open=<true|false,可选;默认 true,创建后在思维树视图打开>
```

> 节点不写坐标，交给自动布局；`layout` 仅为 `free|auto`，与 Mermaid 的 `LR/RL/TB/BT` 方向无关。

### 命令行示例

```bash
# macOS
open "obsidian://zk-navigation?action=create&name=read-notes&folder=MOC&title=阅读笔记&layout=auto"

# Windows
start "" "obsidian://zk-navigation?action=create&name=read-notes&folder=MOC&title=阅读笔记"

# Linux
xdg-open "obsidian://zk-navigation?action=create&name=read-notes&folder=MOC"

# 已存在则覆盖;不自动打开视图
open "obsidian://zk-navigation?action=create&name=read-notes&folder=MOC&overwrite=true&open=false"
```

### 反馈

- 成功：`Notice` 提示 `created "<path>"`，并设为当前 MOC。
- 目录不存在 / 不是目录 / 文件已存在（未传 `overwrite=true`）：`Notice` 给出明确错误，不写文件。

> 含特殊字符的参数（中文、空格、`/`）请做 URL 编码。多行/大段初始内容不适合走 URI（长度与编码限制），属后续增强。

> 提示：想让脚本后续稳定地往根节点挂子节点，创建时传 `rootId=<固定ID>`（如 `rootId=1`），否则根节点会被分配随机 2 字母 ID。

---

## 向已有 .moc 追加子节点（已实现）

`obsidian://zk-navigation?action=add-node` 在指定 `.moc` 的某个父节点下追加一个子节点。子节点 ID 按点号层级自动生成（`parentID.N`），父子边由渲染层的层级规则自动画出——**无需手填关系**。节点不写坐标，交给自动布局。

### URI 参数

```
obsidian://zk-navigation?action=add-node
  &file=<目标 .moc/.moc.md 路径,必填,须已存在>
  &parent=<父节点 ID,必填;根层追加用 __root__>
  &title=<新节点内容,必填>
  &kind=<text|file,可选,默认 text;file 时 title 作为 wiki 链接目标>
  &open=<true|false,可选,默认 true>
```

### 示例:搭一棵关系树 动物 → 哺乳动物 → 人类 / 鸟类

```bash
B="obsidian://zk-navigation"

# 1) 建文件,根节点 id 固定为 1
open "$B?action=create&name=animals&rootId=1&title=动物&layout=auto&open=false"

# 2) 逐个挂子节点(ID 自动 1.1 / 1.1.1 / 1.2)
open "$B?action=add-node&file=animals.moc.md&parent=1&title=哺乳动物&open=false"
open "$B?action=add-node&file=animals.moc.md&parent=1.1&title=人类&open=false"
open "$B?action=add-node&file=animals.moc.md&parent=1&title=鸟类"
```

结果：

```
1   动物
├─ 1.1   哺乳动物
│   └─ 1.1.1  人类
└─ 1.2   鸟类
```

### 反馈

- 成功：`Notice` 提示 `node added (id: <新ID>)`，该 `.moc` 设为当前文件。
- `file` 不存在 / 不是 `.moc` 文件 / `parent` 找不到 / `title` 为空：`Notice` 明确报错，不写文件。

---

## 用 Obsidian CLI (`obsidian eval`) 直接调用（已实现，推荐脚本化用）

插件在 `app.plugins.plugins['thought-navigator'].api` 上暴露了三个方法，可经 Obsidian 内置 CLI 的 `eval` 调用（无需 `open` URI）：

| 方法 | 说明 | 返回 |
|------|------|------|
| `createMOC(opts)` | 创建新 `.moc.md`，`opts` 同 URI（`name/folder/title/layout/overwrite/rootId`） | 文件路径 |
| `addNode(file, parent, title, kind?)` | 向父节点追加一个子节点 | 新节点 ID |
| `addNodes(file, items)` | **一次性**追加多个子节点（`items=[{parent,title,kind?}]`） | 新 ID 数组 |
| `addRelations(file, items)` | **一次性**在已有节点间加关联反向连线(虚线箭头),**直接写入**,`items=[{source,target,label?}]`;MOC 已打开则自动刷新画布 | 新增边 key 数组 |
| `addDraftRelations(file, items, batchId?)` | 注入**待审批草稿关联**(#20):紫色虚线、纯内存,用户确认才经 `addRelations` 落盘;`items=[{source,target,label?}]`;需 MOC 已打开 | 新增边 key 数组 |
| `deleteNode(file, nodeID)` | **直接**删除节点连同后代(无确认),清理其元数据;MOC 已打开则自动刷新画布 | `Promise<void>` |
| `deleteNodes(file, nodeIDs)` | 批量删(#20):草稿节点直接丢弃;**真实节点逐个弹确认**才删;需 MOC 已打开 | `{deleted,draftsDiscarded,cancelled,notFound}` |
| `queryNodes(file, opts?)` | **只读**查询节点(精确 `nodeID` / 模糊 `query` / 整棵树),`opts={nodeID?,query?,recursive?}`;返回项含 `x,y` 坐标 | 精简嵌套节点数组 |
| `discardDrafts(file, draftId?)` | 丢弃待审批草稿(#20):省略 `draftId`=全部+退出草稿模式,传入=单个;需 MOC 已打开 | `Promise<boolean>` |
| `version()` | 插件版本 | string |

### `queryNodes` 详解

只读、不写文件。返回精简嵌套节点 `{nodeID, nodeType, target, alias?, depth, x?, y?, children[]}`(`x,y` 为节点 model 坐标:视图已打开时取实时位置,否则取存档 `nodePositions`,auto 未排布节点可能缺省):

| `opts` | 行为 |
|--------|------|
| `{}` / 省略 | 返回整棵树(顶层节点数组,各自带 `children`) |
| `{nodeID:'1.1'}` | 精确定位该节点,返回它**及其全部后代**(单元素数组) |
| `{query:'哺乳'}` | 对 `nodeID/target/alias` 大小写不敏感模糊匹配,返回所有命中节点(各带子树) |
| `{...,recursive:false}` | 只返回直接子节点(不含孙级);默认 `recursive:true` 带全部后代 |

`nodeID` 与 `query` 同传时 `nodeID` 优先。

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian

# ⚠️ queryNodes 是 async,经 obsidian eval 通常不回显返回值(同 addNodes)。
# 想在 CLI 拿到可打印结果,直接用 fs 同步读 .moc.md(纯 JSON)更可靠:
"$OBS" eval code="(()=>{const fs=require('fs');const d=JSON.parse(fs.readFileSync(app.vault.adapter.basePath+'/animals.moc.md','utf8'));const flat=[];(function w(l){for(const n of l){flat.push(n);w(n.children||[])}})(d.nodes);return JSON.stringify(flat.filter(n=>(n.target||'').includes('哺乳')).map(n=>n.nodeID));})()"

# 程序化(其他插件 / 能真正 await 的环境)直接用 api:
#   const r = await app.plugins.plugins['thought-navigator'].api.queryNodes('animals.moc.md', {nodeID:'1.1'});
```

### ⚠️ 重要：`obsidian eval` 是「发射后不管」

`obsidian eval` 命令**会立即返回，不等待异步操作完成**，且异步结果通常不打印。这意味着：

- 连续快速 fire 多条 `eval`（每条一个 `addNode`）会因为命令体在后台异步执行而**落盘有明显延迟**，过早读取文件会以为「丢了节点」。
- **建议用 `addNodes` 在一次 `eval` 里建整棵树**：单次读-改-写，无竞态、最可靠。

### 推荐写法：一条命令建整棵树

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian   # macOS 内置 CLI
"$OBS" eval code="(async()=>{
  const a = app.plugins.plugins['thought-navigator'].api;
  await a.createMOC({name:'animals', rootId:'1', title:'动物', layout:'auto'});
  return await a.addNodes('animals.moc.md', [
    {parent:'1',   title:'哺乳动物'},   // → 1.1
    {parent:'1.1', title:'人类'},       // → 1.1.1
    {parent:'1',   title:'鸟类'},       // → 1.2
  ]);
})()"
```

结果（已实测）：

```
1   动物
├─ 1.1   哺乳动物
│   └─ 1.1.1  人类
└─ 1.2   鸟类
```

> `addNodes` 里靠 `rootId='1'` 固定根 ID，后续 `parent` 才能稳定引用；`parent` 也可引用本批次中前面刚生成的 ID（按数组顺序应用）。`parent='__root__'` 表示加在根层。

### 重新加载插件后才生效

改动插件后(重新构建 `main.js`),运行中的 Obsidian 仍在用旧代码,需重载:

```bash
"$OBS" eval code="(async()=>{await app.plugins.disablePlugin('thought-navigator');await app.plugins.enablePlugin('thought-navigator');return 'reloaded';})()"
```
