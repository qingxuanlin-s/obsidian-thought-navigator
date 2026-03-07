import { TFile } from "obsidian";
import { ZKNode } from "src/view/indexView";

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
    crossDomainLink?: any;  // 跨领域链接信息（用于 cross-domain 类型）
}

export interface GraphMetadata {
    currentFile: string;
    timestamp: number;
    hash: string;
    renderType: 'family' | 'inoutlinks' | 'moc' | 'moc-tree' | 'index';
    groups?: any[];  // 分组信息
    edgeCurvatures?: Record<string, { distance: number; weight: number }>;  // 边弧度信息
    nodeColors?: Record<string, string>;  // 节点颜色信息
    nodeStyleColors?: Record<string, string>;  // 分支主题色（一级节点）
    crossDomainLinks?: Record<string, any[]>;  // 跨领域关联信息
    nodePositions?: Record<string, { x: number; y: number }>;  // 节点位置信息
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
    direction?: 'TB' | 'BT' | 'LR' | 'RL';
    layoutType?: 'breadthfirst' | 'dagre' | 'cose' | 'cose-bilkent' | 'grid' | 'preset';
    animate?: boolean;
    animationDuration?: number;
    nodeText?: 'id' | 'title' | 'both' | 'id-title';
    themeMode?: 'dark' | 'light';
    themeStyle?: 'default' | 'vivid';
    edgeStyle?: 'straight' | 'bezier' | 'polyline';
    showNoteId?: boolean;
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
