import { App } from "obsidian";
import { MOCParseResult, MOCTreeNode, MOCNodeType, ReverseRelation, GroupInfo, CrossDomainLink, createMOCTreeNode } from "./utils";
import { LayoutPreset, normalizeLayoutPreset, normalizeNodeLayoutPresets } from "src/utils/growthDirection";

// ---- JSON 存储 Schema（新）----

interface JsonNodeData {
    nodeID: string;
    nodeType: MOCNodeType;      // 'file' | 'text' | 'embed'
    extBitMap?: number;         // 节点扩展位图 (8位); 见 NODE_FLAG_* 常量
    target: string;             // file/embed: wiki link；text: 原始文本
    alias?: string;             // 仅 file + [[link|alias]] 时存在
    depth: number;
    children: JsonNodeData[];
    relationText: string;
}

// ---- 旧 Schema（兼容读取）----

interface LegacyJsonNodeData {
    wikiLink: string;
    nodeID: string;
    displayText: string;
    depth: number;
    children: LegacyJsonNodeData[];
    relationText: string;
    isTextOnly?: boolean;
    isEmbed?: boolean;
}

function isLegacyNode(data: any): data is LegacyJsonNodeData {
    return data && typeof data === 'object' && 'wikiLink' in data && !('nodeType' in data);
}

// 旧 shape → 新 shape
function migrateLegacyNode(legacy: LegacyJsonNodeData): JsonNodeData {
    let nodeType: MOCNodeType;
    if (legacy.isTextOnly) nodeType = 'text';
    else if (legacy.isEmbed) nodeType = 'embed';
    else nodeType = 'file';

    const data: JsonNodeData = {
        nodeID: legacy.nodeID,
        nodeType,
        target: legacy.wikiLink,
        depth: legacy.depth,
        children: (legacy.children || []).map(migrateLegacyNode),
        relationText: legacy.relationText || '',
    };
    // file / embed 都支持 alias；displayText 与 wikiLink 不同时保留
    if (nodeType !== 'text' && legacy.displayText && legacy.displayText !== legacy.wikiLink) {
        data.alias = legacy.displayText;
    }
    return data;
}

function normalizeNode(data: any): JsonNodeData {
    if (isLegacyNode(data)) return migrateLegacyNode(data);
    // 已是新 shape，递归规范化子节点
    return {
        nodeID: data.nodeID,
        nodeType: data.nodeType,
        ...(typeof data.extBitMap === 'number' && data.extBitMap !== 0 ? { extBitMap: data.extBitMap & 0xff } : {}),
        target: data.target ?? '',
        ...(data.alias ? { alias: data.alias } : {}),
        depth: data.depth,
        children: (data.children || []).map(normalizeNode),
        relationText: data.relationText || '',
    };
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
    nodeAnchors: Record<string, boolean>;
    collapsedNodeIds: string[];
    nodeLayoutStyle?: 'free' | 'auto';
    nodeLayoutOverrides?: Record<string, 'auto' | 'free'>;
    layoutPreset?: LayoutPreset;
    nodeLayoutPresets?: Record<string, LayoutPreset>;
    isProject?: boolean;
}

// ---- 内部转换工具 ----

function resolveJsonNode(app: App, data: JsonNodeData, basePath: string, resolvedFileCache: Map<string, any>): MOCTreeNode {
    let file: any = null;
    if (data.nodeType !== 'text' && data.target) {
        if (resolvedFileCache.has(data.target)) {
            file = resolvedFileCache.get(data.target) ?? null;
        } else {
            // 剥离 #heading / #^blockRef（Excalidraw 的 #^group=xxx 等），只用文件路径部分解析
            const hashIdx = data.target.indexOf('#');
            const pathOnly = hashIdx >= 0 ? data.target.substring(0, hashIdx) : data.target;

            file = app.metadataCache.getFirstLinkpathDest(pathOnly, basePath) ?? null;
            // metadataCache 解析失败时，回退到 vault 路径查找（兼容图片/excalidraw/.moc）
            if (!file) {
                file = app.vault.getAbstractFileByPath(pathOnly)
                    || app.vault.getAbstractFileByPath(basePath ? `${basePath}/${pathOnly}` : pathOnly)
                    || null;
            }
            resolvedFileCache.set(data.target, file);
        }
    }

    return createMOCTreeNode({
        nodeID: data.nodeID,
        nodeType: data.nodeType,
        extBitMap: data.extBitMap,
        target: data.target,
        alias: data.alias,
        depth: data.depth,
        children: (data.children || []).map(c => resolveJsonNode(app, c, basePath, resolvedFileCache)),
        file,
        relationText: data.relationText || '',
    });
}

