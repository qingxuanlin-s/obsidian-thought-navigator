import { App } from "obsidian";
import { MOCParseResult, MOCTreeNode, ReverseRelation, GroupInfo, CrossDomainLink } from "./utils";

// ---- JSON 存储 Schema ----

interface JsonNodeData {
    wikiLink: string;
    nodeID: string;
    displayText: string;
    depth: number;
    children: JsonNodeData[];
    relationText: string;
    isTextOnly?: boolean;
    isEmbed?: boolean;
}

interface MOCJsonSchema {
    version: number;
    nodes: JsonNodeData[];
    reverseRelations: Array<{ sourceID: string; targetID: string; relationText: string }>;
    nodePositions: Record<string, { x: number; y: number }>;
    groups: GroupInfo[];
    edgeCurvatures: Record<string, { distance: number; weight: number }>;
    nodeColors: Record<string, string>;
    nodeStyleColors: Record<string, string>;
    crossDomainLinks: Record<string, CrossDomainLink[]>;
    embedNodeSizes: Record<string, { width: number; height: number }>;
    nodeRemarks: Record<string, string>;
    nodeLayoutStyle?: 'free' | 'auto';
}

// ---- 内部转换工具 ----

function resolveJsonNode(app: App, data: JsonNodeData, basePath: string): MOCTreeNode {
    const file = (!data.isTextOnly && data.wikiLink)
        ? (app.metadataCache.getFirstLinkpathDest(data.wikiLink, basePath) ?? null)
        : null;

    return {
        wikiLink: data.wikiLink,
        nodeID: data.nodeID,
        displayText: data.displayText,
        depth: data.depth,
        children: (data.children || []).map(c => resolveJsonNode(app, c, basePath)),
        file,
        relationText: data.relationText || '',
        ...(data.isTextOnly ? { isTextOnly: true } : {}),
        ...(data.isEmbed ? { isEmbed: true } : {}),
    };
}

function treeNodeToJson(node: MOCTreeNode): JsonNodeData {
    const d: JsonNodeData = {
        wikiLink: node.wikiLink,
        nodeID: node.nodeID,
        displayText: node.displayText,
        depth: node.depth,
        children: node.children.map(treeNodeToJson),
        relationText: node.relationText || '',
    };
    if (node.isTextOnly) d.isTextOnly = true;
    if (node.isEmbed) d.isEmbed = true;
    return d;
}

function countNodes(nodes: MOCTreeNode[]): { total: number; maxDepth: number } {
    let total = 0;
    let maxDepth = 0;
    const walk = (ns: MOCTreeNode[]) => {
        for (const n of ns) {
            total++;
            if (n.depth > maxDepth) maxDepth = n.depth;
            walk(n.children);
        }
    };
    walk(nodes);
    return { total, maxDepth };
}

// ---- 公共 API ----

/**
 * 解析 .moc 文件（JSON 格式）→ MOCParseResult
 */
export function parseMOCJson(content: string, filePath: string, app: App): MOCParseResult {
    const startTime = Date.now();
    const basePath = filePath.includes('/')
        ? filePath.substring(0, filePath.lastIndexOf('/'))
        : '';

    let json: MOCJsonSchema;
    try {
        json = JSON.parse(content);
    } catch {
        json = {
            version: 1, nodes: [], reverseRelations: [],
            nodePositions: {}, groups: [], edgeCurvatures: {},
            nodeColors: {}, nodeStyleColors: {}, crossDomainLinks: {},
            embedNodeSizes: {}, nodeRemarks: {},
        };
    }

    const nodes = (json.nodes || []).map(n => resolveJsonNode(app, n, basePath));

    const reverseRelations = new Map<string, ReverseRelation>();
    for (const rel of (json.reverseRelations || [])) {
        reverseRelations.set(`${rel.sourceID}->${rel.targetID}`, {
            sourceID: rel.sourceID,
            targetID: rel.targetID,
            relationText: rel.relationText || '',
        });
    }

    const { total, maxDepth } = countNodes(nodes);

    return {
        nodes,
        reverseRelations,
        nodePositions: json.nodePositions || {},
        groups: json.groups || [],
        edgeCurvatures: json.edgeCurvatures || {},
        nodeColors: json.nodeColors || {},
        nodeStyleColors: json.nodeStyleColors || {},
        crossDomainLinks: json.crossDomainLinks || {},
        embedNodeSizes: json.embedNodeSizes || {},
        nodeRemarks: json.nodeRemarks || {},
        nodeLayoutStyle: json.nodeLayoutStyle,
        metadata: {
            totalNodes: total,
            maxDepth,
            hasReverseRelations: reverseRelations.size > 0,
            parseTime: Date.now() - startTime,
            filePath,
            headingTitle: '',
        },
    };
}

/**
 * 序列化 MOCParseResult → .moc 文件内容（JSON 字符串）
 */
export function serializeMOCJson(data: MOCParseResult): string {
    const json: MOCJsonSchema = {
        version: 1,
        nodes: data.nodes.map(treeNodeToJson),
        reverseRelations: Array.from(data.reverseRelations.values()).map(r => ({
            sourceID: r.sourceID,
            targetID: r.targetID,
            relationText: r.relationText || '',
        })),
        nodePositions: data.nodePositions || {},
        groups: data.groups || [],
        edgeCurvatures: data.edgeCurvatures || {},
        nodeColors: data.nodeColors || {},
        nodeStyleColors: (data as any).nodeStyleColors || {},
        crossDomainLinks: (data as any).crossDomainLinks || {},
        embedNodeSizes: (data as any).embedNodeSizes || {},
        nodeRemarks: (data as any).nodeRemarks || {},
    };
    if (data.nodeLayoutStyle) {
        json.nodeLayoutStyle = data.nodeLayoutStyle;
    }
    return JSON.stringify(json, null, 2);
}

/**
 * 创建空 .moc 文件内容
 */
export function createEmptyMOCJson(nodeLayoutStyle: 'free' | 'auto' = 'free'): string {
    const json: MOCJsonSchema = {
        version: 1,
        nodes: [],
        reverseRelations: [],
        nodePositions: {},
        groups: [],
        edgeCurvatures: {},
        nodeColors: {},
        nodeStyleColors: {},
        crossDomainLinks: {},
        embedNodeSizes: {},
        nodeRemarks: {},
        nodeLayoutStyle,
    };
    return JSON.stringify(json, null, 2);
}
