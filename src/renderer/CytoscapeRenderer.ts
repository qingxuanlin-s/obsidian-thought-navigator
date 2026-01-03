import * as cytoscapeNamespace from 'cytoscape';
import * as dagreNamespace from 'cytoscape-dagre';
import * as coseBilkentNamespace from 'cytoscape-cose-bilkent';
import { IGraphRenderer, GraphData, RenderOptions, GraphChanges, ViewState, Edge } from './types';
import { ZKNode } from 'src/view/indexView';

// 处理 CommonJS 和 ESM 模块的兼容性
const getCytoscape = (): any => {
    const cy = (cytoscapeNamespace as any).default || cytoscapeNamespace;
    return cy;
};

const getDagre = (): any => {
    const d = (dagreNamespace as any).default || dagreNamespace;
    return d;
};

const getCoseBilkent = (): any => {
    const cb = (coseBilkentNamespace as any).default || coseBilkentNamespace;
    return cb;
};

// 延迟注册扩展的标志
let extensionsRegistered = false;

// 注册布局扩展
const registerExtensions = () => {
    if (extensionsRegistered) return;
    
    try {
        const cytoscape = getCytoscape();
        const dagre = getDagre();
        const coseBilkent = getCoseBilkent();
        
        if (typeof cytoscape === 'function' && cytoscape.use) {
            cytoscape.use(dagre);
            cytoscape.use(coseBilkent);
            extensionsRegistered = true;
        }
    } catch (error) {
        console.error('Failed to register Cytoscape extensions:', error);
    }
};

/**
 * Cytoscape.js 渲染器
 * 提供高性能的图形可视化和增量更新支持
 */
export class CytoscapeRenderer implements IGraphRenderer {
    private cy: cytoscape.Core | null = null;
    private container: HTMLElement | null = null;
    private currentData: GraphData | null = null;
    private currentOptions: RenderOptions | null = null;
    private edgeControlPoints: Map<string, { distance: number; weight: number }> = new Map();

    /**
     * 渲染图形
     */
    async render(container: HTMLElement, data: GraphData, options: RenderOptions): Promise<void> {
        // 确保扩展已注册
        registerExtensions();
        
        this.container = container;
        this.currentData = data;
        this.currentOptions = options;

        // 如果已存在实例，先销毁
        if (this.cy) {
            this.cy.destroy();
        }

        // 获取 cytoscape 函数
        const cytoscape = getCytoscape();

        // 转换元素（包含分组）
        const elements = this.convertToElementsWithGroups(data);

        // 初始化 Cytoscape
        this.cy = cytoscape({
            container: container,
            elements: elements,
            style: [
                ...this.getStylesheet(options),
                {
                    selector: 'core',
                    style: {
                        'background-color': 'transparent',
                        'background-opacity': 0
                    } as any
                }
            ],
            layout: { name: 'preset' }, // 先使用 preset，稍后运行布局
            // 性能优化选项
            hideEdgesOnViewport: true,
            textureOnViewport: true,
            motionBlur: false,
            pixelRatio: 'auto',
            // 启用节点拖动
            autoungrabify: false,
            userZoomingEnabled: true,
            userPanningEnabled: true
        });

        // 绑定事件
        this.bindEvents();
        
        // 绑定键盘事件
        this.bindKeyboardEvents();

        // 添加节点徽章（左上角的 ID）
        this.addNodeBadges();

        // 检查是否有保存的位置
        const hasSavedPositions = data.nodes.some(node => node.savedPosition);
        
        // 运行布局
        if (this.cy) {
            if (hasSavedPositions) {
                // 如果有保存的位置，使用 preset 布局（保持原位置）
                const layout = this.cy.layout({ name: 'preset' });
                layout.run();
            } else {
                const layout = this.cy.layout({ name: 'preset' });
                layout.run();
            }
        }
    }

    /**
     * 增量更新图形
     */
    async update(changes: GraphChanges): Promise<void> {
        if (!this.cy) return;

        // 批量更新以提高性能
        this.cy.batch(() => {
            // 删除节点（会自动删除相关的边）
            if (changes.removedNodes.length > 0) {
                const ids = changes.removedNodes.map(n => `#${this.escapeId(n.ID)}`).join(',');
                this.cy!.remove(ids);
            }

            // 删除边
            if (changes.removedEdges.length > 0) {
                const ids = changes.removedEdges.map(e => `#${this.escapeId(e.id)}`).join(',');
                this.cy!.remove(ids);
            }

            // 添加新节点
            if (changes.addedNodes.length > 0) {
                this.cy!.add(this.convertNodesToElements(changes.addedNodes));
            }

            // 添加新边
            if (changes.addedEdges.length > 0) {
                this.cy!.add(this.convertEdgesToElements(changes.addedEdges));
            }

            // 更新节点
            changes.updatedNodes.forEach(node => {
                const ele = this.cy!.$id(this.escapeId(node.ID));
                if (ele.length > 0) {
                    ele.data('label', this.getNodeLabel(node, this.currentOptions));
                    ele.data('title', node.title);
                }
            });

            // 更新边
            changes.updatedEdges.forEach(edge => {
                const ele = this.cy!.$id(this.escapeId(edge.id));
                if (ele.length > 0) {
                    ele.data('label', edge.label || '');
                }
            });
        });

        // 根据变化程度决定是否重新布局
        if (this.shouldRelayout(changes)) {
            const layout = this.cy.layout({ name: 'preset' });
            layout.run();
        }
    }

    /**
     * 销毁渲染器
     */
    destroy(): void {
        if (this.cy) {
            this.cy.destroy();
            this.cy = null;
        }
        this.container = null;
        this.currentData = null;
    }

    /**
     * 获取 Cytoscape 实例（用于外部操作）
     */
    getCytoscapeInstance(): cytoscape.Core | null {
        return this.cy;
    }

    /**
     * 居中并适配视图
     */
    fitAndCenter(): void {
        if (this.cy) {
            this.cy.fit();
            this.cy.center();
        }
    }

    /**
     * 获取当前状态
     */
    getState(): ViewState {
        if (!this.cy) {
            return {
                zoom: 1,
                pan: { x: 0, y: 0 },
                selectedNodes: [],
                expandedNodes: [],
                timestamp: Date.now()
            };
        }

        return {
            zoom: this.cy.zoom(),
            pan: this.cy.pan(),
            selectedNodes: this.cy.$(':selected').map((ele: any) => ele.id()),
            expandedNodes: [],
            timestamp: Date.now()
        };
    }

    /**
     * 设置状态
     */
    setState(state: ViewState): void {
        if (!this.cy) return;

        this.cy.zoom(state.zoom);
        this.cy.pan(state.pan);

        // 恢复选中状态
        this.cy.$(':selected').unselect();
        state.selectedNodes.forEach(id => {
            this.cy!.$id(this.escapeId(id)).select();
        });
    }

