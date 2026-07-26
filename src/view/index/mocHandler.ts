import { App, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { MOCParseResult, CrossDomainLink, MOCTreeNode, ReverseRelation, GroupInfo, NODE_FLAG_SEPARATED, NODE_FLAG_SIDE_PINNED } from "src/utils/utils";
import { LayoutPreset, normalizeLayoutPreset } from "src/utils/growthDirection";
import { computeAutoLayout, AutoLayoutNodeInput } from "src/utils/autoLayoutEngine";
import { DomTextMeasurer, DomTextMeasureOptions } from "src/renderer/domTextMeasurer";
import { measureNodeLabel } from "src/renderer/renderPipeline";

// 文本节点盒子尺寸:与 src/renderer/stylesheet.ts 的逐层级测量保持一致
// (root 用纯函数 measureNodeLabel;一级/更深用 DomTextMeasurer 实测文本宽 + 同款 padding)。
// 修改这里时务必同步 stylesheet.ts 对应选择器的常量,否则 CLI 与视图布局会漂移。
function measureTextNodeBox(
    label: string,
    depth: number,
    domMeasure: ((text: string, opts: { fontSize: number; fontWeight?: string; maxWidth: number; lineHeight?: number }) => { width: number; height: number }) | null
): { width: number; height: number } {
    const text = label || ' ';
    if (depth <= 0) {
        // 根节点(stylesheet.ts node[?isRoot] 文本分支)
        const m = measureNodeLabel(text, { baseWidth: 210, minHeight: 78, maxWidth: 560, charWidth: 18, lineHeight: 42, paddingX: 88, paddingY: 38 });
        return { width: m.width, height: m.height };
    }
    // computeAutoTextMetrics 的等价实现
    const opts = depth === 1
        ? { fontSize: 24, fontWeight: 'bold', maxContentWidth: 296, baseWidth: 118, minHeight: 90, paddingX: 72, paddingY: 34 }
        : { fontSize: 20, fontWeight: '500', maxContentWidth: 280, baseWidth: 90, minHeight: 42, paddingX: 72, paddingY: 44 };
    const lineHeight = Math.ceil(opts.fontSize * 1.4);
    const m = domMeasure
        ? domMeasure(text, { fontSize: opts.fontSize, fontWeight: opts.fontWeight, maxWidth: opts.maxContentWidth, lineHeight })
        : measureNodeLabel(text, { fontSize: opts.fontSize, maxWidth: opts.maxContentWidth, lineHeight, paddingX: 0, paddingY: 0 });
    const width = Math.max(opts.baseWidth, Math.min(opts.maxContentWidth + opts.paddingX, Math.ceil(m.width) + opts.paddingX));
    const height = Math.max(opts.minHeight, Math.ceil(m.height) + opts.paddingY);
    return { width, height };
}

/**
 * 深拷贝 MOCTreeNode 树结构
 */
function deepCopyMOCTreeNode(node: MOCTreeNode): MOCTreeNode {
    const copy: MOCTreeNode = {
        nodeID: node.nodeID,
        nodeType: node.nodeType,
        target: node.target,
        depth: node.depth,
        children: node.children.map(child => deepCopyMOCTreeNode(child)),
        file: node.file,
        relationText: node.relationText,
    };
    if (node.alias !== undefined) copy.alias = node.alias;
    if (typeof node.extBitMap === 'number' && node.extBitMap !== 0) copy.extBitMap = node.extBitMap & 0xff;
    if (node.isArrowRelation) copy.isArrowRelation = node.isArrowRelation;
    if (node.arrowSource !== undefined) copy.arrowSource = node.arrowSource;
    if (node.arrowTarget !== undefined) copy.arrowTarget = node.arrowTarget;
    return copy;
}

/**
 * 深拷贝 MOCParseResult，避免修改缓存中的数据
 */
function deepCopyMOCResult(original: MOCParseResult): MOCParseResult {
    return {
        nodes: original.nodes.map(node => deepCopyMOCTreeNode(node)),
        reverseRelations: new Map(Array.from(original.reverseRelations.entries())),
        nodePositions: { ...original.nodePositions },
        groups: original.groups.map(g => ({ ...g, nodeIds: [...g.nodeIds] })),
        edgeCurvatures: { ...original.edgeCurvatures },
        nodeColors: { ...original.nodeColors },
        nodeStyleColors: { ...original.nodeStyleColors || {} },
        crossDomainLinks: original.crossDomainLinks ? structuredClone(original.crossDomainLinks) : {},
        embedNodeSizes: { ...original.embedNodeSizes || {} },
        nodeRemarks: { ...original.nodeRemarks || {} },
        nodeAnchors: { ...original.nodeAnchors || {} },
        collapsedNodeIds: [...(original.collapsedNodeIds || [])],
        nodeLayoutStyle: original.nodeLayoutStyle,
        nodeLayoutOverrides: original.nodeLayoutOverrides ? { ...original.nodeLayoutOverrides } : undefined,
        layoutPreset: original.layoutPreset,
        nodeLayoutPresets: original.nodeLayoutPresets ? { ...original.nodeLayoutPresets } : undefined,
        isProject: original.isProject,
        metadata: { ...original.metadata }
    };
}

/**
 * 只读查询返回的精简节点视图(供 CLI / 脚本)。
 * 与存储的节点同构,仅保留稳定字段,children 按需嵌套。
 */
export interface MOCNodeView {
    nodeID: string;
    nodeType: string;          // 'file' | 'text' | 'embed'
    target: string;            // file/embed: wiki 链接;text: 原始文本
    alias?: string;            // 仅 file + [[link|alias]] 时存在
    depth: number;
    x?: number;                // 节点位置 X(model 坐标);来自 nodePositions,缺省表示交给自动布局
    y?: number;                // 节点位置 Y(model 坐标)
    children: MOCNodeView[];
    isDraft?: boolean;         // 草稿节点(#20,未落地、仅存于打开中的视图内存)
    draftOrigin?: 'ai' | 'manual'; // 草稿来源:ai=CLI/API,manual=页面新建
    draftBatchId?: string;     // 所属草稿批次
    parentRealId?: string;     // 草稿挂载的真实节点 ID(若有)
    parentDraftId?: string;    // 草稿挂载的同批草稿 ID(若有)
}

export interface MOCQueryOptions {
    nodeID?: string;           // 精确按 ID 定位单个节点(连同其子树)
    query?: string;           // 模糊匹配 target/alias/nodeID,返回所有命中节点
    recursive?: boolean;       // 默认 true=带全部后代;false=只到直接子节点
}

/**
 * MOC (Map of Content) 处理器
 * 负责处理所有与 MOC 文件相关的操作
 */
export class MOCHandler {
    private modifyQueues = new Map<string, Promise<void>>();

    constructor(
        private plugin: ZKNavigationPlugin,
        private app: App,
        private hooks?: {
            onBeforeModify?: (payload: { filePath: string; content: string }) => void | Promise<void>;
        }
    ) {}

    private async enqueueModify<T>(filePath: string, task: () => Promise<T>): Promise<T> {
        const previous = this.modifyQueues.get(filePath) || Promise.resolve();
        const run = previous.catch(() => undefined).then(task);
        const current = run.then(() => undefined, () => undefined);
        this.modifyQueues.set(filePath, current);

        try {
            return await run;
        } finally {
            if (this.modifyQueues.get(filePath) === current) {
                this.modifyQueues.delete(filePath);
            }
        }
    }

    private getBranchStylePalette(): string[] {
        return ['#ff5a5f', '#ff8a3d', '#f7c948', '#56d364', '#38d9a9', '#4dabf7', '#9775fa', '#f06595'];
    }

    private pickNextBranchStyleColor(existing: Record<string, string>): string {
        const palette = this.getBranchStylePalette();
        const used = new Set(Object.values(existing || {}).filter(Boolean));
        const unused = palette.find((c) => !used.has(c));
        if (unused) return unused;
        return palette[Math.floor(Math.random() * palette.length)];
    }

    ensureFirstLevelNodeLayoutDefaults(mocData: MOCParseResult, nodeId: string): void {
        if (!this.isFirstLevelChild(mocData, nodeId)) {
            return;
        }

        if (mocData.nodeLayoutStyle !== 'free' && mocData.nodeLayoutStyle !== 'auto') {
            mocData.nodeLayoutStyle = 'free';
        }

        const settingsPreset = normalizeLayoutPreset(this.plugin.settings.autoLayoutDefaultGrowthDirection);
        if (!mocData.layoutPreset) {
            mocData.layoutPreset = settingsPreset;
        }
        if (mocData.nodeLayoutPresets && !mocData.nodeLayoutPresets[nodeId]) {
            mocData.nodeLayoutPresets[nodeId] = settingsPreset;
        }
    }

    /**
     * 通用 MOC 数据修改方法
     * 用于 JSON 格式的 MOC 文件，确保所有 metadata 被正确保留
     * @param mocFile - MOC 文件
     * @param modifyCallback - 修改数据的回调函数
     */
    async modifyMOCData(
        mocFile: TFile,
        modifyCallback: (data: MOCParseResult) => void | Promise<void>
    ): Promise<void> {
        await this.enqueueModify(mocFile.path, async () => {
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            const originalContent = await this.app.vault.read(mocFile);
            if (this.hooks?.onBeforeModify) {
                await this.hooks.onBeforeModify({ filePath: mocFile.path, content: originalContent });
            }

            // 使用 JSON codec：通过 parse/modify/save 流程来保留所有 metadata
            const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
            const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);

            // 深拷贝数据，避免修改缓存中的数据
            const mocDataCopy = deepCopyMOCResult(mocData);

            // 锁定文件级布局风格：新建 MOC 已在创建时写入 nodeLayoutStyle。
            // 老 MOC 没有该字段，必须按历史默认 free 补齐，避免全局默认切到 auto 后污染旧文件。
            if (mocDataCopy.nodeLayoutStyle !== 'free' && mocDataCopy.nodeLayoutStyle !== 'auto') {
                mocDataCopy.nodeLayoutStyle = 'free';
            }

            // 调用修改回调（操作的是拷贝，不影响缓存）
            await modifyCallback(mocDataCopy);

            // 保存更新后的数据（这会保留 crossDomainLinks 等所有 metadata）
            await saveMOCStructure(this.app, mocFile.path, headingTitle, mocDataCopy);
        });
    }

    async modifyMOCDataBatch(
        mocFile: TFile,
        modifyCallbacks: Array<(data: MOCParseResult) => void | Promise<void>>
    ): Promise<void> {
        await this.modifyMOCData(mocFile, async (mocData) => {
            for (const modifyCallback of modifyCallbacks) {
                await modifyCallback(mocData);
            }
        });
    }

    /**
     * 程序化追加子节点(供 URI / 外部脚本调用,不依赖 UI)。
     * 子节点 ID 采用点号层级约定(parentID.N),边由 GraphDataBuilder 的层级兜底自动渲染,
     * 因此无需写 reverseRelations。不写坐标,交给自动布局。
     * @param parentID 父节点 ID;传 '__root__' 在根层追加
     * @returns 新节点 ID
     */
    async addChildNodeToMOC(
        mocFile: TFile,
        parentID: string,
        title: string,
        kind: 'text' | 'file' = 'text',
    ): Promise<string> {
        let newID = '';
        await this.modifyMOCData(mocFile, (mocData) => {
            newID = MOCHandler.insertChildNode(mocData, parentID, title, kind);
            this.applyHeadlessAutoLayout(mocData, [newID]);
        });
        return newID;
    }

    /**
     * 批量追加子节点(供 CLI / 脚本一次性建树)。所有插入在同一次 modifyMOCData 中完成:
     * 单次读-改-写,后续 item 在内存中即可看到前面新增的节点,无读后写竞态,且只触发一次文件写入。
     * @param items 每项 {parent, title, kind?};parent 可用 '__root__' 表示根层,
     *              也可引用本批次中前面刚生成的节点 ID(按顺序应用)。
     * @returns 与 items 对应的新节点 ID 数组
     */
    async addNodesToMOC(
        mocFile: TFile,
        items: Array<{ parent: string; title: string; kind?: 'text' | 'file' }>,
    ): Promise<string[]> {
        const newIDs: string[] = [];
        await this.modifyMOCData(mocFile, (mocData) => {
            for (const item of items) {
                newIDs.push(MOCHandler.insertChildNode(mocData, item.parent, item.title, item.kind ?? 'text'));
            }
            this.applyHeadlessAutoLayout(mocData, newIDs);
        });
        return newIDs;
    }

    /**
     * 批量新增「反向连线」(关联箭头边),供 CLI / 脚本调用。在同一次 modifyMOCData 中完成:
     * 单次读-改-写,只触发一次写入。每条边写入 mocData.reverseRelations(key=`source->target`)。
     * 与树的父子边不同,这些是任意两节点间的关联边(画布上渲染为虚线箭头,可带文字标签)。
     * @param items 每项 {source, target, label?};source/target 为已存在节点的 nodeID。
     * @returns 实际新增的边 key 数组(`source->target`);已存在的同向边会被跳过(不重复)。
     * @throws 端点节点不存在,或 source===target(自环)时抛错。
     */
    async addRelationsToMOC(
        mocFile: TFile,
        items: Array<{ source: string; target: string; label?: string }>,
    ): Promise<string[]> {
        const addedKeys: string[] = [];
        await this.modifyMOCData(mocFile, (mocData) => {
            // 收集全部已存在节点 ID,用于校验端点
            const allIDs = new Set<string>();
            const collect = (ns: MOCTreeNode[]) => { for (const n of ns) { allIDs.add(String(n.nodeID)); collect(n.children ?? []); } };
            collect(mocData.nodes);

            for (const item of items) {
                const source = String(item.source ?? '').trim();
                const target = String(item.target ?? '').trim();
                if (!source || !target) throw new Error('relation source/target required');
                if (source === target) throw new Error(`relation cannot be a self-loop: "${source}"`);
                if (!allIDs.has(source)) throw new Error(`relation source node not found: "${source}"`);
                if (!allIDs.has(target)) throw new Error(`relation target node not found: "${target}"`);

                const key = `${source}->${target}`;
                if (mocData.reverseRelations.has(key)) continue; // 已存在同向边,跳过
                mocData.reverseRelations.set(key, { sourceID: source, targetID: target, relationText: item.label ?? '' });
                addedKeys.push(key);
            }
        });
        return addedKeys;
    }

    /**
     * 落地一批草稿节点(#20),支持「同批内部父子树」。在同一次 modifyMOCData 中按序插入,
     * 用 localId→真实ID 映射解析批内父子引用,避免预测 ID。items 须父先子后(拓扑序)。
     * @param items 每项 {localId, title, kind?, parentLocalId?, parentRealId?}
     *   - parentLocalId:指向同批前面已插入项的 localId(批内树)
     *   - parentRealId:挂到已存在真实节点;两者都无 → 挂根 '__root__'
     * @returns localId → 落地后真实节点 ID 的映射
     */
    async addDraftTreeToMOC(
        mocFile: TFile,
        items: Array<{ localId: string; title: string; kind?: 'text' | 'file'; parentLocalId?: string; parentRealId?: string; position?: { x: number; y: number } }>,
    ): Promise<Map<string, string>> {
        const localToReal = new Map<string, string>();
        await this.modifyMOCData(mocFile, (mocData) => {
            for (const item of items) {
                let parent = '__root__';
                if (item.parentLocalId && localToReal.has(item.parentLocalId)) {
                    parent = localToReal.get(item.parentLocalId)!;
                } else if (item.parentRealId) {
                    parent = item.parentRealId;
                }
                const newId = MOCHandler.insertChildNode(mocData, parent, item.title, item.kind ?? 'text');
                localToReal.set(item.localId, newId);
                // 把草稿在画布上的落点写入 nodePositions,让落地后节点停在用户看到的位置(free 布局尤为关键)。
                // auto 布局文件随后由 applyHeadlessAutoLayout 重算居中坐标覆盖,符合"自动排布"语义。
                if (item.position) {
                    if (!mocData.nodePositions) mocData.nodePositions = {};
                    mocData.nodePositions[newId] = { x: item.position.x, y: item.position.y };
                }
            }
            this.applyHeadlessAutoLayout(mocData, Array.from(localToReal.values()));
        });
        return localToReal;
    }

    /**
     * 只读查询(供 CLI / 脚本),不写文件。解析 .moc,返回精简嵌套节点树。
     * - 不传 nodeID / query:返回整棵树(顶层节点数组,各自带 children)
     * - nodeID:精确定位该节点,返回它及其后代(单元素数组)
     * - query:对 nodeID / target / alias 大小写不敏感模糊匹配,返回所有命中节点(各自带其子树)
     * nodeID 与 query 同时传时以 nodeID 优先。recursive=false 时只保留直接子节点(不含孙级)。
     */
    async queryMOC(mocFile: TFile, opts: MOCQueryOptions = {}): Promise<MOCNodeView[]> {
        const headingTitle = this.plugin.settings.mocHeadingTitle;
        const { parseMOCStructure } = await import('src/utils/utils');
        const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);
        const roots: MOCTreeNode[] = mocData.nodes || [];
        const positions = mocData.nodePositions || {};

        const levels = opts.recursive === false ? 1 : Infinity;
        const viewOf = (n: MOCTreeNode, depthLeft: number): MOCNodeView => {
            const v: MOCNodeView = {
                nodeID: String(n.nodeID),
                nodeType: n.nodeType,
                target: n.target,
                depth: n.depth,
                children: depthLeft > 0 ? (n.children || []).map((c: MOCTreeNode) => viewOf(c, depthLeft - 1)) : [],
            };
            if (n.alias) v.alias = n.alias;
            const pos = positions[String(n.nodeID)];
            if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
                v.x = pos.x;
                v.y = pos.y;
            }
            return v;
        };

        // 精确按 ID:在整棵树里递归定位
        if (opts.nodeID) {
            const wanted = String(opts.nodeID);
            const find = (list: MOCTreeNode[]): MOCTreeNode | null => {
                for (const n of list) {
                    if (String(n.nodeID) === wanted) return n;
                    const hit = find(n.children || []);
                    if (hit) return hit;
                }
                return null;
            };
            const node = find(roots);
            return node ? [viewOf(node, levels)] : [];
        }

        // 模糊按文本:扁平收集后过滤(命中节点各自带子树)
        if (opts.query) {
            const q = opts.query.toLowerCase();
            const hits: MOCTreeNode[] = [];
            const collect = (list: MOCTreeNode[]) => {
                for (const n of list) {
                    const hay = `${n.nodeID}\n${n.target ?? ''}\n${n.alias ?? ''}`.toLowerCase();
                    if (hay.includes(q)) hits.push(n);
                    collect(n.children || []);
                }
            };
            collect(roots);
            return hits.map((n) => viewOf(n, levels));
        }

        // 无条件:整棵树
        return roots.map((n) => viewOf(n, levels));
    }

    /**
     * 无头(CLI/脚本)场景下,直接为 auto 节点算好居中坐标写入 nodePositions,
     * 使文件创建时即居中——视图打开无需再 reflow,避免"先歪后居中"的闪动。
     * 节点尺寸用文本长度估算;居中的对称性不依赖精确尺寸,故根节点必然居中。
     *
     * 既处理整库 auto 文件,也处理 free 文件里的 auto 子树岛(nodeLayoutOverrides 把
     * 某子树标为 auto)——后者以该岛顶点为固定锚点(保留其坐标),只重排其下的 auto 后代,
     * 与视图 relayoutAutoLayoutSiblings 的"free 父锚点 + auto 子树"语义一致。
     * 不这么做的话,CLI 往 free 文件的 auto 岛里加节点会完全不布局、和既有兄弟堆叠重叠。
     *
     * @param newNodeIds 本次新增的节点 ID(可选)。给定时只重排"含新节点的 auto 岛",
     *   避免动到用户手动摆好的其它 auto 岛;省略时重排全部 auto 岛。
     */
    private applyHeadlessAutoLayout(mocData: MOCParseResult, newNodeIds?: string[]): void {
        const tree: MOCTreeNode[] = mocData.nodes;
        if (!tree?.length) return;

        const fileDefault: 'auto' | 'free' = mocData.nodeLayoutStyle === 'auto' ? 'auto' : 'free';
        const overrides: Record<string, 'auto' | 'free'> = mocData.nodeLayoutOverrides || {};
        const hasAutoOverride = Object.values(overrides).some((v) => v === 'auto');
        // 整库 free 且无任何 auto 岛 → 没有需要自动排布的节点,直接返回(自由节点坐标由调用方给)。
        if (fileDefault !== 'auto' && !hasAutoOverride) return;

        // 沿父级链解析有效布局风格(与视图 getEffectiveNodeLayoutStyle 同逻辑)。
        const effectiveStyle = (nodeId: string): 'auto' | 'free' => {
            let cur = nodeId;
            while (cur.length > 0) {
                const o = overrides[cur];
                if (o !== undefined) return o;
                const parts = cur.split('.');
                if (parts.length <= 1) break;
                cur = parts.slice(0, -1).join('.');
            }
            return fileDefault;
        };
        const isAuto = (id: string) => effectiveStyle(id) === 'auto';

        const nodes: Record<string, AutoLayoutNodeInput> = {};
        const parentById: Record<string, string | undefined> = {};
        const childrenById: Record<string, string[]> = {};  // 仅含 auto 子节点(供引擎下行)
        const rootIds: string[] = [];

        // 用真实 DOM 测量(与视图同一套字体/算法),使 CLI 产出的尺寸=视图实测尺寸,
        // 从而布局与手动创建像素级一致。运行环境是 Obsidian 渲染进程,activeDocument 可用;
        // 万一不可用(无 activeDocument)则回退到 measureNodeLabel 纯估算。
        let measurer: DomTextMeasurer | null = null;
        const hasDom = typeof activeDocument !== 'undefined' && !!activeDocument.body;
        if (hasDom) {
            try { measurer = new DomTextMeasurer(activeDocument.body); } catch { measurer = null; }
        }
        const domMeasure = measurer ? (text: string, opts: DomTextMeasureOptions) => measurer!.measure(text, opts) : null;
        const sizeOf = (label: string, depth: number) => measureTextNodeBox(label, depth, domMeasure);

        // 方向提示:沿用视图首次布局的同款偏置(depth 越深 x 越大 → 全部朝同侧 E,竖向堆叠),
        // 保证 CLI 产出与手动/视图重排一致(同侧堆叠、根竖直居中),而非左右交替。
        const dirHint: Record<string, { x: number; y: number }> = {};
        let order = 0;
        const walk = (list: MOCTreeNode[], parentId: string | undefined, depth: number) => {
            for (const n of list) {
                const id = String(n.nodeID);
                nodes[id] = {
                    id,
                    size: sizeOf(n.target, depth),
                    position: { x: 0, y: 0 },
                    colorKey: '__default__',
                };
                dirHint[id] = { x: depth * 260, y: order * 150 };
                parentById[id] = parentId;
                if (!childrenById[id]) childrenById[id] = [];
                // 引擎只沿 auto 子链下行:free 子树(包括 auto 文件里被 override 成 free 的)
                // 不进父节点排布列表,保留其自身坐标。
                if (parentId && isAuto(id)) (childrenById[parentId] ||= []).push(id);
                if (!parentId) rootIds.push(id);
                order++;
                walk(n.children || [], id, depth + 1);
            }
        };
        walk(tree, undefined, 0);

        const realMocRootIds = new Set<string>(rootIds);

        // 锚点 = 各 auto 子树岛的顶点:岛内最高的 auto 节点(其父非 auto,即 free 或不存在)。
        // 引擎以锚点为根、保留其坐标,向下重排整岛的 auto 后代。
        const islandTopOf = (id: string): string => {
            let cur = id;
            while (true) {
                const p = parentById[cur];
                if (!p || !isAuto(p)) return cur;
                cur = p;
            }
        };
        // 收集某锚点下的全部 auto 后代(不含锚点自身)→ 放进 ignore 集让引擎重算坐标。
        const autoDescendantsOf = (anchor: string): string[] => {
            const out: string[] = [];
            const stack = [...(childrenById[anchor] || [])];
            while (stack.length) {
                const id = stack.pop()!;
                out.push(id);
                for (const c of childrenById[id] || []) stack.push(c);
            }
            return out;
        };

        const seedIds = (newNodeIds && newNodeIds.length)
            ? newNodeIds.filter((id) => nodes[id] && isAuto(id))
            // 未指定新增节点:重排所有 auto 岛(岛顶点 = 自身 auto 但父非 auto)。
            : Object.keys(nodes).filter((id) => isAuto(id) && !isAuto(parentById[id] || '__none__'));
        const anchors = new Set<string>(seedIds.map(islandTopOf));
        if (anchors.size === 0) { measurer?.destroy(); return; }

        const preset = normalizeLayoutPreset(this.plugin.settings.autoLayoutDefaultGrowthDirection);
        const merged: Record<string, { x: number; y: number }> = {};
        for (const anchor of anchors) {
            // 锚点用其真实保存坐标作为放置起点(整库 auto 时根可能尚无坐标 → 退回原点);
            // 引擎按 nodes[anchor].position 放根,围绕它对称重排后代。
            nodes[anchor].position = mocData.nodePositions?.[anchor]
                ? { ...mocData.nodePositions[anchor] }
                : { x: 0, y: 0 };
            // 岛内 auto 后代全部进 ignore → 用引擎算出的坐标(关闭旧空位、给新兄弟让位),
            // 而非各自保留旧坐标(那会让新增节点直接堆在既有兄弟上)。
            const ignore = new Set<string>(autoDescendantsOf(anchor));
            const positions = computeAutoLayout({
                relayoutRootId: anchor,
                nodes,
                parentById,
                childrenById,
                realMocRootIds,
                nodePositions: dirHint,
                ignoreSavedPositionsForIds: ignore,
                layoutPreset: preset,
                nodeLayoutPresets: mocData.nodeLayoutPresets,
            });
            Object.assign(merged, positions);
        }

        if (!mocData.nodePositions) mocData.nodePositions = {};
        Object.assign(mocData.nodePositions, merged);
        if (!mocData.layoutPreset) mocData.layoutPreset = preset;

        measurer?.destroy();
    }

    /**
     * 纯内存插入一个子节点,返回新节点 ID。不做 IO,供单个/批量两条路径共用。
     * 子节点 ID 采用点号层级约定(parentID.N),边由 GraphDataBuilder 的层级兜底自动渲染,
     * 因此无需写 reverseRelations。不写坐标,交给自动布局。
     */
    private static insertChildNode(
        mocData: MOCParseResult,
        parentID: string,
        title: string,
        kind: 'text' | 'file' = 'text',
    ): string {
        const text = (title ?? '').trim();
        if (!text) throw new Error('empty node title');

        const nodes: MOCTreeNode[] = mocData.nodes;
        // 收集所有现有 ID,保证唯一
        const allIDs = new Set<string>();
        const collect = (ns: MOCTreeNode[]) => { for (const n of ns) { allIDs.add(String(n.nodeID)); collect(n.children ?? []); } };
        collect(nodes);

        // 定位父节点(__root__ 表示根层)
        const findNode = (ns: MOCTreeNode[]): MOCTreeNode | null => {
            for (const n of ns) {
                if (String(n.nodeID) === parentID) return n;
                const found = findNode(n.children ?? []);
                if (found) return found;
            }
            return null;
        };
        const parent = parentID === '__root__' ? null : findNode(nodes);
        if (parentID !== '__root__' && !parent) {
            throw new Error(`parent node not found: "${parentID}"`);
        }

        const siblings: MOCTreeNode[] = parent ? (parent.children ??= []) : nodes;
        const depth = parent ? (parent.depth ?? 0) + 1 : 0;

        // 计算下一个可用编号:根层用整数,子层用 parentID.N
        const prefix = parent ? `${parentID}.` : '';
        let maxIdx = 0;
        for (const node of siblings) {
            const id = String(node.nodeID);
            const rest = parent ? (id.startsWith(prefix) ? id.slice(prefix.length) : null) : id;
            if (rest && /^\d+$/.test(rest)) maxIdx = Math.max(maxIdx, parseInt(rest));
        }
        let idx = maxIdx + 1;
        let newID = `${prefix}${idx}`;
        while (allIDs.has(newID)) { idx++; newID = `${prefix}${idx}`; }

        siblings.push({ nodeID: newID, nodeType: kind, target: text, depth, children: [], relationText: '', file: null });
        return newID;
    }

    private updateNodeColorInData(mocData: MOCParseResult, nodeID: string, color: string): void {
        if (!mocData.nodeColors) {
            mocData.nodeColors = {};
        }

        if (color) {
            mocData.nodeColors[nodeID] = color;
        } else {
            delete mocData.nodeColors[nodeID];
        }
    }

    private cleanupDeletedNodeMetadata(mocData: MOCParseResult, nodeID: string): void {
        if (mocData.nodePositions && mocData.nodePositions[nodeID]) {
            delete mocData.nodePositions[nodeID];
        }
        if (mocData.nodeColors && mocData.nodeColors[nodeID]) {
            delete mocData.nodeColors[nodeID];
        }
        if (mocData.nodeStyleColors && mocData.nodeStyleColors[nodeID]) {
            delete mocData.nodeStyleColors[nodeID];
        }
        if (mocData.embedNodeSizes && mocData.embedNodeSizes[nodeID]) {
            delete mocData.embedNodeSizes[nodeID];
        }
        if (mocData.nodeRemarks && mocData.nodeRemarks[nodeID]) {
            delete mocData.nodeRemarks[nodeID];
        }
        if (mocData.collapsedNodeIds) {
            mocData.collapsedNodeIds = mocData.collapsedNodeIds
                .filter((id: string) => id !== nodeID && !id.startsWith(`${nodeID}.`));
        }
        if (mocData.nodeLayoutOverrides && mocData.nodeLayoutOverrides[nodeID]) {
            delete mocData.nodeLayoutOverrides[nodeID];
        }
        if (mocData.nodeLayoutPresets && mocData.nodeLayoutPresets[nodeID]) {
            delete mocData.nodeLayoutPresets[nodeID];
        }
    }

    private deleteNodeFromData(mocData: MOCParseResult, nodeID: string): void {
        let deleted = false;
        const deletedNodeIds = new Set<string>();

        const collectNodeIds = (node: MOCTreeNode): void => {
            if (node?.nodeID) {
                deletedNodeIds.add(node.nodeID);
            }
            if (node?.children) {
                node.children.forEach((child: MOCTreeNode) => collectNodeIds(child));
            }
        };

        const deleteNodeFromTree = (nodes: MOCTreeNode[], targetID: string): boolean => {
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                if (node.nodeID === targetID) {
                    collectNodeIds(node);
                    nodes.splice(i, 1);
                    return true;
                }
                if (node.children && node.children.length > 0) {
                    if (deleteNodeFromTree(node.children, targetID)) {
                        return true;
                    }
                }
            }
            return false;
        };

        deleted = deleteNodeFromTree(mocData.nodes, nodeID);

        if (!deleted && mocData.crossDomainLinks) {
            const isCrossDomainNode = nodeID.startsWith('cd-');

            for (const sourceNodeId in mocData.crossDomainLinks) {
                const links = mocData.crossDomainLinks[sourceNodeId];
                const initialLength = links.length;

                mocData.crossDomainLinks[sourceNodeId] = links.filter((link: CrossDomainLink) => {
                    if (link.nodeId === nodeID) {
                        return false;
                    }
                    if (isCrossDomainNode) {
                        const originalNodeId = nodeID.substring(3);
                        if (link.nodeId === originalNodeId) {
                            return false;
                        }
                    }
                    return true;
                });

                if (mocData.crossDomainLinks[sourceNodeId].length < initialLength) {
                    deleted = true;
                    if (mocData.crossDomainLinks[sourceNodeId].length === 0) {
                        delete mocData.crossDomainLinks[sourceNodeId];
                    }
                    break;
                }
            }
        }

        if (!deleted) {
            throw new Error(`未找到节点: ${nodeID}`);
        }

        deletedNodeIds.add(nodeID);
        deletedNodeIds.forEach((deletedNodeId) => this.cleanupDeletedNodeMetadata(mocData, deletedNodeId));

        if (mocData.edgeCurvatures) {
            Object.keys(mocData.edgeCurvatures).forEach((key) => {
                const parts = key.split('-');
                if (parts.some((part) => deletedNodeIds.has(part))) {
                    delete mocData.edgeCurvatures[key];
                }
            });
        }

        const newReverseRelations = new Map();
        for (const [key, relation] of mocData.reverseRelations) {
            if (!deletedNodeIds.has(relation.sourceID) && !deletedNodeIds.has(relation.targetID)) {
                newReverseRelations.set(key, relation);
            }
        }
        mocData.reverseRelations = newReverseRelations;

        if (mocData.groups) {
            mocData.groups.forEach((group) => {
                if (Array.isArray(group.nodeIds)) {
                    group.nodeIds = group.nodeIds.filter((id: string) => !deletedNodeIds.has(id));
                }
            });
            mocData.groups = mocData.groups.filter((group) => group.nodeIds && group.nodeIds.length > 0);
        }
    }

    private deleteCrossDomainNodeFromData(mocData: MOCParseResult, nodeID: string, crossDomainLinkInfo: { sourceNodeId?: string; nodeId?: string }): void {
        if (!mocData.crossDomainLinks) {
            throw new Error(`未找到跨领域链接数据`);
        }

        const sourceNodeId = crossDomainLinkInfo.sourceNodeId;
        const originalNodeId = crossDomainLinkInfo.nodeId;

        if (!sourceNodeId || !mocData.crossDomainLinks[sourceNodeId]) {
            throw new Error(`未找到跨领域链接: sourceNodeId=${sourceNodeId}`);
        }

        const links = mocData.crossDomainLinks[sourceNodeId];
        const initialLength = links.length;

        mocData.crossDomainLinks[sourceNodeId] = links.filter(
            (link: CrossDomainLink) => link.nodeId !== originalNodeId
        );

        if (mocData.crossDomainLinks[sourceNodeId].length < initialLength) {
            if (mocData.crossDomainLinks[sourceNodeId].length === 0) {
                delete mocData.crossDomainLinks[sourceNodeId];
            }

            this.cleanupDeletedNodeMetadata(mocData, nodeID);

            if (mocData.edgeCurvatures) {
                Object.keys(mocData.edgeCurvatures).forEach(key => {
                    const parts = key.split('-');
                    if (parts.includes(nodeID)) {
                        delete mocData.edgeCurvatures[key];
                    }
                });
            }
        } else {
            throw new Error(`未找到跨领域节点链接: ${originalNodeId}`);
        }
    }

    /**
     * 在 MOC 文件中更新节点颜色
     */
    async updateNodeColorInMOC(mocFile: TFile, nodeID: string, color: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            this.updateNodeColorInData(mocData, nodeID, color);
        });
    }

    /**
     * 更新一级分支的主题色，渲染时由该分支下的所有节点继承
     */
    async updateBranchStyleColorInMOC(mocFile: TFile, branchID: string, color: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodeStyleColors) {
                mocData.nodeStyleColors = {};
            }

            if (color) {
                mocData.nodeStyleColors[branchID] = color;
            } else {
                delete mocData.nodeStyleColors[branchID];
            }
        });
    }

    /**
     * 在 MOC 文件中更新节点内容
     * - text 节点：newContent 即节点文本，写入 target
     * - file/embed 节点：newContent 为显示文本；若传入 newWikiLink，则更新 target；
     *   对 file 类型，newContent 与 target 不同时作为 alias，相同则清空 alias
     */
    async updateNodeContentInMOC(
        mocFile: TFile,
        nodeID: string,
        newContent: string,
        newWikiLink?: string,
        newIsEmbed?: boolean
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            const updateNodeContentInTree = (nodes: MOCTreeNode[]): boolean => {
                for (const node of nodes) {
                    if (node.nodeID === nodeID) {
                        if (node.nodeType === 'text') {
                            node.target = newContent;
                            delete node.alias;
                            return true;
                        }

                        if (typeof newWikiLink === 'string') {
                            node.target = newWikiLink;
                        }
                        if (typeof newIsEmbed === 'boolean') {
                            node.nodeType = newIsEmbed ? 'embed' : 'file';
                            // 从 embed 切回文件节点时，清除预览卡片尺寸持久化，避免节点沿用大尺寸
                            if (!newIsEmbed && mocData.embedNodeSizes) {
                                delete mocData.embedNodeSizes[nodeID];
                            }
                        }
                        // file / embed：alias 与 target 不同时才保留
                        if (newContent && newContent !== node.target) {
                            node.alias = newContent;
                        } else {
                            delete node.alias;
                        }
                        return true;
                    }

                    // 递归搜索子节点
                    if (node.children && node.children.length > 0) {
                        if (updateNodeContentInTree(node.children)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            const updated = updateNodeContentInTree(mocData.nodes);
            if (!updated) {
                throw new Error(`未找到节点: ${nodeID}`);
            }
        });
    }

    /**
     * 兼容旧调用：更新文本节点内容
     */
    async updateTextNodeContentInMOC(mocFile: TFile, nodeID: string, newContent: string): Promise<void> {
        await this.updateNodeContentInMOC(mocFile, nodeID, newContent);
    }

    async toggleNodeAnchorInMOC(mocFile: TFile, nodeID: string, anchor: boolean): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodeAnchors) {
                mocData.nodeAnchors = {};
            }
            if (anchor) {
                mocData.nodeAnchors[nodeID] = true;
            } else {
                delete mocData.nodeAnchors[nodeID];
            }
        });
    }

    async updateNodeRemarkInMOC(mocFile: TFile, nodeID: string, remark: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodeRemarks) {
                mocData.nodeRemarks = {};
            }

            const trimmedRemark = remark.trim();
            if (trimmedRemark) {
                mocData.nodeRemarks[nodeID] = trimmedRemark;
            } else {
                delete mocData.nodeRemarks[nodeID];
            }
        });
    }

    /**
     * 在 MOC 文件中更新节点 ID
     * 如果节点有子节点，也会递归更新子节点的 ID 前缀
     * 例如：1.a 改为 1.c，则 1.a.1 会改为 1.c.1
     * @returns 返回更新的节点数量（包括父节点和所有子节点）
     */
    async updateNodeIDInMOC(mocFile: TFile, oldID: string, newID: string): Promise<number> {
        let updateCount = 0;

        await this.modifyMOCData(mocFile, (mocData) => {
            // 存储所有需要更新的 ID 映射（包括子节点）
            const idMappings: Array<{ old: string; new: string }> = [];

            // 更新节点树中的 ID，并收集所有受影响的节点（包括子节点）
            const updateNodeIDInTree = (nodes: MOCTreeNode[], oldID: string, newID: string): boolean => {
                for (const node of nodes) {
                    if (node.nodeID === oldID) {
                        // 找到直接匹配的节点
                        node.nodeID = newID;
                        idMappings.push({ old: oldID, new: newID });

                        // 递归更新所有子节点的 ID 前缀
                        const updateChildrenIDs = (children: MOCTreeNode[], parentOldPrefix: string, parentNewPrefix: string) => {
                            for (const child of children) {
                                const oldChildID = child.nodeID;
                                // 检查子节点 ID 是否以父节点旧 ID 为前缀
                                if (oldChildID.startsWith(parentOldPrefix + '.')) {
                                    const newChildID = parentNewPrefix + oldChildID.substring(parentOldPrefix.length);
                                    child.nodeID = newChildID;
                                    idMappings.push({ old: oldChildID, new: newChildID });

                                    // 递归处理深层子节点
                                    if (child.children && child.children.length > 0) {
                                        updateChildrenIDs(child.children, parentOldPrefix, parentNewPrefix);
                                    }
                                }
                            }
                        };

                        // 更新所有子节点
                        if (node.children && node.children.length > 0) {
                            updateChildrenIDs(node.children, oldID, newID);
                        }

                        return true;
                    }
                    if (node.children && node.children.length > 0) {
                        if (updateNodeIDInTree(node.children, oldID, newID)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            const updated = updateNodeIDInTree(mocData.nodes, oldID, newID);

            if (!updated) {
                throw new Error(`未找到节点: ${oldID}`);
            }

            // 保存更新数量（不包括父节点本身，只统计子节点）
            updateCount = idMappings.length - 1;

            // 更新 reverseRelations 中的节点 ID（处理所有映射）
            const newReverseRelations = new Map();
            for (const [, relation] of mocData.reverseRelations) {
                let newSourceID = relation.sourceID;
                let newTargetID = relation.targetID;

                // 检查是否需要更新 sourceID
                for (const mapping of idMappings) {
                    if (relation.sourceID === mapping.old) {
                        newSourceID = mapping.new;
                        break;
                    }
                }

                // 检查是否需要更新 targetID
                for (const mapping of idMappings) {
                    if (relation.targetID === mapping.old) {
                        newTargetID = mapping.new;
                        break;
                    }
                }

                const newKey = `${newSourceID}->${newTargetID}`;
                newReverseRelations.set(newKey, {
                    sourceID: newSourceID,
                    targetID: newTargetID,
                    relationText: relation.relationText
                });
            }
            mocData.reverseRelations = newReverseRelations;

            // 更新节点位置（处理所有映射）
            for (const mapping of idMappings) {
                if (mocData.nodePositions && mocData.nodePositions[mapping.old]) {
                    mocData.nodePositions[mapping.new] = mocData.nodePositions[mapping.old];
                    delete mocData.nodePositions[mapping.old];
                }
            }

            // 更新边弧度（需要更新包含该节点的所有边 key）
            if (mocData.edgeCurvatures) {
                const newCurvatures: Record<string, { distance: number; weight: number }> = {};
                Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                    let newKey = key;
                    // 对每个映射进行替换
                    for (const mapping of idMappings) {
                        newKey = newKey.split('-').map(part => part === mapping.old ? mapping.new : part).join('-');
                    }
                    newCurvatures[newKey] = value;
                });
                mocData.edgeCurvatures = newCurvatures;
            }

            // 更新节点颜色（处理所有映射）
            for (const mapping of idMappings) {
                if (mocData.nodeColors && mocData.nodeColors[mapping.old]) {
                    mocData.nodeColors[mapping.new] = mocData.nodeColors[mapping.old];
                    delete mocData.nodeColors[mapping.old];
                }
                if (mocData.nodeStyleColors && mocData.nodeStyleColors[mapping.old]) {
                    mocData.nodeStyleColors[mapping.new] = mocData.nodeStyleColors[mapping.old];
                    delete mocData.nodeStyleColors[mapping.old];
                }
            }

            // 更新跨领域链接中的节点 ID（处理所有映射）
            for (const mapping of idMappings) {
                if (mocData.crossDomainLinks && mocData.crossDomainLinks[mapping.old]) {
                    mocData.crossDomainLinks[mapping.new] = mocData.crossDomainLinks[mapping.old];
                    delete mocData.crossDomainLinks[mapping.old];
                }
            }
            if (mocData.collapsedNodeIds) {
                for (const mapping of idMappings) {
                    mocData.collapsedNodeIds = mocData.collapsedNodeIds
                        .map((id: string) => id === mapping.old ? mapping.new : id);
                }
            }
        });

        return updateCount;
    }

    /**
     * 重定向父子边的终点：将 oldTarget 从父节点下移出（变为自由节点），
     * 将 newTarget 从当前位置移入 oldTarget 原来的父节点下（继承 oldTarget 的 ID）。
     * 所有操作在一次 modifyMOCData 中完成，避免多次读写同一文件导致中间状态被覆盖。
     */
    async redirectParentEdgeTarget(mocFile: TFile, oldTarget: string, newTarget: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            // ---- 辅助：从树中找节点并移除，返回 {node, parent} ----
            const findAndRemove = (targetID: string): { node: MOCTreeNode; parent: MOCTreeNode | null } => {
                // 在根层查找
                const rootIdx = mocData.nodes.findIndex((n: MOCTreeNode) => n.nodeID === targetID);
                if (rootIdx !== -1) {
                    const [node] = mocData.nodes.splice(rootIdx, 1);
                    return { node, parent: null };
                }
                // 在子树中查找
                const search = (nodes: MOCTreeNode[]): { node: MOCTreeNode; parent: MOCTreeNode } | null => {
                    for (const n of nodes) {
                        if (!n.children?.length) continue;
                        const idx = n.children.findIndex((c: MOCTreeNode) => c.nodeID === targetID);
                        if (idx !== -1) {
                            const [node] = n.children.splice(idx, 1);
                            return { node, parent: n };
                        }
                        const found = search(n.children);
                        if (found) return found;
                    }
                    return null;
                };
                const result = search(mocData.nodes);
                if (result) return result;
                throw new Error(`未找到节点: ${targetID}`);
            };

            // ---- 辅助：对子树中所有节点做 ID 前缀替换，收集映射 ----
            const remapSubtree = (node: MOCTreeNode, oldPrefix: string, newPrefix: string): Array<{ old: string; new: string }> => {
                const mappings: Array<{ old: string; new: string }> = [];
                const walk = (n: MOCTreeNode) => {
                    const oldID = n.nodeID;
                    const newID = oldID === oldPrefix
                        ? newPrefix
                        : oldID.startsWith(oldPrefix + '.') ? newPrefix + oldID.slice(oldPrefix.length) : oldID;
                    if (oldID !== newID) {
                        mappings.push({ old: oldID, new: newID });
                        n.nodeID = newID;
                    }
                    n.children?.forEach(walk);
                };
                walk(node);
                return mappings;
            };

            // ---- 辅助：计算下一个可用的 free.N ID ----
            const nextFreeID = (): string => {
                const allIDs: string[] = [];
                const collect = (nodes: MOCTreeNode[]) => { for (const n of nodes) { allIDs.push(n.nodeID); collect(n.children ?? []); } };
                collect(mocData.nodes);
                const nums = allIDs
                    .map(id => { const m = id.match(/^free\.(\d+)$/); return m ? parseInt(m[1]) : 0; })
                    .filter(n => n > 0);
                return `free.${nums.length ? Math.max(...nums) + 1 : 1}`;
            };

            // ---- 辅助：应用映射到元数据（不含 nodePositions，位置槽保持不动） ----
            const applyMappings = (mappings: Array<{ old: string; new: string }>) => {
                const applyMap = (id: string) => mappings.find(m => m.old === id)?.new ?? id;

                // reverseRelations
                const newRR = new Map<string, ReverseRelation>();
                for (const [, rel] of mocData.reverseRelations) {
                    const src = applyMap(rel.sourceID);
                    const tgt = applyMap(rel.targetID);
                    newRR.set(`${src}->${tgt}`, { sourceID: src, targetID: tgt, relationText: rel.relationText });
                }
                mocData.reverseRelations = newRR;

                // nodePositions：随 ID 一起重命名，每个节点保持自己的视觉位置
                if (mocData.nodePositions) {
                    const np: Record<string, { x: number; y: number }> = {};
                    for (const [k, v] of Object.entries(mocData.nodePositions)) np[applyMap(k)] = v;
                    mocData.nodePositions = np;
                }

                // edgeCurvatures
                if (mocData.edgeCurvatures) {
                    const nc: Record<string, { distance: number; weight: number }> = {};
                    for (const [k, v] of Object.entries(mocData.edgeCurvatures))
                        nc[k.split('-').map(applyMap).join('-')] = v;
                    mocData.edgeCurvatures = nc;
                }

                // 其他键值映射字段
                for (const field of ['nodeColors', 'nodeStyleColors', 'embedNodeSizes', 'nodeRemarks', 'crossDomainLinks', 'nodeLayoutPresets']) {
                    const obj = (mocData as unknown as Record<string, Record<string, unknown> | undefined>)[field];
                    if (!obj) continue;
                    const nb: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(obj)) nb[applyMap(k)] = v;
                    (mocData as unknown as Record<string, Record<string, unknown>>)[field] = nb;
                }
                if (mocData.collapsedNodeIds) {
                    mocData.collapsedNodeIds = mocData.collapsedNodeIds.map((id: string) => applyMap(id));
                }
            };

            // ======== 主逻辑 ========

            // 1. 取出 oldTarget，记下其父节点
            const { node: oldNode, parent: oldParent } = findAndRemove(oldTarget);

            // 2. 取出 newTarget，记下其旧父节点
            const { node: newNode, parent: newTargetOldParent } = findAndRemove(newTarget);

            // 3. 在 applyMappings 前，先删除两条失效的旧父子 reverseRelation：
            //    a) oldParent → oldTarget（oldTarget 将变为自由节点，该边不再有效）
            //    b) newTargetOldParent → newTarget（newTarget 将移入 oldParent，该边不再有效）
            if (oldParent) {
                mocData.reverseRelations.delete(`${oldParent.nodeID}->${oldTarget}`);
            }
            if (newTargetOldParent) {
                mocData.reverseRelations.delete(`${newTargetOldParent.nodeID}->${newTarget}`);
            }

            // 4. oldNode 变为自由节点，放到根层，重新分配 free.N ID
            const freeID = nextFreeID();
            const mappingsOld = remapSubtree(oldNode, oldTarget, freeID);
            mocData.nodes.push(oldNode);

            // 5. newNode 移入 oldTarget 原父节点的 children，继承 oldTarget 的 ID
            const mappingsNew = remapSubtree(newNode, newTarget, oldTarget);
            const parentDepth: number = oldParent ? (oldParent.depth ?? 0) : -1;
            const setDepth = (n: MOCTreeNode, d: number) => { n.depth = d; n.children?.forEach((c: MOCTreeNode) => setDepth(c, d + 1)); };
            setDepth(newNode, parentDepth + 1);

            if (oldParent) {
                oldParent.children.push(newNode);
            } else {
                mocData.nodes.push(newNode);
            }

            // 6. 更新所有元数据（两批映射合并应用）
            applyMappings([...mappingsOld, ...mappingsNew]);
        });
    }

    /**
     * 将自由节点移动为指定父节点的子节点
     * @param mocFile - MOC 文件
     * @param freeNodeID - 自由节点 ID（以 'free.' 开头）
     * @param parentID - 父节点 ID
     * @param newChildID - 新的子节点 ID
     */
    async moveNodeToParent(mocFile: TFile, freeNodeID: string, parentID: string, newChildID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            const idMappings: Array<{ old: string; new: string }> = [];
            const remapSubtreeIDs = (node: MOCTreeNode, oldPrefix: string, newPrefix: string, depth: number) => {
                const currentOldID = node.nodeID;
                const currentNewID = currentOldID === oldPrefix
                    ? newPrefix
                    : currentOldID.startsWith(`${oldPrefix}.`)
                        ? `${newPrefix}${currentOldID.substring(oldPrefix.length)}`
                        : currentOldID;

                if (currentOldID !== currentNewID) {
                    idMappings.push({ old: currentOldID, new: currentNewID });
                    node.nodeID = currentNewID;
                }

                node.depth = depth;

                if (node.children && node.children.length > 0) {
                    node.children.forEach((child: MOCTreeNode) => remapSubtreeIDs(child, oldPrefix, newPrefix, depth + 1));
                }
            };

            // 1. 找到并移除节点（可能在根节点，也可能在某个父节点的 children 中）
            let nodeToMove: MOCTreeNode | null = null;
            let foundInRoot = false;
            let foundIndex = -1;

            // 先在根节点中查找
            for (let i = 0; i < mocData.nodes.length; i++) {
                if (mocData.nodes[i].nodeID === freeNodeID) {
                    nodeToMove = mocData.nodes[i];
                    foundInRoot = true;
                    foundIndex = i;
                    break;
                }
            }

            // 如果在根节点中没找到，递归在父节点的 children 中查找
            if (!nodeToMove) {
                const removeFromParent = (nodes: MOCTreeNode[]): boolean => {
                    for (const node of nodes) {
                        if (node.children && node.children.length > 0) {
                            const childIndex = node.children.findIndex((child: MOCTreeNode) => child.nodeID === freeNodeID);
                            if (childIndex !== -1) {
                                nodeToMove = node.children.splice(childIndex, 1)[0];
                                return true;
                            }
                            // 递归查找
                            if (removeFromParent(node.children)) {
                                return true;
                            }
                        }
                    }
                    return false;
                };

                removeFromParent(mocData.nodes);
            }

            if (!nodeToMove) {
                throw new Error(`未找到节点: ${freeNodeID}`);
            }

            // 从原来的位置移除
            if (foundInRoot) {
                mocData.nodes.splice(foundIndex, 1);
            }
            // 如果 foundInParent 不为 null，节点已经在上面的递归函数中被移除了

            // 2. 找到父节点并添加为子节点
            const findNodeInTree = (nodes: MOCTreeNode[], targetID: string): MOCTreeNode | null => {
                for (const node of nodes) {
                    if (node.nodeID === targetID) {
                        return node;
                    }
                    if (node.children && node.children.length > 0) {
                        const found = findNodeInTree(node.children, targetID);
                        if (found) return found;
                    }
                }
                return null;
            };

            const parentNode = findNodeInTree(mocData.nodes, parentID);
            if (!parentNode) {
                throw new Error(`未找到父节点: ${parentID}`);
            }

            // 更新当前节点和整棵子树的 ID / 深度
            remapSubtreeIDs(nodeToMove, freeNodeID, newChildID, parentNode.depth + 1);
            // 换父后旧父级的“分离/定侧”意图已失效；清除后让新子节点重新参与自动布局。
            nodeToMove.extBitMap = ((nodeToMove.extBitMap || 0)
                & ~NODE_FLAG_SEPARATED
                & ~NODE_FLAG_SIDE_PINNED) & 0xff;

            // 添加到父节点的子节点列表
            if (!parentNode.children) {
                parentNode.children = [];
            }
            parentNode.children.push(nodeToMove);

            // 4. 更新节点位置、颜色和扩展信息
            idMappings.forEach((mapping) => {
                if (mocData.nodePositions && mocData.nodePositions[mapping.old]) {
                    mocData.nodePositions[mapping.new] = mocData.nodePositions[mapping.old];
                    delete mocData.nodePositions[mapping.old];
                }
                if (mocData.nodeColors && mocData.nodeColors[mapping.old]) {
                    mocData.nodeColors[mapping.new] = mocData.nodeColors[mapping.old];
                    delete mocData.nodeColors[mapping.old];
                }
                if (mocData.nodeStyleColors && mocData.nodeStyleColors[mapping.old]) {
                    mocData.nodeStyleColors[mapping.new] = mocData.nodeStyleColors[mapping.old];
                    delete mocData.nodeStyleColors[mapping.old];
                }
                if (mocData.embedNodeSizes && mocData.embedNodeSizes[mapping.old]) {
                    mocData.embedNodeSizes[mapping.new] = mocData.embedNodeSizes[mapping.old];
                    delete mocData.embedNodeSizes[mapping.old];
                }
                if (mocData.nodeRemarks && mocData.nodeRemarks[mapping.old]) {
                    mocData.nodeRemarks[mapping.new] = mocData.nodeRemarks[mapping.old];
                    delete mocData.nodeRemarks[mapping.old];
                }
                if (mocData.crossDomainLinks && mocData.crossDomainLinks[mapping.old]) {
                    mocData.crossDomainLinks[mapping.new] = mocData.crossDomainLinks[mapping.old];
                    delete mocData.crossDomainLinks[mapping.old];
                }
                if (mocData.nodeAnchors && mapping.old in mocData.nodeAnchors) {
                    mocData.nodeAnchors[mapping.new] = mocData.nodeAnchors[mapping.old];
                    delete mocData.nodeAnchors[mapping.old];
                }
                if (mocData.nodeLayoutOverrides && mapping.old in mocData.nodeLayoutOverrides) {
                    mocData.nodeLayoutOverrides[mapping.new] = mocData.nodeLayoutOverrides[mapping.old];
                    delete mocData.nodeLayoutOverrides[mapping.old];
                }
                if (mocData.nodeLayoutPresets && mapping.old in mocData.nodeLayoutPresets) {
                    mocData.nodeLayoutPresets[mapping.new] = mocData.nodeLayoutPresets[mapping.old];
                    delete mocData.nodeLayoutPresets[mapping.old];
                }
                if (mocData.collapsedNodeIds) {
                    mocData.collapsedNodeIds = mocData.collapsedNodeIds
                        .map((id: string) => id === mapping.old ? mapping.new : id);
                }
            });

            // 为新建一级节点自动分配分支主题色
            if (newChildID.split('.').length === 2) {
                if (!mocData.nodeStyleColors) {
                    mocData.nodeStyleColors = {};
                }
                if (!mocData.nodeStyleColors[newChildID]) {
                    mocData.nodeStyleColors[newChildID] = this.pickNextBranchStyleColor(mocData.nodeStyleColors);
                }
            }
            this.ensureFirstLevelNodeLayoutDefaults(mocData, newChildID);

            // 5. 更新边弧度（需要更新包含该节点的所有边 key）
            if (mocData.edgeCurvatures) {
                const newCurvatures: Record<string, { distance: number; weight: number }> = {};
                Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                    let newKey = key;
                    for (const mapping of idMappings) {
                        newKey = newKey.split('-').map(part => part === mapping.old ? mapping.new : part).join('-');
                    }
                    newCurvatures[newKey] = value;
                });
                mocData.edgeCurvatures = newCurvatures;
            }

            // 6. 更新 reverseRelations 中的节点 ID
            // 同时删掉旧父节点 -> 移动节点 的父子关系边（移动后该边已失效）
            const oldParentID = freeNodeID.includes('.')
                ? freeNodeID.split('.').slice(0, -1).join('.')
                : null;

            const newReverseRelations = new Map();
            for (const [, relation] of mocData.reverseRelations) {
                let newSourceID = relation.sourceID;
                let newTargetID = relation.targetID;

                for (const mapping of idMappings) {
                    if (newSourceID === mapping.old) {
                        newSourceID = mapping.new;
                    }
                    if (newTargetID === mapping.old) {
                        newTargetID = mapping.new;
                    }
                }

                // 跳过旧父节点 -> 新子节点 ID 的失效关系（它是移动前的父子树边，现已无意义）
                if (oldParentID && newSourceID === oldParentID && newTargetID === newChildID) {
                    continue;
                }

                const newKey = `${newSourceID}->${newTargetID}`;
                newReverseRelations.set(newKey, {
                    sourceID: newSourceID,
                    targetID: newTargetID,
                    relationText: relation.relationText
                });
            }
            mocData.reverseRelations = newReverseRelations;
        });
    }

    /**
     * 检查节点是否有父节点（即在某个父节点的 children 数组中）
     * @param mocFile - MOC 文件
     * @param nodeID - 要检查的节点 ID
     * @returns 是否有父节点
     */
    async checkNodeHasParent(mocFile: TFile, nodeID: string): Promise<boolean> {
        let hasParent = false;

        await this.modifyMOCData(mocFile, (mocData) => {
            // 检查节点是否在根节点层级
            const isRootNode = mocData.nodes.some((node: MOCTreeNode) => node.nodeID === nodeID);

            if (isRootNode) {
                // 节点在根层级，没有父节点
                hasParent = false;
                return;
            }

            // 递归查找节点是否在某个父节点的 children 中
            const findInChildren = (nodes: MOCTreeNode[]): boolean => {
                for (const node of nodes) {
                    if (node.children && node.children.length > 0) {
                        // 检查是否在该节点的 children 中
                        if (node.children.some((child: MOCTreeNode) => child.nodeID === nodeID)) {
                            return true;
                        }
                        // 递归查找
                        if (findInChildren(node.children)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            hasParent = findInChildren(mocData.nodes);
        });

        return hasParent;
    }

    /**
     * 将子节点转换为自由节点（从父节点的 children 中移除，添加到根节点）
     * @param mocFile - MOC 文件
     * @param childID - 子节点 ID
     * @param newFreeID - 新的自由节点 ID
     */
    async convertChildToFreeNode(mocFile: TFile, childID: string, newFreeID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            let nodeToConvert: MOCTreeNode | null = null;
            const idMappings: Array<{ old: string; new: string }> = [];
            const remapSubtreeIDs = (node: MOCTreeNode, oldPrefix: string, newPrefix: string, depth: number) => {
                const currentOldID = node.nodeID;
                const currentNewID = currentOldID === oldPrefix
                    ? newPrefix
                    : currentOldID.startsWith(`${oldPrefix}.`)
                        ? `${newPrefix}${currentOldID.substring(oldPrefix.length)}`
                        : currentOldID;

                if (currentOldID !== currentNewID) {
                    idMappings.push({ old: currentOldID, new: currentNewID });
                    node.nodeID = currentNewID;
                }

                node.depth = depth;

                if (node.children && node.children.length > 0) {
                    node.children.forEach((child: MOCTreeNode) => remapSubtreeIDs(child, oldPrefix, newPrefix, depth + 1));
                }
            };

            // 1. 从父节点的 children 中找到并移除子节点
            const removeFromParent = (nodes: MOCTreeNode[]): boolean => {
                for (const node of nodes) {
                    if (node.children && node.children.length > 0) {
                        const childIndex = node.children.findIndex((child: MOCTreeNode) => child.nodeID === childID);
                        if (childIndex !== -1) {
                            // 找到子节点，移除它
                            nodeToConvert = node.children.splice(childIndex, 1)[0];
                            return true;
                        }
                        // 递归查找
                        if (removeFromParent(node.children)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            if (!removeFromParent(mocData.nodes)) {
                throw new Error(`未找到子节点: ${childID}`);
            }

            if (!nodeToConvert) {
                throw new Error(`无法提取子节点: ${childID}`);
            }

            // 2. 更新节点 ID 和深度（整棵子树一起更新）
            remapSubtreeIDs(nodeToConvert, childID, newFreeID, 0);

            // 3. 添加到根节点
            mocData.nodes.push(nodeToConvert);

            // 4. 更新节点位置、颜色和扩展信息
            idMappings.forEach((mapping) => {
                if (mocData.nodePositions && mocData.nodePositions[mapping.old]) {
                    mocData.nodePositions[mapping.new] = mocData.nodePositions[mapping.old];
                    delete mocData.nodePositions[mapping.old];
                }
                if (mocData.nodeColors && mocData.nodeColors[mapping.old]) {
                    mocData.nodeColors[mapping.new] = mocData.nodeColors[mapping.old];
                    delete mocData.nodeColors[mapping.old];
                }
                if (mocData.nodeStyleColors && mocData.nodeStyleColors[mapping.old]) {
                    mocData.nodeStyleColors[mapping.new] = mocData.nodeStyleColors[mapping.old];
                    delete mocData.nodeStyleColors[mapping.old];
                }
                if (mocData.embedNodeSizes && mocData.embedNodeSizes[mapping.old]) {
                    mocData.embedNodeSizes[mapping.new] = mocData.embedNodeSizes[mapping.old];
                    delete mocData.embedNodeSizes[mapping.old];
                }
                if (mocData.nodeRemarks && mocData.nodeRemarks[mapping.old]) {
                    mocData.nodeRemarks[mapping.new] = mocData.nodeRemarks[mapping.old];
                    delete mocData.nodeRemarks[mapping.old];
                }
                if (mocData.crossDomainLinks && mocData.crossDomainLinks[mapping.old]) {
                    mocData.crossDomainLinks[mapping.new] = mocData.crossDomainLinks[mapping.old];
                    delete mocData.crossDomainLinks[mapping.old];
                }
                if (mocData.collapsedNodeIds) {
                    mocData.collapsedNodeIds = mocData.collapsedNodeIds
                        .map((id: string) => id === mapping.old ? mapping.new : id);
                }
            });

            // 5. 更新边弧度（需要更新包含该节点的所有边 key）
            if (mocData.edgeCurvatures) {
                const newCurvatures: Record<string, { distance: number; weight: number }> = {};
                Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                    let newKey = key;
                    for (const mapping of idMappings) {
                        newKey = newKey.split('-').map(part => part === mapping.old ? mapping.new : part).join('-');
                    }
                    newCurvatures[newKey] = value;
                });
                mocData.edgeCurvatures = newCurvatures;
            }

            // 6. 更新 reverseRelations 中的节点 ID，但要移除父节点到该子节点的反向关系
            const newReverseRelations = new Map();

            // 找到原父节点 ID（从 childID 中提取）
            const idParts = childID.split('.');
            const originalParentId = idParts.length > 1 ? idParts.slice(0, -1).join('.') : null;

            for (const [, relation] of mocData.reverseRelations) {
                let newSourceID = relation.sourceID;
                let newTargetID = relation.targetID;

                for (const mapping of idMappings) {
                    if (newSourceID === mapping.old) {
                        newSourceID = mapping.new;
                    }
                    if (newTargetID === mapping.old) {
                        newTargetID = mapping.new;
                    }
                }

                // 如果这是原父节点到该子节点的关系，跳过不添加（相当于删除）
                if (newSourceID === originalParentId && newTargetID === newFreeID) {
                    continue;
                }

                const newKey = `${newSourceID}->${newTargetID}`;
                newReverseRelations.set(newKey, {
                    sourceID: newSourceID,
                    targetID: newTargetID,
                    relationText: relation.relationText
                });
            }
            mocData.reverseRelations = newReverseRelations;
        });
    }

    /**
     * 从 MOC 文件中删除节点
     */
    async deleteNodeFromMOC(mocFile: TFile, nodeID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            this.deleteNodeFromData(mocData, nodeID);
        });
    }

    async deleteNodesFromMOC(
        mocFile: TFile,
        nodes: Array<{ nodeId: string; nodeData?: { isCrossDomain?: boolean; originalNode?: { crossDomainSourceNodeId?: string; crossDomainOriginalNodeId?: string } } }>
    ): Promise<void> {
        const sortedNodes = [...nodes].sort((a, b) => b.nodeId.split('.').length - a.nodeId.split('.').length);

        await this.modifyMOCData(mocFile, (mocData) => {
            for (const { nodeId, nodeData } of sortedNodes) {
                if (nodeData && nodeData.isCrossDomain) {
                    const crossDomainLinkInfo = {
                        sourceNodeId: nodeData.originalNode?.crossDomainSourceNodeId,
                        nodeId: nodeData.originalNode?.crossDomainOriginalNodeId
                    };
                    this.deleteCrossDomainNodeFromData(mocData, nodeId, crossDomainLinkInfo);
                } else {
                    this.deleteNodeFromData(mocData, nodeId);
                }
            }
        });
    }

    /**
     * 从 MOC 文件中删除跨思维树节点
     */
    async deleteCrossDomainNodeFromMOC(mocFile: TFile, nodeID: string, crossDomainLinkInfo: { sourceNodeId?: string; nodeId?: string }): Promise<void> {

        await this.modifyMOCData(mocFile, (mocData) => {
            this.deleteCrossDomainNodeFromData(mocData, nodeID, crossDomainLinkInfo);
        });
    }

    /**
     * 保存节点位置到 MOC 文件
     */
    async saveNodePositionToMOC(
        mocFile: TFile,
        nodeID: string,
        position: { x: number; y: number }
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodePositions) {
                mocData.nodePositions = {};
            }

            mocData.nodePositions[nodeID] = position;
        });
    }

    async setMocLayoutPreset(mocFile: TFile, preset: LayoutPreset): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            const normalized = normalizeLayoutPreset(preset);
            mocData.layoutPreset = normalized;
            if (mocData.nodeLayoutPresets) {
                for (const [nodeId, nodePreset] of Object.entries(mocData.nodeLayoutPresets)) {
                    if (nodePreset === normalized) {
                        delete mocData.nodeLayoutPresets[nodeId];
                    }
                }
                if (Object.keys(mocData.nodeLayoutPresets).length === 0) {
                    delete mocData.nodeLayoutPresets;
                }
            }
        });
    }

    async setNodeLayoutPreset(mocFile: TFile, nodeId: string, preset: LayoutPreset | null): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!this.isFirstLevelChild(mocData, nodeId)) {
                throw new Error(`节点 ${nodeId} 不是根的第一层子代，不能独立设置布局 preset`);
            }

            if (!mocData.nodeLayoutPresets) {
                mocData.nodeLayoutPresets = {};
            }

            if (preset === null) {
                delete mocData.nodeLayoutPresets[nodeId];
            } else {
                const filePreset = normalizeLayoutPreset(mocData.layoutPreset);
                const normalized = normalizeLayoutPreset(preset);
                if (normalized === filePreset) {
                    delete mocData.nodeLayoutPresets[nodeId];
                } else {
                    mocData.nodeLayoutPresets[nodeId] = normalized;
                }
            }

            if (Object.keys(mocData.nodeLayoutPresets).length === 0) {
                delete mocData.nodeLayoutPresets;
            }
        });
    }

    isFirstLevelChild(mocData: MOCParseResult, nodeId: string): boolean {
        return mocData.nodes.some((root) => root.children.some((child) => child.nodeID === nodeId));
    }

    /**
     * 保存边弧度到 MOC 文件
     */
    async saveEdgeCurvatureToMOC(
        mocFile: TFile,
        edgeId: string,
        curvature: { distance: number; weight: number }
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.edgeCurvatures) {
                mocData.edgeCurvatures = {};
            }

            mocData.edgeCurvatures[edgeId] = curvature;
        });
    }

    /**
     * 批量创建分组
     * @param mocFile - MOC 文件
     * @param nodeIds - 要包含在分组中的节点 ID 列表
     * @param groupName - 分组名称
     */
    async createGroupInMOC(
        mocFile: TFile,
        nodeIds: string[],
        groupName: string
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            // 初始化 groups 数组
            if (!mocData.groups) {
                mocData.groups = [];
            }

            // 生成唯一的分组 ID
            const groupId = `group_${Date.now()}`;

            // 创建分组，包含所有指定的节点
            const newGroup: GroupInfo = {
                id: groupId,
                label: groupName,
                nodeIds: nodeIds
            };

            // 添加到分组列表
            mocData.groups.push(newGroup);
        });
    }
}
