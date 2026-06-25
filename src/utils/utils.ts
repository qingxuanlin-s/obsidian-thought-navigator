import ZKNavigationPlugin, { ZoomPanScale } from "main";
import { App, loadMermaid, moment, TFile } from "obsidian";
import { LayoutPreset } from "src/utils/growthDirection";
import { ZKNode } from "src/view/indexView";

// 节点类型
// - file:  文件节点（[[link]] 或 [[link|alias]]）
// - text:  纯文字节点（不关联文件）
// - embed: 嵌入节点（![[link]]）
export type MOCNodeType = 'file' | 'text' | 'embed';

// MOC 解析的节点结构
export interface MOCTreeNode {
    nodeID: string;             // 节点ID，如 "a", "a.1", "a.1.a"
    nodeType: MOCNodeType;      // 节点类型
    extBitMap?: number;         // 节点扩展位图 (8位, 0-255); 见 NODE_FLAG_* 常量
    target: string;             // file/embed: wiki 链接目标；text: 原始文本内容
    alias?: string;             // 显示别名（仅 file 类型 + [[link|alias]] 语法；与 target 不同时才有值）
    depth: number;              // 缩进深度（用于确定父子关系）
    children: MOCTreeNode[];    // 子节点
    file: TFile | null;         // 对应的文件（text 节点为 null）
    relationText: string;       // 关系描述，如 "引出", "相关"
    isArrowRelation?: boolean;  // 是否是箭头关系节点
    arrowSource?: string;       // 箭头关系的源节点ID
    arrowTarget?: string;       // 箭头关系的目标节点ID
}

// ---- MOC 文件后缀识别 ----
// 支持 .moc（旧）和 .moc.md（新）两种后缀
export const MOC_FILE_SUFFIX = '.moc.md';

export function isMocPath(path: string | null | undefined): boolean {
    if (!path) return false;
    const lower = path.toLowerCase();
    return lower.endsWith('.moc.md') || lower.endsWith('.moc');
}

export function isMocFile(file: TFile | null | undefined): boolean {
    if (!file) return false;
    return isMocPath(file.path);
}

export function stripMocSuffix(name: string): string {
    return name.replace(/\.moc\.md$/i, '').replace(/\.moc$/i, '');
}

// ---- 辅助函数 ----

// 构造 MOCTreeNode，提供默认值以降低 16 处构造点的出错概率
export function createMOCTreeNode(opts: {
    nodeID: string;
    nodeType?: MOCNodeType;
    extBitMap?: number;
    target?: string;
    alias?: string;
    depth?: number;
    children?: MOCTreeNode[];
    file?: TFile | null;
    relationText?: string;
    isArrowRelation?: boolean;
    arrowSource?: string;
    arrowTarget?: string;
}): MOCTreeNode {
    const node: MOCTreeNode = {
        nodeID: opts.nodeID,
        nodeType: opts.nodeType ?? 'file',
        target: opts.target ?? '',
        depth: opts.depth ?? 0,
        children: opts.children ?? [],
        file: opts.file ?? null,
        relationText: opts.relationText ?? '',
    };
    if (opts.alias !== undefined && opts.alias !== node.target) node.alias = opts.alias;
    if (opts.extBitMap !== undefined && opts.extBitMap !== 0) node.extBitMap = opts.extBitMap & 0xff;
    if (opts.isArrowRelation) node.isArrowRelation = opts.isArrowRelation;
    if (opts.arrowSource !== undefined) node.arrowSource = opts.arrowSource;
    if (opts.arrowTarget !== undefined) node.arrowTarget = opts.arrowTarget;
    return node;
}

// 获取节点显示文本（alias 优先，无则用 target）
export function getNodeDisplay(node: MOCTreeNode): string {
    return node.alias ?? node.target;
}

// 反向关系信息
export interface ReverseRelation {
    sourceID: string;           // 源节点ID
    targetID: string;           // 目标节点ID
    relationText: string;       // 关系描述
}

