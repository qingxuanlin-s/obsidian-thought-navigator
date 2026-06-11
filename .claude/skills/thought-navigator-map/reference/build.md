# 建图:新建一张全新 .moc.md

适用场景:用户要一张**全新**导图。走 `createMOC` + `addNodes` 直接写入(不进草稿),建完在「思维树」视图打开。

## 工作流程

1. **理清结构**:从用户输入提炼一棵树——一个根主题 + 若干层子节点。
   只给一句话主题就自己合理展开 2~3 层;给了大纲就按层级映射。按用户原文语言生成节点标题。
2. **规划节点与 ID**(见下「ID 规则」):根节点 ID 固定取 `'1'`。为每个子节点写出 `{parent, title}`,**父在子前**。
3. **执行 eval A**:建树 + 开视图(无回显属正常)。
4. **`sleep` 后用脚本读回**:`scripts/moc-query.mjs --ids-only` 打印 `{path,title,ids}` 作为最终结果。
5. **回报**:把文件路径和节点 ID 列表告诉用户。

## API:createMOC / addNodes

- `createMOC({name, folderPath, title, layout, rootId, overwrite})` → `Promise<string>`(返回 `.moc.md` 路径)
  - `name`:文件名(不含后缀),省略=时间戳名。`name:'animals1'` → `animals1.moc.md`
  - `folderPath`:目录,`''`/省略 = vault 根;目录必须已存在,否则报错。
  - `title`:根节点显示文本。
  - `layout`:`'auto'`(脑图自动排布,**推荐**)或 `'free'`(手动)。**创建时锁定**,后续改全局设置不影响已建文件。
  - `rootId`:根节点 ID,**固定传 `'1'`**,方便后续按 `1.x` 引用。
  - `overwrite`:同名是否覆盖,默认 `false`(同名抛 `MOC file already exists`)。
- `addNodes(filePath, [{parent, title, kind?}])` → `Promise<string[]>`(按序返回新 ID)
  - 单次读-改-写建整棵树,无竞态。`parent` 可引用本批次中**前面刚生成**的节点 ID。
  - `kind`:`'text'`(默认,纯文本)或 `'file'`(文件节点,`title` 写成笔记名)。建图一般用默认。
  - 根层用 `parent:'__root__'`;本 skill 用固定 `rootId:'1'`,子节点直接挂 `'1'`。

## ID 规则(决定 `parent` 怎么填)

新节点 ID = `父ID + '.' + 同级下一个序号`,序号从 1 递增:

- 根 `'1'` 的第 1 个子 → `1.1`,第 2 个 → `1.2`…
- `1.1` 的第 1 个子 → `1.1.1`,第 2 个 → `1.1.2`…

在 `addNodes` 数组里按"父先子后"排列,用预测 ID 作为后续节点的 `parent`(注释即生成的 ID):

```js
[
  {parent:'1',   title:'哺乳动物'},   // → 1.1
  {parent:'1.1', title:'人类'},       // → 1.1.1
  {parent:'1.1', title:'鲸'},         // → 1.1.2
  {parent:'1',   title:'鸟类'},       // → 1.2
]
```

> **父先子后**:顺序错了(子引用尚不存在的 parent)会抛 `parent node not found`。

## 为什么"建图(eval) + 读回(脚本)"分两步

`obsidian eval` 对 async 不真正 await:Promise 未同步 settle 就不打印,且 `await` 之后的写入对后续 eval 不可见——
异步续体照常执行(文件会建、视图会开),但你**拿不到返回值**。所以:

1. **eval A(异步)**:`createMOC`/`addNodes` 建树 + 开视图。**无回显正常**。
2. `sleep`(等落盘)。
3. **脚本读回(同步)**:`node scripts/moc-query.mjs <绝对路径> --ids-only`,纯 node 读 `.moc.md`(纯 JSON),会回显。

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

## 完整运行命令(建图 + sleep + 脚本读回)

外层双引号、脚本内单引号避免冲突。`overwrite:true` 避免同名报错。

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian
SKILL_DIR="<本 skill 目录绝对路径>"   # 即包含 SKILL.md / scripts/ 的目录
BASE=$("$OBS" eval code="(()=>app.vault.adapter.basePath)()" | sed 's/^=> //')

# 步骤 A:异步建图 + 开思维树视图(无回显属正常)
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

# 步骤 B:脚本读回,打印 {path,title,ids}
node "$SKILL_DIR/scripts/moc-query.mjs" "$BASE/animals1.moc.md" --ids-only
```

预期 B 输出:`{"path":"animals1.moc.md","title":"动物","ids":["1","1.1","1.1.1","1.2"]}`

指定 vault:在每条 `eval` 前加 `vault="My Vault"`。

## 建图注意事项

- **两步缺一不可**:A 不回显正常(async 不被 await);最终结果以脚本读回为准。
- **同名文件**:`createMOC` 默认不覆盖;脚本默认带 `overwrite:true`,要保留旧图就改唯一文件名。
- **读不到文件**:通常是 A 还没落盘,把 `sleep` 加大到 2s 重试。
- **文件节点**:想指向已有笔记,对该项加 `kind:'file'` 并把 `title` 写成笔记名。
