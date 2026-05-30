# 通过命令行 / URI 创建 .moc 文件 — 实现方案

> 目标:支持从外部脚本 / Obsidian CLI 创建新的 `.moc.md` 文件,或向已有 `.moc.md` 的指定父节点追加子节点;产出必须是插件可解析、可渲染的合法格式。

---

## 0. 关键事实(实现前必读)

1. **`.moc.md` / `.moc` 是 JSON 格式,不是 Mermaid。** `isMocFile()` 为真时,`parseMOCStructure` / `saveMOCStructure` 走 JSON codec(`src/utils/utils.ts:179-180`、`:825-826`);只有普通 `.md` 才走 Mermaid。CLAUDE.md 里"MOC = Mermaid"的描述已过时,仅适用于普通 `.md` MOC。
2. **已有现成创建函数**:`createMOCJsonWithInitialNode(nodeLayoutStyle, initialNodeTitle)`(`src/utils/mocJsonCodec.ts:311`)。三处 UI 入口都调用它(右键文件夹 `createMOCInFolder` main.ts:1149;命令 `zk-new-moc-embed` main.ts:672;indexView 弹窗)。
3. **已注册 URI 协议** `obsidian://zk-navigation`(`main.ts:496`),当前只支持 `para.file`(打开/导航),**不支持创建** → 这是最省力的扩展点。
4. **External API(`plugin.api`)只有文档没有实现**(`docs/api-design.md`),本方案不依赖它;但预留了把核心逻辑抽成可被 `obsidian eval` 复用的形态。
5. **官方 Obsidian CLI 不能 headless 执行插件命令**(只有 `eval` / `plugin:reload`)。因此外部触发只能走:URI handler(推荐)或 `obsidian eval` 调函数。两者都**要求 Obsidian 在运行**(Linux 服务器需 xvfb)。这不是"真无头 CLI",需在文档里写清楚。

---

## 1. 范围与分期

| 分期 | 能力 | 状态 |
|------|------|------|
| **一期** | URI 创建新 `.moc.md`(文件名/目录/标题/布局/覆盖策略),创建后在视图中打开 | 本方案主交付 |
| **二期** | 向已有 `.moc.md` 的指定父节点追加子节点(`action=add-node`) | 独立交付,复杂度更高 |
| 可选 | 暴露极小 `plugin.api.createMOC(...)` 给 `obsidian eval` / 其他插件复用同一逻辑 | 与一期共享内部函数 |

---

## 2. 核心设计原则:坐标 vs 自动布局

**创建/追加节点时一律不写真实坐标,交给自动布局。**

- 渲染时决定布局的是**坐标是否存在**(`CytoscapeRenderer` 的 `hasSavedPositions`):有坐标→`preset` 锁原位;无坐标→`grid` + `avoidOverlap` 自动散开。
- 脚本无法预知画布尺寸/视口,硬编码坐标必然糟糕或重叠。
- 现有 `createMOCJsonWithInitialNode` 已经只给首节点写了无意义占位 `{x:0,y:0}`,对单/少节点无害 —— **沿用其行为,不要试图计算坐标**。
- 显式写 `nodeLayoutStyle`(`'auto'` 或随全局 `settings.nodeLayoutStyle`),保证后续在 UI 内加节点也走统一布局。
- ⚠️ 不要把需求文案里的 `LR/RL/TB/BT` 当成 layout 写进 JSON —— 那是 Mermaid 的 `DirectionOfBranchGraph`,**不进 `.moc.md`**。`.moc.md` 的 layout 字段只有 `'free' | 'auto'`。

---

## 3. 一期:URI 创建新 .moc.md

### 3.1 URI 形态

```
obsidian://zk-navigation?action=create
  &name=<文件名,不含后缀,可选>
  &folder=<目标目录,可选,默认 vault 根或 settings.FolderOfIndexes>
  &title=<根节点文本,可选,默认 t('Default node title')>
  &layout=<free|auto,可选,默认 settings.nodeLayoutStyle>
  &overwrite=<true|false,可选,默认 false>
  &open=<true|false,可选,默认 true 创建后在视图打开>
```