// 节点扩展位图标志位 (存于 MOCTreeNode.extBitMap, 0-255 的 8 位整数)
// bit0: 已从父节点轨道分离 —— auto 布局下被拖出"分离圆"外的节点,作为固定锚点
// 保留坐标、子树独立生长,且不占父节点的排布槽位。
// (兼容:旧版此位语义为"用户手动拖动过 NODE_FLAG_MANUALLY_MOVED",复用同一 bit
//  平滑迁移——旧的手动钉住节点会被当作已分离锚点。)
export const NODE_FLAG_SEPARATED = 1 << 0;
// bit1: 侧别已被用户固定 —— auto 布局下被拖到某一侧的节点,无论层级深浅都按自身
// 保存位置导出左右(E/W 等),不再继承父节点方向。否则深层节点会在每次 reflow 时
// 被强制继承父方向 → 用户拖到对侧的节点会弹回。
export const NODE_FLAG_SIDE_PINNED = 1 << 1;

// MOC 解析结果
export interface MOCParseResult {
    nodes: MOCTreeNode[];       // 解析后的树节点数组
    reverseRelations: Map<string, ReverseRelation>; // 反向关系 Map，key 格式: "sourceID->targetID"
    nodePositions: Record<string, { x: number; y: number }>; // 节点位置信息
    groups: GroupInfo[];        // 分组信息
    edgeCurvatures: Record<string, { distance: number; weight: number }>; // 边弧度信息
    nodeColors: Record<string, string>; // 节点颜色信息
    nodeStyleColors: Record<string, string>; // 分支主题色（一级节点）
    crossDomainLinks?: Record<string, CrossDomainLink[]>; // 跨领域节点关联信息
    embedNodeSizes?: Record<string, { width: number; height: number }>; // 预览节点尺寸（模型坐标系）
    nodeRemarks?: Record<string, string>; // 节点备注
    nodeAnchors?: Record<string, boolean>; // 锚点节点
    collapsedNodeIds?: string[]; // 折叠的节点 ID
    nodeLayoutStyle?: 'free' | 'auto'; // 节点布局风格（新建文件时锁定，后期修改设置不受影响）
    nodeLayoutOverrides?: Record<string, 'auto' | 'free'>; // 节点级布局风格覆盖（优先于文件级 nodeLayoutStyle）
    layoutPreset?: LayoutPreset; // 自动布局 preset（bidirectional/top-down/radial）
    nodeLayoutPresets?: Record<string, LayoutPreset>; // 根节点第一层子代的布局 preset 覆盖
    isProject?: boolean; // v0.5: 是否为项目（标记后在选择器中置顶并显示项目徽章）
    metadata: {                 // 扩展信息
        totalNodes: number;     // 总节点数
        maxDepth: number;       // 最大深度
        hasReverseRelations: boolean; // 是否包含反向关系
        parseTime: number;      // 解析耗时（毫秒）
        filePath: string;       // MOC 文件路径
        headingTitle: string;   // 标题名称
    };
}

// 跨领域节点关联
export interface CrossDomainLink {
    nodeId: string;             // 关联的节点 ID
    mocPath: string;            // 关联的 MOC 文件路径
    displayText: string;        // 节点显示文本
    filePath: string;           // 节点文件路径
    position?: { x: number; y: number };  // 虚拟跨领域节点的位置
}

// 分组信息
export interface GroupInfo {
    id: string;                 // 分组 ID
    label: string;              // 分组标签
    nodeIds: string[];          // 包含的节点 ID 列表
    color?: string;             // 分组颜色（可选）
}

