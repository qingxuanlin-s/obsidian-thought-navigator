import ZKNavigationPlugin, { ZoomPanScale } from "main";
import { App, loadMermaid, moment, Notice, TFile } from "obsidian";
import { ZKNode } from "src/view/indexView";

// MOC 解析的节点结构
export interface MOCTreeNode {
    wikiLink: string;           // wiki链接，如 "20251214-波函数"
    nodeID: string;             // 节点ID，如 "a", "a.1", "a.1.a"
    displayText: string;        // 显示文本（链接后的描述）
    depth: number;              // 缩进深度（用于确定父子关系）
    children: MOCTreeNode[];    // 子节点
    file: TFile | null;         // 对应的文件
    relationText: string;       // 关系描述，如 "引出", "相关"
    isArrowRelation?: boolean;  // 是否是箭头关系节点
    arrowSource?: string;       // 箭头关系的源节点ID
    arrowTarget?: string;       // 箭头关系的目标节点ID
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
    metadata: {                 // 扩展信息
        totalNodes: number;     // 总节点数
        maxDepth: number;       // 最大深度
        hasReverseRelations: boolean; // 是否包含反向关系
        parseTime: number;      // 解析耗时（毫秒）
        filePath: string;       // MOC 文件路径
        headingTitle: string;   // 标题名称
    };
}

// 分组信息
export interface GroupInfo {
    id: string;                 // 分组 ID
    label: string;              // 分组标签
    nodeIds: string[];          // 包含的节点 ID 列表
    color?: string;             // 分组颜色（可选）
}


interface ArrowRelation {
  source: string;
  label: string;
  target: string;
  hasLabel: boolean;
}

/**
 * 判断文本是否包含箭头关系
 * @param text - 要检查的文本
 * @returns 是否包含箭头关系
 */
function hasArrow(text: string): boolean {
  const regex = /--(?:.*?)?-->/;
  return regex.test(text);
}

/**
 * 提取箭头关系
 * 支持两种格式：
 * 1. A -- label --> B
 * 2. A --> B
 * @param text - 要解析的文本
 * @returns 箭头关系对象，如果没有匹配则返回 null
 */