外部触发示例:

```bash
open "obsidian://zk-navigation?action=create&name=read-notes&folder=MOC&title=阅读笔记&layout=auto"
# Windows: start "obsidian://..."   Linux: xdg-open "obsidian://..."
```

### 3.2 先抽共享创建函数(消除三处漂移)

当前 `createMOCInFolder`(main.ts:1149)、`zk-new-moc-embed`(main.ts:672)、indexView 弹窗各写一遍"拼路径→生成内容→`vault.create`→设 current→刷新"。先收敛成一个私有方法,新 URI 分支与旧入口共用:

```typescript
// main.ts — 新增私有方法
interface CreateMOCOptions {
    folderPath?: string;       // 不含文件名,'' 或省略 = vault 根
    name?: string;             // 不含后缀,省略 = 默认前缀+时间戳
    title?: string;            // 根节点文本,省略 = t('Default node title')
    layout?: 'free' | 'auto';  // 省略 = settings.nodeLayoutStyle
    overwrite?: boolean;       // 目标已存在时是否覆盖,默认 false
}

async createMOCFile(opts: CreateMOCOptions = {}): Promise<TFile> {
    const layout = opts.layout
        ?? (this.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free');
    const baseName = opts.name?.trim()
        || (t('default MOC file prefix') + '-' + moment().format('YYYYMMDDHHmmss'));

    // 1) 目录校验:不存在则报错(不静默新建,避免脚本误写)
    const folderPath = (opts.folderPath ?? '').replace(/\/+$/, '');
    if (folderPath) {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) throw new Error(`folder not found: "${folderPath}"`);
        if (!(folder instanceof TFolder)) throw new Error(`not a folder: "${folderPath}"`);
    }

    // 2) 文件名安全化(去掉非法字符 / 路径分隔符)
    const safeName = baseName.replace(/[\\/:*?"<>|]/g, '_');
    const filePath = folderPath
        ? `${folderPath}/${safeName}${MOC_FILE_SUFFIX}`
        : `${safeName}${MOC_FILE_SUFFIX}`;

    // 3) 已存在策略
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    const content = createMOCJsonWithInitialNode(
        layout,
        opts.title?.trim() || t('Default node title')
    );
    if (existing) {
        if (!(existing instanceof TFile)) throw new Error(`path occupied: "${filePath}"`);
        if (!opts.overwrite) throw new Error(`file already exists: "${filePath}" (pass overwrite=true to replace)`);
        await this.app.vault.modify(existing, content);
        return existing;
    }
    return await this.app.vault.create(filePath, content);
}
```

> 改造旧入口:`createMOCInFolder(folder)` 内部改为 `return this.createMOCFile({ folderPath: folder.path })`;`zk-new-moc-embed` 同理调用后再 `editor.replaceSelection`。行为保持不变(默认前缀+时间戳、默认标题)。

### 3.3 URI handler 分支

在 `main.ts:496` 的 handler 顶部、`if(para.file)` **之前**加 create 分支:

```typescript
this.registerObsidianProtocolHandler("zk-navigation", async (para) => {

    if (para.action === 'create') {
        try {
            const file = await this.createMOCFile({
                name: para.name,
                folderPath: para.folder,
                title: para.title,
                layout: para.layout === 'auto' ? 'auto'
                      : para.layout === 'free' ? 'free' : undefined,
                overwrite: para.overwrite === 'true',
            });

            this.settings.mocCurrentFile = file.path;
            await this.saveData(this.settings);
            new Notice(`zk-navigation: created "${file.path}"`);

            if (para.open !== 'false') {
                this.settings.lastRetrival = {
                    type: 'index', ID: '', displayText: '',
                    filePath: file.path, openTime: '',
                };
                this.settings.zoomPanScaleArr = [];
                this.settings.BranchTab = 0;
                this.RefreshIndexViewFlag = true;
                await this.openIndexView();
            }
            this.app.workspace.trigger('zk-navigation:refresh-index-graph');
        } catch (e) {
            new Notice(`zk-navigation: ${e.message}`);
            console.error('[zk-navigation] create via uri failed', e);
        }
        return;
    }

    if (para.file) {
        // ...现有逻辑不动...
    } else {
        new Notice(`zk-navigation: invalid uri`);
    }
})
```