// 解析 MOC 笔记中指定标题下的树结构
export async function parseMOCStructure(
    app: App,
    filePath: string,
    headingTitle: string
): Promise<MOCParseResult> {
    const startTime = Date.now();

    const file = app.vault.getFileByPath(filePath);
    if (!file) {
        return {
            nodes: [],
            reverseRelations: new Map(),
            nodePositions: {},
            groups: [],
            edgeCurvatures: {},
            nodeColors: {},
            nodeStyleColors: {},
            crossDomainLinks: {},
            embedNodeSizes: {},
            nodeRemarks: {},
            nodeAnchors: {},
            collapsedNodeIds: [],
            metadata: {
                totalNodes: 0,
                maxDepth: 0,
                hasReverseRelations: false,
                parseTime: Date.now() - startTime,
                filePath,
                headingTitle,
            }
        };
    }


    if (!isMocFile(file)) {
        throw new Error(`Not a JSON MOC file: ${filePath}`);
    }

    // 用 adapter.read 直读磁盘，绕过 vault.read 基于 mtime 的缓存：
    // 同一秒内连续写入(如脚本/CLI 快速 addNode)mtime 不变会导致 vault.read 返回旧内容，
    // 造成"读到刚写入前的快照、父节点找不到"的竞态。adapter.read 总是磁盘真实内容。
    const diskContent = await app.vault.adapter.read(filePath);
    const { parseMOCJson } = await import('./mocJsonCodec');
    return parseMOCJson(diskContent, filePath, app);
}

// 将 MOC 树结构转换为 ZKNode 数组
export async function convertMOCToZKNodes(
    plugin: ZKNavigationPlugin,
    mocTrees: MOCTreeNode[],
    reverseRelations: Map<string, ReverseRelation> = new Map(),
    parentIDArr: string[] = [],
    nodePositions: Record<string, { x: number; y: number }> = {}
): Promise<ZKNode[]> {
    const nodes: ZKNode[] = [];
    let position = 0;

    const processNode = async (
        mocNode: MOCTreeNode,
        currentIDArr: string[],
        index: number
    ): Promise<void> => {
        // 构建 ID 数组
        const nodeIDArr = [...currentIDArr];

        // 如果有节点 ID，使用它；否则使用索引
        if (mocNode.nodeID) {
            // 直接使用完整的节点 ID（如 "a.1.a"）
            nodeIDArr.push(mocNode.nodeID);
        } else {
            nodeIDArr.push(index.toString());
        }

        const isTextOnly = mocNode.nodeType === 'text';
        const isEmbed = mocNode.nodeType === 'embed';

        // 只有当文件存在或是纯文字节点时才创建并添加节点
        if (!mocNode.file && !isTextOnly) {
            // 既没有文件也不是纯文字节点，跳过但递归处理子节点
            for (let i = 0; i < mocNode.children.length; i++) {
                await processNode(mocNode.children[i], nodeIDArr, i);
            }
            return;
        }

        // 对于 MOC 节点，IDStr 直接使用 nodeID（如 "a", "a.1"）
        // 这样父子关系判断才能正确工作
        const idStr = mocNode.nodeID || nodeIDArr.join(',');
        const display = getNodeDisplay(mocNode);

        const zkNode: ZKNode = {
            ID: mocNode.nodeID || mocNode.target,
            IDArr: nodeIDArr,
            IDStr: idStr,
            position: position++,
            file: mocNode.file,  // 纯文字节点为 null
            title: display,
            relationText: mocNode.relationText,
            displayText: getDisplayText(plugin, mocNode),
            wikiLink: mocNode.target,
            ctime: mocNode.file?.stat?.ctime || Date.now(),  // 纯文字节点使用当前时间
            randomId: random(16),
            nodeSons: 1,
            startY: 0,
            height: 0,
            isRoot: currentIDArr.length === 0,
            fixWidth: 0,
            branchName: "",
            gitNodePos: 0,
            isTextOnly,
            isEmbed,
        };

        // 如果有保存的位置信息，添加到节点
        const nodeID = mocNode.nodeID || mocNode.target;
        if (nodePositions[nodeID]) {
            zkNode.savedPosition = nodePositions[nodeID];
        }

        nodes.push(zkNode);

        // 递归处理子节点
        for (let i = 0; i < mocNode.children.length; i++) {
            await processNode(mocNode.children[i], nodeIDArr, i);
        }
    };

    // 处理所有根节点
    for (let i = 0; i < mocTrees.length; i++) {
        await processNode(mocTrees[i], parentIDArr, i);
    }


    // 重新计算 position 和 isRoot
    nodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
    for (let i = 0; i < nodes.length; i++) {
        nodes[i].position = i;
        // 检查是否有父节点 - 基于节点ID的层级关系
        if (nodes[i].IDStr) {
            const idParts = nodes[i].IDStr.split('.');
            // 自由节点（free.*）是孤立节点，不应被视为根节点
            if (nodes[i].IDStr.startsWith('free.')) {
                nodes[i].isRoot = false;
            } else if (idParts.length === 1) {
                nodes[i].isRoot = true;
            } else {
                const parentId = idParts.slice(0, -1).join('.');
                const hasParent = nodes.find(n => n.IDStr === parentId);
                nodes[i].isRoot = !hasParent;
            }
        } else {
            nodes[i].isRoot = parentIDArr.length === 0;
        }
    }

    return nodes;
}