function extractArrow(text: string): ArrowRelation | null {
  // 匹配格式: `source` -- 或 -- label -- 或 -- -> `target`
  // 支持 --> 和 -> 两种箭头
  const regex = /`([^`]+)`\s*(-+)\s*(.*?)\s*(-+>)\s*`([^`]+)`/;
  const match = text.match(regex);
  
  if (!match) return null;
  
  // 去除反引号，直接使用匹配到的内容
  const source = match[1].trim();
  const label = match[3].trim();
  const target = match[5].trim();
  
  return {
    source,     
    label,
    target,     
    hasLabel: label.length > 0
  };
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
    const lines = content.split('\n');

    // 查找指定的一级标题
    let startIndex = -1;
    let endIndex = lines.length;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 匹配一级标题
        if (line.startsWith('# ')) {
            if (line === `# ${headingTitle}` || line.startsWith(`# ${headingTitle}`)) {
                startIndex = i + 1;
            } else if (startIndex !== -1) {
                // 找到下一个一级标题，结束
                endIndex = i;
                break;
            }
        }
    }

    if (startIndex === -1) {
        return {
            nodes: [],
            reverseRelations: new Map(),
            nodePositions: {},
            groups: [],
            edgeCurvatures: {},
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

    // 解析标题下的节点位置信息、分组信息和边弧度信息（新格式：%% ext:{"node_positions":{...},"groups":[...],"edge_curvatures":{...}} %%）
    const nodePositions: Record<string, { x: number; y: number }> = {};
    const groups: any[] = [];
    const edgeCurvatures: Record<string, { distance: number; weight: number }> = {};
    let posLineIndex = -1;
    
    // 从后往前查找位置行
    for (let i = endIndex - 1; i > startIndex; i--) {
        const line = lines[i].trim();
        const match = line.match(/^%%\s*ext:\s*(\{.*\})\s*%%$/);
        if (match) {
            try {
                const extData = JSON.parse(match[1]);
                if (extData.node_positions) {
                    posLineIndex = i;
                    Object.assign(nodePositions, extData.node_positions);
                    if (extData.groups) {
                        groups.push(...extData.groups);
                    }
                    if (extData.edge_curvatures) {
                        Object.assign(edgeCurvatures, extData.edge_curvatures);
                    }
                    break;
                }
            } catch (e) {
                console.error('Failed to parse ext data:', e);
            }
        }
    }
    
    // 如果找到位置行，更新 endIndex 排除它
    if (posLineIndex !== -1) {
        endIndex = posLineIndex;
        // 跳过位置行前的空行
        while (endIndex > startIndex && lines[endIndex - 1].trim() === '') {
            endIndex--;
        }
    }


    // 解析标题下的列表内容和箭头关系
    const allNodes: MOCTreeNode[] = [];
    const arrowRelations: Array<{relation: ArrowRelation, lineIndex: number, indentLevel: number}> = [];
    let maxDepth = 0;

    // 第一步：收集所有节点和箭头关系
    for (let i = startIndex; i < endIndex; i++) {
        const line = lines[i];

        // 跳过空行
        if (line.trim() === '') continue;

        // 检查是否是箭头关系行
        if (hasArrow(line)) {
            const arrowRelation = extractArrow(line);
            if (arrowRelation) {
                // 计算缩进级别
                const indentMatch = line.match(/^(\s*)/);
                const indentLevel = indentMatch ? Math.floor(indentMatch[1].length / 2) : 0; // 假设每2个空格为一级缩进
                
                arrowRelations.push({
                    relation: arrowRelation,
                    lineIndex: i,
                    indentLevel: indentLevel
                });                
            }
            continue; // 跳过箭头关系行，不作为普通节点处理
        }

        // 解析列表项
        const listMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
        if (!listMatch) continue;

        const itemContent = listMatch[2];

        // 解析 wiki 链接和节点 ID
        const parsedItem = parseListItem(app, itemContent);
        if (!parsedItem || !parsedItem.nodeID) continue;

        // 根据节点ID计算深度（点号分隔的层级数）
        const idParts = parsedItem.nodeID.split('.');
        const depth = idParts.length - 1;
        maxDepth = Math.max(maxDepth, depth);

        const node: MOCTreeNode = {
            wikiLink: parsedItem.wikiLink,
            nodeID: parsedItem.nodeID,
            displayText: parsedItem.displayText,
            depth: depth,
            children: [],
            file: parsedItem.file,
            relationText: parsedItem.relationText,
        };

        allNodes.push(node);
    }

    // 第二步：根据节点ID构建父子关系
    const treeNodes: MOCTreeNode[] = [];
    const nodeMap = new Map<string, MOCTreeNode>();

    // 创建节点映射
    allNodes.forEach(node => {
        nodeMap.set(node.nodeID, node);
    });

    // 构建基本树结构
    allNodes.forEach(node => {
        const idParts = node.nodeID.split('.');

        if (idParts.length === 1) {
            // 根节点（如 "a"）
            treeNodes.push(node);
        } else {
            // 子节点，找到父节点
            const parentId = idParts.slice(0, -1).join('.');
            const parentNode = nodeMap.get(parentId);

            if (parentNode) {
                parentNode.children.push(node);
            } else {
                // 如果找不到父节点，作为根节点处理
                treeNodes.push(node);
            }
        }
    });

    // 第三步：将箭头关系插入到对应的父级节点下
    const reverseRelations = new Map<string, ReverseRelation>();
    
    for (const arrowInfo of arrowRelations) {
        const { relation, lineIndex, indentLevel } = arrowInfo;
        
        // 从 nodeMap 获取节点
        const sourceNode = nodeMap.get(relation.source);
        const targetNode = nodeMap.get(relation.target);
        
        if (sourceNode && targetNode) {
            // 找到应该归属的父级节点
            const parentNode = findParentNodeForArrow(sourceNode, targetNode, allNodes, indentLevel);
            
            if (parentNode) {
                // 创建一个虚拟的箭头关系节点
                const arrowNode: MOCTreeNode = {
                    wikiLink: `${relation.source}->${relation.target}`,
                    nodeID: `arrow_${relation.source}_${relation.target}`,
                    displayText: `${relation.source} --${relation.label}--> ${relation.target}`,
                    depth: parentNode.depth + 1,
                    children: [],
                    file: null, // 箭头关系没有对应的文件
                    relationText: relation.label,
                    isArrowRelation: true, // 标记为箭头关系
                    arrowSource: relation.source,
                    arrowTarget: relation.target
                };
                
                // 将箭头关系添加到父节点的子节点中
                parentNode.children.push(arrowNode);
            
            }
            
            // 同时保存到 reverseRelations Map 中供其他功能使用
            const key = `${sourceNode.nodeID}->${targetNode.nodeID}`;
            reverseRelations.set(key, {
                sourceID: sourceNode.nodeID,
                targetID: targetNode.nodeID,
                relationText: relation.label
            });
        }
    }

    const parseTime = Date.now() - startTime;

    return {
        nodes: treeNodes,
        reverseRelations,
        nodePositions,
        groups,
        edgeCurvatures,
        metadata: {
            totalNodes: allNodes.length,
            maxDepth,
            hasReverseRelations: reverseRelations.size > 0,
            parseTime,
            filePath,
            headingTitle,
        }
    };
}

// 辅助函数：找到箭头关系应该归属的父级节点
function findParentNodeForArrow(
    sourceNode: MOCTreeNode, 
    targetNode: MOCTreeNode, 
    allNodes: MOCTreeNode[], 
    indentLevel: number
): MOCTreeNode | null {
    // 策略1: 根据缩进级别找到对应深度的父节点
    // 如果缩进级别为0，放在根节点下
    // 如果缩进级别为1，放在一级节点下，以此类推
    
    // 找到源节点和目标节点的共同祖先
    const sourceIdParts = sourceNode.nodeID.split('.');
    const targetIdParts = targetNode.nodeID.split('.');
    
    // 找到共同前缀
    let commonPrefixLength = 0;
    const minLength = Math.min(sourceIdParts.length, targetIdParts.length);
    
    for (let i = 0; i < minLength; i++) {
        if (sourceIdParts[i] === targetIdParts[i]) {
            commonPrefixLength++;
        } else {
            break;
        }
    }
    
    // 如果有共同前缀，找到对应的共同祖先节点
    if (commonPrefixLength > 0) {
        const commonAncestorId = sourceIdParts.slice(0, commonPrefixLength).join('.');
        const commonAncestor = allNodes.find(n => n.nodeID === commonAncestorId);
        if (commonAncestor) {
            return commonAncestor;
        }
    }
    
    // 如果没有共同祖先，根据源节点的层级决定
    // 通常放在源节点的父节点下，或者源节点本身下
    if (sourceIdParts.length > 1) {
        const sourceParentId = sourceIdParts.slice(0, -1).join('.');
        const sourceParent = allNodes.find(n => n.nodeID === sourceParentId);
        if (sourceParent) {
            return sourceParent;
        }
    }
    
    // 最后的备选方案：放在源节点下
    return sourceNode;
}

// 解析列表项内容
function parseListItem(app: App, content: string): {
    wikiLink: string;
    nodeID: string;
    displayText: string;
    file: TFile | null;
    relationText: string;
} | null {
    // 匹配 wiki 链接: [[链接]] 或 [[链接|显示文本]]
    const wikiMatch = content.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (!wikiMatch) return null;

    const wikiLink = wikiMatch[1];
    const linkDisplayText = wikiMatch[2] || wikiMatch[1];

    // 获取 wiki 链接后的内容
    const afterLink = content.substring(content.indexOf(']]') + 2).trim();

    // 识别用反引号包裹的节点 ID，格式如: [[link]] `c1` 或 [[link]] - `c1` 或 [[link]] `a`- 引出
    // 匹配反引号包裹的内容，如 `c1`, `a.1`, `a.1.a` 等，允许后面有更多内容
    const idMatch = afterLink.match(/[-–—]?\s*`([a-zA-Z0-9.]+)`/);
    const nodeID = idMatch ? idMatch[1] : '';

    // 获取关系描述（wiki链接前的文字）
    const beforeLink = content.substring(0, content.indexOf('[[')).trim();
    const relationText = beforeLink || '';

    // 查找对应的文件
    const file = app.metadataCache.getFirstLinkpathDest(wikiLink, '') || null;

    return {
        wikiLink,
        nodeID,
        displayText: linkDisplayText,
        file,
        relationText,
    };
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

        // 只有当文件存在时才创建并添加节点
        if (!mocNode.file) {
            // 递归处理子节点（即使当前节点无文件）
            for (let i = 0; i < mocNode.children.length; i++) {
                await processNode(mocNode.children[i], nodeIDArr, i);
            }
            return;
        }


        const zkNode: ZKNode = {
            ID: mocNode.nodeID || mocNode.wikiLink,
            IDArr: nodeIDArr,
            IDStr: mocNode.nodeID || nodeIDArr.join(','),
            position: position++,
            file: mocNode.file,
            title: mocNode.displayText,
            relationText: mocNode.relationText,
            displayText: getDisplayText(plugin, mocNode),
            ctime: mocNode.file.stat?.ctime || Date.now(),
            randomId: random(16),
            nodeSons: 1,
            startY: 0,
            height: 0,
            isRoot: currentIDArr.length === 0,
            fixWidth: 0,
            branchName: "",
            gitNodePos: 0,
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
                nodes[i].isRoot = !nodes.find(n => n.IDStr === parentId);
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
    const wrappedId = id ? `\`${id}\`` : '';

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

                if (nodeCache !== null && node.file.extension == 'md') {
                    if (typeof nodeCache.frontmatter !== 'undefined' && plugin.settings.TitleField !== "") {

                        let title = nodeCache.frontmatter[plugin.settings.TitleField]?.toString();
                        if (typeof title == "string" && title.length > 0) {
                            node.title = title;
                        }
                    }
                }

                break;
            case "2":
                if (node.file.extension == 'md') {
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

        if (plugin.settings.CustomCreatedTime.length > 0 && node.file.extension == 'md') {

            let ctime = nodeCache?.frontmatter?.[plugin.settings.CustomCreatedTime];

            if (ctime) {
                let time = moment(ctime);
                if (time.isValid()) {
                    node.ctime = time.valueOf();
                }
            }
        }

        if (node.ctime === 0) {
            node.ctime = node.file.stat.ctime
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
        const compoundKey = item.ID + '_' + item.file.path;
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