function treeNodeToJson(node: MOCTreeNode): JsonNodeData {
    const d: JsonNodeData = {
        nodeID: node.nodeID,
        nodeType: node.nodeType,
        target: node.target,
        depth: node.depth,
        children: node.children.map(treeNodeToJson),
        relationText: node.relationText || '',
    };
    if (node.alias !== undefined && node.alias !== node.target) d.alias = node.alias;
    if (typeof node.extBitMap === 'number' && node.extBitMap !== 0) d.extBitMap = node.extBitMap & 0xff;
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
            embedNodeSizes: {}, nodeRemarks: {}, nodeAnchors: {}, collapsedNodeIds: [],
        };
    }

    const resolvedFileCache = new Map<string, any>();
    // 兼容读取：旧 shape (wikiLink/displayText/isTextOnly/isEmbed) 自动迁移到新 shape
    const normalized = (json.nodes || []).map(normalizeNode);
    const nodes = normalized.map(n => resolveJsonNode(app, n, basePath, resolvedFileCache));

    // 兼容读取：旧版顶层 nodeExtBitMap 映射 → 注入到每个节点的 extBitMap
    const legacyBitMap = (json as any).nodeExtBitMap as Record<string, number> | undefined;
    if (legacyBitMap && Object.keys(legacyBitMap).length > 0) {
        const apply = (ns: MOCTreeNode[]) => {
            for (const n of ns) {
                const v = legacyBitMap[n.nodeID];
                if (typeof v === 'number' && v !== 0) n.extBitMap = v & 0xff;
                if (n.children?.length) apply(n.children);
            }
        };
        apply(nodes);
    }

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
        nodeAnchors: json.nodeAnchors || {},
        collapsedNodeIds: Array.isArray(json.collapsedNodeIds) ? json.collapsedNodeIds : [],
        nodeLayoutStyle: json.nodeLayoutStyle,
        nodeLayoutOverrides: json.nodeLayoutOverrides,
        layoutPreset: json.layoutPreset ? normalizeLayoutPreset(json.layoutPreset) : undefined,
        nodeLayoutPresets: normalizeNodeLayoutPresets(json.nodeLayoutPresets),
        isProject: json.isProject === true,
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
        nodeAnchors: (data as any).nodeAnchors || {},
        collapsedNodeIds: (data as any).collapsedNodeIds || [],
    };
    if (data.nodeLayoutStyle) {
        json.nodeLayoutStyle = data.nodeLayoutStyle;
    }
    if (data.nodeLayoutOverrides && Object.keys(data.nodeLayoutOverrides).length > 0) {
        json.nodeLayoutOverrides = data.nodeLayoutOverrides;
    }
    if (data.layoutPreset) {
        json.layoutPreset = data.layoutPreset;
    }
    if (data.nodeLayoutPresets && Object.keys(data.nodeLayoutPresets).length > 0) {
        json.nodeLayoutPresets = data.nodeLayoutPresets;
    }
    if (data.isProject) {
        json.isProject = true;
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
        nodeAnchors: {},
        collapsedNodeIds: [],
        nodeLayoutStyle,
    };
    return JSON.stringify(json, null, 2);
}

function createRandomTwoLetterNodeId(): string {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const pick = () => letters[Math.floor(Math.random() * letters.length)];
    return `${pick()}${pick()}`;
}

/**
 * 创建带默认首节点的 .moc 文件内容
 */
export function createMOCJsonWithInitialNode(
    nodeLayoutStyle: 'free' | 'auto' = 'free',
    initialNodeTitle: string = '新节点',
    initialNodeId: string = createRandomTwoLetterNodeId()
): string {
    const json: MOCJsonSchema = {
        version: 1,
        nodes: [
            {
                nodeID: initialNodeId,
                nodeType: 'text',
                target: initialNodeTitle,
                depth: 0,
                children: [],
                relationText: '',
            },
        ],
        reverseRelations: [],
        nodePositions: {
            [initialNodeId]: { x: 0, y: 0 },
        },
        groups: [],
        edgeCurvatures: {},
        nodeColors: {},
        nodeStyleColors: {},
        crossDomainLinks: {},
        embedNodeSizes: {},
        nodeRemarks: {},
        nodeAnchors: {},
        collapsedNodeIds: [],
        nodeLayoutStyle,
    };
    return JSON.stringify(json, null, 2);
}