// 根据设置生成显示文本
function getDisplayText(plugin: ZKNavigationPlugin, mocNode: MOCTreeNode): string {
    const id = mocNode.nodeID || mocNode.target;
    const title = getNodeDisplay(mocNode);

    // 如果有关系描述，加入显示
    //let prefix = relation ? `${relation} ` : '';

    // 编号用反引号包裹（因为只有用反引号包裹的编号才会被识别）
    const wrappedId = id ? id : '';

    switch (plugin.settings.NodeText) {
        case "id":
            return wrappedId;
        case "title":
            return (title || wrappedId);
        case "both":
        default:
            return `${wrappedId}: ${title}`;
    }
}

// formatting Luhmann style IDs
export async function ID_formatting(id: string, arr: string[], siblingsOrder: string): Promise<string[]> {
    if (/^[0-9]$/.test(id[0])) {
        const numStr = id.match(/\d+/g);
        if (numStr && numStr.length > 0) {
            arr.push(numStr[0].padStart(4, "0"));
            const len = numStr[0].length;
            if (len < id.length) {
                return await ID_formatting(id.slice(len), arr, siblingsOrder);
            } else {
                return arr;
            }
        } else {
            return arr;
        }
    } else if (/^[a-zA-Z]$/.test(id[0])) {
        let letterStr: string;
        if (siblingsOrder === "letter") {
            letterStr = id[0].padStart(5, "0");
        } else {
            letterStr = id[0];
        }
        arr.push(letterStr)
        if (id.length === 1) {
            return arr;
        } else {
            return await ID_formatting(id.slice(1), arr, siblingsOrder);
        }
    } else {
        if (id.length === 1) {
            return arr;
        } else {
            return await ID_formatting(id.slice(1), arr, siblingsOrder);
        }
    }
}

