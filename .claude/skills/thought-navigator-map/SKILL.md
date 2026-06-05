---
name: thought-navigator-map
description: 把一个主题/大纲生成为 Thought Navigator 插件的知识导图(.moc.md),并在「思维树」视图中打开。仅在用户显式点名调用本 skill（例如输入 /thought-navigator-map，或明确说"用 thought-navigator-map / 生成思维导图并打开思维树视图"）时使用；不要在普通对话中自动触发。
---

# Thought Navigator 知识导图生成器

把用户给的主题或大纲，转成 Thought Navigator(插件 id：`thought-navigator`)的 MOC 知识导图，
通过 Obsidian CLI 的 `eval` 直接调用插件 API 建树，最后在「思维树」(index)视图里打开。

> **触发约束**：本 skill 必须由用户主动调用，不要自动感知触发。只有当用户明确点名
> （`/thought-navigator-map`，或直白地说"用这个 skill 生成思维导图/思维树导图并打开"）时才执行。

## 前置条件

- Obsidian 正在运行，且目标 vault 已加载、`thought-navigator` 插件已启用。
- 可执行 CLI：`/Applications/Obsidian.app/Contents/MacOS/obsidian`(macOS)。
  可先 `which obsidian` 看是否在 PATH；否则用绝对路径。
- 多 vault 时用 `vault="<vault 名>"` 指定，否则作用于当前活动 vault。

## 工作流程

1. **理清结构**：从用户输入提炼一棵树——一个根主题 + 若干层子节点。
   若用户只给了一句话主题，自己合理地展开 2~3 层；若给了大纲，按大纲层级映射。
   不确定层级或语言时，按用户原文语言生成节点标题。
2. **规划节点与 ID**(关键，见下「ID 规则」)：根节点 ID 固定取 `'1'`。
   为每个子节点写出 `{parent, title}`，**父节点必须排在子节点之前**。
3. **生成并执行 eval 脚本**：填入下方模板，用 Bash 运行 `obsidian eval code="..."`。
   脚本一次性 `createMOC` + `addNodes` + 打开思维树视图，返回新节点 ID 数组。
4. **回报结果**：把生成的文件路径和节点 ID 列表告诉用户。

## API 速览

`app.plugins.plugins['thought-navigator'].api`：

- `createMOC({name, folderPath, title, layout, rootId, overwrite})` → `Promise<string>`(返回 `.moc.md` 路径)
  - `name`：文件名(不含后缀)，省略则自动用时间戳名。`name:'animals1'` → `animals1.moc.md`
  - `folderPath`：所在目录，`''`/省略 = vault 根；目录必须已存在，否则报错。
  - `title`：根节点显示文本。
  - `layout`：`'auto'`(脑图自动排布，**推荐**) 或 `'free'`(手动)。
  - `rootId`：根节点 ID，建议固定传 `'1'`，方便后续按 `1.x` 引用。
  - `overwrite`：同名文件已存在时是否覆盖，默认 `false`(不覆盖会抛错)。
- `addNodes(filePath, [{parent, title, kind?}])` → `Promise<string[]>`(按序返回新 ID)
  - 单次读-改-写建整棵树，无竞态。`parent` 可引用本批次中**前面刚生成**的节点 ID。
  - `kind`：`'text'`(默认，纯文本节点) 或 `'file'`(文件节点)。建图一般用默认。
  - 根层用 `parent:'__root__'`；但本 skill 用固定 `rootId:'1'`，子节点直接挂 `'1'`。

## ID 规则(决定 `parent` 怎么填)

新节点 ID = `父ID + '.' + 同级下一个序号`，序号从 1 递增：

- 根 `'1'` 的第 1 个子节点 → `1.1`，第 2 个 → `1.2`，第 3 个 → `1.3`…
- `1.1` 的第 1 个子节点 → `1.1.1`，第 2 个 → `1.1.2`…

所以在 `addNodes` 数组里，按"父先子后"的顺序排列，并用上面规则预测出的 ID 作为后续节点的 `parent`。
示例(注释即生成的 ID)：

```js
[
  {parent:'1',   title:'哺乳动物'},   // → 1.1
  {parent:'1.1', title:'人类'},       // → 1.1.1
  {parent:'1.1', title:'鲸'},         // → 1.1.2
  {parent:'1',   title:'鸟类'},       // → 1.2
]
```

## 为什么分两步(必读)

`obsidian eval` 对 **async 脚本不真正 await**：返回的 Promise 若未同步 settle 就不打印，
且 **`await` 之后的任何写入(写 globalThis、写 plugin 实例都算)对后续 eval 不可见** ——
异步续体照样执行(文件会建、视图会开),但你**拿不到它的返回值**。

所以本 skill 用「**异步建图 + 同步读回**」两步,保证拿到可打印的结果：