    /**
     * 转换数据为 Cytoscape 元素（包含分组）
     */
    private convertToElementsWithGroups(data: GraphData): cytoscape.ElementDefinition[] {
        // 先加载边弧度信息到 Map（必须在 convertEdgesToElements 之前）
        this.edgeControlPoints.clear();
        const edgeCurvatures = data.metadata.edgeCurvatures || {};
        Object.entries(edgeCurvatures).forEach(([key, value]) => {
            this.edgeControlPoints.set(key, value);
        });
        
        // 然后转换节点和边
        const nodes = this.convertNodesToElements(data.nodes);
        const edges = this.convertEdgesToElements(data.edges);
        
        // 获取分组信息
        const groups = (data.metadata as any)?.groups || [];
        
        // 创建分组节点（compound nodes）
        const groupNodes = groups.map((group: any) => {
            return {
                group: 'nodes' as const,
                data: {
                    id: group.id,
                    label: group.label,
                    isGroup: true
                },
                classes: 'group-node'
            };
        });
        
        // 为分组内的节点设置 parent
        nodes.forEach((node: any) => {
            const nodeId = node.data.originalNode?.ID;
            if (nodeId) {
                const parentGroup = groups.find((g: any) => g.nodeIds.includes(nodeId));
                if (parentGroup) {
                    node.data.parent = parentGroup.id;
                }
            }
        });
        
        return [...groupNodes, ...nodes, ...edges];
    }

    /**
     * 转换数据为 Cytoscape 元素
     */
    private convertToElements(data: GraphData): cytoscape.ElementDefinition[] {
        const nodes = this.convertNodesToElements(data.nodes);
        const edges = this.convertEdgesToElements(data.edges);
        return [...nodes, ...edges];
    }

    /**
     * 转换节点为 Cytoscape 元素
     */
    private convertNodesToElements(nodes: ZKNode[]): any[] {
        // 获取当前文件路径（如果有）
        const currentFilePath = this.currentData?.metadata.currentFile || '';
        
        const elements = nodes.map(node => {
            const element: any = {
                group: 'nodes' as const,
                data: {
                    id: this.escapeId(node.ID),
                    label: this.getNodeLabel(node, this.currentOptions),
                    badge: this.getNodeBadge(node, this.currentOptions),
                    title: node.title,
                    filePath: node.file.path,
                    displayText: node.displayText,
                    position: node.position,
                    isCurrentFile: node.file.path === currentFilePath,
                    originalNode: node
                }
            };
            
            // 如果节点有保存的位置信息，使用它
            if (node.savedPosition) {
                element.position = {
                    x: node.savedPosition.x,
                    y: node.savedPosition.y
                };
            }
            
            return element;
        });
        
        
        return elements;
    }

    /**
     * 转换边为 Cytoscape 元素
     */
    private convertEdgesToElements(edges: Edge[]): any[] {
        const elements = edges.map(edge => {
            const element: any = {
                group: 'edges' as const,
                data: {
                    id: this.escapeId(edge.id),
                    source: this.escapeId(edge.source),
                    target: this.escapeId(edge.target),
                    label: edge.label || '',
                    type: edge.type,
                    // 保存原始的 source 和 target ID（未转义）
                    originalSource: edge.source,
                    originalTarget: edge.target
                }
            };
            
            // 使用标准格式: source-target (如 "a-a.1.a")
            const key = `${edge.source}-${edge.target}`;
            const curvature = this.edgeControlPoints.get(key);
            
            if (curvature) {
                element.data.controlPointDistance = curvature.distance;
                element.data.controlPointWeight = curvature.weight;
            }
            
            return element;
        });
        
        return elements;
    }

    /**
     * 获取节点标签
     */
    private getNodeLabel(node: ZKNode, options: RenderOptions | null): string {
        const nodeText = options?.nodeText || 'both';
        
        let label = '';
        switch (nodeText) {
            case 'id':
                label = node.ID;
                break;
            case 'title':
                label = node.title || node.displayText;
                break;
            case 'id-title':
                // id-title 模式：只返回标题，ID 会在 badge 中显示
                label = node.title || node.displayText;
                break;
            case 'both':
            default:
                label = node.displayText;
                break;
        }
        
        // 处理显示文本：去掉时间戳前缀
        return this.processDisplayText(label, nodeText);
    }

    /**
     * 获取节点徽章（左上角显示的 ID）
     */
    private getNodeBadge(node: ZKNode, options: RenderOptions | null): string {
        const nodeText = options?.nodeText || 'both';
        
        // 在 id-title 和 both 模式下显示 ID 徽章
        if (nodeText === 'id-title' || nodeText === 'both') {
            return node.ID;
        }
        
        return '';
    }

    /**
     * 处理显示文本：去掉时间戳前缀
     * 支持的时间戳格式：
     * - YYYYMMDD (8位数字)
     * - YYYYMMDDHHMMSS (14位数字)
     * - YYYY-MM-DD
     * - YYYYMMDD-HHMMSS
     */
    private processDisplayText(text: string, nodeText: string): string {
        if (nodeText === 'id-title') {
            // id-title 模式：去掉 ": " 后面的时间戳
            // 例如：a.1: 20251215 薛定谔方程 -> a.1: 薛定谔方程
            return text.replace(/[^ ]+ /, ' ');
        } else if (nodeText === 'title' || nodeText === 'both') {
            // title 或 both 模式：去掉开头的时间戳
            // 例如：20251215 薛定谔方程 -> 薛定谔方程
            return text.replace(/^(\d{8}|\d{14}|\d{4}-\d{2}-\d{2}|\d{8}-\d{6})\s+/, "");
        }
        
        return text;
    }

    /**
     * 转义 ID 中的特殊字符
     */
    private escapeId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