// translating different ID fields(filename/attribute/prefix of filename) into standard ZKNode array
export async function mainNoteInit(plugin: ZKNavigationPlugin) {

    const app = plugin.app;
    let mainNoteFiles: TFile[] = app.vault.getFiles();

    if (plugin.settings.MainNoteExt == 'md') {
        mainNoteFiles = mainNoteFiles.filter(file => file.extension == "md");
    }

    //clear our folder field
    if (plugin.settings.FolderOfMainNotes !== "") {
        plugin.settings.FolderList.push(plugin.settings.FolderOfMainNotes);
        plugin.settings.FolderOfMainNotes = "";
    }

    if (plugin.settings.FolderList.length > 0) {

        const validFolders = [...new Set(plugin.settings.FolderList)].filter(folder => folder !== "");

        const tempMainNoteFiles: TFile[] = [];

        for (let i = 0; i < validFolders.length; i++) {

            if (validFolders[i] === '/') {
                tempMainNoteFiles.push(...mainNoteFiles.filter(file => file.parent && file.parent.name === ""))

            } else {
                tempMainNoteFiles.push(...mainNoteFiles.filter(
                    file => {
                        return file.path.replace(file.name, "").startsWith(validFolders[i] + '/');
                    }))
            }
        }
        mainNoteFiles = uniqueByTFile(tempMainNoteFiles);
    }

    if (plugin.settings.TagOfMainNotes !== '') {

        let mdMainNote: TFile[] = [];
        let otherMainNote: TFile[] = [];

        if (plugin.settings.MainNoteExt == 'all') {
            otherMainNote = mainNoteFiles.filter(file => file.extension !== "md");
        }

        mdMainNote = mainNoteFiles.filter(
            file => file.extension == 'md' && getfileTags(app, file).includes(plugin.settings.TagOfMainNotes)
        )
        mainNoteFiles = mdMainNote.concat(otherMainNote);
    }

    plugin.MainNotes = [];

    for (const note of mainNoteFiles) {
        const IDArr: string[] = [];

        const node: ZKNode = {
            ID: '',
            IDArr: IDArr,
            IDStr: '',
            position: 0,
            file: note,
            title: '',
            displayText: '',
            relationText: '',
            ctime: 0,
            randomId: random(16),
            nodeSons: 1,
            startY: 0,
            height: 0,
            isRoot: false,
            fixWidth: 0,
            branchName: "",
            gitNodePos: 0,
        }

        const nodeCache = app.metadataCache.getFileCache(note);

        switch (plugin.settings.IDFieldOption) {
            case "1":
                node.ID = note.basename;

                node.IDArr = await ID_formatting(node.ID, node.IDArr, plugin.settings.siblingsOrder);

                node.IDStr = IDArr.toString();

                if (nodeCache !== null && node.file?.extension == 'md') {
                    if (typeof nodeCache.frontmatter !== 'undefined' && plugin.settings.TitleField !== "") {

                        const title = nodeCache.frontmatter[plugin.settings.TitleField]?.toString();
                        if (typeof title == "string" && title.length > 0) {
                            node.title = title;
                        }
                    }
                }

                break;
            case "2":
                if (node.file?.extension == 'md') {
                    if (nodeCache !== null) {
                        if (typeof nodeCache.frontmatter !== 'undefined' && plugin.settings.IDField !== "") {
                            const id = nodeCache.frontmatter[plugin.settings.IDField];
                            if (Array.isArray(id)) {
                                if (id[0] === null) {
                                    continue;
                                }
                                node.ID = id[0].toString();
                                node.IDArr = await ID_formatting(node.ID, node.IDArr, plugin.settings.siblingsOrder);
                                node.IDStr = node.IDArr.toString();
                                node.title = note.basename;
                            } else if (typeof id == "string") {
                                node.ID = id;
                                node.IDArr = await ID_formatting(node.ID, node.IDArr, plugin.settings.siblingsOrder);
                                node.IDStr = node.IDArr.toString();
                                node.title = note.basename;
                            } else if (typeof id == 'number') {
                                node.ID = id.toString();
                                node.IDArr = await ID_formatting(node.ID, node.IDArr, plugin.settings.siblingsOrder);
                                node.IDStr = node.IDArr.toString();
                                node.title = note.basename;
                            }
                        }
                    }
                    if (node.ID == '') {
                        continue;
                    }
                }
                break;
            case "3": {
                let parts: string[] = [];

                // 根据配置的分隔符分割文件名
                if (plugin.settings.Separator === "other") {
                    parts = note.basename.split(plugin.settings.OtherSeparator);
                } else {
                    parts = note.basename.split(plugin.settings.Separator);
                }

                // 必须有至少2部分（ID和标题），且标题不能为空
                if (parts.length < 2 || !parts[1] || parts[1].trim() === '') {
                    continue; // 跳过不符合格式的文件
                }

                node.ID = parts[0].trim();
                node.title = parts.slice(1).join(plugin.settings.Separator === "other" ? plugin.settings.OtherSeparator : plugin.settings.Separator).trim();
                node.IDArr = await ID_formatting(node.ID, node.IDArr, plugin.settings.siblingsOrder);
                node.IDStr = IDArr.toString();
                break;
            }
            default:
            // do nothing
        }

        if (plugin.settings.CustomCreatedTime.length > 0 && node.file?.extension == 'md') {

            const ctime = nodeCache?.frontmatter?.[plugin.settings.CustomCreatedTime];

            if (ctime) {
                const time = moment(ctime);
                if (time.isValid()) {
                    node.ctime = time.valueOf();
                }
            }
        }

        if (node.ctime === 0) {
            node.ctime = node.file?.stat?.ctime || Date.now()
        }

        plugin.MainNotes.push(node);
    }

    plugin.MainNotes = plugin.MainNotes.filter(n => n.IDArr.length > 0);

    plugin.MainNotes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));

    for (let i = 0; i < plugin.MainNotes.length; i++) {
        const node = plugin.MainNotes[i];
        node.position = i;
        if (!plugin.MainNotes.find(n => n.IDArr.toString() == node.IDArr.slice(0, -1).toString())) {
            node.isRoot = true;
        }

        switch (plugin.settings.NodeText) {
            case "id":
                node.displayText = node.ID;
                break;
            case "title":
                if (node.title == "") {
                    node.displayText = node.ID;
                } else {
                    node.displayText = node.title;
                }
                break;
            case "both":
                node.displayText = `${node.ID}: ${node.title}`;
                break;
            default:
            //do nothing
        }
    }
}

