import * as cytoscapeNamespace from 'cytoscape';
import * as dagreNamespace from 'cytoscape-dagre';
import * as coseBilkentNamespace from 'cytoscape-cose-bilkent';
import { IGraphRenderer, GraphData, RenderOptions, GraphChanges, ViewState, Edge } from './types';
import { ZKNode } from 'src/view/indexView';
import { Component, MarkdownRenderer, Notice } from 'obsidian';

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

/**
 * 自然比较 Luhmann ID
 * 例如: "a.11" > "a.9", "a.2.1" > "a.1.9"
 */
function compareIds(id1: string, id2: string): number {
    const parts1 = id1.split('.');
    const parts2 = id2.split('.');

    // 取两个数组长度的最大值，确保每一层都能比到
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
        const p1 = parts1[i];
        const p2 = parts2[i];

        // 情况 1：id2 已经没有这一层级了（如 1.a.1 vs 1.a）
        // 默认短的更小
        if (p1 !== undefined && p2 === undefined) return 1;
        if (p1 === undefined && p2 !== undefined) return -1;

        // 情况 2：两个部分都有值，进行对比
        // 使用 localeCompare 开启 numeric 模式，可以自动处理 '10' > '2' 的逻辑
        const cmp = p1.localeCompare(p2, undefined, { numeric: true, sensitivity: 'base' });

        if (cmp !== 0) {
            return cmp > 0 ? 1 : -1;
        }
    }

    return 0;
}

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
    private batchSelectedNodeIds: string[] = []; // 保存批量选中的节点ID
    private batchSelectedNodes: any[] = []; // 保存批量选中的完整节点数据（包含 isCrossDomain 等信息）
    private isMetaPressed = false; // 标记 Command 键是否被按下（框选模式）
    private embedPreviewCleanup: (() => void) | null = null;
    private collapseHandleCleanup: (() => void) | null = null;
    private collapsedNodeIds: Set<string> = new Set();

    // SimpleMind 风格布局常量
    private readonly VERTICAL_GAP = 80;       // 垂直间距
    private readonly HORIZONTAL_GAP = 200;    // 水平间距
    private readonly SIBLING_GAP = 100;       // 兄弟节点间距

    /**
     * 渲染图形
     * @性能优化：支持增量更新，避免每次都销毁重建
     */
    async render(container: HTMLElement, data: GraphData, options: RenderOptions): Promise<void> {
        // 确保扩展已注册
        registerExtensions();

        const containerChanged = this.container !== container;
        const previousOptions = this.currentOptions;

        this.container = container;
        this.currentData = data;
        this.currentOptions = options;

        // 转换元素（包含分组）
        const elements = this.convertToElementsWithGroups(data);

        // 如果没有 Cytoscape 实例或容器变化，需要完全重建
        if (!this.cy || containerChanged) {
            // 销毁旧实例（如果存在）
            if (this.cy) {
                this.cy.destroy();
                this.cy = null;
            }

            // 获取 cytoscape 函数
            const cytoscape = getCytoscape();

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
                // 关闭拖拽纹理缓存，避免画布拖动时出现半透明色块伪影
                textureOnViewport: false,
                motionBlur: false,
                pixelRatio: 'auto',
                // 启用节点拖动
                autoungrabify: false,
                // 启用原生缩放和平移
                userZoomingEnabled: true,   // 启用滚轮/双指缩放
                userPanningEnabled: true,   // 启用原生拖动画布
                // 默认禁用框选，需要按 Command 键才启用
                boxSelectionEnabled: false,
                // 设置缩放范围
                minZoom: 0.1,
                maxZoom: 1.0
            });

            // 绑定事件
            this.bindEvents();
            this.bindKeyboardEvents();
            this.initBoxSelection();
            this.addNodeBadges();

        } else {
            // 复用实例时也要刷新样式，确保主题/风格切换即时生效
            const shouldRefreshStyle =
                !previousOptions ||
                previousOptions.themeMode !== options.themeMode ||
                previousOptions.themeStyle !== options.themeStyle ||
                previousOptions.edgeStyle !== options.edgeStyle;
            if (shouldRefreshStyle) {
                this.cy.style([
                    ...this.getStylesheet(options),
                    {
                        selector: 'core',
                        style: {
                            'background-color': 'transparent',
                            'background-opacity': 0
                        } as any
                    }
                ]);
            }

            // 增量更新：复用现有 Cytoscape 实例
            this.cy.batch(() => {
                // 先删除所有占位符节点（因为它们不在传入的数据中）
                const placeholderNodes = this.cy!.nodes().filter((node: any) => node.data('isPlaceholder'));
                if (placeholderNodes.length > 0) {
                    console.log('[CytoscapeRenderer] 增量更新前删除占位符节点', placeholderNodes.length);
                    this.cy!.remove(placeholderNodes);
                }

                // 清理所有占位符连接线
                const connectionLines = this.container?.querySelectorAll('.placeholder-connection-line');
                if (connectionLines && connectionLines.length > 0) {
                    console.log('[CytoscapeRenderer] 增量更新前清理占位符连接线', connectionLines.length);
                    connectionLines.forEach(line => {
                        if (line.parentNode) {
                            line.parentNode.removeChild(line);
                        }
                    });
                }

                // 清理占位符节点的编辑框和链接建议器
                const editor = this.container?.querySelector('.node-label-editor');
                if (editor) {
                    console.log('[CytoscapeRenderer] 增量更新前清理编辑框图层');
                    editor.remove();
                }

                const suggester = this.container?.querySelector('.node-link-suggester');
                if (suggester) {
                    console.log('[CytoscapeRenderer] 增量更新前清理链接建议器');
                    suggester.remove();
                }

                // 获取当前所有节点和边的 ID
                const currentIds = new Set(this.cy!.elements().map(ele => ele.id()));
                const newIds = new Set(elements.map(ele => ele.data.id || ''));

                // 找出需要删除的元素
                const toRemove: string[] = [];
                currentIds.forEach(id => {
                    if (!newIds.has(id)) {
                        toRemove.push(id);
                    }
                });

                // 找出需要添加的元素
                const toAdd = elements.filter(ele => {
                    const id = ele.data.id;
                    return id && !currentIds.has(id);
                });

                // 删除旧元素（使用 filter 避免选择器语法问题）
                if (toRemove.length > 0) {
                    // 检查是否删除了分组节点，如果是，先释放子节点
                    toRemove.forEach(id => {
                        const ele = this.cy!.$id(id);
                        if (ele.length > 0 && ele.data('isGroup')) {
                            // 这是一个分组节点，需要先释放其子节点
                            const childNodes = this.cy!.nodes(`[parent="${id}"]`);
                            // 将子节点的 parent 设为 null，使其成为独立节点
                            childNodes.forEach((child: any) => {
                                child.move({ parent: null });
                            });
                        }
                    });

                    const elementsToRemove = this.cy!.elements().filter(ele => toRemove.includes(ele.id()));
                    this.cy!.remove(elementsToRemove);
                }

                // 添加新元素
                if (toAdd.length > 0) {
                    this.cy!.add(toAdd);
                }

                // 更新现有元素的数据（包括 parent 属性）
                elements.forEach(ele => {
                    const id = ele.data.id;
                    if (id) {
                        const existing = this.cy!.$id(id);
                        if (existing.length > 0) {
                            // 更新节点数据
                            existing.data(ele.data);

                            // 特殊处理 parent 属性，确保分组关系正确更新
                            if (ele.group === 'nodes' && 'parent' in ele.data) {
                                const newParent = ele.data.parent;
                                const currentParent = existing.data('parent');

                                // 如果 parent 发生变化，需要使用 move() 方法更新
                                if (newParent !== currentParent) {
                                    existing.move({
                                        parent: newParent || null
                                    });
                                }
                            }
                        }
                    }
                });
            });
        }

        // 更新节点徽章（无论初始化还是增量更新都需要更新）
        // 这确保已删除节点的徽章也被移除
        this.addNodeBadges();
        this.addEmbedNodePreviews();

        // 检查是否有保存的位置
        const hasSavedPositions = data.nodes.some(node => node.savedPosition);

        // 运行布局
        if (this.cy) {
            if (hasSavedPositions) {
                // 如果有保存的位置，使用 preset 布局（保持原位置）
                this.runLayoutSafely({ name: 'preset' });
            } else {
                // 检查是否是入链出链图，并设置初始位置
                this.setInOutLinksInitialPositions(data);

                // 如果没有保存位置，根据 layoutType 选择布局算法
                // 默认使用 preset（索引视图等已有位置信息的情况）
                // 局部关系视图的出入链图会传入 'cose' 等布局类型来自动分散节点
                const layoutConfig = this.getLayoutConfig(options);
                this.runLayoutSafely(layoutConfig);
            }
        }
        this.applyCollapsedState();
    }

    /**
     * 安全运行布局：
     * - 主要用于规避少数数据情况下 cose/cose-bilkent 内部报错导致整图不可用
     * - 首次布局失败时自动回退到 breadthfirst
     */
    private runLayoutSafely(layoutConfig: any): void {
        if (!this.cy) return;

        // 空图/单节点图不跑复杂布局，避免布局器内部边界计算异常
        const nodeCount = this.cy.nodes().length;
        if (nodeCount <= 1) {
            this.cy.layout({ name: 'preset' }).run();
            return;
        }

        try {
            const layout = this.cy.layout(layoutConfig);
            layout.run();
        } catch (error) {
            console.error('[CytoscapeRenderer] layout run failed, fallback to breadthfirst', {
                layout: layoutConfig?.name,
                error
            });
            try {
                const fallbackGrid = this.cy.layout({
                    name: 'grid',
                    fit: true,
                    padding: 40
                });
                fallbackGrid.run();
            } catch (fallbackError) {
                console.error('[CytoscapeRenderer] grid fallback failed, fallback to preset', fallbackError);
                try {
                    this.cy.layout({ name: 'preset' }).run();
                } catch (presetError) {
                    console.error('[CytoscapeRenderer] preset fallback failed', presetError);
                }
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
                // 检查是否删除了分组节点，如果是，先释放子节点
                changes.removedNodes.forEach(node => {
                    const nodeId = this.escapeId(node.ID);
                    const ele = this.cy!.$id(nodeId);

                    if (ele.length > 0 && ele.data('isGroup')) {
                        // 这是一个分组节点，需要先释放其子节点
                        const childNodes = this.cy!.nodes(`[parent="${nodeId}"]`);

                        // 将子节点的 parent 设为 null，使其成为独立节点
                        childNodes.forEach((child: any) => {
                            child.move({ parent: null });
                        });
                    }
                });

                // 现在可以安全地删除节点
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
        if (this.embedPreviewCleanup) {
            this.embedPreviewCleanup();
            this.embedPreviewCleanup = null;
        }
        if (this.collapseHandleCleanup) {
            this.collapseHandleCleanup();
            this.collapseHandleCleanup = null;
        }
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
            
            // 限制最大缩放级别，避免单个节点时过度放大
            const currentZoom = this.cy.zoom();
            const maxZoom = 2.0;  // 最大缩放级别，降低此值可让节点显示更小
            
            if (currentZoom > maxZoom) {
                this.cy.zoom(maxZoom);
            }
            
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
                    isGroup: true,
                    nodeIds: group.nodeIds || []  // 添加节点 ID 列表
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

        // 获取节点颜色映射
        const nodeColors = this.currentData?.metadata.nodeColors || {};
        const nodeRemarks = this.currentData?.metadata.nodeRemarks || {};
        const vividStyleMap = this.buildVividNodeStyleMap(nodes);
        const parentLinkedNodeIds = new Set<string>();
        (this.currentData?.edges || []).forEach((edge) => {
            if (edge.type !== 'parent') return;
            parentLinkedNodeIds.add(edge.source);
            parentLinkedNodeIds.add(edge.target);
        });

        const elements = nodes.map(node => {
            const vividStyle = vividStyleMap.get(node.IDStr);
            const hasParentChildLink = parentLinkedNodeIds.has(node.ID) || parentLinkedNodeIds.has(node.IDStr);
            const element: any = {
                group: 'nodes' as const,
                data: {
                    id: this.escapeId(node.ID),
                    label: this.getNodeLabel(node, this.currentOptions),
                    badge: this.getNodeBadge(node, this.currentOptions),
                    title: node.title,
                    filePath: node.file?.path || '',  // 纯文字节点 file 为 null
                    displayText: node.displayText,
                    position: node.position,
                    isCurrentFile: node.file?.path === currentFilePath,  // 纯文字节点不匹配
                    originalNode: node,
                    isRoot: node.isRoot || false,  // 根节点标记
                    customColor: nodeColors[node.IDStr] || null,  // 添加自定义颜色
                    isCrossDomain: node.isCrossDomain || false,  // 传递跨领域节点标记
                    isTextOnly: node.isTextOnly || false,  // 传递纯文字节点标记
                    isStandaloneText: (node.isTextOnly || false) && !hasParentChildLink, // 无父子关系的文本节点
                    isEmbed: node.isEmbed || false,  // 嵌入节点标记（![[...]]）
                    isFreeNode: (node.ID || '').startsWith('free.'),
                    remark: nodeRemarks[node.IDStr] || nodeRemarks[node.ID] || '',
                    hasRemark: !!(nodeRemarks[node.IDStr] || nodeRemarks[node.ID]),
                    hasFileIcon: (!node.isTextOnly && node.file) ? true : false, // 文件节点显示图标
                    branchNodeBackground: vividStyle?.background || null,
                    branchNodeBorder: vividStyle?.border || null
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
        const edgeColorMap = this.buildVividEdgeColorMap();
        const allNodes = this.currentData?.nodes || [];
        const nodeById = new Map<string, ZKNode>();
        allNodes.forEach((n) => {
            nodeById.set(n.ID, n);
            nodeById.set(n.IDStr, n);
        });
        const nodeStyleMap = this.buildVividNodeStyleMap(allNodes);
        const elements = edges.map(edge => {
            const sourceNode = nodeById.get(edge.source);
            const targetNode = nodeById.get(edge.target);
            const sourceLevel = sourceNode?.IDStr ? sourceNode.IDStr.split('.').length : 0;
            const targetLevel = targetNode?.IDStr ? targetNode.IDStr.split('.').length : 0;
            const isRootToFirstLevel =
                !!sourceNode &&
                !!targetNode &&
                sourceLevel === 1 &&
                targetLevel === 2 &&
                targetNode.IDStr.startsWith(`${sourceNode.IDStr}.`);

            let branchEdgeColor = edgeColorMap.get(edge.source) || null;
            if (isRootToFirstLevel && targetNode) {
                branchEdgeColor = nodeStyleMap.get(targetNode.IDStr)?.border || branchEdgeColor;
            }
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
                    originalTarget: edge.target,
                    branchEdgeColor,
                    isRootToFirstLevel
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

    private isVividThemeStyle(): boolean {
        return (this.currentOptions?.themeStyle || 'default') === 'vivid';
    }

    private getTopBranchId(nodeId: string): string {
        const parts = (nodeId || '').split('.').filter(Boolean);
        if (parts.length <= 1) return nodeId;
        return `${parts[0]}.${parts[1]}`;
    }

    private buildVividNodeStyleMap(nodes: ZKNode[]): Map<string, { background: string; border: string }> {
        const styleMap = new Map<string, { background: string; border: string }>();
        if (!this.isVividThemeStyle()) return styleMap;

        const branchIds = Array.from(
            new Set(
                nodes
                    .filter((node) => !node.isRoot)
                    .map((node) => this.getTopBranchId(node.IDStr))
                    .filter(Boolean)
            )
        ).sort(compareIds);

        const isLight = this.currentOptions?.themeMode === 'light';
        const branchColorById = new Map<string, { background: string; border: string }>();
        const styleColorMap = (this.currentData?.metadata as any)?.nodeStyleColors || {};
        const palette = this.getBranchStylePalette();

        branchIds.forEach((branchId) => {
            const storedColor = this.normalizeHexColor(styleColorMap[branchId]);
            const baseColor = storedColor || palette[this.hashString(branchId) % palette.length];
            const border = this.softenColor(baseColor, isLight);
            const background = isLight
                ? this.hexToRgba(border, 0.08)
                : this.hexToRgba(border, 0.12);
            branchColorById.set(branchId, { background, border });
        });

        nodes.forEach((node) => {
            if (node.isRoot) return;
            const branchId = this.getTopBranchId(node.IDStr);
            const style = branchColorById.get(branchId);
            if (style) styleMap.set(node.IDStr, style);
        });

        return styleMap;
    }

    private buildVividEdgeColorMap(): Map<string, string> {
        const colorMap = new Map<string, string>();
        if (!this.isVividThemeStyle() || !this.currentData?.nodes) return colorMap;

        const nodeStyleMap = this.buildVividNodeStyleMap(this.currentData.nodes);
        this.currentData.nodes.forEach((node) => {
            const style = nodeStyleMap.get(node.IDStr);
            if (style) colorMap.set(node.IDStr, style.border);
        });
        return colorMap;
    }

    private getBranchStylePalette(): string[] {
        return [
            '#ff5a5f',
            '#d9793a',
            '#c8a746',
            '#56d364',
            '#38d9a9',
            '#4dabf7',
            '#9775fa',
            '#f06595',
            '#3fb18f',
            '#5b8fd9',
            '#7d6ccf',
            '#b86fb0',
            '#c96a6a',
            '#b8974f'
        ];
    }

    private hashString(value: string): number {
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
            hash = ((hash << 5) - hash) + value.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    private normalizeHexColor(color: string | null | undefined): string | null {
        if (!color || typeof color !== 'string') return null;
        const trimmed = color.trim();
        const isHex3 = /^#([0-9a-fA-F]{3})$/.test(trimmed);
        const isHex6 = /^#([0-9a-fA-F]{6})$/.test(trimmed);
        if (!isHex3 && !isHex6) return null;
        if (isHex6) return trimmed.toLowerCase();
        const [, shortHex] = trimmed.match(/^#([0-9a-fA-F]{3})$/)!;
        return `#${shortHex.split('').map((c) => c + c).join('').toLowerCase()}`;
    }

    private hexToRgba(hex: string, alpha: number): string {
        const normalized = this.normalizeHexColor(hex) || '#5b8fd9';
        const r = parseInt(normalized.slice(1, 3), 16);
        const g = parseInt(normalized.slice(3, 5), 16);
        const b = parseInt(normalized.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    private softenColor(hex: string, isLight: boolean): string {
        const normalized = this.normalizeHexColor(hex) || '#5b8fd9';
        const r = parseInt(normalized.slice(1, 3), 16);
        const g = parseInt(normalized.slice(3, 5), 16);
        const b = parseInt(normalized.slice(5, 7), 16);

        // 保持色相，降低亮度与对比度
        const target = isLight ? 98 : 132;
        const ratio = isLight ? 0.54 : 0.50;
        const sr = Math.round(r * (1 - ratio) + target * ratio);
        const sg = Math.round(g * (1 - ratio) + target * ratio);
        const sb = Math.round(b * (1 - ratio) + target * ratio);

        return `#${sr.toString(16).padStart(2, '0')}${sg.toString(16).padStart(2, '0')}${sb.toString(16).padStart(2, '0')}`;
    }

    /**
     * 获取节点标签
     */
    private getNodeLabel(node: ZKNode, options: RenderOptions | null): string {
        const nodeText = options?.nodeText || 'both';
        const showNoteId = options?.showNoteId ?? true;

        let label = '';
        switch (nodeText) {
            case 'id':
                label = showNoteId ? node.ID : (node.title || node.displayText);
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
                label = showNoteId ? node.displayText : (node.title || node.displayText);
                break;
        }

        // 处理显示文本：去掉时间戳前缀
        label = this.processDisplayText(label, nodeText, showNoteId);
        label = label.replace(/\\n/g, '\n');

        // 文件图标通过 HTML 叠加层显示，不在这里添加

        return label;
    }

    /**
     * 获取节点徽章（左上角显示的 ID）
     */
    private getNodeBadge(node: ZKNode, options: RenderOptions | null): string {
        const nodeText = options?.nodeText || 'both';
        const showNoteId = options?.showNoteId ?? true;

        if (!showNoteId) {
            return '';
        }
        
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
    private processDisplayText(text: string, nodeText: string, showNoteId: boolean): string {
        if (!showNoteId) {
            return text
                .replace(/^[a-zA-Z0-9._]+:\s*/, '')
                .replace(/^\d+\s+/, '');
        }

        if (nodeText === 'id-title') {
            // id-title 模式：去掉 "ID: " 前缀和时间戳
            // 例如：1: 20251215 nihao -> nihao
            // 或者：a.1: 20251215 薛定谔方程 -> 薛定谔方程
            return text
                .replace(/^[a-zA-Z0-9._]+:\s*/, '')  // 去掉 "ID: " 前缀
                .replace(/^\d+\s+/, '');  // 去掉开头的任意数字和空格
        } else if (nodeText === 'title' || nodeText === 'both') {
            // title 或 both 模式：去掉开头的时间戳
            // 例如：20251215 薛定谔方程 -> 薛定谔方程
            return text.replace(/^\d+\s+/, "");
        }
        
        return text;
    }

    /**
     * 转义 ID 中的特殊字符
     */
    private escapeId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    /**
     * 设置入链出链图的初始位置
     * 入链节点在中心节点上方，出链节点在下方
     */
    private setInOutLinksInitialPositions(data: GraphData): void {
        const cy = this.cy;
        if (!cy) return;

        // 检查是否有入链或出链节点
        const hasInOutLinks = data.nodes.some(node =>
            node.ID.startsWith('inlink-') || node.ID.startsWith('outlink-') || node.ID === 'current'
        );

        if (!hasInOutLinks) return;

        // 找到中心节点
        const centerNodeId = this.escapeId('current');
        const centerNode = cy.$id(centerNodeId);

        if (centerNode.length === 0) return;

        // 将中心节点放在原点
        centerNode.position({ x: 0, y: 0 });

        // 分离入链和出链节点
        const inlinks: any[] = [];
        const outlinks: any[] = [];

        data.nodes.forEach(node => {
            if (node.ID.startsWith('inlink-')) {
                inlinks.push(cy.$id(this.escapeId(node.ID)));
            } else if (node.ID.startsWith('outlink-')) {
                outlinks.push(cy.$id(this.escapeId(node.ID)));
            }
        });

        // 为入链节点设置初始位置（在中心上方）
        const inlinkSpacing = 150;
        const inlinkStartY = -150;
        inlinks.forEach((node, index) => {
            // 水平分散，垂直固定在上方
            const x = (index - (inlinks.length - 1) / 2) * inlinkSpacing;
            node.position({ x, y: inlinkStartY });
        });

        // 为出链节点设置初始位置（在中心下方）
        const outlinkSpacing = 150;
        const outlinkStartY = 150;
        outlinks.forEach((node, index) => {
            // 水平分散，垂直固定在下方
            const x = (index - (outlinks.length - 1) / 2) * outlinkSpacing;
            node.position({ x, y: outlinkStartY });
        });
    }

    /**
     * 根据 layoutType 获取布局配置
     * 用于局部关系视图的出入链图等需要自动布局的场景
     */
    private getLayoutConfig(options: RenderOptions): any {
        const layoutType = options.layoutType || 'preset';

        // 默认使用 preset 布局（索引视图等已有位置信息的情况）
        if (layoutType === 'preset') {
            return { name: 'preset' };
        }

        // 根据方向设置布局方向
        const rankDir = this.directionToRankDir(options.direction || 'TB');

        switch (layoutType) {
            case 'dagre':
                // dagre 层级布局，适合家族树结构
                return {
                    name: 'dagre',
                    rankDir: rankDir,
                    nodeSep: 50,
                    rankSep: 100,
                    edgeSep: 10
                };

            case 'cose':
                // cose 力导向布局，适合入链出链图
                return {
                    name: 'cose',
                    // 节点间距
                    nodeRepulsion: 100000,
                    // 理想边长
                    idealEdgeLength: 100,
                    // 边弹性
                    edgeElasticity: 100,
                    // 布局迭代次数
                    nestingFactor: 5,
                    // 初始布局时的温度
                    initialTemp: 200,
                    // 冷却因子
                    coolingFactor: 0.95,
                    // 最小温度
                    minTemp: 1.0
                };

            case 'cose-bilkent':
                // cose-bilkent 力导向布局，适合复杂的网络结构
                return {
                    name: 'cose-bilkent',
                    // 布局质量
                    quality: 'proof',
                    // 是否为有向图
                    directed: false,
                    // 节点间距
                    nodeRepulsion: 4500,
                    // 理想边长
                    idealEdgeLength: 50,
                    // 边弹性
                    edgeElasticity: 0.45
                };

            case 'breadthfirst':
                return {
                    name: 'breadthfirst',
                    directed: false,
                    spacingFactor: 1.5
                };

            case 'grid':
                return {
                    name: 'grid'
                };

            default:
                return { name: 'preset' };
        }
    }

    /**
     * 将方向字符串转换为 dagre 的 rankDir 格式
     */
    private directionToRankDir(direction: string): string {
        switch (direction) {
            case 'TB': return 'TB'; // Top to Bottom
            case 'BT': return 'BT'; // Bottom to Top
            case 'LR': return 'LR'; // Left to Right
            case 'RL': return 'RL'; // Right to Left
            default: return 'TB';
        }
    }

    private getStylesheet(options: RenderOptions): any[] {
    const isLight = options.themeMode === 'light';
    const isVivid = (options.themeStyle || 'default') === 'vivid';
    const edgeStyle = options.edgeStyle || 'bezier';

    const colors = isLight ? {
        // 浅色主题颜色
        nodeBackground: '#f0f0f0',
        nodeBackgroundHover: '#e0e0e0',
        nodeBackgroundSelected: '#d0d0d0',
        nodeBorder: '#b0b0b0',
        nodeBorderSelected: '#0066cc',
        nodeText: '#333333',
        nodeTextMuted: '#666666',
        edgeNormal: '#999999',
        edgeForward: '#60a5fa',  // 淡蓝色
        edgeReverse: '#dc2626',
        edgeSelected: '#7c3aed',
        textBackground: '#ffffff',
        overlayColor: '#60a5fa',
        badgeBackground: '#60a5fa',
        badgeText: '#ffffff'
    } : {
        // 深色主题颜色（保持原有颜色）
        nodeBackground: '#1a2332',
        nodeBackgroundHover: '#243447',
        nodeBackgroundSelected: '#2d4a6b',
        nodeBorder: '#3d5a80',
        nodeBorderSelected: '#5b8fd9',
        nodeText: '#ffffff',
        nodeTextMuted: '#94a3b8',
        edgeNormal: '#4a5568',
        edgeForward: '#5b8fd9',
        edgeReverse: '#ef4444',
        edgeSelected: '#7c3aed',
        textBackground: '#0f172a',
        overlayColor: '#5b8fd9',
        badgeBackground: '#5b8fd9',
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
                'background-color': (ele: any) => {
                    if (isVivid && ele.data('branchNodeBackground') && !ele.data('isRoot')) {
                        return ele.data('branchNodeBackground');
                    }
                    return colors.nodeBackground;
                },
                'color': colors.nodeText,
                'font-size': '14px',
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
                    const baseHeight = 50 * 2 / 3;  // 改为原来的 2/3
                    const lineHeight = 18 * 2 / 3;  // 改为原来的 2/3
                    const maxWidth = 200;
                    const charWidth = 8;
                    const padding = 24 * 2 / 3;  // 改为原来的 2/3

                    const estimatedLines = Math.ceil((label.length * charWidth) / maxWidth);
                    const textHeight = estimatedLines * lineHeight;
                    return Math.max(baseHeight, textHeight + padding);
                },
                'padding': '20px',
                'shape': 'round-rectangle',
                'corner-radius': '18px',
                'border-width': '2px',
                'border-color': (ele: any) => {
                    // 如果有自定义颜色，使用自定义颜色
                    const customColor = ele.data('customColor');
                    if (customColor) return customColor;
                    if (isVivid && ele.data('branchNodeBorder') && !ele.data('isRoot')) {
                        return ele.data('branchNodeBorder');
                    }
                    return colors.nodeBorder;
                },
                'transition-property': 'background-color, border-color',
                'transition-duration': '0.2s'
            } as any
        },
        // 嵌入节点：由 HTML 预览卡片承载内容，隐藏 Cytoscape 默认卡片外观
        {
            selector: 'node[?isEmbed]',
            style: {
                'label': '',
                'background-opacity': 0,
                'border-width': 0
            } as any
        },
        // 自由文本节点（无父子关系）：纯文本样式（透明边框与背景）
        {
            selector: 'node[?isStandaloneText]',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'shape': 'round-rectangle',
                'padding': '0px',
                'text-max-width': '320px'
            } as any
        },
        // 根节点样式：尺寸放大 2 倍，边框加粗
        {
            selector: 'node[?isRoot]',
            style: {
                'background-color': '#66c7ff',
                'border-color': '#8dd8ff',
                'font-size': '26px',
                'font-weight': 'bold',
                'text-max-width': '400px',
                'width': (ele: any) => {
                    const label = ele.data('label') || '';
                    const baseWidth = 80;
                    const charWidth = 8;
                    const maxWidth = 220;
                    const padding = 32;
                    const textWidth = Math.min(label.length * charWidth, maxWidth);
                    const normalWidth = Math.max(baseWidth, textWidth + padding);
                    return normalWidth * 2;
                },
                'height': (ele: any) => {
                    const label = ele.data('label') || '';
                    const baseHeight = 50 * 2 / 3;
                    const lineHeight = 18 * 2 / 3;
                    const maxWidth = 200;
                    const charWidth = 8;
                    const padding = 24 * 2 / 3;
                    const estimatedLines = Math.ceil((label.length * charWidth) / maxWidth);
                    const textHeight = estimatedLines * lineHeight;
                    const normalHeight = Math.max(baseHeight, textHeight + padding);
                    return normalHeight * 2;
                },
                'border-width': '4px'
            } as any
        },
        {
            selector: 'node[?isRoot]:selected',
            style: {
                'background-color': '#66c7ff',
                'border-color': '#8dd8ff',
                'border-width': '4px',
                'color': '#ffffff'
            } as any
        },
        // 节点徽章样式已通过 HTML 叠加层实现，这里不需要额外样式
        // 分组节点样式 - 容器化设计
        {
            selector: '.group-node',
            style: {
                'background-color':  isLight ? 'rgba(203, 213, 225, 0.3)' : 'rgba(30, 41, 59, 0.2)',  // 半透明深色背景
                'background-opacity': 1,
                'border-width': '0px',
                'shape': 'round-rectangle',
                'label': 'data(label)',
                'text-valign': 'top',
                'text-halign': 'center',
                'text-margin-y': -10,
                'font-size': '14px',
                'font-weight': '600',
                'color': isLight ?  '#94a3b8' : '#666666' ,
                'padding': '20px'
            } as any
        },
        // 占位符节点样式 - 虚线边框，半透明
        {
            selector: 'node[?isPlaceholder]',
            style: {
                'opacity': 0.7,
                'border-style': 'dashed',
                'border-width': '2px',
                'border-color': colors.nodeBorderSelected,
                'background-color': colors.nodeBackground
            } as any
        },
        // 占位符节点选中状态 - 更明显的视觉反馈
        {
            selector: 'node[?isPlaceholder]:selected',
            style: {
                'opacity': 1,
                'border-style': 'dashed',
                'border-width': '3px',
                'border-color': colors.nodeBorderSelected,
                'background-color': colors.nodeBackgroundSelected,
                'overlay-color': colors.nodeBorderSelected,
                'overlay-padding': '4px',
                'overlay-opacity': 0.3
            } as any
        },
        // 文件节点样式 - 使用多个背景图在右上角显示文件图标
        {
            selector: 'node[?hasFileIcon]',
            style: {
                // 第二个背景图：文件图标（右上角）
                'background-width': ['100%', '16px'],
                'background-height': ['100%', '16px'],
                'background-fit': ['cover', 'none'],
                'background-clip': ['node', 'none'],
                'background-position-x': ['50%', '100%'],
                'background-position-y': ['50%', '0%'],
                'background-image': ['none', 'url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' viewBox=\'0 0 16 16\'%3E%3Cpath fill=\'%235b8fd9\' d=\'M14 4H6.5L3 8.5V14h11V4zm-1 9H4V9h1.5l1-1H6v4h7V5z\'/%3E%3C/svg%3E")']
            } as any
        },
        // 折叠隐藏的子节点/连线
        {
            selector: 'node.zk-collapsed-hidden',
            style: {
                'display': 'none'
            } as any
        },
        {
            selector: 'edge.zk-collapsed-hidden',
            style: {
                'display': 'none'
            } as any
        },
        // 默认边样式 - 使用 unbundled-bezier 支持自定义控制点
        {
            selector: 'edge',
            style: {
                'width': (ele: any) => {
                    if (ele.data('isRootToFirstLevel')) {
                        return 6;
                    }
                    return 2;
                },
                'line-color': (ele: any) => {
                    if (isVivid && ele.data('branchEdgeColor')) {
                        return ele.data('branchEdgeColor');
                    }
                    return colors.edgeNormal;
                },
                'target-arrow-color': (ele: any) => {
                    if (isVivid && ele.data('branchEdgeColor')) {
                        return ele.data('branchEdgeColor');
                    }
                    return colors.edgeNormal;
                },
                'target-arrow-shape': 'triangle',
                'curve-style': edgeStyle === 'straight'
                    ? 'straight'
                    : (edgeStyle === 'polyline' ? 'taxi' : 'unbundled-bezier'),
                'taxi-direction': 'auto',
                'taxi-turn': 40,
                'control-point-distances': (ele: any) => {
                    if (edgeStyle !== 'bezier') return 0;
                    const distance = ele.data('controlPointDistance');
                    // 贝塞尔模式下给一个非零默认弯曲量，避免视觉上仍是直线
                    return distance !== undefined ? distance : 60;
                },
                'control-point-weights': (ele: any) => {
                    if (edgeStyle !== 'bezier') return 0.5;
                    const weight = ele.data('controlPointWeight');
                    return weight !== undefined ? weight : 0.5;
                },
                'arrow-scale': 1.5,
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
        // 跨领域边（虚线连接 + 特殊样式）
        {
            selector: 'edge[type="cross-domain"]',
            style: {
                'line-style': 'dashed',
                'line-dash-pattern': [8, 4],  // 虚线模式
                'line-color': '#8b5cf6',  // 紫色（跨领域标识）
                'target-arrow-color': '#8b5cf6',
                'width': 2,
                'arrow-scale': 1.2,
                'opacity': 0.7,
                'label': 'data(label)',
                'font-size': '10px',
                'color': '#8b5cf6',
                'text-background-color': '#f3e8ff',
                'text-background-opacity': 1,
                'text-background-padding': '3px',
                'text-background-shape': 'roundrectangle',
                'z-index': 998
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
        // 自由节点：非选中态边框透明
        {
            selector: 'node[?isFreeNode]:unselected',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'border-color': 'transparent'
            } as any
        },
        // 自由节点选中态：与普通节点保持一致（覆盖 isStandaloneText 选中样式）
        {
            selector: 'node[?isFreeNode]:selected',
            style: {
                'background-opacity': 1,
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
                'background-color': '#66c7ff',
                'border-color': '#8dd8ff',
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
        },
        // 高亮子节点箭头
        {
            selector: 'edge.child-edge-highlight',
            style: {
                'line-color': '#a78b71',
                'target-arrow-color': '#a78b71',
                'width': 2.5,
                'opacity': 0.8,
                'z-index': 1000
            } as any
        }
    ];
}

    /**
     * 为 ![[...]] 节点添加常驻预览卡片（类似 Canvas 笔记卡）
     */
    private addEmbedNodePreviews(): void {
        if (!this.cy || !this.container) return;

        if (this.embedPreviewCleanup) {
            this.embedPreviewCleanup();
            this.embedPreviewCleanup = null;
        }

        const embedNodes = this.cy.nodes('[?isEmbed]');
        if (embedNodes.length === 0) return;

        const app = (window as any).app;
        if (!app) return;

        const previewContainer = document.createElement('div');
        previewContainer.className = 'zk-embed-previews';
        previewContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 2;
        `;
        this.container.appendChild(previewContainer);

        const rendererComponent = new Component();
        const updaters: Array<() => void> = [];
        // 记录用户手动调整后的尺寸（以画布坐标系存储，缩放时按 zoom 换算为像素）
        const cardSizeMap = new Map<string, { widthModel: number; heightModel: number }>();
        const embedNodeSizes = ((this.currentData?.metadata as any)?.embedNodeSizes || {}) as Record<string, { width: number; height: number }>;
        const interactionUpdaters: Array<() => void> = [];
        let suppressedCanvasInteractionCount = 0;
        const setCanvasInteractionSuppressed = (suppressed: boolean) => {
            if (!this.cy) return;
            if (suppressed) {
                suppressedCanvasInteractionCount += 1;
                if (suppressedCanvasInteractionCount === 1) {
                    this.cy.userZoomingEnabled(false);
                    this.cy.userPanningEnabled(false);
                }
                return;
            }
            suppressedCanvasInteractionCount = Math.max(0, suppressedCanvasInteractionCount - 1);
            if (suppressedCanvasInteractionCount === 0) {
                this.cy.userZoomingEnabled(true);
                this.cy.userPanningEnabled(true);
            }
        };

        embedNodes.forEach((node: any) => {
            const data = node.data();
            const originalNode = data.originalNode as ZKNode | undefined;
            if (!originalNode?.file) return;
            const sourceFile = originalNode.file;
            const nodeId = node.id();
            const persistedSize = embedNodeSizes[originalNode.ID] || embedNodeSizes[originalNode.IDStr];
            if (persistedSize && persistedSize.width > 0 && persistedSize.height > 0) {
                cardSizeMap.set(nodeId, {
                    widthModel: persistedSize.width,
                    heightModel: persistedSize.height
                });
            }
            const isVivid = this.isVividThemeStyle();
            const branchBorderColor = typeof data.branchNodeBorder === 'string' ? data.branchNodeBorder : '';
            const vividHeaderBackground = isVivid && branchBorderColor
                ? this.hexToRgba(branchBorderColor, this.currentOptions?.themeMode === 'light' ? 0.18 : 0.28)
                : 'rgba(11, 16, 25, 0.72)';
            const vividHeaderDivider = isVivid && branchBorderColor
                ? this.hexToRgba(branchBorderColor, this.currentOptions?.themeMode === 'light' ? 0.55 : 0.7)
                : 'rgba(90, 111, 127, 0.45)';

            const card = document.createElement('div');
            card.className = 'zk-embed-preview-card';
            card.style.cssText = `
                position: absolute;
                background: linear-gradient(180deg, rgba(20, 26, 38, 0.98) 0%, rgba(16, 22, 34, 0.98) 100%);
                border: 1px solid rgba(90, 111, 127, 0.6);
                border-radius: 12px;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04);
                color: var(--text-normal);
                overflow: hidden;
                pointer-events: auto;
            `;

            const headerEl = document.createElement('div');
            headerEl.style.cssText = `
                height: 36px;
                padding: 0 12px;
                display: flex;
                align-items: center;
                border-bottom: 1px solid ${vividHeaderDivider};
                background: ${vividHeaderBackground};
                color: var(--text-muted);
                font-size: 12px;
                font-weight: 600;
                letter-spacing: 0.2px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                cursor: move;
                user-select: none;
            `;
            headerEl.textContent = sourceFile.basename;

            const contentEl = document.createElement('div');
            contentEl.style.cssText = `
                height: calc(100% - 36px);
                overflow: auto;
                overscroll-behavior: contain;
                padding: 12px 14px;
                font-size: 14px;
                line-height: 1.6;
                color: var(--text-normal);
                scrollbar-width: thin;
            `;

            // 右下角 resize 焦点（仅在选中时可用）
            const resizeHandle = document.createElement('div');
            resizeHandle.style.cssText = `
                position: absolute;
                right: 0;
                bottom: 0;
                width: 18px;
                height: 18px;
                background: rgba(91, 143, 217, 0.9);
                border-top-left-radius: 6px;
                cursor: nwse-resize;
                pointer-events: none;
                opacity: 0;
                color: rgba(255, 255, 255, 0.95);
                font-size: 11px;
                font-weight: 700;
                display: flex;
                align-items: flex-end;
                justify-content: flex-end;
                line-height: 1;
                padding-right: 2px;
                transition: opacity 0.15s ease;
            `;
            resizeHandle.textContent = '◢';

            card.appendChild(headerEl);
            card.appendChild(contentEl);
            card.appendChild(resizeHandle);
            previewContainer.appendChild(card);

            // 仅选中时允许交互（滚轮滚动/拖拽缩放），避免影响画布操作
            let isHoveringCard = false;
            const releaseCanvasSuppression = () => {
                if (isHoveringCard) {
                    isHoveringCard = false;
                    setCanvasInteractionSuppressed(false);
                }
            };
            const updateInteraction = () => {
                const isSelected = node.selected();
                resizeHandle.style.pointerEvents = isSelected ? 'auto' : 'none';
                resizeHandle.style.opacity = isSelected ? '1' : '0';
                if (!isSelected) {
                    releaseCanvasSuppression();
                }
            };
            interactionUpdaters.push(updateInteraction);
            updateInteraction();

            card.addEventListener('mouseenter', () => {
                if (!node.selected() || isHoveringCard) return;
                isHoveringCard = true;
                setCanvasInteractionSuppressed(true);
            });
            card.addEventListener('mouseleave', () => {
                releaseCanvasSuppression();
            });

            let wheelSuppressTimeout: number | null = null;
            const handleWheel = (e: WheelEvent) => {
                if (!node.selected()) return;
                e.preventDefault();
                e.stopPropagation();
                if (!isHoveringCard) {
                    isHoveringCard = true;
                    setCanvasInteractionSuppressed(true);
                }
                if (wheelSuppressTimeout !== null) {
                    window.clearTimeout(wheelSuppressTimeout);
                }
                wheelSuppressTimeout = window.setTimeout(() => {
                    if (!isHoveringCard) {
                        setCanvasInteractionSuppressed(false);
                    }
                    wheelSuppressTimeout = null;
                }, 180);
                contentEl.scrollTop += e.deltaY;
            };
            card.addEventListener('wheel', handleWheel, { passive: false });
            contentEl.addEventListener('wheel', handleWheel, { passive: false });

            let draggingFromHeader = false;
            let dragStartMouseX = 0;
            let dragStartMouseY = 0;
            let dragStartRenderedX = 0;
            let dragStartRenderedY = 0;

            const onHeaderMouseMove = (e: MouseEvent) => {
                if (!draggingFromHeader || !this.cy) return;
                const dx = e.clientX - dragStartMouseX;
                const dy = e.clientY - dragStartMouseY;
                node.renderedPosition({
                    x: dragStartRenderedX + dx,
                    y: dragStartRenderedY + dy
                });
            };

            const onHeaderMouseUp = () => {
                if (!draggingFromHeader) return;
                draggingFromHeader = false;
                setCanvasInteractionSuppressed(false);
                document.removeEventListener('mousemove', onHeaderMouseMove);
                document.removeEventListener('mouseup', onHeaderMouseUp);
            };

            headerEl.addEventListener('mousedown', (e: MouseEvent) => {
                if (!this.cy) return;
                if (e.button !== 0) return;
                if (e.detail >= 2) return; // 双击交给编辑逻辑
                e.preventDefault();
                e.stopPropagation();
                draggingFromHeader = true;
                setCanvasInteractionSuppressed(true);
                dragStartMouseX = e.clientX;
                dragStartMouseY = e.clientY;
                const renderedPos = node.renderedPosition();
                dragStartRenderedX = renderedPos.x;
                dragStartRenderedY = renderedPos.y;
                document.addEventListener('mousemove', onHeaderMouseMove);
                document.addEventListener('mouseup', onHeaderMouseUp);
            });

            headerEl.addEventListener('dblclick', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                this.showInlineNodeEditor(node);
            });

            card.addEventListener('mousedown', (e: MouseEvent) => {
                if (!this.cy) return;
                // 在预览卡片任意位置点击都可命中该节点
                const toggleSelection = e.metaKey || e.ctrlKey;
                if (toggleSelection) {
                    if (node.selected()) {
                        node.unselect();
                    } else {
                        node.select();
                    }
                } else if (!node.selected()) {
                    this.cy.$(':selected').unselect();
                    node.select();
                }
                e.stopPropagation();
            });

            // 右下角拖拽调整尺寸
            let resizing = false;
            let startX = 0;
            let startY = 0;
            let startW = 0;
            let startH = 0;

            const onMouseMove = (e: MouseEvent) => {
                if (!resizing) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                const newWidth = Math.max(220, startW + dx);
                const newHeight = Math.max(180, startH + dy);
                const zoom = this.cy?.zoom() ?? 1;
                cardSizeMap.set(nodeId, {
                    widthModel: newWidth / zoom,
                    heightModel: newHeight / zoom
                });
                card.style.width = `${newWidth}px`;
                card.style.height = `${newHeight}px`;
            };

            const onMouseUp = () => {
                if (!resizing) return;
                resizing = false;
                setCanvasInteractionSuppressed(false);
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                const modelSize = cardSizeMap.get(nodeId);
                if (modelSize) {
                    this.container?.dispatchEvent(new CustomEvent('embed-node-size-changed', {
                        detail: {
                            node: data.originalNode,
                            size: modelSize
                        }
                    }));
                }
            };

            resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
                if (!node.selected()) return;
                e.preventDefault();
                e.stopPropagation();
                resizing = true;
                setCanvasInteractionSuppressed(true);
                startX = e.clientX;
                startY = e.clientY;
                const size = cardSizeMap.get(nodeId);
                if (size) {
                    const zoom = this.cy?.zoom() ?? 1;
                    startW = size.widthModel * zoom;
                    startH = size.heightModel * zoom;
                } else {
                    const bb = node.renderedBoundingBox();
                    startW = Math.max(220, bb.w);
                    startH = Math.max(180, bb.h);
                }
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });

            app.vault.cachedRead(sourceFile).then(async (markdown: string) => {
                if (!contentEl.isConnected) return;

                // 控制渲染量，避免超长笔记影响图形交互
                const snippet = markdown.length > 3000 ? `${markdown.slice(0, 3000)}\n\n...` : markdown;
                contentEl.empty?.();
                contentEl.textContent = '';
                await MarkdownRenderer.render(app, snippet, contentEl, sourceFile.path, rendererComponent);
                contentEl.querySelectorAll('h1,h2,h3,h4').forEach((el: any) => {
                    el.style.marginTop = '0.4em';
                    el.style.marginBottom = '0.35em';
                    el.style.lineHeight = '1.35';
                });
                contentEl.querySelectorAll('p,li').forEach((el: any) => {
                    el.style.marginTop = '0.28em';
                    el.style.marginBottom = '0.28em';
                });
            }).catch(() => {
                contentEl.textContent = sourceFile.basename || '';
            });

            const updatePosition = () => {
                if (!this.cy) return;
                const bb = node.renderedBoundingBox();
                const zoom = this.cy.zoom();
                const size = cardSizeMap.get(nodeId);
                const width = size ? size.widthModel * zoom : Math.max(220, bb.w);
                const height = size ? size.heightModel * zoom : Math.max(180, bb.h);

                card.style.left = `${bb.x1}px`;
                card.style.top = `${bb.y1}px`;
                card.style.width = `${width}px`;
                card.style.height = `${height}px`;
                card.style.borderRadius = `${Math.max(8, 12 * zoom)}px`;
            };

            updaters.push(updatePosition);
            updatePosition();
        });

        let scheduled = false;
        const scheduleUpdate = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                updaters.forEach(fn => fn());
                scheduled = false;
            });
        };

        const handleSelectionChange = () => interactionUpdaters.forEach(fn => fn());
        this.cy.on('zoom pan viewport drag position', scheduleUpdate);
        this.cy.on('dragfree', scheduleUpdate);
        this.cy.on('select unselect', handleSelectionChange);

        this.embedPreviewCleanup = () => {
            if (this.cy) {
                this.cy.off('zoom pan viewport drag position', scheduleUpdate);
                this.cy.off('dragfree', scheduleUpdate);
                this.cy.off('select unselect', handleSelectionChange);
                this.cy.userZoomingEnabled(true);
                this.cy.userPanningEnabled(true);
            }
            rendererComponent.unload();
            previewContainer.remove();
        };
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

        // 存储所有徽章的更新函数
        const badgeUpdaters: Array<() => void> = [];
        let updateScheduled = false;

        this.cy.nodes('[?hasRemark]').forEach((node: any) => {
            const remarkText = node.data('remark') || '';
            const remarkColor = node.data('branchNodeBorder') || '#ef4444';
            const remarkEl = document.createElement('div');
            remarkEl.className = 'zk-node-remark-badge';
            remarkEl.textContent = 'R';
            remarkEl.style.cssText = `
                position: absolute;
                width: 18px;
                height: 18px;
                background-color: ${remarkColor};
                color: #ffffff;
                font-size: 11px;
                font-weight: 700;
                border-radius: 999px;
                border: 2px solid rgba(255, 255, 255, 0.95);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: auto;
                cursor: pointer;
                user-select: none;
            `;
            badgeContainer.appendChild(remarkEl);

            const tooltipEl = document.createElement('div');
            tooltipEl.className = 'zk-node-remark-tooltip';
            tooltipEl.textContent = remarkText;
            tooltipEl.style.cssText = `
                position: absolute;
                max-width: 280px;
                padding: 8px 10px;
                background: rgba(15, 23, 42, 0.96);
                color: #ffffff;
                font-size: 12px;
                line-height: 1.45;
                border-radius: 8px;
                border: 1px solid rgba(148, 163, 184, 0.28);
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
                white-space: pre-wrap;
                word-break: break-word;
                pointer-events: none;
                opacity: 0;
                transform: translateY(4px);
                transition: opacity 0.12s ease, transform 0.12s ease;
                z-index: 20;
            `;
            badgeContainer.appendChild(tooltipEl);

            const updateRemarkPosition = () => {
                if (!this.cy) return;
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();

                if (isHidden) {
                    remarkEl.style.display = 'none';
                    tooltipEl.style.display = 'none';
                    tooltipEl.style.opacity = '0';
                    return;
                }

                remarkEl.style.display = 'flex';
                tooltipEl.style.display = 'block';
                const zoom = this.cy.zoom();
                const boundingBox = node.renderedBoundingBox();
                const size = 18 * zoom;
                const x = boundingBox.x2 - size * 0.35;
                const y = boundingBox.y1 - size * 0.35;

                remarkEl.style.left = `${x}px`;
                remarkEl.style.top = `${y}px`;
                remarkEl.style.width = `${size}px`;
                remarkEl.style.height = `${size}px`;
                remarkEl.style.fontSize = `${11 * zoom}px`;
                remarkEl.style.borderWidth = `${Math.max(1, 2 * zoom)}px`;

                const tooltipX = x + size + (8 * zoom);
                const tooltipY = y - (6 * zoom);
                tooltipEl.style.left = `${tooltipX}px`;
                tooltipEl.style.top = `${tooltipY}px`;
            };

            badgeUpdaters.push(updateRemarkPosition);
            updateRemarkPosition();

            remarkEl.addEventListener('click', (e) => {
                e.stopPropagation();
                node.select();
                this.container?.dispatchEvent(new CustomEvent('node-remark-edit', {
                    detail: {
                        node: node.data('originalNode'),
                        event: e
                    }
                }));
            });

            remarkEl.addEventListener('mouseenter', () => {
                if (!remarkText) return;
                tooltipEl.style.opacity = '1';
                tooltipEl.style.transform = 'translateY(0)';
            });

            remarkEl.addEventListener('mouseleave', () => {
                tooltipEl.style.opacity = '0';
                tooltipEl.style.transform = 'translateY(4px)';
            });
        });

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
                
                const zoom = this.cy.zoom();
                const boundingBox = node.renderedBoundingBox();
                
                // 计算徽章位置（节点左上角内部，增加更多内边距）
                const x = boundingBox.x1 + 8 * zoom;  // 左边距 8px
                const y = boundingBox.y1 + 8 * zoom;  // 上边距 8px
                
                badgeEl.style.left = `${x}px`;
                badgeEl.style.top = `${y}px`;
                badgeEl.style.fontSize = `${9 * zoom}px`;
                badgeEl.style.padding = `${2 * zoom}px ${5 * zoom}px`;
                badgeEl.style.borderRadius = `${3 * zoom}px`;
                badgeEl.style.borderWidth = `${1 * zoom}px`;
            };

            badgeUpdaters.push(updateBadgePosition);

            // 初始位置
            updateBadgePosition();

            // 点击徽章时选中节点
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                node.select();
            });
        });

        // 统一的更新函数，使用 requestAnimationFrame 确保在下一帧更新
        const scheduleUpdate = () => {
            if (updateScheduled) return;
            updateScheduled = true;
            
            requestAnimationFrame(() => {
                badgeUpdaters.forEach(updater => updater());
                updateScheduled = false;
            });
        };

        // 立即更新函数（用于拖动结束等需要立即同步的场景）
        const immediateUpdate = () => {
            badgeUpdaters.forEach(updater => updater());
            updateScheduled = false;
        };

        // 监听全局事件
        if (this.cy) {
            this.cy.on('pan zoom viewport drag position', scheduleUpdate);
            // 拖动结束时立即更新
            this.cy.on('dragfree', immediateUpdate);
            // 收起/展开、分组、重新布局等会改变节点可见性或渲染位置
            this.cy.on('class data select unselect add remove layoutstop', scheduleUpdate);
        }
        
        // 添加边控制点
        this.addEdgeControlPoints();

        // 添加边端点手柄
        this.addEdgeEndpointHandles();

        // 添加连线手柄
        this.addConnectionHandles();

        // 添加折叠/展开子节点手柄
        this.addCollapseToggleHandle();
        
        // 添加分组调整大小手柄
        this.addGroupResizeHandles();
    }

    private addCollapseToggleHandle(): void {
        if (!this.cy || !this.container) return;

        if (this.collapseHandleCleanup) {
            this.collapseHandleCleanup();
            this.collapseHandleCleanup = null;
        }

        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-collapse-toggle-handle';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 4;
        `;
        this.container.appendChild(handleContainer);
        const handleUpdaters: Array<() => void> = [];
        let updateScheduled = false;

        const hasChildren = (originalId: string): boolean => {
            return this.cy!.nodes().some((n: any) => {
                const childId = n.data()?.originalNode?.IDStr;
                return typeof childId === 'string' && childId !== originalId && childId.startsWith(`${originalId}.`);
            });
        };

        this.cy.nodes().forEach((node: any) => {
            const data = node.data();
            const originalId = data?.originalNode?.IDStr;
            if (!originalId || data?.isGroup || data?.isPlaceholder) return;
            if (!hasChildren(originalId)) return;

            const handle = document.createElement('div');
            handle.style.cssText = `
                position: absolute;
                width: 33px;
                height: 33px;
                border-radius: 16.5px;
                background-color: rgba(17, 24, 39, 0.85);
                border: 1px solid rgba(148, 163, 184, 0.45);
                color: #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                font-weight: 700;
                line-height: 1;
                cursor: pointer;
                pointer-events: auto;
                user-select: none;
            `;
            handleContainer.appendChild(handle);

            const updateHandle = () => {
                if (!this.cy) return;

                const isHidden = node.hasClass('zk-collapsed-hidden') || !node.visible();
                if (isHidden) {
                    handle.style.display = 'none';
                    return;
                }

                const bb = node.renderedBoundingBox();
                const zoom = this.cy.zoom();
                const size = 33 * zoom;
                const left = bb.x1 - size - (8 * zoom);
                const top = bb.y1 + (bb.h - size) / 2;
                const isCollapsed = this.collapsedNodeIds.has(originalId);
                const shouldShow = isCollapsed || node.selected();

                if (!shouldShow) {
                    handle.style.display = 'none';
                    return;
                }

                handle.textContent = isCollapsed ? '▶' : '▼';
                handle.title = isCollapsed ? '展开子节点' : '收起子节点';
                handle.style.width = `${size}px`;
                handle.style.height = `${size}px`;
                handle.style.borderRadius = `${size / 2}px`;
                handle.style.left = `${left}px`;
                handle.style.top = `${top}px`;
                handle.style.fontSize = `${18 * zoom}px`;
                handle.style.display = 'flex';
            };

            handleUpdaters.push(updateHandle);
            updateHandle();

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            handle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.collapsedNodeIds.has(originalId)) {
                    this.collapsedNodeIds.delete(originalId);
                } else {
                    this.collapsedNodeIds.add(originalId);
                }
                this.applyCollapsedState();
                handleUpdaters.forEach((fn) => fn());
            });
        });

        const scheduleUpdate = () => {
            if (updateScheduled) return;
            updateScheduled = true;
            requestAnimationFrame(() => {
                handleUpdaters.forEach((fn) => fn());
                updateScheduled = false;
            });
        };

        this.cy.on('zoom pan position dragfree viewport class data add remove layoutstop select unselect', scheduleUpdate);

        this.collapseHandleCleanup = () => {
            if (this.cy) {
                this.cy.off('zoom pan position dragfree viewport class data add remove layoutstop select unselect', scheduleUpdate);
            }
            handleContainer.remove();
        };
    }

    private applyCollapsedState(): void {
        if (!this.cy) return;

        const existingIds = new Set<string>();
        this.cy.nodes().forEach((node: any) => {
            const id = node.data()?.originalNode?.IDStr;
            if (id) existingIds.add(id);
        });
        this.collapsedNodeIds = new Set(Array.from(this.collapsedNodeIds).filter((id) => existingIds.has(id)));

        this.cy.nodes().removeClass('zk-collapsed-hidden');
        this.cy.edges().removeClass('zk-collapsed-hidden');

        const hiddenIds = new Set<string>();
        this.collapsedNodeIds.forEach((collapsedId) => {
            this.cy!.nodes().forEach((node: any) => {
                const id = node.data()?.originalNode?.IDStr;
                if (!id) return;
                if (id !== collapsedId && id.startsWith(`${collapsedId}.`)) {
                    hiddenIds.add(id);
                    node.addClass('zk-collapsed-hidden');
                }
            });
        });

        this.cy.edges().forEach((edge: any) => {
            const sourceId = edge.data()?.originalSource;
            const targetId = edge.data()?.originalTarget;
            if ((sourceId && hiddenIds.has(sourceId)) || (targetId && hiddenIds.has(targetId))) {
                edge.addClass('zk-collapsed-hidden');
            }
        });

        // 如果分组内成员全部隐藏，则分组容器也一并隐藏
        this.cy.nodes('[?isGroup]').forEach((groupNode: any) => {
            const groupNodeIds: string[] = groupNode.data('nodeIds') || [];
            if (groupNodeIds.length === 0) return;

            const hasVisibleMember = groupNodeIds.some((nodeId) => !hiddenIds.has(nodeId));
            if (!hasVisibleMember) {
                groupNode.addClass('zk-collapsed-hidden');
            }
        });
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

        // 存储所有手柄的更新函数
        const handleUpdaters: Array<() => void> = [];
        let updateScheduled = false;

        // 为每个节点创建连线手柄
        this.cy.nodes('[!isGroup]').forEach((node: any) => {
            const handle = document.createElement('div');
            handle.className = 'zk-connection-handle';
            handle.style.cssText = `
                position: absolute;
                width: 24px;
                height: 24px;
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
                handle.style.width = `${24 * zoom}px`;
                handle.style.height = `${24 * zoom}px`;
                handle.style.borderWidth = `${2 * zoom}px`;
            };

            handleUpdaters.push(updateHandlePosition);

            // 初始位置
            updateHandlePosition();

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

        // 统一的更新函数，使用 requestAnimationFrame 确保在下一帧更新
        const scheduleUpdate = () => {
            if (updateScheduled) return;
            updateScheduled = true;
            
            requestAnimationFrame(() => {
                handleUpdaters.forEach(updater => updater());
                updateScheduled = false;
            });
        };

        // 立即更新函数（用于拖动结束等需要立即同步的场景）
        const immediateUpdate = () => {
            handleUpdaters.forEach(updater => updater());
            updateScheduled = false;
        };

        // 监听全局事件
        if (this.cy) {
            this.cy.on('pan zoom viewport drag position', scheduleUpdate);
            // 拖动结束时立即更新
            this.cy.on('dragfree', immediateUpdate);
        }
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

            // 创建连线 - 使用淡绿色（与智能连线一致）
            dragLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            dragLine.setAttribute('stroke', '#10b981');  // 淡绿色，表示可以创建子节点
            dragLine.setAttribute('stroke-width', '2');
            dragLine.setAttribute('stroke-dasharray', '5,5');  // 虚线
            dragLine.setAttribute('opacity', '0.8');  // 略微透明
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
                // 有目标节点 - 高亮显示
                dragLine.setAttribute('stroke', '#10b981');  // 绿色表示可以连接
                dragLine.setAttribute('stroke-width', '3');  // 加粗
                dragLine.setAttribute('opacity', '1');  // 不透明
                targetNode.addClass('connection-target-hover');
            } else {
                // 拖到空白处 - 准备创建子节点（仍然显示绿色，但略细和透明）
                dragLine.setAttribute('stroke', '#10b981');  // 绿色表示可以创建子节点
                dragLine.setAttribute('stroke-width', '2');  // 正常宽度
                dragLine.setAttribute('opacity', '0.8');  // 略微透明
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
            this.cy.nodes('.connection-target-hover').removeClass('connection-target-hover');

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

        // 监听边移除事件，确保控制点被清除
        this.cy.on('remove', 'edge', () => {
            this.hideEdgeControlPoints(controlPointContainer);
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
            width: 14px;
            height: 14px;
            background-color: rgba(148, 163, 184, 0.95);
            border: 2px solid rgba(255, 255, 255, 0.95);
            border-radius: 50%;
            cursor: grab;
            pointer-events: auto;
            transform: translate(-50%, -50%);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
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

            // 二次贝塞尔控制点位置（参数意义仍保持不变）
            const currentDistance = edge.data('controlPointDistance') !== undefined ? edge.data('controlPointDistance') : 0;
            const cpX = midX + perpX * currentDistance;
            const cpY = midY + perpY * currentDistance;

            // 手柄显示在曲线中点（t=0.5），避免“漂离连线”的视觉问题
            const curveMidX = sourcePos.x * 0.25 + cpX * 0.5 + targetPos.x * 0.25;
            const curveMidY = sourcePos.y * 0.25 + cpY * 0.5 + targetPos.y * 0.25;

            controlPoint.style.left = `${curveMidX}px`;
            controlPoint.style.top = `${curveMidY}px`;
        };

        // 使用 requestAnimationFrame 调度更新
        let updateScheduled = false;
        const scheduleUpdate = () => {
            if (updateScheduled) return;
            updateScheduled = true;
            
            requestAnimationFrame(() => {
                updateControlPointPosition();
                updateScheduled = false;
            });
        };

        // 立即更新函数（用于拖动结束等需要立即同步的场景）
        const immediateUpdate = () => {
            updateControlPointPosition();
            updateScheduled = false;
        };

        // 初始位置
        updateControlPointPosition();

        // 监听图形缩放、平移和节点位置变化
        this.cy.on('zoom pan position drag viewport', scheduleUpdate);
        // 拖动结束时立即更新
        this.cy.on('dragfree', immediateUpdate);

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
                controlPoint.style.cursor = 'grab';
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // 清理函数
        const cleanup = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            if (this.cy) {
                this.cy.off('zoom pan position drag viewport', scheduleUpdate);
                this.cy.off('dragfree', immediateUpdate);
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
     * 添加边端点手柄（用于拖动修改边的起点和终点）
     */
    private addEdgeEndpointHandles(): void {
        if (!this.cy || !this.container) return;

        // 创建手柄容器
        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-edge-endpoint-handles';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 2;
        `;
        this.container.appendChild(handleContainer);

        // 监听边选中事件
        this.cy.on('select', 'edge', (evt: any) => {
            const edge = evt.target;
            this.showEdgeEndpointHandles(edge, handleContainer);
        });

        // 监听边取消选中事件
        this.cy.on('unselect', 'edge', () => {
            this.hideEdgeEndpointHandles(handleContainer);
        });

        // 监听边移除事件，确保手柄被清除
        this.cy.on('remove', 'edge', () => {
            this.hideEdgeEndpointHandles(handleContainer);
        });
    }

    /**
     * 显示边的端点手柄
     */
    private showEdgeEndpointHandles(edge: any, container: HTMLElement): void {
        // 清除旧的手柄
        this.hideEdgeEndpointHandles(container);

        const data = edge.data();
        const sourceNode = this.cy!.$id(data.source);
        const targetNode = this.cy!.$id(data.target);

        if (!sourceNode.length || !targetNode.length) return;

        // 检查约束：目标节点必须是叶子节点（nodeSons === 1）
        const targetData = targetNode.data();
        const originalTargetNode = targetData.originalNode;
        const canModifyTarget = originalTargetNode && originalTargetNode.nodeSons === 1;

        // 创建起点手柄（始终可用）
        const sourceHandle = this.createEndpointHandle('source', sourceNode, edge, container);

        // 创建终点手柄（仅当满足约束时）
        let targetHandle: HTMLElement | null = null;
        if (canModifyTarget) {
            targetHandle = this.createEndpointHandle('target', targetNode, edge, container);
        }

        // 在视口变化时更新位置
        const scheduleUpdate = () => {
            requestAnimationFrame(() => {
                this.updateEndpointHandlePosition(sourceHandle, sourceNode, edge, 'source');
                if (targetHandle) {
                    this.updateEndpointHandlePosition(targetHandle, targetNode, edge, 'target');
                }
            });
        };

        this.cy!.on('zoom pan viewport drag position', scheduleUpdate);
        // 首帧再同步一次，避免初始渲染时手柄短暂错位
        requestAnimationFrame(scheduleUpdate);
    }

    /**
     * 创建端点手柄
     */
    private createEndpointHandle(
        type: 'source' | 'target',
        node: any,
        edge: any,
        container: HTMLElement
    ): HTMLElement {
        const handle = document.createElement('div');
        handle.className = `zk-edge-endpoint-handle zk-edge-endpoint-${type}`;
        handle.style.cssText = `
            position: absolute;
            width: 10px;
            height: 10px;
            background-color: #f97316;
            border: 2px solid #ffffff;
            border-radius: 3px;
            cursor: grab;
            pointer-events: auto;
            transform: translate(-50%, -50%);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            z-index: 1001;
        `;
        container.appendChild(handle);

        // 初始位置
        this.updateEndpointHandlePosition(handle, node, edge, type);

        // 绑定拖动事件
        this.bindEndpointHandleDrag(handle, type, node, edge, container);

        return handle;
    }

    /**
     * 更新端点手柄位置（计算边的实际端点）
     */
    private updateEndpointHandlePosition(handle: HTMLElement, node: any, edge: any, type: 'source' | 'target'): void {
        if (!this.cy) return;

        // 优先使用 rendered 端点（像素坐标），确保手柄贴合当前连线
        let endpoint: { x: number; y: number } | null = null;
        if (type === 'source') {
            if (typeof edge.renderedSourceEndpoint === 'function') {
                endpoint = edge.renderedSourceEndpoint();
            } else if (typeof edge.sourceEndpoint === 'function') {
                const modelPos = edge.sourceEndpoint();
                if (modelPos && typeof modelPos.x === 'number' && typeof modelPos.y === 'number') {
                    const zoom = this.cy.zoom();
                    const pan = this.cy.pan();
                    endpoint = {
                        x: modelPos.x * zoom + pan.x,
                        y: modelPos.y * zoom + pan.y
                    };
                }
            }
        } else {
            if (typeof edge.renderedTargetEndpoint === 'function') {
                endpoint = edge.renderedTargetEndpoint();
            } else if (typeof edge.targetEndpoint === 'function') {
                const modelPos = edge.targetEndpoint();
                if (modelPos && typeof modelPos.x === 'number' && typeof modelPos.y === 'number') {
                    const zoom = this.cy.zoom();
                    const pan = this.cy.pan();
                    endpoint = {
                        x: modelPos.x * zoom + pan.x,
                        y: modelPos.y * zoom + pan.y
                    };
                }
            }
        }

        if (endpoint && typeof endpoint.x === 'number' && typeof endpoint.y === 'number') {
            handle.style.display = 'block';
            handle.style.left = `${endpoint.x}px`;
            handle.style.top = `${endpoint.y}px`;
            return;
        }

        // 获取节点中心和边界框
        const nodeCenter = node.renderedPosition();
        const boundingBox = node.renderedBoundingBox();

        // 安全检查：确保节点存在且有有效的位置
        if (!nodeCenter || !boundingBox) {
            if (handle.parentNode) {
                handle.style.display = 'none';
            }
            return;
        }

        const halfWidth = (boundingBox.x2 - boundingBox.x1) / 2;
        const halfHeight = (boundingBox.y2 - boundingBox.y1) / 2;

        // 获取边的另一端节点位置
        const edgeData = edge.data();
        let otherNode: any;

        if (type === 'source') {
            otherNode = this.cy.$id(edgeData.target);
        } else {
            otherNode = this.cy.$id(edgeData.source);
        }

        // 安全检查：确保另一端节点存在
        if (!otherNode || !otherNode.length) {
            if (handle.parentNode) {
                handle.style.display = 'none';
            }
            return;
        }

        const otherPos = otherNode.renderedPosition();

        // 安全检查：确保另一端节点的位置有效
        if (!otherPos || typeof otherPos.x !== 'number' || typeof otherPos.y !== 'number') {
            if (handle.parentNode) {
                handle.style.display = 'none';
            }
            return;
        }

        // 计算从当前节点指向另一端的方向
        const dx = otherPos.x - nodeCenter.x;
        const dy = otherPos.y - nodeCenter.y;

        // 归一化方向
        const length = Math.sqrt(dx * dx + dy * dy);
        const dirX = length > 0 ? dx / length : 0;
        const dirY = length > 0 ? dy / length : 0;

        // 计算交点（线段与矩形边框的交点）
        let x = nodeCenter.x;
        let y = nodeCenter.y;

        // 计算到各边的距离
        const distToRight = halfWidth / Math.abs(dirX || 1);
        const distToLeft = halfWidth / Math.abs(dirX || 1);
        const distToBottom = halfHeight / Math.abs(dirY || 1);
        const distToTop = halfHeight / Math.abs(dirY || 1);

        // 找出最小的正距离
        let minDist = Infinity;

        if (dirX > 0) distToRight < minDist && (minDist = distToRight);
        if (dirX < 0) distToLeft < minDist && (minDist = distToLeft);
        if (dirY > 0) distToBottom < minDist && (minDist = distToBottom);
        if (dirY < 0) distToTop < minDist && (minDist = distToTop);

        // 计算交点
        if (minDist !== Infinity) {
            x = nodeCenter.x + dirX * minDist;
            y = nodeCenter.y + dirY * minDist;
        }

        handle.style.left = `${x}px`;
        handle.style.top = `${y}px`;
    }

    /**
     * 隐藏边端点手柄
     */
    private hideEdgeEndpointHandles(container: HTMLElement): void {
        const handles = container.querySelectorAll('.zk-edge-endpoint-handle');
        handles.forEach(h => h.remove());
    }

    /**
     * 绑定端点手柄拖动事件
     */
    private bindEndpointHandleDrag(
        handle: HTMLElement,
        type: 'source' | 'target',
        sourceOrTargetNode: any,
        edge: any,
        container: HTMLElement
    ): void {
        if (!this.cy || !this.container) return;

        let isDragging = false;
        let dragLine: SVGLineElement | null = null;
        let svgOverlay: SVGSVGElement | null = null;

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            handle.style.cursor = 'grabbing';

            // 创建 SVG 覆盖层用于拖动线
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

            dragLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            dragLine.setAttribute('stroke', '#3b82f6');  // 改为蓝色
            dragLine.setAttribute('stroke-width', '2');
            dragLine.setAttribute('stroke-dasharray', '5,5');
            svgOverlay.appendChild(dragLine);

            // 获取父级起始位置
            const edgeData = edge.data();
            let startPos: { x: number; y: number };

            if (type === 'source') {
                // 拖动起点时，从终点位置开始
                const targetNode = this.cy!.$id(edgeData.target);
                startPos = targetNode.renderedPosition();
            } else {
                // 拖动终点时，从起点位置开始
                const sourceNode = this.cy!.$id(edgeData.source);
                startPos = sourceNode.renderedPosition();
            }

            dragLine.setAttribute('x1', startPos.x.toString());
            dragLine.setAttribute('y1', startPos.y.toString());
            dragLine.setAttribute('x2', startPos.x.toString());
            dragLine.setAttribute('y2', startPos.y.toString());
        });

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !dragLine || !this.cy) return;

            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;

            // 获取父级起始位置
            const edgeData = edge.data();
            let startPos: { x: number; y: number };

            if (type === 'source') {
                // 拖动起点时，从终点位置开始
                const targetNode = this.cy!.$id(edgeData.target);
                startPos = targetNode.renderedPosition();
            } else {
                // 拖动终点时，从起点位置开始
                const sourceNode = this.cy!.$id(edgeData.source);
                startPos = sourceNode.renderedPosition();
            }

            dragLine.setAttribute('x1', startPos.x.toString());
            dragLine.setAttribute('y1', startPos.y.toString());
            dragLine.setAttribute('x2', mouseX.toString());
            dragLine.setAttribute('y2', mouseY.toString());

            // 检查是否悬停在有效的目标节点上
            const mousePos = { x: mouseX, y: mouseY };
            const targetNode = this.getNodeAtPosition(mousePos);

            if (targetNode && targetNode !== sourceOrTargetNode) {
                // 绿色表示有效连接
                dragLine.setAttribute('stroke', '#10b981');
                targetNode.addClass('connection-target-hover');
            } else {
                // 蓝色表示拖动中
                dragLine.setAttribute('stroke', '#3b82f6');
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
            const newTargetNode = this.getNodeAtPosition(mousePos);

            // 清理视觉元素
            if (svgOverlay) {
                svgOverlay.remove();
                svgOverlay = null;
            }
            dragLine = null;
            this.cy.nodes('.connection-target-hover').removeClass('connection-target-hover');
            handle.style.cursor = 'grab';

            // 如果连接到有效节点
            if (newTargetNode && newTargetNode !== sourceOrTargetNode) {
                const edgeData = edge.data();
                const sourceNode = this.cy.$id(edgeData.source);
                const originalTargetNode = this.cy.$id(edgeData.target);

                if (type === 'source') {
                    // 修改起点
                    this.container?.dispatchEvent(new CustomEvent('edge-source-changed', {
                        detail: {
                            edgeId: edgeData.id,
                            oldSource: edgeData.originalSource || edgeData.source,
                            newSource: newTargetNode.data().originalNode.IDStr,
                            target: edgeData.originalTarget || edgeData.target,
                            label: edgeData.label
                        }
                    }));
                } else if (type === 'target') {
                    // 修改终点（包含 ID 继承）

                    // 检查新目标是否有子节点（约束）
                    const newTargetData = newTargetNode.data();
                    const newTargetNodeSons = newTargetData.originalNode.nodeSons;
                    if (newTargetNodeSons > 1) {
                        const { Notice } = require('obsidian');
                        new Notice('无法连接到有子节点的节点');
                        return;
                    }

                    const oldTargetData = originalTargetNode.data();
                    const oldTargetID = oldTargetData.originalNode.IDStr;
                    const newTargetData2 = newTargetNode.data();
                    const newTargetID = newTargetData2.originalNode.IDStr;

                    this.container?.dispatchEvent(new CustomEvent('edge-target-changed', {
                        detail: {
                            edgeId: edgeData.id,
                            source: edgeData.originalSource || edgeData.source,
                            oldTarget: oldTargetID,
                            newTarget: newTargetID,
                            label: edgeData.label
                        }
                    }));
                }
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
     * 从选中的节点创建分组
     */
    private createGroupFromNodes(nodes: any[]): void {
        if (nodes.length === 0) return;

        // 过滤掉占位符节点和分组节点
        const validNodes = nodes.filter(node => {
            const data = node.data();
            return !data.isPlaceholder && !data.isGroup && data.originalNode;
        });

        if (validNodes.length === 0) return;

        // 获取节点 ID 列表
        const nodeIds = validNodes.map(node => node.data('originalNode').ID);

        // 检查是否有节点已经在某个分组中
        const existingGroups = this.findGroupsContainingNodes(nodeIds);

        if (existingGroups.length > 0) {
            // 有节点已经在分组中，询问用户是创建新分组还是添加到现有分组
            this.showGroupActionDialog(existingGroups, (action, targetGroupId) => {
                if (action === 'new') {
                    // 创建新分组
                    this.showGroupNameDialog((groupLabel) => {
                        if (!groupLabel) return;

                        const groupId = `group_${Date.now()}`;
                        this.container?.dispatchEvent(new CustomEvent('group-create', {
                            detail: { groupId, groupLabel, nodeIds }
                        }));
                    });
                } else if (action === 'add' && targetGroupId) {
                    // 添加到现有分组
                    this.container?.dispatchEvent(new CustomEvent('group-add-nodes', {
                        detail: { groupId: targetGroupId, nodeIds }
                    }));
                }
            });
        } else {
            // 没有节点在分组中，直接创建新分组
            this.showGroupNameDialog((groupLabel) => {
                if (!groupLabel) return;

                const groupId = `group_${Date.now()}`;
                this.container?.dispatchEvent(new CustomEvent('group-create', {
                    detail: { groupId, groupLabel, nodeIds }
                }));
            });
        }
    }

    /**
     * 查找包含指定节点的分组
     */
    private findGroupsContainingNodes(nodeIds: string[]): Array<{ id: string; label: string; nodeIds: string[] }> {
        const groups = this.currentData?.metadata?.groups || [];
        const result: Array<{ id: string; label: string; nodeIds: string[] }> = [];

        for (const group of groups) {
            // 检查是否有任何选中的节点在这个分组中
            const hasCommonNode = nodeIds.some(id => group.nodeIds.includes(id));
            if (hasCommonNode) {
                result.push(group);
            }
        }

        return result;
    }

    /**
     * 显示分组操作选择对话框
     */
    private showGroupActionDialog(
        existingGroups: Array<{ id: string; label: string; nodeIds: string[] }>,
        callback: (action: 'new' | 'add', groupId?: string) => void
    ): void {
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
            min-width: 350px;
            max-width: 500px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;

        // 标题
        const title = document.createElement('h3');
        title.textContent = '选择操作';
        title.style.cssText = `
            margin: 0 0 15px 0;
            color: var(--text-normal);
            font-size: 16px;
        `;

        // 提示信息
        const info = document.createElement('p');
        info.textContent = '部分节点已在分组中，请选择操作：';
        info.style.cssText = `
            margin: 0 0 15px 0;
            color: var(--text-muted);
            font-size: 14px;
        `;

        // 选项容器
        const optionsContainer = document.createElement('div');
        optionsContainer.style.cssText = `
            margin-bottom: 20px;
        `;

        // 创建新分组选项
        const newGroupOption = document.createElement('div');
        newGroupOption.style.cssText = `
            padding: 10px;
            margin-bottom: 10px;
            border: 2px solid var(--background-modifier-border);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
        `;
        newGroupOption.innerHTML = `
            <div style="font-weight: 600; color: var(--text-normal); margin-bottom: 4px;">创建新分组</div>
            <div style="font-size: 12px; color: var(--text-muted);">将选中的节点创建为新的分组</div>
        `;
        newGroupOption.addEventListener('mouseenter', () => {
            newGroupOption.style.borderColor = '#5b8fd9';
            newGroupOption.style.backgroundColor = 'rgba(91, 143, 217, 0.1)';
        });
        newGroupOption.addEventListener('mouseleave', () => {
            newGroupOption.style.borderColor = 'var(--background-modifier-border)';
            newGroupOption.style.backgroundColor = 'transparent';
        });
        newGroupOption.addEventListener('click', () => {
            overlay.remove();
            callback('new');
        });

        optionsContainer.appendChild(newGroupOption);

        // 为每个现有分组创建选项
        existingGroups.forEach(group => {
            const groupOption = document.createElement('div');
            groupOption.style.cssText = `
                padding: 10px;
                margin-bottom: 10px;
                border: 2px solid var(--background-modifier-border);
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
            `;
            groupOption.innerHTML = `
                <div style="font-weight: 600; color: var(--text-normal); margin-bottom: 4px;">添加到「${group.label}」</div>
                <div style="font-size: 12px; color: var(--text-muted);">将新选中的节点添加到此分组（当前 ${group.nodeIds.length} 个节点）</div>
            `;
            groupOption.addEventListener('mouseenter', () => {
                groupOption.style.borderColor = '#5b8fd9';
                groupOption.style.backgroundColor = 'rgba(91, 143, 217, 0.1)';
            });
            groupOption.addEventListener('mouseleave', () => {
                groupOption.style.borderColor = 'var(--background-modifier-border)';
                groupOption.style.backgroundColor = 'transparent';
            });
            groupOption.addEventListener('click', () => {
                overlay.remove();
                callback('add', group.id);
            });

            optionsContainer.appendChild(groupOption);
        });

        // 取消按钮
        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.style.cssText = `
            width: 100%;
            padding: 8px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            cursor: pointer;
            font-size: 14px;
        `;
        cancelButton.addEventListener('click', () => {
            overlay.remove();
        });

        // 组装对话框
        dialog.appendChild(title);
        dialog.appendChild(info);
        dialog.appendChild(optionsContainer);
        dialog.appendChild(cancelButton);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
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

        // Enter 键保存，Delete 键（全选时清空），Escape 键取消
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                saveLabel();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                isSaved = true;  // 标记为已处理
                if (input.parentNode) {
                    input.remove();
                }
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // 检查文本框是否全选
                if (input.selectionStart === 0 && input.selectionEnd === input.value.length) {
                    // 全选状态：清空输入框
                    e.preventDefault();
                    e.stopPropagation();
                    input.value = '';
                } else {
                    // 非全选状态：阻止事件冒泡，允许默认删除行为
                    e.stopPropagation();
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
     * 显示占位符节点的内联编辑器
     */
    private showInlineNodeEditor(node: any): void {
        if (!this.cy || !this.container) return;

        const data = node.data();
        const originalNode = data.originalNode;
        const isPlaceholder = !!data.isPlaceholder;
        const isExistingNode = !!originalNode && !data.isGroup;
        if (!isPlaceholder && !isExistingNode) return;

        // 移除已存在的编辑器
        const existingEditor = this.container.querySelector('.node-label-editor');
        if (existingEditor) {
            existingEditor.remove();
        }

        // 获取节点位置
        const boundingBox = node.renderedBoundingBox();

        // 创建 textarea，直接覆盖在节点上
        const textarea = document.createElement('textarea');
        const originalDisplayLabel = data.label || '';
        const initialValue = isPlaceholder
            ? (data.label || '')
            : (originalNode?.isTextOnly
                ? ((originalNode.title || '').replace(/\\n/g, '\n'))
                : `${originalNode?.isEmbed ? '!' : ''}[[${originalNode?.file?.basename || originalNode?.title || ''}${(originalNode?.title && originalNode?.file?.basename && originalNode.title !== originalNode.file.basename) ? `|${originalNode.title}` : ''}]]`);
        textarea.value = initialValue;
        textarea.className = 'node-label-editor';

        // 重要：在编辑时隐藏节点标签，避免重复显示
        node.data('label', '');

        textarea.style.cssText = `
            position: absolute;
            left: ${boundingBox.x1}px;
            top: ${boundingBox.y1}px;
            width: ${Math.max(boundingBox.x2 - boundingBox.x1, 320)}px;
            height: ${Math.max(boundingBox.y2 - boundingBox.y1, 140)}px;
            transform: translate(0, 0);
            padding: 12px 14px;
            border: 1px solid rgba(148, 163, 184, 0.45);
            border-radius: 10px;
            background: rgba(15, 23, 42, 0.96);
            color: var(--text-normal);
            font-size: 14px;
            font-family: inherit;
            z-index: 1000;
            resize: both;
            overflow: auto;
            outline: none;
            text-align: left;
            line-height: 1.5;
            cursor: text;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        `;

        this.container.appendChild(textarea);

        const resizeEditorToContent = () => {
            const currentBox = node.renderedBoundingBox();
            const minWidth = Math.max(currentBox.x2 - currentBox.x1, 320);
            const minHeight = Math.max(currentBox.y2 - currentBox.y1, 140);
            textarea.style.width = `${minWidth}px`;
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.max(minHeight, textarea.scrollHeight + 4)}px`;
        };

        // 自动聚焦并全选文本（方便删除）
        setTimeout(() => {
            textarea.focus();
            textarea.select();
            resizeEditorToContent();
        }, 0);

        // 标记是否已保存，避免重复触发
        let isSaved = false;
        const suggesterPopoverRef = { value: null as HTMLElement | null };

        // 保存函数
        const saveNode = async () => {
            if (isSaved) return;
            isSaved = true;

            const newLabel = textarea.value.trim();
            node.data('label', originalDisplayLabel);

            if (!newLabel) {
                if (isPlaceholder) {
                    cancelEdit();
                }
                return;
            }

            // 获取节点的实际位置（使用 position() 而不是 boundingBox）
            const nodePosition = node.position();
            const actualPosition = {
                x: nodePosition.x,
                y: nodePosition.y
            };

            if (isPlaceholder) {
                this.container?.dispatchEvent(new CustomEvent('placeholder-node-edit', {
                    detail: {
                        nodeId: data.id,
                        label: newLabel,
                        position: actualPosition,
                        suggestedNodeId: data.suggestedNodeId
                    }
                }));
            } else {
                this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
                    detail: {
                        node: originalNode,
                        content: newLabel,
                        position: actualPosition
                    }
                }));
            }

            // 清理
            if (textarea.parentNode) {
                textarea.remove();
            }
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                suggesterPopoverRef.value.remove();
            }

            // 将焦点返回给 container，以便键盘事件能被捕获
            this.container?.focus();
        };

        // 取消编辑函数
        const cancelEdit = () => {
            if (isSaved) return;
            isSaved = true;
            node.data('label', isPlaceholder ? '' : originalDisplayLabel);
            if (isPlaceholder) {
                this.container?.dispatchEvent(new CustomEvent('placeholder-node-cancel', {
                    detail: {
                        nodeId: data.id
                    }
                }));
            }
            if (textarea.parentNode) {
                textarea.remove();
            }
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                suggesterPopoverRef.value.remove();
            }

            // 将焦点返回给 container，以便键盘事件能被捕获
            this.container?.focus();
        };

        // 事件监听器
        textarea.addEventListener('input', (e) => {
            // 阻止事件冒泡
            e.stopPropagation();
            // 不再实时更新节点标签，避免重复显示
            this.checkForLinkPattern(textarea, node, boundingBox, suggesterPopoverRef);
            resizeEditorToContent();
        });

        // 阻止其他事件冒泡到 Cytoscape
        textarea.addEventListener('keyup', (e) => e.stopPropagation());
        textarea.addEventListener('keypress', (e) => e.stopPropagation());
        textarea.addEventListener('click', (e) => e.stopPropagation());
        textarea.addEventListener('mousedown', (e) => e.stopPropagation());

        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
            // 阻止事件冒泡到 Cytoscape，避免被其他事件处理器拦截
            e.stopPropagation();

            // 如果 suggester 正在显示，ESC 键关闭 suggester，其他键让 suggester 的键盘处理器处理
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                if (e.key === 'Escape') {
                    // ESC 键关闭 suggester
                    e.preventDefault();
                    (suggesterPopoverRef.value as HTMLElement).remove();
                    return;
                }
                // 其他按键（方向键、Enter、删除键）由 suggester 的 handleKeyDown 处理
                return;
            }

            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    return;
                }
                e.preventDefault();
                saveNode();
            } else if (e.key === 'Escape') {
                // 取消编辑
                e.preventDefault();
                cancelEdit();
            }
            // 其他键（包括删除键）允许默认行为，不做任何处理
        });

        // 失去焦点时自动保存节点
        textarea.addEventListener('blur', () => {
            setTimeout(() => {
                // 如果焦点移到了 suggester 上，不保存
                if (suggesterPopoverRef.value && (suggesterPopoverRef.value as Node).contains(document.activeElement as Node)) {
                    return;
                }

                // 关闭 suggester
                if (suggesterPopoverRef.value) {
                    suggesterPopoverRef.value.remove();
                    suggesterPopoverRef.value = null;
                }

                if (!isSaved) {
                    if (isPlaceholder) {
                        cancelEdit();
                    } else {
                        saveNode();
                    }
                }
            }, 20);
        });

        // 点击编辑器外区域：占位符取消，普通节点保存
        const handleOutsidePointerDown = (e: MouseEvent) => {
            if (isSaved) return;
            const target = e.target as Node | null;
            if (!target) return;
            if (textarea.contains(target)) return;
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.contains(target)) return;
            if (isPlaceholder) {
                cancelEdit();
            } else {
                saveNode();
            }
        };
        document.addEventListener('mousedown', handleOutsidePointerDown, true);

        // 监听图形缩放和平移，更新编辑器位置
        const updatePosition = () => {
            if (!this.cy) return;

            const newBoundingBox = node.renderedBoundingBox();
            textarea.style.left = `${newBoundingBox.x1}px`;
            textarea.style.top = `${newBoundingBox.y1}px`;
            resizeEditorToContent();
        };

        this.cy.on('zoom pan', updatePosition);

        // 编辑器移除时清理事件监听
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((removedNode) => {
                    if (removedNode === textarea && this.cy) {
                        this.cy.off('zoom pan', updatePosition);
                        document.removeEventListener('mousedown', handleOutsidePointerDown, true);
                    }
                });
            });
        });

        observer.observe(this.container, { childList: true });
    }

    /**
     * 检查 [[ 链接模式
     */
    private checkForLinkPattern(
        textarea: HTMLTextAreaElement,
        node: any,
        boundingBox: any,
        suggesterPopoverRef: { value: HTMLElement | null }
    ): void {
        const value = textarea.value;
        const cursorPos = textarea.selectionStart;

        // 检查用户是否刚刚输入了 '[[' / '【【' / '![[ ' / '！【【'
        const lastTwoChars = value.substring(cursorPos - 2, cursorPos);
        const lastThreeChars = value.substring(cursorPos - 3, cursorPos);

        // 移除现有的 suggester
        const existingSuggester = this.container?.querySelector('.node-link-suggester');
        if (existingSuggester) {
            existingSuggester.remove();
            suggesterPopoverRef.value = null;
        }

        // 如果模式匹配，显示 suggester
        if (lastTwoChars === '[[' || lastTwoChars === '【【' || lastThreeChars === '![[' || lastThreeChars === '！【【') {
            const isEmbed = lastThreeChars === '![[' || lastThreeChars === '！【【';
            this.showLinkSuggester(textarea, node, boundingBox, suggesterPopoverRef, isEmbed);
        }
    }

    /**
     * 显示链接建议器
     */
    private showLinkSuggester(
        textarea: HTMLTextAreaElement,
        node: any,
        boundingBox: any,
        suggesterPopoverRef: { value: HTMLElement | null },
        isEmbed: boolean = false
    ): void {
        // 获取所有 markdown 文件
        const app = (window as any).app;
        const files = app.vault.getMarkdownFiles();

        // 创建 suggester popover
        const popover = document.createElement('div');
        popover.className = 'node-link-suggester';
        popover.style.cssText = `
            position: absolute;
            left: ${boundingBox.x1}px;
            top: ${boundingBox.y2 + 5}px;
            max-height: 240px;
            width: 320px;
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 6px;
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
            z-index: 1001;
            overflow-y: auto;
            padding: 4px 0;
        `;

        // 搜索输入框
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search notes...';
        searchInput.style.cssText = `
            width: calc(100% - 16px);
            margin: 4px 8px;
            padding: 6px 8px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-secondary);
            color: var(--text-normal);
            font-size: 12px;
            position: sticky;
            top: 0;
            z-index: 2;
        `;

        // 存储当前的选中索引和文件列表
        let selectedIndex = 0;
        let currentFiles: any[] = [];

        // 过滤文件（显示前 10 个）
        let searchTerm = '';
        const updateFileList = () => {
            // 清除现有项目
            const existingItems = popover.querySelectorAll('.suggester-item');
            existingItems.forEach(item => item.remove());

            // 过滤并显示文件
            currentFiles = files
                .filter((file: any) => {
                    const lowerPath = file.path.toLowerCase();
                    const lowerName = file.basename.toLowerCase();
                    return lowerName.includes(searchTerm.toLowerCase()) ||
                           lowerPath.includes(searchTerm.toLowerCase());
                })
                .slice(0, 10);

            // 重置选中索引
            selectedIndex = 0;

            currentFiles.forEach((file: any, index: number) => {
                const item = document.createElement('div');
                item.className = 'suggester-item';
                item.dataset.index = index.toString();
                item.style.cssText = `
                    padding: 6px 12px;
                    cursor: pointer;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                `;

                item.innerHTML = `
                    <span style="font-weight: 500; color: var(--text-normal);">${file.basename}</span>
                    <span style="font-size: 11px; color: var(--text-muted);">${file.path}</span>
                `;

                // 高亮选中的项目
                if (index === selectedIndex) {
                    item.style.backgroundColor = 'var(--background-modifier-hover)';
                }

                item.addEventListener('mouseenter', () => {
                    // 移除所有高亮
                    popover.querySelectorAll('.suggester-item').forEach(i => {
                        (i as HTMLElement).style.backgroundColor = '';
                    });
                    // 高亮当前项
                    item.style.backgroundColor = 'var(--background-modifier-hover)';
                    selectedIndex = index;
                });

                item.addEventListener('click', () => {
                    selectFile(file);
                });

                popover.appendChild(item);
            });
        };

        // 选择文件并创建节点
        const selectFile = (file: any) => {
            // 移除 suggester
            popover.remove();

            // 触发事件，调用 addFreeNodeToMOC
            this.container?.dispatchEvent(new CustomEvent('add-free-node-from-suggester', {
                detail: {
                    nodeId: node.data().id,
                    wikiLink: file.basename,
                    file: file,
                    isEmbed
                }
            }));
        };

        // 初始文件列表
        updateFileList();

        // 滚轮事件：优先滚动候选框，阻止冒泡到 Cytoscape（避免触发全局缩放）
        const handlePopoverWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            popover.scrollTop += e.deltaY;
        };

        popover.addEventListener('wheel', handlePopoverWheel, { passive: false });
        searchInput.addEventListener('wheel', handlePopoverWheel, { passive: false });

        // 候选框打开期间：拦截容器层滚轮，避免触发 Cytoscape 全局缩放
        const handleContainerWheelCapture = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            popover.scrollTop += e.deltaY;
        };
        this.container?.addEventListener('wheel', handleContainerWheelCapture, { passive: false, capture: true });

        // 候选框打开期间：临时禁用 Cytoscape 缩放/平移，避免画布交互干扰
        const prevZoomingEnabled = this.cy?.userZoomingEnabled() ?? true;
        const prevPanningEnabled = this.cy?.userPanningEnabled() ?? true;
        this.cy?.userZoomingEnabled(false);
        this.cy?.userPanningEnabled(false);

        // 搜索输入事件
        searchInput.addEventListener('input', (e) => {
            e.stopPropagation();
            searchTerm = (e.target as HTMLInputElement).value;
            updateFileList();
        });

        // 阻止搜索框的其他键盘事件冒泡到 Cytoscape（非导航键）
        searchInput.addEventListener('keyup', (e) => e.stopPropagation());
        searchInput.addEventListener('keypress', (e) => e.stopPropagation());

        // 更新选中高亮
        const updateSelection = () => {
            const items = popover.querySelectorAll('.suggester-item');
            items.forEach((item: any, index: number) => {
                if (index === selectedIndex) {
                    item.style.backgroundColor = 'var(--background-modifier-hover)';
                    // 滚动到可见区域
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.style.backgroundColor = '';
                }
            });
        };

        // 键盘导航
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                selectedIndex = Math.min(selectedIndex + 1, currentFiles.length - 1);
                updateSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                updateSelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (currentFiles[selectedIndex]) {
                    selectFile(currentFiles[selectedIndex]);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                popover.remove();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // 阻止删除键冒泡到 Cytoscape，允许在输入框中正常删除
                e.stopPropagation();
            }
        };

        // 监听键盘事件（在 textarea 和 searchInput 上）
        textarea.addEventListener('keydown', handleKeyDown);
        searchInput.addEventListener('keydown', handleKeyDown);

        // 将 popover 引用保存到外部变量，以便其他代码可以访问
        suggesterPopoverRef.value = popover;

        // suggester 移除时清理事件监听
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((removedNode) => {
                    if (removedNode === popover) {
                        textarea.removeEventListener('keydown', handleKeyDown);
                        searchInput.removeEventListener('keydown', handleKeyDown);
                        popover.removeEventListener('wheel', handlePopoverWheel as EventListener);
                        searchInput.removeEventListener('wheel', handlePopoverWheel as EventListener);
                        this.container?.removeEventListener('wheel', handleContainerWheelCapture as EventListener, true);
                        this.cy?.userZoomingEnabled(prevZoomingEnabled);
                        this.cy?.userPanningEnabled(prevPanningEnabled);
                        if (suggesterPopoverRef.value === popover) {
                            suggesterPopoverRef.value = null;
                        }
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(this.container!, { childList: true });

        if (popover.firstChild) {
            popover.insertBefore(searchInput, popover.firstChild);
        } else {
            popover.appendChild(searchInput);
        }

        if (this.container) {
            this.container.appendChild(popover);
        }

        // 自动聚焦搜索框
        const focusSearchInput = () => {
            searchInput.focus();
            searchInput.setSelectionRange(0, searchInput.value.length);
        };
        setTimeout(focusSearchInput, 0);
        requestAnimationFrame(() => requestAnimationFrame(focusSearchInput));
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (!this.cy || !this.container) return;

        // 绑定分组创建事件（Command + 拖动）- 已禁用
        // this.bindGroupCreationEvents();

        // 节点点击事件（单击选中；Command/Ctrl + 单击打开文件节点）
        this.cy.on('tap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 如果是分组节点或占位符节点，不触发普通节点点击事件
            if (data.isGroup) {
                return;
            }
            if (data.isPlaceholder) {
                return;  // 占位符节点不触发点击事件
            }

            // 清除之前的高亮（使用filter避免selector转义问题）
            this.cy?.edges('.child-edge-highlight').removeClass('child-edge-highlight');

            // 递归高亮所有后代节点的边
            const nodeId = node.id();
            const visited = new Set<string>();  // 防止循环引用导致无限递归
            const highlightChildEdges = (sourceNodeId: string) => {
                // 检查是否已访问过，避免循环引用
                if (visited.has(sourceNodeId)) {
                    return;
                }
                visited.add(sourceNodeId);

                // 获取从当前节点出发的所有边（使用filter避免selector转义问题）
                const outgoingEdges = this.cy?.edges().filter((edge: any) => edge.data('source') === sourceNodeId);
                if (!outgoingEdges || outgoingEdges.length === 0) {
                    return;
                }

                // 高亮当前层的边
                outgoingEdges.addClass('child-edge-highlight');

                // 递归处理子节点
                outgoingEdges.forEach((edge: any) => {
                    const targetNodeId = edge.data('target');
                    highlightChildEdges(targetNodeId);
                });
            };

            // 从当前节点开始递归高亮
            highlightChildEdges(nodeId);

            // Command/Ctrl + 单击：打开文件节点
            if ((originalEvent.metaKey || originalEvent.ctrlKey) && data.originalNode?.file && !data.isCrossDomain) {
                this.container?.dispatchEvent(new CustomEvent('node-click', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent,
                        ctrlKey: originalEvent.ctrlKey,
                        metaKey: originalEvent.metaKey,
                        shiftKey: originalEvent.shiftKey,
                        altKey: originalEvent.altKey
                    }
                }));
                return;
            }

            // 跨领域节点：单击只选中，不跳转（跳转到双击处理）
            if (data.isCrossDomain) {
                // 只选中节点，不触发跳转
                // 触发选中事件以便其他功能使用
                this.container?.dispatchEvent(new CustomEvent('node-select', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent
                    }
                }));
                return;
            }

            // 普通节点：单击只选中，不打开文件
            // 触发自定义事件（用于其他功能，如高亮等）
            this.container?.dispatchEvent(new CustomEvent('node-select', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent
                }
            }));
        });

        // 节点双击事件（编辑内容）
        this.cy.on('dbltap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 如果是分组节点，不触发
            if (data.isGroup) {
                return;
            }

            // 占位符节点：双击显示内联编辑器
            if (data.isPlaceholder) {
                this.showInlineNodeEditor(node);
                return;
            }

            // 跨领域节点：双击触发跳转
            if (data.isCrossDomain) {
                // 触发跳转事件，传递 originalNode
                this.container?.dispatchEvent(new CustomEvent('cross-domain-node-click', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent
                    }
                }));
                return;
            }

            // 普通节点：双击进入内联编辑
            this.showInlineNodeEditor(node);
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

            // 跨领域节点：发送专门的跨领域右键菜单事件
            if (data.isCrossDomain) {
                this.container?.dispatchEvent(new CustomEvent('cross-domain-contextmenu', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent,
                        position: {
                            x: renderedPosition.x,
                            y: renderedPosition.y
                        }
                    }
                }));
                return;
            }

            // 普通节点：发送普通的节点右键菜单事件
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
                // 清除子节点箭头高亮
                this.cy?.$('edge.child-edge-highlight').removeClass('child-edge-highlight');

                // 取消批量选择并隐藏工具栏
                if (this.batchSelectedNodeIds.length > 0) {
                    this.batchSelectedNodeIds = [];
                    this.batchSelectedNodes = [];
                    this.hideBatchToolbar();
                }

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

        // 监听添加占位符节点事件
        this.container?.addEventListener('add-placeholder-node', (event: any) => {
            const { nodeId, position, suggestedNodeId, parentNodeId } = event.detail;

            console.log('[CytoscapeRenderer] add-placeholder-node 事件触发', {
                nodeId,
                position,
                suggestedNodeId,
                parentNodeId,
                当前选中节点: this.cy?.$(':selected').length
            });

            try {
                // 直接在 Cytoscape 中添加占位符节点
                this.cy?.add({
                    group: 'nodes',
                    data: {
                        id: nodeId,
                        label: '',  // 不显示预生成的 ID，保持空白
                        isPlaceholder: true,
                        originalNode: null,
                        suggestedNodeId: suggestedNodeId,  // 存储预生成的节点 ID
                        parentNodeId: parentNodeId  // 存储父节点 ID
                    },
                    position: position
                });

                console.log('[CytoscapeRenderer] 节点已添加到 Cytoscape', nodeId);

                // 如果有父节点，创建连接线
                if (parentNodeId) {
                    setTimeout(() => {
                        const placeholderNode = this.cy?.$id(nodeId);
                        if (placeholderNode && placeholderNode.length > 0) {
                            this.createPlaceholderConnectionLine(nodeId, parentNodeId);
                        }
                    }, 50);
                }

                // 自动选中并打开编辑框
                setTimeout(() => {
                    const node = this.cy?.$id(nodeId);
                    console.log('[CytoscapeRenderer] 准备选中节点', {
                        nodeId,
                        nodeFound: node && node.length > 0,
                        当前选中: this.cy?.$(':selected').map((n: any) => n.id())
                    });

                    if (node && node.length > 0) {
                        // 取消其他节点的选中
                        const previouslySelected = this.cy!.$(':selected');
                        console.log('[CytoscapeRenderer] 取消选中', {
                            count: previouslySelected.length,
                            nodes: previouslySelected.map((n: any) => n.id())
                        });
                        previouslySelected.unselect();

                        // 选中这个节点
                        node.select();
                        console.log('[CytoscapeRenderer] 节点已选中', {
                            nodeId,
                            isPlaceholder: node.data('isPlaceholder'),
                            选中状态: node.selected(),
                            当前总选中数: this.cy?.$(':selected').length
                        });

                        // 延迟打开编辑器，确保选中完成
                        setTimeout(() => {
                            console.log('[CytoscapeRenderer] 准备打开编辑器', {
                                nodeId,
                                选中状态: node.selected()
                            });
                            this.showInlineNodeEditor(node);
                        }, 10);
                    } else {
                        console.error('[CytoscapeRenderer] 未找到节点', nodeId);
                    }
                }, 10);
            } catch (error) {
                console.error('[CytoscapeRenderer] Error adding placeholder node:', error);
            }
        });

        // 监听移除占位符节点事件
        this.container?.addEventListener('remove-placeholder-node', (event: any) => {
            const { nodeId } = event.detail;

            console.log('[CytoscapeRenderer] remove-placeholder-node 事件触发', { nodeId });

            // 先清理连接线（通过查询选择器，更可靠）
            const connectionLine = this.container?.querySelector(`.placeholder-connection-line[data-placeholder-id="${nodeId}"]`);
            if (connectionLine && connectionLine.parentNode) {
                console.log('[CytoscapeRenderer] 移除占位符连接线', { nodeId });
                connectionLine.parentNode.removeChild(connectionLine);
            }

            // 从 Cytoscape 中移除占位符节点
            const node = this.cy?.$id(nodeId);
            if (node && node.length > 0) {
                // 清理连接线（备用方法）
                const nodeData = node.data();
                const connectionLineFromData = (nodeData as any).connectionLine;

                if (connectionLineFromData && connectionLineFromData.parentNode) {
                    console.log('[CytoscapeRenderer] 从节点数据清理连接线', { nodeId });
                    connectionLineFromData.parentNode.removeChild(connectionLineFromData);
                }

                this.cy?.remove(node);
            }
        });

        // 监听节点移除事件，清理占位符节点的连接线
        this.cy?.on('remove', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            // 如果是占位符节点，清理连接线
            if (data.isPlaceholder) {
                const connectionLine = this.container?.querySelector(`.placeholder-connection-line[data-placeholder-id="${data.id}"]`);
                if (connectionLine && connectionLine.parentNode) {
                    console.log('[CytoscapeRenderer] 节点移除时自动清理连接线', { nodeId: data.id });
                    connectionLine.parentNode.removeChild(connectionLine);
                }
            }
        });

        // 监听清理所有占位符连接线事件（用于视图刷新时）
        this.container?.addEventListener('cleanup-all-placeholder-connections', () => {
            console.log('[CytoscapeRenderer] 清理所有占位符连接线');
            const connectionLines = this.container?.querySelectorAll('.placeholder-connection-line');
            if (connectionLines) {
                connectionLines.forEach(line => {
                    if (line.parentNode) {
                        line.parentNode.removeChild(line);
                    }
                });
                console.log(`[CytoscapeRenderer] 已清理 ${connectionLines.length} 条占位符连接线`);
            }
        });

        // 监听通过 ID 选中节点事件（用于新建节点后自动选中）
        this.container?.addEventListener('select-node-by-id', (event: any) => {
            const { nodeId } = event.detail;

            // 延迟执行，确保视图刷新完成
            setTimeout(() => {
                if (!this.cy) return;

                // 查找对应 ID 的节点
                const targetNode = this.cy.$('node').filter((node: any) => {
                    const data = node.data();
                    return data.originalNode && data.originalNode.IDStr === nodeId;
                });

                if (targetNode.length > 0) {
                    // 取消其他节点的选中
                    this.cy.$(':selected').unselect();

                    // 选中目标节点
                    targetNode.select();


                    // 将焦点设置到 container，确保方向键能工作
                    this.container?.focus();
                } else {
                    console.warn('[CytoscapeRenderer] 未找到节点', nodeId);
                }
            }, 10); // 延迟 200ms 确保视图刷新完成
        });

        // 节点拖动自动连接相关变量
        let tempConnectionLine: SVGLineElement | null = null;
        let svgOverlay: SVGSVGElement | null = null;
        let nearbyNodeId: string | null = null;
        const PROXIMITY_THRESHOLD = 250;  // 250px 范围

        // 节点开始拖动事件
        this.cy.on('grab', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const smartEnabled = this.isSmartConnectionEnabled();

            if (!smartEnabled) {
                if (tempConnectionLine && svgOverlay) {
                    svgOverlay.removeChild(tempConnectionLine);
                    tempConnectionLine = null;
                }
                this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');
                nearbyNodeId = null;
                return;
            }

            // 只对自由节点启用自动连接
            if (data.isPlaceholder || data.isGroup || data.isCrossDomain) return;

            // 检查是否是自由节点（ID 以 'free.' 开头）
            const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;

            if (!originalNodeId.startsWith('free.')) {
                return;  // 只允许自由节点拖动自动连接
            }

            // 创建 SVG 叠加层用于绘制连线
            if (!svgOverlay && this.container) {
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
                this.container.appendChild(svgOverlay);
            }
        });

        // 节点拖动事件
        this.cy.on('drag', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const smartEnabled = this.isSmartConnectionEnabled();

            if (!smartEnabled) {
                if (tempConnectionLine && svgOverlay) {
                    svgOverlay.removeChild(tempConnectionLine);
                    tempConnectionLine = null;
                }
                this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');
                nearbyNodeId = null;
                return;
            }

            // 处理占位符节点的智能连线
            if (data.isPlaceholder) {
                const pos = node.renderedPosition();

                // 查找最近的节点
                let nearestNode: any = null;
                let minDistance = Infinity;

                this.cy!.nodes().forEach((otherNode: any) => {
                    if (otherNode.id() === node.id()) return;  // 跳过自己
                    if (otherNode.data().isPlaceholder) return;  // 跳过其他占位符
                    if (otherNode.data().isGroup) return;  // 跳过分组

                    const otherPos = otherNode.renderedPosition();
                    const distance = Math.sqrt(
                        Math.pow(pos.x - otherPos.x, 2) +
                        Math.pow(pos.y - otherPos.y, 2)
                    );

                    if (distance < minDistance && distance < PROXIMITY_THRESHOLD) {
                        minDistance = distance;
                        nearestNode = otherNode;
                    }
                });

                // 移除旧的临时连接
                if (tempConnectionLine && svgOverlay) {
                    svgOverlay.removeChild(tempConnectionLine);
                    tempConnectionLine = null;
                }
                this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');
                nearbyNodeId = null;

                // 如果找到附近的节点，创建虚线连接
                if (nearestNode && svgOverlay) {
                    nearbyNodeId = nearestNode.id();

                    // 获取目标节点位置
                    const targetPos = nearestNode.renderedPosition();

                    // 创建 SVG 连线
                    tempConnectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    tempConnectionLine.setAttribute('x1', targetPos.x.toString());
                    tempConnectionLine.setAttribute('y1', targetPos.y.toString());
                    tempConnectionLine.setAttribute('x2', pos.x.toString());
                    tempConnectionLine.setAttribute('y2', pos.y.toString());
                    tempConnectionLine.setAttribute('stroke', '#10b981');  // 绿色表示可以连接
                    tempConnectionLine.setAttribute('stroke-width', '2');
                    tempConnectionLine.setAttribute('stroke-dasharray', '5,5');  // 虚线
                    svgOverlay.appendChild(tempConnectionLine);

                    // 高亮目标节点
                    nearestNode.addClass('connection-target-hover');
                }
                return;  // 处理完占位符节点后返回
            }

            // 只对自由节点启用自动连接
            if (data.isPlaceholder || data.isGroup || data.isCrossDomain) return;

            // 检查是否是自由节点（ID 以 'free.' 开头）
            const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;

            if (!originalNodeId.startsWith('free.')) {
                return;  // 只允许自由节点拖动自动连接
            }

            // 获取当前节点位置
            const pos = node.renderedPosition();

            // 查找最近的节点
            let nearestNode: any = null;
            let minDistance = Infinity;

            this.cy!.nodes().forEach((otherNode: any) => {
                if (otherNode.id() === node.id()) return;  // 跳过自己
                if (otherNode.data().isPlaceholder) return;  // 跳过占位符
                if (otherNode.data().isGroup) return;  // 跳过分组

                // 自由节点可以连接到任何节点（包括子节点）
                const otherPos = otherNode.renderedPosition();
                const distance = Math.sqrt(
                    Math.pow(pos.x - otherPos.x, 2) +
                    Math.pow(pos.y - otherPos.y, 2)
                );

                if (distance < minDistance && distance < PROXIMITY_THRESHOLD) {
                    minDistance = distance;
                    nearestNode = otherNode;
                }
            });

            // 移除旧的临时连接
            if (tempConnectionLine && svgOverlay) {
                svgOverlay.removeChild(tempConnectionLine);
                tempConnectionLine = null;
            }
            this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');
            nearbyNodeId = null;

            // 如果找到附近的节点，创建虚线连接
            if (nearestNode && svgOverlay) {
                nearbyNodeId = nearestNode.id();

                // 获取目标节点位置
                const targetPos = nearestNode.renderedPosition();

                // 创建 SVG 连线
                tempConnectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                tempConnectionLine.setAttribute('x1', targetPos.x.toString());
                tempConnectionLine.setAttribute('y1', targetPos.y.toString());
                tempConnectionLine.setAttribute('x2', pos.x.toString());
                tempConnectionLine.setAttribute('y2', pos.y.toString());
                tempConnectionLine.setAttribute('stroke', '#10b981');  // 绿色表示可以连接
                tempConnectionLine.setAttribute('stroke-width', '2');
                tempConnectionLine.setAttribute('stroke-dasharray', '5,5');  // 虚线
                svgOverlay.appendChild(tempConnectionLine);

                // 高亮目标节点
                nearestNode.addClass('connection-target-hover');
            }
        });

        // 节点拖动结束事件
        this.cy.on('dragfree', 'node', (evt: any) => {
            if (!evt || !evt.target) return;
            const node = evt.target;
            const data = node.data();
            const smartEnabled = this.isSmartConnectionEnabled();

            // 移除临时连接线和 SVG 叠加层
            if (tempConnectionLine && svgOverlay) {
                svgOverlay.removeChild(tempConnectionLine);
                tempConnectionLine = null;
            }
            this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');

            // 如果是分组节点，不触发位置保存
            if (data.isGroup) return;

            const position = node.position();

            // 处理占位符节点的智能连线
            if (data.isPlaceholder) {
                // 检查是否启用了智能连线并且有附近的节点
                if (smartEnabled && nearbyNodeId) {
                    const parentData = this.cy!.$id(nearbyNodeId).data();
                    const parentId = parentData.originalNode?.ID || parentData.originalSource || nearbyNodeId;
                    const placeholderId = data.id;

                    // 触发占位符节点自动连接事件
                    this.container?.dispatchEvent(new CustomEvent('placeholder-smart-connect', {
                        detail: {
                            placeholderId: placeholderId,
                            parentNodeId: parentId,
                            position: {
                                x: position.x,
                                y: position.y
                            }
                        }
                    }));

                    nearbyNodeId = null;
                }
                return;  // 占位符节点不保存位置
            }

            // 检查是否有自动连接（自由节点）
            if (smartEnabled && nearbyNodeId) {
                const parentData = this.cy!.$id(nearbyNodeId).data();

                // 使用 originalNode.ID（带点的格式）而不是转义后的 ID
                const childId = data.originalNode?.ID || data.originalSource || data.id;
                const parentId = parentData.originalNode?.ID || parentData.originalSource || nearbyNodeId;

                // 触发自动连接事件
                this.container?.dispatchEvent(new CustomEvent('auto-connect-node', {
                    detail: {
                        childNodeId: childId,
                        parentNodeId: parentId,
                        position: {
                            x: position.x,
                            y: position.y
                        }
                    }
                }));

                nearbyNodeId = null;
                return;
            }

            nearbyNodeId = null;

            // 跨领域节点：触发特殊的位置变化事件
            if (data.isCrossDomain) {
                const crossDomainLink = data.originalNode?.file;

                // 找到连接这个跨领域节点的边，获取源节点 ID
                const connectedEdges = this.cy!.$(`edge[type="cross-domain"][target="${data.id}"]`);
                let sourceNodeId = null;
                if (connectedEdges.length > 0) {
                    sourceNodeId = connectedEdges.first().data().originalSource;
                }

                this.container?.dispatchEvent(new CustomEvent('cross-domain-node-position-changed', {
                    detail: {
                        node: data.originalNode,
                        nodeId: data.id,
                        position: {
                            x: position.x,
                            y: position.y
                        },
                        // 获取跨领域链接信息和源节点 ID
                        crossDomainLink: crossDomainLink,
                        sourceNodeId: sourceNodeId
                    }
                }));
                return;
            }

            // 普通节点：触发位置变化事件
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

        // 节点释放事件（清理 SVG 叠加层）
        this.cy.on('free', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            // 只对自由节点进行清理
            const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;
            if (!originalNodeId.startsWith('free.')) {
                return;
            }

            // 延迟清理，确保 dragfree 事件已经处理完成
            setTimeout(() => {
                // 移除 SVG 叠加层
                if (svgOverlay && this.container) {
                    this.container.removeChild(svgOverlay);
                    svgOverlay = null;
                }

                if (tempConnectionLine) {
                    tempConnectionLine = null;
                }

                this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');
                nearbyNodeId = null;
            }, 0);
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
        this.cy.on('dbltap', 'edge', (evt: any) => {
            const edge = evt.target;
            const data = edge.data();

            // 允许编辑所有边的标签
            this.showInlineEdgeLabelEditor(edge);
        });

        // 边右键菜单事件（删除边）
        this.cy.on('cxttap', 'edge', (evt: any) => {
            const edge = evt.target;
            const data = edge.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 获取目标节点的 nodeSons 信息
            const targetNode = this.cy!.$id(data.target);
            if (!targetNode.length) return;

            const targetData = targetNode.data();
            const targetNodeSons = targetData.originalNode ? targetData.originalNode.nodeSons : 1;

            // 触发边右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('edge-contextmenu', {
                detail: {
                    edgeId: data.id,
                    source: data.originalSource || data.source,  // 使用原始 ID
                    target: data.originalTarget || data.target,  // 使用原始 ID
                    type: data.type,
                    label: data.label,
                    targetNodeSons: targetNodeSons,  // 添加目标节点的子节点数量
                    event: originalEvent,
                    position: {
                        x: originalEvent.clientX,
                        y: originalEvent.clientY
                    }
                }
            }));
        });

        // 画板拖动视觉反馈（当空格键按下并拖动时）
        this.cy.on('grab', () => {
            if (this.cy) {
                const container = this.cy.container();
                if (container) {
                    container.style.cursor = 'grabbing';
                }
            }
        });

        this.cy.on('free', () => {
            if (this.cy && this.cy.userPanningEnabled()) {
                const container = this.cy.container();
                if (container) {
                    container.style.cursor = 'grab';
                }
            }
        });

        // 监听视图状态变化（缩放和平移）
        // 使用防抖避免频繁触发
        let viewStateTimeout: NodeJS.Timeout | null = null;
        this.cy.on('zoom pan', () => {
            if (viewStateTimeout) clearTimeout(viewStateTimeout);
            viewStateTimeout = setTimeout(() => {
                const zoom = this.cy!.zoom();
                const pan = this.cy!.pan();
                this.container?.dispatchEvent(new CustomEvent('viewStateChanged', {
                    detail: { zoom, pan }
                }));
            }, 20); // 300ms 防抖
        });
    }

    /**
     * 绑定键盘事件
     */
    private bindKeyboardEvents(): void {
        if (!this.container) return;

        // 监听键盘按下事件
        const handleKeyDown = (event: KeyboardEvent) => {
            // Command/Meta 键：启用框选模式
            if ((event.key === 'Meta' || event.key === 'Meta') && !event.repeat) {
                this.isMetaPressed = true;
                if (this.cy) {
                    this.cy.boxSelectionEnabled(true);
                }
            }

            // Delete 或 Backspace 键
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (!this.cy) return;

                // 获取选中的元素
                const selected = this.cy.$(':selected');

                // 检查是否有选中的普通节点
                const selectedNodes = selected.filter('node[!isGroup]');

                if (selectedNodes.length > 0) {
                    // 阻止默认行为（避免浏览器后退）
                    event.preventDefault();
                    event.stopPropagation();

                    // 如果选中的节点 >= 2个，使用批量删除
                    if (selectedNodes.length >= 2) {
                        // 保存选中的节点 ID 和完整节点数据
                        this.batchSelectedNodeIds = [];
                        this.batchSelectedNodes = [];
                        selectedNodes.forEach((node: any) => {
                            const data = node.data();
                            if (data.originalNode && data.originalNode.IDStr) {
                                this.batchSelectedNodeIds.push(data.originalNode.IDStr);
                                // 保存完整节点数据，包含 isCrossDomain 等信息
                                this.batchSelectedNodes.push({
                                    IDStr: data.originalNode.IDStr,
                                    isCrossDomain: data.originalNode.isCrossDomain || false,
                                    originalNode: data.originalNode
                                });
                            }
                        });

                        // 触发批量删除
                        this.batchDeleteNodes();
                        return;
                    }

                    // 单个节点删除，使用现有的确认流程
                    selectedNodes.forEach((node: any) => {
                        const data = node.data();
                        const originalNode = data.originalNode;

                        if (originalNode) {
                            // 计算节点的关系数量（入边 + 出边）
                            const connectedEdges = node.connectedEdges();
                            const relationCount = connectedEdges.length;

                            this.container?.dispatchEvent(new CustomEvent('node-delete-key', {
                                detail: {
                                    node: originalNode,
                                    relationCount: relationCount
                                }
                            }));
                        }
                    });

                    return; // 处理完节点删除后返回
                }
                
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
                    
                    return;
                }
                
                // 检查是否有选中的边（所有类型）
                const selectedEdges = selected.filter('edge');

                if (selectedEdges.length > 0) {
                    // 阻止默认行为
                    event.preventDefault();
                    event.stopPropagation();

                    // 触发删除边事件
                    selectedEdges.forEach((edge: any) => {
                        const data = edge.data();

                        // 获取目标节点的 nodeSons 信息
                        const targetNode = this.cy!.$id(data.target);
                        if (!targetNode.length) return;

                        const targetData = targetNode.data();
                        const targetNodeSons = targetData.originalNode ? targetData.originalNode.nodeSons : 1;

                        this.container?.dispatchEvent(new CustomEvent('edge-delete-key', {
                            detail: {
                                edgeId: data.id,
                                source: data.originalSource || data.source,  // 使用原始 ID
                                target: data.originalTarget || data.target,  // 使用原始 ID
                                type: data.type,
                                label: data.label,
                                targetNodeSons: targetNodeSons  // 添加目标节点的子节点数量
                            }
                        }));
                    });
                }
            }

            // Tab 键：创建子节点
            if (event.key === 'Tab' && !event.shiftKey && !event.repeat) {
                event.preventDefault();
                this.handleCreateChildNode();
                return;
            }

            // Enter 键：创建兄弟节点（仅在没有打开内联编辑器时）
            if (event.key === 'Enter' && !event.repeat) {
                // 检查是否有打开的内联编辑器
                if (!this.container?.querySelector('.inline-node-editor')) {
                    event.preventDefault();
                    this.handleCreateSiblingNode();
                    return;
                }
            }

            // Shift+Tab 键：创建父节点
            if (event.key === 'Tab' && event.shiftKey && !event.repeat) {
                event.preventDefault();
                this.handleCreateParentNode();
                return;
            }

            // 方向键：切换选中节点
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.repeat) {
                // 检查是否有打开的内联编辑器
                const hasEditor = this.container?.querySelector('.inline-node-editor');

                if (!hasEditor) {
                    event.preventDefault();
                    this.handleArrowKeyNavigation(event.key);
                    return;
                } 
            }
        };

        // 监听键盘松开事件
        const handleKeyUp = (event: KeyboardEvent) => {
            // Command/Meta 键：禁用框选模式
            if (event.key === 'Meta') {
                this.isMetaPressed = false;
                if (this.cy) {
                    this.cy.boxSelectionEnabled(false);
                }
            }
        };

        // 添加事件监听器
        this.container.addEventListener('keydown', handleKeyDown);
        this.container.addEventListener('keyup', handleKeyUp);

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

    /**
     * 添加分组调整大小手柄
     */
    private addGroupResizeHandles(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的手柄容器
        const oldHandleContainer = this.container.querySelector('.zk-group-resize-handles');
        if (oldHandleContainer) {
            oldHandleContainer.remove();
        }

        // 创建手柄容器
        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-group-resize-handles';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 999;
        `;
        this.container.appendChild(handleContainer);

        let currentHandles: HTMLElement[] = [];
        let selectedGroup: any = null;
        let resizePreview: HTMLElement | null = null;  // 添加预览框

        // 清除所有手柄
        const clearHandles = () => {
            currentHandles.forEach(handle => handle.remove());
            currentHandles = [];
            selectedGroup = null;
            if (resizePreview) {
                resizePreview.remove();
                resizePreview = null;
            }
        };

        // 创建四个角的调整大小手柄
        const createResizeHandles = (groupNode: any) => {
            clearHandles();
            selectedGroup = groupNode;

            const positions = [
                { name: 'nw', cursor: 'nwse-resize', x: 0, y: 0 },      // 左上
                { name: 'ne', cursor: 'nesw-resize', x: 1, y: 0 },      // 右上
                { name: 'sw', cursor: 'nesw-resize', x: 0, y: 1 },      // 左下
                { name: 'se', cursor: 'nwse-resize', x: 1, y: 1 }       // 右下
            ];

            positions.forEach(pos => {
                const handle = document.createElement('div');
                handle.className = `zk-group-resize-handle zk-group-resize-${pos.name}`;
                handle.style.cssText = `
                    position: absolute;
                    width: 10px;
                    height: 10px;
                    background-color: #5b8fd9;
                    border: 2px solid #ffffff;
                    border-radius: 2px;
                    cursor: ${pos.cursor};
                    pointer-events: auto;
                    transform: translate(-50%, -50%);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    z-index: 1000;
                `;
                handleContainer.appendChild(handle);
                currentHandles.push(handle);


                // 绑定拖动事件
                this.bindResizeHandleDrag(handle, groupNode, pos, handleContainer);
            });

            // 更新手柄位置
            updateHandlePositions();
        };

        // 更新手柄位置
        const updateHandlePositions = () => {
            if (!selectedGroup || currentHandles.length === 0) return;
            if (!this.cy) return;

            const bb = selectedGroup.renderedBoundingBox();
            const positions = [
                { x: bb.x1, y: bb.y1 },  // 左上
                { x: bb.x2, y: bb.y1 },  // 右上
                { x: bb.x1, y: bb.y2 },  // 左下
                { x: bb.x2, y: bb.y2 }   // 右下
            ];


            currentHandles.forEach((handle, index) => {
                handle.style.left = `${positions[index].x}px`;
                handle.style.top = `${positions[index].y}px`;
            });
        };

        // 监听分组节点选中事件
        this.cy.on('select', 'node[?isGroup]', (evt: any) => {
            const groupNode = evt.target;
            createResizeHandles(groupNode);
        });

        // 监听分组节点取消选中事件
        this.cy.on('unselect', 'node[?isGroup]', () => {
            clearHandles();
        });

        // 监听视图变化，更新手柄位置
        this.cy.on('pan zoom viewport', () => {
            if (selectedGroup) {
                updateHandlePositions();
            }
        });

        // 监听分组节点移动
        this.cy.on('position', 'node[?isGroup]', (evt: any) => {
            if (evt.target === selectedGroup) {
                updateHandlePositions();
            }
        });
    }

    /**
     * 绑定调整大小手柄的拖动事件
     */
    private bindResizeHandleDrag(
        handle: HTMLElement,
        groupNode: any,
        position: { name: string; cursor: string; x: number; y: number },
        handleContainer: HTMLElement
    ): void {
        if (!this.cy || !this.container) return;

        let isDragging = false;
        let startMousePos: { x: number; y: number } | null = null;
        let startBoundingBox: any = null;
        let originalNodeIds: string[] = [];
        let resizePreview: HTMLElement | null = null;

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            startMousePos = { x: e.clientX, y: e.clientY };
            startBoundingBox = groupNode.renderedBoundingBox();
            
            // 记录原始节点列表
            originalNodeIds = groupNode.data('nodeIds') || [];


            // 创建预览框
            resizePreview = document.createElement('div');
            resizePreview.className = 'zk-group-resize-preview';
            resizePreview.style.cssText = `
                position: absolute;
                border: 2px dashed #5b8fd9;
                background-color: rgba(91, 143, 217, 0.1);
                pointer-events: none;
                z-index: 998;
            `;
            handleContainer.appendChild(resizePreview);

            // 禁用 Cytoscape 的平移
            if (this.cy) {
                this.cy.userPanningEnabled(false);
                this.cy.boxSelectionEnabled(false);
            }

            // 添加全局鼠标移动和释放监听器
            const handleMouseMove = (e: MouseEvent) => {
                if (!isDragging || !startMousePos || !startBoundingBox || !this.cy) return;

                // 将屏幕坐标转换为渲染坐标
                const zoom = this.cy.zoom();
                const pan = this.cy.pan();
                
                const deltaX = (e.clientX - startMousePos.x);
                const deltaY = (e.clientY - startMousePos.y);

                // 计算新的边界框
                let newX1 = startBoundingBox.x1;
                let newY1 = startBoundingBox.y1;
                let newX2 = startBoundingBox.x2;
                let newY2 = startBoundingBox.y2;

                // 根据手柄位置调整边界
                if (position.x === 0) {
                    newX1 += deltaX;  // 左边
                } else {
                    newX2 += deltaX;  // 右边
                }

                if (position.y === 0) {
                    newY1 += deltaY;  // 上边
                } else {
                    newY2 += deltaY;  // 下边
                }

                // 确保最小尺寸
                const minSize = 50;
                if (newX2 - newX1 < minSize || newY2 - newY1 < minSize) {
                    return;
                }

                // 查找新边界内的所有节点
                const nodesInBounds: any[] = [];
                this.cy.nodes('[!isGroup]').forEach((node: any) => {
                    const nodeBB = node.renderedBoundingBox();
                    const nodeCenterX = (nodeBB.x1 + nodeBB.x2) / 2;
                    const nodeCenterY = (nodeBB.y1 + nodeBB.y2) / 2;

                    // 检查节点中心是否在新边界内
                    if (nodeCenterX >= newX1 && nodeCenterX <= newX2 &&
                        nodeCenterY >= newY1 && nodeCenterY <= newY2) {
                        nodesInBounds.push(node);
                    }
                });


                // 更新预览框位置
                if (resizePreview) {
                    resizePreview.style.left = `${newX1}px`;
                    resizePreview.style.top = `${newY1}px`;
                    resizePreview.style.width = `${newX2 - newX1}px`;
                    resizePreview.style.height = `${newY2 - newY1}px`;
                }

                // 更新分组的节点列表（视觉预览）
                // 过滤掉占位符节点
                const newNodeIds = nodesInBounds
                    .filter(n => n.data('originalNode') && !n.data('isPlaceholder'))
                    .map(n => n.data('originalNode').ID);


                // 临时更新分组边界（通过调整子节点）
                // 注意：这里只是视觉预览，实际更新在 mouseup 时进行
                nodesInBounds.forEach(node => {
                    if (!node.data('isPlaceholder') &&
                        node.data('originalNode') &&
                        !originalNodeIds.includes(node.data('originalNode').ID)) {
                        // 新加入的节点，临时设置为分组的子节点
                        node.data('parent', groupNode.id());
                    }
                });

                // 移除不在边界内的节点
                this.cy.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                    if (!node.data('isPlaceholder') && node.data('originalNode')) {
                        const nodeId = node.data('originalNode').ID;
                        if (!newNodeIds.includes(nodeId)) {
                            node.data('parent', undefined);
                        }
                    }
                });
            };

            const handleMouseUp = (e: MouseEvent) => {
                if (!isDragging) return;

                isDragging = false;

                // 移除预览框
                if (resizePreview) {
                    resizePreview.remove();
                    resizePreview = null;
                }

                // 恢复 Cytoscape 的平移
                if (this.cy) {
                    this.cy.userPanningEnabled(true);
                    this.cy.boxSelectionEnabled(true);
                }

                // 重新计算最终边界（使用最终鼠标位置）
                if (startMousePos && startBoundingBox && this.cy) {
                    const deltaX = e.clientX - startMousePos.x;
                    const deltaY = e.clientY - startMousePos.y;

                    let newX1 = startBoundingBox.x1;
                    let newY1 = startBoundingBox.y1;
                    let newX2 = startBoundingBox.x2;
                    let newY2 = startBoundingBox.y2;

                    if (position.x === 0) {
                        newX1 += deltaX;
                    } else {
                        newX2 += deltaX;
                    }

                    if (position.y === 0) {
                        newY1 += deltaY;
                    } else {
                        newY2 += deltaY;
                    }


                    // 确保最小尺寸
                    const minSize = 50;
                    if (newX2 - newX1 >= minSize && newY2 - newY1 >= minSize) {
                        // 查找最终边界内的所有节点
                        const nodesInBounds: any[] = [];
                        this.cy.nodes('[!isGroup]').forEach((node: any) => {
                            const nodeBB = node.renderedBoundingBox();
                            const nodeCenterX = (nodeBB.x1 + nodeBB.x2) / 2;
                            const nodeCenterY = (nodeBB.y1 + nodeBB.y2) / 2;

                            if (nodeCenterX >= newX1 && nodeCenterX <= newX2 &&
                                nodeCenterY >= newY1 && nodeCenterY <= newY2) {
                                nodesInBounds.push(node);
                            }
                        });


                        // 清除所有当前的 parent 关系
                        this.cy.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                            node.data('parent', undefined);
                        });

                        // 设置新的 parent 关系
                        nodesInBounds.forEach(node => {
                            const currentParent = node.data('parent');
                            const isGroup = node.data('isGroup');
                            const nodeId = node.data('originalNode')?.ID || node.id();
                    
                            // 分组节点不能作为子节点
                            if (isGroup) {
                                return;
                            }
                            
                            // 使用 move() 方法移动节点到新的 parent
                            try {
                                if (currentParent !== groupNode.id()) {
                                    node.move({ parent: groupNode.id() });

                                }
                            } catch (error) {
                                console.warn('  Failed to move node:', error);
                            }
                        });                    
                    }
                }

                // 获取最终的节点列表
                const finalNodeIds: string[] = [];
                this.cy?.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                    if (!node.data('isPlaceholder') && node.data('originalNode')) {
                        const nodeId = node.data('originalNode').ID;
                        finalNodeIds.push(nodeId);
                    }
                });


                // 更新分组的 nodeIds 数据
                groupNode.data('nodeIds', finalNodeIds);

                // 强制 Cytoscape 重新计算分组边界
                if (this.cy) {
                    // 触发布局更新
                    this.cy.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                        node.trigger('position');
                    });
                    
                    // 强制重绘
                    this.cy.forceRender();
                }

                // 触发分组更新事件
                if (finalNodeIds.length > 0 && 
                    JSON.stringify(finalNodeIds.sort()) !== JSON.stringify(originalNodeIds.sort())) {
                    this.container?.dispatchEvent(new CustomEvent('group-resize', {
                        detail: {
                            groupId: groupNode.id(),
                            groupLabel: groupNode.data('label'),
                            nodeIds: finalNodeIds
                        }
                    }));
                }

                // 移除全局监听器
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
    }

    /**
     * 选择选择框内的节点
     */
    private selectNodesInBox(left: number, top: number, width: number, height: number): void {
        if (!this.cy) return;

        const nodes = this.cy.nodes().filter((node: any) => !node.data('isGroup'));

        nodes.forEach((node: any) => {
            const bbox = node.renderedBoundingBox();
            const intersects = !(
                bbox.x2 < left ||
                bbox.x1 > left + width ||
                bbox.y2 < top ||
                bbox.y1 > top + height
            );

            if (intersects) {
                node.select();
            }
        });
    }

    /**
     * 初始化框选功能
     */
    private initBoxSelection(): void {
        if (!this.cy || !this.container) return;

        // 创建选择框元素
        const selectionBox = document.createElement('div');
        selectionBox.className = 'zk-selection-box';
        selectionBox.style.cssText = `
            position: absolute;
            display: none;
            border: 2px dashed #5b8fd9;
            background-color: rgba(91, 143, 217, 0.1);
            border-radius: 4px;
            pointer-events: none;
            z-index: 9999;
        `;
        this.container.appendChild(selectionBox);

        let isDragging = false;
        let hasMoved = false;  // 标记是否真正移动了鼠标
        let startX = 0;
        let startY = 0;
        let isMultiSelect = false;

        // 鼠标按下开始框选
        this.container.addEventListener('mousedown', (e: MouseEvent) => {
            const target = e.target as HTMLElement;

            // 只在 canvas 上点击时才开始框选
            if (target.tagName !== 'CANVAS') return;

            // 只有左键（button === 0）才能触发框选
            if (e.button !== 0) return;

            // 必须按住 Command 键才能开始框选
            if (!e.metaKey && !e.ctrlKey) return;

            // 检查点击位置是否有节点
            if (this.cy) {
                const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
                const clickX = e.clientX - rect.left;
                const clickY = e.clientY - rect.top;

                // 检查点击位置是否在某个节点上
                const clickedNode = this.cy.$('node').filter((node: any) => {
                    const bbox = node.renderedBoundingBox();
                    return clickX >= bbox.x1 && clickX <= bbox.x2 &&
                           clickY >= bbox.y1 && clickY <= bbox.y2;
                });

                // 如果点击在节点上，不开始框选
                if (clickedNode.length > 0) {
                    return;
                }
            }

            // 检查是否按住多选键
            isMultiSelect = e.shiftKey || e.ctrlKey || e.metaKey;

            // 如果没有按住多选键，先清除现有选择
            if (!isMultiSelect && this.cy) {
                this.cy.$(':selected').unselect();
                this.hideBatchToolbar();
            }

            const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;
            isDragging = true;
            hasMoved = false;  // 重置移动标记

            // 显示选择框
            selectionBox.style.display = 'block';
            selectionBox.style.left = `${startX}px`;
            selectionBox.style.top = `${startY}px`;
            selectionBox.style.width = '0px';
            selectionBox.style.height = '0px';

            e.preventDefault();
        });

        // 鼠标移动更新选择框
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;

            const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
            const currentX = e.clientX - rect.left;
            const currentY = e.clientY - rect.top;

            // 检查是否移动了足够的距离（避免误触）
            if (Math.abs(currentX - startX) > 5 || Math.abs(currentY - startY) > 5) {
                hasMoved = true;
            }

            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);

            selectionBox.style.left = `${left}px`;
            selectionBox.style.top = `${top}px`;
            selectionBox.style.width = `${width}px`;
            selectionBox.style.height = `${height}px`;

            // 选择框内的节点
            this.selectNodesInBox(left, top, width, height);
        };

        // 鼠标释放结束框选
        const handleMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;

            // 隐藏选择框
            selectionBox.style.display = 'none';

            // 只有在真正移动了鼠标（框选操作）时才显示批量工具栏
            if (hasMoved) {
                setTimeout(() => {
                    this.showBatchToolbar();
                }, 20);
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }

    /**
     * 显示批量操作工具栏
     */
    private showBatchToolbar(): void {
        if (!this.cy || !this.container) return;

        const selectedNodes = this.cy.$(':selected').filter('node[!isGroup]');
        const count = selectedNodes.length;

        if (count < 2) {
            this.hideBatchToolbar();
            return;
        }

        // 保存选中的节点ID（使用 originalNode.IDStr）
        this.batchSelectedNodeIds = [];
        this.batchSelectedNodes = [];
        selectedNodes.forEach((node: any) => {
            const data = node.data();
            if (data.originalNode && data.originalNode.IDStr) {
                this.batchSelectedNodeIds.push(data.originalNode.IDStr);
                // 保存完整节点数据，包含 isCrossDomain 等信息
                this.batchSelectedNodes.push({
                    IDStr: data.originalNode.IDStr,
                    isCrossDomain: data.originalNode.isCrossDomain || false,
                    originalNode: data.originalNode
                });
            }
        });

        let toolbar = document.getElementById('zk-batch-toolbar');
        if (!toolbar) {
            toolbar = this.createBatchToolbar();
            this.container.appendChild(toolbar);
        }

        // 更新位置到选中区域上方
        let minY = Infinity;
        let minX = Infinity;
        selectedNodes.forEach((node: any) => {
            const pos = node.renderedPosition();
            minY = Math.min(minY, pos.y);
            minX = Math.min(minX, pos.x);
        });

        toolbar.style.top = `${Math.max(10, minY - 60)}px`;
        toolbar.style.left = `${minX}px`;

        // 更新计数
        const countLabel = toolbar.querySelector('.zk-batch-count');
        if (countLabel) {
            countLabel.textContent = `已选中 ${count} 个节点`;
        }
    }

    /**
     * 隐藏批量操作工具栏
     */
    private hideBatchToolbar(): void {
        const toolbar = document.getElementById('zk-batch-toolbar');
        if (toolbar) {
            toolbar.remove();
        }
    }

    /**
     * 创建批量操作工具栏
     */
    private createBatchToolbar(): HTMLElement {
        const toolbar = document.createElement('div');
        toolbar.id = 'zk-batch-toolbar';
        toolbar.style.cssText = `
            position: absolute;
            background-color: var(--background-secondary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 8px 12px;
            display: flex;
            gap: 8px;
            z-index: 10000;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        `;

        // 计数标签
        const countLabel = document.createElement('span');
        countLabel.className = 'zk-batch-count';
        countLabel.style.cssText = `
            font-size: 13px;
            color: var(--text-normal);
            font-weight: 500;
            padding-right: 8px;
            border-right: 1px solid var(--background-modifier-border);
        `;
        countLabel.textContent = '已选中 0 个节点';
        toolbar.appendChild(countLabel);

        // 分组按钮
        const groupBtn = this.createToolbarButton('📦 分组', () => this.batchCreateGroup());
        toolbar.appendChild(groupBtn);

        // 删除按钮
        const deleteBtn = this.createToolbarButton('🗑️ 删除', () => this.batchDeleteNodes());
        toolbar.appendChild(deleteBtn);

        // 改颜色按钮
        const colorBtn = this.createToolbarButton('🎨 改颜色', () => this.batchChangeColor());
        toolbar.appendChild(colorBtn);

        // 取消按钮
        const cancelBtn = this.createToolbarButton('✕ 取消', () => {
            if (this.cy) {
                this.cy.$(':selected').unselect();
            }
            this.hideBatchToolbar();
        });
        toolbar.appendChild(cancelBtn);

        return toolbar;
    }

    /**
     * 创建工具栏按钮
     */
    private createToolbarButton(text: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = `
            padding: 6px 12px;
            background-color: var(--interactive-normal);
            color: var(--text-normal);
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        `;
        btn.onmouseover = () => btn.style.backgroundColor = 'var(--interactive-hover)';
        btn.onmouseout = () => btn.style.backgroundColor = 'var(--interactive-normal)';

        // 防止按下工具栏按钮时触发底层画布点击/取消选中
        btn.onpointerdown = (event: PointerEvent) => {
            event.preventDefault();
            event.stopPropagation();
        };
        btn.onmousedown = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
        };

        btn.onclick = (event: MouseEvent) => {
            event.stopPropagation(); // 阻止事件冒泡到画布
            onClick();
        };

        return btn;
    }

    /**
     * 批量创建分组
     */
    private batchCreateGroup(): void {
        if (this.batchSelectedNodeIds.length === 0) {
            return;
        }

        // 先隐藏工具栏，避免遮挡输入框
        this.hideBatchToolbar();

        // 批量分组：统一走 batch-create-group 事件链路（由 indexView 持久化）
        this.showGroupNameDialog((groupName) => {
            if (!groupName) {
                // 取消时恢复工具栏
                this.showBatchToolbar();
                return;
            }

            this.container?.dispatchEvent(new CustomEvent('batch-create-group', {
                detail: {
                    nodeIds: [...this.batchSelectedNodeIds],
                    groupName
                }
            }));

            // 清空选中缓存
            this.batchSelectedNodeIds = [];
            this.batchSelectedNodes = [];
        });
    }

    /**
     * 获取当前活动的节点（第一个选中的节点）
     */
    private getActiveNode(): any | null {
        if (!this.cy) return null;

        const selectedNodes = this.cy.$('node:selected');

        console.log('[getActiveNode] 当前选中的节点', {
            count: selectedNodes.length,
            nodes: selectedNodes.map((n: any) => ({
                id: n.id(),
                IDStr: n.data().originalNode?.IDStr,
                label: n.data().label
            }))
        });

        if (selectedNodes.length === 0) {
            new Notice('请先选择一个节点');
            return null;
        }

        return selectedNodes.first();
    }

    private normalizeVector(vx: number, vy: number): { x: number; y: number } {
        const len = Math.hypot(vx, vy);
        if (len < 1e-6) return { x: 1, y: 0 };
        return { x: vx / len, y: vy / len };
    }

    private getBranchDirection(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const parent = activeNode.incomers('edge').sources();
        if (parent.length > 0) {
            const parentPos = parent.first().position();
            return this.normalizeVector(nodePos.x - parentPos.x, nodePos.y - parentPos.y);
        }

        // 根节点：优先使用占用最少的象限方向
        const children = activeNode.outgoers('edge').targets();
        if (children.length === 0) return { x: 1, y: 0 };

        const cardinal = [
            { x: 1, y: 0 },   // 右
            { x: -1, y: 0 },  // 左
            { x: 0, y: 1 },   // 下
            { x: 0, y: -1 }   // 上
        ];
        const score = [0, 0, 0, 0];

        children.forEach((child: any) => {
            const cp = child.position();
            const dir = this.normalizeVector(cp.x - nodePos.x, cp.y - nodePos.y);
            let bestIndex = 0;
            let bestDot = -Infinity;
            cardinal.forEach((c, idx) => {
                const dot = dir.x * c.x + dir.y * c.y;
                if (dot > bestDot) {
                    bestDot = dot;
                    bestIndex = idx;
                }
            });
            score[bestIndex] += 1;
        });

        let minIdx = 0;
        for (let i = 1; i < score.length; i++) {
            if (score[i] < score[minIdx]) minIdx = i;
        }
        return cardinal[minIdx];
    }

    private getPerpendicular(dir: { x: number; y: number }): { x: number; y: number } {
        return { x: -dir.y, y: dir.x };
    }

    private nextOffsetByProjection(points: any[], anchor: { x: number; y: number }, normal: { x: number; y: number }, gap: number): number {
        const projections = points.map((n: any) => {
            const p = n.position();
            return (p.x - anchor.x) * normal.x + (p.y - anchor.y) * normal.y;
        });

        if (projections.length === 0) return 0;

        // 让新增节点延续当前侧向增长：优先正向堆叠，碰撞则继续外扩
        let offset = Math.max(...projections) + gap;
        const isOccupied = (candidate: number) => projections.some(v => Math.abs(v - candidate) < gap * 0.8);
        while (isOccupied(offset)) {
            offset += gap;
        }
        return offset;
    }

    /**
     * 处理创建子节点（Tab 键）
     * SimpleMind 风格：子节点基于视觉位置而非 ID
     */
    private handleCreateChildNode(): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodeData = activeNode.data();
        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;
        const nodePos = activeNode.position();
        const children = activeNode.outgoers('edge').targets();
        const dir = this.getBranchDirection(activeNode);
        const normal = this.getPerpendicular(dir);

        const anchor = {
            x: nodePos.x + dir.x * this.HORIZONTAL_GAP,
            y: nodePos.y + dir.y * this.HORIZONTAL_GAP
        };
        const offset = this.nextOffsetByProjection(children, anchor, normal, this.VERTICAL_GAP);
        const position = {
            x: anchor.x + normal.x * offset,
            y: anchor.y + normal.y * offset
        };

        this.container?.dispatchEvent(new CustomEvent('create-child-node-shortcut', {
            detail: { activeNodeId, position }
        }));
    }

    /**
     * 处理创建兄弟节点（Enter 键）
     * SimpleMind 风格：自动推开下方的兄弟节点及其子树
     */
    private handleCreateSiblingNode(): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodeData = activeNode.data();
        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;
        const nodePos = activeNode.position();
        const parent = activeNode.incomers('edge').sources();
        if (parent.length === 0) return;

        const parentPos = parent.first().position();
        const siblings = parent.first().outgoers('edge').targets();
        const dir = this.normalizeVector(nodePos.x - parentPos.x, nodePos.y - parentPos.y);
        const normal = this.getPerpendicular(dir);
        const siblingGap = Math.max(this.SIBLING_GAP, this.VERTICAL_GAP + 40);
        const anchor = {
            x: parentPos.x + dir.x * this.HORIZONTAL_GAP,
            y: parentPos.y + dir.y * this.HORIZONTAL_GAP
        };
        const activeProj = (nodePos.x - anchor.x) * normal.x + (nodePos.y - anchor.y) * normal.y;
        let offset = activeProj + siblingGap;

        const projections = siblings.map((sib: any) => {
            const p = sib.position();
            return (p.x - anchor.x) * normal.x + (p.y - anchor.y) * normal.y;
        });
        const isOccupied = (candidate: number) => projections.some((v: number) => Math.abs(v - candidate) < siblingGap * 0.8);
        while (isOccupied(offset)) {
            offset += siblingGap;
        }

        const position = {
            x: anchor.x + normal.x * offset,
            y: anchor.y + normal.y * offset
        };

        // 触发创建兄弟节点事件
        this.container?.dispatchEvent(new CustomEvent('create-sibling-node-shortcut', {
            detail: {
                activeNodeId: activeNodeId,
                position: position
            }
        }));
    }

    /**
     * 处理创建父节点（Shift+Tab 键）
     */
    private handleCreateParentNode(): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodePos = activeNode.position();
        const dir = this.getBranchDirection(activeNode);
        const position = {
            x: nodePos.x - dir.x * this.HORIZONTAL_GAP,
            y: nodePos.y - dir.y * this.HORIZONTAL_GAP
        };
        const nodeData = activeNode.data();

        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;


        // 触发创建父节点事件
        this.container?.dispatchEvent(new CustomEvent('create-parent-node-shortcut', {
            detail: {
                activeNodeId: activeNodeId,
                position: position
            }
        }));
    }

    /**
     * 创建占位符节点到父节点的连接线（绿色虚线）
     */
    private createPlaceholderConnectionLine(placeholderNodeId: string, parentNodeId: string): void {
        if (!this.cy || !this.container) return;

        const placeholderNode = this.cy.$id(placeholderNodeId);
        const parentNode = this.cy.$('node').filter((node: any) => {
            const data = node.data();
            return data.originalNode && data.originalNode.IDStr === parentNodeId;
        });

        if (!placeholderNode || placeholderNode.length === 0) {
            console.warn('[CytoscapeRenderer] 未找到占位符节点', placeholderNodeId);
            return;
        }

        if (!parentNode || parentNode.length === 0) {
            console.warn('[CytoscapeRenderer] 未找到父节点', parentNodeId);
            return;
        }

        console.log('[CytoscapeRenderer] 创建占位符连接线', { placeholderNodeId, parentNodeId });

        // 创建 SVG 叠加层（如果不存在）
        let svgOverlay = this.container.querySelector('.placeholder-connections-svg') as SVGSVGElement;
        if (!svgOverlay) {
            svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgOverlay.classList.add('placeholder-connections-svg');
            svgOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 1;
            `;
            this.container.appendChild(svgOverlay);
        }

        // 创建连接线 - 使用绿色虚线（与智能连线一致）
        const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        connectionLine.setAttribute('stroke', '#10b981');  // 淡绿色
        connectionLine.setAttribute('stroke-width', '2');
        connectionLine.setAttribute('stroke-dasharray', '5,5');  // 虚线
        connectionLine.setAttribute('opacity', '0.8');
        connectionLine.classList.add('placeholder-connection-line');
        connectionLine.setAttribute('data-placeholder-id', placeholderNodeId);

        // 初始位置
        const placeholderPos = placeholderNode.renderedPosition();
        const parentPos = parentNode.renderedPosition();
        connectionLine.setAttribute('x1', parentPos.x.toString());
        connectionLine.setAttribute('y1', parentPos.y.toString());
        connectionLine.setAttribute('x2', placeholderPos.x.toString());
        connectionLine.setAttribute('y2', placeholderPos.y.toString());

        svgOverlay.appendChild(connectionLine);

        // 保存连接线引用
        const nodeData = placeholderNode.data();
        (nodeData as any).connectionLine = connectionLine;
        (nodeData as any).connectionParentNode = parentNode;

        console.log('[CytoscapeRenderer] 连接线已创建', {
            from: parentNodeId,
            to: placeholderNodeId
        });

        // 更新连接线位置的函数
        const updateConnectionLine = () => {
            if (!this.cy || !connectionLine.parentNode) return;

            const currentPlaceholder = this.cy.$id(placeholderNodeId);
            const currentParent = this.cy.$('node').filter((node: any) => {
                const data = node.data();
                return data.originalNode && data.originalNode.IDStr === parentNodeId;
            });

            if (currentPlaceholder && currentPlaceholder.length > 0 &&
                currentParent && currentParent.length > 0) {
                const newPos = currentPlaceholder.renderedPosition();
                const parentPos = currentParent.renderedPosition();

                connectionLine.setAttribute('x1', parentPos.x.toString());
                connectionLine.setAttribute('y1', parentPos.y.toString());
                connectionLine.setAttribute('x2', newPos.x.toString());
                connectionLine.setAttribute('y2', newPos.y.toString());
            }
        };

        // 监听位置变化
        const updateHandler = () => {
            requestAnimationFrame(updateConnectionLine);
        };

        // 监听占位符节点的位置变化
        placeholderNode.on('position', updateHandler);
        parentNode.on('position', updateHandler);

        // 监听视图的缩放和平移
        this.cy.on('zoom pan', updateHandler);

        // 保存更新处理器引用，以便后续清理
        (nodeData as any).connectionLineUpdater = updateHandler;

        console.log('[CytoscapeRenderer] 连接线监听器已设置');
    }

    /**
     * 处理方向键导航
     */
    private handleArrowKeyNavigation(key: string): void {
        if (!this.cy) return;

        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodePosition = activeNode.position();
        const allNodes = this.cy.nodes().filter(node => !node.data().isPlaceholder);

        // 根据方向键找到最近的节点
        let targetNode: any | null = null;
        let minDistance = Infinity;

        allNodes.forEach((node: any) => {
            // 跳过当前节点
            if (node.id() === activeNode.id()) return;

            const nodePos = node.position();
            const dx = nodePos.x - nodePosition.x;
            const dy = nodePos.y - nodePosition.y;

            // 检查节点是否在指定方向上
            let isInDirection = false;
            switch (key) {
                case 'ArrowUp':
                    isInDirection = dy < 0 && Math.abs(dx) < Math.abs(dy);
                    break;
                case 'ArrowDown':
                    isInDirection = dy > 0 && Math.abs(dx) < Math.abs(dy);
                    break;
                case 'ArrowLeft':
                    isInDirection = dx < 0 && Math.abs(dx) > Math.abs(dy);
                    break;
                case 'ArrowRight':
                    isInDirection = dx > 0 && Math.abs(dx) > Math.abs(dy);
                    break;
            }

            if (isInDirection) {
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < minDistance) {
                    minDistance = distance;
                    targetNode = node;
                }
            }
        });

        if (targetNode) {
            // 取消当前选中
            this.cy.$(':selected').unselect();

            // 选中目标节点
            targetNode.select();

            // 可选：将视图中心移到选中的节点
            // this.cy.animate({
            //     center: { eles: targetNode },
            //     zoom: this.cy.zoom()
            // }, {
            //     duration: 200
            // });
        }
    }

    /**
     * 批量删除节点
     */
    private batchDeleteNodes(): void {
        if (this.batchSelectedNodeIds.length === 0) return;
        const nodeIdsSnapshot = [...this.batchSelectedNodeIds];
        const nodesSnapshot = this.batchSelectedNodes.map((n: any) => ({ ...n }));

        // 先隐藏工具栏，避免遮挡对话框
        this.hideBatchToolbar();

        // 创建确认对话框
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 15px;
            min-width: 300px;
        `;

        const title = document.createElement('h3');
        title.textContent = '确认删除';
        title.style.margin = '0';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.textContent = `确认删除 ${nodeIdsSnapshot.length} 个节点？`;
        message.style.margin = '0';
        dialog.appendChild(message);

        const buttonContainer = document.createElement('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.justifyContent = 'flex-end';

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '确认';
        confirmBtn.onclick = () => {
            // 触发批量删除事件
            this.container?.dispatchEvent(new CustomEvent('batch-delete-nodes', {
                detail: {
                    nodeIds: nodeIdsSnapshot,
                    nodes: nodesSnapshot
                }
            }));

            overlay.remove();

            // 清除选择并清空节点ID
            if (this.cy) {
                this.cy.$(':selected').unselect();
            }
            this.batchSelectedNodeIds = [];
            this.batchSelectedNodes = [];
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = () => {
            overlay.remove();
            // 用户取消，重新显示工具栏
            this.showBatchToolbar();
        };

        buttonContainer.appendChild(confirmBtn);
        buttonContainer.appendChild(cancelBtn);
        dialog.appendChild(buttonContainer);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    /**
     * 批量改变颜色
     */
    private batchChangeColor(): void {
        if (this.batchSelectedNodeIds.length === 0) return;
        const nodeIdsSnapshot = [...this.batchSelectedNodeIds];

        // 先隐藏工具栏
        this.hideBatchToolbar();

        // 触发批量颜色选择事件
        this.container?.dispatchEvent(new CustomEvent('batch-show-color-picker', {
            detail: { nodeIds: nodeIdsSnapshot }
        }));
    }

    /**
     * 检查智能连线功能是否启用
     */
    private isSmartConnectionEnabled(): boolean {
        if (this.currentOptions && typeof this.currentOptions.smartConnection === 'boolean') {
            return this.currentOptions.smartConnection;
        }

        // 从全局设置中获取智能连线开关状态
        const app = (window as any).app;
        if (!app || !app.plugins) return false;

        const plugin = app.plugins.plugins['thought-tree-navigator'];
        if (!plugin || !plugin.settings) return false;

        return plugin.settings.smartConnection === true;
    }
}
