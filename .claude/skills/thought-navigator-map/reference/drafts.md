# 草稿模式 + 删除 / 取消(#20)

## 何时走草稿

用户想"先看 AI 的提案、确认后再进图",或要**在已有导图的既有节点下扩展**——这两种**默认走草稿**,
不要直接 `addNodes` 改动用户既有树。草稿在画布上与普通节点**同款渲染,仅边框紫色虚线**并带 `AI` 角标,
右上角出现批次操作条:**确认落地 / 丢弃**。注入会**自动进入草稿模式**(此间用户新建的节点也都是草稿),
所有批次确认/丢弃后自动退出。草稿纯内存,刷新/重启即丢失,确认前不写文件。

**前置**:目标 MOC 必须已在思维树视图打开。若是新建,先用建图模板的"开视图"段打开,`sleep` 后再注入。

## API

- `addDraftNodes(filePath, [{content, kind?, parentRealId?, localId?, parentLocalId?}], batchId?)` → `Promise<string[]>`
  - `content`:节点文本;`kind`:`'text'`(默认)/`'file'`。
  - `parentRealId`:挂到某个**已存在真实节点**(其 nodeID,如 `'1.1'`)。
  - `localId` + `parentLocalId`:同批草稿内部父子树——给本批每个节点起 `localId`,子节点用 `parentLocalId`
    指向父的 `localId`(父先子后),落地时原样建成子树。
  - ⚠️ 前置:MOC 必须已打开;async 不回显,注入是副作用、无需回显。
- `setDraftMode(filePath, on)` → `Promise<boolean>`:开/关已打开 MOC 的草稿模式(`addDraftNodes` 注入时会自动开)。
- `discardDrafts(filePath, draftId?)` → `Promise<boolean>`:丢弃草稿(纯内存,不碰真实数据)。
  - 省略 `draftId` = 丢弃该视图**全部**草稿并退出草稿模式;传入则只丢**这一个**。
  - 前置:MOC 已打开,否则返回 `false`。等价于画布上「丢弃」按钮。
- `deleteNode(filePath, nodeID)` → `Promise<void>`:删除**真实**节点连同其全部后代,清理位置/颜色/备注等元数据。
  - 直接写文件;`nodeID` 不存在则静默无操作。若该 MOC 已打开,删除后**自动刷新画布**。

## 注入草稿(两步:开视图 → 注入)

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian
FILE=animals1.moc.md   # 已存在 / 刚建好并打开的 MOC

# (若该 MOC 尚未打开)先打开思维树视图
"$OBS" eval code="(async()=>{const p=app.plugins.plugins['thought-navigator'];p.settings.mocCurrentFile='$FILE';p.settings.lastRetrival={type:'index',ID:'',displayText:'',filePath:'$FILE',openTime:''};p.RefreshIndexViewFlag=true;await p.saveData(p.settings);await p.openIndexView();app.workspace.trigger('zk-navigation:refresh-index-graph');})()"

sleep 1   # 等视图渲染出 Cytoscape 画布

# 注入一批草稿(本例:在根 '1' 下提一个二级子树,等用户审批)
"$OBS" eval code="(async()=>{const a=app.plugins.plugins['thought-navigator'].api;await a.addDraftNodes('$FILE',[
  {localId:'A', content:'爬行动物', parentRealId:'1'},
  {localId:'B', content:'蜥蜴',     parentLocalId:'A'},
  {localId:'C', content:'蛇',       parentLocalId:'A'}
]);})()"
```

- `parentRealId:'1'` 把草稿挂到真实根节点 `1` 下;`parentLocalId` 串起草稿内部父子。
- 注入后**告诉用户**:已在画布生成 N 个 AI 草稿,请在思维树里点「确认落地」或「丢弃」。
- 无需读回——草稿不写文件,确认后才经正式流程落盘。

## 删除节点 / 取消草稿(CLI)

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian
FILE=animals1.moc.md

# 删除某真实节点(连同后代),直接写文件;若该 MOC 已打开会自动刷新画布。副作用、无回显。
"$OBS" eval code="(async()=>{await app.plugins.plugins['thought-navigator'].api.deleteNode('$FILE','1.2');})()"

# 取消(丢弃)全部待审批草稿——纯内存,需该 MOC 已在思维树视图打开
"$OBS" eval code="(async()=>{await app.plugins.plugins['thought-navigator'].api.discardDrafts('$FILE');})()"

# 只丢弃某一个草稿节点(传 draftId)
"$OBS" eval code="(async()=>{await app.plugins.plugins['thought-navigator'].api.discardDrafts('$FILE','<draftId>');})()"
```

> 删除是写文件的真实改动;取消草稿只清内存中的「待审批」节点,不碰已落盘数据。
> 删除后想确认结果,用 `reference/query.md` 的脚本再读一次。