export const random = (e: number) => {
    const t = [];
    for (let n = 0; n < e; n++) {
        t.push((16 * Math.random() | 0).toString(16));
    }
    return t.join("");
};


function uniqueByTFile(arr: TFile[]) {
    const map = new Map();
    const result = [];
    for (const item of arr) {
        const compoundKey = item.path;
        if (!map.has(compoundKey)) {
            map.set(compoundKey, true);
            result.push(item);
        }
    }
    return result;
}


export function displayWidth(str: string) {
    let length = 0;
    for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        length += charCode >= 0 && charCode <= 128 ? 1 : 2;
    }
    return length;
}

export async function addSvgPanZoom(
    zkGraph: HTMLDivElement,
    indexMermaidDiv: HTMLElement,
    i: number,
    plugin: ZKNavigationPlugin,
    mermaidStr: string, height: number) {

    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`${zkGraph.id}-svg`, mermaidStr);

    const parsedSvg = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    zkGraph.appendChild(activeDocument.importNode(parsedSvg, true));

    if (plugin.settings.graphType === "roadmap") {
        zkGraph.children[0].removeAttribute('style');
    }

    zkGraph.children[0].addClass("zk-full-width");

    zkGraph.children[0].setAttr('height', `${height}px`);

    indexMermaidDiv.appendChild(zkGraph);

    const svgPanZoomModule = await import("svg-pan-zoom");
    const svgPanZoom = (svgPanZoomModule as any).default ?? svgPanZoomModule;
    const panZoomTiger = await svgPanZoom(`#${zkGraph.id}-svg`, {
        zoomEnabled: true,
        controlIconsEnabled: false,
        fit: true,
        center: true,
        minZoom: 0.001,
        maxZoom: 1000,
        dblClickZoomEnabled: false,
        zoomScaleSensitivity: 0.2,

        onZoom: async () => {
            // 安全检查：确保数组元素存在
            if (plugin.settings.zoomPanScaleArr[i]) {
                plugin.settings.zoomPanScaleArr[i].zoomScale = panZoomTiger.getZoom();
            }
        },
        onPan: async () => {
            // 安全检查：确保数组元素存在
            if (plugin.settings.zoomPanScaleArr[i]) {
                plugin.settings.zoomPanScaleArr[i].pan = panZoomTiger.getPan();
            }
        }
    })

    // 将 panZoom 实例存储到 SVG 元素上，方便后续访问
    const svgElement = activeDocument.getElementById(`${zkGraph.id}-svg`);
    if (svgElement) {
        // @ts-ignore
        svgElement.panZoomInstance = panZoomTiger;
    }

    const touchSvg = activeDocument.getElementById(`${zkGraph.id}-svg`);

    if (touchSvg !== null) {
        let startDistance = 0;
        let scale = panZoomTiger.getZoom();
        const lastScale = scale;

        touchSvg.addEventListener('touchstart', (event) => {
            if (event.touches.length === 2) {
                const touch1 = event.touches[0];
                const touch2 = event.touches[1];
                startDistance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
            }
        })

        touchSvg.addEventListener('touchmove', (event) => {
            if (event.touches.length === 2) {
                const touch1 = event.touches[0];
                const touch2 = event.touches[1];
                const currentDistance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
                const newScale = currentDistance / startDistance;
                scale = scale * newScale / lastScale;
                panZoomTiger.zoom(scale);
            }
        })
    }

    if (typeof plugin.settings.zoomPanScaleArr[i] === 'undefined') {

        const setSvg = activeDocument.getElementById(`${zkGraph.id}-svg`);

        if (setSvg !== null) {
            const a = setSvg.children[0].getAttr("style");
            if (a) {
                const b = a.match(/\d([^,]+)\d/g)
                if (b !== null && Number(b[0]) > 1) {
                    panZoomTiger.zoom(1 / Number(b[0]))
                }
            }
            const zoomPanScale: ZoomPanScale = {
                graphID: zkGraph.id,
                zoomScale: panZoomTiger.getZoom(),
                pan: panZoomTiger.getPan(),
            };

            plugin.settings.zoomPanScaleArr.push(zoomPanScale);
        }

    } else {
        panZoomTiger.zoom(plugin.settings.zoomPanScaleArr[i].zoomScale);
        panZoomTiger.pan(plugin.settings.zoomPanScaleArr[i].pan);

    }
}

