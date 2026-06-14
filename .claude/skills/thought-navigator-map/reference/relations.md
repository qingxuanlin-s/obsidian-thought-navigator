# 关联反向连线:在两个已有节点间加关联边

适用场景:用户已有一张导图,想在**任意两个已存在节点**之间补一条**关联边**——
表达"A 关联 / 引用 / 启发 B"这类**非父子**的横向联系。画布上渲染为**虚线箭头**,可带文字标签。

> 与树的父子边的区别:父子边由层级结构(`1` → `1.1`)隐式生成、实线;关联反向连线是
> 显式补的横向边,存在 `reverseRelations` 里,虚线。两节点是不是父子无所谓——若恰好是父子,
> 则该边会被当作父子实线;一般用于跨分支的关联。

## 两条路:草稿(默认) vs 直接写入

| 方式 | API | 行为 | 何时用 |
|------|-----|------|--------|
| **草稿(默认)** | `addDraftRelations` | 注入**待审批**草稿关联,纯内存、不写文件,用户在画布点「确认落地」才落盘 | 在用户**既有**图上补关联,默认走这条——和草稿节点共用同一条批次操作条 |
| 直接写入 | `addRelations` | 立即写入文件 `reverseRelations` | 用户**明确**要求直接连、不需要审批时 |

> 与草稿节点同理:在用户既有导图上做改动,**默认走草稿**,让用户审批,不要默认直接 `addRelations`。

## API

### addDraftRelations(草稿,默认)

`addDraftRelations(filePath, [{source, target, label?}], batchId?)` → `Promise<string[]>`(返回实际新增的草稿边 key)

- **前置:目标 MOC 必须已在思维树视图打开**(草稿是纯内存渲染层能力);未打开会抛 `Open the MOC ... first`。
- `source` / `target`:**已存在节点**的 nodeID(如 `'1.1'`),或**同期草稿节点**的 draftId(落地时自动映射成真实 ID)。箭头方向 `source → target`。
- `label`:边上文字标签,省略 = 无标签。
- 画布上渲染为**紫色虚线箭头**(`AI` 配色),并入右上角草稿操作条:用户点**确认落地**才经 `addRelations` 流程写文件,点**丢弃**则纯内存回收、不碰真实数据。
- **端点不存在 / 自环(source===target) / 已存在同向草稿边**会被**静默跳过**(不抛错,不计入返回)。
- 注入后**告诉用户**:已在画布生成 N 条 AI 草稿关联,请在思维树里点「确认落地」或「丢弃」(与草稿节点共用同一操作条,可一起审批)。

### addRelations(直接写入)

`addRelations(filePath, [{source, target, label?}])` → `Promise<string[]>`(返回实际新增的边 key)

- `source` / `target`:**已存在节点**的 nodeID。箭头方向 `source → target`。
- 单次读-改-写,只写一次文件。**端点节点不存在**或 **source===target(自环)** 会抛错。
- **已存在的同向边**(同 `source->target`)会被**静默跳过**,不重复、不报错。
- 若该 MOC 正在思维树视图打开,加完会**自动刷新画布**,新连线即时可见。

## 先查再连(推荐)

要连哪两个节点,得先知道它们的 nodeID。不确定时先用 `scripts/moc-query.mjs` 查(见 [`query.md`](query.md)),
拿到准确 ID 再连,避免端点不存在(直接写会抛错,草稿则静默跳过)。

## 运行命令

`obsidian eval` 对 async 不回显属正常;无论草稿还是直接写,加边都是副作用照常生效。

### 注入草稿关联(默认:开视图 → 注入,等用户审批)

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian
FILE=animals1.moc.md       # 已存在的 MOC(vault 内相对路径)

# (若该 MOC 尚未打开)先打开思维树视图
"$OBS" eval code="(async()=>{const p=app.plugins.plugins['thought-navigator'];p.settings.mocCurrentFile='$FILE';p.settings.lastRetrival={type:'index',ID:'',displayText:'',filePath:'$FILE',openTime:''};p.RefreshIndexViewFlag=true;await p.saveData(p.settings);await p.openIndexView();app.workspace.trigger('zk-navigation:refresh-index-graph');})()"

sleep 1   # 等视图渲染出 Cytoscape 画布

# 注入草稿关联(无回显属正常);用户在画布确认/丢弃
"$OBS" eval code="(async()=>{const a=app.plugins.plugins['thought-navigator'].api;await a.addDraftRelations('$FILE',[
  {source:'1.1.1', target:'1.2', label:'类比'},
  {source:'1.2',   target:'1.1.2'}
]);})()"
```

### 直接写入(用户明确不需审批时)

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian
SKILL_DIR="<本 skill 目录绝对路径>"
FILE=animals1.moc.md
BASE=$("$OBS" eval code="(()=>app.vault.adapter.basePath)()" | sed 's/^=> //')

"$OBS" eval code="(async()=>{const a=app.plugins.plugins['thought-navigator'].api;await a.addRelations('$FILE',[
  {source:'1.1.1', target:'1.2', label:'类比'}
]);})()"

sleep 1   # 等异步落盘
node "$SKILL_DIR/scripts/moc-query.mjs" "$BASE/$FILE" --ids-only
```

指定 vault:在 `eval` 前加 `vault="My Vault"`。

## 注意事项

- **草稿需视图已开**:`addDraftRelations` 是内存渲染层能力,MOC 必须已在思维树视图打开;`addRelations` 则不要求。
- **端点必须已存在**:`source`/`target` 都得是图里真实节点的 nodeID(草稿额外允许同期草稿节点的 draftId)。直接写端点不存在会抛 `relation source/target node not found`,草稿则静默跳过。
- **方向**:`source → target` 是箭头朝向,按用户语义填(A 引用 B 则 `source:A, target:B`)。
- **不是父子扩展**:要在某节点**下面长新子节点**,用 `addNodes`(建图)或 `addDraftNodes`(草稿),不是本 API。
- **去重**:重复加同一条边无副作用(跳过),返回的 key 数组只含本次真正新增的边。
- **取消草稿关联**:画布上选中该虚线边按 Delete 单独丢弃,或用 `discardDrafts`(省略 draftId)连同草稿节点一起全部丢弃。
- **删除已落盘连线**:本 skill 未封装删边 API;需要时在画布上双击边/右键删除,或用 `deleteNode` 删端点节点连带清边。