   private getStylesheet(options: RenderOptions): any[] {
    const colors = {
        nodeBackground: '#1a2332',
        nodeBackgroundHover: '#243447',
        nodeBackgroundSelected: '#2d4a6b',
        nodeBorder: '#3d5a80',
        nodeBorderSelected: '#5b8fd9',
        nodeText: '#e0e7ff',
        nodeTextMuted: '#94a3b8',
        edgeNormal: '#4a5568',
        edgeForward: '#5b8fd9',
        edgeReverse: '#ef4444',
        edgeSelected: '#7c3aed',
        textBackground: '#0f172a',
        overlayColor: '#5b8fd9',
        badgeBackground: '#5b8fd9',  // 改为蓝色，更柔和
        badgeText: '#ffffff'
    };

    return [
        // 节点样式 - 使用函数动态计算大小
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'text-valign': 'center',
                'text-halign': 'center',
                'text-wrap': 'wrap',
                'text-max-width': '200px',
                'text-overflow-wrap': 'anywhere',
                'background-color': colors.nodeBackground,
                'color': colors.nodeText,
                'font-size': '12px',
                'font-weight': '500',
                // 使用函数动态计算宽度和高度
                'width': (ele: any) => {
                    const label = ele.data('label') || '';
                    const baseWidth = 80;
                    const charWidth = 8;
                    const maxWidth = 220;
                    const padding = 32;
                    
                    const textWidth = Math.min(label.length * charWidth, maxWidth);
                    return Math.max(baseWidth, textWidth + padding);
                },
                'height': (ele: any) => {
                    const label = ele.data('label') || '';
                    const baseHeight = 50;
                    const lineHeight = 18;
                    const maxWidth = 200;
                    const charWidth = 8;
                    const padding = 24;
                    
                    const estimatedLines = Math.ceil((label.length * charWidth) / maxWidth);
                    const textHeight = estimatedLines * lineHeight;
                    return Math.max(baseHeight, textHeight + padding);
                },
                'padding': '16px',
                'shape': 'round-rectangle',
                'border-width': '2px',
                'border-color': colors.nodeBorder,
                'transition-property': 'background-color, border-color',
                'transition-duration': '0.2s'
            } as any
        },
        // 节点徽章样式已通过 HTML 叠加层实现，这里不需要额外样式
        // 分组节点样式 - 容器化设计
        {
            selector: '.group-node',
            style: {
                'background-color': 'rgba(30, 41, 59, 0.2)',  // 半透明深色背景
                'background-opacity': 1,
                'border-width': '0px',  // 移除边框
                'shape': 'round-rectangle',  // 圆角矩形
                'label': 'data(label)',
                'text-valign': 'top',
                'text-halign': 'center',
                'text-margin-y': -10,
                'font-size': '14px',
                'font-weight': '600',
                'color': '#94a3b8',  // 柔和的灰色文字
                'padding': '20px'
            } as any
        },
        // 默认边样式 - 使用 unbundled-bezier 支持自定义控制点
        {
            selector: 'edge',
            style: {
                'width': 2,
                'line-color': colors.edgeNormal,
                'target-arrow-color': colors.edgeNormal,
                'target-arrow-shape': 'triangle',
                'curve-style': 'unbundled-bezier',
                'control-point-distances': (ele: any) => {
                    const distance = ele.data('controlPointDistance');
                    return distance !== undefined ? distance : 0;  // 默认为 0（直线）
                },
                'control-point-weights': (ele: any) => {
                    const weight = ele.data('controlPointWeight');
                    return weight !== undefined ? weight : 0.5;
                },
                'arrow-scale': 1.2,
                'label': 'data(label)',
                'font-size': '11px',
                'color': colors.nodeText,
                'text-background-color': colors.textBackground,
                'text-background-opacity': 1,
                'text-background-padding': '4px',
                'text-background-shape': 'roundrectangle',
                'text-border-width': 1,
                'text-border-color': colors.nodeBorder,
                'text-border-opacity': 0.8,
                'z-index-compare': 'manual',
                'z-index': 999
            } as any
        },
        // 正向边
        {
            selector: 'edge[type="forward"]',
            style: {
                'line-color': colors.edgeForward,
                'target-arrow-color': colors.edgeForward,
                'width': 2.5,
                'z-index': 999
            } as any
        },
        // 反向边（虚线）- 降噪设计
        {
            selector: 'edge[type="reverse"]',
            style: {
                'line-style': 'dashed',
                'line-dash-pattern': [6, 4],
                'line-color': '#64748b',  // 暗灰色（降噪）
                'target-arrow-color': '#64748b',
                'width': 1.5,  // 更细
                'arrow-scale': 1.0,
                'opacity': 0.5,  // 更淡
                'z-index': 999
            } as any
        },
        // 边选中状态
        {
            selector: 'edge:selected',
            style: {
                'line-color': colors.edgeSelected,
                'target-arrow-color': colors.edgeSelected,
                'width': 3,
                'opacity': 1,
                'z-index': 1000
            } as any
        },
        // 节点悬停状态
        {
            selector: 'node:active',
            style: {
                'background-color': colors.nodeBackgroundHover,
                'border-color': colors.nodeBorderSelected,
                'overlay-opacity': 0.15
            } as any
        },
        // 节点选中状态
        {
            selector: 'node:selected',
            style: {
                'background-color': colors.nodeBackgroundSelected,
                'border-color': colors.nodeBorderSelected,
                'border-width': '3px',
                'color': '#ffffff'
            } as any
        },
        // 当前文件节点
        {
            selector: 'node[?isCurrentFile]',
            style: {
                'background-color': colors.nodeBackgroundSelected,
                'border-color': colors.nodeBorderSelected,
                'border-width': '3px',
                'font-weight': '600'
            } as any
        },
        // 连接目标悬停状态
        {
            selector: 'node.connection-target-hover',
            style: {
                'border-color': '#10b981',  // 绿色
                'border-width': '3px',
                'background-color': 'rgba(16, 185, 129, 0.1)'
            } as any
        }
    ];
}
        /**
     * 获取布局配置
     */
    private getLayout(options: RenderOptions): any {
     const layoutType = options.layoutType || 'dagre';  // 改为 dagre 默认
    const animate = options.animate !== false;
    const animationDuration = options.animationDuration || 500;

    const baseLayout = {
        animate: animate,
        animationDuration: animationDuration,
        fit: true,
        padding: 80
    };

        switch (layoutType) {
            case 'breadthfirst':
                return {
                    name: 'breadthfirst',
                    ...baseLayout,
                    directed: true,
                    spacingFactor: 1.5,
                    avoidOverlap: true,
                    nodeDimensionsIncludeLabels: true
                };
case 'dagre':
    return {
        name: 'dagre',
        ...baseLayout,
        rankDir: 'LR',
        nodeSep: 150,        // 同层节点间距（水平）
        edgeSep: 50,         // 边的间距
        rankSep: 200,        // 层级间距（垂直）
        ranker: 'network-simplex',
        nodeDimensionsIncludeLabels: true  // 考虑标签尺寸
    };
            case 'cose':
                return {
                    name: 'cose-bilkent',
                    ...baseLayout,
                    nodeRepulsion: 4500,
                    idealEdgeLength: 100,
                    edgeElasticity: 0.45,
                    nestingFactor: 0.1,
                    gravity: 0.25,
                    numIter: 2500,
                    tile: true,
                    tilingPaddingVertical: 10,
                    tilingPaddingHorizontal: 10,
                    gravityRangeCompound: 1.5,
                    gravityCompound: 1.0,
                    gravityRange: 3.8
                };

            case 'grid':
                return {
                    name: 'grid',
                    ...baseLayout,
                    rows: undefined,
                    cols: undefined,
                    avoidOverlap: true,
                    avoidOverlapPadding: 10,
                    nodeDimensionsIncludeLabels: true
                };

            default:
                return {
                    name: 'breadthfirst',
                    ...baseLayout
                };
        }
    }

    /**
     * 添加节点徽章（HTML 叠加层）
     */
    private addNodeBadges(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的徽章容器
        const oldBadgeContainer = this.container.querySelector('.zk-node-badges');
        if (oldBadgeContainer) {
            oldBadgeContainer.remove();
        }

        // 创建徽章容器
        const badgeContainer = document.createElement('div');
        badgeContainer.className = 'zk-node-badges';
        badgeContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1;
        `;
        this.container.appendChild(badgeContainer);

        // 为每个有 badge 的节点创建徽章元素
        this.cy.nodes('[badge]').forEach((node: any) => {
            const badge = node.data('badge');
            if (!badge) return;

            const badgeEl = document.createElement('div');
            badgeEl.className = 'zk-node-badge';
            badgeEl.textContent = badge;
            badgeEl.style.cssText = `
                position: absolute;
                background-color: rgba(59, 130, 246, 0.15);
                color: #94a3b8;
                font-size: 9px;
                font-weight: 600;
                padding: 2px 6px;
                border-radius: 4px;
                border: 1px solid rgba(71, 85, 105, 0.4);
                backdrop-filter: blur(4px);
                white-space: nowrap;
                pointer-events: auto;
                cursor: pointer;
            `;
            badgeContainer.appendChild(badgeEl);

            // 更新徽章位置的函数
            const updateBadgePosition = () => {
                // 检查 cy 实例是否存在
                if (!this.cy) return;
                
                const pos = node.renderedPosition();
                const zoom = this.cy.zoom();
                const boundingBox = node.renderedBoundingBox();
                
                // 计算徽章位置（节点左上角内部）
                const x = boundingBox.x1 + 4 * zoom;  // 左边距 4px
                const y = boundingBox.y1 + 4 * zoom;  // 上边距 4px
                
                badgeEl.style.left = `${x}px`;
                badgeEl.style.top = `${y}px`;
                // 移除 scale 变换，让徽章随图形缩放
                badgeEl.style.transform = '';
                badgeEl.style.fontSize = `${10 * zoom}px`;
                badgeEl.style.padding = `${2 * zoom}px ${6 * zoom}px`;
                badgeEl.style.borderRadius = `${4 * zoom}px`;
                badgeEl.style.borderWidth = `${1 * zoom}px`;
            };

            // 初始位置
            updateBadgePosition();

            // 监听节点位置变化
            node.on('position', updateBadgePosition);
            
            // 监听视图变化（缩放、平移）
            if (this.cy) {
                this.cy.on('zoom pan', updateBadgePosition);
            }

            // 点击徽章时选中节点
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                node.select();
            });
        });
        
        // 添加边控制点
        this.addEdgeControlPoints();
        
        // 添加连线手柄
        this.addConnectionHandles();
    }
    
    /**
     * 添加连线手柄（用于拖动创建连接）
     */
    private addConnectionHandles(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的手柄容器
        const oldHandleContainer = this.container.querySelector('.zk-connection-handles');
        if (oldHandleContainer) {
            oldHandleContainer.remove();
        }

        // 创建手柄容器
        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-connection-handles';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 3;
        `;
        this.container.appendChild(handleContainer);

        // 为每个节点创建连线手柄
        this.cy.nodes('[!isGroup]').forEach((node: any) => {
            const handle = document.createElement('div');
            handle.className = 'zk-connection-handle';
            handle.style.cssText = `
                position: absolute;
                width: 12px;
                height: 12px;
                background-color: #5b8fd9;
                border: 2px solid #ffffff;
                border-radius: 50%;
                cursor: crosshair;
                pointer-events: auto;
                transform: translate(-50%, -50%);
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                opacity: 0;
                transition: opacity 0.2s;
            `;
            handleContainer.appendChild(handle);

            // 更新手柄位置的函数
            const updateHandlePosition = () => {
                if (!this.cy) return;
                
                const boundingBox = node.renderedBoundingBox();
                const zoom = this.cy.zoom();
                
                // 手柄位置在节点右边缘中点
                const x = boundingBox.x2;
                const y = (boundingBox.y1 + boundingBox.y2) / 2;
                
                handle.style.left = `${x}px`;
                handle.style.top = `${y}px`;
                handle.style.width = `${12 * zoom}px`;
                handle.style.height = `${12 * zoom}px`;
                handle.style.borderWidth = `${2 * zoom}px`;
            };

            // 初始位置
            updateHandlePosition();

            // 监听节点位置和视图变化
            if (this.cy) {
                this.cy.on('zoom pan position', updateHandlePosition);
            }

            // 鼠标悬停显示手柄
            node.on('mouseover', () => {
                handle.style.opacity = '1';
            });

            node.on('mouseout', () => {
                handle.style.opacity = '0';
            });

            // 拖动创建连接
            this.bindConnectionDrag(handle, node, handleContainer);
        });
    }

    /**
     * 绑定连线拖动事件
     */
    private bindConnectionDrag(handle: HTMLElement, sourceNode: any, container: HTMLElement): void {
        if (!this.cy || !this.container) return;

        let isDragging = false;
        let dragLine: SVGLineElement | null = null;
        let svgOverlay: SVGSVGElement | null = null;

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            
            isDragging = true;
            handle.style.opacity = '1';

            // 创建 SVG 叠加层用于绘制连线
            svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 2;
            `;
            this.container!.appendChild(svgOverlay);

            // 创建连线
            dragLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            dragLine.setAttribute('stroke', '#5b8fd9');
            dragLine.setAttribute('stroke-width', '2');
            dragLine.setAttribute('stroke-dasharray', '5,5');
            svgOverlay.appendChild(dragLine);

            const sourcePos = sourceNode.renderedPosition();
            dragLine.setAttribute('x1', sourcePos.x.toString());
            dragLine.setAttribute('y1', sourcePos.y.toString());
            dragLine.setAttribute('x2', sourcePos.x.toString());
            dragLine.setAttribute('y2', sourcePos.y.toString());
        });

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !dragLine || !this.cy) return;

            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;

            const sourcePos = sourceNode.renderedPosition();
            dragLine.setAttribute('x1', sourcePos.x.toString());
            dragLine.setAttribute('y1', sourcePos.y.toString());
            dragLine.setAttribute('x2', mouseX.toString());
            dragLine.setAttribute('y2', mouseY.toString());

            // 检测鼠标下的节点
            const mousePos = { x: mouseX, y: mouseY };
            const targetNode = this.getNodeAtPosition(mousePos);
            
            if (targetNode && targetNode !== sourceNode) {
                // 高亮目标节点
                dragLine.setAttribute('stroke', '#10b981'); // 绿色表示可以连接
                targetNode.addClass('connection-target-hover');
            } else {
                dragLine.setAttribute('stroke', '#5b8fd9'); // 蓝色
                this.cy.nodes('.connection-target-hover').removeClass('connection-target-hover');
            }
        };

        const handleMouseUp = async (e: MouseEvent) => {
            if (!isDragging || !this.cy) return;

            isDragging = false;

            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;
            const mousePos = { x: mouseX, y: mouseY };

            // 检测目标节点
            const targetNode = this.getNodeAtPosition(mousePos);

            // 清理
            if (svgOverlay) {
                svgOverlay.remove();
                svgOverlay = null;
            }
            dragLine = null;
            this.cy.nodes('.connection-target-hover').removeClass('.connection-target-hover');

            const sourceData = sourceNode.data();
            const sourceOriginalNode = sourceData.originalNode;

            if (targetNode && targetNode !== sourceNode) {
                // 连接到现有节点 - 创建反向关系
                const targetData = targetNode.data();
                const targetOriginalNode = targetData.originalNode;

                this.container?.dispatchEvent(new CustomEvent('create-arrow-relation', {
                    detail: {
                        sourceNode: sourceOriginalNode,
                        targetNode: targetOriginalNode
                    }
                }));
            } else {
                // 连接到空白处 - 创建子节点
                const modelPos = this.cy.pan();
                const zoom = this.cy.zoom();
                const graphX = (mouseX - modelPos.x) / zoom;
                const graphY = (mouseY - modelPos.y) / zoom;

                this.container?.dispatchEvent(new CustomEvent('create-child-node', {
                    detail: {
                        parentNode: sourceOriginalNode,
                        position: { x: graphX, y: graphY }
                    }
                }));
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // 清理函数
        const cleanup = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        // 当手柄被移除时清理
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node === handle) {
                        cleanup();
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(container, { childList: true });
    }

    /**
     * 获取指定位置的节点
     */
    private getNodeAtPosition(pos: { x: number; y: number }): any {
        if (!this.cy) return null;

        const nodes = this.cy.nodes('[!isGroup]');
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const bb = node.renderedBoundingBox();
            
            if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
                return node;
            }
        }

        return null;
    }
    
    /**
     * 添加边控制点（用于手动调整弧度）
     */
    private addEdgeControlPoints(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的控制点容器
        const oldControlPointContainer = this.container.querySelector('.zk-edge-control-points');
        if (oldControlPointContainer) {
            oldControlPointContainer.remove();
        }

        // 创建控制点容器
        const controlPointContainer = document.createElement('div');
        controlPointContainer.className = 'zk-edge-control-points';
        controlPointContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 2;
        `;
        this.container.appendChild(controlPointContainer);

        // 监听边选中事件
        this.cy.on('select', 'edge', (evt: any) => {
            const edge = evt.target;
            this.showEdgeControlPoint(edge, controlPointContainer);
        });

        // 监听边取消选中事件
        this.cy.on('unselect', 'edge', () => {
            this.hideEdgeControlPoints(controlPointContainer);
        });

        // 监听节点位置变化，更新控制点位置
        this.cy.on('position', 'node', () => {
            // 如果有选中的边，更新其控制点
            const selectedEdge = this.cy?.$('edge:selected');
            if (selectedEdge && selectedEdge.length > 0) {
                // 触发控制点位置更新
                const event = new CustomEvent('update-control-point-position');
                controlPointContainer.dispatchEvent(event);
            }
        });
    }

    /**
     * 显示边的控制点
     */
    private showEdgeControlPoint(edge: any, container: HTMLElement): void {
        if (!this.cy) return;

        // 清除旧的控制点
        this.hideEdgeControlPoints(container);

        const data = edge.data();
        const sourceNode = this.cy.$id(data.source);
        const targetNode = this.cy.$id(data.target);

        if (!sourceNode.length || !targetNode.length) return;

        // 获取当前弧度参数
        const distance = data.controlPointDistance !== undefined ? data.controlPointDistance : 0;  // 默认为 0
        const weight = data.controlPointWeight !== undefined ? data.controlPointWeight : 0.5;

        // 创建控制点
        const controlPoint = document.createElement('div');
        controlPoint.className = 'zk-edge-control-point';
        controlPoint.style.cssText = `
            position: absolute;
            width: 12px;
            height: 12px;
            background-color: #5b8fd9;
            border: 2px solid #ffffff;
            border-radius: 50%;
            cursor: move;
            pointer-events: auto;
            transform: translate(-50%, -50%);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            z-index: 1000;
        `;
        container.appendChild(controlPoint);

        // 计算控制点位置的函数
        const updateControlPointPosition = () => {
            if (!this.cy) return;
            
            const sourcePos = sourceNode.renderedPosition();
            const targetPos = targetNode.renderedPosition();

            // 计算边的中点
            const currentWeight = edge.data('controlPointWeight') !== undefined ? edge.data('controlPointWeight') : 0.5;
            const midX = sourcePos.x + (targetPos.x - sourcePos.x) * currentWeight;
            const midY = sourcePos.y + (targetPos.y - sourcePos.y) * currentWeight;

            // 计算垂直方向
            const dx = targetPos.x - sourcePos.x;
            const dy = targetPos.y - sourcePos.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const perpX = -dy / len;
            const perpY = dx / len;

            // 控制点位置
            const currentDistance = edge.data('controlPointDistance') !== undefined ? edge.data('controlPointDistance') : 0;
            const cpX = midX + perpX * currentDistance;
            const cpY = midY + perpY * currentDistance;

            controlPoint.style.left = `${cpX}px`;
            controlPoint.style.top = `${cpY}px`;
        };

        // 初始位置
        updateControlPointPosition();

        // 监听图形缩放和平移
        this.cy.on('zoom pan', updateControlPointPosition);

        // 监听节点位置变化（使用 Cytoscape 的全局事件）
        this.cy.on('position', updateControlPointPosition);

        // 监听自定义的控制点位置更新事件
        const handleUpdatePosition = () => updateControlPointPosition();
        container.addEventListener('update-control-point-position', handleUpdatePosition);

        // 拖动控制点
        let isDragging = false;

        controlPoint.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = true;
            controlPoint.style.cursor = 'grabbing';
        });

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !this.cy) return;

            const sourcePos = sourceNode.renderedPosition();
            const targetPos = targetNode.renderedPosition();

            // 计算鼠标在画布上的位置
            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;

            // 计算边的中点和方向
            const currentWeight = edge.data('controlPointWeight') !== undefined ? edge.data('controlPointWeight') : 0.5;
            const midX = sourcePos.x + (targetPos.x - sourcePos.x) * currentWeight;
            const midY = sourcePos.y + (targetPos.y - sourcePos.y) * currentWeight;

            const dx = targetPos.x - sourcePos.x;
            const dy = targetPos.y - sourcePos.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const perpX = -dy / len;
            const perpY = dx / len;

            // 计算新的 distance（鼠标到边中点的垂直距离）
            const toMouseX = mouseX - midX;
            const toMouseY = mouseY - midY;
            const newDistance = toMouseX * perpX + toMouseY * perpY;

            // 更新边的弧度
            edge.data('controlPointDistance', newDistance);
            edge.data('controlPointWeight', currentWeight);

            // 立即更新控制点位置
            updateControlPointPosition();

            // 触发弧度变化事件
            this.container?.dispatchEvent(new CustomEvent('edge-curvature-changed', {
                detail: {
                    edgeId: `${data.originalSource}-${data.originalTarget}`,  // 使用原始 ID 格式
                    source: data.originalSource || data.source,
                    target: data.originalTarget || data.target,
                    distance: newDistance,
                    weight: currentWeight
                }
            }));
        };

        const handleMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                controlPoint.style.cursor = 'move';
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // 清理函数
        const cleanup = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            container.removeEventListener('update-control-point-position', handleUpdatePosition);
            if (this.cy) {
                this.cy.off('zoom pan position', updateControlPointPosition);
            }
        };

        // 当控制点被移除时清理
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node === controlPoint) {
                        cleanup();
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(container, { childList: true });
    }

    /**
     * 隐藏边控制点
     */
    private hideEdgeControlPoints(container: HTMLElement): void {
        const controlPoints = container.querySelectorAll('.zk-edge-control-point');
        controlPoints.forEach(cp => cp.remove());
    }

    /**
     * 绑定分组创建事件（Command/Ctrl + 拖动）
     */
    private bindGroupCreationEvents(): void {
        if (!this.cy || !this.container) return;

        let isDrawing = false;
        let startPos: { x: number; y: number } | null = null;
        let selectionBox: HTMLDivElement | null = null;

        // 监听鼠标按下事件
        this.container.addEventListener('mousedown', (e: MouseEvent) => {
            // 检查是否按下 Command (Mac) 或 Ctrl (Windows/Linux)
            if (e.metaKey || e.ctrlKey) {
                // 阻止默认行为
                e.preventDefault();
                e.stopPropagation();

                isDrawing = true;
                startPos = { x: e.clientX, y: e.clientY };

                // 创建选择框
                selectionBox = document.createElement('div');
                selectionBox.style.cssText = `
                    position: fixed;
                    border: 2px dashed #5b8fd9;
                    background-color: rgba(91, 143, 217, 0.1);
                    pointer-events: none;
                    z-index: 10000;
                `;
                document.body.appendChild(selectionBox);

                // 禁用 Cytoscape 的平移
                if (this.cy) {
                    this.cy.userPanningEnabled(false);
                }
            }
        });

        // 监听鼠标移动事件
        this.container.addEventListener('mousemove', (e: MouseEvent) => {
            if (isDrawing && startPos && selectionBox) {
                const currentPos = { x: e.clientX, y: e.clientY };

                // 计算矩形位置和大小
                const left = Math.min(startPos.x, currentPos.x);
                const top = Math.min(startPos.y, currentPos.y);
                const width = Math.abs(currentPos.x - startPos.x);
                const height = Math.abs(currentPos.y - startPos.y);

                selectionBox.style.left = `${left}px`;
                selectionBox.style.top = `${top}px`;
                selectionBox.style.width = `${width}px`;
                selectionBox.style.height = `${height}px`;
            }
        });

        // 监听鼠标释放事件
        this.container.addEventListener('mouseup', (e: MouseEvent) => {
            if (isDrawing && startPos && selectionBox) {
                const endPos = { x: e.clientX, y: e.clientY };

                // 计算选择框的边界
                const containerRect = this.container!.getBoundingClientRect();
                const left = Math.min(startPos.x, endPos.x) - containerRect.left;
                const top = Math.min(startPos.y, endPos.y) - containerRect.top;
                const right = Math.max(startPos.x, endPos.x) - containerRect.left;
                const bottom = Math.max(startPos.y, endPos.y) - containerRect.top;

                // 查找矩形内的节点
                const selectedNodes: any[] = [];
                if (this.cy) {
                    this.cy.nodes().forEach((node: any) => {
                        const pos = node.renderedPosition();
                        const bb = node.renderedBoundingBox();

                        // 检查节点是否在选择框内
                        if (bb.x1 >= left && bb.x2 <= right && bb.y1 >= top && bb.y2 <= bottom) {
                            selectedNodes.push(node);
                        }
                    });
                }

                // 移除选择框
                selectionBox.remove();
                selectionBox = null;

                // 恢复 Cytoscape 的平移
                if (this.cy) {
                    this.cy.userPanningEnabled(true);
                }

                // 如果选中了节点，创建分组
                if (selectedNodes.length > 0) {
                    this.createGroupFromNodes(selectedNodes);
                }

                // 重置状态
                isDrawing = false;
                startPos = null;
            }
        });

        // 监听鼠标离开容器事件（取消绘制）
        this.container.addEventListener('mouseleave', () => {
            if (isDrawing && selectionBox) {
                selectionBox.remove();
                selectionBox = null;
                isDrawing = false;
                startPos = null;

                // 恢复 Cytoscape 的平移
                if (this.cy) {
                    this.cy.userPanningEnabled(true);
                }
            }
        });
    }

    /**
     * 从选中的节点创建分组
     */
    private createGroupFromNodes(nodes: any[]): void {
        if (nodes.length === 0) return;

        // 创建自定义输入对话框
        this.showGroupNameDialog((groupLabel) => {
            if (!groupLabel) return;

            // 生成分组 ID
            const groupId = `group_${Date.now()}`;

            // 获取节点 ID 列表
            const nodeIds = nodes.map(node => node.data('originalNode').ID);

            // 触发创建分组事件
            this.container?.dispatchEvent(new CustomEvent('group-create', {
                detail: {
                    groupId,
                    groupLabel,
                    nodeIds
                }
            }));
        });
    }

    /**
     * 显示分组名称输入对话框
     */
    private showGroupNameDialog(callback: (name: string | null) => void, defaultValue: string = '分组1'): void {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 20px;
            min-width: 300px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;

        // 标题
        const title = document.createElement('h3');
        title.textContent = '创建分组';
        title.style.cssText = `
            margin: 0 0 15px 0;
            color: var(--text-normal);
            font-size: 16px;
        `;

        // 输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '请输入分组名称';
        input.value = defaultValue;
        input.style.cssText = `
            width: 100%;
            padding: 8px;
            margin-bottom: 15px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            font-size: 14px;
            box-sizing: border-box;
        `;

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        `;

        // 取消按钮
        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.style.cssText = `
            padding: 6px 16px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            cursor: pointer;
            font-size: 14px;
        `;
        cancelButton.addEventListener('click', () => {
            overlay.remove();
            callback(null);
        });

        // 确认按钮
        const confirmButton = document.createElement('button');
        confirmButton.textContent = '确认';
        confirmButton.style.cssText = `
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            background-color: #5b8fd9;
            color: #ffffff;
            cursor: pointer;
            font-size: 14px;
        `;
        confirmButton.addEventListener('click', () => {
            const value = input.value.trim();
            overlay.remove();
            callback(value || null);
        });

        // 组装对话框
        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(confirmButton);
        dialog.appendChild(title);
        dialog.appendChild(input);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 自动聚焦输入框并选中文本
        setTimeout(() => {
            input.focus();
            input.select();
        }, 0);

        // 支持 Enter 键确认
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmButton.click();
            } else if (e.key === 'Escape') {
                cancelButton.click();
            }
        });

        // 点击遮罩层关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                cancelButton.click();
            }
        });
    }

    /**
     * 显示边标签编辑对话框
     */
    private showEdgeLabelDialog(callback: (label: string | null) => void, defaultValue: string = ''): void {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 20px;
            min-width: 300px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;

        // 标题
        const title = document.createElement('h3');
        title.textContent = '编辑关系文本';
        title.style.cssText = `
            margin: 0 0 15px 0;
            color: var(--text-normal);
            font-size: 16px;
        `;

        // 输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '请输入关系描述（可为空）';
        input.value = defaultValue;
        input.style.cssText = `
            width: 100%;
            padding: 8px;
            margin-bottom: 15px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            font-size: 14px;
            box-sizing: border-box;
        `;

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        `;

        // 取消按钮
        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.style.cssText = `
            padding: 6px 16px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            cursor: pointer;
            font-size: 14px;
        `;
        cancelButton.addEventListener('click', () => {
            overlay.remove();
            callback(null);
        });

        // 确认按钮
        const confirmButton = document.createElement('button');
        confirmButton.textContent = '确认';
        confirmButton.style.cssText = `
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            background-color: #5b8fd9;
            color: #ffffff;
            cursor: pointer;
            font-size: 14px;
        `;
        confirmButton.addEventListener('click', () => {
            const value = input.value.trim();
            overlay.remove();
            callback(value);  // 允许空字符串
        });

        // 组装对话框
        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(confirmButton);
        dialog.appendChild(title);
        dialog.appendChild(input);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 自动聚焦输入框并选中文本
        setTimeout(() => {
            input.focus();
            input.select();
        }, 0);

        // 支持 Enter 键确认
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmButton.click();
            } else if (e.key === 'Escape') {
                cancelButton.click();
            }
        });

        // 点击遮罩层关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                cancelButton.click();
            }
        });
    }

    /**
     * 显示内联边标签编辑器
     */
    private showInlineEdgeLabelEditor(edge: any): void {
        if (!this.cy || !this.container) return;

        const data = edge.data();
        const currentLabel = data.label || '';

        // 移除已存在的编辑器
        const existingEditor = this.container.querySelector('.edge-label-editor');
        if (existingEditor) {
            existingEditor.remove();
        }

        // 获取边的中点位置
        const sourceNode = this.cy.$id(data.source);
        const targetNode = this.cy.$id(data.target);
        
        if (!sourceNode.length || !targetNode.length) return;

        const sourcePos = sourceNode.renderedPosition();
        const targetPos = targetNode.renderedPosition();
        const midX = (sourcePos.x + targetPos.x) / 2;
        const midY = (sourcePos.y + targetPos.y) / 2;

        // 创建输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentLabel;
        input.className = 'edge-label-editor';
        input.style.cssText = `
            position: absolute;
            left: ${midX}px;
            top: ${midY}px;
            transform: translate(-50%, -50%);
            padding: 4px 8px;
            border: 2px solid #5b8fd9;
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            font-size: 11px;
            z-index: 1000;
            min-width: 80px;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        `;

        this.container.appendChild(input);

        // 自动聚焦并选中文本
        setTimeout(() => {
            input.focus();
            input.select();
        }, 0);

        // 标记是否已保存，避免重复触发
        let isSaved = false;

        // 保存函数
        const saveLabel = () => {
            if (isSaved) return;  // 避免重复保存
            isSaved = true;
            
            const newLabel = input.value.trim();
            
            if (newLabel !== currentLabel) {
                // 触发边标签编辑事件
                this.container?.dispatchEvent(new CustomEvent('edge-label-edit', {
                    detail: {
                        edgeId: data.id,
                        source: data.originalSource || data.source,
                        target: data.originalTarget || data.target,
                        oldLabel: currentLabel,
                        newLabel: newLabel
                    }
                }));
            }
            
            // 安全地移除输入框
            if (input.parentNode) {
                input.remove();
            }
        };

        // Enter 键保存
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveLabel();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                isSaved = true;  // 标记为已处理
                if (input.parentNode) {
                    input.remove();
                }
            }
        });

        // 失去焦点时保存
        input.addEventListener('blur', () => {
            // 使用 setTimeout 确保在其他事件处理后执行
            setTimeout(() => {
                saveLabel();
            }, 0);
        });

        // 监听图形缩放和平移，更新输入框位置
        const updatePosition = () => {
            if (!this.cy) return;
            
            const sourcePos = sourceNode.renderedPosition();
            const targetPos = targetNode.renderedPosition();
            const midX = (sourcePos.x + targetPos.x) / 2;
            const midY = (sourcePos.y + targetPos.y) / 2;
            
            input.style.left = `${midX}px`;
            input.style.top = `${midY}px`;
        };

        this.cy.on('zoom pan', updatePosition);

        // 输入框移除时清理事件监听
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node === input && this.cy) {
                        this.cy.off('zoom pan', updatePosition);
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(this.container, { childList: true });
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (!this.cy || !this.container) return;

        // 绑定分组创建事件（Command + 拖动）
        this.bindGroupCreationEvents();

        // 节点点击事件
        this.cy.on('tap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 如果是分组节点，不触发普通节点点击事件
            if (data.isGroup) {
                return;
            }

            // 触发自定义事件
            this.container?.dispatchEvent(new CustomEvent('node-click', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent,
                    ctrlKey: originalEvent.ctrlKey,
                    shiftKey: originalEvent.shiftKey,
                    altKey: originalEvent.altKey
                }
            }));
        });

        // 分组节点双击事件（修改分组名）
        this.cy.on('dbltap', 'node[?isGroup]', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            
            this.showGroupNameDialog((newLabel) => {
                if (newLabel && newLabel !== data.label) {
                    // 触发分组重命名事件
                    this.container?.dispatchEvent(new CustomEvent('group-rename', {
                        detail: {
                            groupId: data.id,
                            oldLabel: data.label,
                            newLabel: newLabel
                        }
                    }));
                }
            }, data.label);
        });

        // 分组节点右键菜单事件（删除分组）
        this.cy.on('cxttap', 'node[?isGroup]', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 触发分组右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('group-contextmenu', {
                detail: {
                    groupId: data.id,
                    groupLabel: data.label,
                    event: originalEvent,
                    position: {
                        x: originalEvent.clientX,
                        y: originalEvent.clientY
                    }
                }
            }));
        });

        // 节点悬停事件
        this.cy.on('mouseover', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            this.container?.dispatchEvent(new CustomEvent('node-hover', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent
                }
            }));
        });

        // 节点离开事件
        this.cy.on('mouseout', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            this.container?.dispatchEvent(new CustomEvent('node-leave', {
                detail: {
                    node: data.originalNode
                }
            }));
        });

        // 节点右键菜单事件
        this.cy.on('cxttap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;
            const renderedPosition = node.renderedPosition();

            this.container?.dispatchEvent(new CustomEvent('node-contextmenu', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent,
                    position: {
                        x: renderedPosition.x,
                        y: renderedPosition.y
                    }
                }
            }));
        });

        // 背景点击事件（取消选择）
        this.cy.on('tap', (evt: any) => {
            if (evt.target === this.cy) {
                this.container?.dispatchEvent(new CustomEvent('background-click', {
                    detail: { event: evt.originalEvent }
                }));
            }
        });

        // 背景双击事件（创建自由节点）
        this.cy.on('dbltap', (evt: any) => {
            if (evt.target === this.cy) {
                const position = evt.position;
                this.container?.dispatchEvent(new CustomEvent('background-dblclick', {
                    detail: { 
                        position: { x: position.x, y: position.y },
                        event: evt.originalEvent 
                    }
                }));
            }
        });

        // 节点拖动结束事件
        this.cy.on('dragfree', 'node', (evt: any) => {
            if (!evt || !evt.target) return;
            const node = evt.target;
            const data = node.data();
            
            // 如果是分组节点，不触发位置保存
            if (data.isGroup) return;
            
            const position = node.position();

            // 触发位置变化事件
            this.container?.dispatchEvent(new CustomEvent('node-position-changed', {
                detail: {
                    node: data.originalNode,
                    nodeId: data.id,
                    position: {
                        x: position.x,
                        y: position.y
                    }
                }
            }));
        });

        // 边点击事件（选中边）
        this.cy.on('tap', 'edge', (evt: any) => {
            const edge = evt.target;
            const data = edge.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 触发边点击事件
            this.container?.dispatchEvent(new CustomEvent('edge-click', {
                detail: {
                    edgeId: data.id,
                    source: data.originalSource || data.source,  // 使用原始 ID
                    target: data.originalTarget || data.target,  // 使用原始 ID
                    type: data.type,
                    label: data.label,
                    event: originalEvent
                }
            }));
        });

        // 边双击事件（编辑关系文本）
        this.cy.on('dbltap', 'edge[type="reverse"]', (evt: any) => {
            const edge = evt.target;
            const data = edge.data();

            // 只允许编辑箭头关系的文本
            this.showInlineEdgeLabelEditor(edge);
        });

        // 边右键菜单事件（删除边）
        this.cy.on('cxttap', 'edge', (evt: any) => {
            const edge = evt.target;
            const data = edge.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 触发边右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('edge-contextmenu', {
                detail: {
                    edgeId: data.id,
                    source: data.originalSource || data.source,  // 使用原始 ID
                    target: data.originalTarget || data.target,  // 使用原始 ID
                    type: data.type,
                    label: data.label,
                    event: originalEvent,
                    position: {
                        x: originalEvent.clientX,
                        y: originalEvent.clientY
                    }
                }
            }));
        });
    }

    /**
     * 绑定键盘事件
     */
    private bindKeyboardEvents(): void {
        if (!this.container) return;

        // 监听键盘按下事件
        const handleKeyDown = (event: KeyboardEvent) => {
            // Delete 或 Backspace 键
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (!this.cy) return;

                // 获取选中的元素
                const selected = this.cy.$(':selected');
                
                // 检查是否有选中的分组节点
                const selectedGroups = selected.filter('node[?isGroup]');
                
                if (selectedGroups.length > 0) {
                    // 阻止默认行为（避免浏览器后退）
                    event.preventDefault();
                    event.stopPropagation();
                    
                    // 触发删除分组事件
                    selectedGroups.forEach((groupNode: any) => {
                        const data = groupNode.data();
                        this.container?.dispatchEvent(new CustomEvent('group-delete-key', {
                            detail: {
                                groupId: data.id,
                                groupLabel: data.label
                            }
                        }));
                    });
                }
                
                // 检查是否有选中的箭头关系边
                const selectedReverseEdges = selected.filter('edge[type="reverse"]');
                
                if (selectedReverseEdges.length > 0) {
                    // 阻止默认行为
                    event.preventDefault();
                    event.stopPropagation();
                    
                    // 触发删除边事件
                    selectedReverseEdges.forEach((edge: any) => {
                        const data = edge.data();
                        this.container?.dispatchEvent(new CustomEvent('edge-delete-key', {
                            detail: {
                                edgeId: data.id,
                                source: data.originalSource || data.source,  // 使用原始 ID
                                target: data.originalTarget || data.target,  // 使用原始 ID
                                type: data.type,
                                label: data.label
                            }
                        }));
                    });
                }
            }
        };

        // 添加事件监听器
        this.container.addEventListener('keydown', handleKeyDown);
        
        // 确保容器可以接收键盘事件
        if (!this.container.hasAttribute('tabindex')) {
            this.container.setAttribute('tabindex', '0');
        }
        
        // 当容器获得焦点时，自动聚焦
        this.container.addEventListener('mousedown', () => {
            this.container?.focus();
        });
    }

    /**
     * 判断是否需要重新布局
     */
    private shouldRelayout(changes: GraphChanges): boolean {
        if (!this.currentData) return true;

        const totalChanges = changes.addedNodes.length +
            changes.removedNodes.length +
            changes.addedEdges.length +
            changes.removedEdges.length;

        const currentNodeCount = this.currentData.nodes.length;
        const changeRatio = totalChanges / Math.max(currentNodeCount, 1);

        // 如果变化超过 20%，重新布局
        return changeRatio > 0.2;
    }
}