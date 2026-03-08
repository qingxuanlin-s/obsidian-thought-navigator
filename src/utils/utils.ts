import ZKNavigationPlugin, { ZoomPanScale } from "main";
import { App, loadMermaid, moment, Notice, TFile } from "obsidian";
import { ZKNode } from "src/view/indexView";

// MOC 解析的节点结构
export interface MOCTreeNode {
    wikiLink: string;           // wiki链接，如 "20251214-波函数"（对于纯文字节点，存储原始文本）
    nodeID: string;             // 节点ID，如 "a", "a.1", "a.1.a"
    displayText: string;        // 显示文本（链接后的描述）
    depth: number;              // 缩进深度（用于确定父子关系）
    children: MOCTreeNode[];    // 子节点
    file: TFile | null;         // 对应的文件（纯文字节点为 null）
    relationText: string;       // 关系描述，如 "引出", "相关"
    isArrowRelation?: boolean;  // 是否是箭头关系节点
    arrowSource?: string;       // 箭头关系的源节点ID
    arrowTarget?: string;       // 箭头关系的目标节点ID
    isTextOnly?: boolean;       // 是否为纯文字节点（不关联文件）
    isEmbed?: boolean;          // 是否为嵌入节点（![[...]]）
}

// 反向关系信息
export interface ReverseRelation {
    sourceID: string;           // 源节点ID
    targetID: string;           // 目标节点ID
    relationText: string;       // 关系描述
}

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


    const content = await app.vault.read(file);

    // 使用 Mermaid 解析器
    const { MermaidParser } = await import('./mermaidParser');
    const mermaidParser = new MermaidParser(app);
    const result = await mermaidParser.parse(content, filePath, headingTitle);


    return result;
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

        // 只有当文件存在或是纯文字节点时才创建并添加节点
        if (!mocNode.file && !mocNode.isTextOnly) {
            // 既没有文件也不是纯文字节点，跳过但递归处理子节点
            for (let i = 0; i < mocNode.children.length; i++) {
                await processNode(mocNode.children[i], nodeIDArr, i);
            }
            return;
        }

        // 对于 MOC 节点，IDStr 直接使用 nodeID（如 "a", "a.1"）
        // 这样父子关系判断才能正确工作
        const idStr = mocNode.nodeID || nodeIDArr.join(',');

        const zkNode: ZKNode = {
            ID: mocNode.nodeID || mocNode.wikiLink,
            IDArr: nodeIDArr,
            IDStr: idStr,
            position: position++,
            file: mocNode.file,  // 纯文字节点为 null
            title: mocNode.displayText,
            relationText: mocNode.relationText,
            displayText: getDisplayText(plugin, mocNode),
            wikiLink: mocNode.wikiLink,
            ctime: mocNode.file?.stat?.ctime || Date.now(),  // 纯文字节点使用当前时间
            randomId: random(16),
            nodeSons: 1,
            startY: 0,
            height: 0,
            isRoot: currentIDArr.length === 0,
            fixWidth: 0,
            branchName: "",
            gitNodePos: 0,
            isTextOnly: mocNode.isTextOnly || false,  // 传递纯文字节点标记
            isEmbed: mocNode.isEmbed || false,
        };

        // 如果有保存的位置信息，添加到节点
        const nodeID = mocNode.nodeID || mocNode.wikiLink;
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
            if (idParts.length === 1) {
                nodes[i].isRoot = true;
            } else {
                const parentId = idParts.slice(0, -1).join('.');
                const hasParent = nodes.find(n => n.IDStr === parentId);
                // 如果找不到父节点，标记为根节点（如 free.1 找不到 free）
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
    const id = mocNode.nodeID || mocNode.wikiLink;
    const title = mocNode.displayText;

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
        let numStr = id.match(/\d+/g);
        if (numStr && numStr.length > 0) {
            arr.push(numStr[0].padStart(4, "0"));
            let len = numStr[0].length;
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

    let mainNoteFiles: TFile[] = this.app.vault.getFiles();

    if (plugin.settings.MainNoteExt == 'md') {
        mainNoteFiles = mainNoteFiles.filter(file => file.extension == "md");
    }

    //clear our folder field
    if (plugin.settings.FolderOfMainNotes !== "") {
        plugin.settings.FolderList.push(plugin.settings.FolderOfMainNotes);
        plugin.settings.FolderOfMainNotes = "";
    }

    if (plugin.settings.FolderList.length > 0) {

        let validFolders = [...new Set(plugin.settings.FolderList)].filter(folder => folder !== "");

        let tempMainNoteFiles: TFile[] = [];

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
            file => file.extension == 'md' && getfileTags(file).includes(plugin.settings.TagOfMainNotes)
        )
        mainNoteFiles = mdMainNote.concat(otherMainNote);
    }

    plugin.MainNotes = [];

    for (let note of mainNoteFiles) {
        let IDArr: string[] = [];

        let node: ZKNode = {
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

        let nodeCache = this.app.metadataCache.getFileCache(note);

        switch (plugin.settings.IDFieldOption) {
            case "1":
                node.ID = note.basename;

                node.IDArr = await ID_formatting(node.ID, node.IDArr, plugin.settings.siblingsOrder);

                node.IDStr = IDArr.toString();

                if (nodeCache !== null && node.file?.extension == 'md') {
                    if (typeof nodeCache.frontmatter !== 'undefined' && plugin.settings.TitleField !== "") {

                        let title = nodeCache.frontmatter[plugin.settings.TitleField]?.toString();
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
                            let id = nodeCache.frontmatter[plugin.settings.IDField];
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
            case "3":
                let temLen: number = 1;
                let parts: string[] = [];

                // 根据配置的分隔符分割文件名
                if (plugin.settings.Separator === "other") {
                    parts = note.basename.split(plugin.settings.OtherSeparator);
                    temLen = plugin.settings.OtherSeparator.length;
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
            default:
            // do nothing
        }

        if (plugin.settings.CustomCreatedTime.length > 0 && node.file?.extension == 'md') {

            let ctime = nodeCache?.frontmatter?.[plugin.settings.CustomCreatedTime];

            if (ctime) {
                let time = moment(ctime);
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
        let node = plugin.MainNotes[i];
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
    let t = [];
    for (let n = 0; n < e; n++) {
        t.push((16 * Math.random() | 0).toString(16));
    }
    return t.join("");
};


function uniqueByZKNote(arr: ZKNode[]) {
    const map = new Map();
    const result = [];
    for (const item of arr) {
        const filePath = item.file?.path || 'text-only';
        const compoundKey = item.ID + '_' + filePath;
        if (!map.has(compoundKey)) {
            map.set(compoundKey, true);
            result.push(item);
        }
    }
    return result;
}

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
    let { svg } = await mermaid.render(`${zkGraph.id}-svg`, mermaidStr);

    zkGraph.insertAdjacentHTML('beforeend', svg);

    if (plugin.settings.graphType === "roadmap") {
        zkGraph.children[0].removeAttribute('style');
    }

    zkGraph.children[0].addClass("zk-full-width");

    zkGraph.children[0].setAttr('height', `${height}px`);

    indexMermaidDiv.appendChild(zkGraph);

    const svgPanZoom = require("svg-pan-zoom");

    let panZoomTiger = await svgPanZoom(`#${zkGraph.id}-svg`, {
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
    const svgElement = document.getElementById(`${zkGraph.id}-svg`);
    if (svgElement) {
        // @ts-ignore
        svgElement.panZoomInstance = panZoomTiger;
    }

    const touchSvg = document.getElementById(`${zkGraph.id}-svg`);

    if (touchSvg !== null) {
        let startDistance: number = 0;
        let scale = panZoomTiger.getZoom();
        let lastScale = scale;

        touchSvg.addEventListener('touchstart', (event) => {
            if (event.touches.length === 2) {
                let touch1 = event.touches[0];
                let touch2 = event.touches[1];
                startDistance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
            }
        })

        touchSvg.addEventListener('touchmove', (event) => {
            if (event.touches.length === 2) {
                let touch1 = event.touches[0];
                let touch2 = event.touches[1];
                let currentDistance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
                let newScale = currentDistance / startDistance;
                scale = scale * newScale / lastScale;
                panZoomTiger.zoom(scale);
            }
        })
    }

    if (typeof plugin.settings.zoomPanScaleArr[i] === 'undefined') {

        const setSvg = document.getElementById(`${zkGraph.id}-svg`);

        if (setSvg !== null) {
            let a = setSvg.children[0].getAttr("style");
            if (a) {
                let b = a.match(/\d([^\,]+)\d/g)
                if (b !== null && Number(b[0]) > 1) {
                    panZoomTiger.zoom(1 / Number(b[0]))
                }
            }
            let zoomPanScale: ZoomPanScale = {
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

function getfileTags(file: TFile) {
    let fileTags: string[] = [];
    let fmTags = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
    if (fmTags) {
        if (Array.isArray(fmTags)) {

            for (let tag of fmTags) {
                splitNestedTags("#" + tag, fileTags);
            }

        } else if (typeof fmTags == "string") {
            splitNestedTags("#" + fmTags, fileTags);
        } else {
        }
    }

    let tags = this.app.metadataCache.getFileCache(file)?.tags

    if (tags && Array.isArray(tags)) {

        for (let tag of tags) {
            splitNestedTags(tag.tag, fileTags);
        }
    }

    return fileTags;
}

function splitNestedTags(nestTag: string, arr: string[]) {
    let words = nestTag.split("/");
    let tagStr = "";
    for (let word of words) {
        tagStr = tagStr.concat(word);
        arr.push(tagStr);
        tagStr = tagStr.concat("/");
    }
    return arr
}

/**
 * 替换指定标题下的内容
 * @param content - 原始文件内容
 * @param headingTitle - 标题名称
 * @param newContent - 新内容
 * @returns 更新后的文件内容
 */
function replaceHeadingContent(
    content: string,
    headingTitle: string,
    newContent: string
): string {
    const lines = content.split('\n');
    let startIndex = -1;
    let endIndex = lines.length;

    // 查找指定的一级标题
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('# ')) {
            if (line === `# ${headingTitle}` || line.startsWith(`# ${headingTitle}`)) {
                startIndex = i;
            } else if (startIndex !== -1) {
                // 找到下一个一级标题，结束
                endIndex = i;
                break;
            }
        }
    }

    if (startIndex === -1) {
        // 标题不存在，在文件末尾添加
        return content + '\n\n# ' + headingTitle + '\n\n' + newContent;
    }

    // 替换标题下的内容
    const before = lines.slice(0, startIndex + 1).join('\n');
    const after = endIndex < lines.length ? '\n' + lines.slice(endIndex).join('\n') : '';
    
    return before + '\n\n' + newContent + '\n' + after;
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

    const content = await app.vault.read(file);

    // 检查读取到的内容中是否包含 node_colors
    const nodeColorsInContent = content.match(/"node_colors":\s*{([^}]*)}/);

    // 使用 MermaidSerializer 序列化数据
    const { MermaidSerializer } = await import('./mermaidSerializer');
    const serializer = new MermaidSerializer();
    const mermaidContent = serializer.serialize(data);


    // 替换指定标题下的内容
    const updatedContent = replaceHeadingContent(
        content,
        headingTitle,
        mermaidContent
    );

    
    await app.vault.modify(file, updatedContent);

    // 等待文件系统更新 mtime
    await new Promise(resolve => setTimeout(resolve, 50));


    // 写入完成后清除该文件的旧缓存（基于旧 mtime 的缓存）
    const { MermaidParser } = await import('./mermaidParser');
    MermaidParser.clearCacheForFile(filePath);
}

/**
 * 创建 MOC 模板（Mermaid 格式）
 * @returns Mermaid 格式的模板字符串
 */
export function createMOCTemplate(): string {
    return `\`\`\`mermaid
graph LR

%% 1. 定义根节点
a["[[示例笔记 A]]"]

%% 2. 定义子节点
a.1["[[示例笔记 A.1]]"]
a.2["[[示例笔记 A.2]]"]

%% 3. 定义连线关系
%% 父子关系
a --> a.1
a --> a.2

%% 可选：添加带标签的关系
%% a.1 -->|相关| a.2

%% ext:{"node_positions":{},"groups":[],"edge_curvatures":{},"node_colors":{},"node_style_colors":{}} %%
\`\`\`

**使用说明：**
1. 节点格式：\`nodeId["[[笔记标题]]"]\`
2. 边格式：\`source --> target\` 或 \`source -->|标签| target\`
3. 节点 ID 使用字母和数字，用点号分隔层级（如 a, a.1, a.1.a）
4. 拖动节点后位置会自动保存到 ext 注释中
`;
}