function getfileTags(app: App, file: TFile) {
    const fileTags: string[] = [];
    const fmTags = app.metadataCache.getFileCache(file)?.frontmatter?.tags;
    if (fmTags) {
        if (Array.isArray(fmTags)) {

            for (const tag of fmTags) {
                splitNestedTags("#" + tag, fileTags);
            }

        } else if (typeof fmTags == "string") {
            splitNestedTags("#" + fmTags, fileTags);
        }
    }

    const tags = app.metadataCache.getFileCache(file)?.tags

    if (tags && Array.isArray(tags)) {

        for (const tag of tags) {
            splitNestedTags(tag.tag, fileTags);
        }
    }

    return fileTags;
}

function splitNestedTags(nestTag: string, arr: string[]) {
    const words = nestTag.split("/");
    let tagStr = "";
    for (const word of words) {
        tagStr = tagStr.concat(word);
        arr.push(tagStr);
        tagStr = tagStr.concat("/");
    }
    return arr
}

/**
 * 保存 MOC 数据到文件
 * @param app - Obsidian App 实例
 * @param filePath - 文件路径
 * @param headingTitle - 标题名称
 * @param data - MOC 解析结果
 */
export async function saveMOCStructure(
    app: App,
    filePath: string,
    headingTitle: string,
    data: MOCParseResult
): Promise<void> {
    const file = app.vault.getFileByPath(filePath);
    if (!file) {
        throw new Error(`File not found: ${filePath}`);
    }

    if (!isMocFile(file)) {
        throw new Error(`Not a JSON MOC file: ${filePath}`);
    }

    const { serializeMOCJson } = await import('./mocJsonCodec');
    await app.vault.modify(file, serializeMOCJson(data));
    await new Promise(resolve => window.setTimeout(resolve, 50));
}

/**
 * 获取所有 MOC 文件：
 * - .moc / .moc.md 文件全局识别，不限文件夹
 */
export function getMOCFilesInFolder(app: App, _folderPath: string): TFile[] {
    return app.vault.getFiles().filter(f => {
        if (isMocFile(f)) return true;
        return false;
    });
}
