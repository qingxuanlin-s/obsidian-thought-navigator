---
name: thought-navigator-map
version: 1.6.0
description: 把一个主题/大纲生成为 Thought Navigator 插件的知识导图(.moc.md),并在「思维树」视图中打开;也能查询已有导图的节点(精确/模糊/取子树),或注入「待审批草稿节点」(由用户在画布上确认落地/丢弃)。仅在用户显式点名调用本 skill（例如输入 /thought-navigator-map，或明确说"用 thought-navigator-map / 生成思维导图并打开思维树视图 / 查询某个导图节点 / 生成草稿等我审批"）时使用；不要在普通对话中自动触发。
---

# Thought Navigator 知识导图生成器

把用户给的主题/大纲转成 Thought Navigator(插件 id:`thought-navigator`)的 MOC 知识导图(`.moc.md`),
通过 Obsidian CLI 的 `eval` 调用插件 API 建树、在「思维树」(index)视图打开;也支持查询节点、注入待审批草稿、删除/取消。

> **触发约束**:本 skill 必须由用户主动点名调用(`/thought-navigator-map`,或明确说"用这个 skill 生成思维导图/思维树导图并打开")才执行,**不要**自动感知触发。

## 选哪条路(先决策,再翻对应参考文件)

| 场景 | 怎么做 | 详细步骤 |
|------|--------|----------|
| 新建一张**全新** `.moc.md` | `createMOC` + `addNodes` **直接写入**,开视图 | [`reference/build.md`](reference/build.md) |
| 在**已有**导图的既有节点下扩展 | **默认走草稿**:`addDraftNodes` 注入待审批,用户画布确认/丢弃 | [`reference/drafts.md`](reference/drafts.md) |
| 查询已有导图节点(精确/模糊/取子树/坐标) | 跑 `scripts/moc-query.mjs`(纯 node 读 JSON) | [`reference/query.md`](reference/query.md) |
| 删除节点 / 取消草稿 | `deleteNode` / `discardDrafts` | [`reference/drafts.md`](reference/drafts.md) |

> **正常建图 vs 草稿(关键)**:新建整图 → 直接写;在用户**既有**节点下加 → **默认草稿**,不要直接 `addNodes` 改动既有树。

## 前置条件

- Obsidian 正在运行,目标 vault 已加载、`thought-navigator` 插件已启用。
- CLI:`/Applications/Obsidian.app/Contents/MacOS/obsidian`(macOS;`which obsidian` 看是否在 PATH,否则用绝对路径)。
- 多 vault 用 `vault="<vault 名>"` 指定,否则作用于当前活动 vault。
- vault 绝对路径(脚本查询/读回要用):`obsidian eval code="(()=>app.vault.adapter.basePath)()"`
  ——**裸属性不回显,必须函数包裹**;输出形如 `=> /path/to/vault`,去掉 `=> ` 前缀即得 basePath。

## API 速览

`app.plugins.plugins['thought-navigator'].api`:

| 方法 | 用途 | 返回 | 详见 |
|------|------|------|------|
| `createMOC(opts)` | 建新 `.moc.md`(`name/folderPath/title/layout/rootId/overwrite`) | 路径 | build.md |
| `addNodes(file, [{parent,title,kind?}])` | **一次性**建整棵树(父先子后) | 新 ID 数组 | build.md |
| `deleteNode(file, nodeID)` | 删节点连同后代、清元数据;已打开则自动刷新画布 | `void` | drafts.md |
| `addDraftNodes(file, items, batchId?)` | 注入待审批草稿(**需视图已开**) | draftId 数组 | drafts.md |
| `setDraftMode(file, on)` | 开/关草稿模式 | `bool` | drafts.md |
| `discardDrafts(file, draftId?)` | 丢弃草稿(省略=全部+退出草稿模式) | `bool` | drafts.md |
| `queryNodes(file, opts?)` | 程序化只读查询(async,CLI 不回显→改用脚本) | 节点数组 | query.md |
| `version()` | 插件版本 | `string` | — |

## 全局注意事项(各路通用)

- **`obsidian eval` 是 fire-and-forget**:async 脚本不被真正 `await`,返回值通常不回显;且 `await` 之后的写入对后续 eval 不可见。建图/注入是副作用照常生效,**拿不到返回值是正常的**。
- **要可打印结果就走同步**:查询/读回用 `scripts/moc-query.mjs`(纯 node 读 `.moc.md` JSON,可回显),**不要**用 `app.vault.read`(异步、不回显)。
- **裸属性不回显**:`eval code="x.y"` 不打印,要写成 `eval code="(()=>x.y)()"`。
- **写文件后 `sleep`**:建图/删除后过早读文件可能没落盘,`sleep 1`(慢则 2s)再读。
- **父先子后**:`addNodes` 顺序错了(子引用尚不存在的 parent)会抛 `parent node not found`。
- **`layout` 创建时锁定**:后续改全局设置不影响已建文件;建图默认 `'auto'`。
