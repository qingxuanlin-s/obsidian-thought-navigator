import { App, TFile } from "obsidian";
import { ZKNode } from "src/view/indexView";
import { CrossDomainLink, GroupInfo } from "src/utils/utils";

/**
 * 图形数据结构
 */
export interface GraphData {
    nodes: ZKNode[];
    edges: Edge[];
    metadata: GraphMetadata;
}

export interface Edge {
    id: string;
    source: string;  // 源节点 ID
    target: string;  // 目标节点 ID
    type: 'parent' | 'child' | 'sibling' | 'link' | 'inlink' | 'outlink' | 'forward' | 'reverse' | 'cross-domain';
    label?: string;
    crossDomainLink?: CrossDomainLink;  // 跨领域链接信息（用于 cross-domain 类型）
    crossDomainSourceNodeId?: string;  // 跨领域边的源节点 ID（= ext metadata 中 cross_domain_links 的键，用于标签持久化定位）
}

/**
 * cytoscape 元素 data() 的形状(节点与边合用一个结构,字段随元素种类而异故多为可选)。
 * 用于把 `node.data()` / `edge.data()` 的 any 收成结构化类型。
 */
export interface CyData {
    id: string;
    label?: string;
    title?: string;
    displayText?: string;
    originalNode?: ZKNode;
    isGroup?: boolean;
    isPlaceholder?: boolean;
    isCrossDomain?: boolean;
    isDraft?: boolean;
    isDraftEdge?: boolean;
    isDraftRelation?: boolean;
    isFreeNode?: boolean;
    parent?: string;
    nodeIds?: string[];
    draftBatchId?: string;
    relKey?: string;
    // 边字段
    source?: string;
    target?: string;
    type?: string;
    originalSource?: string;
    originalTarget?: string;
    crossDomainLink?: CrossDomainLink;
    crossDomainSourceNodeId?: string;
}

export interface GraphMetadata {
    currentFile: string;
    timestamp: number;
    hash: string;
    renderType: 'family' | 'inoutlinks' | 'moc' | 'moc-tree' | 'index';
    groups?: GroupInfo[];  // 分组信息
    edgeCurvatures?: Record<string, { distance: number; weight: number }>;  // 边弧度信息
    nodeColors?: Record<string, string>;  // 节点颜色信息
    nodeStyleColors?: Record<string, string>;  // 分支主题色（一级节点）
    crossDomainLinks?: Record<string, CrossDomainLink[]>;  // 跨领域关联信息
    nodePositions?: Record<string, { x: number; y: number }>;  // 节点位置信息
    embedNodeSizes?: Record<string, { width: number; height: number }>; // 预览节点尺寸（模型坐标系）
    nodeRemarks?: Record<string, string>; // 节点备注
    nodeAnchors?: Record<string, boolean>; // 锚点节点
    collapsedNodeIds?: string[]; // 折叠的节点 ID
}

/**
 * 视图状态
 */
export interface ViewState {
    zoom: number;
    pan: { x: number; y: number };
    selectedNodes: string[];
    expandedNodes: string[];
    timestamp: number;
}

/**
 * 渲染选项
 */
export interface RenderOptions {
    app?: App;
    direction?: 'TB' | 'BT' | 'LR' | 'RL';
    layoutType?: 'breadthfirst' | 'dagre' | 'cose' | 'cose-bilkent' | 'grid' | 'preset';
    animate?: boolean;
    animationDuration?: number;
    nodeText?: 'id' | 'title' | 'both' | 'id-title';
    themeMode?: 'dark' | 'light';
    themeStyle?: 'default' | 'modern' | 'nebula';
    edgeStyle?: 'straight' | 'bezier' | 'polyline';
    nodeLayoutStyle?: 'free' | 'auto';
    nodeLayoutOverrides?: Record<string, 'auto' | 'free'>;
    // auto 布局下已与父节点轨道分离的节点 ID(NODE_FLAG_SEPARATED)。
    // 渲染器据此在拖动时算"分离圆"半径时排除这些远处的兄弟。
    separatedNodeIds?: string[];
    showNoteId?: boolean;
    smartConnection?: boolean;
    readOnly?: boolean;
    showMinimap?: boolean;
    exportMode?: boolean;  // 纯导出模式：跳过所有 DOM 事件绑定和预览渲染，防止触发 MutationObserver 副作用
    mocPreviewExporter?: (mocFile: TFile) => Promise<TFile | null>;
    initialCollapsedNodeIds?: string[];
    // 点击节点内 wiki 链接时按「文件默认打开方式」打开;未提供时回退到 openLinkText。
    // forceTab=true(Cmd/Ctrl+点击)始终新标签页。
    openLink?: (linkText: string, sourcePath: string, forceTab: boolean) => void;
    // 点击已解析文件(如 embed 预览标题)时按「文件默认打开方式」打开。
    openFile?: (file: TFile, wikiLink: string, forceTab: boolean) => void;
}

/**
 * 图形变化
 */
export interface GraphChanges {
    addedNodes: ZKNode[];
    removedNodes: ZKNode[];
    updatedNodes: ZKNode[];
    addedEdges: Edge[];
    removedEdges: Edge[];
    updatedEdges: Edge[];
}

/**
 * 渲染器接口
 */
export interface IGraphRenderer {
    render(container: HTMLElement, data: GraphData, options: RenderOptions): Promise<void>;
    update(changes: GraphChanges): Promise<void>;
    destroy(): void;
    getState(): ViewState;
    setState(state: ViewState): void;
}