1. **eval A(异步)** —— 调 `createMOC`/`addNodes` 建树并打开思维树视图。**无回显是正常的**。
2. `sleep`(留时间让文件落盘)。
3. **eval B(同步)** —— 用 Node `fs.readFileSync` 直接读 `.moc.md`(纯 JSON),
   遍历节点打印 `{path, title, ids}`。这条是同步的,会回显,作为最终结果反馈给用户。

> `.moc.md` 是纯 JSON(见 `mocJsonCodec`),`fs` 在 eval 里可用(`require('fs')`),
> 故同步读回完全可行;**不要**用 `app.vault.read`(异步,不回显)。

## eval A 模板(异步建图 + 开视图)

把 `<...>` 替换为规划结果。开视图逻辑等同 `obsidian://zk-navigation?action=create` 的 open 分支。

```js
(async () => {
  const p = app.plugins.plugins['thought-navigator'];
  if (!p) throw new Error('thought-navigator 插件未启用');
  const a = p.api;
  const path = await a.createMOC({ name: '<文件名>', rootId: '1', title: '<根主题>', layout: 'auto', overwrite: true });
  await a.addNodes(path, [
    <{parent, title} 列表，父先子后>
  ]);
  p.settings.mocCurrentFile = path;
  p.settings.lastRetrival = { type: 'index', ID: '', displayText: '', filePath: path, openTime: '' };
  p.settings.zoomPanScaleArr = [];
  p.settings.BranchTab = 0;
  p.RefreshIndexViewFlag = true;
  await p.saveData(p.settings);
  await p.openIndexView();
  app.workspace.trigger('zk-navigation:refresh-index-graph');
})()
```

## eval B 模板(同步读回，会打印结果)

`<相对路径>` = `createMOC` 用的 `name` + `.moc.md`(若传了 `folderPath` 要带上目录前缀)。

```js
(() => {
  const fs = require('fs');
  const full = app.vault.adapter.basePath + '/' + '<相对路径>';
  const d = JSON.parse(fs.readFileSync(full, 'utf8'));
  const ids = [];
  const walk = n => { ids.push(n.nodeID); (n.children || []).forEach(walk); };
  d.nodes.forEach(walk);
  return JSON.stringify({ path: '<相对路径>', title: d.nodes[0].target, ids });
})()
```

## 运行命令(完整一条 bash，含两步 + sleep)

外层双引号、脚本内单引号避免冲突。`overwrite:true` 可避免同名报错(见注意事项)。

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian

# 步骤 A：异步建图 + 开思维树视图（无回显属正常）
"$OBS" eval code="(async()=>{
  const p = app.plugins.plugins['thought-navigator'];
  const a = p.api;
  const path = await a.createMOC({name:'animals1', rootId:'1', title:'动物', layout:'auto', overwrite:true});
  await a.addNodes(path, [
    {parent:'1',   title:'哺乳动物'},
    {parent:'1.1', title:'人类'},
    {parent:'1',   title:'鸟类'},
  ]);
  p.settings.mocCurrentFile = path;
  p.settings.lastRetrival = {type:'index',ID:'',displayText:'',filePath:path,openTime:''};
  p.settings.zoomPanScaleArr = []; p.settings.BranchTab = 0; p.RefreshIndexViewFlag = true;
  await p.saveData(p.settings); await p.openIndexView();
  app.workspace.trigger('zk-navigation:refresh-index-graph');
})()"

sleep 1   # 等异步落盘

# 步骤 B：同步读回，打印 {path, title, ids}
"$OBS" eval code="(()=>{const fs=require('fs');const full=app.vault.adapter.basePath+'/animals1.moc.md';const d=JSON.parse(fs.readFileSync(full,'utf8'));const ids=[];const walk=n=>{ids.push(n.nodeID);(n.children||[]).forEach(walk)};d.nodes.forEach(walk);return JSON.stringify({path:'animals1.moc.md',title:d.nodes[0].target,ids});})()"
```

预期 B 输出：`=> {"path":"animals1.moc.md","title":"动物","ids":["1","1.1","1.1.1","1.2"]}`

指定 vault：在每条 `eval` 前加 `vault="My Vault"`。

## 注意事项

- **两步缺一不可**：A 不回显是正常的(async 不被 await);最终结果以 B 的同步输出为准。
- **同步读回**：用 `require('fs').readFileSync` 读纯 JSON 的 `.moc.md`;`app.vault.read` 是异步的,不会回显。
- **父先子后**：`addNodes` 顺序错了(子节点引用尚不存在的 parent)会抛 `parent node not found`。
- **同名文件**：`createMOC` 默认不覆盖,同名抛 `MOC file already exists`;脚本默认带 `overwrite:true`,需要保留旧图就改用唯一文件名。
- **layout 锁定**：`layout` 在文件创建时锁定,后续改全局设置不影响已建文件。建图默认用 `'auto'`。
- **节点标题**：纯文本即可;若要做成指向已有笔记的文件节点,对该项加 `kind:'file'` 并把 `title` 写成笔记名。
- B 读不到文件(返回报错)通常是 A 还没落盘:把 `sleep` 加大到 2s 重试。
