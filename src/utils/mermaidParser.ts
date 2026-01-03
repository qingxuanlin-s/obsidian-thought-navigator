import { App, TFile } from "obsidian";
import { MOCTreeNode, MOCParseResult, ReverseRelation, GroupInfo } from "./utils";

/**
 * 节点定义
 */
interface NodeDefinition {
    id: string;              // 节点 ID，如 "a", "a.1"
    wikiLink: string;        // Wiki 链接，如 "20251214 波函数"
    displayText: string;     // 显示文本
}

/**
 * 边定义
 */
interface EdgeDefinition {
    source: string;          // 源节点 ID
    target: string;          // 目标节点 ID
    label: string;           // 边标签（可选）
}

/**
 * 解析错误
 */
interface ParseError {
    type: 'syntax' | 'reference' | 'metadata';
    line: number;
    message: string;
    context: string;  // 错误行的内容
}

/**
 * Mermaid 格式解析器
 * 负责解析 Mermaid 格式的 MOC 文件
 */
export class MermaidParser {
    private app: App;
    private errors: ParseError[] = [];
    private warnings: ParseError[] = [];
    
    // 解析缓存：key 为 "filePath:mtime"，value 为解析结果
    private static parseCache = new Map<string, MOCParseResult>();

    constructor(app: App) {
        this.app = app;
    }

    /**
     * 清除所有解析缓存
     */
    static clearCache(): void {
        console.log(`[MermaidParser] Clearing all cache (${MermaidParser.parseCache.size} entries)`);
        MermaidParser.parseCache.clear();
    }

    /**
     * 清除指定文件的缓存
     */
    static clearCacheForFile(filePath: string): void {
        let cleared = 0;
        for (const key of MermaidParser.parseCache.keys()) {
            if (key.startsWith(`${filePath}:`)) {
                MermaidParser.parseCache.delete(key);
                cleared++;
            }
        }
        console.log(`[MermaidParser] Cleared ${cleared} cache entries for ${filePath}`);
    }

    /**
     * 识别和提取 Mermaid 代码块
     * @param content - 文件内容
     * @returns Mermaid 代码内容，如果不存在则返回 null
     */
    extractMermaidBlock(content: string): string | null {
        // 匹配 ```mermaid ... ``` 代码块
        const mermaidBlockRegex = /```mermaid\s*\n([\s\S]*?)\n```/;
        const match = content.match(mermaidBlockRegex);
        
        if (match && match[1]) {
            return match[1].trim();
        }
        
        return null;
    }

    /**
     * 解析节点定义
     * @param line - Mermaid 代码行
     * @returns 节点信息，如果不是节点定义则返回 null
     */
    parseNode(line: string): NodeDefinition | null {
        // 匹配格式：nodeId["[[wikilink]]"] 或 nodeId["[[wikilink|displayText]]"]
        // 支持带引号和不带引号的情况
        const nodeRegex = /^([a-zA-Z0-9.]+)\["?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]"?\]$/;
        const match = line.trim().match(nodeRegex);
        
        if (match) {
            const id = match[1];
            const wikiLink = match[2];
            const displayText = match[3] || match[2]; // 如果没有显示文本，使用 wikiLink
            
            return {
                id,
                wikiLink,
                displayText
            };
        }
        
        return null;
    }

    /**
     * 解析边定义
     * @param line - Mermaid 代码行
     * @returns 边信息，如果不是边定义则返回 null
     */
    parseEdge(line: string): EdgeDefinition | null {
        const trimmedLine = line.trim();
        
        // 匹配有标签的边：source -->|label| target
        const labeledEdgeRegex = /^([a-zA-Z0-9.]+)\s*-->\s*\|([^|]+)\|\s*([a-zA-Z0-9.]+)$/;
        const labeledMatch = trimmedLine.match(labeledEdgeRegex);
        
        if (labeledMatch) {
            return {
                source: labeledMatch[1],
                target: labeledMatch[3],
                label: labeledMatch[2].trim()
            };
        }
        
        // 匹配无标签的边：source --> target
        const unlabeledEdgeRegex = /^([a-zA-Z0-9.]+)\s*-->\s*([a-zA-Z0-9.]+)$/;
        const unlabeledMatch = trimmedLine.match(unlabeledEdgeRegex);
        
        if (unlabeledMatch) {
            return {
                source: unlabeledMatch[1],
                target: unlabeledMatch[2],
                label: ''
            };
        }
        
        return null;
    }

