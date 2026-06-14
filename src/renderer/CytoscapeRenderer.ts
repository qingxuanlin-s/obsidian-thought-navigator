import * as cytoscapeNamespace from 'cytoscape';
import * as dagreNamespace from 'cytoscape-dagre';
import * as coseBilkentNamespace from 'cytoscape-cose-bilkent';
import { IGraphRenderer, GraphData, RenderOptions, GraphChanges, ViewState } from './types';
import { ZKNode } from 'src/view/indexView';
import { Component, MarkdownRenderer, Platform } from 'obsidian';
import { EmbeddableMarkdownEditor } from 'src/utils/EmbeddableMarkdownEditor';
import { Minimap } from './Minimap';
import { buildStylesheet } from './stylesheet';
import * as layoutAdapter from './layoutAdapter';
import { OverlayScheduler } from './overlayScheduler';
import { EdgeControls } from './edgeControls';
import {
    darkenColor,
    hexToRgba,
    lightenColor,
    normalizeHexColor,
} from './colorUtils';
import {
    buildElementConversionContext,
    compensateFreeLikeNodeFrameSize,
    computeDirectionalEdgeControlPoints,
    convertEdgesToElements,
    convertNodesToElements,
    convertToElementsWithGroups,
    escapeId,
    getNodeLabel,
    measureNodeLabel,
    measureTextWidthCanvas,
} from './renderPipeline';
import { renderEmbedNodePreviews, renderImageNodePreviews } from './embedPreview';
import { renderNodeBadges } from './nodeBadges';
import { DomTextMeasurer } from './domTextMeasurer';
import {
    bindEvents as event_bindEvents,
    bindKeyboardEvents as event_bindKeyboardEvents,
    shouldRelayout as event_shouldRelayout,
    addGroupResizeHandles as event_addGroupResizeHandles,
    bindResizeHandleDrag as event_bindResizeHandleDrag,
    selectNodesInBox as event_selectNodesInBox,
    initBoxSelection as event_initBoxSelection,
    showBatchToolbar as event_showBatchToolbar,
    showSearchBar as event_showSearchBar,
    hideBatchToolbar as event_hideBatchToolbar,
    createBatchToolbar as event_createBatchToolbar,
    createToolbarButton as event_createToolbarButton,
    batchCreateGroup as event_batchCreateGroup,
    getActiveNode as event_getActiveNode,
    normalizeVector as event_normalizeVector,
    getBranchDirection as event_getBranchDirection,
    getAutoLayoutDirection as event_getAutoLayoutDirection,
    getPerpendicular as event_getPerpendicular,
    getAutoLayoutStackDirection as event_getAutoLayoutStackDirection,
    nextOffsetByProjection as event_nextOffsetByProjection,
    isAutoNodeLayoutStyle as event_isAutoNodeLayoutStyle,
    isNodeAutoLayoutForId as event_isNodeAutoLayoutForId,
    estimateCollisionBox as event_estimateCollisionBox,
    getAxisSpan as event_getAxisSpan,
    getDirectionalDistance as event_getDirectionalDistance,
    isPositionColliding as event_isPositionColliding,
    resolveShortcutPosition as event_resolveShortcutPosition,
    getFreeChildShortcutPosition as event_getFreeChildShortcutPosition,
    getAutoChildShortcutPosition as event_getAutoChildShortcutPosition,
    handleCreateChildNode as event_handleCreateChildNode,
    getFreeSiblingShortcutPosition as event_getFreeSiblingShortcutPosition,
    getAutoSiblingShortcutPosition as event_getAutoSiblingShortcutPosition,
    handleCreateSiblingNode as event_handleCreateSiblingNode,
    getFreeParentShortcutPosition as event_getFreeParentShortcutPosition,
    getAutoParentShortcutPosition as event_getAutoParentShortcutPosition,
    handleCreateParentNode as event_handleCreateParentNode,
    createPlaceholderConnectionLine as event_createPlaceholderConnectionLine,
    handleArrowKeyNavigation as event_handleArrowKeyNavigation,
    batchDeleteNodes as event_batchDeleteNodes,
    batchChangeColor as event_batchChangeColor,
    isSmartConnectionEnabled as event_isSmartConnectionEnabled,
    handlePasteShortcut as event_handlePasteShortcut,
} from './events';
import {
    attachContentSelectionToolbar as inlineAttachContentSelectionToolbar,
    attachInlineTextSelectionToolbar as inlineAttachInlineTextSelectionToolbar,
    checkForLinkPattern as inlineCheckForLinkPattern,
    ensureNodeVisibleInViewport as inlineEnsureNodeVisibleInViewport,
    showInlineEdgeLabelEditor as inlineShowInlineEdgeLabelEditor,
    showInlineNodeEditor as inlineShowInlineNodeEditor,
    showLinkSuggester as inlineShowLinkSuggester,
    startInPlaceTextEdit as inlineStartInPlaceTextEdit,
    startInPlaceTextEditLegacy as inlineStartInPlaceTextEditLegacy,
    startPlaceholderInPlaceEdit as inlineStartPlaceholderInPlaceEdit,
    startPlaceholderTextareaFallback as inlineStartPlaceholderTextareaFallback,
} from './inlineEditor';

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
    private batchSelectedNodeIds: string[] = []; // 保存批量选中的节点ID
    private batchSelectedNodes: any[] = []; // 保存批量选中的完整节点数据（包含 isCrossDomain 等信息）
    private isMetaPressed = false; // 标记 Command 键是否被按下（框选模式）
    private embedPreviewCleanup: (() => void) | null = null;
    private imagePreviewCleanup: (() => void) | null = null;
    private minimap: Minimap | null = null;
    private overlayScheduler = new OverlayScheduler({
        getCy: () => this.cy,
        getContainer: () => this.container,
    });
    private edgeControls = new EdgeControls({
        getCy: () => this.cy,
        getContainer: () => this.container,
        getCurrentData: () => this.currentData,
        overlayScheduler: this.overlayScheduler,
        showGroupActionDialog: this.showGroupActionDialog.bind(this),
        showGroupNameDialog: this.showGroupNameDialog.bind(this),
    });
    // 追踪正在进行中的 overlay 拖拽/缩放操作，确保 destroy() 时能中止挂在 document 上的监听器
    private activeOverlayDragAborters: Set<AbortController> = new Set();
    // 缓存已渲染的预览卡片 DOM，避免重建时 excalidraw/markdown 内容闪烁
    private embedCardCache: Map<string, HTMLElement> = new Map();
    private embedRendererComponents: Set<Component> = new Set();
    // 备注 tooltip 富文本渲染共享生命周期组件(懒建,destroy 时 unload)
    private remarkTooltipComponent: Component | null = null;
    private activeAlignmentOverlay: SVGSVGElement | null = null;
    private activeSeparationOverlay: SVGSVGElement | null = null;
    private boxSelectionElement: HTMLElement | null = null;
    private liveEditCleanupHandlers: Set<() => void> = new Set();
    private collapseHandleCleanup: (() => void) | null = null;
    // #43 增量新增标记:由 render() 在"复用实例+纯新增+已有节点未变"路径上置为新节点 id 集合,
    // renderNodeBadges 读到后只为这些新节点构建+定位 overlay(一次性消费)。
    private _incrementalAddIds: Set<string> | null = null;
    // 与 _incrementalAddIds 配套:增量新增时若已有节点被推开(仅位置变化),置 true,
    // renderNodeBadges 在增量末尾改用 scheduler.immediate() 重定位全部 overlay(一次性消费)。
    private _incrementalRepositionAll = false;
    private domTextMeasurer: DomTextMeasurer | null = null;
    private collapsedNodeIds: Set<string> = new Set();
    private focusOverlayVisibleCyIds: Set<string> | null = null;
    private focusOverlayVisibilityMode: 'hide' | 'dim' = 'hide';
    private activeTextSelectionToolbarCleanup: (() => void) | null = null;
    // 记住用户上一次在文本选区工具条里选择的颜色，跨选区保持
    private lastPickedTextColor: string | null = null;
    private lastPickedBgColor: string | null = null;

    // 文本节点 Markdown 渲染缓存：跨 addNodeBadges 重建复用已渲染的 overlay DOM + Component
    // key = `${sourcePath}||${rawSource}`
    private textMdOverlayCache: Map<string, {
        el: HTMLElement;
        component: Component;
        mdEditor: EmbeddableMarkdownEditor | null;
        width: number;
        height: number;
        isPlainText: boolean;
        usedInCycle: boolean;
    }> = new Map();

    // 节点剪贴板（Cmd+C/V 复制粘贴）
    private clipboardNodes: Array<{ originalNode: any; position: { x: number; y: number } }> = [];
    // Cmd+C 时同步写入系统剪贴板的文本快照;Cmd+V 时跟系统剪贴板比对,
    // 若不一致则说明用户从外部复制了新内容,优先走系统剪贴板路径
    private lastCopiedSystemText: string = '';

    // SimpleMind 风格布局常量
    private readonly VERTICAL_GAP = 80;       // 垂直间距
    private readonly HORIZONTAL_GAP = 200;    // 水平间距
    private readonly SIBLING_GAP = 100;       // 兄弟节点间距
    private readonly ROOT_NODE_FONT_SIZE = 36;
    private readonly ROOT_NODE_FONT_WEIGHT = 700;
    private readonly FIRST_LEVEL_NODE_FONT_SIZE = 24;
    private readonly FIRST_LEVEL_NODE_FONT_WEIGHT = 650;
    private readonly ROOT_TO_FIRST_LEVEL_EDGE_WIDTH = 3.6;
    private readonly ROOT_TO_FIRST_LEVEL_EDGE_OPACITY = 0.78;
    private readonly ACTIVE_ROOT_TO_FIRST_LEVEL_EDGE_OPACITY = 0.85;
    private readonly SECONDARY_PARENT_EDGE_OPACITY = 0.7;

    private isReadOnlyMode(): boolean {
        return this.currentOptions?.readOnly === true || Platform.isMobile;
    }

    private shouldShowMinimap(options: RenderOptions): boolean {
        return options.exportMode !== true && options.showMinimap !== false;
    }

    private isCyUsable(cy: cytoscape.Core | null = this.cy): cy is cytoscape.Core {
        return !!cy && !!(cy as any)._private;
    }

    private clearActiveTextSelectionToolbar(): void {
        if (!this.activeTextSelectionToolbarCleanup) return;
        this.activeTextSelectionToolbarCleanup();
        this.activeTextSelectionToolbarCleanup = null;
    }

    private stripInlineTextFormatting(text: string): string {
        let result = text;
        const unwrapPatterns: Array<[RegExp, string]> = [
            [/\*\*([\s\S]*?)\*\*/g, '$1'],
            [/~~([\s\S]*?)~~/g, '$1'],
            [/<u>([\s\S]*?)<\/u>/gi, '$1'],
            [/<span\b[^>]*>([\s\S]*?)<\/span>/gi, '$1'],
        ];

        let changed = true;
        while (changed) {
            changed = false;
            for (const [pattern, replacement] of unwrapPatterns) {
                const next = result.replace(pattern, replacement);
                if (next !== result) {
                    result = next;
                    changed = true;
                }
            }
        }

        return result.replace(/<\/?[^>]+>/g, '');
    }

    private unloadEmbedRendererComponents(): void {
        this.embedRendererComponents.forEach((component) => {
            try { component.unload(); } catch { /* ignore */ }
        });
        this.embedRendererComponents.clear();
    }

    private cleanupLiveEditHandlers(): void {
        this.liveEditCleanupHandlers.forEach((cleanup) => {
            try { cleanup(); } catch { /* ignore */ }
        });
        this.liveEditCleanupHandlers.clear();
    }

    private cleanupInlineEditingDom(): void {
        this.clearActiveTextSelectionToolbar();
        this.container?.querySelectorAll(
            '.node-label-editor, .edge-label-editor, .node-link-suggester, .zk-placeholder-edit-overlay'
        ).forEach((el) => el.remove());
    }

    private cleanupBadgeInteractionBindings(): void {
        this.edgeControls.cleanupBindings();
    }

    /**
     * 渲染图形
     * @性能优化：支持增量更新，避免每次都销毁重建
     */
    async render(container: HTMLElement, data: GraphData, options: RenderOptions): Promise<void> {
        // 确保扩展已注册
        registerExtensions();

        // 性能埋点(与 indexView 共用 window.__zkPerf 开关),细分 render 内部各阶段耗时
        const __zkPerf = (window as any).__zkPerf === true;
        const __mark: Record<string, number> = {};
        let __tPrev = __zkPerf ? performance.now() : 0;
        const __lap = (name: string) => {
            if (!__zkPerf) return;
            const t = performance.now();
            __mark[name] = (__mark[name] || 0) + (t - __tPrev);
            __tPrev = t;
        };

        const containerChanged = this.container !== container;
        const previousOptions = this.currentOptions;

        this.container = container;
        this.currentData = data;
        this.currentOptions = options;
        this.collapsedNodeIds = new Set(
            options.initialCollapsedNodeIds
            || data.metadata.collapsedNodeIds
            || []
        );
        if (!this.domTextMeasurer || containerChanged) {
            this.domTextMeasurer?.destroy();
            this.domTextMeasurer = new DomTextMeasurer(container);
        } else {
            this.domTextMeasurer.invalidate();
        }

        // 出入链预设网格位置（必须在转换元素之前，确保 savedPosition 生效）
        this.presetInOutLinksPositions(data);
        // 检查是否有保存的位置
        const hasSavedPositions = data.nodes.some(node => node.savedPosition);
        // 复用现有实例 = 增量重渲染(如删除/新增节点后刷新)。此时不应让布局再 fit:
        // 用户已经手动缩放/平移,内部 fit 会把视图重新适配到全图(缩回最小),还会通过
        // 防抖的 viewStateChanged 污染已保存的缩放。首次构建/换容器才需要 fit 来初始定位,
        // 各调用方(indexView 的视图状态恢复 / graphView 的 fitAndCenter)会在 render 后显式处理视口。
        const reusedInstance = this.isCyUsable() && !containerChanged;

        // 转换元素（包含分组）
        const elements = convertToElementsWithGroups(data, {
            options: this.currentOptions,
            edgeControlPoints: this.edgeControlPoints,
            rootToFirstLevelEdgeWidth: this.ROOT_TO_FIRST_LEVEL_EDGE_WIDTH,
        });
        __lap('convertElements');

        // 如果没有 Cytoscape 实例、实例已销毁或容器变化，需要完全重建
        if (!this.isCyUsable() || containerChanged) {
            // 销毁旧实例（如果存在）
            if (this.cy) {
                this.overlayScheduler.cleanupManagedDomListeners();
                this.overlayScheduler.cleanupEventBindings();
                this.cleanupBadgeInteractionBindings();
                this.overlayScheduler.cleanupScheduler();
                this.activeAlignmentOverlay?.remove();
                this.activeAlignmentOverlay = null;
                this.activeSeparationOverlay?.remove();
                this.activeSeparationOverlay = null;
                this.boxSelectionElement?.remove();
                this.boxSelectionElement = null;
                if (this.minimap) {
                    this.minimap.destroy();
                    this.minimap = null;
                }
                if (this.isCyUsable()) {
                    this.cy.destroy();
                }
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
                // 没有保存位置时，先用轻量网格打散，避免首帧节点重叠导致边端点无效
                layout: hasSavedPositions
                    ? { name: 'preset' }
                    : { name: 'grid', fit: false, avoidOverlap: true, padding: 30 },
                // 性能优化选项
                hideEdgesOnViewport: true,
                hideLabelsOnViewport: true,  // pan/zoom 时隐藏标签，减少 canvas 渲染量
                // 关闭拖拽纹理缓存，避免画布拖动时出现半透明色块伪影
                textureOnViewport: false,
                motionBlur: false,
                pixelRatio: Math.min(window.devicePixelRatio, 2),  // 限制最高 2x，3x 屏省 ~25% canvas 填充
                // 启用节点拖动
                autoungrabify: options.readOnly === true,
                // 启用原生缩放和平移
                userZoomingEnabled: true,   // 启用滚轮/双指缩放
                userPanningEnabled: true,   // 启用原生拖动画布
                // 默认禁用框选，需要按 Command 键才启用
                boxSelectionEnabled: false,
                // 设置缩放范围
                minZoom: 0.1,
                maxZoom: 1.0
            });

            // 绑定事件（exportMode 下跳过所有 DOM 交互绑定，避免 MutationObserver/focus 副作用）
            // 注: addNodeBadges() 不在此处调用，由后续统一的 if (!options.exportMode) 块处理，避免首帧重复构建。
            if (!options.exportMode) {
                this.bindEvents();
                this.bindKeyboardEvents();
                this.initBoxSelection();
                if (this.isReadOnlyMode()) {
                    this.hideBatchToolbar();
                }
                // Minimap —— 浮在画布右下角的缩略导航(exportMode 下不创建)
                if (this.cy && this.container && this.shouldShowMinimap(options)) {
                    this.minimap = new Minimap(this.container, this.cy);
                }
            }

        } else {
            const cy = this.cy;
            if (!this.isCyUsable(cy)) return;

            if (typeof (cy as any).autoungrabify === 'function') {
                (cy as any).autoungrabify(options.readOnly === true);
            }
            if (this.isReadOnlyMode()) {
                this.hideBatchToolbar();
            }

            // 复用实例时也要刷新样式，确保主题/风格切换即时生效
            const shouldRefreshStyle =
                !previousOptions ||
                previousOptions.themeMode !== options.themeMode ||
                previousOptions.themeStyle !== options.themeStyle ||
                previousOptions.edgeStyle !== options.edgeStyle;
            if (shouldRefreshStyle) {
                cy.style([
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

            if (this.shouldShowMinimap(options)) {
                if (!this.minimap && this.container && cy) {
                    this.minimap = new Minimap(this.container, cy);
                }
            } else if (this.minimap) {
                this.minimap.destroy();
                this.minimap = null;
            }

            // 增量更新：复用现有 Cytoscape 实例

            // 获取当前所有节点和边的 ID（batch 外计算，避免在 batch 内读取被修改的集合）
            const currentIds = new Set(cy.elements().map((ele: any) => ele.id()));
            const newIds = new Set(elements.map(ele => ele.data.id || ''));

            // 找出需要删除的元素
            const toRemove: string[] = [];
            currentIds.forEach(id => {
                if (!newIds.has(id)) {
                    toRemove.push(id);
                }
            });
            // #43 fast path:区分"真实节点删除"与"占位符移除"。占位符没有任何持久 badge overlay
            // (各子系统都按 isPlaceholder 跳过,编辑框/连线在 batch 内单独清理),所以"只移除占位符"
            // 仍可视为纯新增。realRemovedCount 只统计非占位符的删除。
            const realRemovedCount = toRemove.filter((id) => {
                const ele = cy.$id(id);
                return ele.length > 0 && !ele.data('isPlaceholder');
            }).length;

            // 找出需要添加的元素
            const toAdd = elements.filter(ele => {
                const id = ele.data.id;
                return id && !currentIds.has(id);
            });

            // 分组节点的子节点释放必须在 batch 外执行：
            // 若 move({ parent: null }) 和 cy.remove(groupNode) 在同一 batch 内，
            // Cytoscape endBatch 通知队列会遍历到已 remove 的节点（_private 为 null）导致 crash。
            if (toRemove.length > 0) {
                toRemove.forEach(id => {
                    const ele = cy.$id(id);
                    if (ele.length > 0 && ele.data('isGroup')) {
                        const childNodes = cy.nodes(`[parent="${id}"]`);
                        childNodes.forEach((child: any) => {
                            child.move({ parent: null });
                        });
                    }
                });
            }

            // #43 增量新增 fast path 追踪:是否有"已有节点"的数据/位置/分组发生变化、是否移除了占位符。
            // 任一为真说明已有 overlay 可能失效 → 不能走 fast path。
            let existingChanged = false;
            let existingChangeDetail: string | null = null;
            let placeholdersRemoved = false;
            // 已有节点"仅位置变化"(典型:auto 布局新增节点推开同级)。这类变化不会让 overlay DOM
            // 失效——badge/备注等内容不变,只需在增量渲染末尾用 scheduler.immediate() 重定位一次
            // (成本=一帧 pan,远低于全量重建 N 个 overlay DOM)。因此它不计入 existingChanged,
            // 不阻断 fast path,仅通过 existingMoved 触发增量后的一次性重定位。
            let existingMoved = false;
            const markExistingChanged = (reason: string) => {
                existingChanged = true;
                if (!existingChangeDetail) existingChangeDetail = reason;
            };
            // fast path 判定专用:找出已有节点中"会影响 overlay 的"真实数据变化字段(无则返回空)。
            // 跳过不影响 overlay 视觉的字段:
            //  - originalNode:每次 build 都是新对象引用,内容已由 label 等标量字段反映,且体积大不宜深比。
            //  - position:节点的文档排序序号(GraphDataBuilder 里的 index+1),并非坐标;在插入点之前
            //    插入新节点会让后续所有节点序号 +1,但 overlay 不读它(渲染只用 cy 的 x/y 坐标)。
            // 其余对象值字段按内容比较,避免"引用每次都变"的伪变化;节点真移动时坐标内容不同会照常判变。
            const IGNORED_OVERLAY_DATA_KEYS = new Set(['originalNode', 'position']);
            const overlayMeaningfulChange = (cur: any, next: any): string => {
                for (const key in next) {
                    if (IGNORED_OVERLAY_DATA_KEYS.has(key)) continue;
                    const a = cur[key];
                    const b = next[key];
                    if (a === b) continue;
                    if (a && b && typeof a === 'object' && typeof b === 'object') {
                        try { if (JSON.stringify(a) === JSON.stringify(b)) continue; } catch { /* 比不了就当变化 */ }
                    }
                    // 诊断:带上变化前后的值(截断),帮助分辨 undefined→值 还是真实数值变化
                    let av = ''; let bv = '';
                    try { av = JSON.stringify(a); } catch { av = String(a); }
                    try { bv = JSON.stringify(b); } catch { bv = String(b); }
                    return `${key} (${(av || 'undefined').slice(0, 60)} -> ${(bv || 'undefined').slice(0, 60)})`;
                }
                return '';
            };

            cy.batch(() => {
                // 先删除所有占位符节点（因为它们不在传入的数据中）
                const placeholderNodes = cy.nodes().filter((node: any) => node.data('isPlaceholder'));
                if (placeholderNodes.length > 0) {
                    placeholdersRemoved = true;
                    cy.remove(placeholderNodes);
                }

                // 清理所有占位符连接线
                const connectionLines = this.container?.querySelectorAll('.placeholder-connection-line');
                if (connectionLines && connectionLines.length > 0) {
                    connectionLines.forEach(line => {
                        if (line.parentNode) {
                            line.parentNode.removeChild(line);
                        }
                    });
                }

                // 清理占位符节点的编辑框和链接建议器
                const editor = this.container?.querySelector('.node-label-editor');
                if (editor) {
                    editor.remove();
                }
                const edgeEditor = this.container?.querySelector('.edge-label-editor');
                if (edgeEditor) {
                    edgeEditor.remove();
                }
                this.clearActiveTextSelectionToolbar();

                const suggester = this.container?.querySelector('.node-link-suggester');
                if (suggester) {
                    suggester.remove();
                }

                // 删除旧元素
                // 性能优化：原实现 cy.elements().filter(ele => toRemove.includes(...))
                // 对全图元素做 O(E × |toRemove|) 扫描。改为直接用 $id 做 O(1) 哈希查找，
                // 把移除复杂度降到 O(|toRemove|)。
                if (toRemove.length > 0) {
                    toRemove.forEach(id => {
                        const ele = cy.$id(id);
                        if (ele.length > 0) {
                            cy.remove(ele);
                        }
                    });
                }

                // 添加新元素
                if (toAdd.length > 0) {
                    cy.add(toAdd);
                }

                // 更新现有元素的数据（包括 parent 属性）
                elements.forEach(ele => {
                    const id = ele.data.id;
                    if (id) {
                        const existing = cy.$id(id);
                        if (existing.length > 0) {
                            // 该元素在本次渲染前已存在(非本轮新增)。其变化才可能让已有 overlay 失效。
                            // 排除分组节点:分组没有 badge overlay,仅驱动 glass(fast path 已跳过、靠 pan/zoom
                            // 惰性更新)。新节点加入分组会改分组的 nodeIds,这对其他节点 overlay 无影响。
                            const isExisting = currentIds.has(id) && !existing.data('isGroup');
                            const wasEmbed = !!existing.data('isEmbed');
                            const nextIsEmbed = !!ele.data.isEmbed;
                            // 浅比较 ele.data 与现有 data,只有变化时才写入,避免触发不必要的 style/data 事件
                            const currentData = existing.data();
                            let dataChanged = false;
                            if (
                                ele.group === 'edges' &&
                                ele.data.controlPointDistance === undefined &&
                                (currentData.controlPointDistance !== undefined || currentData.controlPointWeight !== undefined)
                            ) {
                                existing.removeData('controlPointDistance');
                                existing.removeData('controlPointWeight');
                                dataChanged = true;
                            }
                            for (const key in ele.data) {
                                if (currentData[key] !== ele.data[key]) {
                                    dataChanged = true;
                                    break;
                                }
                            }
                            if (dataChanged) {
                                if (isExisting) {
                                    const mkey = overlayMeaningfulChange(currentData, ele.data);
                                    if (mkey) markExistingChanged(`data:${id}:${mkey}`);
                                }
                                existing.data(ele.data);
                            }

                            // 同步更新位置（savedPosition 对应的坐标在 ele.position 上，data 里不含位置）
                            if (ele.group === 'nodes' && (ele as any).position) {
                                if (isExisting) {
                                    const cur = existing.position();
                                    const next = (ele as any).position;
                                    if (Math.abs(cur.x - next.x) > 0.01 || Math.abs(cur.y - next.y) > 0.01) {
                                        // 仅位置变化:不阻断 fast path,改由 existingMoved 触发增量后重定位
                                        existingMoved = true;
                                    }
                                }
                                existing.position((ele as any).position);
                            }

                            // embed -> 普通文件节点：移除预览卡片写入的 bypass，恢复样式表计算尺寸和边框视觉
                            if (ele.group === 'nodes' && wasEmbed && !nextIsEmbed) {
                                existing.data('isImageNode', false);
                                existing.removeStyle('label');
                                existing.removeStyle('background-opacity');
                                existing.removeStyle('border-opacity');
                                existing.removeStyle('border-width');
                                existing.removeStyle('overlay-opacity');
                                existing.removeStyle('padding');
                                existing.removeStyle('width');
                                existing.removeStyle('height');
                            }

                            // 特殊处理 parent 属性，确保分组关系正确更新
                            if (ele.group === 'nodes' && 'parent' in ele.data) {
                                const newParent = ele.data.parent;
                                const currentParent = existing.data('parent');

                                // 如果 parent 发生变化，需要使用 move() 方法更新
                                if (newParent !== currentParent) {
                                    if (isExisting) markExistingChanged(`parent:${id}`);
                                    existing.move({
                                        parent: newParent || null
                                    });
                                }
                            }
                        }
                    }
                });
            });

            // #43 fast path 判定:复用实例 + 纯新增(无删除) + 已有节点"内容"未变(data/parent) +
            // 未移除占位符 + 无样式刷新 → 仅为新增节点构建 overlay。任一条件不满足则保持
            // _incrementalAddIds=null 走全量重建。
            // 已有节点"仅位置变化"(auto 布局新增推开同级)不再阻断 fast path:overlay 内容仍有效,
            // 只需增量末尾 immediate() 重定位一次(_incrementalRepositionAll 透传该意图)。
            const addedNodeIds = toAdd
                .filter(e => e.group === 'nodes' && e.data.id)
                .map(e => e.data.id as string);
            const fastAddOk = !options.exportMode
                && realRemovedCount === 0
                && addedNodeIds.length > 0
                && !existingChanged
                && !shouldRefreshStyle;
            if (fastAddOk) {
                this._incrementalAddIds = new Set(addedNodeIds);
                this._incrementalRepositionAll = existingMoved;
            }
            if ((window as any).__zkPerf === true) {
                console.log('[zkPerf:fastadd]', {
                    taken: fastAddOk,
                    added: addedNodeIds.length,
                    toRemove: toRemove.length,
                    realRemoved: realRemovedCount,
                    existingChanged,
                    existingChangeDetail,
                    existingMoved,
                    placeholdersRemoved,
                    shouldRefreshStyle,
                });
            }
        }

        __lap('cyDiff');

        // 更新节点徽章（exportMode 下跳过，避免 MarkdownRenderer 触发 MutationObserver 导致跳转）
        if (!options.exportMode) {
            this.addNodeBadges();
            __lap('badges');
            this.addEmbedNodePreviews();
            this.addImageNodePreviews();
            __lap('previews');
            this.reapplyFocusOverlayState();
            if (this.shouldShowMinimap(options)) {
                this.minimap?.refresh();
            }
            __lap('overlaysMisc');
        }

        // 运行布局
        if (this.isCyUsable()) {
            const cy = this.cy;
            if (!cy) return;
            // 容器尺寸变化后显式通知 Cytoscape 重算 viewport/canvas 尺寸
            cy.resize();
            // exportMode 下禁用 fit：cy.fit() 会通过 setTimeout 延迟触发 viewport 回调，
            // 而 renderer.destroy() 在 finally 里立即销毁 cy，导致回调执行时 cy 已 null。
            // cy.png({ full:true }) 自己会处理 fit，layout 不需要再 fit。
            const noFit = (options.exportMode || reusedInstance) ? { fit: false } : {};
            if (hasSavedPositions) {
                // 如果有保存的位置，使用 preset 布局（保持原位置）
                this.runLayoutSafely({ name: 'preset', ...noFit });
                this.resolveExactNodeOverlaps();
            } else {
                // 如果没有保存位置，根据 layoutType 选择布局算法
                // 默认使用 preset（索引视图等已有位置信息的情况）
                // 局部关系视图的出入链图会传入 'cose' 等布局类型来自动分散节点
                const layoutConfig = { ...this.getLayoutConfig(options), ...noFit };
                this.runLayoutSafely(layoutConfig);
            }
        }
        __lap('layout');
        this.applyCollapsedState();
        this.updateActiveFirstLevelBranch();
        // 方向感知 S 形边:布局定稿后按最终坐标重算全部层级边的控制点(覆盖新增边)
        this.refreshDirectionalEdgeCurves();
        __lap('finalize');
        if (__zkPerf) {
            const total = Object.values(__mark).reduce((a, b) => a + b, 0);
            console.log(
                `[zkPerf:render] total=${total.toFixed(1)}ms`,
                Object.fromEntries(Object.entries(__mark).map(([k, v]) => [k, +v.toFixed(1)]))
            );
        }
    }

    /**
     * 轻微打散完全重叠的节点，避免边端点重合导致 "invalid endpoints" 警告。
     * 仅处理非分组节点，且只在坐标几乎完全一致时生效。
     */
    private resolveExactNodeOverlaps(): void {
        layoutAdapter.resolveExactNodeOverlaps(this.cy);
    }

    private updateActiveFirstLevelBranch(): void {
        if (!this.cy) return;

        this.cy.nodes('.zk-active-first-level-branch').removeClass('zk-active-first-level-branch');
        this.cy.edges('.zk-active-root-branch-edge').removeClass('zk-active-root-branch-edge');

        const activeBranchIds = new Set<string>();
        this.cy.$('node:selected').forEach((node: any) => {
            if (node.data('isGroup') || node.data('isPlaceholder')) return;
            const branchId = String(node.data('firstLevelBranchId') || '').trim();
            if (branchId) {
                activeBranchIds.add(branchId);
            } else if (node.data('isFirstLevelNode')) {
                activeBranchIds.add(String(node.data('originalNodeId') || node.data('id') || '').trim());
            }
        });

        activeBranchIds.forEach((branchId) => {
            const branchNode = this.cy!.$id(escapeId(branchId));
            if (branchNode.length > 0) {
                branchNode.addClass('zk-active-first-level-branch');
                branchNode.connectedEdges('[?isRootToFirstLevel]').addClass('zk-active-root-branch-edge');
            }
        });
    }

    /**
     * 安全运行布局：
     * - 主要用于规避少数数据情况下 cose/cose-bilkent 内部报错导致整图不可用
     * - 首次布局失败时自动回退到 breadthfirst
     */
    private runLayoutSafely(layoutConfig: any): void {
        layoutAdapter.runLayoutSafely(this.cy, layoutConfig);
    }

    /**
     * 增量更新图形
     */
    async update(changes: GraphChanges): Promise<void> {
        if (!this.isCyUsable()) return;

        // 批量更新以提高性能
        const cy = this.cy;
        if (!cy) return;
        cy.batch(() => {
            // 删除节点（会自动删除相关的边）
            if (changes.removedNodes.length > 0) {
                // 检查是否删除了分组节点，如果是，先释放子节点
                changes.removedNodes.forEach(node => {
                    const nodeId = escapeId(node.ID);
                    const ele = cy.$id(nodeId);

                    if (ele.length > 0 && ele.data('isGroup')) {
                        // 这是一个分组节点，需要先释放其子节点
                        const childNodes = cy.nodes(`[parent="${nodeId}"]`);

                        // 将子节点的 parent 设为 null，使其成为独立节点
                        childNodes.forEach((child: any) => {
                            child.move({ parent: null });
                        });
                    }
                });

                // 现在可以安全地删除节点
                const ids = changes.removedNodes.map(n => `#${escapeId(n.ID)}`).join(',');
                cy.remove(ids);
            }

            // 删除边
            if (changes.removedEdges.length > 0) {
                const ids = changes.removedEdges.map(e => `#${escapeId(e.id)}`).join(',');
                cy.remove(ids);
            }

            // 添加新节点
            if (changes.addedNodes.length > 0) {
                const context = buildElementConversionContext(this.currentData, this.currentOptions);
                cy.add(convertNodesToElements(changes.addedNodes, this.currentData, this.currentOptions, context));
            }

            // 添加新边
            if (changes.addedEdges.length > 0) {
                const context = buildElementConversionContext(this.currentData, this.currentOptions);
                cy.add(convertEdgesToElements(
                    changes.addedEdges,
                    context,
                    this.edgeControlPoints,
                    this.ROOT_TO_FIRST_LEVEL_EDGE_WIDTH
                ));
            }

            // 更新节点
            changes.updatedNodes.forEach(node => {
                const ele = cy.$id(escapeId(node.ID));
                if (ele.length > 0) {
                    ele.data('label', getNodeLabel(node, this.currentOptions));
                    ele.data('title', node.title);
                }
            });

            // 更新边
            changes.updatedEdges.forEach(edge => {
                const ele = cy.$id(escapeId(edge.id));
                if (ele.length > 0) {
                    ele.data('label', edge.label || '');
                }
            });
        });

        // 根据变化程度决定是否重新布局
        if (this.shouldRelayout(changes)) {
            const layout = cy.layout({ name: 'preset' });
            layout.run();
        }
    }

    /**
     * 销毁渲染器
     */
    destroy(): void {
        this.cleanupLiveEditHandlers();
        this.cleanupInlineEditingDom();
        this.overlayScheduler.cleanupManagedDomListeners();
        this.overlayScheduler.cleanupEventBindings();
        this.cleanupBadgeInteractionBindings();
        this.overlayScheduler.cleanupScheduler();
        if (this.minimap) {
            this.minimap.destroy();
            this.minimap = null;
        }

        // 中止所有挂在 document 上、尚未释放的 overlay 拖拽/缩放监听器
        for (const ctrl of this.activeOverlayDragAborters) {
            try { ctrl.abort(); } catch { /* ignore */ }
        }
        this.activeOverlayDragAborters.clear();

        if (this.embedPreviewCleanup) {
            this.embedPreviewCleanup();
            this.embedPreviewCleanup = null;
        }
        if (this.imagePreviewCleanup) {
            this.imagePreviewCleanup();
            this.imagePreviewCleanup = null;
        }
        if (this.collapseHandleCleanup) {
            this.collapseHandleCleanup();
            this.collapseHandleCleanup = null;
        }
        this.activeAlignmentOverlay?.remove();
        this.activeAlignmentOverlay = null;
        this.activeSeparationOverlay?.remove();
        this.activeSeparationOverlay = null;
        this.boxSelectionElement?.remove();
        this.boxSelectionElement = null;
        this.embedCardCache.forEach((card) => {
            if (card.parentNode) card.remove();
        });
        this.embedCardCache.clear();
        this.unloadEmbedRendererComponents();
        // 清理文本节点 MD overlay 缓存（unload 每个 Component）
        this.textMdOverlayCache.forEach(entry => {
            if (entry.mdEditor) {
                try { entry.mdEditor.unload(); } catch { /* ignore */ }
            }
            const liveHost = entry.el.querySelector('.zk-text-md-live-edit-host') as any;
            if (liveHost?._mdEditor) {
                try { liveHost._mdEditor.unload(); } catch { /* ignore */ }
            }
            try { entry.component.unload(); } catch { /* ignore */ }
            if (entry.el.parentNode) entry.el.remove();
        });
        this.textMdOverlayCache.clear();
        if (this.remarkTooltipComponent) {
            try { this.remarkTooltipComponent.unload(); } catch { /* ignore */ }
            this.remarkTooltipComponent = null;
        }
        if (this.cy) {
            if (this.isCyUsable()) {
                this.cy.destroy();
            }
            this.cy = null;
        }
        this.domTextMeasurer?.destroy();
        this.domTextMeasurer = null;
        this.focusOverlayVisibleCyIds = null;
        this.focusOverlayVisibilityMode = 'hide';
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
     * Cmd+V 入口:供 indexView 的 scope.register('Mod','v') 调用,统一调度
     * 外部剪贴板 / 内部 clipboardNodes 的粘贴。两者皆无时返回 false 让上层 fallback 到 scratchpad。
     */
    handlePasteShortcut(): Promise<boolean> {
        return event_handlePasteShortcut.call(this);
    }

    applyFocusOverlayState(visibleCyIds: Set<string> | null, visibilityMode: 'hide' | 'dim' = 'hide', persistState: boolean = true): void {
        if (persistState) {
            this.focusOverlayVisibleCyIds = visibleCyIds ? new Set(visibleCyIds) : null;
            this.focusOverlayVisibilityMode = visibilityMode;
        }
        if (!this.container) return;
        const clearing = visibleCyIds === null;
        const isLightTheme = this.container.classList.contains('zk-theme-light')
            || (!this.container.classList.contains('zk-theme-dark') && document.body.classList.contains('theme-light'));
        const restorePreviewWeight = (card: HTMLElement) => {
            const nodeId = card.dataset.nodeId || '';
            const isSelected = !!nodeId && !!this.cy?.$id(nodeId)?.selected?.();
            card.style.opacity = isSelected ? '1' : '0.82';
            card.style.filter = isSelected ? 'brightness(1) saturate(1)' : 'brightness(0.86) saturate(0.92)';
            delete card.dataset.levelDimmed;
        };

        this.container.querySelectorAll<HTMLElement>('.zk-embed-preview-card, .zk-image-preview-card')
            .forEach(card => {
                if (clearing) {
                    card.style.display = '';
                    if (card.dataset.levelDimmed === '1') restorePreviewWeight(card);
                    return;
                }

                const isVisible = visibleCyIds!.has(card.dataset.nodeId || '');
                if (visibilityMode === 'dim') {
                    card.style.display = '';
                    if (isVisible) {
                        if (card.dataset.levelDimmed === '1') restorePreviewWeight(card);
                    } else {
                        card.dataset.levelDimmed = '1';
                        card.style.opacity = '0.28';
                        card.style.filter = 'brightness(0.72) saturate(0.72)';
                    }
                } else {
                    card.style.display = isVisible ? '' : 'none';
                    if (card.dataset.levelDimmed === '1') restorePreviewWeight(card);
                }
            });

        this.container.querySelectorAll<HTMLElement>([
            '.zk-text-md-overlay',
            '.zk-node-file-underline-group',
            '.zk-node-remark-badge',
            '.zk-node-anchor-badge',
            '.zk-node-color-dot',
            '.zk-node-badge'
        ].join(', '))
            .forEach(el => {
                if (clearing) {
                    if (el.dataset.levelHidden === '1') el.style.display = '';
                    if (el.dataset.levelDimmed === '1') {
                        el.style.opacity = '';
                        el.style.filter = '';
                        el.style.pointerEvents = '';
                    }
                    delete el.dataset.levelDimmed;
                    delete el.dataset.levelHidden;
                    return;
                }

                const nodeId = el.dataset.nodeId || '';
                const cyNode = nodeId && this.cy ? this.cy.$id(nodeId) : null;
                const isVisible = !!nodeId && visibleCyIds!.has(nodeId);
                const isDimmed = !!cyNode?.length && cyNode.hasClass('zk-level-dimmed');
                if (visibilityMode === 'dim') {
                    if (el.dataset.levelHidden === '1') el.style.display = '';
                    delete el.dataset.levelHidden;
                    if (!isDimmed) {
                        if (el.dataset.levelDimmed === '1') {
                            el.style.opacity = '';
                            el.style.filter = '';
                            el.style.pointerEvents = '';
                        }
                        delete el.dataset.levelDimmed;
                    } else {
                        el.dataset.levelDimmed = '1';
                        if (isLightTheme && el.classList.contains('zk-text-md-overlay')) {
                            el.style.opacity = '0.92';
                            el.style.filter = 'none';
                        } else {
                            el.style.opacity = '0.16';
                            el.style.filter = 'brightness(0.62) saturate(0.58)';
                        }
                        el.style.pointerEvents = 'none';
                    }
                } else {
                    if (isVisible) {
                        if (el.dataset.levelHidden === '1') el.style.display = '';
                    } else {
                        el.dataset.levelHidden = '1';
                        el.style.display = 'none';
                    }
                    if (el.dataset.levelDimmed === '1') {
                        el.style.opacity = '';
                        el.style.filter = '';
                        el.style.pointerEvents = '';
                    }
                    delete el.dataset.levelDimmed;
                }
            });

        this.container.querySelectorAll<HTMLElement>('.zk-group-glass-layer').forEach(layer => {
            layer.style.display = clearing || visibilityMode === 'dim' ? '' : 'none';
            layer.style.opacity = clearing ? '' : (visibilityMode === 'dim' ? '0.26' : '');
        });
    }

    private reapplyFocusOverlayState(): void {
        if (this.focusOverlayVisibleCyIds === null) return;
        this.applyFocusOverlayState(this.focusOverlayVisibleCyIds, this.focusOverlayVisibilityMode, false);
    }

    /**
     * 祖先链高亮:把指定 cy node 到 root 的整条路径(节点 + 沿途的边)打上
     * `zk-ancestor-active` class,从而被 stylesheet/CSS 选择器恢复亮色 + 边加粗。
     * 传 null 清除所有 ancestor 高亮。
     *
     * 与 levelDim 的关系:被 `zk-level-dimmed` 命中的节点跳过 ——
     * levelDim 是显式"屏蔽其他",优先级更高,ancestor 不应该把它强亮回来。
     */
    applyAncestorHighlight(focusCyNodeId: string | null): void {
        if (!this.cy || !this.container) return;

        // 1. 清除旧的 ancestor-active class(节点 + 边)
        this.cy.elements('.zk-ancestor-active').removeClass('zk-ancestor-active');

        // 2. 清除 DOM overlay 上的 class
        this.container.querySelectorAll<HTMLElement>('.zk-text-md-overlay.zk-ancestor-active')
            .forEach(el => el.classList.remove('zk-ancestor-active'));

        if (!focusCyNodeId) return;

        const focusCyNode = this.cy.$id(focusCyNodeId);
        if (!focusCyNode || focusCyNode.length === 0) return;

        const focusOriginal = focusCyNode.data('originalNode') as { IDStr?: string; ID?: string } | undefined;
        if (!focusOriginal) return;
        const focusIdStr = (focusOriginal.IDStr || focusOriginal.ID || '').trim();
        if (!focusIdStr || !focusIdStr.includes('.')) {
            // root 节点本身没有祖先链,但还是把自己点亮(以便 file 节点 canvas label 走亮色规则)
            if (!focusCyNode.hasClass('zk-level-dimmed')) {
                focusCyNode.addClass('zk-ancestor-active');
                this.container.querySelectorAll<HTMLElement>(`.zk-text-md-overlay[data-node-id="${CSS.escape(focusCyNodeId)}"]`)
                    .forEach(el => el.classList.add('zk-ancestor-active'));
            }
            return;
        }

        // 3. 计算祖先 IDStr 集合(包含被点节点自己)
        const ancestorIdStrs = new Set<string>();
        const parts = focusIdStr.split('.');
        for (let i = 1; i <= parts.length; i++) {
            ancestorIdStrs.add(parts.slice(0, i).join('.'));
        }

        // 4. 给命中的 cy 节点加 class,同时收集它们的 cy id
        const activeCyIds = new Set<string>();
        this.cy.nodes().forEach((n: any) => {
            if (n.data('isGroup')) return;
            if (n.hasClass('zk-level-dimmed')) return;
            const original = n.data('originalNode') as { IDStr?: string; ID?: string } | undefined;
            const idStr = (original?.IDStr || original?.ID || '').trim();
            if (ancestorIdStrs.has(idStr)) {
                n.addClass('zk-ancestor-active');
                activeCyIds.add(n.id());
            }
        });

        // 5. 沿途的边:源和目标都在 ancestor 集合里
        this.cy.edges().forEach((e: any) => {
            if (e.hasClass('zk-level-dimmed')) return;
            if (activeCyIds.has(e.source().id()) && activeCyIds.has(e.target().id())) {
                e.addClass('zk-ancestor-active');
            }
        });

        // 6. DOM overlay(text-only 节点)同步加 class —— CSS 选择器会把 muted 文字翻成亮色
        this.container.querySelectorAll<HTMLElement>('.zk-text-md-overlay').forEach(el => {
            const nodeId = el.dataset.nodeId || '';
            if (activeCyIds.has(nodeId)) {
                el.classList.add('zk-ancestor-active');
            }
        });
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
     * 方向感知的 S 形层级边:按节点最终坐标重算 unbundled-bezier 的控制点数组并写入 edge.data,
     * 样式从 autoCpDistances/autoCpWeights 取值。Cytoscape 不会在节点移动时重评估控制点样式函数,
     * 因此移动后必须主动调用本方法(布局结束 / 拖动 / reflow,见 events 的全局 position 监听)。
     *
     * 只处理层级骨架边(parent / forward),且跳过用户手动拖过的控制点(controlPointDistance 优先)。
     * @param edges 仅刷新这些边(增量,如拖动时的 connectedEdges);省略则全量。
     */
    refreshDirectionalEdgeCurves(edges?: any): void {
        if (!this.isCyUsable()) return;
        const cy = this.cy;
        if (!cy) return;
        const opts = this.currentOptions;
        // 仅贝塞尔风格需要;直线/折线无控制点
        if (opts?.edgeStyle && opts.edgeStyle !== 'bezier') return;
        const direction = ((opts as any)?.direction || 'LR') as 'LR' | 'RL' | 'TB' | 'BT';
        const horizontal = direction === 'LR' || direction === 'RL';
        const targetEdges = edges || cy.edges('[type="parent"], [type="forward"]');
        cy.batch(() => {
            targetEdges.forEach((edge: any) => {
                const type = edge.data('type');
                if (type !== 'parent' && type !== 'forward') return;
                const sn = edge.source();
                const tn = edge.target();
                const s = sn.position();
                const t = tn.position();
                // 控制点必须在两端节点框外,否则 Cytoscape 求不到端点交点会丢边。
                // 沿主轴取两端较大的半尺寸 + 余量作为最小切向距离。
                const margin = 10;
                const minTangent = horizontal
                    ? Math.max(sn.width(), tn.width()) / 2 + margin
                    : Math.max(sn.height(), tn.height()) / 2 + margin;
                // 近距回退:主轴间距 < 2×minTangent 时 S 形控制点交叉,曲线缩进两节点框
                // 之间被盖住(看起来"没有线");贝塞尔在重叠/极近时还可能端点无解直接不画。
                // 此时整条边降级为直线(zk-near-straight 类切换 curve-style),最稳;拉开自动恢复。
                const mainSpan = horizontal ? Math.abs(t.x - s.x) : Math.abs(t.y - s.y);
                if (mainSpan < 2 * minTangent) {
                    edge.addClass('zk-near-straight');
                    return;
                }
                edge.removeClass('zk-near-straight');
                if (edge.data('controlPointDistance') !== undefined) return; // 手动控制点优先
                const cp = computeDirectionalEdgeControlPoints(s.x, s.y, t.x, t.y, direction, 0.5, minTangent);
                edge.data('autoCpDistances', cp.distances);
                edge.data('autoCpWeights', cp.weights);
            });
        });
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
            this.cy!.$id(escapeId(id)).select();
        });
    }

    /**
     * 设置入链出链图的初始位置
     * 入链节点在中心节点上方，出链节点在下方
     */
    /**
     * 为出入链节点预设网格位置（在 Cytoscape 初始化前调用）
     * 直接设置 savedPosition，避免节点堆叠在原点导致 edge 无法绘制
     */
    private presetInOutLinksPositions(data: GraphData): void {
        layoutAdapter.presetInOutLinksPositions(data);
    }

    /**
     * 根据 layoutType 获取布局配置
     * 用于局部关系视图的出入链图等需要自动布局的场景
     */
    private getLayoutConfig(options: RenderOptions): any {
        return layoutAdapter.getLayoutConfig(options);
    }

    /**
     * 将方向字符串转换为 dagre 的 rankDir 格式
     */
    private directionToRankDir(direction: string): string {
        return layoutAdapter.directionToRankDir(direction);
    }

    private getStylesheet(options: RenderOptions): any[] {
        return buildStylesheet(options, {
            FIRST_LEVEL_NODE_FONT_SIZE: this.FIRST_LEVEL_NODE_FONT_SIZE,
            ROOT_NODE_FONT_SIZE: this.ROOT_NODE_FONT_SIZE,
            ROOT_TO_FIRST_LEVEL_EDGE_WIDTH: this.ROOT_TO_FIRST_LEVEL_EDGE_WIDTH,
            ROOT_TO_FIRST_LEVEL_EDGE_OPACITY: this.ROOT_TO_FIRST_LEVEL_EDGE_OPACITY,
            ACTIVE_ROOT_TO_FIRST_LEVEL_EDGE_OPACITY: this.ACTIVE_ROOT_TO_FIRST_LEVEL_EDGE_OPACITY,
            SECONDARY_PARENT_EDGE_OPACITY: this.SECONDARY_PARENT_EDGE_OPACITY,
            measureNodeLabel,
            compensateFreeLikeNodeFrameSize,
            measureTextWidthCanvas,
            domMeasure: (text, opts) => {
                if (!this.domTextMeasurer && this.container) {
                    this.domTextMeasurer = new DomTextMeasurer(this.container);
                }
                if (this.domTextMeasurer) return this.domTextMeasurer.measure(text, opts);
                const fallback = measureNodeLabel(text, {
                    fontSize: opts.fontSize,
                    maxWidth: opts.maxWidth,
                    lineHeight: opts.lineHeight,
                });
                return {
                    width: Math.min(opts.maxWidth, fallback.width),
                    height: fallback.height,
                    lineCount: Math.max(1, Math.round(fallback.height / (opts.lineHeight ?? Math.ceil(opts.fontSize * 1.4))))
                };
            },
            normalizeHexColor,
            hexToRgba,
            lightenColor,
            darkenColor,
        });
    }

    /**
     * 为 ![[...]] 节点添加常驻预览卡片（类似 Canvas 笔记卡）
     */
    private addEmbedNodePreviews(): void {
        renderEmbedNodePreviews.call(this);
    }

    private addImageNodePreviews(): void {
        renderImageNodePreviews.call(this);
    }

    /**
     * 获取布局配置
     */
    private getLayout(options: RenderOptions): any {
        return layoutAdapter.getLayout(options);
    }

    /**
     * 添加节点徽章（HTML 叠加层）
     */
    private addNodeBadges(): void {
        renderNodeBadges.call(this);
    }

    private applyCollapsedState(): void {
        if (!this.cy) return;
        this.collapsedNodeIds = layoutAdapter.applyCollapsedState(this.cy, this.collapsedNodeIds);
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
        const newGroupTitle = newGroupOption.createDiv({ text: '创建新分组' });
        newGroupTitle.style.fontWeight = '600';
        newGroupTitle.style.color = 'var(--text-normal)';
        newGroupTitle.style.marginBottom = '4px';
        const newGroupDesc = newGroupOption.createDiv({ text: '将选中的节点创建为新的分组' });
        newGroupDesc.style.fontSize = '12px';
        newGroupDesc.style.color = 'var(--text-muted)';
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
            const groupTitle = groupOption.createDiv({ text: `添加到「${group.label}」` });
            groupTitle.style.fontWeight = '600';
            groupTitle.style.color = 'var(--text-normal)';
            groupTitle.style.marginBottom = '4px';
            const groupDesc = groupOption.createDiv({ text: `将新选中的节点添加到此分组（当前 ${group.nodeIds.length} 个节点）` });
            groupDesc.style.fontSize = '12px';
            groupDesc.style.color = 'var(--text-muted)';
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



    private attachInlineTextSelectionToolbar(inputEl: HTMLInputElement | HTMLTextAreaElement): {
        destroy: () => void;
        containsTarget: (target: Node | null) => boolean;
    } {
        return inlineAttachInlineTextSelectionToolbar.call(this, inputEl);
    }

    private attachContentSelectionToolbar(
        rootEl: HTMLElement,
        applyTransform: (formatter: (selectedText: string) => string) => boolean
    ): {
        destroy: () => void;
        containsTarget: (target: Node | null) => boolean;
    } {
        return inlineAttachContentSelectionToolbar.call(this, rootEl, applyTransform);
    }

    /**
     * 渲染备注 tooltip 内容为富文本(与画布文本节点一致):支持 **粗** / ~~删~~ / <u> / 颜色/字号 span。
     * 纯文本走快路径直接 textContent;含 markdown/HTML 语法才走 MarkdownRenderer。
     * 仅在源文本变化时被调用(调用方做 diff),避免每帧渲染。
     */
    private renderRemarkTooltipContent(el: HTMLElement, source: string): void {
        el.empty();
        const text = String(source || '');
        if (!text) return;
        // 快路径:无 markdown/HTML 语法
        if (!/[<*_~`\[\]#>]|==|!\[/.test(text)) {
            el.textContent = text;
            return;
        }
        const app = this.currentOptions?.app;
        if (!app) { el.textContent = text; return; }
        if (!this.remarkTooltipComponent) {
            this.remarkTooltipComponent = new Component();
            this.remarkTooltipComponent.load();
        }
        const sourcePath = this.currentData?.metadata?.currentFile || '';
        void MarkdownRenderer.render(app, text, el, sourcePath, this.remarkTooltipComponent);
    }

    /**
     * 在任意宿主元素(如节点详情侧栏的备注编辑器)上挂载选区格式工具栏。
     * 复用画布同款 attachContentSelectionToolbar:用 hostContainer 替换定位/挂载容器,
     * 并关闭 cy 缩放联动(侧栏无图缩放)。共享 strip/取色等渲染器逻辑,保持格式一致。
     */
    public attachSelectionToolbarToHost(
        rootEl: HTMLElement,
        applyTransform: (formatter: (selectedText: string) => string) => boolean,
        hostContainer: HTMLElement
    ): {
        destroy: () => void;
        containsTarget: (target: Node | null) => boolean;
    } {
        const ctx: any = Object.create(this);
        ctx.container = hostContainer;          // 工具栏挂载/定位改用侧栏根
        ctx.cy = null;                          // 侧栏不随图缩放/平移
        ctx.activeTextSelectionToolbarCleanup = null; // 独立于画布工具栏的清理引用
        return inlineAttachContentSelectionToolbar.call(ctx, rootEl, applyTransform);
    }

    private showInlineEdgeLabelEditor(edge: any): void {
        inlineShowInlineEdgeLabelEditor.call(this, edge);
    }

    private showInlineNodeEditor(node: any): void {
        inlineShowInlineNodeEditor.call(this, node);
    }

    private startInPlaceTextEdit(
        node: any,
        originalNode: ZKNode,
        entry: {
            el: HTMLElement;
            component: Component;
            mdEditor?: EmbeddableMarkdownEditor | null;
            width: number;
            height: number;
            isPlainText: boolean;
            usedInCycle: boolean;
        }
    ): void {
        inlineStartInPlaceTextEdit.call(this, node, originalNode, entry);
    }

    private startPlaceholderInPlaceEdit(node: any): void {
        inlineStartPlaceholderInPlaceEdit.call(this, node);
    }

    private startPlaceholderTextareaFallback(node: any): void {
        inlineStartPlaceholderTextareaFallback.call(this, node);
    }

    private startInPlaceTextEditLegacy(
        node: any,
        originalNode: ZKNode,
        entry: {
            el: HTMLElement;
            component: Component;
            mdEditor?: EmbeddableMarkdownEditor | null;
            width: number;
            height: number;
            isPlainText: boolean;
            usedInCycle: boolean;
        }
    ): void {
        inlineStartInPlaceTextEditLegacy.call(this, node, originalNode, entry);
    }

    private ensureNodeVisibleInViewport(node: any, padding: number = 40): void {
        inlineEnsureNodeVisibleInViewport.call(this, node, padding);
    }

    private checkForLinkPattern(
        textarea: HTMLTextAreaElement,
        node: any,
        boundingBox: any,
        suggesterPopoverRef: { value: HTMLElement | null },
        onSelectFile?: (file: any, isEmbed: boolean) => void
    ): void {
        inlineCheckForLinkPattern.call(this, textarea, node, boundingBox, suggesterPopoverRef, onSelectFile);
    }

    private showLinkSuggester(
        textarea: HTMLTextAreaElement,
        node: any,
        boundingBox: any,
        suggesterPopoverRef: { value: HTMLElement | null },
        isEmbed: boolean = false,
        onSelectFile?: (file: any, isEmbed: boolean) => void
    ): void {
        inlineShowLinkSuggester.call(this, textarea, node, boundingBox, suggesterPopoverRef, isEmbed, onSelectFile);
    }

    private bindEvents(...args: any[]): any {
        return event_bindEvents.call(this, ...args);
    }

    private bindKeyboardEvents(...args: any[]): any {
        return event_bindKeyboardEvents.call(this, ...args);
    }

    private shouldRelayout(...args: any[]): any {
        return event_shouldRelayout.call(this, ...args);
    }

    private addGroupResizeHandles(...args: any[]): any {
        return event_addGroupResizeHandles.call(this, ...args);
    }

    private bindResizeHandleDrag(...args: any[]): any {
        return event_bindResizeHandleDrag.call(this, ...args);
    }

    private selectNodesInBox(...args: any[]): any {
        return event_selectNodesInBox.call(this, ...args);
    }

    private initBoxSelection(...args: any[]): any {
        return event_initBoxSelection.call(this, ...args);
    }

    private showBatchToolbar(...args: any[]): any {
        return event_showBatchToolbar.call(this, ...args);
    }

    private showSearchBar(...args: any[]): any {
        return event_showSearchBar.call(this, ...args);
    }

    private hideBatchToolbar(...args: any[]): any {
        return event_hideBatchToolbar.call(this, ...args);
    }

    private createBatchToolbar(...args: any[]): any {
        return event_createBatchToolbar.call(this, ...args);
    }

    private createToolbarButton(...args: any[]): any {
        return event_createToolbarButton.call(this, ...args);
    }

    private batchCreateGroup(...args: any[]): any {
        return event_batchCreateGroup.call(this, ...args);
    }

    private getActiveNode(...args: any[]): any {
        return event_getActiveNode.call(this, ...args);
    }

    private normalizeVector(...args: any[]): any {
        return event_normalizeVector.call(this, ...args);
    }

    private getBranchDirection(...args: any[]): any {
        return event_getBranchDirection.call(this, ...args);
    }

    private getAutoLayoutDirection(...args: any[]): any {
        return event_getAutoLayoutDirection.call(this, ...args);
    }

    private getPerpendicular(...args: any[]): any {
        return event_getPerpendicular.call(this, ...args);
    }

    private getAutoLayoutStackDirection(...args: any[]): any {
        return event_getAutoLayoutStackDirection.call(this, ...args);
    }

    private nextOffsetByProjection(...args: any[]): any {
        return event_nextOffsetByProjection.call(this, ...args);
    }

    private isAutoNodeLayoutStyle(...args: any[]): any {
        return event_isAutoNodeLayoutStyle.call(this, ...args);
    }

    private isNodeAutoLayoutForId(...args: any[]): any {
        return event_isNodeAutoLayoutForId.call(this, ...args);
    }

    private estimateCollisionBox(...args: any[]): any {
        return event_estimateCollisionBox.call(this, ...args);
    }

    private getAxisSpan(...args: any[]): any {
        return event_getAxisSpan.call(this, ...args);
    }

    private getDirectionalDistance(...args: any[]): any {
        return event_getDirectionalDistance.call(this, ...args);
    }

    private isPositionColliding(...args: any[]): any {
        return event_isPositionColliding.call(this, ...args);
    }

    private resolveShortcutPosition(...args: any[]): any {
        return event_resolveShortcutPosition.call(this, ...args);
    }

    private getFreeChildShortcutPosition(...args: any[]): any {
        return event_getFreeChildShortcutPosition.call(this, ...args);
    }

    private getAutoChildShortcutPosition(...args: any[]): any {
        return event_getAutoChildShortcutPosition.call(this, ...args);
    }

    private handleCreateChildNode(...args: any[]): any {
        return event_handleCreateChildNode.call(this, ...args);
    }

    private getFreeSiblingShortcutPosition(...args: any[]): any {
        return event_getFreeSiblingShortcutPosition.call(this, ...args);
    }

    private getAutoSiblingShortcutPosition(...args: any[]): any {
        return event_getAutoSiblingShortcutPosition.call(this, ...args);
    }

    private handleCreateSiblingNode(...args: any[]): any {
        return event_handleCreateSiblingNode.call(this, ...args);
    }

    private getFreeParentShortcutPosition(...args: any[]): any {
        return event_getFreeParentShortcutPosition.call(this, ...args);
    }

    private getAutoParentShortcutPosition(...args: any[]): any {
        return event_getAutoParentShortcutPosition.call(this, ...args);
    }

    private handleCreateParentNode(...args: any[]): any {
        return event_handleCreateParentNode.call(this, ...args);
    }

    private createPlaceholderConnectionLine(...args: any[]): any {
        return event_createPlaceholderConnectionLine.call(this, ...args);
    }

    private handleArrowKeyNavigation(...args: any[]): any {
        return event_handleArrowKeyNavigation.call(this, ...args);
    }

    private batchDeleteNodes(...args: any[]): any {
        return event_batchDeleteNodes.call(this, ...args);
    }

    private batchChangeColor(...args: any[]): any {
        return event_batchChangeColor.call(this, ...args);
    }

    private isSmartConnectionEnabled(...args: any[]): any {
        return event_isSmartConnectionEnabled.call(this, ...args);
    }

}