### 3.4 错误反馈矩阵(一期)

| 场景 | 行为 |
|------|------|
| `folder` 不存在 / 不是目录 | `throw` → `Notice("zk-navigation: folder not found: ...")` |
| 文件已存在且 `overwrite!=true` | `Notice("... file already exists ... (pass overwrite=true)")` |
| 文件已存在且 `overwrite=true` | `vault.modify` 覆盖,提示已覆盖 |
| 文件名含非法字符 | 自动替换为 `_`(或可选改为报错,二选一定稿) |
| `layout` 非法值 | 回落到 `settings.nodeLayoutStyle` |
| 创建成功 | `Notice("created \"path\"")`,可选打开视图 |

---

## 4. 二期:向已有 .moc.md 父节点追加子节点

> 复杂度明显高于一期,**不要直接拼 JSON**,必须走规范变更通道。建议独立交付。

### 4.1 URI 形态

```
obsidian://zk-navigation?action=add-node
  &file=<目标 .moc.md 路径,必填>
  &parent=<父节点 nodeID,必填;指定根级则可约定 parent=__root__>
  &title=<新节点文本,必填>
  &kind=<text|file,可选,默认 text;file 时 title 视为 wiki 目标>
```

### 4.2 实现:在 MOCHandler 暴露不依赖 UI 的 addChildNode

所有变更必须经 `MOCHandler.modifyMOCData()`(`src/view/index/mocHandler.ts:119`):它内部 `parseMOCStructure`(JSON codec)→ 深拷贝 → 回调变更 → `saveMOCStructure`,并自动补 `nodeLayoutStyle`。节点树字段见 `JsonNodeData`(`mocJsonCodec.ts:7`):`nodeID / nodeType('file'|'text'|'embed') / target / depth / children[] / relationText`。

```typescript
// mocHandler.ts — 新增
async addChildNodeProgrammatic(
    mocFile: TFile,
    parentID: string,           // '__root__' 表示加在根级
    title: string,
    kind: 'text' | 'file' = 'text',
): Promise<string> {
    let newID = '';
    await this.modifyMOCData(mocFile, (mocData) => {
        // 1) 找父节点(根级特判)
        const parent = parentID === '__root__'
            ? null
            : findNodeById(mocData.nodes, parentID);   // 需实现/复用现有查找
        if (parentID !== '__root__' && !parent) {
            throw new Error(`parent node not found: "${parentID}"`);
        }
        const siblings = parent ? parent.children : mocData.nodes;
        const depth = parent ? parent.depth + 1 : 0;

        // 2) 生成唯一 nodeID(关键:现有随机 2 字母无去重,见 mocJsonCodec.ts:302)
        newID = generateUniqueNodeId(mocData);   // 需实现:碰撞则重试/扩位

        // 3) 不写坐标(nodePositions 不动),交给自动布局
        siblings.push({
            nodeID: newID,
            nodeType: kind,
            target: title,        // text: 原文; file: wiki 链接目标
            depth,
            children: [],
            relationText: '',
        });
    });
    return newID;
}
```

### 4.3 二期必须解决的点