    /**
     * 解析分组定义
     * @param lines - Mermaid 代码行数组
     * @param startIndex - 开始索引
     * @returns 分组信息和结束索引，如果不是分组定义则返回 null
     */
    parseSubgraph(lines: string[], startIndex: number): {
        group: GroupInfo;
        endIndex: number;
        nodeIds: string[];
        nodes: NodeDefinition[];  // 添加节点定义数组
    } | null {
        const line = lines[startIndex].trim();
        
        // 匹配 subgraph 开始：subgraph groupId [groupLabel]
        const subgraphRegex = /^subgraph\s+([a-zA-Z0-9_]+)\s*\[([^\]]+)\]$/;
        const match = line.match(subgraphRegex);
        
        if (!match) {
            return null;
        }
        
        const groupId = match[1];
        const groupLabel = match[2];
        const nodeIds: string[] = [];
        const nodes: NodeDefinition[] = [];  // 收集节点定义
        
        // 查找 subgraph 块中的节点
        let endIndex = startIndex + 1;
        let foundEnd = false;
        
        for (let i = startIndex + 1; i < lines.length; i++) {
            const currentLine = lines[i].trim();
            
            // 检查是否到达 end
            if (currentLine === 'end') {
                endIndex = i;
                foundEnd = true;
                break;
            }
            
            // 跳过 direction 指令
            if (currentLine.startsWith('direction ')) {
                continue;
            }
            
            // 跳过注释
            if (currentLine.startsWith('%%')) {
                continue;
            }
            
            // 跳过空行
            if (currentLine === '') {
                continue;
            }
            
            // 解析节点定义
            const node = this.parseNode(currentLine);
            if (node) {
                nodeIds.push(node.id);
                nodes.push(node);  // 保存节点定义
            }
        }
        
        if (!foundEnd) {
            this.warnings.push({
                type: 'syntax',
                line: startIndex,
                message: `Subgraph ${groupId} is not closed with 'end'`,
                context: line
            });
        }
        
