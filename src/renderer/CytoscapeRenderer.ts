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

        // 添加节点徽章（左上角的 ID）
        this.addNodeBadges();

        // 检查是否有保存的位置
        const hasSavedPositions = data.nodes.some(node => node.savedPosition);
        
        // 运行布局
        if (this.cy) {
            if (hasSavedPositions) {
                // 如果有保存的位置，使用 preset 布局（保持原位置）
                console.log('Using saved positions (preset layout)');
                const layout = this.cy.layout({ name: 'preset' });
                layout.run();
            } else {
                // 如果没有保存的位置，使用指定的布局算法
                console.log('No saved positions, using layout:', options.layoutType);
                const layout = this.cy.layout(this.getLayout(options));
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
            const layout = this.cy.layout(this.getLayout(this.currentOptions || {}));
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
        
        console.log('Converted nodes:', elements.map(e => ({ id: e.data.id, label: e.data.label, badge: e.data.badge, position: e.position })));
        return elements;
    }

    /**
     * 转换边为 Cytoscape 元素
     */
    private convertEdgesToElements(edges: Edge[]): any[] {
        const elements = edges.map(edge => ({
            group: 'edges' as const,
            data: {
                id: this.escapeId(edge.id),
                source: this.escapeId(edge.source),
                target: this.escapeId(edge.target),
                label: edge.label || '',
                type: edge.type
            }
        }));
        
        console.log('Converted edges:', elements.map(e => ({ 
            id: e.data.id, 
            source: e.data.source, 
            target: e.data.target, 
            type: e.data.type,
            label: e.data.label 
        })));
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
        // 分组节点样式
        {
            selector: '.group-node',
            style: {
                'background-color': 'transparent',
                'background-opacity': 0,
                'border-width': '2px',
                'border-color': '#fca5a5',  // 淡红色（原来是 #ef4444）
                'border-style': 'dashed',
                'label': 'data(label)',
                'text-valign': 'top',
                'text-halign': 'center',
                'text-margin-y': -10,
                'font-size': '14px',
                'font-weight': '600',
                'color': '#fca5a5',  // 淡红色文字（原来是 #ef4444）
                'padding': '20px'
            } as any
        },
        // 默认边样式
        {
            selector: 'edge',
            style: {
                'width': 2,
                'line-color': colors.edgeNormal,
                'target-arrow-color': colors.edgeNormal,
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                'control-point-step-size': 40,
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
                'curve-style': 'bezier',
                'control-point-step-size': 40,
                'z-index': 999
            } as any
        },
        // 反向边（虚线）
        {
            selector: 'edge[type="reverse"]',
            style: {
                'curve-style': 'bezier',
                'control-point-step-size': 80,
                'line-style': 'dashed',
                'line-dash-pattern': [6, 4],
                'line-color': colors.edgeReverse,
                'target-arrow-color': colors.edgeReverse,
                'width': 2,
                'arrow-scale': 1.1,
                'opacity': 0.85,
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
                background-color: #5b8fd9;
                color: #ffffff;
                font-size: 10px;
                font-weight: 600;
                padding: 2px 6px;
                border-radius: 4px;
                border: 1px solid #3d5a80;
                white-space: nowrap;
                pointer-events: auto;
                cursor: pointer;
            `;
            badgeContainer.appendChild(badgeEl);

            // 更新徽章位置的函数
            const updateBadgePosition = () => {
                const pos = node.renderedPosition();
                const zoom = this.cy!.zoom();
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
            const position = node.position();
            const data = node.data();

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
                    source: data.source,
                    target: data.target,
                    type: data.type,
                    label: data.label,
                    event: originalEvent
                }
            }));
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
                    source: data.source,
                    target: data.target,
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