- **nodeID 唯一性**:现有 `createRandomTwoLetterNodeId`(mocJsonCodec.ts:302)无去重。新增 `generateUniqueNodeId(mocData)`:遍历现有 ID,碰撞则重试,必要时扩到 3 字母。
- **父节点存在性校验** + 根级追加约定(`__root__`)。
- **`depth` / `children` 维护**:子节点 `depth = parent.depth + 1`。
- **缓存一致性**:连续多次写同一文件,注意 `parseMOCStructure` 的缓存键 `filePath:mtime` 同秒陈旧问题。`modifyMOCData` 用 `enqueueModify` 串行化已缓解;若 JSON codec 有独立缓存,需确认是否需 `clearCacheForFile`(见 MEMORY.md)。
- `file` 类型节点的 `target` 应是合法 wiki 目标(`[[..]]` 内文),需校验目标笔记是否存在(可选,缺失即占位)。

---

## 5. 可选:plugin.api.createMOC(给 obsidian eval / 其他插件)

与一期共享 `createMOCFile`,几乎零成本:

```typescript
// main.ts onload() 末尾
(this as any).api = {
    version: () => this.manifest.version,
    createMOC: (opts: CreateMOCOptions) => this.createMOCFile(opts),
    // 二期: addNode: (file, parent, title, kind) => ...
};
```

```bash
obsidian eval code="await app.plugins.plugins['thought-navigator'].api.createMOC({name:'x',folder:'MOC',title:'根',layout:'auto'})"
```

> 注意:`api-design.md` 描述的是更大的一套接口(`generateMOCFromNote` 等),本项只落地 `createMOC` 一个最小方法,不追求对齐整篇文档。

---

## 6. 验收标准对照

| 验收项 | 一期可达 | 实现点 |
|--------|---------|--------|
| 命令行创建有效 .moc | ✅ | URI `action=create` → `createMOCFile` → `createMOCJsonWithInitialNode`,产出必合法 |
| 指定文件名/目录/标题/根节点 | ✅ | `name/folder/title` 参数;多节点初始内容不在一期范围 |
| 填充已有 .moc 的某父节点 | 二期 | `action=add-node` + `addChildNodeProgrammatic` |
| 新建 .moc 在视图正常渲染 | ✅ | 无坐标走 grid 布局;`open!=false` 时 `openIndexView()` |
| 错误参数/目录不存在/已存在反馈 | ✅ | 第 3.4 节矩阵,统一 `Notice` |
| `npm run build` 通过 | ✅ | 仅新增分支 + 一个方法,类型完整 |

---

## 7. 风险与未决项

1. **非真 headless**:URI / eval 都要 Obsidian 运行;文档需明确,Linux 服务器需 xvfb。
2. **目录是否自动创建**:本方案选择"目录不存在即报错",不静默 `createFolder`(更安全;若需自动建目录可加 `mkdir=true` 参数)。
3. **文件名非法字符**:当前定为自动替换 `_`,需确认是否改为报错。
4. **URI 参数体积**:多行/大段初始内容经 URI 需编码且有长度限制;大内容场景应改"外部写文件 + 插件规范化"模式(本方案未含)。
5. **二期 nodeID 去重**是新逻辑,需单独测试碰撞与扩位。
6. **i18n**:新增 `Notice` 文案建议走 `t(key)`,在 `src/lang/en.ts` / `zh.ts` 补键。

---

## 8. 改动清单(一期)

| 文件 | 改动 |
|------|------|
| `main.ts` | 新增 `createMOCFile(opts)`;`createMOCInFolder` / `zk-new-moc-embed` 改为调用它;URI handler(:496)加 `action=create` 分支;(可选)onload 末尾挂 `this.api.createMOC` |
| `src/lang/en.ts` `zh.ts` | 新增 Notice 文案键(created / folder not found / already exists 等) |
| `docs/` | 更新使用说明(URI 用法、headless 限制) |

一期不需要改 `mocJsonCodec.ts` / `mocHandler.ts` / 渲染层。二期才涉及 `mocHandler.ts`(新增 `addChildNodeProgrammatic`)与 `mocJsonCodec.ts`(唯一 ID 生成)。