        return {
            group: {
                id: groupId,
                label: groupLabel,
                nodeIds: nodeIds
            },
            endIndex,
            nodeIds,
            nodes  // 返回节点定义
        };
    }

    /**
     * 解析元数据注释
     * @param content - Mermaid 代码内容
     * @returns 元数据对象
     */
    parseMetadata(content: string): {
        nodePositions: Record<string, { x: number; y: number }>;
        groups: GroupInfo[];
        edgeCurvatures: Record<string, { distance: number; weight: number }>;
        nodeColors: Record<string, string>;
    } {
        const defaultMetadata = {
            nodePositions: {},
            groups: [],
            edgeCurvatures: {},
            nodeColors: {}
        };
        
        // 匹配元数据注释：%% ext:{JSON} %%
        const metadataRegex = /%%\s*ext:\s*(\{.*\})\s*%%/;
        const match = content.match(metadataRegex);
        
        if (!match || !match[1]) {
            return defaultMetadata;
        }
        
        try {
            const metadata = JSON.parse(match[1]);
            
            return {
                nodePositions: metadata.node_positions || {},
                groups: metadata.groups || [],
                edgeCurvatures: metadata.edge_curvatures || {},
                nodeColors: metadata.node_colors || {}
            };
        } catch (e) {
            this.warnings.push({
                type: 'metadata',
                line: -1,
                message: `Failed to parse metadata JSON: ${e.message}`,
                context: match[1]
            });
            
            return defaultMetadata;
        }
    }

    /**
     * 解析 Mermaid 格式的 MOC 文件
     * @param content - 文件内容
     * @param filePath - 文件路径
     * @param headingTitle - 标题名称
     * @returns 解析结果
     */
    async parse(
        content: string,
        filePath: string,
        headingTitle: string
    ): Promise<MOCParseResult> {
        const startTime = Date.now();
        
        // 检查缓存
        const file = this.app.vault.getFileByPath(filePath);
        if (file) {
            const cacheKey = `${filePath}:${file.stat.mtime}`;
            const cached = MermaidParser.parseCache.get(cacheKey);
            if (cached) {
                console.log(`Using cached parse result for ${filePath}`);
                return cached;
            }
            
            // 清除该文件的旧缓存（mtime 不同的）
            for (const key of MermaidParser.parseCache.keys()) {
                if (key.startsWith(`${filePath}:`)) {
                    console.log(`Clearing old cache for ${filePath}`);
                    MermaidParser.parseCache.delete(key);
                }
            }
        }
        
        // 重置错误和警告
        this.errors = [];
        this.warnings = [];
        
        // 提取 Mermaid 代码块
        const mermaidBlock = this.extractMermaidBlock(content);
        
        if (!mermaidBlock) {
            return this.emptyResult(filePath, headingTitle, startTime);
        }
        
        // 解析元数据
        const metadata = this.parseMetadata(mermaidBlock);
        
        // 分行处理
        const lines = mermaidBlock.split('\n');
        
        // 存储解析结果
        const nodesMap = new Map<string, NodeDefinition>();
        const edges: EdgeDefinition[] = [];
        const subgraphNodeIds = new Set<string>(); // 记录在 subgraph 中的节点
        
        // 第一遍：解析所有节点和边
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            
            // 跳过空行和注释
            if (line === '' || line.startsWith('%%') || line.startsWith('graph ')) {
                i++;
                continue;
            }
            
            // 解析 subgraph
            const subgraphResult = this.parseSubgraph(lines, i);
            if (subgraphResult) {
                // 记录 subgraph 中的节点 ID
                subgraphResult.nodeIds.forEach(id => subgraphNodeIds.add(id));
                // 将 subgraph 中的节点添加到 nodesMap
                subgraphResult.nodes.forEach(node => {
                    nodesMap.set(node.id, node);
                    console.log(`[MermaidParser] Added node from subgraph: ${node.id}`);
                });
                i = subgraphResult.endIndex + 1;
                continue;
            }
            
            // 解析节点
            const node = this.parseNode(line);
            if (node) {
                nodesMap.set(node.id, node);
                i++;
                continue;
            }
            
            // 解析边
            const edge = this.parseEdge(line);
            if (edge) {
                edges.push(edge);
                i++;
                continue;
            }
            
            // 未识别的行
            if (line !== 'direction TB' && line !== 'direction LR' && line !== 'end') {
                this.warnings.push({
                    type: 'syntax',
                    line: i,
                    message: `Unrecognized line: ${line}`,
                    context: line
                });
            }
            
            i++;
        }
        
        // 验证边引用
        const validEdges: EdgeDefinition[] = [];
        for (const edge of edges) {
            if (!nodesMap.has(edge.source)) {
                this.errors.push({
                    type: 'reference',
                    line: -1,
                    message: `Edge references non-existent source node: ${edge.source}`,
                    context: `${edge.source} --> ${edge.target}`
                });
                continue;
            }
            
            if (!nodesMap.has(edge.target)) {
                this.errors.push({
                    type: 'reference',
                    line: -1,
                    message: `Edge references non-existent target node: ${edge.target}`,
                    context: `${edge.source} --> ${edge.target}`
                });
                continue;
            }
            
            validEdges.push(edge);
        }
        
        // 验证分组引用
        for (const group of metadata.groups) {
            for (const nodeId of group.nodeIds) {
                if (!nodesMap.has(nodeId)) {
                    this.errors.push({
                        type: 'reference',
                        line: -1,
                        message: `Group ${group.id} references non-existent node: ${nodeId}`,
                        context: group.label
                    });
                }
            }
        }
        
        // 构建 MOCTreeNode 结构
        const mocNodes = await this.buildMOCTreeNodes(nodesMap, validEdges);
        
        // 构建反向关系 Map
        // 将所有边都添加到 reverseRelations 中（包括无标签的边）
        const reverseRelations = new Map<string, ReverseRelation>();
        for (const edge of validEdges) {
            const key = `${edge.source}->${edge.target}`;
            reverseRelations.set(key, {
                sourceID: edge.source,
                targetID: edge.target,
                relationText: edge.label || ''  // 如果没有标签，使用空字符串
            });
        }
        
        const parseTime = Date.now() - startTime;
        
        const result = {
            nodes: mocNodes,
            reverseRelations,
            nodePositions: metadata.nodePositions,
            groups: metadata.groups,
            edgeCurvatures: metadata.edgeCurvatures,
            nodeColors: metadata.nodeColors,
            metadata: {
                totalNodes: nodesMap.size,
                maxDepth: this.calculateMaxDepth(mocNodes),
                hasReverseRelations: reverseRelations.size > 0,
                parseTime,
                filePath,
                headingTitle
            }
        };
        
        // 保存到缓存
        if (file) {
            const cacheKey = `${filePath}:${file.stat.mtime}`;
            MermaidParser.parseCache.set(cacheKey, result);
            
            // 限制缓存大小（最多保留 50 个）
            if (MermaidParser.parseCache.size > 50) {
                const firstKey = MermaidParser.parseCache.keys().next().value;
                MermaidParser.parseCache.delete(firstKey);
            }
        }
        
        return result;
    }

    /**
     * 构建 MOCTreeNode 结构
     */
    private async buildMOCTreeNodes(
        nodesMap: Map<string, NodeDefinition>,
        edges: EdgeDefinition[]
    ): Promise<MOCTreeNode[]> {
        const treeNodes: MOCTreeNode[] = [];
        const nodeMap = new Map<string, MOCTreeNode>();
        
        // 创建所有节点
        for (const [id, nodeDef] of nodesMap) {
            const file = this.app.metadataCache.getFirstLinkpathDest(nodeDef.wikiLink, '') || null;
            
            // 调试输出
            if (!file) {
                console.warn(`[MermaidParser] File not found for node ${id}: ${nodeDef.wikiLink}`);
            } else {
                console.log(`[MermaidParser] Found file for node ${id}: ${file.path}`);
            }
            
            const idParts = id.split('.');
            const depth = idParts.length - 1;
            
            const treeNode: MOCTreeNode = {
                wikiLink: nodeDef.wikiLink,
                nodeID: id,
                displayText: nodeDef.displayText,
                depth,
                children: [],
                file,
                relationText: ''
            };
            
            nodeMap.set(id, treeNode);
        }
        
        // 构建父子关系（基于节点 ID 的层级结构）
        for (const [id, node] of nodeMap) {
            const idParts = id.split('.');
            
            console.log(`[buildMOCTreeNodes] Processing node ${id}, depth: ${idParts.length - 1}`);
            
            if (idParts.length === 1) {
                // 根节点
                console.log(`[buildMOCTreeNodes] Adding ${id} as root node`);
                treeNodes.push(node);
            } else {
                // 子节点，找到父节点
                const parentId = idParts.slice(0, -1).join('.');
                const parentNode = nodeMap.get(parentId);
                
                console.log(`[buildMOCTreeNodes] Looking for parent ${parentId} for node ${id}`);
                
                if (parentNode) {
                    console.log(`[buildMOCTreeNodes] Found parent ${parentId}, adding ${id} as child`);
                    parentNode.children.push(node);
                } else {
                    // 如果找不到父节点，作为根节点处理
                    console.log(`[buildMOCTreeNodes] Parent ${parentId} not found, adding ${id} as root`);
                    treeNodes.push(node);
                }
            }
        }
        
        console.log(`[buildMOCTreeNodes] Total root nodes: ${treeNodes.length}`);
        treeNodes.forEach(root => {
            console.log(`[buildMOCTreeNodes] Root: ${root.nodeID}, children: ${root.children.length}`);
        });
        
        // 从边中提取关系文本（父子边的标签）
        for (const edge of edges) {
            const targetNode = nodeMap.get(edge.target);
            if (targetNode && edge.label) {
                // 检查这是否是父子边
                const targetIdParts = edge.target.split('.');
                if (targetIdParts.length > 1) {
                    const expectedParentId = targetIdParts.slice(0, -1).join('.');
                    if (expectedParentId === edge.source) {
                        // 这是父子边，设置关系文本
                        targetNode.relationText = edge.label;
                    }
                }
            }
        }
        
        return treeNodes;
    }

    /**
     * 计算最大深度
     */
    private calculateMaxDepth(nodes: MOCTreeNode[]): number {
        let maxDepth = 0;
        
        const traverse = (node: MOCTreeNode) => {
            maxDepth = Math.max(maxDepth, node.depth);
            for (const child of node.children) {
                traverse(child);
            }
        };
        
        for (const node of nodes) {
            traverse(node);
        }
        
        return maxDepth;
    }

    /**
     * 返回空结果
     */
    private emptyResult(filePath: string, headingTitle: string, startTime: number): MOCParseResult {
        return {
            nodes: [],
            reverseRelations: new Map(),
            nodePositions: {},
            groups: [],
            edgeCurvatures: {},
            nodeColors: {},
            metadata: {
                totalNodes: 0,
                maxDepth: 0,
                hasReverseRelations: false,
                parseTime: Date.now() - startTime,
                filePath,
                headingTitle
            }
        };
    }

    /**
     * 获取错误列表
     */
    getErrors(): ParseError[] {
        return this.errors;
    }

    /**
     * 获取警告列表
     */
    getWarnings(): ParseError[] {
        return this.warnings;
    }
}
