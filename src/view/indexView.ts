import { toPng } from "html-to-image";
import ZKNavigationPlugin from "main";
import { ExtraButtonComponent, FileView, FuzzySuggestModal, Menu, Modal, Notice, Platform, Scope, Setting, TFile, WorkspaceLeaf, debounce, moment, setIcon, setTooltip } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { AddFreeNodeModal } from "src/modal/addFreeNodeModal";
import { expandGraphModal } from "src/modal/expandGraphModal";
import { MOCSelectorModal } from "src/modal/mocSelectorModal";
import { NoteSearchModal } from "src/modal/noteSearchModal";
import { convertMOCToZKNodes, createMOCTreeNode, getMOCFilesInFolder, isMocFile, isMocPath, MOC_FILE_SUFFIX, MOCParseResult, MOCTreeNode, NODE_FLAG_SEPARATED, NODE_FLAG_SIDE_PINNED, parseMOCStructure, saveMOCStructure, stripMocSuffix } from "src/utils/utils";
import { WorkspacePanel } from "src/view/workspace/WorkspacePanel";
import { WSMocNode } from "src/types/workspace";
import { ScratchpadDrawer } from "src/view/scratchpadDrawer";
import { NodeDetailPanel } from "src/view/index/detailPanel";
import { ScratchpadEntry } from "src/scratch/scratchpadManager";
import { resolveDroppedVaultFiles } from "src/utils/dropFileResolver";
import { createMOCJsonWithInitialNode } from "src/utils/mocJsonCodec";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { createSelectionColorPanel } from "src/renderer/colorUtils";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { RenderOptions } from "src/renderer/types";
import { MOCHandler } from "src/view/index/mocHandler";
import { computeAutoLayout, AutoLayoutNodeInput } from "src/utils/autoLayoutEngine";
import { resolveThemeMode } from "src/utils/themeMode";
import { DEFAULT_LAYOUT_PRESET, DIR_VECTORS, GrowthDirection, LayoutPreset, PRESET_POOL, normalizeLayoutPreset, quantizeToPool, stackAxisOf } from "src/utils/growthDirection";
import {
    DEBOUNCE_DELAY,
    ERROR_MESSAGES,
    SUCCESS_MESSAGES,
    KEYBOARD,
    MODAL_BUTTONS
} from "src/view/index/constants";

export const ZK_INDEX_TYPE: string = "zk-index-type";
export const ZK_INDEX_VIEW: string = t("thought-tree-graph");
export const ZK_NAVIGATION: string = "zk-navigation";

export interface ReverseRelation {
    sourceID: string;
    targetID: string;
    relationText: string;
}

export interface ZKNode {
    ID: string;
    IDArr: string[];
    IDStr: string;
    position: number;
    file: TFile | null;  // 改为可选，支持纯文字节点
    title: string;
    displayText: string;
    relationText: string;
    ctime: number;
    randomId: string;
    nodeSons: number; //used for caculating card position when export to canvas
    startY: number; //used for caculating card position when export to canvas
    height: number; //used for caculating card position when export to canvas
    isRoot: boolean;
    fixWidth: number; // used for setting the same width for siblings
    branchName: string; // for generating gitGraph
    gitNodePos: number; // for keeping node's position in gitBranch
    savedPosition?: { x: number; y: number }; // 保存的节点位置（用于 Cytoscape 图形）
    isCrossDomain?: boolean; // 是否为跨领域节点
    crossDomainSourceNodeId?: string; // 跨领域节点的源节点 ID（用于删除）
    crossDomainOriginalNodeId?: string; // 跨领域节点的原始节点 ID
    isPlaceholder?: boolean; // 是否为占位符节点（未完成编辑）
    isDraft?: boolean; // 是否为草稿节点（待审批落地，#20）
    isTextOnly?: boolean; // 是否为纯文字节点（不关联文件）
    isEmbed?: boolean; // 是否为嵌入节点（![[...]]）
    wikiLink?: string; // 原始 wikilink（用于官方预览解析）
}

interface BrancAllhNodes {
    branchTab: number;
    branchNodes: ZKNode[];
}

export class ZKIndexView extends FileView {

    plugin: ZKNavigationPlugin;
    branchAllNodes: BrancAllhNodes[];


    // 按需渲染相关属性
    branchEntranceNodes: ZKNode[] = [];
    renderedBranches: Set<number> = new Set();
    indexMermaidContainer: HTMLElement | null = null;
    private lastPickedNodeFillColor: string | null = null;

    // Cytoscape 渲染器
    private branchRenderer: CytoscapeRenderer | null = null;
    // 当前 cy 实例对应的 MOC 文件路径（用于切换时正确保存位置）
    private lastRenderedMOCPath: string | null = null;
    // 上次成功渲染时的完整签名（文件路径 + mtime + 影响渲染的设置项）。
    // 用于跳过无实质变化的 refresh：如窗口 resize、未相关事件触发的刷新等
    private lastRenderSignature: string | null = null;
    // 渲染完成后自动选中并定位的节点 ID（来自搜索选中）
    private pendingSelectNodeId: string | null = null;

    // 性能优化：节点位置缓存 Map，O(1) 查找替代 O(n) filter
    nodePositionMap: Map<number, ZKNode> = new Map();

    // MOC 模式相关属性
    mocNodes: ZKNode[] = [];                    // MOC 解析后的节点
    mocTreeStructure: MOCTreeNode[] = [];       // MOC 原始树结构
    mocReverseRelations: Map<string, ReverseRelation> = new Map(); // MOC 反向关系
    private nodeRemarks: Record<string, string> = {};
    private nodeAnchors: Record<string, boolean> = {};
    private collapsedNodeIds: string[] = [];
    private currentNodeLayoutStyle: 'free' | 'auto' = 'free'; // 当前 MOC 文件的节点布局风格（从 ext 读取，新建时锁定）
    private currentNodeLayoutOverrides: Record<string, 'auto' | 'free'> = {}; // 节点级布局风格覆盖
    private currentLayoutPreset: LayoutPreset = DEFAULT_LAYOUT_PRESET;
    private currentNodeLayoutPresets: Record<string, LayoutPreset> = {};
    // ensureNodePositions 为 auto 文件补齐缺失坐标后置位,渲染完成后触发一次居中 reflow
    private pendingInitialAutoCenter = false;

    // 防抖相关属性
    resizeTimeout: NodeJS.Timeout | null = null;
    edgeCurvatureSaveTimeout: NodeJS.Timeout | null = null;
    nodePositionSaveTimeout: NodeJS.Timeout | null = null;
    private pendingNodePositionSavePromise: Promise<void> | null = null;
    pendingPositionChanges: Map<string, { node: any; position: { x: number; y: number } }> = new Map();
    crossDomainPositionSaveTimeout: NodeJS.Timeout | null = null;
    embedNodeSizeSaveTimeout: NodeJS.Timeout | null = null;
    private changeRefreshTimer: NodeJS.Timeout | null = null;

    // 事件监听器跟踪（用于清理，防止内存泄漏）
    private registeredEventListeners: Array<{
        element: HTMLElement | Window | Document;
        event: string;
        handler: EventListenerOrEventListenerObject;
        options?: AddEventListenerOptions;
    }> = [];

    // MOC 处理器（用于 MOC 文件操作）
    private mocHandler: MOCHandler;

    // MOC 视图状态（缩放和平移）
    private mocViewStates: Map<string, { zoom: number; pan: { x: number; y: number } }> = new Map();
    private readonly MAX_MOC_VIEW_STATES = 20;

    // 占位符节点追踪（用于未完成编辑的临时节点）
    private placeholderNodes: Map<string, {
        nodeId: string;
        tempId: string;
        mocPath: string;
        content: string;
        position: { x: number; y: number };
        timestamp: number;
        parentNodeId?: string;
        suggestedNodeId?: string;  // 预生成的节点 ID
        childNodeId?: string;  // 需要移动到此节点下的子节点 ID（用于创建父节点时）
        layoutStyle?: 'free' | 'auto';
    }> = new Map();
    private readonly PLACEHOLDER_EXPIRY_MS = 10 * 60 * 1000;

    // 草稿节点(#20):AI/人产出、待审批落地的虚拟节点。纯内存,不写文件,刷新/卸载即丢失。
    // origin 由入口决定:'ai'=走 CLI/公共 API,'manual'=页面 UI 新建。
    private draftNodes: Map<string /* draftId */, {
        draftId: string;
        batchId: string;
        mocPath: string;
        content: string;
        kind: 'text' | 'file';
        origin: 'ai' | 'manual';
        position: { x: number; y: number };
        parentDraftId?: string;   // 指向同批另一个草稿(草稿内部树,P4)
        parentRealId?: string;    // 挂到已存在的真实节点
        timestamp: number;
    }> = new Map();
    // 草稿关联(#20):AI/人产出、待审批落地的「关联反向连线」。纯内存,不写文件,与草稿节点共用批次操作条。
    // key = `${source}->${target}`;端点可为已存在真实节点 IDStr,或同期草稿节点的 draftId(落地时映射成真实 ID)。
    private draftRelations: Map<string /* relKey */, {
        relKey: string;
        batchId: string;
        mocPath: string;
        source: string;
        target: string;
        label: string;
        origin: 'ai' | 'manual';
        timestamp: number;
    }> = new Map();
    private draftBatchBar: HTMLElement | null = null;
    // 草稿模式:开启后新建的节点都先作为草稿(待审批);AI 注入会自动开启,批次清空后自动关闭。
    private draftMode: boolean = false;

    // MOC 芯片标签引用（用于更新显示）
    private mocChipLabel: HTMLElement | null = null;
    private mocChipProjectBadge: HTMLElement | null = null;
    private multiverseContainer: HTMLElement | null = null;
    private levelBreadcrumbContainer: HTMLElement | null = null;
    private currentDimLevel: number | null = null;
    private levelPath: string[] = [];
    private dimMode: 'subtree' | 'level' = 'subtree';
    private focusVisibilityMode: 'hide' | 'dim' = 'hide';

    // 性能优化：防止重复刷新的标志位
    private isRefreshing: boolean = false;
    private pendingRefresh: boolean = false;

    // 性能优化：静态 UI 层标记
    private staticUICreated: boolean = false;
    private staticToolbarDiv: HTMLElement | null = null;
    // 内嵌工作区模式(typed-node 壳):图谱 ⇄ 工作区 在同一视图内切换
    private workspacePanel: WorkspacePanel | null = null;
    private workspaceMode = false;
    private scratchDrawer: ScratchpadDrawer | null = null;
    // 节点详情侧栏(单击节点 → 跟随展示备注/笔记预览)
    private detailPanel: NodeDetailPanel | null = null;
    private detailPanelLastId: string | null = null;
    private workspaceStoreUnsubscribe: (() => void) | null = null;

    // 性能优化：追踪事件监听器初始化状态，避免重复添加
    private branchGraphListenersInitialized: boolean = false;
    private currentBranchGraphDiv: HTMLElement | null = null;
    private isCreateMOCPromptOpen: boolean = false;
    private fullscreenBackButtonListenerBound: boolean = false;
    private lastHoverPreviewPath: string | null = null;
    private lastHoverPreviewAt = 0;
    // 分屏打开模式下复用的内容叶,避免每次点击都新建一个分屏
    private fileOpenSplitLeaf: WorkspaceLeaf | null = null;
    private undoStack: Array<{ filePath: string; content: string; timestamp: number }> = [];
    // 30 步在长操作会话足够使用;30 × ~50KB MOC = ~1.5MB,V8 内存无压力
    private readonly MAX_UNDO_STEPS = 30;
    private isApplyingUndo = false;
    private undoShortcutBound = false;
    private pasteListenerBound = false;

    private getFullscreenElement(): Element | null {
        const doc = document as Document & {
            webkitFullscreenElement?: Element | null;
        };
        return document.fullscreenElement || doc.webkitFullscreenElement || null;
    }

    private exitFullscreenCompat(): void {
        const doc = document as Document & {
            webkitExitFullscreen?: () => Promise<void> | void;
        };
        if (document.exitFullscreen) {
            void document.exitFullscreen();
            return;
        }
        if (doc.webkitExitFullscreen) {
            void doc.webkitExitFullscreen();
        }
    }

    private syncBranchFullscreenBackButtonVisibility(): void {
        const branchGraphDiv = this.currentBranchGraphDiv || document.getElementById('zk-branch-cytoscape');
        if (!branchGraphDiv) return;

        const backBtn = branchGraphDiv.querySelector('.zk-branch-fullscreen-back-btn') as HTMLButtonElement | null;
        if (!backBtn) return;

        backBtn.setCssStyles({ display: this.getFullscreenElement() === branchGraphDiv ? 'inline-flex' : 'none' });
    }

    private ensureBranchFullscreenBackButton(branchGraphDiv: HTMLElement): void {
        let backBtn = branchGraphDiv.querySelector('.zk-branch-fullscreen-back-btn') as HTMLButtonElement | null;
        if (!backBtn) {
            backBtn = branchGraphDiv.createEl('button', {
                cls: 'zk-branch-fullscreen-back-btn',
                attr: {
                    type: 'button',
                    'aria-label': t("exit fullscreen")
                }
            });

            const iconEl = backBtn.createSpan({ cls: 'zk-branch-fullscreen-back-icon' });
            setIcon(iconEl, 'arrow-left');

            const exitHandler = (event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (this.getFullscreenElement()) {
                    this.exitFullscreenCompat();
                }
            };

            backBtn.addEventListener('pointerdown', exitHandler);
            backBtn.addEventListener('touchstart', exitHandler, { passive: false });
            backBtn.addEventListener('click', exitHandler);
            backBtn.addEventListener('pointerup', exitHandler);
            backBtn.addEventListener('touchend', exitHandler, { passive: false });
        }

        backBtn.classList.toggle('zk-branch-fullscreen-back-btn-light', resolveThemeMode(this.plugin.settings.themeMode) === 'light');
        backBtn.classList.toggle('zk-branch-fullscreen-back-btn-dark', resolveThemeMode(this.plugin.settings.themeMode) !== 'light');
        backBtn.setAttribute('aria-label', t("exit fullscreen"));
        setTooltip(backBtn, t("exit fullscreen"));
        this.syncBranchFullscreenBackButtonVisibility();
    }

    constructor(leaf: WorkspaceLeaf, plugin: ZKNavigationPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.allowNoFile = true;
        this.scope = new Scope(this.app.scope);
        this.scope.register(['Mod'], 'f', (event: KeyboardEvent) => {
            const activeEl = document.activeElement as HTMLElement | null;
            if (activeEl && (
                activeEl.tagName === 'INPUT' ||
                activeEl.tagName === 'TEXTAREA' ||
                activeEl.isContentEditable
            )) {
                return false;
            }

            event.preventDefault();
            event.stopPropagation();
            this.openBranchSearchBar();
            return false;
        });
        // Esc 关闭节点详情侧栏(仅在面板打开且不在内联编辑时拦截;
        // 编辑中的 Esc 留给 CM6 编辑器自己取消)
        this.scope.register([], 'Escape', (event: KeyboardEvent) => {
            if (this.detailPanel?.isOpen && !this.detailPanel.isEditing && !this.detailPanel.isPinned) {
                event.preventDefault();
                event.stopPropagation();
                this.detailPanelLastId = null;
                this.detailPanel.hide();
                return false;
            }
        });
        this.scope.register([], ' ', (event: KeyboardEvent) => {
            if (this.handleDetailPanelSpaceEdit(event)) return false;
        });
        this.mocHandler = new MOCHandler(plugin, (this.app as any), {
            onBeforeModify: ({ filePath, content }) => {
                if (this.isApplyingUndo) return;
                this.pushUndoSnapshot(filePath, content);
            }
        });

        // 临时工作区:Cmd+C/X/V
        const isInputFocused = (): boolean => {
            const ae = document.activeElement as HTMLElement | null;
            return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
        };
        const isScratchpadOpen = (): boolean => !!this.scratchDrawer?.isVisible();
        this.scope.register(['Mod'], 'c', (event: KeyboardEvent) => {
            if (isInputFocused()) return;
            if (!isScratchpadOpen()) return;
            if (this.copySelectionToScratchpad('copy')) {
                event.preventDefault();
                event.stopPropagation();
                return false;
            }
        });
        this.scope.register(['Mod'], 'x', (event: KeyboardEvent) => {
            if (isInputFocused()) return;
            if (!isScratchpadOpen()) return;
            if (this.copySelectionToScratchpad('cut')) {
                event.preventDefault();
                event.stopPropagation();
                return false;
            }
        });
        // Cmd+V 优先级:外部剪贴板新内容 > 渲染器内 clipboardNodes > scratchpad 顶部条目
        // (统一在 scope 层异步调度,避免 scope 拦截后 DOM keydown 拿不到事件、scratchpad 抢先粘贴)
        this.scope.register(['Mod'], 'v', (event: KeyboardEvent) => {
            if (isInputFocused()) return;
            event.preventDefault();
            event.stopPropagation();
            void this.dispatchPasteShortcut();
            return false;
        });
    }

    getViewType(): string {
        return ZK_INDEX_TYPE;
    }
    getDisplayText(): string {
        return ZK_INDEX_VIEW;
    }

    getIcon(): string {
        return "tree-pine";
    }

    private handleDetailPanelSpaceEdit(event: KeyboardEvent): boolean {
        if (!(event.key === ' ' || event.code === 'Space') || event.repeat || !this.detailPanel?.isOpen) return false;
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && (
            activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.isContentEditable
        )) {
            return false;
        }
        if (!this.detailPanel.editCurrentRemark()) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
    }

    async onLoadFile(file: TFile): Promise<void> {
        if (!isMocFile(file)) return;
        if (this.plugin.settings.mocCurrentFile !== file.path) {
            this.plugin.settings.mocCurrentFile = file.path;
            await this.plugin.saveData(this.plugin.settings);
        }
        this.plugin.RefreshIndexViewFlag = true;
    }

    async onUnloadFile(_file: TFile): Promise<void> {
    }

    /** 图谱 ⇄ 工作区 模式切换(同一视图内整块替换,非蒙层) */
    private setWorkspaceMode(on: boolean): void {
        if (!this.workspacePanel) {
            new Notice(t("ws not ready"));
            return;
        }
        this.workspaceMode = on;
        this.workspacePanel.setVisible(on);
        if (on) this.workspacePanel.refresh();
        // 面板为 position:absolute inset:0,自然覆盖图谱工具栏与画布,无需手动隐藏
    }

    /** 工作区面板里点了带 .moc.md 的 MOC 节点 → 切回图谱模式并加载该文件 */
    private openMocFromWorkspace(node: WSMocNode): boolean {
        const path = node.filePath;
        if (!path) return false;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            new Notice(t("ws moc not found").replace('{path}', path));
            return false;
        }
        void (async () => {
            if (this.plugin.settings.mocCurrentFile !== file.path) {
                this.plugin.settings.mocCurrentFile = file.path;
                await this.plugin.saveData(this.plugin.settings);
                await this.refreshBranchMermaid();
            }
            this.setWorkspaceMode(false);
        })();
        return true;
    }

    /**
     * 添加可跟踪的事件监听器（用于后续清理，防止内存泄漏）
     */
    private addTrackedListener<T extends HTMLElement | Window | Document>(
        element: T,
        event: string,
        handler: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions
    ): void {
        element.addEventListener(event, handler, options);
        this.registeredEventListeners.push({ element, event, handler, options });    
    }

    /**
     * 清理所有跟踪的事件监听器
     */
    private cleanupEventListeners(): void {
        this.registeredEventListeners.forEach(({ element, event, handler, options }) => {
            element.removeEventListener(event, handler, options);
        });
        this.registeredEventListeners = [];
    }

    /**
     * 清理特定元素上的事件监听器
     * @param element 要清理监听器的元素
     */
    private cleanupElementListeners(element: HTMLElement | Window): void {
        // 过滤出与该元素相关的监听器
        const toKeep: Array<{ element: any; event: string; handler: any; options?: any }> = [];
        const toRemove: Array<{ element: any; event: string; handler: any; options?: any }> = [];

        this.registeredEventListeners.forEach(listener => {
            if (listener.element === element) {
                toRemove.push(listener);
            } else {
                toKeep.push(listener);
            }
        });


        // 移除该元素的所有监听器
        toRemove.forEach(({ event, handler, options }) => {
            element.removeEventListener(event, handler, options);
        });

        // 更新监听器列表，保留其他元素的监听器
        this.registeredEventListeners = toKeep;
    }

    private pushUndoSnapshot(filePath: string, content: string): void {
        const last = this.undoStack[this.undoStack.length - 1];
        if (last && last.filePath === filePath && last.content === content) {
            return;
        }
        this.undoStack.push({
            filePath,
            content,
            timestamp: Date.now()
        });
        if (this.undoStack.length > this.MAX_UNDO_STEPS) {
            this.undoStack = this.undoStack.slice(this.undoStack.length - this.MAX_UNDO_STEPS);
        }
    }

    private pruneMOCViewStates(activePath?: string | null): void {
        if (activePath && this.mocViewStates.has(activePath)) {
            const activeState = this.mocViewStates.get(activePath)!;
            this.mocViewStates.delete(activePath);
            this.mocViewStates.set(activePath, activeState);
        }

        while (this.mocViewStates.size > this.MAX_MOC_VIEW_STATES) {
            const oldestKey = this.mocViewStates.keys().next().value;
            if (!oldestKey) break;
            this.mocViewStates.delete(oldestKey);
        }
    }

    private prunePlaceholderNodes(currentMOCPath?: string | null): void {
        const now = Date.now();
        this.placeholderNodes.forEach((info, key) => {
            const expired = now - info.timestamp > this.PLACEHOLDER_EXPIRY_MS;
            const staleMOC = !!currentMOCPath && info.mocPath !== currentMOCPath;
            if (expired || staleMOC) {
                this.placeholderNodes.delete(key);
            }
        });
    }

    private createPlaceholderRecord(
        tempId: string,
        position: { x: number; y: number },
        extra: {
            parentNodeId?: string;
            suggestedNodeId?: string;
            childNodeId?: string;
            layoutStyle?: 'free' | 'auto';
        } = {}
    ): void {
        const mocPath = this.plugin.settings.mocCurrentFile || '__graph__';
        this.prunePlaceholderNodes(mocPath);
        this.placeholderNodes.set(tempId, {
            nodeId: tempId,
            tempId,
            mocPath,
            content: '',
            position,
            timestamp: Date.now(),
            parentNodeId: extra.parentNodeId,
            suggestedNodeId: extra.suggestedNodeId,
            childNodeId: extra.childNodeId,
            layoutStyle: extra.layoutStyle,
        });
    }

    // ============ 草稿节点(#20)============
    // AI(CLI)/人工(UI)产出待审批的虚拟节点。纯内存渲染,确认才经 modifyMOCData 落地。

    /**
     * 注入一批草稿节点到当前思维树视图。纯内存,不写文件。
     * @param items 每项 {content, kind?, parentRealId?, parentLocalId?, localId?}
     *   - parentRealId:挂到某个已存在真实节点(IDStr)
     *   - localId/parentLocalId:同批草稿内部父子关系(P4 用,本批渲染连线)
     * @param origin 'ai'=走 CLI/API,'manual'=页面新建
     * @returns 生成的 draftId 列表(与 items 同序)
     */
    injectDraftNodes(
        items: Array<{ content: string; kind?: 'text' | 'file'; parentRealId?: string; parentLocalId?: string; localId?: string; position?: { x: number; y: number } }>,
        origin: 'ai' | 'manual',
        batchId?: string
    ): string[] {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (!cy || !branchGraphDiv || !items?.length) return [];

        // 注入草稿即进入草稿模式(AI 自动开启);用户提交/丢弃完所有批次后自动退出。
        this.draftMode = true;

        const mocPath = this.plugin.settings.mocCurrentFile || '__graph__';
        const realBatchId = batchId || `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const localToDraft = new Map<string, string>();
        const createdIds: string[] = [];

        // 起始布局:从当前视口中心铺开(简单稳态,用户可再拖动调整)
        const extent = cy.extent();
        const centerX = (extent.x1 + extent.x2) / 2;
        const centerY = (extent.y1 + extent.y2) / 2;
        const SIBLING_GAP = 110;  // 草稿卡片高度(~90)+ 间隙,避免同父草稿堆叠重叠
        // 草稿用「预测的真实子 id」(如 1.1.a),让布局引擎按层级正确摆放;reserved 防同批重复
        const reserved = new Set<string>(this.draftNodes.keys());
        // 每个有效父下的"已有兄弟数"(真实子 + 已存在草稿子)作为起始序号,本批内累加。
        // 新草稿严格排在已有兄弟之后,保证最终顺序 = 注入顺序(reflow 按位置排序,故初始 y 必须按序递增)。
        const siblingOrder = new Map<string, number>();
        const baseSiblingCount = (parentId: string): number => {
            let c = this.isFreeNodeID(parentId) ? 0 : this.getChildNodeIds(parentId).length;
            for (const d of this.draftNodes.values()) if ((d.parentDraftId || d.parentRealId) === parentId) c++;
            return c;
        };

        items.forEach((item, idx) => {
            // 解析父节点:优先同批草稿(内部树),其次真实节点。
            // 若传入的 parentRealId 其实是一个已存在的草稿(如在草稿上 Tab/Enter),按草稿父处理。
            const parentIsExistingDraft = !!item.parentRealId && this.draftNodes.has(item.parentRealId);
            const parentDraftId = (item.parentLocalId ? localToDraft.get(item.parentLocalId) : undefined)
                || (parentIsExistingDraft ? item.parentRealId : undefined);
            const parentRealId = parentIsExistingDraft ? undefined : item.parentRealId;
            const effParent = parentDraftId || parentRealId;  // 有效父 id(真实或草稿)

            // 预测真实 id(父优先用草稿父的预测 id,其次真实父;都无则 free.N)
            const draftId = this.predictDraftId(effParent, reserved);
            reserved.add(draftId);
            if (item.localId) localToDraft.set(item.localId, draftId);

            // 兄弟序号:首次取该父已有兄弟数,本批内递增 → 严格向下排,顺序稳定
            const pk = effParent || '__root__';
            if (!siblingOrder.has(pk)) siblingOrder.set(pk, effParent ? baseSiblingCount(effParent) : 0);
            const order = siblingOrder.get(pk)!;
            siblingOrder.set(pk, order + 1);

            // 位置:点击落点优先;否则锚定父节点,按 order 向下排(reflow 随后按位置排序并居中)
            let position: { x: number; y: number };
            if (item.position) {
                position = { ...item.position };
            } else if (effParent) {
                const parentCy = this.findCyNodeByIdStr(effParent);
                const pp = parentCy ? parentCy.position() : { x: centerX, y: centerY };
                let x = pp.x + 260;
                if (parentRealId && this.isNodeAutoLayout(parentRealId)) {
                    const anchor = this.getAutoPlaceholderPosition(parentRealId, { x, y: pp.y });
                    if (anchor) x = anchor.x;
                }
                position = { x, y: pp.y + order * SIBLING_GAP };
            } else {
                position = { x: centerX, y: centerY + order * SIBLING_GAP };
            }

            this.draftNodes.set(draftId, {
                draftId,
                batchId: realBatchId,
                mocPath,
                content: item.content || '',
                kind: item.kind === 'file' ? 'file' : 'text',
                origin,
                position,
                parentDraftId,
                parentRealId,
                timestamp: Date.now(),
            });
            createdIds.push(draftId);

            // 连线父节点:挂真实节点用其 IDStr,挂同批草稿用该草稿的 cy id
            // (createPlaceholderConnectionLine 已支持两种解析)。
            const lineParent = parentRealId ?? parentDraftId;
            branchGraphDiv.dispatchEvent(new CustomEvent('add-draft-node', {
                detail: {
                    nodeId: draftId,
                    position,
                    label: item.content || '',
                    origin,
                    batchId: realBatchId,
                    parentNodeId: lineParent,
                }
            }));
        });

        this.refreshDraftBatchBar();

        // 选中最后创建的草稿,使后续 Tab/Enter 直接以它为活动节点继续(否则首个新建后无选中态)
        const lastId = createdIds[createdIds.length - 1];
        if (lastId) {
            const ln = cy.$id(lastId);
            if (ln && ln.length > 0) { cy.$(':selected').unselect(); ln.select(); }
        }

        // 草稿是合成的一等 auto 节点(isNodeAutoLayout 恒真)→ 用自动布局按真实尺寸做一次「视觉重排」
        // (persistPositions:false,不写文件):整棵草稿子树按节点高度级联让位,杜绝固定步长堆叠重叠。
        // 锚定在草稿挂载的真实父节点上——父是 auto(自动 MOC)走级联紧凑重排;父是 free(自由 MOC)
        // 则以该父为固定锚点、仅局部摆放其下的 auto 草稿子树(localOnly,不牵动用户手摆的真实节点)。
        // 草稿无文件位置,统一把草稿 id 放进 ignoreSavedPositionsForIds,确保用引擎算出的坐标而非注入落点。
        //
        // 例外:本批显式传了 position(自由布局让调用方自算坐标)时,跳过预览重排,原样尊重传入坐标——
        // 否则引擎会按 ignoreSavedPositionsForIds 重算、覆盖掉 caller 算好的位置。
        const hasExplicitPos = items.some(it => it.position);
        const realAnchors = hasExplicitPos ? new Set<string>() : new Set(
            items.map(it => it.parentRealId).filter((id): id is string => !!id && !this.draftNodes.has(id))
        );
        if (realAnchors.size > 0) {
            void (async () => {
                const draftIds = Array.from(this.draftNodes.keys());
                for (const anchor of realAnchors) {
                    const anchorIsAuto = this.getEffectiveNodeLayoutStyle(anchor) === 'auto';
                    await this.relayoutAutoLayoutSiblings(anchor, anchorIsAuto
                        ? {
                            compactVisibleNodes: true,
                            collapsedNodeIds: this.collapsedNodeIds,
                            rebalanceRootChildren: true,
                            ignoreSavedPositionsForIds: draftIds,
                            persistPositions: false,
                        }
                        : {
                            localOnly: true,
                            ignoreSavedPositionsForIds: draftIds,
                            persistPositions: false,
                        });
                }
                // 把重排后的 cy 坐标同步回内存草稿,落地时按此写入
                const c = this.branchRenderer?.getCytoscapeInstance();
                if (c) for (const [id, info] of this.draftNodes) {
                    const n = c.$id(id);
                    if (n && n.length > 0) { const p = n.position(); info.position = { x: p.x, y: p.y }; }
                }
            })();
        }
        return createdIds;
    }

    /**
     * 把当前内存里的草稿节点导出为 MOCNodeView[](供 api.queryNodes 合并返回,#20)。
     * 扁平返回(children 恒空),用 parentRealId/parentDraftId 表达挂载关系;按 opts 过滤。
     */
    getDraftNodeViews(opts: { nodeID?: string; query?: string } = {}): import("src/view/index/mocHandler").MOCNodeView[] {
        const all = Array.from(this.draftNodes.values());
        const q = opts.query?.toLowerCase();
        return all
            .filter(d => {
                if (opts.nodeID) return d.draftId === opts.nodeID;
                if (q) return `${d.draftId}\n${d.content}`.toLowerCase().includes(q);
                return true;
            })
            .map(d => ({
                nodeID: d.draftId,
                nodeType: d.kind,
                target: d.content,
                depth: 0,
                children: [],
                isDraft: true,
                draftOrigin: d.origin,
                draftBatchId: d.batchId,
                ...(d.parentRealId ? { parentRealId: d.parentRealId } : {}),
                ...(d.parentDraftId ? { parentDraftId: d.parentDraftId } : {}),
            }));
    }

    /**
     * 读取画布上所有节点的实时位置(model 坐标),供 api.queryNodes 返回更准确的 x,y。
     * auto 布局文件未必把每个节点都写进 nodePositions,但 cy 上恒有坐标,故以实时为准。
     */
    getLivePositions(): Record<string, { x: number; y: number }> {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        const out: Record<string, { x: number; y: number }> = {};
        if (!cy) return out;
        cy.nodes().forEach((n: any) => {
            const p = n.position();
            if (p && typeof p.x === 'number' && typeof p.y === 'number') {
                out[n.id()] = { x: p.x, y: p.y };
            }
        });
        return out;
    }

    /** 切换草稿模式(手动) */
    toggleDraftMode(): void {
        this.setDraftMode(!this.draftMode);
    }

    /** 设置草稿模式开关 */
    setDraftMode(on: boolean): void {
        if (this.draftMode === on) return;
        this.draftMode = on;
        new Notice(on ? t('Draft mode entered') : t('Draft mode exited'));
        this.refreshDraftBatchBar();
    }

    /** 是否处于草稿模式(供创建路径判断) */
    isDraftMode(): boolean {
        return this.draftMode;
    }

    /**
     * 草稿模式下:把刚编辑完的占位符转存为草稿(内存),不写 MOC。返回是否已处理。
     * 复用占位符的位置/智能连线父节点,保持与普通新建一致的交互。
     */
    private convertPlaceholderToDraft(nodeId: string, content: string): boolean {
        if (!this.draftMode) return false;
        const info = this.placeholderNodes.get(nodeId);
        const position = info?.position;
        const parentRealId = info?.parentNodeId;  // 智能连线父(真实节点 IDStr / free.N)
        // 先移除占位符(画布节点 + 记录 + 连线),再注入草稿
        void this.removePlaceholderNode(nodeId);
        const text = (content || '').trim();
        if (text) {
            this.injectDraftNodes([{ content: text, parentRealId, position }], 'manual');
        }
        return true;
    }

    /**
     * 草稿模式下:把"自由节点创建"(文件拖入 / 新建自由节点弹框)转存为草稿,不写 MOC。
     * 返回 true 表示已按草稿处理,调用方应 return,跳过 saveFreeNodeToMOC。
     */
    private divertFreeNodeToDraft(
        result: { wikiLink?: string; text?: string; isTextOnly?: boolean; isEmbed?: boolean; file?: TFile | null; connectToNodeID?: string },
        position?: { x: number; y: number }
    ): boolean {
        if (!this.draftMode) return false;
        const content = result.isTextOnly
            ? (result.text || '')
            : `${result.isEmbed ? '!' : ''}[[${result.wikiLink || result.file?.basename || ''}]]`;
        if (content.trim()) {
            this.injectDraftNodes([{ content, parentRealId: result.connectToNodeID || undefined, position }], 'manual');
        }
        return true;
    }

    /** 删除单个草稿节点(纯内存 + 画布,连带边随节点回收);子草稿的父引用悬空时落地按根处理 */
    deleteDraftNode(draftId: string): void {
        if (!this.draftNodes.has(draftId)) return;
        this.draftNodes.delete(draftId);
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        branchGraphDiv?.dispatchEvent(new CustomEvent('remove-draft-node', { detail: { nodeId: draftId } }));
        // 全部草稿(节点+关联)删完则退出草稿模式
        if (this.draftNodes.size === 0 && this.draftRelations.size === 0) this.draftMode = false;
        this.refreshDraftBatchBar();
    }

    /**
     * 注入一批「草稿关联」(待审批的关联反向连线,#20)。纯内存,不写文件,与草稿节点共用批次操作条。
     * 端点 source/target 可为已存在真实节点的 IDStr,或同期草稿节点的 draftId(落地时按 localToReal 映射)。
     * @param origin 'ai'=走 CLI/API,'manual'=页面新建
     * @returns 实际新增的边 key 数组(`source->target`);端点不存在 / 自环 / 已存在同向草稿边会被跳过。
     */
    injectDraftRelations(
        items: Array<{ source: string; target: string; label?: string }>,
        origin: 'ai' | 'manual',
        batchId?: string
    ): string[] {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (!cy || !branchGraphDiv || !items?.length) return [];

        // 注入草稿关联即进入草稿模式;用户提交/丢弃完所有批次后自动退出。
        this.draftMode = true;
        const mocPath = this.plugin.settings.mocCurrentFile || '__graph__';
        const realBatchId = batchId || `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const createdKeys: string[] = [];

        // 端点存在性:真实节点(originalNode.IDStr)或草稿节点(draftId)皆可——findCyNodeByIdStr 对两者都按 IDStr 命中
        const exists = (id: string) => this.draftNodes.has(id) || !!this.findCyNodeByIdStr(id);

        for (const item of items) {
            const source = String(item.source ?? '').trim();
            const target = String(item.target ?? '').trim();
            if (!source || !target || source === target) continue;
            if (!exists(source) || !exists(target)) continue;
            const relKey = `${source}->${target}`;
            if (this.draftRelations.has(relKey)) continue; // 已有同向草稿边,跳过

            this.draftRelations.set(relKey, {
                relKey,
                batchId: realBatchId,
                mocPath,
                source,
                target,
                label: item.label ?? '',
                origin,
                timestamp: Date.now(),
            });
            createdKeys.push(relKey);

            branchGraphDiv.dispatchEvent(new CustomEvent('add-draft-relation', {
                detail: { relKey, source, target, label: item.label ?? '', origin, batchId: realBatchId }
            }));
        }

        this.refreshDraftBatchBar();
        return createdKeys;
    }

    /** 删除单个草稿关联(纯内存 + 画布);全部草稿(节点+关联)清空后退出草稿模式 */
    deleteDraftRelation(relKey: string): void {
        if (!this.draftRelations.has(relKey)) return;
        this.draftRelations.delete(relKey);
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        branchGraphDiv?.dispatchEvent(new CustomEvent('remove-draft-relation', { detail: { relKey } }));
        if (this.draftNodes.size === 0 && this.draftRelations.size === 0) this.draftMode = false;
        this.refreshDraftBatchBar();
    }

    /**
     * 删除一批节点(供 CLI / API,#20)。区分草稿与真实节点:
     * - 草稿节点:直接丢弃(纯内存,不弹确认)
     * - 真实节点:逐个弹「删除确认」对话框,用户确认才真删(连同后代,清元数据并刷新画布)
     * @returns 各类结果的 nodeID 汇总
     */
    async requestDeleteNodes(nodeIds: string[]): Promise<{
        deleted: string[]; draftsDiscarded: string[]; cancelled: string[]; notFound: string[];
    }> {
        const deleted: string[] = [];
        const draftsDiscarded: string[] = [];
        const cancelled: string[] = [];
        const notFound: string[] = [];
        if (this.isMobileReadOnly()) return { deleted, draftsDiscarded, cancelled, notFound };

        for (const raw of nodeIds || []) {
            const id = String(raw ?? '').trim();
            if (!id) continue;

            // 草稿节点:随便删(丢弃),不弹确认
            if (this.draftNodes.has(id)) {
                this.deleteDraftNode(id);
                draftsDiscarded.push(id);
                continue;
            }

            // 真实节点:先弹确认,确认后才删
            const cyNode = this.findCyNodeByIdStr(id);
            const original = cyNode?.data('originalNode') as ZKNode | undefined;
            if (!cyNode || !original) { notFound.push(id); continue; }

            const relationCount = cyNode.connectedEdges().length;
            const confirmed = await this.showDeleteConfirmDialog(original, relationCount);
            if (!confirmed) { cancelled.push(id); continue; }

            // 已确认 → 复用完整删除流程;传 relationCount=0 跳过其内部的二次确认,避免重复弹窗
            await this.deleteNodeFromGraph(original, 0);
            deleted.push(id);
        }
        return { deleted, draftsDiscarded, cancelled, notFound };
    }

    /** 更新草稿节点内容(纯内存):同步 Map 与画布 label */
    updateDraftContent(draftId: string, content: string): void {
        const info = this.draftNodes.get(draftId);
        if (!info) return;
        info.content = content;
        const cy = this.branchRenderer?.getCytoscapeInstance();
        const node = cy?.$id(draftId);
        // 草稿走原生 label,直接改 data 即时重绘,无需重建 overlay
        if (node && node.length > 0) node.data('label', content);
    }

    /**
     * 草稿连线(#20):把草稿端点改父子,纯内存,不写 MOC。箭头 source→target 表示 source 是父。
     * - target 是草稿 → 让 target 认 source 为父(draft→draft / real→draft)
     * - 否则 source 是草稿 → 让 source 认 target 为父(draft→real,把草稿挂到已有节点下)
     * 父若也是草稿用 parentDraftId,否则用 parentRealId;随后重绘该草稿的连线。
     */
    private connectDraftRelation(sourceId: string, targetId: string): void {
        const reparent = (childId: string, parentId: string) => {
            const child = this.draftNodes.get(childId);
            if (!child) return;
            if (this.draftNodes.has(parentId)) {
                child.parentDraftId = parentId;
                child.parentRealId = undefined;
            } else {
                child.parentRealId = parentId;
                child.parentDraftId = undefined;
            }
            const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
            branchGraphDiv?.dispatchEvent(new CustomEvent('draft-relink', {
                detail: { childId, parentId }
            }));
        };

        if (this.draftNodes.has(targetId)) reparent(targetId, sourceId);
        else if (this.draftNodes.has(sourceId)) reparent(sourceId, targetId);
    }

    /** 一键确认落地所有草稿:经 modifyMOCData 写入真实 MOC,然后刷新重渲染为真实节点 */
    async commitAllDrafts(): Promise<void> {
        if (this.isMobileReadOnly()) return;
        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile) {
            new Notice(t('Draft no moc'));
            return;
        }

        // 取出全部草稿(节点 + 关联)
        const all = Array.from(this.draftNodes.values());
        const allRels = Array.from(this.draftRelations.values());
        if (!all.length && !allRels.length) return;
        // 节点按父子层级(父先子后)排序,使 parentLocalId 引用先落地
        const ordered = this.topoSortDrafts(all);

        // 落地前快照每个草稿在画布上的实时位置(model 坐标),写回 MOC 让节点停在原处
        const cy = this.branchRenderer?.getCytoscapeInstance();
        const livePos = new Map<string, { x: number; y: number }>();
        ordered.forEach(d => {
            const n = cy?.$id(d.draftId);
            if (n && n.length > 0) {
                const p = n.position();
                livePos.set(d.draftId, { x: p.x, y: p.y });
            }
        });

        // 用 draftId 作为 localId,parentDraftId 作为批内父引用(跨批也唯一),一次性解析建树
        const items = ordered.map(d => ({
            localId: d.draftId,
            title: d.content,
            kind: d.kind,
            parentLocalId: d.parentDraftId,
            parentRealId: d.parentRealId,
            position: livePos.get(d.draftId) ?? d.position,
        }));

        try {
            // 1) 先落地草稿节点,拿到 draftId → 真实节点 ID 的映射(供关联端点改写)
            const localToReal = all.length
                ? await this.mocHandler.addDraftTreeToMOC(mocFile, items)
                : new Map<string, string>();
            // 2) 再落地草稿关联:端点若指向草稿节点(draftId)则映射成刚落地的真实 ID
            if (allRels.length) {
                const relItems = allRels.map(r => ({
                    source: localToReal.get(r.source) ?? r.source,
                    target: localToReal.get(r.target) ?? r.target,
                    label: r.label,
                }));
                await this.mocHandler.addRelationsToMOC(mocFile, relItems);
            }
            new Notice(allRels.length
                ? t('Draft committed mixed').replace('{n}', String(localToReal.size)).replace('{r}', String(allRels.length))
                : t('Draft committed').replace('{n}', String(localToReal.size)));
        } catch (e) {
            console.error('[Draft] commit failed:', e);
            new Notice(t('Draft commit failed'));
            return;
        }

        // 清空所有草稿(内存 + 画布)并退出草稿模式,强制重建以正确渲染落地后的真实树
        this.clearAllDrafts();
        this.draftMode = false;
        await this.refreshBranchMermaid(true);
    }

    /** 一键驳回所有草稿:全部移除,不影响真实数据,并退出草稿模式 */
    discardAllDrafts(): void {
        this.clearAllDrafts();
        this.draftMode = false;
        // 预览期的 reflow 只改了 cy 视觉(未写文件),丢弃后强制从文件重建,
        // 让被预览推动的真实节点恢复原布局(普通刷新因 mtime 未变会走 no-op 短路)。
        void this.refreshBranchMermaid(true);
    }

    /** 草稿内部父子拓扑排序(父先子后),用于落地顺序 */
    private topoSortDrafts(batch: Array<{ draftId: string; parentDraftId?: string }>): any[] {
        const byId = new Map(batch.map(d => [d.draftId, d]));
        const result: any[] = [];
        const visited = new Set<string>();
        const visit = (d: any) => {
            if (visited.has(d.draftId)) return;
            if (d.parentDraftId && byId.has(d.parentDraftId)) visit(byId.get(d.parentDraftId));
            visited.add(d.draftId);
            result.push(d);
        };
        batch.forEach(visit);
        return result;
    }

    /** 清空所有草稿(节点 + 关联;视图刷新/卸载时调用) */
    clearAllDrafts(): void {
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        const batchIds = new Set<string>([
            ...Array.from(this.draftNodes.values()).map(d => d.batchId),
            ...Array.from(this.draftRelations.values()).map(r => r.batchId),
        ]);
        // remove-draft-batch 同时回收该批次的草稿节点与草稿关联边
        batchIds.forEach(bid => branchGraphDiv?.dispatchEvent(new CustomEvent('remove-draft-batch', { detail: { batchId: bid } })));
        this.draftNodes.clear();
        this.draftRelations.clear();
        this.removeDraftBatchBar();
    }

    /** 重建画布右上角的草稿操作条:单一一条,汇总全部草稿,一键提交 / 驳回 */
    private refreshDraftBatchBar(): void {
        this.removeDraftBatchBar();

        const nodeCount = this.draftNodes.size;
        const relCount = this.draftRelations.size;
        const total = nodeCount + relCount;
        const hasAi = Array.from(this.draftNodes.values()).some(d => d.origin === 'ai')
            || Array.from(this.draftRelations.values()).some(r => r.origin === 'ai');
        // 无草稿且未开启草稿模式 → 不显示
        if (total === 0 && !this.draftMode) return;

        const host = document.getElementById("zk-branch-cytoscape");
        if (!host) return;

        const bar = document.createElement('div');
        bar.className = 'zk-draft-batch-bar';
        bar.setCssStyles({
            position: 'absolute',
            top: '12px',
            right: '12px',
            zIndex: '20',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            maxWidth: '360px',
            padding: '8px 10px',
            borderRadius: '10px',
            background: 'var(--background-secondary)',
            border: `1px ${total === 0 ? 'dashed' : 'solid'} ${hasAi ? '#a855f7' : '#94a3b8'}`,
            boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
        });

        const tag = document.createElement('span');
        tag.textContent = hasAi ? t('Draft tag ai') : t('Draft tag manual');
        tag.setCssStyles({
            fontSize: '11px',
            fontWeight: '700',
            color: '#fff',
            padding: '2px 6px',
            borderRadius: '6px',
            background: `${hasAi ? '#a855f7' : '#64748b'}`,
        });

        const label = document.createElement('span');
        label.textContent = total === 0
            ? t('Draft mode entered')
            : (nodeCount > 0 && relCount > 0)
                ? t('Draft mixed count').replace('{n}', String(nodeCount)).replace('{r}', String(relCount))
                : relCount > 0
                    ? t('Draft relation count').replace('{r}', String(relCount))
                    : t('Draft batch count').replace('{n}', String(nodeCount));
        label.setCssStyles({
            fontSize: '12px',
            flex: '1',
            color: 'var(--text-normal)',
        });

        bar.appendChild(tag);
        bar.appendChild(label);

        if (total > 0) {
            const commitBtn = document.createElement('button');
            commitBtn.textContent = t('Draft confirm');
            commitBtn.setCssStyles({
                fontSize: '12px',
                padding: '4px 10px',
                borderRadius: '6px',
                cursor: 'pointer',
                border: 'none',
                color: '#fff',
                background: 'var(--interactive-accent)',
            });
            commitBtn.onclick = () => { void this.commitAllDrafts(); };
            bar.appendChild(commitBtn);
        }

        const discardBtn = document.createElement('button');
        discardBtn.textContent = total > 0 ? t('Draft discard') : t('Draft mode exit');
        discardBtn.setCssStyles({
            fontSize: '12px',
            padding: '4px 10px',
            borderRadius: '6px',
            cursor: 'pointer',
            border: '1px solid var(--background-modifier-border)',
            background: 'transparent',
            color: 'var(--text-muted)',
        });
        discardBtn.onclick = () => this.discardAllDrafts();
        bar.appendChild(discardBtn);

        host.appendChild(bar);
        this.draftBatchBar = bar;
    }

    private removeDraftBatchBar(): void {
        if (this.draftBatchBar?.parentNode) this.draftBatchBar.parentNode.removeChild(this.draftBatchBar);
        this.draftBatchBar = null;
        // 兜底清理可能残留的同类节点
        document.querySelectorAll('.zk-draft-batch-bar').forEach(el => el.remove());
    }

    private async undoLastMOCChange(): Promise<void> {
        const currentMOCPath = this.plugin.settings.mocCurrentFile;
        if (!currentMOCPath) {
            new Notice('当前没有可回退的 MOC');
            return;
        }

        let targetIndex = -1;
        for (let i = this.undoStack.length - 1; i >= 0; i--) {
            if (this.undoStack[i].filePath === currentMOCPath) {
                targetIndex = i;
                break;
            }
        }

        if (targetIndex < 0) {
            new Notice('没有可回退的操作');
            return;
        }

        const snapshot = this.undoStack.splice(targetIndex, 1)[0];
        const mocFile = this.app.vault.getFileByPath(snapshot.filePath);
        if (!mocFile) {
            new Notice('回退失败：MOC 文件不存在');
            return;
        }

        this.isApplyingUndo = true;
        try {
            await this.app.vault.modify(mocFile, snapshot.content);
            await this.refreshBranchMermaid();
            new Notice('已回退 1 步');
        } catch (error) {
            console.error('Undo failed:', error);
            new Notice(`回退失败: ${error.message}`);
        } finally {
            this.isApplyingUndo = false;
        }
    }

    /**
     * 清理所有防抖定时器
     */
    private cleanupTimers(): void {
        if (this.resizeTimeout) {
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = null;
        }
        if (this.edgeCurvatureSaveTimeout) {
            clearTimeout(this.edgeCurvatureSaveTimeout);
            this.edgeCurvatureSaveTimeout = null;
        }
        if (this.nodePositionSaveTimeout) {
            clearTimeout(this.nodePositionSaveTimeout);
            this.nodePositionSaveTimeout = null;
        }
        if (this.crossDomainPositionSaveTimeout) {
            clearTimeout(this.crossDomainPositionSaveTimeout);
            this.crossDomainPositionSaveTimeout = null;
        }
        if (this.embedNodeSizeSaveTimeout) {
            clearTimeout(this.embedNodeSizeSaveTimeout);
            this.embedNodeSizeSaveTimeout = null;
        }
        if (this.changeRefreshTimer) {
            clearTimeout(this.changeRefreshTimer);
            this.changeRefreshTimer = null;
        }
    }

    onResize() {

        if (this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE).length > 0 && this.containerEl.offsetHeight !== 0) {

            if (this.plugin.indexViewOffsetHeight !== this.containerEl.offsetHeight ||
                this.plugin.indexViewOffsetWidth !== this.containerEl.offsetWidth) {

                // 使用防抖来避免频繁触发刷新
                if (this.resizeTimeout) {
                    clearTimeout(this.resizeTimeout);
                }

                this.resizeTimeout = setTimeout(() => {
                    this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                    this.resizeTimeout = null;
                }, DEBOUNCE_DELAY.RESIZE);
            }
        }
    }

    /**
     * 检查当前是否正在显示指定的 MOC 文件
     */
    private isDisplayingMOC(mocFile: TFile): boolean {
        // 检查当前的 lastRetrival 是否指向该 MOC 文件
        if (this.plugin.settings.lastRetrival.type === 'moc' && 
            this.plugin.settings.lastRetrival.filePath === mocFile.path) {
            return true;
        }
        return false;
    }

    /**
     * 显示加载指示器
     */
    private showLoadingIndicator(container: HTMLElement): HTMLElement {
        const indicator = container.createDiv("zk-loading-indicator");
        indicator.createDiv("zk-spinner");
        indicator.createEl("span", { text: t("Updating...") });
        indicator.setCssStyles({
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'var(--background-primary)',
            padding: '20px',
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            zIndex: '1000',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
        });
        return indicator;
    }

    /**
     * 平滑更新视图（避免闪烁）
     */
    private async smoothUpdateView(container: HTMLElement, updateFn: () => Promise<void>): Promise<void> {
        // 显示加载指示器
        const indicator = this.showLoadingIndicator(container);

        try {
            // 执行更新（不做 opacity 动画，避免闪烁）
            await updateFn();
        } catch (error) {
            console.error("Index View: Error during smooth update", error);
        } finally {
            indicator.remove();
        }
    }

    async IndexViewInterfaceInit() {
        let { containerEl } = this;

        // 主题类(每次都要重设,否则切主题不生效)
        // Nebula 跟随 themeMode:暗色=深空黑底霓虹,浅色=浅灰冷底白卡柔影
        // (styles.css 按 .zk-style-nebula.zk-theme-dark/light 分别提供容器变量与画布渐变)。
        const isNebula = this.plugin.settings.themeStyle === 'nebula';
        const isLight = resolveThemeMode(this.plugin.settings.themeMode) === 'light';
        containerEl.toggleClass('zk-theme-light', isLight);
        containerEl.toggleClass('zk-theme-dark', !isLight);
        containerEl.toggleClass('zk-style-nebula', isNebula);

        // 性能优化：分离静态 UI 层和动态图形层
        // 只在首次创建时初始化静态 UI
        if (!this.staticUICreated) {
            containerEl.empty();
            containerEl.addClass("zk-view-content");

            // 创建静态工具栏（只创建一次）
            this.staticToolbarDiv = containerEl.createDiv("zk-index-toolbar");
            await this.createStaticToolbarUI(this.staticToolbarDiv);

            // 创建动态图形容器（保留引用，后续不清空）
            const indexMermaidDiv = containerEl.createDiv("zk-index-mermaid-container");
            indexMermaidDiv.id = "zk-index-mermaid-container";

            // 临时工作区抽屉(左侧),跨 MOC 共享的节点暂存
            if (this.plugin.scratchpad) {
                this.scratchDrawer = new ScratchpadDrawer(
                    containerEl,
                    this.plugin.scratchpad,
                    this.app,
                    () => ({
                        path: this.plugin.settings.mocCurrentFile,
                        name: this.getCurrentMOCDisplayName(),
                    }),
                );
                this.registerScratchpadDocumentListeners();
            }

            // 节点详情侧栏(右侧/左侧,覆盖在图上)
            this.detailPanel = new NodeDetailPanel(containerEl, this.app, {
                getRemark: (n) => this.getNodeRemark(n),
                getLabel: (idStr) => this.getNodeLabelByIdStr(idStr),
                getBranchColor: (n) => this.findCyNodeByIdStr(n.IDStr)?.data('branchNodeBorder') || null,
                onSaveRemark: (n, text) => this.saveNodeRemarkFromPanel(n, text),
                canEdit: () => !this.isMobileReadOnly(),
                onOpenFile: (file) => { this.openFileInPreferredLeaf(file, false); },
                onNavigate: (idStr) => this.selectAndShowDetailByIdStr(idStr),
                attachSelectionToolbar: (rootEl, applyTransform, hostContainer) =>
                    this.branchRenderer?.attachSelectionToolbarToHost(rootEl, applyTransform, hostContainer) ?? null,
                onWidthChange: (px) => { this.plugin.settings.detailPanelWidth = px; void this.plugin.saveData(this.plugin.settings); },
                onPinChange: (pinned) => { this.plugin.settings.detailPanelPinned = pinned; void this.plugin.saveData(this.plugin.settings); },
                component: this,
            });
            this.detailPanel.setSide(this.plugin.settings.detailPanelSide === 'left' ? 'left' : 'right');
            this.detailPanel.setWidth(this.plugin.settings.detailPanelWidth || 0);
            if (this.plugin.settings.detailPanelPinned) this.detailPanel.setPinned(true);

            // 订阅工作区变化,实时刷新项目徽章(挂载状态现以 WorkspaceStore 为准)
            if (this.plugin.workspaceStore && !this.workspaceStoreUnsubscribe) {
                this.workspaceStoreUnsubscribe = this.plugin.workspaceStore.onChange(() => {
                    this.refreshProjectBadge(this.plugin.settings.mocCurrentFile);
                });
            }

            // 内嵌工作区面板(绝对覆盖整个内容区,默认隐藏;由工具栏「工作区」按钮切换)
            if (this.plugin.workspaceStore) {
                this.workspacePanel = new WorkspacePanel(containerEl, {
                    app: this.app,
                    store: this.plugin.workspaceStore,
                    owner: this,
                    projectFolderPath: this.plugin.settings.projectFolderPath,
                    taskPrefix: this.plugin.settings.wsTaskPrefix,
                    onExitToGraph: () => this.setWorkspaceMode(false),
                    onOpenMoc: (node: WSMocNode) => this.openMocFromWorkspace(node),
                });
                this.workspacePanel.setVisible(false);
            }

            this.staticUICreated = true;
        } else {
            // 已创建过静态 UI，不清空图形容器（由各渲染函数内部增量更新）
        }

        // 刷新图形内容（动态层）
        await this.refreshBranchMermaid();
    }

    /**
     * 创建静态工具栏 UI（只创建一次）
     */
    private async createStaticToolbarUI(toolbarDiv: HTMLElement): Promise<void> {
        // 面包屑导航区域
        const breadcrumbNav = toolbarDiv.createDiv("zk-breadcrumb-nav");

        if (this.plugin.settings.MainNoteButton == true) {
            const mainNoteChip = breadcrumbNav.createDiv("zk-chip zk-chip-outlined");
            mainNoteChip.createSpan("zk-chip-label").setText(this.plugin.settings.MainNoteButtonText);
            mainNoteChip.addEventListener("click", () => {
                this.openNoteSearchModal();
            });

            // 面包屑分隔符
            breadcrumbNav.createSpan("zk-breadcrumb-sep").setText("\u203A");
        }

        if (this.plugin.settings.IndexButton == true) {
            const indexChip = breadcrumbNav.createDiv("zk-chip zk-chip-outlined");
            setIcon(indexChip.createSpan("zk-chip-icon"), "search");
            indexChip.createSpan("zk-chip-label").setText(this.plugin.settings.IndexButtonText);
            indexChip.addEventListener("click", () => {
                if (this.plugin.settings.SuggestMode === "keywordOrder") {
                    new indexModal(this.app, this.plugin, this.plugin.MainNotes, (index) => {
                        this.plugin.settings.lastRetrival = {
                            type: 'index',
                            ID: '',
                            displayText: index.keyword,
                            filePath: index.path,
                            openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                        }
                        this.plugin.clearShowingSettings();
                        this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                    }).open();
                } else {
                    new indexFuzzyModal(this.app, this.plugin, this.plugin.MainNotes, (index) => {
                        this.plugin.settings.lastRetrival = {
                            type: 'index',
                            ID: '',
                            displayText: index.keyword,
                            filePath: index.path,
                            openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                        }
                        this.plugin.clearShowingSettings();
                        this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                    }).open();
                }
            });

            breadcrumbNav.createSpan("zk-breadcrumb-sep").setText("\u203A");
        }

        // MOC 选择器
        const mocChip = breadcrumbNav.createDiv("zk-chip zk-chip-filled");
        setIcon(mocChip.createSpan("zk-chip-icon"), "git-fork");
        const mocLabel = mocChip.createSpan("zk-chip-label");

        // 项目徽章(默认隐藏,加载 MOC 后根据 isProject 决定显示)
        const projectBadge = mocChip.createSpan("zk-chip-project-badge");
        setIcon(projectBadge, "ruler");
        setTooltip(projectBadge, t("Project"));

        // 获取当前MOC名称
        const currentMOCPath = this.plugin.settings.mocCurrentFile;
        const currentMOCFile = currentMOCPath ? this.app.vault.getAbstractFileByPath(currentMOCPath) : null;
        let currentMOCName = currentMOCFile instanceof TFile ? currentMOCFile.basename : t("Untitled");
        const maxLength = 12;
        if (currentMOCName.length > maxLength) {
            currentMOCName = currentMOCName.substring(0, maxLength) + "...";
        }
        mocLabel.setText(currentMOCName);

        // 保存引用以便后续更新
        this.mocChipLabel = mocLabel;
        this.mocChipProjectBadge = projectBadge;
        mocChip.addEventListener("click", () => {
            this.openMOCSelectorModal();
        });

        // 平行宇宙面包屑：选中节点 + MOC 徽章（动态区域）
        this.multiverseContainer = breadcrumbNav.createDiv("zk-multiverse-container");
        this.multiverseContainer.setCssStyles({ display: "none" });

        // 层级面包屑：选中节点的 Luhmann 层级路径，点击可暗淡更深层的节点
        this.levelBreadcrumbContainer = breadcrumbNav.createDiv("zk-level-breadcrumb");
        this.levelBreadcrumbContainer.setCssStyles({ display: "none" });

        // 右侧工具按钮（用 spacer 推到右边）
        const spacer = toolbarDiv.createDiv("zk-toolbar-spacer");

        // 创建右侧按钮容器
        const rightBtns = toolbarDiv.createDiv("zk-toolbar-right-buttons");

        const workspaceBtn = new ExtraButtonComponent(rightBtns);
        workspaceBtn.setIcon("layout-grid").setTooltip(t("ws Workspace"));
        workspaceBtn.onClick(() => {
            this.setWorkspaceMode(!this.workspaceMode);
        });

        const searchBtn = new ExtraButtonComponent(rightBtns);
        searchBtn.setIcon("search").setTooltip(t("search placeholder"));
        searchBtn.onClick(() => {
            this.openBranchSearchBar();
        });

        const sep = document.createElement("span");
        sep.className = "zk-toolbar-separator";
        rightBtns.appendChild(sep);

        const centerBtn = new ExtraButtonComponent(rightBtns);
        centerBtn.setIcon("target").setTooltip("center");
        centerBtn.onClick(() => {
            if (this.branchRenderer) {
                this.branchRenderer.fitAndCenter();
            }
        });

        const expandBtn = new ExtraButtonComponent(rightBtns);
        expandBtn.setIcon("expand").setTooltip(t("expand graph"));
        expandBtn.onClick(() => {
            const div = document.getElementById("zk-branch-cytoscape");
            if (div && div.requestFullscreen) {
                div.requestFullscreen();
            }
        });

        const moreBtn = new ExtraButtonComponent(rightBtns);
        moreBtn.setIcon("more-horizontal").setTooltip(t("more options"));
        moreBtn.onClick(() => {
            this.showMoreMenu(moreBtn.extraSettingsEl);
        });
    }

    /**
     * 显示"更多"下拉菜单
     */
    private showMoreMenu(btnEl: HTMLElement): void {
        // 移除已有菜单
        const existingMenu = document.querySelector('.zk-more-menu');
        if (existingMenu) {
            existingMenu.remove();
            return; // toggle 行为
        }

        const btnRect = btnEl.getBoundingClientRect();
        const menu = document.body.createDiv('zk-more-menu');
        menu.setCssStyles({
            position: 'fixed',
            zIndex: '10000',
        });

        // 草稿模式开关(#20):开启后新建节点都先作为草稿,待审批落地
        const draftOption = menu.createDiv('zk-menu-option');
        setIcon(draftOption.createSpan('zk-menu-option-icon'), this.draftMode ? 'check-square' : 'square-pen');
        draftOption.createSpan().setText(this.draftMode ? t('Draft mode on') : t('Draft mode off'));
        draftOption.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            this.toggleDraftMode();
        });
        menu.createDiv('zk-menu-separator');

        // 添加到项目文件夹(仅 .moc / .moc.md 可用)
        const currentPath = this.plugin.settings.mocCurrentFile;
        const currentFile = currentPath ? this.app.vault.getFileByPath(currentPath) : null;
        if (currentFile && isMocFile(currentFile)) {
            const mountedCount = this.plugin.workspaceStore
                ?.containersHostingFile(currentFile.path).length ?? 0;
            const mountOption = menu.createDiv('zk-menu-option');
            setIcon(mountOption.createSpan('zk-menu-option-icon'), 'folder-plus');
            const labelText = mountedCount > 0
                ? t("Manage project folder mounts").replace("{count}", String(mountedCount))
                : t("Add to project folder...");
            mountOption.createSpan().setText(labelText);
            mountOption.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.remove();
                this.plugin.openFolderMountModal(currentFile);
            });

            // 分隔线
            menu.createDiv('zk-menu-separator');
        }

        // 导出为图片（带子菜单）
        const exportOption = menu.createDiv('zk-menu-option');
        setIcon(exportOption.createSpan('zk-menu-option-icon'), 'image');
        exportOption.createSpan().setText(t('export as image'));
        setIcon(exportOption.createSpan('zk-menu-option-arrow'), 'chevron-right');

        exportOption.addEventListener('click', (e) => {
            e.stopPropagation();
            // 切换子菜单
            let sub = menu.querySelector('.zk-more-submenu') as HTMLElement | null;
            if (sub) {
                sub.remove();
                return;
            }
            sub = menu.createDiv('zk-more-submenu');

            const mediumOption = sub.createDiv('zk-menu-option');
            setIcon(mediumOption.createSpan('zk-menu-option-icon'), 'file-image');
            mediumOption.createSpan().setText(t('export medium quality'));
            mediumOption.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                menu.remove();
                await this.exportGraphAsImage(2);
            });

            const highOption = sub.createDiv('zk-menu-option');
            setIcon(highOption.createSpan('zk-menu-option-icon'), 'file-image');
            highOption.createSpan().setText(t('export high quality'));
            highOption.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                menu.remove();
                await this.exportGraphAsImage(4);
            });
        });

        // 分隔线
        menu.createDiv('zk-menu-separator');

        // 导出为交互式 HTML
        const htmlOption = menu.createDiv('zk-menu-option');
        setIcon(htmlOption.createSpan('zk-menu-option-icon'), 'code');
        htmlOption.createSpan().setText(t('export as html'));
        htmlOption.addEventListener('click', async (e) => {
            e.stopPropagation();
            menu.remove();
            await this.exportGraphAsHTML();
        });

        // 定位菜单：在按钮下方
        menu.setCssStyles({ top: `${btnRect.bottom + 4}px` });
        menu.setCssStyles({ right: `${document.documentElement.clientWidth - btnRect.right}px` });

        // 点击其他地方关闭
        const closeMenu = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 导出当前图形为 PNG 图片
     */
    private async exportGraphAsImage(scale: number): Promise<void> {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        const graphDiv = document.getElementById('zk-branch-cytoscape');
        if (!cy || !graphDiv) {
            new Notice(t('export fail'));
            return;
        }

        const savedZoom = cy.zoom();
        const savedPan = { ...cy.pan() };

        try {
            const savedWidth = graphDiv.style.width;
            const savedHeight = graphDiv.style.height;
            const savedPosition = graphDiv.style.position;
            const savedOverflow = graphDiv.style.overflow;

            // 计算全图 bounding box（模型坐标）
            const bb = cy.elements().boundingBox();
            const padding = 60;

            // 浏览器 canvas 像素上限（安全值）
            const maxCanvasDim = 8192;
            // 计算最大允许的 zoom，确保 容器尺寸 * pixelRatio < 上限
            const rawW = bb.w + padding * 2;
            const rawH = bb.h + padding * 2;
            let exportZoom = 1;
            const maxDim = Math.max(rawW, rawH) * scale;
            if (maxDim > maxCanvasDim) {
                exportZoom = maxCanvasDim / (Math.max(rawW, rawH) * scale);
            }

            const fullW = Math.ceil(rawW * exportZoom);
            const fullH = Math.ceil(rawH * exportZoom);

            // 临时撑大容器，以 exportZoom 渲染全图
            graphDiv.setCssStyles({
                width: `${fullW}px`,
                height: `${fullH}px`,
                overflow: 'hidden',
            });

            cy.resize();
            cy.viewport({
                zoom: exportZoom,
                pan: { x: (-bb.x1 + padding) * exportZoom, y: (-bb.y1 + padding) * exportZoom }
            });

            // 等待 overlay 重新定位
            await new Promise(r => setTimeout(r, 300));

            const canvasBg = getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || '#1e1e1e';

            const dataUrl = await toPng(graphDiv, {
                pixelRatio: scale,
                backgroundColor: canvasBg,
                width: fullW,
                height: fullH,
                filter: (node: HTMLElement) => {
                    if (node.classList?.contains('zk-node-add-btn')) return false;
                    if (node.classList?.contains('zk-batch-toolbar')) return false;
                    if (node.classList?.contains('zk-more-menu')) return false;
                    return true;
                },
            });

            // 恢复容器尺寸和视口
            graphDiv.setCssStyles({
                width: savedWidth,
                height: savedHeight,
                position: savedPosition,
                overflow: savedOverflow,
            });
            cy.resize();
            cy.viewport({ zoom: savedZoom, pan: savedPan });

            // 触发下载
            const a = document.createElement('a');
            const mocPath = this.plugin.settings.mocCurrentFile || 'graph';
            const baseName = mocPath.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
            a.href = dataUrl;
            a.download = `${baseName}-${Date.now()}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            new Notice(t('export success'));
        } catch (err) {
            console.error('[ZK] export graph as image failed', err);
            // 尝试恢复
            graphDiv.setCssStyles({
                width: '',
                height: '',
            });
            cy.resize();
            cy.viewport({ zoom: savedZoom, pan: savedPan });
            new Notice(t('export fail'));
        }
    }

    /**
     * 导出为自包含交互式 HTML（可拖拽 / 缩放）
     */
    private async exportGraphAsHTML(): Promise<void> {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) {
            new Notice(t('export fail'));
            return;
        }

        try {
            // 提取每个节点/边的计算后样式
            const nodes: any[] = [];
            cy.nodes().forEach((n: any) => {
                if (n.style('display') === 'none') return;
                const d = n.data();
                nodes.push({
                    data: {
                        id: d.id,
                        label: d.label || '',
                        isRoot: !!d.isRoot,
                        isEmbed: !!d.isEmbed,
                        isGroup: !!d.isGroup,
                        isTextOnly: !!d.isTextOnly,
                        isStandaloneText: !!d.isStandaloneText,
                    },
                    position: { ...n.position() },
                    style: {
                        'width': n.width(),
                        'height': n.height(),
                        'background-color': n.style('background-color'),
                        'background-opacity': n.style('background-opacity'),
                        'border-width': n.style('border-width'),
                        'border-color': n.style('border-color'),
                        'color': n.style('color'),
                        'font-size': n.style('font-size'),
                        'font-weight': n.style('font-weight'),
                        'shape': n.style('shape'),
                        'label': d.isEmbed ? '' : (d.label || ''),
                        'opacity': n.style('opacity'),
                    }
                });
            });

            const edges: any[] = [];
            cy.edges().forEach((e: any) => {
                if (e.style('display') === 'none') return;
                const d = e.data();
                edges.push({
                    data: {
                        id: d.id,
                        source: d.source,
                        target: d.target,
                        label: d.label || '',
                    },
                    style: {
                        'width': e.style('width'),
                        'line-color': e.style('line-color'),
                        'target-arrow-color': e.style('target-arrow-color'),
                        'target-arrow-shape': e.style('target-arrow-shape'),
                        'curve-style': e.style('curve-style'),
                    }
                });
            });

            const bgColor = getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || '#1e1e1e';

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mind Map Export</title>
<script src="https://unpkg.com/cytoscape@3.30.4/dist/cytoscape.min.js"><\/script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: ${bgColor}; overflow: hidden; }
#cy { width: 100vw; height: 100vh; }
#toolbar {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  background: rgba(30,30,30,0.85); border-radius: 8px; padding: 6px 12px;
  display: flex; gap: 8px; z-index: 10; backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.1);
}
#toolbar button {
  background: none; border: 1px solid rgba(255,255,255,0.2);
  color: #ccc; padding: 6px 14px; border-radius: 6px; cursor: pointer;
  font-size: 13px; transition: all 0.15s;
}
#toolbar button:hover { background: rgba(255,255,255,0.1); color: #fff; }
</style>
</head>
<body>
<div id="cy"></div>
<div id="toolbar">
  <button onclick="cy.fit(null,40)">Fit</button>
  <button onclick="cy.zoom({level:cy.zoom()*1.3,renderedPosition:{x:innerWidth/2,y:innerHeight/2}})">Zoom +</button>
  <button onclick="cy.zoom({level:cy.zoom()/1.3,renderedPosition:{x:innerWidth/2,y:innerHeight/2}})">Zoom −</button>
</div>
<script>
var graphData = ${JSON.stringify({ nodes, edges })};
var cy = cytoscape({
  container: document.getElementById('cy'),
  elements: graphData.nodes.map(function(n){return{group:'nodes',data:n.data,position:n.position}})
    .concat(graphData.edges.map(function(e){return{group:'edges',data:e.data}})),
  style: [
    { selector: 'node', style: {
      'label': 'data(label)', 'text-valign': 'center', 'text-halign': 'center',
      'text-wrap': 'wrap', 'text-max-width': '260px', 'font-size': '18px',
      'font-weight': '500', 'shape': 'round-rectangle', 'corner-radius': '20px',
      'border-width': '2px', 'border-opacity': 0.72, 'padding': '18px',
      'text-overflow-wrap': 'anywhere',
    }},
    { selector: 'edge', style: {
      'curve-style': 'unbundled-bezier', 'control-point-distances': 60,
      'control-point-weights': 0.5, 'target-arrow-shape': 'triangle',
      'arrow-scale': 1.2,
    }},
  ].concat(
    graphData.nodes.map(function(n){
      var s = {}; for(var k in n.style){ if(n.style[k] != null) s[k] = n.style[k]; }
      return { selector: 'node[id="'+n.data.id+'"]', style: s };
    })
  ).concat(
    graphData.edges.map(function(e){
      var s = {}; for(var k in e.style){ if(e.style[k] != null) s[k] = e.style[k]; }
      return { selector: 'edge[id="'+e.data.id+'"]', style: s };
    })
  ),
  layout: { name: 'preset' },
  userZoomingEnabled: true,
  userPanningEnabled: true,
  boxSelectionEnabled: false,
  autoungrabify: false,
  minZoom: 0.05,
  maxZoom: 3
});
cy.fit(null, 40);
<\/script>
</body>
</html>`;

            const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const mocPath = this.plugin.settings.mocCurrentFile || 'graph';
            const baseName = mocPath.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
            a.href = url;
            a.download = `${baseName}-${Date.now()}.html`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            new Notice(t('export success'));
        } catch (err) {
            console.error('[ZK] export graph as HTML failed', err);
            new Notice(t('export fail'));
        }
    }

    async onload() {

        this.registerEvent(this.app.workspace.on("active-leaf-change", async (leaf) => {

            if (leaf?.view.getViewType() == ZK_INDEX_TYPE) {
                if (this.plugin.RefreshIndexViewFlag === true) {
                    await this.IndexViewInterfaceInit();
                }
            }
        }));

        this.registerEvent(this.app.vault.on("rename", async () => {
            this.plugin.RefreshIndexViewFlag = true;
        }));

        this.registerEvent(this.app.vault.on("create", async (file) => {
            if (file instanceof TFile && (file.extension === 'md' || file.extension === 'moc')) {
                this.plugin.RefreshIndexViewFlag = true;
            }
        }));

        this.registerEvent(this.app.vault.on("delete", async (file) => {
            if (file instanceof TFile && (file.extension === 'md' || file.extension === 'moc')) {
                this.plugin.RefreshIndexViewFlag = true;
            }
        }));

        // 智能延迟刷新：监听文件内容变化
        let lastEditTime = 0;
        const smartChangeRefresh = () => {
            const now = Date.now();
            const timeSinceLastEdit = now - lastEditTime;

            // 如果最后编辑在 2 秒内，说明还在编辑，再延迟 5 秒
            if (timeSinceLastEdit < 2000) {
                if (this.changeRefreshTimer) {
                    clearTimeout(this.changeRefreshTimer);
                }
                this.changeRefreshTimer = setTimeout(smartChangeRefresh, 5000);
            } else {
                // 超过 2 秒没有编辑，执行刷新
                this.plugin.RefreshIndexViewFlag = true;
                this.changeRefreshTimer = null;
            }
        };

        this.registerEvent(this.app.metadataCache.on("changed", async (file) => {
            const activeFile = this.app.workspace.getActiveFile();
            // 只在当前活动文件变化时刷新
            if (activeFile && file.path === activeFile.path) {
                lastEditTime = Date.now();
                
                // 如果没有定时器在运行，启动一个
                if (!this.changeRefreshTimer) {                
                    this.changeRefreshTimer = setTimeout(smartChangeRefresh, 5000);
                }
            }
        }));

        this.registerEvent(this.app.metadataCache.on("deleted", async () => {
            this.plugin.RefreshIndexViewFlag = true;
        }));

        const refresh = debounce(this.refreshIndexLayout, 500, true);
        this.registerEvent(this.app.workspace.on("zk-navigation:refresh-index-graph", refresh));

        // MOC 文件变化事件监听（实时同步）
        this.registerEvent(this.app.workspace.on("zk-navigation:moc-file-changed", async (mocFile: TFile) => {
            // 只在 MOC 模式下且当前显示的是该 MOC 时才刷新
            if (this.isDisplayingMOC(mocFile)) {
                const indexMermaidDiv = document.getElementById("zk-index-mermaid-container");
                if (indexMermaidDiv) {
                    await this.smoothUpdateView(indexMermaidDiv, async () => {
                        await this.refreshBranchMermaidMOC(indexMermaidDiv);
                    });
                }
            }
        }));
    }

    async onOpen() {
        if (!this.fullscreenBackButtonListenerBound) {
            this.addTrackedListener(document, 'fullscreenchange', () => {
                this.syncBranchFullscreenBackButtonVisibility();
            });
            this.addTrackedListener(document as any, 'webkitfullscreenchange', () => {
                this.syncBranchFullscreenBackButtonVisibility();
            });
            this.fullscreenBackButtonListenerBound = true;
        }

        if (!this.undoShortcutBound) {
            this.addTrackedListener(window, 'keydown', async (event: KeyboardEvent) => {
                if (this.handleDetailPanelSpaceEdit(event)) return;

                const isCmdZ = event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z';
                if (!isCmdZ) return;

                // 只在当前激活的是分支视图时生效
                const activeView = this.app.workspace.getActiveViewOfType(ZKIndexView);
                if (activeView !== this) return;

                event.preventDefault();
                event.stopPropagation();
                await this.undoLastMOCChange();
            });
            this.undoShortcutBound = true;
        }

        if (!this.pasteListenerBound) {
            this.addTrackedListener(window, 'paste', async (event: Event) => {
                // 只在当前激活的是分支视图时生效
                const activeView = this.app.workspace.getActiveViewOfType(ZKIndexView);
                if (activeView !== this) return;

                // 如果焦点在文本输入框内（如 textarea、input），不拦截粘贴
                const activeEl = document.activeElement;
                if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || (activeEl as HTMLElement).isContentEditable)) {
                    return;
                }

                await this.handleImagePaste(event as ClipboardEvent);
            });
            this.pasteListenerBound = true;
        }

        if (this.app.workspace.layoutReady) {

            this.refreshIndexLayout();
        } else {
            this.app.workspace.onLayoutReady(() => {

                this.refreshIndexLayout();

            });
        }
    }

    public openBranchSearchBar(): void {
        const branchGraphDiv = this.currentBranchGraphDiv || document.getElementById('zk-branch-cytoscape');
        if (!branchGraphDiv) return;
        branchGraphDiv.dispatchEvent(new CustomEvent('zk-open-search-bar'));
    }

    private getGraphModelPositionFromClientPoint(
        clientX: number,
        clientY: number,
        branchGraphDiv: HTMLElement
    ): { x: number; y: number } {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        const rect = branchGraphDiv.getBoundingClientRect();

        if (!cy) {
            return {
                x: clientX - rect.left,
                y: clientY - rect.top
            };
        }

        const pan = cy.pan();
        const zoom = cy.zoom() || 1;
        return {
            x: (clientX - rect.left - pan.x) / zoom,
            y: (clientY - rect.top - pan.y) / zoom
        };
    }

    private hasDroppableTypes(event: DragEvent): boolean {
        const dt = event.dataTransfer;
        if (!dt) return false;
        const types = Array.from(dt.types || []);
        return types.some(t =>
            t === 'text/plain' ||
            t === 'text/uri-list' ||
            t === 'text/x-obsidian-uri' ||
            t === 'application/x-obsidian-uri' ||
            t === 'application/x-obsidian-file' ||
            t === 'application/x-zk-scratch' ||
            t === 'Files'
        );
    }

    private isScratchpadDrag(event: DragEvent): boolean {
        const dt = event.dataTransfer;
        if (!dt) return false;
        return Array.from(dt.types || []).includes('application/x-zk-scratch');
    }

    private resolveDroppedVaultFiles(event: DragEvent): TFile[] {
        return resolveDroppedVaultFiles(this.app, event);
    }

    private async createDroppedFileNode(file: TFile, position: { x: number; y: number }): Promise<void> {
        const nodeID = this.generateNextFreeNodeID();
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (!mocFilePath) return;

        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (!mocFile) return;

        // 草稿模式(#20):拖入的文件也先作为草稿,待审批
        if (this.divertFreeNodeToDraft({ wikiLink: file.basename, file }, position)) return;

        await this.saveFreeNodeToMOC({
            wikiLink: file.basename,
            nodeID,
            relationText: '',
            file,
            isEmbed: false
        });

        await this.saveNodePositionToMOC(mocFile, nodeID, position);
        await this.refreshBranchMermaid();

        const branchGraphDiv = this.currentBranchGraphDiv || document.getElementById('zk-branch-cytoscape');
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('select-node-by-id', {
                detail: { nodeId: nodeID }
            }));
        }
    }

    private getDroppedFileNodePositions(
        anchor: { x: number; y: number },
        count: number
    ): Array<{ x: number; y: number }> {
        if (count <= 1) {
            return [anchor];
        }

        const positions: Array<{ x: number; y: number }> = [];
        const verticalGap = 110;
        const horizontalGap = 220;
        const columns = count > 6 ? 2 : 1;
        const rowsPerColumn = Math.ceil(count / columns);
        const startYOffset = -((rowsPerColumn - 1) * verticalGap) / 2;

        for (let index = 0; index < count; index++) {
            const column = Math.floor(index / rowsPerColumn);
            const row = index % rowsPerColumn;
            positions.push({
                x: anchor.x + column * horizontalGap,
                y: anchor.y + startYOffset + row * verticalGap
            });
        }

        return positions;
    }

    private async createDroppedFileNodes(files: TFile[], anchorPosition: { x: number; y: number }): Promise<void> {
        const uniqueFiles = files.filter((file, index, arr) => arr.findIndex(other => other.path === file.path) === index);
        if (uniqueFiles.length === 0) return;

        if (uniqueFiles.length === 1) {
            await this.createDroppedFileNode(uniqueFiles[0], anchorPosition);
            return;
        }

        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (!mocFilePath) return;
        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (!mocFile) return;

        const positions = this.getDroppedFileNodePositions(anchorPosition, uniqueFiles.length);
        const createdNodeIds: string[] = [];

        await this.mocHandler.modifyMOCData(mocFile, async (mocData: MOCParseResult) => {
            const collectNodeIds = (nodes: MOCTreeNode[]): string[] => {
                return nodes.flatMap((node) => [node.nodeID, ...collectNodeIds(node.children || [])]);
            };

            const existingNodeIds = new Set(collectNodeIds(mocData.nodes));
            const freeNums = Array.from(existingNodeIds)
                .map((id) => {
                    const match = id?.match(/^free\.(\d+)$/);
                    return match ? parseInt(match[1], 10) : 0;
                })
                .filter((num) => num > 0);
            let nextFreeNum = freeNums.length > 0 ? Math.max(...freeNums) + 1 : 1;

            uniqueFiles.forEach((file, index) => {
                let nodeID = `free.${nextFreeNum}`;
                while (existingNodeIds.has(nodeID)) {
                    nextFreeNum += 1;
                    nodeID = `free.${nextFreeNum}`;
                }
                existingNodeIds.add(nodeID);
                nextFreeNum += 1;
                createdNodeIds.push(nodeID);

                const newNode: MOCTreeNode = {
                    nodeID,
                    nodeType: 'file',
                    target: file.basename,
                    depth: 0,
                    children: [],
                    file,
                    relationText: '',
                };

                mocData.nodes.push(newNode);
                if (!mocData.nodePositions) {
                    mocData.nodePositions = {};
                }
                mocData.nodePositions[nodeID] = positions[index];
            });
        });

        await this.refreshBranchMermaid();

        const branchGraphDiv = this.currentBranchGraphDiv || document.getElementById('zk-branch-cytoscape');
        if (branchGraphDiv && createdNodeIds[0]) {
            branchGraphDiv.dispatchEvent(new CustomEvent('select-node-by-id', {
                detail: { nodeId: createdNodeIds[0] }
            }));
        }
    }

    refreshIndexLayout = async () => {

        await this.IndexViewInterfaceInit();

    }

    async refreshBranchMermaid(force: boolean = false) {

        this.plugin.RefreshIndexViewFlag = false;
        const indexMermaidDiv = document.getElementById("zk-index-mermaid-container");

        if (!indexMermaidDiv) return;

        await this.refreshBranchMermaidMOC(indexMermaidDiv, force);
    }

    /**
     * 计算影响渲染结果的完整签名：文件路径 + mtime + 影响视觉/布局的设置项。
     * 用于 refreshBranchMermaidMOC 的 no-op 短路检测——签名一致说明完全无需重建。
     *
     * ⚠️ 维护说明：任何会改变画面的设置都必须加进来，否则改设置不会即时生效。
     * 目前只包含"会影响 parseMOCStructure / convertMOCToZKNodes / render options"的字段。
     * 不进入签名的字段：HistoryList、zoomPanScaleArr、mocCurrentFile（已是 filePath）等运行时状态。
     */
    private computeRenderSignature(filePath: string, mtime: number): string {
        const s = this.plugin.settings;
        return [
            filePath,
            mtime,
            // 主题 / 视觉(用解析后值,auto 时跟随 Obsidian 实时主题)
            resolveThemeMode(s.themeMode),
            s.themeStyle || 'modern',
            s.edgeStyle || 'bezier',
            s.nodeColor || '',
            // 布局
            s.DirectionOfBranchGraph || 'LR',
            s.nodeLayoutStyle || 'free',
            s.autoLayoutDefaultGrowthDirection || DEFAULT_LAYOUT_PRESET,
            s.graphType || 'structure',
            // 节点标签 / 显示
            s.NodeText || 'both',
            s.showNoteIdInBranchView ? '1' : '0',
            s.smartConnection ? '1' : '0',
            // 节点 ID / 标题解析（影响 convertMOCToZKNodes）
            s.IDFieldOption || '1',
            s.TitleField || '',
            s.IDField || '',
            s.Separator || ' ',
            s.OtherSeparator || '',
            // MOC 解析
            s.mocHeadingTitle || '',
            // 运行时
            this.isMobileReadOnly() ? 'ro' : 'rw',
        ].join('|');
    }

    private buildMOCFilePath(mocFolder: string, baseName: string): string {
        const normalizedFolder = (mocFolder || '').replace(/^\/+|\/+$/g, '');
        return normalizedFolder ? `${normalizedFolder}/${baseName}${MOC_FILE_SUFFIX}` : `${baseName}${MOC_FILE_SUFFIX}`;
    }

    private async promptCreateInitialMOCFile(mocFolder: string): Promise<TFile | null> {
        if (this.isCreateMOCPromptOpen) return null;
        this.isCreateMOCPromptOpen = true;

        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            let settled = false;
            const finish = (file: TFile | null) => {
                if (settled) return;
                settled = true;
                this.isCreateMOCPromptOpen = false;
                resolve(file);
            };

            modal.titleEl.setText(t("No MOC file detected"));
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.createEl('p', { text: t("No mind tree file exists yet. Create one now?") });

            const defaultBaseName = `${t("default MOC file prefix")}-${moment().format('YYYYMMDDHHmmss')}`;
            let draftBaseName = defaultBaseName;

            new Setting(contentEl)
                .setName(t("File name"))
                .setDesc(t("MOC suffix will be added automatically"))
                .addText((text) => {
                    text.setPlaceholder(defaultBaseName);
                    text.setValue(defaultBaseName);
                    text.onChange((value) => {
                        draftBaseName = value.trim();
                    });
                });

            const buttonRow = contentEl.createDiv();
            buttonRow.setCssStyles({
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                marginTop: '16px',
            });

            const cancelBtn = buttonRow.createEl('button', { text: t("Cancel") });
            cancelBtn.onclick = () => {
                modal.close();
                finish(null);
            };

            const createBtn = buttonRow.createEl('button', { text: t("Create") });
            createBtn.addClass('mod-cta');
            createBtn.onclick = async () => {
                const normalizedBaseName = stripMocSuffix(draftBaseName || defaultBaseName).trim();
                if (!normalizedBaseName) {
                    new Notice(t("File name cannot be empty"));
                    return;
                }

                const filePath = this.buildMOCFilePath(mocFolder, normalizedBaseName);
                const exists = this.app.vault.getAbstractFileByPath(filePath);
                if (exists) {
                    new Notice(`文件已存在: ${filePath}`);
                    return;
                }

                try {
                    const content = createMOCJsonWithInitialNode(
                        this.plugin.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free',
                        t("Default node title")
                    );
                    const newFile = await this.app.vault.create(filePath, content);
                    this.plugin.settings.mocCurrentFile = newFile.path;
                    await this.plugin.saveData(this.plugin.settings);
                    modal.close();
                    finish(newFile);
                } catch (error: any) {
                    new Notice(t("Create failed").replace("{message}", String(error?.message || error)));
                }
            };

            modal.onClose = () => {
                finish(null);
            };

            modal.open();
        });
    }

    private async ensureCurrentMOCFile(mocFolder: string): Promise<TFile | null> {
        const configuredPath = this.plugin.settings.mocCurrentFile;
        if (configuredPath) {
            const configuredFile = this.app.vault.getAbstractFileByPath(configuredPath);
            if (configuredFile instanceof TFile) {
                return configuredFile;
            }
        }

        const mocFiles = getMOCFilesInFolder(this.app, mocFolder);
        if (mocFiles.length > 0) {
            const fallback = mocFiles[0];
            this.plugin.settings.mocCurrentFile = fallback.path;
            await this.plugin.saveData(this.plugin.settings);
            return fallback;
        }

        return await this.promptCreateInitialMOCFile(mocFolder);
    }

    private async ensureInitialRootNode(
        mocFile: TFile,
        mocParseResult: MOCParseResult,
        headingTitle: string
    ): Promise<MOCParseResult> {
        if (mocParseResult.nodes.length > 0) {
            return mocParseResult;
        }

        mocParseResult.nodes = [
            createMOCTreeNode({
                nodeID: '1',
                nodeType: 'text',
                target: t("Default node title"),
                depth: 0,
                children: [],
                relationText: '',
            }),
        ];
        mocParseResult.nodePositions = {
            ...(mocParseResult.nodePositions || {}),
            '1': { x: 0, y: 0 },
        };
        if (mocParseResult.nodeLayoutStyle !== 'free' && mocParseResult.nodeLayoutStyle !== 'auto') {
            mocParseResult.nodeLayoutStyle = this.plugin.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free';
        }
        await saveMOCStructure(this.app, mocFile.path, headingTitle, mocParseResult);
        return await parseMOCStructure(this.app, mocFile.path, headingTitle);
    }

    private async ensureNodePositions(
        mocFile: TFile,
        mocParseResult: MOCParseResult,
        headingTitle: string
    ): Promise<MOCParseResult> {
        if (mocParseResult.nodes.length === 0) {
            return mocParseResult;
        }

        if (!mocParseResult.nodePositions) {
            mocParseResult.nodePositions = {};
        }

        let changed = false;
        let fallbackIndex = 0;
        const visit = (nodes: MOCTreeNode[], depth: number) => {
            for (const node of nodes) {
                if (node.nodeID && !mocParseResult.nodePositions[node.nodeID]) {
                    mocParseResult.nodePositions[node.nodeID] = {
                        x: Math.round(depth * 260),
                        y: Math.round(fallbackIndex * 150),
                    };
                    changed = true;
                }
                fallbackIndex++;
                visit(node.children || [], depth + 1);
            }
        };

        visit(mocParseResult.nodes, 0);
        if (!changed) {
            return mocParseResult;
        }

        // auto 文件若刚补齐了缺失坐标(典型:CLI/脚本写入的节点没有坐标),
        // 用的是上面那套粗糙的 depth*260 / index*150 兜底排布,会偏左上不居中。
        // 标记一下,渲染完成后用真正的 reflow(带节点尺寸)重排居中。
        if (mocParseResult.nodeLayoutStyle === 'auto') {
            this.pendingInitialAutoCenter = true;
        }

        await saveMOCStructure(this.app, mocFile.path, headingTitle, mocParseResult);
        return await parseMOCStructure(this.app, mocFile.path, headingTitle);
    }

    // 依赖 onLoadFile/onUnloadFile 不做重渲染:setViewState 切换 file 会回调这两个钩子,
    // 当前实现只更新 settings 与 flag,否则会在 render 中途销毁 cytoscape 实例。
    private async syncCurrentMOCToLeafState(mocFile: TFile): Promise<void> {
        const currentState = this.leaf?.getViewState?.();
        if (!currentState || currentState.type !== ZK_INDEX_TYPE) return;

        const stateFile = currentState.state?.file;
        const loadedFilePath = this.file?.path || '';
        if (stateFile === mocFile.path && loadedFilePath === mocFile.path) {
            return;
        }

        await this.leaf.setViewState({
            ...currentState,
            type: ZK_INDEX_TYPE,
            state: {
                ...(currentState.state || {}),
                file: mocFile.path,
            },
            active: currentState.active ?? (this.app.workspace.activeLeaf === this.leaf),
        });
    }

    // MOC 模式专用的刷新方法
    // MOC 模式专用的刷新方法 - 使用 Cytoscape 渲染
    async refreshBranchMermaidMOC(indexMermaidDiv: HTMLElement, force: boolean = false) {
        // 仅在 MOC 文件真正切换时才冲刷保存旧画面位置，避免同文件刷新覆盖刚写入的位置
        const incomingMOCPath = this.plugin.settings.mocCurrentFile;
        this.prunePlaceholderNodes(incomingMOCPath);
        this.pruneMOCViewStates(incomingMOCPath);

        // 同步更新 MOC 选择器标签
        if (this.mocChipLabel && incomingMOCPath) {
            const mocFile = this.app.vault.getFileByPath(incomingMOCPath);
            if (mocFile) {
                const maxLength = 12;
                let label = mocFile.basename;
                if (label.length > maxLength) label = label.substring(0, maxLength) + '...';
                this.mocChipLabel.setText(label);
            }
        }
        if (this.lastRenderedMOCPath && this.lastRenderedMOCPath !== incomingMOCPath) {
            await this.flushAndSaveCurrentPositions();
        }

        // 获取 MOC 配置
        const mocFolder = this.plugin.settings.mocFolderPath;
        const headingTitle = this.plugin.settings.mocHeadingTitle;

        if (!mocFolder) {
            new Notice(t("Please configure MOC folder path in settings"));
            return;
        }

        const currentMOCFile = await this.ensureCurrentMOCFile(mocFolder);
        if (!(currentMOCFile instanceof TFile)) {
            return;
        }
        const currentMOCPath = currentMOCFile.path;
        this.scratchDrawer?.refreshContext();
        await this.syncCurrentMOCToLeafState(currentMOCFile);

        // 性能优化：如果文件 mtime 和影响渲染的设置都没变，且 cy 实例仍对应同一文件，
        // 说明这是一次无实质变化的刷新（如窗口 resize、其他模块触发的事件），直接跳过
        // parse → convert → build → render 整条热路径，只同步容器尺寸即可。
        const renderSignature = this.computeRenderSignature(currentMOCPath, currentMOCFile.stat.mtime);
        const cyInstance = this.branchRenderer?.getCytoscapeInstance();
        if (!force && cyInstance && this.lastRenderedMOCPath === currentMOCPath && this.lastRenderSignature === renderSignature) {
            const existingGraphDiv = document.getElementById("zk-branch-cytoscape") as HTMLElement | null;
            if (existingGraphDiv) {
                const graphHeight = Math.max(220, this.containerEl.offsetHeight - 80);
                if (existingGraphDiv.style.height !== `${graphHeight}px`) {
                    existingGraphDiv.setCssStyles({ height: `${graphHeight}px` });
                    cyInstance.resize();
                }
                return;
            }
        }

        // 真实重建画布前清空未落地草稿(#20:刷新可丢失);no-op 短路路径上方已 return,故草稿在
        // 纯交互(拖动草稿不触发刷新)期间得以保留,只有真正重建才回收。
        if (this.draftNodes.size > 0 || this.draftRelations.size > 0) this.clearAllDrafts();

        // 性能埋点：在控制台执行 `window.__zkPerf = true` 后,每次刷新会打印各阶段耗时,
        // 用于定位大图新增节点变慢的真实瓶颈(parse / convert / build / render)。
        const __zkPerf = (window as any).__zkPerf === true;
        const __now = () => (__zkPerf ? performance.now() : 0);
        const __mark: Record<string, number> = {};
        let __tPrev = __now();
        const __lap = (name: string) => {
            if (!__zkPerf) return;
            const t = performance.now();
            __mark[name] = t - __tPrev;
            __tPrev = t;
        };

        let mocParseResult = await parseMOCStructure(this.app, currentMOCPath, headingTitle);
        mocParseResult = await this.ensureInitialRootNode(currentMOCFile, mocParseResult, headingTitle);
        mocParseResult = await this.ensureNodePositions(currentMOCFile, mocParseResult, headingTitle);
        __lap('parse');

        // 项目徽章:当前 MOC 是否被挂载到任意 FolderNode 下
        this.refreshProjectBadge(currentMOCPath);

        // 读取 MOC 文件中持久化的节点布局风格；老 .moc 未记录时按历史默认 free 处理。
        // 新建 .moc 会在创建时写入 nodeLayoutStyle，后续不再受全局设置切换影响。
        this.currentNodeLayoutStyle = this.normalizeNodeLayoutStyle(
            mocParseResult.nodeLayoutStyle,
            'free'
        );
        this.currentNodeLayoutOverrides = mocParseResult.nodeLayoutOverrides || {};
        this.currentLayoutPreset = normalizeLayoutPreset(this.plugin.settings.autoLayoutDefaultGrowthDirection);
        this.currentNodeLayoutPresets = mocParseResult.nodeLayoutPresets || {};

        // 转换为 ZKNode（即使为空也继续）
        this.mocNodes = mocParseResult.nodes.length > 0
            ? await convertMOCToZKNodes(this.plugin, mocParseResult.nodes, mocParseResult.reverseRelations, [], mocParseResult.nodePositions)
            : [];
        // 克隆 reverseRelations Map，避免修改缓存中的数据
        this.mocReverseRelations = new Map(Array.from(mocParseResult.reverseRelations.entries()));
        __lap('convertZKNodes');

        // 性能优化：复用或创建图形容器（不复用 renderer 内部的 Cytoscape 实例）
        let branchGraphDiv = document.getElementById("zk-branch-cytoscape") as HTMLElement;

        if (!branchGraphDiv) {
            // 首次创建：创建容器
            const branchGraphContainer = indexMermaidDiv.createDiv("zk-branch-graph-container");
            branchGraphDiv = branchGraphContainer.createEl("div", {
                cls: "zk-graph-cytoscape"
            });
            branchGraphDiv.id = "zk-branch-cytoscape";
        }
        // 每次刷新都同步容器尺寸，避免窗口缩放后沿用旧高度
        const graphHeight = Math.max(220, this.containerEl.offsetHeight - 80);
        branchGraphDiv.setCssStyles({
            height: `${graphHeight}px`,
            width: "100%",
        });

        if (this.isMobileReadOnly()) {
            branchGraphDiv.setCssStyles({
                border: 'none',
                boxShadow: 'none',
                outline: 'none',
            });
        } else {
            branchGraphDiv.setCssStyles({
                border: '',
                boxShadow: '',
                outline: '',
            });
        }
        // Nebula 走透明底(让 CSS 按 dark/light 提供的星云/浅灰径向渐变透出),
        // 否则按 light/dark 给纯色底。注意:这里是 inline 样式,会盖过 CSS,必须显式处理 nebula。
        const isNebulaStyle = this.plugin.settings.themeStyle === 'nebula';
        branchGraphDiv.setCssStyles({ backgroundColor: isNebulaStyle
            ? 'transparent'
            : (resolveThemeMode(this.plugin.settings.themeMode) === 'light' ? '#f2f5fa' : '#2a2a2a') });
        this.ensureBranchFullscreenBackButton(branchGraphDiv);

        // 注意：不再清空 branchGraphDiv，让 CytoscapeRenderer 内部的增量更新逻辑处理

        // 构建图形数据（包含分组信息和边弧度信息）
        const groups = mocParseResult.groups || [];
        const edgeCurvatures = mocParseResult.edgeCurvatures || {};
        const nodeColors = mocParseResult.nodeColors || {};
        const nodeStyleColors = (mocParseResult as any).nodeStyleColors || {};
        const crossDomainLinks = mocParseResult.crossDomainLinks || {};
        const nodePositions = mocParseResult.nodePositions || {};
        const embedNodeSizes = (mocParseResult as any).embedNodeSizes || {};
        this.nodeRemarks = (mocParseResult as any).nodeRemarks || {};
        this.nodeAnchors = (mocParseResult as any).nodeAnchors || {};
        this.collapsedNodeIds = (mocParseResult as any).collapsedNodeIds || [];
        const graphData = GraphDataBuilder.fromMOCTree(
            this.mocNodes,
            this.mocReverseRelations,
            null,
            groups,
            edgeCurvatures,
            nodeColors,
            nodeStyleColors,
            crossDomainLinks,
            nodePositions,
            embedNodeSizes,
            this.nodeRemarks,
            this.nodeAnchors,
            this.collapsedNodeIds
        );
        __lap('buildGraphData');

        // 收集已分离节点 ID(NODE_FLAG_SEPARATED),供渲染器拖动时计算"分离圆"半径排除远处兄弟。
        const separatedNodeIds: string[] = [];
        {
            const collect = (ns: MOCTreeNode[]) => {
                for (const n of ns) {
                    if (((n.extBitMap || 0) & NODE_FLAG_SEPARATED) !== 0) separatedNodeIds.push(n.nodeID);
                    if (n.children?.length) collect(n.children);
                }
            };
            collect(mocParseResult.nodes);
        }

        // 配置渲染选项
        const options: RenderOptions = {
            app: this.app,
            direction: (this.plugin.settings.DirectionOfBranchGraph || 'LR') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'dagre',
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
            themeMode: resolveThemeMode(this.plugin.settings.themeMode),
            themeStyle: this.plugin.settings.themeStyle || 'modern',
            edgeStyle: this.plugin.settings.edgeStyle || 'bezier',
            nodeLayoutStyle: this.currentNodeLayoutStyle,
            nodeLayoutOverrides: this.currentNodeLayoutOverrides,
            separatedNodeIds,
            showNoteId: this.plugin.settings.showNoteIdInBranchView,
            smartConnection: this.plugin.settings.smartConnection === true,
            readOnly: this.isMobileReadOnly(),
            initialCollapsedNodeIds: this.collapsedNodeIds,
            openLink: (linkText, sourcePath, forceTab) => this.openLinkInPreferredLeaf(linkText, sourcePath, forceTab),
            openFile: (file, wikiLink, forceTab) => this.openFileInPreferredLeaf(file, forceTab, this.getWikiSubpath(wikiLink)),
        };

        // 性能优化：复用或创建渲染器，避免每次都销毁重建
        if (!this.branchRenderer) {
            this.branchRenderer = new CytoscapeRenderer();
        }

        // 渲染或更新图形
        // CytoscapeRenderer 内部会智能判断是否需要完全重建或增量更新
        await this.branchRenderer.render(branchGraphDiv, graphData, options);
        __lap('render');
        if (__zkPerf) {
            const total = Object.values(__mark).reduce((a, b) => a + b, 0);
            console.log(
                `[zkPerf] nodes=${this.mocNodes.length} total=${total.toFixed(1)}ms`,
                Object.fromEntries(Object.entries(__mark).map(([k, v]) => [k, +v.toFixed(1)]))
            );
        }
        this.lastRenderedMOCPath = currentMOCPath;
        this.lastRenderSignature = renderSignature;

        // auto 文件首次补齐坐标后(如 CLI 创建),此时已有真实节点尺寸,做一次居中重排,
        // 让根节点相对子节点竖直居中,而非粗糙兜底的左上排布。
        if (this.pendingInitialAutoCenter) {
            this.pendingInitialAutoCenter = false;
            const rootId = this.getPrimaryMocRootId();
            if (rootId) {
                await this.reflowAutoLayout(rootId);
                this.lastRenderSignature = null;
            }
        }

        // 收起态紧凑视图 = f(文件坐标, collapsedNodeIds) 的纯函数,渲染后统一重放。
        // 收起时的紧凑重排不落盘(避免污染文件坐标),而任何文件驱动的刷新
        // (persistCollapseState 自写触发的 mocMonitor 刷新、外部编辑、主题切换)
        // 都会把节点打回文件坐标 —— 不在这里重放,临时紧凑布局就会被刷新撤销,
        // 表现为收起/展开后位置错乱。relayout 内部对纯 free 树自动跳过。
        if (this.collapsedNodeIds.length > 0) {
            const collapseRootId = this.getPrimaryMocRootId();
            if (collapseRootId) {
                await this.relayoutAutoLayoutSiblings(collapseRootId, {
                    collapsedNodeIds: this.collapsedNodeIds,
                    compactVisibleNodes: true,
                    rebalanceRootChildren: true,
                    persistPositions: false,
                });
            }
        }

        // 恢复或自动居中视图
        const cy = this.branchRenderer.getCytoscapeInstance();
        if (cy) {
            if (this.pendingSelectNodeId) {
                // 搜索选中后定位到目标节点
                const escapedId = this.pendingSelectNodeId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const targetNode = cy.$id(escapedId);
                if (targetNode.length > 0) {
                    cy.elements().deselect();
                    targetNode.select();
                    cy.animate({ center: { eles: targetNode }, duration: 300 });
                } else {
                    cy.fit(undefined, 50);
                }
                this.pendingSelectNodeId = null;
            } else {
                const savedViewState = this.getMOCViewState(currentMOCPath);
                if (savedViewState) {
                    // 恢复保存的视图状态
                    cy.zoom(savedViewState.zoom);
                    cy.pan(savedViewState.pan);
                } else {
                    // 没有保存的状态，自动居中
                    cy.fit(undefined, 50);
                }
            }
        }

        // 图加载/切换 MOC 后,初始化或校验层级面包屑路径
        this.initLevelBreadcrumbForCurrentGraph();

        // 性能优化：只在容器变化或首次初始化时重建事件监听器
        // Cytoscape 增量更新不会替换容器，所以监听器可以复用
        const needsListenerInit = !this.branchGraphListenersInitialized || this.currentBranchGraphDiv !== branchGraphDiv;

        if (needsListenerInit) {
            // 清理该图形容器上的旧事件监听器（如果是新容器）
            if (this.currentBranchGraphDiv && this.currentBranchGraphDiv !== branchGraphDiv) {
                this.cleanupElementListeners(this.currentBranchGraphDiv);
            }

            const setDropHover = (active: boolean) => {
                branchGraphDiv.classList.toggle('zk-branch-drop-hover', active);
                if (active) {
                    branchGraphDiv.setCssStyles({ boxShadow: 'inset 0 0 0 2px rgba(91, 143, 217, 0.9)' });
                } else if (this.isMobileReadOnly()) {
                    branchGraphDiv.setCssStyles({ boxShadow: 'none' });
                } else {
                    branchGraphDiv.setCssStyles({ boxShadow: '' });
                }
            };
            const getLatestMOCFile = () => {
                const latestMOCPath = this.plugin.settings.mocCurrentFile;
                return latestMOCPath ? this.app.vault.getFileByPath(latestMOCPath) : null;
            };

            this.addTrackedListener(branchGraphDiv, 'dragenter', (event: DragEvent) => {
                if (this.isMobileReadOnly()) return;
                if (!this.hasDroppableTypes(event)) return;
                event.preventDefault();
                setDropHover(true);
            });

            this.addTrackedListener(branchGraphDiv, 'dragover', (event: DragEvent) => {
                if (this.isMobileReadOnly()) return;
                if (!this.hasDroppableTypes(event)) return;
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = this.isScratchpadDrag(event) ? 'move' : 'copy';
                }
                setDropHover(true);
            });

            this.addTrackedListener(branchGraphDiv, 'dragleave', (event: DragEvent) => {
                const relatedTarget = event.relatedTarget as Node | null;
                if (relatedTarget && branchGraphDiv.contains(relatedTarget)) {
                    return;
                }
                setDropHover(false);
            });

            this.addTrackedListener(branchGraphDiv, 'drop', async (event: DragEvent) => {
                if (this.isMobileReadOnly()) return;
                setDropHover(false);

                // 优先处理暂存区卡片落入
                if (this.isScratchpadDrag(event)) {
                    const tempId = event.dataTransfer?.getData('application/x-zk-scratch');
                    event.preventDefault();
                    event.stopPropagation();
                    if (!tempId) return;
                    const found = this.plugin.scratchpad?.get(tempId);
                    if (!found) return;
                    const pos = this.getGraphModelPositionFromClientPoint(
                        event.clientX,
                        event.clientY,
                        branchGraphDiv
                    );
                    await this.materializeScratchpadEntryAt(found.entry, pos);
                    return;
                }

                const droppedFiles = this.resolveDroppedVaultFiles(event);
                if (droppedFiles.length === 0) return;

                event.preventDefault();
                event.stopPropagation();

                const position = this.getGraphModelPositionFromClientPoint(
                    event.clientX,
                    event.clientY,
                    branchGraphDiv
                );
                await this.createDroppedFileNodes(droppedFiles, position);
            });

            // 监听视图状态变化事件（缩放和平移）
            this.addTrackedListener(branchGraphDiv, 'viewStateChanged', async (event: any) => {
                const { zoom, pan } = event.detail;
                // 监听器可能复用，保存时读取最新当前文件路径，避免写入旧 MOC 的视图状态
                const latestMOCPath = this.plugin.settings.mocCurrentFile;
                if (!latestMOCPath) return;
                this.saveMOCViewState(latestMOCPath, zoom, pan);
            });

        // 监听自动连接事件（拖动节点到附近节点时触发）
        this.addTrackedListener(branchGraphDiv, 'auto-connect-node', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            if (!this.plugin.settings.smartConnection) {
                return;
            }
            const { childNodeId, parentNodeId, position } = event.detail;

            // 查找子节点和父节点
            const childNode = this.mocNodes.find(n => n.ID === childNodeId || n.IDStr === childNodeId);
            const parentNode = this.mocNodes.find(n => n.ID === parentNodeId || n.IDStr === parentNodeId);

            if (!childNode || !parentNode) {
                console.warn('[auto-connect-node] 未找到节点:', { childNode, parentNode });
                return;
            }

            // 保存连接关系到 MOC
            try {
                const mocFile = getLatestMOCFile();
                if (!mocFile) {
                    new Notice(t("No current MOC file selected"));
                    return;
                }

                // 智能连线：自由节点连接到普通节点时，建立父子关系（而不是反向关系）
                if (!this.isFreeNodeID(childNode.IDStr) || this.isFreeNodeID(parentNode.IDStr)) {
                    console.warn('[auto-connect-node] 非法智能连线目标（child 必须是自由节点，parent 必须是普通节点）', {
                        childNodeId: childNode.IDStr,
                        parentNodeId: parentNode.IDStr
                    });
                    return;
                }

                const newChildID = this.generateChildNodeID(parentNode.IDStr);
                await this.mocHandler.moveNodeToParent(mocFile, childNode.IDStr, parentNode.IDStr, newChildID);

                // 保存移动后的节点位置（使用新子节点 ID）
                await this.saveNodePositionToMOC(mocFile, newChildID, position);

                // 刷新视图
                await this.refreshBranchMermaid(true);

                new Notice(t("Parent-child relation created")
                    .replace("{parent}", String(parentNode.displayText))
                    .replace("{child}", String(childNode.displayText)));
            } catch (error) {
                console.error('[auto-connect-node] 连接失败:', error);
                new Notice(t("Connection failed").replace("{message}", String(error.message)));
            }
        });

        // 监听节点位置变化事件（拖动后保存到 MOC 文件）
        // 多节点拖动时 dragfree 会对每个节点触发，先累积到 pendingPositionChanges，防抖后批量保存
        let pendingMOCPath: string | null = null; // 事件发生时的 MOC 路径
        let pendingGroupLeaves: Array<{ nodeId: string; groupId: string }> = [];
        let pendingGroupJoins: Array<{ nodeId: string; groupId: string }> = [];
        // auto 布局分离意图:nodeKey → {父节点, 拖出/拖回, 拖动前是否已分离}
        let pendingSeparations: Map<string, { parentId: string; willSeparate: boolean; wasSeparated: boolean }> = new Map();
        this.addTrackedListener(branchGraphDiv, 'node-position-changed', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node, position, leftGroup, joinedGroup, separation } = event.detail;
            const nodeKey = node?.IDStr || node?.ID;

            // 检查节点是否有效
            if (!node || !nodeKey) {
                console.warn('Invalid node in position-changed event:', node);
                return;
            }

            // 在事件发生时立即捕获当前 MOC 路径，而不是等 200ms 后再读
            pendingMOCPath = this.plugin.settings.mocCurrentFile;

            // 累积待保存的位置变化
            this.pendingPositionChanges.set(nodeKey, { node, position });

            // 若节点同时脱离了分组，累积脱组信息（与位置合并到同一次写入）
            if (leftGroup) {
                pendingGroupLeaves.push(leftGroup);
            }
            if (joinedGroup) {
                pendingGroupJoins.push(joinedGroup);
            }
            // auto 布局:拖出/拖回分离圆的意图(仅被拖节点携带)
            if (separation && typeof separation.parentId === 'string') {
                pendingSeparations.set(nodeKey, separation);
            }

            // 使用防抖，等所有 dragfree 事件到达后一次性保存
            if (this.nodePositionSaveTimeout) {
                clearTimeout(this.nodePositionSaveTimeout);
            }

            this.nodePositionSaveTimeout = setTimeout(() => {
                this.nodePositionSaveTimeout = null;
                const savePromise = (async () => {
                    const changes = new Map(this.pendingPositionChanges);
                    this.pendingPositionChanges.clear();
                    const groupLeaves = pendingGroupLeaves.splice(0);
                    const groupJoins = pendingGroupJoins.splice(0);
                    const separations = pendingSeparations;
                    pendingSeparations = new Map();

                    try {
                        // 使用事件发生时捕获的 MOC 路径，防止切换后写入错误文件
                        const targetMOCPath = pendingMOCPath || this.plugin.settings.mocCurrentFile;
                        pendingMOCPath = null;
                        const mocFile = this.app.vault.getFileByPath(targetMOCPath);
                        if (!mocFile) return;

                        // 分离跨领域节点和普通节点
                        const crossDomainChanges: Array<{ node: any; position: { x: number; y: number } }> = [];
                        const normalChanges: Map<string, { x: number; y: number }> = new Map();

                        for (const [nodeID, { node: n, position: pos }] of changes) {
                            if (n.isCrossDomain && n.crossDomainSourceNodeId && n.crossDomainOriginalNodeId) {
                                crossDomainChanges.push({ node: n, position: pos });
                            } else {
                                normalChanges.set(nodeID, pos);
                            }
                        }

                        // 批量保存普通节点位置 + 脱组信息（一次 parse-modify-save，避免竞态）
                        if (normalChanges.size > 0 || groupLeaves.length > 0 || groupJoins.length > 0) {
                            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                                this.ensureMOCNodeLayoutStyle(mocData);
                                if (!mocData.nodePositions) {
                                    mocData.nodePositions = {};
                                }
                                for (const [nodeID, pos] of normalChanges) {
                                    mocData.nodePositions[nodeID] = {
                                        x: Math.round(pos.x * 100) / 100,
                                        y: Math.round(pos.y * 100) / 100
                                    };
                                }
                                // auto 布局分离标志:仅被拖节点据"分离圆"内外置/清 SEPARATED。
                                // 拖出 → 置位(成为独立生长锚点);拖回 → 清位(归队,随后 reflow 吸附)。
                                // 不再对所有拖动节点盲打标志:圆内的节点要吸附回树,不应被钉住。
                                for (const [nodeID, sep] of separations) {
                                    const treeNode = this.findNodeInTree(mocData.nodes, nodeID);
                                    if (!treeNode) continue;
                                    if (sep.willSeparate) {
                                        treeNode.extBitMap = ((treeNode.extBitMap || 0) | NODE_FLAG_SEPARATED) & 0xff;
                                    } else {
                                        // 圆内:取消分离 + 固定该侧。固定后无论层级深浅,reflow 都按
                                        // 该节点自身保存位置导出左右,不再继承父方向弹回对侧。
                                        treeNode.extBitMap = (((treeNode.extBitMap || 0) & ~NODE_FLAG_SEPARATED) | NODE_FLAG_SIDE_PINNED) & 0xff;
                                    }
                                }
                                for (const { nodeId, groupId } of groupLeaves) {
                                    const group = mocData.groups?.find((g: any) => g.id === groupId);
                                    if (group) {
                                        group.nodeIds = (group.nodeIds || []).filter((id: string) => id !== nodeId);
                                    }
                                }
                                for (const { nodeId, groupId } of groupJoins) {
                                    if (!mocData.groups) {
                                        mocData.groups = [];
                                    }
                                    mocData.groups.forEach((group: any) => {
                                        if (group.id !== groupId) {
                                            group.nodeIds = (group.nodeIds || []).filter((id: string) => id !== nodeId);
                                        }
                                    });
                                    const group = mocData.groups.find((g: any) => g.id === groupId);
                                    if (group) {
                                        const ids = group.nodeIds || (group.nodeIds = []);
                                        if (!ids.includes(nodeId)) {
                                            ids.push(nodeId);
                                        }
                                    }
                                }
                            });
                        }

                        // 跨领域节点逐个保存（数量通常很少）
                        for (const { node: n, position: pos } of crossDomainChanges) {
                            const crossDomainLink = {
                                nodeId: n.crossDomainOriginalNodeId,
                                mocPath: n.filePath,
                                displayText: n.displayText,
                                filePath: n.filePath
                            };
                            await this.saveCrossDomainNodePosition(
                                mocFile,
                                n.crossDomainSourceNodeId,
                                crossDomainLink,
                                pos
                            );
                        }

                        // auto 布局分离/归队后:重排受影响父节点的子树。
                        // 分离 → 其余兄弟紧凑回收空位(分离节点子树被排除,保留原位);
                        // 归队/圆内拖动 → 该节点吸附回树(按落点定侧/序),不留自由坐标。
                        // saveMOCStructure 已清解析缓存,reflow 重新解析即拿到最新标志位。
                        if (separations.size > 0) {
                            const reflowParents = new Set<string>();
                            for (const sep of separations.values()) reflowParents.add(sep.parentId);
                            for (const parentId of reflowParents) {
                                // 仅局部重排该父节点的子树(不上溯整棵树):分离 → 兄弟补位;
                                // 吸附 → 该节点归位。避免拖一个节点导致整棵树所有分支重排。
                                await this.relayoutAutoLayoutSiblings(parentId, {
                                    compactVisibleNodes: true,
                                    collapsedNodeIds: this.collapsedNodeIds,
                                    rebalanceRootChildren: true,
                                    localOnly: true,
                                });
                            }
                            // separatedNodeIds 选项随之变化 → 触发刷新,保证下次拖动的分离圆半径准确。
                            this.lastRenderSignature = null;
                            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                        }
                    } catch (error) {
                        console.error('Failed to save node positions:', error);
                    }
                })();
                this.pendingNodePositionSavePromise = savePromise;
                savePromise.finally(() => {
                    if (this.pendingNodePositionSavePromise === savePromise) {
                        this.pendingNodePositionSavePromise = null;
                    }
                });
            }, DEBOUNCE_DELAY.POSITION_SAVE);
        });

        // 监听跨领域节点位置变化事件（拖动后保存到 cross_domain_links）
        this.addTrackedListener(branchGraphDiv, 'cross-domain-node-position-changed', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node, position, crossDomainLink, sourceNodeId } = event.detail;

            // 检查是否有效
            if (!node || !crossDomainLink || !sourceNodeId) {
                return;
            }

            // 使用防抖，避免拖动时频繁保存
            if (this.crossDomainPositionSaveTimeout) {
                clearTimeout(this.crossDomainPositionSaveTimeout);
            }

            this.crossDomainPositionSaveTimeout = setTimeout(async () => {
                // 保存跨领域节点位置到 MOC 文件
                try {
                    // 监听器可能复用，保存时读取最新当前文件路径，避免写入旧 MOC
                    const latestMOCPath = this.plugin.settings.mocCurrentFile;
                    const mocFile = this.app.vault.getFileByPath(latestMOCPath);
                    if (mocFile) {
                        await this.saveCrossDomainNodePosition(mocFile, sourceNodeId, crossDomainLink, position);
                    }
                } catch (error) {
                    console.error('Failed to save cross-domain node position:', error);
                }
            }, DEBOUNCE_DELAY.POSITION_SAVE);
        });

        this.addTrackedListener(branchGraphDiv, 'node-collapse-state-changed', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const nodeId = String(event.detail?.nodeId || '').trim();
            const collapsedNodeIds = Array.isArray(event.detail?.collapsedNodeIds)
                ? event.detail.collapsedNodeIds.map((id: unknown) => String(id)).filter(Boolean)
                : [];
            const collapsed = event.detail?.collapsed === true;
            if (!nodeId) return;

            try {
                const mocFile = getLatestMOCFile();
                if (!mocFile) return;
                this.collapsedNodeIds = collapsedNodeIds;
                await this.persistCollapseState(mocFile, collapsedNodeIds);
                if (this.isNodeAutoLayout(nodeId)) {
                    // auto 布局:收起和展开都按当前 collapsedNodeIds 重新计算可见节点的紧凑布局。
                    // 收起/部分展开 → persistPositions:false,仅临时视觉重排,不污染文件坐标
                    // (文件驱动的刷新会在渲染后统一重放这份紧凑布局,见 refreshBranchMermaidMOC 尾部);
                    // 全部展开 → 落盘整树重算结果:收起期间的持久化 reflow(新建/删除/移动节点)
                    // 不包含隐藏节点,会让隐藏子树的文件坐标过期,此时必须整体重写使其重新自洽。
                    await this.relayoutAutoLayoutSiblings(nodeId, {
                        collapsedNodeIds,
                        compactVisibleNodes: true,
                        rebalanceRootChildren: true,
                        persistPositions: collapsedNodeIds.length === 0,
                    });
                } else if (collapsedNodeIds.length === 0) {
                    // free 布局:节点都有保存坐标,展开时还原即可。
                    await this.restoreSavedNodePositions(mocFile);
                }
            } catch (error) {
                console.error('Failed to save collapse state:', error);
            }
        });

        // 监听边弧度变化事件（拖动控制点后保存到 MOC 文件）
        this.addTrackedListener(branchGraphDiv, 'edge-curvature-changed', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { edgeId, source, target, distance, weight } = event.detail;

            // 使用防抖，避免拖动时频繁保存
            if (this.edgeCurvatureSaveTimeout) {
                clearTimeout(this.edgeCurvatureSaveTimeout);
            }

            this.edgeCurvatureSaveTimeout = setTimeout(async () => {
                // 保存弧度到 MOC 文件
                try {
                    const mocFile = getLatestMOCFile();
                    if (mocFile) {
                        await this.saveEdgeCurvatureToMOC(mocFile, edgeId, { distance, weight });
                    }
                } catch (error) {
                    console.error('Failed to save edge curvature:', error);
                }
            }, DEBOUNCE_DELAY.EDGE_CURVATURE_SAVE);
        });

        // 监听预览节点尺寸变化事件（右下角拖拽后保存到 JSON）
        // 使用 debounce 合并连续 resize 事件，避免高频写入。
        this.addTrackedListener(branchGraphDiv, 'embed-node-size-changed', (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node, nodeId, size } = event.detail || {};
            const targetNodeId = String(nodeId || node?.ID || node?.IDStr || '').trim();
            if (!targetNodeId || !size) return;

            if (this.embedNodeSizeSaveTimeout) {
                clearTimeout(this.embedNodeSizeSaveTimeout);
            }
            this.embedNodeSizeSaveTimeout = setTimeout(async () => {
                try {
                    const mocFile = getLatestMOCFile();
                    if (mocFile) {
                        await this.saveEmbedNodeSizeToMOC(mocFile, targetNodeId, size);
                        if (this.isNodeAutoLayout(targetNodeId) || this.hasAutoLayoutChild(targetNodeId)) {
                            await this.reflowAutoLayout(targetNodeId);
                        }
                    }
                } catch (error) {
                    console.error('Failed to save embed node size:', error);
                }
            }, DEBOUNCE_DELAY.POSITION_SAVE);
        });

        // 监听分组创建事件
        this.addTrackedListener(branchGraphDiv, 'group-create', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { groupId, groupLabel, nodeIds } = event.detail;
            
            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    await this.saveGroupToMOC(mocFile, { id: groupId, label: groupLabel, nodeIds });
                    // 刷新视图以显示新分组
                    await this.refreshBranchMermaid();
                }
            } catch (error) {
                console.error('Failed to save group:', error);
            }
        });

        // 监听分组重命名事件
        this.addTrackedListener(branchGraphDiv, 'group-rename', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { groupId, oldLabel, newLabel } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    await this.renameGroupInMOC(mocFile, groupId, newLabel);
                    // 刷新视图以显示更新后的分组名
                    await this.refreshBranchMermaid();
                }
            } catch (error) {
                console.error('Failed to rename group:', error);
            }
        });

        // 监听分组调整大小事件
        this.addTrackedListener(branchGraphDiv, 'group-resize', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { groupId, groupLabel, nodeIds } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    // 更新分组的节点列表
                    await this.updateGroupNodesInMOC(mocFile, groupId, nodeIds);
                    // 刷新视图以显示更新后的分组
                    await this.refreshBranchMermaid();
                }
            } catch (error) {
                console.error('Failed to resize group:', error);
            }
        });

        // 监听分组右键菜单事件
        this.addTrackedListener(branchGraphDiv, 'group-contextmenu', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { groupId, groupLabel, event: mouseEvent } = event.detail;
            this.showGroupContextMenu(mouseEvent, groupId, groupLabel);
        });

        // 监听节点点击事件
        this.addTrackedListener(branchGraphDiv, 'node-click', (event: any) => {
            const { node, event: triggerEvent } = event.detail || {};

            // 检查节点是否有效
            if (!node) {
                console.warn('Invalid node clicked:', node);
                return;
            }

            // 优先使用已解析文件；否则回退到 wikiLink/显示文本解析，避免转换后 file 暂时为空导致无法打开
            let targetFile = node.file ?? null;
            if (!targetFile && node.file?.path) {
                targetFile = this.app.vault.getFileByPath(node.file.path);
            }
            if (!targetFile) {
                const mocPath = this.plugin.settings.mocCurrentFile || '';
                const basePath = mocPath.includes('/') ? mocPath.substring(0, mocPath.lastIndexOf('/')) : '';
                const linkText = (node.wikiLink || node.displayText || node.title || '').trim();
                if (linkText) {
                    targetFile = this.app.metadataCache.getFirstLinkpathDest(linkText, basePath) || null;
                }
            }
            if (!targetFile) {
                console.warn('Node click target file not resolved:', node);
                return;
            }

            const isMouseEvent = triggerEvent instanceof MouseEvent;
            const isMocTarget = isMocPath(targetFile.path);
            // Cmd/Ctrl+点击始终在新标签页打开（MOC 目标仍走当前视图切换逻辑）；否则按设置的默认打开方式。
            const forceTab = !isMocTarget && isMouseEvent && (triggerEvent.metaKey || triggerEvent.ctrlKey);
            // 带 #heading / #^blockRef 的链接（如 Excalidraw 的 #^group=xxx）：
            // 用 leaf.openFile + eState.subpath 让 ExcalidrawView.setEphemeralState 解析 subpath 并自动 zoomToElementId
            const rawLink = String(node.wikiLink || '').trim();
            const hashIdx = rawLink.indexOf('#');
            const subpath = hashIdx >= 0 ? rawLink.substring(hashIdx) : '';

            if (subpath) {
                this.openFileInPreferredLeaf(targetFile, forceTab, subpath);
                return;
            }

            this.openFileInPreferredLeaf(targetFile, forceTab);
        });

        // 监听节点悬停事件
        this.addTrackedListener(branchGraphDiv, 'node-hover', (event: any) => {
            const { node, event: mouseEvent } = event.detail;

            // 检查节点是否有效
            if (!node || !node.file) {
                return;
            }
            const now = Date.now();
            if (this.lastHoverPreviewPath === node.file.path && now - this.lastHoverPreviewAt < 120) {
                return;
            }
            this.lastHoverPreviewPath = node.file.path;
            this.lastHoverPreviewAt = now;

            this.app.workspace.trigger('hover-link', {
                event: mouseEvent,
                source: 'zk-navigation',
                hoverParent: branchGraphDiv,
                // 使用 Obsidian 常规参数组合，避免 [[...]] 解析差异导致误判"未创建"
                linktext: "",
                targetEl: mouseEvent?.target ?? branchGraphDiv,
                sourcePath: node.file.path,
            });
        });

        this.addTrackedListener(branchGraphDiv, 'node-leave', () => {
            this.lastHoverPreviewPath = null;
            this.lastHoverPreviewAt = 0;
        });

        // 监听节点选中事件（单击）— 更新平行宇宙面包屑 + 同步层级面包屑到该节点的路径
        this.addTrackedListener(branchGraphDiv, 'node-select', (event: any) => {
            const { node } = event.detail;
            this.updateMultiverseBadge(node);
            this.syncLevelBreadcrumbWithNode(node);
            this.handleDetailPanelSelect(node);
        });

        // 点击画布空白处 — 隐藏平行宇宙徽章,清除暗淡;层级面包屑保持显示
        this.addTrackedListener(branchGraphDiv, 'background-click', () => {
            this.updateMultiverseBadge(null);
            this.clearLevelDim();
            this.refreshLevelBreadcrumb();
            // 钉住(常驻)时背景点击不收起,也不丢失当前节点引用
            if (!this.detailPanel?.isPinned) {
                this.detailPanelLastId = null;
                this.detailPanel?.hide();
            }
        });

        // 监听节点编辑事件（双击）
        this.addTrackedListener(branchGraphDiv, 'node-edit', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node } = event.detail;

            if (!node) {
                return;
            }

            await this.editNodeContent(node);
        });

        this.addTrackedListener(branchGraphDiv, 'node-inline-edit-save', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node, content, position, nodeSize, nodeId, isDraft, relationCount } = event.detail;
            // 草稿节点(#20):复用同一内联文本框,保存只更新内存,不写 MOC
            if (isDraft && nodeId && this.draftNodes.has(nodeId)) {
                // 空内容 = 删除该草稿
                if (!content || !content.trim()) {
                    this.deleteDraftNode(nodeId);
                } else {
                    this.updateDraftContent(nodeId, content);
                }
                return;
            }
            if (!node) {
                return;
            }
            await this.saveNodeContent(node, content, nodeSize, position, relationCount || 0);
        });

        // 录音命令产出的音频文件 → 追加为当前文本节点的嵌入(![[audio]])
        this.addTrackedListener(branchGraphDiv, 'node-append-embed', async (event: any) => {
            if (this.isMobileReadOnly()) return;
            const { nodeIdStr, embedPath } = event.detail || {};
            if (!nodeIdStr || !embedPath) return;
            await this.appendEmbedToTextNode(String(nodeIdStr), String(embedPath));
        });

        // 草稿节点(#20):删除键 → 仅从内存与画布移除,不碰 MOC
        this.addTrackedListener(branchGraphDiv, 'draft-node-delete', (event: any) => {
            if (this.isMobileReadOnly()) return;
            const { draftId } = event.detail || {};
            if (draftId) this.deleteDraftNode(draftId);
        });

        this.addTrackedListener(branchGraphDiv, 'draft-relation-delete', (event: any) => {
            if (this.isMobileReadOnly()) return;
            const { relKey } = event.detail || {};
            if (relKey) this.deleteDraftRelation(relKey);
        });

        // R 角标点击 → 打开/切换详情侧栏(只读态也可查看;再次点同一节点关闭)
        this.addTrackedListener(branchGraphDiv, 'node-detail-toggle', async (event: any) => {
            const { node } = event.detail;
            if (!node || !this.detailPanel) {
                return;
            }
            if (this.detailPanel.isOpen && this.detailPanel.nodeIdStr === node.IDStr) {
                this.detailPanel.close();
                this.detailPanelLastId = null;
                return;
            }
            this.detailPanel.setSide(this.plugin.settings.detailPanelSide === 'left' ? 'left' : 'right');
            this.detailPanelLastId = node.IDStr;
            await this.detailPanel.show(node);
        });

        // 监听 .moc 预览节点点击跳转分支视图
        this.addTrackedListener(branchGraphDiv, 'open-moc-in-index-view', async (event: any) => {
            const { filePath } = event.detail;
            if (!filePath) return;
            this.plugin.settings.mocCurrentFile = filePath;
            await this.plugin.saveData(this.plugin.settings);
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        });

        // 监听文件节点⟷预览节点切换
        this.addTrackedListener(branchGraphDiv, 'toggle-embed-node', async (event: any) => {
            if (this.isMobileReadOnly()) return;
            const { node, nodeId: detailNodeId, wikiLink: detailWikiLink, filePath: detailFilePath, displayText: detailDisplayText, title: detailTitle, currentIsEmbed } = event.detail;
            const mocFilePath = this.plugin.settings.mocCurrentFile;
            if (!mocFilePath) return;
            const mocFile = this.app.vault.getFileByPath(mocFilePath);
            if (!mocFile) return;
            const nodeId = String(detailNodeId || node?.IDStr || node?.nodeID || node?.ID || '').trim();
            if (!nodeId) {
                console.warn('[indexView] toggle-embed-node missing node id', node);
                new Notice('切换失败：节点 ID 缺失');
                return;
            }

            const newIsEmbed = !currentIsEmbed;
            const fallbackWikiFromPath = (() => {
                const path = String(detailFilePath || node?.file?.path || '').trim();
                if (!path) return '';
                const name = path.includes('/') ? path.substring(path.lastIndexOf('/') + 1) : path;
                if (isMocPath(name)) {
                    return name; // .moc / .moc.md 需要保留扩展名
                }
                return name.replace(/\.md$/i, '');
            })();
            // .moc 需要保留扩展名，优先取 file.name；其他文件兼容现有字段
            const contentForSave = String(
                detailWikiLink || node?.wikiLink || node?.file?.name || node?.file?.basename || detailDisplayText || node?.displayText || detailTitle || node?.title || fallbackWikiFromPath
            ).trim();

            try {
                await this.mocHandler.updateNodeContentInMOC(
                    mocFile,
                    nodeId,
                    contentForSave,
                    undefined,
                    newIsEmbed
                );
                this.lastRenderSignature = null;
                await this.refreshBranchMermaid();
            } catch (error) {
                console.error('[indexView] toggle-embed-node failed:', { nodeId, node, error });
                new Notice(`切换失败: ${error?.message || error}`);
            }
        });

        // 监听跨领域节点点击事件（跳转到关联的 MOC 文件）
        this.addTrackedListener(branchGraphDiv, 'cross-domain-node-click', async (event: any) => {
            const { node } = event.detail;

            // 获取跨领域链接信息
            const crossDomainLink = node.file;  // 跨领域节点的 file 字段存储了链接信息

            if (!crossDomainLink || !crossDomainLink.mocPath) {
                new Notice('跨领域节点信息无效');
                return;
            }

            try {
                // 切换到关联的 MOC 文件
                const mocFile = this.app.vault.getFileByPath(crossDomainLink.mocPath);
                if (!mocFile) {
                    new Notice(`未找到 MOC 文件: ${crossDomainLink.mocPath}`);
                    return;
                }

                // 更新当前 MOC 文件设置
                this.plugin.settings.mocCurrentFile = mocFile.path;
                await this.plugin.saveData(this.plugin.settings);

                // 刷新视图
                await this.refreshBranchMermaid();

                new Notice(`已跳转到 MOC: ${mocFile.basename}`);
            } catch (error) {
                console.error('Failed to jump to cross-domain MOC:', error);
                new Notice(`跳转失败: ${error.message}`);
            }
        });

        // 跨领域「出口角标」卡片里点击某条链接 → 跳到目标 MOC 并定位该节点
        this.addTrackedListener(branchGraphDiv, 'cross-domain-jump', async (event: any) => {
            const { link } = event.detail || {};
            if (!link?.mocPath) {
                new Notice('跨领域链接信息无效');
                return;
            }
            const mocFile = this.app.vault.getFileByPath(link.mocPath);
            if (!mocFile) {
                new Notice(`未找到 MOC 文件: ${link.mocPath}`);
                return;
            }
            try {
                if (mocFile.path !== this.plugin.settings.mocCurrentFile) {
                    this.plugin.settings.mocCurrentFile = mocFile.path;
                    await this.plugin.saveData(this.plugin.settings);
                    await this.refreshBranchMermaid();
                }
                // 定位目标节点(渲染可能稍滞后,定位失败则单次重试)
                if (link.nodeId) {
                    const locate = () => {
                        const found = this.findCyNodeByIdStr(link.nodeId);
                        if (found) { this.selectAndShowDetailByIdStr(link.nodeId); return true; }
                        return false;
                    };
                    if (!locate()) window.setTimeout(locate, 160);
                }
                new Notice(`已跳转到: ${mocFile.basename}`);
            } catch (error) {
                console.error('Failed to jump to cross-domain note:', error);
                new Notice(`跳转失败: ${error.message}`);
            }
        });

        // 跨领域「出口角标」卡片里点击 × → 双向删除该条链接(对侧不存在也不报错,兼容历史单向数据)
        this.addTrackedListener(branchGraphDiv, 'cross-domain-remove', async (event: any) => {
            if (this.isMobileReadOnly()) return;
            const { sourceNodeId, link } = event.detail || {};
            if (!sourceNodeId || !link?.nodeId) return;
            const currentMocPath = this.plugin.settings.mocCurrentFile;
            const mocFile = this.app.vault.getFileByPath(currentMocPath);
            if (!mocFile) return;
            try {
                await this.saveAllNodePositionsBeforeRefresh();
                // 近端:当前 MOC 的源节点下,删指向 link.nodeId@link.mocPath 的那条
                const nearRemoved = await this.removeCrossDomainLinkFromExt(
                    mocFile, sourceNodeId, { nodeId: link.nodeId, mocPath: link.mocPath }
                );
                // 远端:目标 MOC 的目标节点下,删反向指回 sourceNodeId@当前 MOC 的那条
                let farRemoved = false;
                const targetMocFile = link.mocPath ? this.app.vault.getFileByPath(link.mocPath) : null;
                if (targetMocFile) {
                    farRemoved = await this.removeCrossDomainLinkFromExt(
                        targetMocFile, link.nodeId, { nodeId: sourceNodeId, mocPath: currentMocPath }
                    );
                }
                await this.refreshBranchMermaid();
                new Notice(
                    nearRemoved && farRemoved ? '已删除跨领域链接(双向)'
                    : (nearRemoved || farRemoved) ? '已删除跨领域链接(单向·对侧原本缺失)'
                    : '未找到要删除的跨领域链接'
                );
            } catch (error) {
                console.error('Failed to remove cross-domain link:', error);
                new Notice(`删除失败: ${error.message}`);
            }
        });

        // 监听节点复制事件（Cmd+C）
        this.addTrackedListener(branchGraphDiv, 'node-copy', (event: any) => {
            const { count } = event.detail;
            new Notice(t("Copied nodes").replace("{count}", String(count)));
        });

        // 监听节点粘贴事件（Cmd+V）
        this.addTrackedListener(branchGraphDiv, 'node-paste', async (event: any) => {
            if (this.isMobileReadOnly()) return;
            const { nodes, pasteCenter } = event.detail as {
                nodes: Array<{ originalNode: any; position: { x: number; y: number } }>;
                pasteCenter: { x: number; y: number };
            };
            if (!nodes || nodes.length === 0) return;

            const mocFilePath = this.plugin.settings.mocCurrentFile;
            if (!mocFilePath) return;
            const mocFile = this.app.vault.getFileByPath(mocFilePath);
            if (!mocFile) return;

            // 计算原始节点群的中心，粘贴时保持相对位置
            const origCenterX = nodes.reduce((s, n) => s + n.position.x, 0) / nodes.length;
            const origCenterY = nodes.reduce((s, n) => s + n.position.y, 0) / nodes.length;
            const PASTE_OFFSET = 60; // 避免完全重叠

            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 在 mocData 内部计算可用 ID，避免批量粘贴时 ID 冲突
                const collectIds = (nodes: MOCTreeNode[]): string[] =>
                    nodes.flatMap(n => [n.nodeID, ...collectIds(n.children || [])]);
                const existingIds = new Set(collectIds(mocData.nodes));
                const maxFree = Math.max(0, ...Array.from(existingIds)
                    .map(id => { const m = id?.match(/^free\.(\d+)$/); return m ? parseInt(m[1]) : 0; }));
                let nextFree = maxFree + 1;

                for (const { originalNode, position } of nodes) {
                    if (!originalNode) continue;
                    let newID = `free.${nextFree}`;
                    while (existingIds.has(newID)) { nextFree++; newID = `free.${nextFree}`; }
                    existingIds.add(newID);
                    nextFree++;

                    // originalNode 来自 Cytoscape，是 ZKNode（保留旧字段）；映射为新 MOCTreeNode 形状
                    const zkIsTextOnly = !!originalNode.isTextOnly;
                    const zkIsEmbed = !!originalNode.isEmbed;
                    const zkTarget = zkIsTextOnly
                        ? (originalNode.displayText || '')
                        : (originalNode.wikiLink || originalNode.displayText || '');
                    const newNode: MOCTreeNode = {
                        nodeID: newID,
                        nodeType: zkIsTextOnly ? 'text' : (zkIsEmbed ? 'embed' : 'file'),
                        target: zkTarget,
                        depth: 0,
                        children: [],
                        file: zkIsTextOnly ? null : (originalNode.file || null),
                        relationText: '',
                    };
                    // 仅 file 节点 + displayText 与 target 不同时保留 alias
                    if (!zkIsTextOnly && !zkIsEmbed
                        && originalNode.displayText
                        && originalNode.displayText !== zkTarget) {
                        newNode.alias = originalNode.displayText;
                    }
                    mocData.nodes.push(newNode);

                    if (!mocData.nodePositions) mocData.nodePositions = {};
                    mocData.nodePositions[newID] = {
                        x: pasteCenter.x + (position.x - origCenterX) + PASTE_OFFSET,
                        y: pasteCenter.y + (position.y - origCenterY) + PASTE_OFFSET
                    };
                }
            });

            await this.refreshBranchMermaid();
            new Notice(t("Pasted nodes").replace("{count}", String(nodes.length)));
        });

        // 监听系统剪贴板粘贴事件(Cmd+V 且内部剪贴板为空时回退)
        // 自动识别 [[link]] / ![[embed]] / 多行 wiki link / 纯文本,创建对应节点
        this.addTrackedListener(branchGraphDiv, 'system-text-paste', async (event: any) => {
            if (this.isMobileReadOnly()) return;
            const { text, pasteCenter } = event.detail as {
                text: string;
                pasteCenter: { x: number; y: number };
            };
            if (!text) return;

            const mocFilePath = this.plugin.settings.mocCurrentFile;
            if (!mocFilePath) return;
            const mocFile = this.app.vault.getFileByPath(mocFilePath);
            if (!mocFile) return;

            // 解析剪贴板内容:整段当作一个文本节点;若整段是单个 [[..]] / ![[..]] 则识别为 file/embed
            type ParsedNode = { type: 'file' | 'embed' | 'text'; target: string; alias?: string };
            const parseClipboard = (raw: string): ParsedNode => {
                const trimmed = raw.trim();
                const embedMatch = trimmed.match(/^!\[\[([^\]]+)\]\]$/);
                if (embedMatch) {
                    const [target, alias] = embedMatch[1].split('|').map((s) => s.trim());
                    return { type: 'embed', target, alias: alias || undefined };
                }
                const linkMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
                if (linkMatch) {
                    const [target, alias] = linkMatch[1].split('|').map((s) => s.trim());
                    return { type: 'file', target, alias: alias || undefined };
                }
                return { type: 'text', target: trimmed };
            };

            const parsed = parseClipboard(text);

            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                const collectIds = (nodes: MOCTreeNode[]): string[] =>
                    nodes.flatMap((n) => [n.nodeID, ...collectIds(n.children || [])]);
                const existingIds = new Set(collectIds(mocData.nodes));
                const maxFree = Math.max(0, ...Array.from(existingIds)
                    .map((id) => { const m = id?.match(/^free\.(\d+)$/); return m ? parseInt(m[1]) : 0; }));
                const newID = `free.${maxFree + 1}`;

                const newNode: MOCTreeNode = {
                    nodeID: newID,
                    nodeType: parsed.type,
                    target: parsed.target,
                    depth: 0,
                    children: [],
                    file: parsed.type === 'text' ? null : null,
                    relationText: '',
                };
                if (parsed.alias && parsed.type !== 'text') {
                    newNode.alias = parsed.alias;
                }
                mocData.nodes.push(newNode);

                if (!mocData.nodePositions) mocData.nodePositions = {};
                mocData.nodePositions[newID] = { x: pasteCenter.x, y: pasteCenter.y };
            });

            await this.refreshBranchMermaid();
            new Notice(t("Pasted nodes").replace("{count}", '1'));
        });

        // 监听节点删除键事件
        this.addTrackedListener(branchGraphDiv, 'node-delete-key', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node, relationCount } = event.detail;

            if (!node || !node.ID) {
                console.warn('Invalid node for deletion:', node);
                return;
            }

            await this.deleteNodeFromGraph(node, relationCount);
        });

        // 监听跨领域节点右键菜单事件
        this.addTrackedListener(branchGraphDiv, 'cross-domain-contextmenu', async (event: any) => {
            const { node, event: mouseEvent } = event.detail;

            // 获取跨领域链接信息
            const crossDomainLink = node?.file;

            // 阻止默认右键菜单
            mouseEvent.preventDefault();
            mouseEvent.stopPropagation();

            // 创建菜单
            const menu = new Menu();

            // 添加"打开跨界思维树"选项
            menu.addItem((item) => {
                item.setTitle("🌳 打开跨界思维树")
                    .setIcon("network")
                    .onClick(async () => {
                        if (crossDomainLink?.mocPath) {
                            await this.openCrossDomainMOC(crossDomainLink.mocPath);
                        }
                    });
            });

            // 显示菜单
            menu.showAtMouseEvent(mouseEvent);
        });

        // 监听节点右键菜单事件
        this.addTrackedListener(branchGraphDiv, 'node-contextmenu', (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node, event: mouseEvent, position } = event.detail;
            
            // 检查节点是否有效（允许纯文字节点，即 file 为 null 的节点）
            if (!node) {
                console.warn('Invalid node for context menu:', node);
                return;
            }
            
            // 阻止默认右键菜单
            mouseEvent.preventDefault();
            mouseEvent.stopPropagation();

            this.showNodeContextMenu(mouseEvent, node);
        });

        // 监听背景双击事件（创建占位符节点）
        this.addTrackedListener(branchGraphDiv, 'background-dblclick', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { position } = event.detail;

            // 草稿模式(#20):仍走常规占位符文本框,只是完成时存为草稿(见 placeholder-node-edit)
            await this.createPlaceholderNode(position);
        });

        // 监听占位符节点编辑事件
        this.addTrackedListener(branchGraphDiv, 'placeholder-node-edit', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeId, label, position, suggestedNodeId, nodeSize } = event.detail;

            // 草稿模式(#20):占位符内容转存为草稿,不写 MOC
            if (this.draftMode) {
                if (label.trim()) {
                    this.convertPlaceholderToDraft(nodeId, label.trim());
                } else {
                    await this.removePlaceholderNode(nodeId);
                }
                return;
            }

            // 如果有预生成的节点 ID，更新占位符信息
            if (suggestedNodeId) {
                const placeholderInfo = this.placeholderNodes.get(nodeId);
                if (placeholderInfo) {
                    placeholderInfo.suggestedNodeId = suggestedNodeId;
                }
            }

            const parsed = this.parseRawWikiLinkInput(label);
            if (parsed) {
                // 情况 1：检测到 wiki link/嵌入 link → 创建文件节点
                const aliasToSave = parsed.displayText && parsed.displayText !== parsed.wikiLink
                    ? parsed.displayText : undefined;
                await this.finalizeFileNode(nodeId, parsed.wikiLink, label, position, parsed.isEmbed, aliasToSave);
            } else if (label.trim()) {
                // 情况 2：无 wiki link → 创建纯文字节点（保留编辑时的可视尺寸）
                await this.finalizeTextOnlyNode(nodeId, label.trim(), position, nodeSize);
            } else {
                // 情况 3：空输入 → 移除占位符
                await this.removePlaceholderNode(nodeId);
            }
        });

        // 监听占位符节点取消事件（Esc 或点击空白）
        this.addTrackedListener(branchGraphDiv, 'placeholder-node-cancel', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeId } = event.detail;
            // auto 预览重排把兄弟挪开了(未落盘),取消时按文件保存坐标还原,回收占位空缺。
            const wasAutoPreview = this.placeholderNodes.get(nodeId)?.layoutStyle === 'auto';
            await this.removePlaceholderNode(nodeId);
            if (wasAutoPreview) {
                const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
                if (mocFile) await this.restoreSavedNodePositions(mocFile);
            }
        });

        // 监听占位符节点完成事件（从 suggester 选择文件后触发）
        this.addTrackedListener(branchGraphDiv, 'placeholder-node-complete', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeId, wikiLink, file, isEmbed } = event.detail;

            // 草稿模式(#20):选中的文件也转存为草稿(以 wiki 链接文本形式),不写 MOC
            if (this.draftMode) {
                this.convertPlaceholderToDraft(nodeId, `${isEmbed ? '!' : ''}[[${wikiLink}]]`);
                return;
            }

            // 获取占位符信息
            const placeholderInfo = this.placeholderNodes.get(nodeId);
            if (!placeholderInfo) return;

            // 优先使用预生成的节点 ID，否则生成新的自由节点 ID
            const suggestedID = placeholderInfo.suggestedNodeId || this.generateNextFreeNodeID();

            // 检查是否有智能连线确定的父节点
            if (placeholderInfo.parentNodeId) {
                // 先保存为自由节点，然后移动到父节点下
                await this.saveFreeNodeToMOC({
                    wikiLink: wikiLink,
                    nodeID: suggestedID,
                    relationText: '',
                    file: file,
                    isEmbed: !!isEmbed
                });

                // 然后移动到父节点下
                const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
                if (mocFile) {
                    if (this.isFreeNodeID(suggestedID) || this.isFreeNodeID(placeholderInfo.parentNodeId)) {
                        await this.addArrowRelationToMOC(mocFile, placeholderInfo.parentNodeId, suggestedID, '');
                    } else {
                        await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
                    }
                }
            } else {
                // 保存到 MOC
                await this.saveFreeNodeToMOC({
                    wikiLink: wikiLink,
                    nodeID: suggestedID,
                    relationText: '',
                    file: file,
                    isEmbed: !!isEmbed
                });
            }

            // 保存位置
            const mocFilePath = this.plugin.settings.mocCurrentFile;
            const mocFile = this.app.vault.getFileByPath(mocFilePath);
            if (mocFile) {
                await this.savePlaceholderLayoutPositions(
                    mocFile,
                    suggestedID,
                    placeholderInfo.position
                );
            }

            // 从占位符追踪中移除
            this.placeholderNodes.delete(nodeId);

            // 刷新视图
            await this.refreshBranchMermaid();

            // 声明式 reflow: 整棵树重排, 给新节点腾位置, 回收空缺。
            if (this.isNodeAutoLayout(suggestedID)) {
                await this.applyNewSiblingSide(suggestedID);
                await this.reflowAutoLayout(suggestedID);
            }

            // 清理所有占位符连接线（因为视图已经刷新，占位符节点已不存在）
            branchGraphDiv.dispatchEvent(new CustomEvent('cleanup-all-placeholder-connections'));

            // 自动选中新创建的节点
            branchGraphDiv.dispatchEvent(new CustomEvent('select-node-by-id', {
                detail: {
                    nodeId: suggestedID
                }
            }));
        });

        // 监听从 suggester 添加自由节点事件
        this.addTrackedListener(branchGraphDiv, 'add-free-node-from-suggester', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeId, wikiLink, file, isEmbed } = event.detail;

            // 草稿模式(#20):选中的文件也转存为草稿(以 wiki 链接文本形式),不写 MOC
            if (this.draftMode) {
                this.convertPlaceholderToDraft(nodeId, `${isEmbed ? '!' : ''}[[${wikiLink}]]`);
                return;
            }

            // 获取占位符信息
            const placeholderInfo = this.placeholderNodes.get(nodeId);
            if (!placeholderInfo) return;

            // 优先使用预生成的节点 ID，否则生成新的自由节点 ID
            const suggestedID = placeholderInfo.suggestedNodeId || this.generateNextFreeNodeID();

            // 检查是否有智能连线确定的父节点
            if (placeholderInfo.parentNodeId) {
                // 先保存为自由节点，然后移动到父节点下
                await this.saveFreeNodeToMOC({
                    wikiLink: wikiLink,
                    nodeID: suggestedID,
                    relationText: '',
                    file: file,
                    isEmbed: !!isEmbed
                });

                // 然后移动到父节点下
                const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
                if (mocFile) {
                    if (this.isFreeNodeID(suggestedID) || this.isFreeNodeID(placeholderInfo.parentNodeId)) {
                        await this.addArrowRelationToMOC(mocFile, placeholderInfo.parentNodeId, suggestedID, '');
                    } else {
                        await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
                    }
                }
            } else {
                // 直接保存到 MOC，不需要打开模态框
                await this.saveFreeNodeToMOC({
                    wikiLink: wikiLink,
                    nodeID: suggestedID,
                    relationText: '',
                    file: file,
                    isEmbed: !!isEmbed
                });
            }

            // 保存位置
            const mocFilePath = this.plugin.settings.mocCurrentFile;
            const mocFile = this.app.vault.getFileByPath(mocFilePath);
            if (mocFile) {
                await this.savePlaceholderLayoutPositions(
                    mocFile,
                    suggestedID,
                    placeholderInfo.position
                );
            }

            // 从占位符追踪中移除
            this.placeholderNodes.delete(nodeId);

            // 刷新视图
            await this.refreshBranchMermaid();

            // 声明式 reflow: 整棵树重排, 给新节点腾位置, 回收空缺。
            if (this.isNodeAutoLayout(suggestedID)) {
                await this.applyNewSiblingSide(suggestedID);
                await this.reflowAutoLayout(suggestedID);
            }

            // 清理所有占位符连接线（因为视图已经刷新，占位符节点已不存在）
            branchGraphDiv.dispatchEvent(new CustomEvent('cleanup-all-placeholder-connections'));

            // 自动选中新创建的节点
            branchGraphDiv.dispatchEvent(new CustomEvent('select-node-by-id', {
                detail: {
                    nodeId: suggestedID
                }
            }));
        });

        // 监听边点击事件
        this.addTrackedListener(branchGraphDiv, 'edge-click', (event: any) => {
            const { edgeId, source, target, type, label } = event.detail;
            // 可以在这里添加边的高亮或其他交互
        });

        // 监听边右键菜单事件（删除边）
        this.addTrackedListener(branchGraphDiv, 'edge-contextmenu', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { edgeId, source, target, type, label, position, targetNodeSons } = event.detail;
            // 创建右键菜单
            const menu = new Menu();

            menu.addItem((item) => {
                item.setTitle('恢复自动样式')
                    .setIcon('refresh-cw')
                    .onClick(async () => {
                        try {
                            const mocFile = getLatestMOCFile();
                            if (mocFile) {
                                await this.restoreEdgeAutoStyleInMOC(mocFile, `${source}-${target}`);
                                await this.refreshBranchMermaid(true);
                            }
                        } catch (error) {
                            console.error('Failed to restore edge auto style:', error);
                            new Notice(`恢复自动样式失败: ${error.message}`);
                        }
                    });
            });

            menu.addItem((item) => {
                item.setTitle('删除箭头关系')
                    .setIcon('trash')
                    .onClick(async () => {
                        try {
                            const mocFile = getLatestMOCFile();
                            if (mocFile) {
                                await this.deleteArrowRelationFromMOC(mocFile, source, target, targetNodeSons, type);
                                // 刷新视图
                                await this.refreshBranchMermaid();
                            }
                        } catch (error) {
                            console.error('Failed to delete arrow relation:', error);
                            new Notice(`删除箭头关系失败: ${error.message}`);
                        }
                    });
            });

            menu.showAtPosition(position);
        });

        // 监听分组删除键事件（Delete/Backspace）
        this.addTrackedListener(branchGraphDiv, 'group-delete-key', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { groupId, groupLabel } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    await this.deleteGroupFromMOC(mocFile, groupId);
                    // 刷新视图
                    await this.refreshBranchMermaid();
                }
            } catch (error) {
                console.error('Failed to delete group:', error);
                new Notice(`删除分组失败: ${error.message}`);
            }
        });

        // 监听边删除键事件（Delete/Backspace）
        this.addTrackedListener(branchGraphDiv, 'edge-delete-key', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { edgeId, source, target, type, label, targetNodeSons } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    await this.deleteArrowRelationFromMOC(mocFile, source, target, targetNodeSons, type);
                    // 刷新视图
                    await this.refreshBranchMermaid();
                }
            } catch (error) {
                console.error('Failed to delete arrow relation:', error);
                new Notice(`删除箭头关系失败: ${error.message}`);
            }
        });

        // 监听边标签编辑事件（双击边）
        this.addTrackedListener(branchGraphDiv, 'edge-label-edit', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { edgeId, source, target, oldLabel, newLabel, edgeType, crossDomainLink, crossDomainSourceNodeId } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (!mocFile) return;

                if (edgeType === 'cross-domain' && crossDomainLink && crossDomainSourceNodeId) {
                    // 跨领域边:标签存进 cross_domain_links 的 relationLabel(非普通箭头关系)。
                    // 空标签回退默认"跨领域"(清空 relationLabel 字段)。
                    await this.saveCrossDomainRelationLabel(mocFile, crossDomainSourceNodeId, crossDomainLink, newLabel);
                } else {
                    await this.updateArrowRelationLabelInMOC(mocFile, source, target, newLabel);
                }
                // 刷新视图
                await this.refreshBranchMermaid();
            } catch (error) {
                console.error('Failed to update arrow relation label:', error);
                new Notice(`更新关系文本失败: ${error.message}`);
            }
        });

        // 监听边起点修改事件（修改父节点）
        this.addTrackedListener(branchGraphDiv, 'edge-source-changed', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { edgeType, oldSource, newSource, target, label } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (!mocFile) return;

                if (edgeType === 'parent') {
                    // 树边：移动子节点到新父节点
                    await this.saveAllNodePositionsBeforeRefresh();
                    const newChildID = this.generateChildNodeID(newSource);
                    await this.mocHandler.moveNodeToParent(mocFile, target, newSource, newChildID);
                    await this.refreshBranchMermaid();
                    new Notice(`已修改父节点: ${target} 从 ${oldSource} → ${newSource} (新ID: ${newChildID})`);
                } else {
                    // 箭头关系边：修改关系起点
                    await this.updateEdgeSourceInMOC(mocFile, oldSource, newSource, target, label);
                    await this.refreshBranchMermaid();
                    new Notice(`已修改边起点: ${oldSource} → ${newSource}`);
                }
            } catch (error) {
                console.error('Failed to update edge source:', error);
                new Notice(`修改边起点失败: ${error.message}`);
            }
        });

        // 监听边终点修改事件
        this.addTrackedListener(branchGraphDiv, 'edge-target-changed', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { edgeType, source, oldTarget, newTarget, label } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (!mocFile) return;

                if (edgeType === 'parent') {
                    // 树边：将 oldTarget 变为自由节点，newTarget 接替 oldTarget 成为父节点的子节点
                    await this.saveAllNodePositionsBeforeRefresh();
                    await this.mocHandler.redirectParentEdgeTarget(mocFile, oldTarget, newTarget);
                    await this.refreshBranchMermaid();
                    new Notice(`已修改边终点: ${oldTarget} → ${newTarget}`);
                } else {
                    // 箭头关系边
                    await this.updateEdgeTargetInMOC(mocFile, source, oldTarget, newTarget, label);
                    await this.refreshBranchMermaid();
                    new Notice(`已修改边终点: ${oldTarget} → ${newTarget}`);
                }
            } catch (error) {
                console.error('Failed to update edge target:', error);
                new Notice(`修改边终点失败: ${error.message}`);
            }
        });

        // 监听创建箭头关系事件（拖动连线到现有节点）
        this.addTrackedListener(branchGraphDiv, 'create-arrow-relation', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { sourceNode, targetNode, sourceId, targetId } = event.detail;

            const finalSourceId = sourceId || sourceNode?.IDStr;
            const finalTargetId = targetId || targetNode?.IDStr;

            if (!finalSourceId || !finalTargetId) {
                console.warn('Invalid nodes for arrow relation:', { sourceNode, targetNode, sourceId, targetId });
                return;
            }

            // 草稿节点(#20)参与连线:纯内存改父子,绝不写 MOC
            // (否则会把 draft-batch-* 这种临时 id 写进文件,还会触发刷新把草稿清空)
            if (this.draftNodes.has(finalSourceId) || this.draftNodes.has(finalTargetId)) {
                this.connectDraftRelation(finalSourceId, finalTargetId);
                return;
            }

            // 涉及自由节点时，只创建虚线关系，不做父子挂载
            const sourceIsFree = this.isFreeNodeID(finalSourceId);
            const targetIsFree = this.isFreeNodeID(finalTargetId);
            let relationText = '';

            // 在刷新前保存所有节点的当前位置
            await this.saveAllNodePositionsBeforeRefresh();

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    // 新规则：非自由节点第一次连线到自由节点时，
                    // 将自由节点直接挂载为其子节点（自由↔自由仍保持虚线关系）。
                    // 仅对真实 MOC 节点生效（分组节点不参与父子树）。
                    const sourceExistsInTree = this.mocNodes.some((n) => n.IDStr === finalSourceId || n.ID === finalSourceId);
                    if (!sourceIsFree && targetIsFree && sourceExistsInTree) {
                        const newChildID = this.generateChildNodeID(finalSourceId);
                        await this.mocHandler.moveNodeToParent(mocFile, finalTargetId, finalSourceId, newChildID);
                        await this.refreshBranchMermaid();
                        new Notice(`已将自由节点挂载为子节点: ${finalTargetId} → ${newChildID}`);
                        return;
                    }

                    await this.addArrowRelationToMOC(
                        mocFile,
                        finalSourceId,
                        finalTargetId,
                        relationText
                    );

                    // 刷新视图
                    await this.refreshBranchMermaid();

                    const relationType = (sourceIsFree || targetIsFree) ? '自由节点虚线关系' : '箭头关系';
                    new Notice(`已创建${relationType}: ${finalSourceId} → ${finalTargetId}`);
                }
            } catch (error) {
                console.error('Failed to create arrow relation:', error);
                new Notice(`创建箭头关系失败: ${error.message}`);
            }
        });

        // 监听创建子节点事件（拖动连线到空白处）- 改为创建占位符节点
        this.addTrackedListener(branchGraphDiv, 'create-child-node', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { parentNode, position } = event.detail;

            if (!parentNode) {
                console.warn('Invalid parent node for child creation:', parentNode);
                return;
            }

            // 直接创建占位符节点，而不是打开模态框
            await this.createPlaceholderNode(position, parentNode.IDStr);
        });

        // 监听创建子节点快捷键事件（Tab）
        this.addTrackedListener(branchGraphDiv, 'create-child-node-shortcut', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { activeNodeId, position } = event.detail;
            await this.createChildNodeFromActive(activeNodeId, position);
        });

        // 监听创建兄弟节点快捷键事件（Enter）
        this.addTrackedListener(branchGraphDiv, 'create-sibling-node-shortcut', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { activeNodeId, position } = event.detail;
            await this.createSiblingNodeFromActive(activeNodeId, position);
        });

        // 监听创建父节点快捷键事件（Shift+Tab）
        this.addTrackedListener(branchGraphDiv, 'create-parent-node-shortcut', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { activeNodeId, position } = event.detail;
            await this.createParentNodeFromActive(activeNodeId, position);
        });

        // 监听批量分组事件
        this.addTrackedListener(branchGraphDiv, 'batch-create-group', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeIds, groupName } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    await this.mocHandler.createGroupInMOC(mocFile, nodeIds, groupName);
                    await this.refreshBranchMermaid();
                    new Notice(`已创建分组 "${groupName}"，包含 ${nodeIds.length} 个节点`);
                } else {
                    console.error('MOC file not found:', this.plugin.settings.mocCurrentFile);
                }
            } catch (error) {
                console.error('Failed to create batch group:', error);
                new Notice(`批量分组失败: ${error.message}`);
            }
        });

        // 监听批量删除节点事件
        this.addTrackedListener(branchGraphDiv, 'batch-delete-nodes', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeIds, nodes } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    const batchNodes = nodeIds.map((nodeId: string, index: number): { nodeId: string; nodeData: any } => ({
                        nodeId,
                        nodeData: nodes[index]
                    }));
                    await this.flushAndSaveCurrentPositions();
                    // 删除前解析真实父级(自由节点父子关系只在边里,删除+刷新后丢失)
                    const reflowParentId = this.pickAutoLayoutParentForReflow(nodeIds);
                    // 删除前收集各节点内嵌附件(删除后内容已没)
                    const embeddedAttachments: TFile[] = [];
                    for (const n of nodes) {
                        if (n.originalNode) {
                            embeddedAttachments.push(...this.collectNodeEmbeddedAttachments(n.originalNode, mocFile.path));
                        }
                    }
                    await this.mocHandler.deleteNodesFromMOC(mocFile, batchNodes);

                    // 删除嵌入图片节点对应的图片文件
                    for (const n of nodes) {
                        if (n.originalNode) {
                            await this.deleteImageFileIfNeeded(n.originalNode);
                        }
                    }

                    // 文本节点内嵌附件:全库已无其它引用则一并回收
                    await this.deleteOrphanedAttachments(embeddedAttachments);

                    await this.refreshBranchMermaid();

                    // 声明式 reflow: 批量删除后整棵树重排
                    if (reflowParentId) {
                        await this.reflowAutoLayout(reflowParentId);
                    }

                    new Notice(t("Deleted nodes").replace("{count}", String(nodeIds.length)));
                }
            } catch (error) {
                console.error('Failed to batch delete nodes:', error);
                new Notice(t("Batch delete failed").replace("{message}", String(error.message)));
            }
        });

        // 监听批量显示颜色选择器事件
        this.addTrackedListener(branchGraphDiv, 'batch-show-color-picker', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeIds } = event.detail;
            await this.batchChangeNodeColor(nodeIds);
        });

        // 标记监听器已初始化，保存当前容器引用
        this.branchGraphListenersInitialized = true;
        this.currentBranchGraphDiv = branchGraphDiv;
        this.syncBranchFullscreenBackButtonVisibility();
        }

        this.plugin.indexViewOffsetWidth = this.containerEl.offsetWidth;
        this.plugin.indexViewOffsetHeight = this.containerEl.offsetHeight;
    }


    /**
     * 更新平行宇宙面包屑徽章
     */
    /**
     * 打开笔记搜索 Modal — 从反向索引中模糊搜索笔记，定位到所在 MOC
     */
    private openNoteSearchModal(): void {
        const reverseIndex = this.plugin.mocReverseIndex;
        if (!reverseIndex || !reverseIndex.isInitialized) {
            new Notice(t("Please configure MOC folder path in settings"));
            return;
        }

        new NoteSearchModal(this.app, reverseIndex, async (notePath, location) => {
            // 切换到选中的 MOC
            this.plugin.settings.mocCurrentFile = location.mocFilePath;
            this.plugin.settings.BranchTab = 0;
            await this.plugin.saveData(this.plugin.settings);
            this.renderedBranches.clear();
            await this.plugin.clearShowingSettings();

            // 更新 MOC 面包屑文本
            if (this.mocChipLabel) {
                let mocName = location.mocFileName;
                const maxLength = 12;
                if (mocName.length > maxLength) {
                    mocName = mocName.substring(0, maxLength) + "...";
                }
                this.mocChipLabel.setText(mocName);
            }

            // 标记渲染完成后需要定位的节点
            this.pendingSelectNodeId = location.nodeId;
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        }).open();
    }

    private updateMultiverseBadge(node: ZKNode | null): void {
        if (!this.multiverseContainer) return;

        // 清空容器
        this.multiverseContainer.empty();
        this.multiverseContainer.setCssStyles({ display: "none" });

        if (!node || !node.file) return;

        const reverseIndex = this.plugin.mocReverseIndex;
        if (!reverseIndex || !reverseIndex.isInitialized) return;

        const currentMOC = this.plugin.settings.mocCurrentFile;
        const otherMOCs = reverseIndex.query(node.file.path, currentMOC);

        if (otherMOCs.length === 0) return;

        // 显示容器
        this.multiverseContainer.setCssStyles({ display: "flex" });

        // 分隔符
        this.multiverseContainer.createSpan("zk-breadcrumb-sep").setText("\u203A");

        // 当前节点名称
        const nodeChip = this.multiverseContainer.createDiv("zk-chip zk-chip-outlined zk-multiverse-node");
        let nodeLabel = this.firstLineLabel(node.title || node.displayText || '') || node.IDStr;
        if (nodeLabel.length > 10) {
            nodeLabel = nodeLabel.substring(0, 10) + "...";
        }
        nodeChip.createSpan("zk-chip-label").setText(nodeLabel);

        // +N MOCs 徽章
        const badge = this.multiverseContainer.createDiv("zk-multiverse-badge");
        setIcon(badge.createSpan("zk-multiverse-badge-icon"), "layers");
        badge.createSpan("zk-multiverse-badge-text").setText(`+${otherMOCs.length} MOCs`);

        // 悬浮面板
        const panel = this.multiverseContainer.createDiv("zk-multiverse-panel");
        panel.setCssStyles({ display: "none" });

        const panelTitle = panel.createDiv("zk-multiverse-panel-title");
        panelTitle.setText(t("Note also exists in:"));

        for (const loc of otherMOCs) {
            const item = panel.createDiv("zk-multiverse-panel-item");
            setIcon(item.createSpan("zk-multiverse-panel-item-icon"), "book-open");
            item.createSpan("zk-multiverse-panel-item-text").setText(loc.mocFileName);

            item.addEventListener("click", async () => {
                // 切换到该 MOC
                this.plugin.settings.mocCurrentFile = loc.mocFilePath;
                this.plugin.settings.BranchTab = 0;
                await this.plugin.saveData(this.plugin.settings);
                this.renderedBranches.clear();
                await this.plugin.clearShowingSettings();

                // 更新 MOC 按钮文本
                if (this.mocChipLabel) {
                    let mocName = loc.mocFileName;
                    const maxLength = 12;
                    if (mocName.length > maxLength) {
                        mocName = mocName.substring(0, maxLength) + "...";
                    }
                    this.mocChipLabel.setText(mocName);
                }

                this.app.workspace.trigger("zk-navigation:refresh-index-graph");

                // 清除 multiverse 区域
                this.updateMultiverseBadge(null);
            });
        }

        // 点击徽章切换面板
        badge.addEventListener("click", (e) => {
            e.stopPropagation();
            panel.setCssStyles({ display: panel.style.display === "none" ? "block" : "none" });
        });

        // 点击其他区域关闭面板
        const closePanel = (e: MouseEvent) => {
            if (!panel.contains(e.target as Node) && !badge.contains(e.target as Node)) {
                panel.setCssStyles({ display: "none" });
                document.removeEventListener("click", closePanel);
            }
        };
        badge.addEventListener("click", () => {
            setTimeout(() => document.addEventListener("click", closePanel), 0);
        });
    }

    /**
     * 在 cy 中按 IDStr 找节点
     */
    private findCyNodeByIdStr(idStr: string): any | null {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return null;
        const matches = cy.nodes().filter((n: any) => {
            const original = n.data('originalNode') as ZKNode | undefined;
            return original?.IDStr === idStr;
        });
        return matches.length > 0 ? matches[0] : null;
    }

    /**
     * 收集所有 level-1 根节点(过滤跨域/占位/free)
     */
    private getLevelRoots(): ZKNode[] {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return [];
        const roots: ZKNode[] = [];
        cy.nodes().forEach((n: any) => {
            const original = n.data('originalNode') as ZKNode | undefined;
            if (!original) return;
            if (original.isCrossDomain || original.isPlaceholder || original.isDraft) return;
            if ((original.IDStr || '').startsWith('free.')) return;
            if (original.IDArr?.length === 1) roots.push(original);
        });
        // 按 IDStr 排序,保持稳定顺序
        roots.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
        return roots;
    }

    /**
     * 收集某个父节点的直接子节点(基于 cy 当前可见节点)
     */
    private getCyDirectChildren(parentIdStr: string): ZKNode[] {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return [];
        const parent = this.findCyNodeByIdStr(parentIdStr);
        if (!parent) return [];
        const parentDepth = (parent.data('originalNode') as ZKNode).IDArr.length;
        const children: ZKNode[] = [];
        const prefix = parentIdStr + '.';
        cy.nodes().forEach((n: any) => {
            const original = n.data('originalNode') as ZKNode | undefined;
            if (!original) return;
            if (original.isCrossDomain || original.isPlaceholder || original.isDraft) return;
            if (original.IDArr?.length === parentDepth + 1
                && (original.IDStr || '').startsWith(prefix)) {
                children.push(original);
            }
        });
        children.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
        return children;
    }

    /**
     * 给定 IDStr 取展示标签:优先 title,否则 ID 末段
     */
    private getNodeLabelByIdStr(idStr: string): string {
        const cyNode = this.findCyNodeByIdStr(idStr);
        if (cyNode) {
            const original = cyNode.data('originalNode') as ZKNode;
            const text = original.title || original.displayText || '';
            if (text.trim()) return text.trim();
        }
        return idStr.split('.').pop() || idStr;
    }

    /**
     * 面包屑只展示第一行:兼容真实换行与文本节点标题里的字面量 \n,
     * 按换行切分取首段并 trim,避免多行文本把面包屑撑高(issue #49)。
     */
    private firstLineLabel(s: string): string {
        return String(s ?? '').replace(/\\n/g, '\n').split('\n')[0].trim();
    }

    private truncateLabel(s: string, max: number): string {
        const first = this.firstLineLabel(s);
        return first.length > max ? first.substring(0, max) + '…' : first;
    }

    /**
     * 由用户在画布上选中节点 → 同步面包屑路径到该节点
     */
    private syncLevelBreadcrumbWithNode(node: ZKNode | null): void {
        if (!node || !node.IDArr || node.IDArr.length === 0) {
            this.refreshLevelBreadcrumb();
            return;
        }
        if (node.isCrossDomain || node.isPlaceholder || node.isDraft) return;
        if ((node.IDStr || '').startsWith('free.')) return;
        this.levelPath = [...node.IDArr];
        // 校验暗淡级别是否仍有效
        if (this.currentDimLevel !== null && this.currentDimLevel > this.levelPath.length) {
            this.clearLevelDim();
        } else if (this.currentDimLevel !== null) {
            this.applyLevelDim(this.currentDimLevel, this.levelPath[this.currentDimLevel - 1]);
        }
        this.refreshLevelBreadcrumb();
    }

    /**
     * 单击选中 → 详情侧栏跟随。
     * 详情侧栏现在是「备注专属」面板,多数节点无备注,故单击节点默认【不】自动展开,
     * 主入口改为点击节点右上角 R 角标(见 node-detail-toggle)。
     * - 面板已展开/钉住:跟随选中刷新内容(开着就当 inspector 用)
     * - detailPanelAutoOpen=true(默认 false):退回老行为,任意选中即展开
     */
    private handleDetailPanelSelect(node: ZKNode | null): void {
        if (!this.detailPanel) return;
        if (!node || node.isPlaceholder || node.isDraft) {
            this.detailPanelLastId = null;
            this.detailPanel.hide();
            return;
        }
        this.detailPanel.setSide(this.plugin.settings.detailPanelSide === 'left' ? 'left' : 'right');
        const auto = this.plugin.settings.detailPanelAutoOpen === true;
        this.detailPanelLastId = node.IDStr;
        if (auto || this.detailPanel.isOpen || this.detailPanel.isPinned) {
            void this.detailPanel.show(node);
        }
    }

    /** 面包屑点击某一级 → 选中并居中该节点,同时刷新侧栏 */
    private selectAndShowDetailByIdStr(idStr: string): void {
        const cyNode = this.findCyNodeByIdStr(idStr);
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cyNode || !cy) return;
        cy.nodes(':selected').unselect();
        cyNode.select();
        cy.animate({ center: { eles: cyNode }, duration: 250 });
        const original = cyNode.data('originalNode') as ZKNode | undefined;
        if (original) {
            this.updateMultiverseBadge(original);
            this.syncLevelBreadcrumbWithNode(original);
            this.detailPanelLastId = original.IDStr;
            void this.detailPanel?.show(original);
        }
    }

    /**
     * 从 levelPath 末端继续向下钻,每层取第一个子节点,直到没有子节点
     */
    private extendLevelPathToDeepest(): void {
        if (this.levelPath.length === 0) return;
        let current = this.levelPath[this.levelPath.length - 1];
        for (let i = 0; i < 100; i++) {
            const children = this.getCyDirectChildren(current);
            if (children.length === 0) break;
            const firstChild = children[0];
            this.levelPath.push(firstChild.IDStr);
            current = firstChild.IDStr;
        }
    }

    /**
     * 图渲染完成后调用:校验当前 levelPath,失效则重置;首次进入自动钻到最深
     */
    private initLevelBreadcrumbForCurrentGraph(): void {
        const roots = this.getLevelRoots();
        if (roots.length === 0) {
            this.levelPath = [];
            this.clearLevelDim();
            this.refreshLevelBreadcrumb();
            return;
        }
        const needsReset = this.levelPath.length === 0 || !roots.some(r => r.IDStr === this.levelPath[0]);
        if (needsReset) {
            this.levelPath = [roots[0].IDStr];
            // 首次/重置:自动钻到当前分支最深叶子
            this.extendLevelPathToDeepest();
        } else {
            // 校验下游路径每一段都还存在
            for (let i = 1; i < this.levelPath.length; i++) {
                const children = this.getCyDirectChildren(this.levelPath[i - 1]);
                if (!children.some(c => c.IDStr === this.levelPath[i])) {
                    this.levelPath = this.levelPath.slice(0, i);
                    break;
                }
            }
        }
        if (this.currentDimLevel !== null && this.currentDimLevel > this.levelPath.length) {
            this.clearLevelDim();
        }
        this.refreshLevelBreadcrumb();
    }


    /**
     * 基于当前 levelPath 重新渲染面包屑 DOM
     */
    private refreshLevelBreadcrumb(): void {
        if (!this.levelBreadcrumbContainer) return;
        this.levelBreadcrumbContainer.empty();

        if (this.levelPath.length === 0) {
            this.levelBreadcrumbContainer.setCssStyles({ display: "none" });
            return;
        }

        this.levelBreadcrumbContainer.setCssStyles({ display: "flex" });
        this.levelBreadcrumbContainer.createSpan("zk-level-divider");

        for (let i = 0; i < this.levelPath.length; i++) {
            const segmentDepth = i + 1;
            const idStr = this.levelPath[i];
            const rawLabel = this.getNodeLabelByIdStr(idStr);
            const label = this.truncateLabel(rawLabel, 10);

            const siblings = i === 0
                ? this.getLevelRoots()
                : this.getCyDirectChildren(this.levelPath[i - 1]);
            const hasMultiple = siblings.length > 1;

            const segWrap = this.levelBreadcrumbContainer.createSpan("zk-level-seg-wrap");
            const seg = segWrap.createSpan("zk-level-seg");
            seg.setText(label);
            seg.setAttribute(
                "title",
                t("Level breadcrumb segment tooltip")
                    .replace("{level}", String(segmentDepth))
                    .replace("{id}", idStr)
                    .replace("{visibility}", this.focusVisibilityMode === 'hide' ? t("hidden") : t("dimmed"))
            );

            if (this.currentDimLevel === segmentDepth) seg.addClass("zk-level-seg-active");

            seg.addEventListener("click", (e) => {
                e.stopPropagation();
                if (this.currentDimLevel === segmentDepth) {
                    this.clearLevelDim();
                } else {
                    this.applyLevelDim(segmentDepth, idStr);
                }
                this.refreshLevelBreadcrumb();
            });

            if (hasMultiple) {
                // 兄弟切换图标用 chevrons-up-down (↕),与工具栏 chevron-down (▾) 视图切换语义区分
                const chevron = segWrap.createSpan("zk-level-chevron zk-level-sib");
                setIcon(chevron, "chevrons-up-down");
                chevron.setAttribute("title", t("Switch sibling nodes").replace("{count}", String(siblings.length)));
                chevron.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.showSiblingDropdown(segWrap, siblings, i, false);
                });
            }

            if (i < this.levelPath.length - 1) {
                this.levelBreadcrumbContainer.createSpan("zk-level-sep").setText("\u203A");
            }
        }

        // 末端「下钻」按钮:若当前最深节点还有子节点,允许选一个继续往下
        const deepestId = this.levelPath[this.levelPath.length - 1];
        const childrenOfDeepest = this.getCyDirectChildren(deepestId);
        if (childrenOfDeepest.length > 0) {
            this.levelBreadcrumbContainer.createSpan("zk-level-sep").setText("\u203A");
            const drillBtn = this.levelBreadcrumbContainer.createSpan("zk-level-drill");
            drillBtn.setText("+");
            drillBtn.setAttribute("title", t("Drill down to next level").replace("{count}", String(childrenOfDeepest.length)));
            drillBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.showSiblingDropdown(drillBtn, childrenOfDeepest, this.levelPath.length, true);
            });

            // 一键钻到最深
            const drillAllBtn = this.levelBreadcrumbContainer.createSpan("zk-level-drill-all");
            drillAllBtn.setText("\u00BB");
            drillAllBtn.setAttribute("title", t("Expand to deepest level in current branch"));
            drillAllBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.extendLevelPathToDeepest();
                this.refreshLevelBreadcrumb();
            });
        }

        // 模式切换按钮(始终显示):子树聚焦 ↔ 同层切片
        const modeBtn = this.levelBreadcrumbContainer.createSpan("zk-level-mode-toggle");
        const modeIconWrap = modeBtn.createSpan("zk-level-mode-icon");
        setIcon(modeIconWrap, this.dimMode === 'subtree' ? 'git-branch' : 'layers');
        modeBtn.setAttribute("title",
            this.dimMode === 'subtree'
                ? t("Current mode subtree focus")
                : t("Current mode level slice")
        );
        modeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.dimMode = this.dimMode === 'subtree' ? 'level' : 'subtree';
            if (this.currentDimLevel !== null && this.currentDimLevel <= this.levelPath.length) {
                this.applyLevelDim(this.currentDimLevel, this.levelPath[this.currentDimLevel - 1]);
            }
            this.refreshLevelBreadcrumb();
        });

        // 可见性切换:隐藏无关分支 ↔ 弱化无关分支
        const visibilityBtn = this.levelBreadcrumbContainer.createSpan("zk-level-visibility-toggle");
        const visibilityIconWrap = visibilityBtn.createSpan("zk-level-mode-icon");
        setIcon(visibilityIconWrap, this.focusVisibilityMode === 'hide' ? 'eye-off' : 'eye');
        visibilityBtn.setAttribute(
            "title",
            this.focusVisibilityMode === 'hide'
                ? t("Current visibility hide")
                : t("Current visibility dim")
        );
        visibilityBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.focusVisibilityMode = this.focusVisibilityMode === 'hide' ? 'dim' : 'hide';
            if (this.currentDimLevel !== null && this.currentDimLevel <= this.levelPath.length) {
                this.applyLevelDim(this.currentDimLevel, this.levelPath[this.currentDimLevel - 1]);
            }
            this.refreshLevelBreadcrumb();
        });

        if (this.currentDimLevel !== null) {
            const resetBtn = this.levelBreadcrumbContainer.createSpan("zk-level-reset");
            resetBtn.setText("\u2715");
            resetBtn.setAttribute("title", t("Clear level filter"));
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.clearLevelDim();
                this.refreshLevelBreadcrumb();
            });
        }
    }

    /**
     * 弹出兄弟节点选择面板
     */
    private showSiblingDropdown(
        anchor: HTMLElement,
        options: ZKNode[],
        levelIndex: number,
        isExtension: boolean
    ): void {
        document.querySelectorAll('.zk-level-dropdown').forEach(el => el.remove());

        const dropdown = document.body.createDiv('zk-level-dropdown');
        const rect = anchor.getBoundingClientRect();
        dropdown.setCssStyles({
            position: 'fixed',
            top: `${rect.bottom + 4}px`,
            left: `${rect.left}px`,
            zIndex: '10000',
        });

        for (const node of options) {
            const item = dropdown.createDiv('zk-level-dropdown-item');
            const rawLabel = node.title || node.displayText || (node.IDStr.split('.').pop() || node.IDStr);
            const label = this.truncateLabel(rawLabel, 24);
            item.setText(label);
            item.setAttribute('title', node.IDStr);
            if (!isExtension && this.levelPath[levelIndex] === node.IDStr) {
                item.addClass('zk-level-dropdown-item-active');
            }
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.levelPath = this.levelPath.slice(0, levelIndex);
                this.levelPath.push(node.IDStr);
                dropdown.remove();
                if (this.currentDimLevel !== null && this.currentDimLevel > this.levelPath.length) {
                    this.clearLevelDim();
                } else if (this.currentDimLevel !== null) {
                    this.applyLevelDim(this.currentDimLevel, this.levelPath[this.currentDimLevel - 1]);
                }
                this.refreshLevelBreadcrumb();
            });
        }

        const closeHandler = (ev: MouseEvent) => {
            if (!dropdown.contains(ev.target as Node)) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    private applyLevelDim(level: number, ancestorId: string): void {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return;

        this.currentDimLevel = level;
        const visibleCyIds = new Set<string>();

        if (this.dimMode === 'subtree') {
            const focusPrefix = ancestorId + '.';
            const ancestorIds = new Set<string>();
            const parts = ancestorId.split('.');
            for (let i = 1; i <= parts.length; i++) {
                ancestorIds.add(parts.slice(0, i).join('.'));
            }
            const isVisible = (idStr: string) =>
                ancestorIds.has(idStr) || idStr.startsWith(focusPrefix);

            // 先计算哪些非组节点可见,再处理 compound 父子关系
            cy.nodes().forEach((n: any) => {
                if (n.data('isGroup')) return;
                const id = (n.data('originalNode') as ZKNode | undefined)?.IDStr || '';
                if (isVisible(id)) visibleCyIds.add(n.id());
            });

            cy.batch(() => {
                cy.nodes().removeClass('zk-level-dimmed');
                cy.edges().removeClass('zk-level-dimmed');

                // 先处理组节点(compound parent),确保父节点状态正确
                cy.nodes('.group-node').forEach((groupNode: any) => {
                    const memberIds: string[] = groupNode.data('nodeIds') || [];
                    const escapedMemberIds = memberIds.map((id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_'));
                    const hasVisibleMember = escapedMemberIds.some((id: string) => visibleCyIds.has(id));
                    if (this.focusVisibilityMode === 'dim') {
                        groupNode.show();
                        if (!hasVisibleMember) groupNode.addClass('zk-level-dimmed');
                    } else if (hasVisibleMember) {
                        groupNode.show();
                    } else {
                        groupNode.hide();
                    }
                });
                // 再处理普通节点(compound children 在父节点 show 后才能正确显示)
                cy.nodes().forEach((n: any) => {
                    if (n.data('isGroup')) return;
                    if (visibleCyIds.has(n.id())) {
                        n.show();
                    } else if (this.focusVisibilityMode === 'dim') {
                        n.show();
                        n.addClass('zk-level-dimmed');
                    } else {
                        n.hide();
                    }
                });
                cy.edges().forEach((e: any) => {
                    const srcId = (e.source().data('originalNode') as ZKNode | undefined)?.IDStr || '';
                    const tgtId = (e.target().data('originalNode') as ZKNode | undefined)?.IDStr || '';
                    if (isVisible(srcId) && isVisible(tgtId)) {
                        e.show();
                    } else if (this.focusVisibilityMode === 'dim') {
                        e.show();
                        e.addClass('zk-level-dimmed');
                    } else {
                        e.hide();
                    }
                });
            });
        } else {
            cy.nodes().forEach((n: any) => {
                if (n.data('isGroup')) return;
                const depth = (n.data('originalNode') as ZKNode | undefined)?.IDArr?.length ?? 1;
                if (depth <= level) visibleCyIds.add(n.id());
            });

            cy.batch(() => {
                cy.nodes().removeClass('zk-level-dimmed');
                cy.edges().removeClass('zk-level-dimmed');

                cy.nodes('.group-node').forEach((groupNode: any) => {
                    const memberIds: string[] = groupNode.data('nodeIds') || [];
                    const escapedMemberIds = memberIds.map((id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_'));
                    const hasVisibleMember = escapedMemberIds.some((id: string) => visibleCyIds.has(id));
                    if (this.focusVisibilityMode === 'dim') {
                        groupNode.show();
                        if (!hasVisibleMember) groupNode.addClass('zk-level-dimmed');
                    } else if (hasVisibleMember) {
                        groupNode.show();
                    } else {
                        groupNode.hide();
                    }
                });
                cy.nodes().forEach((n: any) => {
                    if (n.data('isGroup')) return;
                    if (visibleCyIds.has(n.id())) {
                        n.show();
                    } else if (this.focusVisibilityMode === 'dim') {
                        n.show();
                        n.addClass('zk-level-dimmed');
                    } else {
                        n.hide();
                    }
                });
                cy.edges().forEach((e: any) => {
                    const srcDepth = (e.source().data('originalNode') as ZKNode | undefined)?.IDArr?.length ?? 1;
                    const tgtDepth = (e.target().data('originalNode') as ZKNode | undefined)?.IDArr?.length ?? 1;
                    const isEdgeVisible = srcDepth <= level && tgtDepth <= level;
                    if (isEdgeVisible) {
                        e.show();
                    } else if (this.focusVisibilityMode === 'dim') {
                        e.show();
                        e.addClass('zk-level-dimmed');
                    } else {
                        e.hide();
                    }
                });
            });
        }

        // 同步 DOM overlay(embed 卡片)的透明度
        this.applyDimToOverlays(visibleCyIds, this.focusVisibilityMode);

        const ancestor = cy.nodes().filter((n: any) => {
            const original = n.data('originalNode') as ZKNode | undefined;
            return original?.IDStr === ancestorId;
        });
        if (ancestor.length > 0) {
            cy.animate({ center: { eles: ancestor }, duration: 250 });
        }
    }

    private applyDimToOverlays(visibleCyIds: Set<string> | null, visibilityMode: 'hide' | 'dim' = 'hide'): void {
        this.branchRenderer?.applyFocusOverlayState(visibleCyIds, visibilityMode);
    }

    private clearLevelDim(): void {
        if (this.currentDimLevel === null) return;
        this.currentDimLevel = null;
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return;
        cy.batch(() => {
            cy.nodes().removeClass('zk-level-dimmed');
            cy.edges().removeClass('zk-level-dimmed');
            (cy.nodes() as any).show();
            (cy.edges() as any).show();
        });
        this.applyDimToOverlays(null);
    }

    // MOC 文件选择器
    openMOCSelectorModal() {
        const mocFolder = this.plugin.settings.mocFolderPath;
        if (!mocFolder) {
            new Notice(t("Please configure MOC folder path in settings"));
            return;
        }

        const mocFiles = getMOCFilesInFolder(this.app, mocFolder);

        if (mocFiles.length === 0) {
            new Notice(t("No MOC files found in the specified folder"));
            return;
        }

        // 使用 MOCSelectorModal 创建搜索界面
        new MOCSelectorModal(this.app, mocFiles, this.plugin.workspaceStore, async (item) => {
            if (item.file) {
                this.plugin.settings.mocCurrentFile = item.file.path;
                this.plugin.settings.BranchTab = 0;
                await this.plugin.saveData(this.plugin.settings);
                this.renderedBranches.clear();
                await this.plugin.clearShowingSettings();

                // 更新 MOC 按钮显示文本
                if (this.mocChipLabel) {
                    let mocName = item.file.basename;
                    const maxLength = 12;
                    if (mocName.length > maxLength) {
                        mocName = mocName.substring(0, maxLength) + "...";
                    }
                    this.mocChipLabel.setText(mocName);
                }

                this.app.workspace.trigger("zk-navigation:refresh-index-graph");
            }
        }).open();
    }

    openMOCSelector(targetElement?: HTMLElement) {
        const mocFolder = this.plugin.settings.mocFolderPath;
        if (!mocFolder) {
            new Notice(t("Please configure MOC folder path in settings"));
            return;
        }

        const mocFiles = getMOCFilesInFolder(this.app, mocFolder);

        if (mocFiles.length === 0) {
            new Notice(t("No MOC files found in the specified folder"));
            return;
        }

        // 创建一个简单的选择菜单
        const menu = new Menu();

        // 添加所有 MOC 文件
        for (const file of mocFiles) {
            menu.addItem((item) => {
                item.setTitle(file.basename)
                    .setIcon("file-text")
                    .onClick(async () => {
                        this.plugin.settings.mocCurrentFile = file.path;
                        this.plugin.settings.BranchTab = 0;
                        this.renderedBranches.clear();
                        await this.plugin.clearShowingSettings();
                        this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                    });
            });
        }

        // 在 MOC 选择器位置显示菜单
        if (targetElement) {
            const rect = targetElement.getBoundingClientRect();
            menu.showAtPosition({ x: rect.left, y: rect.bottom + 8 });
        } else {
            // 备用方案：尝试查找元素
            const mocSelectorBlock = document.querySelector('.zk-moc-selector-block');
            if (mocSelectorBlock) {
                const rect = mocSelectorBlock.getBoundingClientRect();
                menu.showAtPosition({ x: rect.left, y: rect.bottom + 8 });
            } else {
                menu.showAtMouseEvent(new MouseEvent('click'));
            }
        }
    }

    // ========== 自由节点功能 ==========

    /**
     * 生成下一个可用的自由节点 ID
     * 如果没有任何节点，返回 "1" 作为初始节点 ID
     * 如果有节点，返回 "free.X" 格式的 ID
     */
    generateNextFreeNodeID(): string {
        // 如果没有任何节点，返回初始节点 ID
        if (this.mocNodes.length === 0) {
            return '1';
        }
        
        // 查找所有 free.* 节点
        const freeNodes = this.mocNodes.filter(n => n.ID.startsWith('free.'));
        
        if (freeNodes.length === 0) {
            return 'free.1';
        }
        
        // 找到最大的数字
        const maxNum = Math.max(...freeNodes.map(n => {
            const match = n.ID.match(/free\.(\d+)/);
            return match ? parseInt(match[1]) : 0;
        }));
        
        return `free.${maxNum + 1}`;
    }

    /**
     * 向右键菜单添加一个可点击项：图标 + 文本 + 点击回调
     * 点击后自动关闭菜单并解绑 closeMenu 监听器
     */
    private addContextMenuItem(
        parent: HTMLElement,
        menu: HTMLElement,
        closeMenu: (e: MouseEvent) => void,
        icon: string,
        label: string,
        action: () => Promise<void>
    ) {
        const opt = parent.createDiv('zk-node-ctx-item');
        const iconEl = opt.createSpan();
        setIcon(iconEl, icon);
        opt.createSpan({ text: label });
        opt.addEventListener('click', async (e) => {
            e.stopPropagation();
            menu.remove();
            document.removeEventListener('click', closeMenu);
            await action();
        });
    }

    /**
     * 显示节点右键菜单
     */
    showNodeContextMenu(mouseEvent: MouseEvent, node: ZKNode) {
        const existing = document.querySelector('.zk-node-context-menu');
        if (existing) existing.remove();

        const menu = document.body.createDiv('zk-node-ctx-menu zk-node-context-menu');
        menu.setCssStyles({
            position: 'fixed',
            zIndex: '10000',
        });

        const isAnchor = !!(this.nodeAnchors[node.IDStr] || this.nodeAnchors[node.ID]);
        const nodeId = node.IDStr || node.ID;

        const closeMenu = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };

        // 置顶锚点（全宽）
        this.addContextMenuItem(
            menu, menu, closeMenu,
            isAnchor ? 'star-off' : 'star',
            isAnchor ? t('ctx unpin anchor') : t('ctx pin anchor'),
            () => this.toggleNodeAnchor(node)
        );
        // 关联跨领域节点（全宽）
        this.addContextMenuItem(menu, menu, closeMenu, 'share-2', t('ctx link cross domain'), () => this.linkCrossDomainNode(node));

        const cyNode = this.branchRenderer?.getCytoscapeInstance()?.$id(nodeId);
        const hasManualTextSize = !!node.isTextOnly && !!cyNode?.length && (
            Number(cyNode.data('manualWidthModel') || 0) > 0 ||
            Number(cyNode.data('manualHeightModel') || 0) > 0
        );
        if (hasManualTextSize) {
            this.addContextMenuItem(
                menu, menu, closeMenu,
                'scan',
                '恢复自动尺寸',
                () => this.resetTextNodeAutoSize(node)
            );
        }

        // 分隔线
        menu.createDiv('zk-node-ctx-sep');

        // 暂存区:复制 / 剪切到工作区(跨领域虚拟节点不可用)
        if (!node.isCrossDomain && !node.isPlaceholder) {
            const scratchRow = menu.createDiv('zk-node-ctx-row');
            this.addContextMenuItem(scratchRow, menu, closeMenu, 'copy', t('ctx copy to scratch'), async () => {
                this.copySelectionToScratchpad('copy', node);
            });
            this.addContextMenuItem(scratchRow, menu, closeMenu, 'scissors', t('ctx cut to scratch'), async () => {
                this.copySelectionToScratchpad('cut', node);
            });
            menu.createDiv('zk-node-ctx-sep');
        }

        // 底部两列：修改节点 ID + 修改节点颜色
        const row = menu.createDiv('zk-node-ctx-row');
        this.addContextMenuItem(row, menu, closeMenu, 'fingerprint', t('ctx rename id'), () => this.renameNodeID(node));
        this.addContextMenuItem(row, menu, closeMenu, 'palette', t('ctx change color'), () => this.changeNodeColor(node));

        // 节点布局风格
        menu.createDiv('zk-node-ctx-sep');
        const effectiveLayout = this.getEffectiveNodeLayoutStyle(nodeId);
        const layoutLabel = menu.createDiv('zk-node-ctx-label');
        layoutLabel.textContent = t('ctx node layout');
        const layoutRow = menu.createDiv('zk-node-ctx-row');
        // 根节点有子节点时不允许切换布局风格（会破坏已布局子树）
        const isRootWithChildren = !!node.isRoot && this.getChildNodeIds(nodeId).length > 0;
        const autoItem = layoutRow.createDiv('zk-node-ctx-item');
        const autoIcon = autoItem.createSpan();
        setIcon(autoIcon, 'git-fork');
        autoItem.createSpan({ text: (effectiveLayout === 'auto' ? '✓ ' : '') + t('ctx layout auto') });
        if (isRootWithChildren) {
            autoItem.addClass('zk-node-ctx-disabled');
            setTooltip(autoItem, t('ctx layout root locked'));
        } else {
            autoItem.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.remove();
                document.removeEventListener('click', closeMenu);
                await this.setNodeLayoutStyle(node, 'auto');
            });
        }
        const freeItem = layoutRow.createDiv('zk-node-ctx-item');
        const freeIcon = freeItem.createSpan();
        setIcon(freeIcon, 'move');
        freeItem.createSpan({ text: (effectiveLayout === 'free' ? '✓ ' : '') + t('ctx layout free') });
        if (isRootWithChildren) {
            freeItem.addClass('zk-node-ctx-disabled');
            setTooltip(freeItem, t('ctx layout root locked'));
        } else {
            freeItem.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.remove();
                document.removeEventListener('click', closeMenu);
                await this.setNodeLayoutStyle(node, 'free');
            });
        }

        if (this.isFirstLevelMocChildNode(nodeId) && this.isNodeAutoLayout(nodeId)) {
            menu.createDiv('zk-node-ctx-sep');
            const presetLabel = menu.createDiv('zk-node-ctx-label');
            presetLabel.textContent = t("Branch layout");
            const presetRow = menu.createDiv('zk-node-ctx-row');
            const effectivePreset = this.currentNodeLayoutPresets[nodeId] || this.currentLayoutPreset;
            const addPresetItem = (preset: LayoutPreset, icon: string, label: string) => {
                const item = presetRow.createDiv('zk-node-ctx-item');
                const itemIcon = item.createSpan();
                setIcon(itemIcon, icon);
                const selected = effectivePreset === preset;
                item.createSpan({ text: (selected ? '✓ ' : '') + label });
                item.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                    await this.setBranchLayoutPreset(nodeId, preset);
                });
            };
            addPresetItem('bidirectional', 'columns-2', t("Bidirectional"));
            addPresetItem('top-down', 'rows-2', t("Top down"));
            addPresetItem('radial', 'sparkles', t("Radial"));
        }

        // 定位：先在屏幕外渲染以获取尺寸
        menu.setCssStyles({
            visibility: 'hidden',
            left: '0',
            top: '0',
        });

        this.positionContextMenu(menu, mouseEvent);
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    /**
     * 显示分组右键菜单（仅保留分组相关操作）
     */
    private showGroupContextMenu(mouseEvent: MouseEvent, groupId: string, groupLabel: string) {
        const existing = document.querySelector('.zk-node-context-menu');
        if (existing) existing.remove();

        const menu = document.body.createDiv('zk-node-ctx-menu zk-node-context-menu');
        menu.setCssStyles({
            position: 'fixed',
            zIndex: '10000',
        });

        const closeMenu = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };

        this.addContextMenuItem(menu, menu, closeMenu, 'trash', t('ctx delete group'), async () => {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (!mocFile) return;
            await this.deleteGroupFromMOC(mocFile, groupId);
            await this.refreshBranchMermaid();
        });

        this.addContextMenuItem(menu, menu, closeMenu, 'pencil', t('ctx rename group'), async () => {
            const newLabel = await this.showGroupLabelInputDialog(groupLabel);
            if (!newLabel || newLabel === groupLabel) return;
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (!mocFile) return;
            await this.renameGroupInMOC(mocFile, groupId, newLabel);
            await this.refreshBranchMermaid();
        });

        this.addContextMenuItem(menu, menu, closeMenu, 'fingerprint', t('ctx rename id'), async () => {
            const newGroupId = await this.showGroupIDInputDialog(groupId);
            if (!newGroupId || newGroupId === groupId) return;
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (!mocFile) return;
            await this.renameGroupIDInMOC(mocFile, groupId, newGroupId);
            await this.refreshBranchMermaid();
        });

        this.positionContextMenu(menu, mouseEvent);
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    /**
     * 在鼠标位置附近定位右键菜单，并保证不溢出视口
     */
    private positionContextMenu(menu: HTMLElement, mouseEvent: MouseEvent) {
        menu.setCssStyles({
            visibility: 'hidden',
            left: '0',
            top: '0',
        });
        requestAnimationFrame(() => {
            const mw = menu.offsetWidth;
            const mh = menu.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            let x = mouseEvent.clientX;
            let y = mouseEvent.clientY;
            if (x + mw > vw) x = vw - mw - 4;
            if (y + mh > vh) y = vh - mh - 4;
            menu.setCssStyles({
                left: `${x}px`,
                top: `${y}px`,
                visibility: 'visible',
            });
        });
    }

    /**
     * 显示添加节点菜单
     */
    showAddNodeMenu(btnRect: DOMRect, node: ZKNode, container: HTMLElement) {
        // 移除已存在的菜单
        const existingMenu = document.querySelector('.zk-add-node-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        // 创建菜单容器
        const menu = document.body.createDiv('zk-add-node-menu');
        menu.setCssStyles({ position: 'fixed' });
        // 菜单显示在按钮右侧
        menu.setCssStyles({
            left: `${btnRect.right + 10}px`,
            top: `${btnRect.top - 20}px`,
            zIndex: '10000',
        });

        // 正向连接选项
        const forwardOption = menu.createDiv('zk-menu-option');
        forwardOption.textContent = t('add node forward');
        forwardOption.addEventListener('click', async (e) => {
            e.stopPropagation();
            menu.remove();
            await this.addChildNodeToMOC(node);
        });

        // 反向连接选项
        const reverseOption = menu.createDiv('zk-menu-option');
        reverseOption.textContent = t('add node reverse');
        reverseOption.addEventListener('click', async (e) => {
            e.stopPropagation();
            menu.remove();
            await this.addReverseNodeToMOC(node);
        });

        // 点击其他地方关闭菜单
        const closeMenu = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    /**
     * 修改节点颜色
     */
    /**
     * 关联跨领域节点
     */
    async linkCrossDomainNode(sourceNode: ZKNode) {
        try {
            const currentMOCPath = this.plugin.settings.mocCurrentFile;

            // 获取所有 MOC 文件（.md 和 .moc 均包含）
            const mocFolder = this.plugin.settings.mocFolderPath;
            const mocFiles = getMOCFilesInFolder(this.app, mocFolder);

            if (mocFiles.length === 0) {
                new Notice('没有找到其他 MOC 文件');
                return;
            }

            // 第一步：选择目标 MOC 文件
            const { CrossDomainMOCModal } = await import('src/modal/crossDomainNodeModal');
            const mocFile = await new Promise<TFile>((resolve) => {
                new CrossDomainMOCModal(
                    this.app,
                    mocFiles,
                    sourceNode,
                    currentMOCPath,
                    (selectedFile) => resolve(selectedFile)
                ).open();
            });

            if (!mocFile) {
                return; // 用户取消
            }

            // 解析目标 MOC 文件获取节点列表
            const { parseMOCStructure } = await import('src/utils/utils');
            const targetMOCData = await parseMOCStructure(
                this.app,
                mocFile.path,
                this.plugin.settings.mocHeadingTitle
            );

            if (targetMOCData.nodes.length === 0) {
                new Notice(`MOC 文件 "${mocFile.basename}" 中没有节点`);
                return;
            }

            // 第二步：选择目标节点（可能包含多个）
            const { CrossDomainNodeModal } = await import('src/modal/crossDomainNodeModal');
            const targetNodes = await new Promise<any[]>((resolve) => {
                new CrossDomainNodeModal(
                    this.app,
                    targetMOCData.nodes,
                    sourceNode,
                    currentMOCPath,
                    mocFile,
                    (srcNode, srcPath, tgtNodes, tgtFile) => resolve(tgtNodes)
                ).open();
            });

            if (!targetNodes || targetNodes.length === 0) {
                return; // 用户取消
            }

            // 保存跨领域关联数据到双方的 ext JSON（支持多个节点）
            await this.saveCrossDomainLinks(sourceNode, currentMOCPath, targetNodes, mocFile.path);

            // 刷新视图
            await this.refreshBranchMermaid();

            const sourceId = (sourceNode as any).nodeID || sourceNode.IDStr;
            const targetIds = targetNodes.map(n => (n as any).nodeID || (n as any).IDStr).join(', ');
            new Notice(`已关联跨领域节点: ${sourceId} ↔ ${targetIds} (${targetNodes.length} 个节点)`);
        } catch (error) {
            console.error('Failed to link cross-domain node:', error);
            new Notice(`关联跨领域节点失败: ${error.message}`);
        }
    }

    /**
     * 保存跨领域关联到双方 MOC 文件的 ext 数据
     */
    private async saveCrossDomainLink(
        sourceNode: any,
        sourceMOCPath: string,
        targetNode: any,
        targetMOCPath: string
    ): Promise<void> {
        // 获取节点 ID（兼容不同类型）
        const sourceNodeId = sourceNode.IDStr || sourceNode.nodeID;
        const targetNodeId = targetNode.nodeID || targetNode.IDStr;
        const sourceDisplayText = sourceNode.displayText || sourceNode.title || sourceNode.alias || sourceNode.target;
        // 目标节点是 MOCTreeNode(来自 parseMOCStructure),只有 alias/target,没有 title/displayText
        const targetDisplayText = targetNode.title || targetNode.displayText || targetNode.alias || targetNode.target;
        const sourceFilePath = sourceNode.file?.path || sourceNode.filePath;
        const targetFilePath = targetNode.filePath || targetNode.file?.path;

        // 构建跨领域关联数据
        const sourceLink = {
            nodeId: sourceNodeId,
            mocPath: sourceMOCPath,
            displayText: sourceDisplayText,
            filePath: sourceFilePath
        };

        const targetLink = {
            nodeId: targetNodeId,
            mocPath: targetMOCPath,
            displayText: targetDisplayText,
            filePath: targetFilePath
        };

        // 保存到源 MOC 文件
        const sourceMOCFile = this.app.vault.getFileByPath(sourceMOCPath);
        if (sourceMOCFile) {
            await this.addCrossDomainLinkToExt(sourceMOCFile, sourceNodeId, targetLink);
        }

        // 保存到目标 MOC 文件
        const targetMOCFile = this.app.vault.getFileByPath(targetMOCPath);
        if (targetMOCFile) {
            await this.addCrossDomainLinkToExt(targetMOCFile, targetNodeId, sourceLink);
        }
    }

    /**
     * 保存多个跨领域关联到双方 MOC 文件的 ext 数据
     */
    private async saveCrossDomainLinks(
        sourceNode: any,
        sourceMOCPath: string,
        targetNodes: any[],
        targetMOCPath: string
    ): Promise<void> {
        // 获取源节点信息
        const sourceNodeId = sourceNode.IDStr || sourceNode.nodeID;
        const sourceDisplayText = sourceNode.displayText || sourceNode.title || sourceNode.alias || sourceNode.target;
        const sourceFilePath = sourceNode.file?.path || sourceNode.filePath;

        // 构建源节点关联数据
        const sourceLink = {
            nodeId: sourceNodeId,
            mocPath: sourceMOCPath,
            displayText: sourceDisplayText,
            filePath: sourceFilePath
        };

        // 保存所有目标节点到源 MOC 文件
        const sourceMOCFile = this.app.vault.getFileByPath(sourceMOCPath);
        if (sourceMOCFile) {
            for (const targetNode of targetNodes) {
                const targetNodeId = targetNode.nodeID || targetNode.IDStr;
                // 目标节点是 MOCTreeNode(来自 parseMOCStructure),只有 alias/target,没有 title/displayText
                const targetDisplayText = targetNode.title || targetNode.displayText || targetNode.alias || targetNode.target;
                const targetFilePath = targetNode.filePath || targetNode.file?.path;

                const targetLink = {
                    nodeId: targetNodeId,
                    mocPath: targetMOCPath,
                    displayText: targetDisplayText,
                    filePath: targetFilePath
                };

                await this.addCrossDomainLinkToExt(sourceMOCFile, sourceNodeId, targetLink);
            }
        }

        // 保存源节点到所有目标节点的 MOC 文件
        for (const targetNode of targetNodes) {
            const targetNodeId = targetNode.nodeID || targetNode.IDStr;
            const targetMOCFile = this.app.vault.getFileByPath(targetMOCPath);
            if (targetMOCFile) {
                await this.addCrossDomainLinkToExt(targetMOCFile, targetNodeId, sourceLink);
            }
        }
    }

    /**
     * 添加跨领域关联到 MOC 文件的 ext 数据
     */
    private async addCrossDomainLinkToExt(
        mocFile: TFile,
        nodeId: string,
        crossDomainLink: {
            nodeId: string;
            mocPath: string;
            displayText: string;
            filePath: string;
        }
    ): Promise<void> {
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            // 初始化 cross_domain_links 字段
            if (!mocData.crossDomainLinks) {
                mocData.crossDomainLinks = {};
            }

            // 添加跨领域关联
            if (!mocData.crossDomainLinks[nodeId]) {
                mocData.crossDomainLinks[nodeId] = [];
            }

            // 检查是否已经存在该关联
            const exists = mocData.crossDomainLinks[nodeId].some(
                (link: any) => link.mocPath === crossDomainLink.mocPath && link.nodeId === crossDomainLink.nodeId
            );

            if (!exists) {
                mocData.crossDomainLinks[nodeId].push(crossDomainLink);
            }
        });
    }

    /**
     * 从某 MOC 的 ext 数据里删除一条跨领域链接(寛容:键/条目不存在直接跳过,不抛错)。
     * match.mocPath 给定时按 nodeId+mocPath 精确匹配,否则只按 nodeId。返回是否真的删掉了。
     */
    private async removeCrossDomainLinkFromExt(
        mocFile: TFile,
        sourceKey: string,
        match: { nodeId: string; mocPath?: string }
    ): Promise<boolean> {
        let removed = false;
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            const links = mocData.crossDomainLinks?.[sourceKey];
            if (!links || !links.length) return;
            const filtered = links.filter((l: any) =>
                !(l.nodeId === match.nodeId && (!match.mocPath || l.mocPath === match.mocPath))
            );
            if (filtered.length !== links.length) {
                removed = true;
                if (filtered.length === 0) {
                    delete mocData.crossDomainLinks![sourceKey];
                } else {
                    mocData.crossDomainLinks![sourceKey] = filtered;
                }
            }
        });
        return removed;
    }

    async toggleNodeAnchor(node: ZKNode) {
        const isAnchor = !!(this.nodeAnchors[node.IDStr] || this.nodeAnchors[node.ID]);
        await this.saveAllNodePositionsBeforeRefresh();
        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                await this.mocHandler.toggleNodeAnchorInMOC(mocFile, node.IDStr, !isAnchor);
                await this.refreshBranchMermaid();
                new Notice(isAnchor ? `已取消节点 ${node.ID} 的锚点` : `已置顶锚点：节点 ${node.ID}`);
            }
        } catch (error) {
            console.error('Failed to toggle anchor:', error);
            new Notice(`操作失败: ${error.message}`);
        }
    }

    async changeNodeColor(node: ZKNode) {
        // 预设颜色
        const colors = [
            { name: '蓝色', value: '#00a8ff' },
            { name: '绿色', value: '#34d399' },
            { name: '橙色', value: '#f59e0b' },
            { name: '红色', value: '#ef4444' },
            { name: '紫色', value: '#a78bfa' },
            { name: '浅灰', value: '#e2e8f0' },
            { name: '默认', value: '' }
        ];
        
        // 显示颜色选择对话框
        const selectedColor = await this.showColorPickerDialog(colors, node);
        
        if (selectedColor === null) {
            return; // 取消
        }
        
        // 在刷新前保存所有节点的当前位置
        await this.saveAllNodePositionsBeforeRefresh();
        
        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                const persistedColor = selectedColor ? `fill2:${selectedColor}` : '';
                await this.mocHandler.updateNodeColorInMOC(mocFile, node.IDStr, persistedColor);
                
                // 刷新视图
                await this.refreshBranchMermaid();
                
                if (selectedColor) {
                    new Notice(`已设置节点 ${node.ID} 的底色`);
                } else {
                    new Notice(`已重置节点 ${node.ID} 的底色`);
                }
            }
        } catch (error) {
            console.error('Failed to change node color:', error);
            new Notice(`修改节点底色失败: ${error.message}`);
        }
    }

    /**
     * 批量修改节点颜色
     */
    async batchChangeNodeColor(nodeIds: string[]) {
        // 预设颜色
        const colors = [
            { name: '蓝色', value: '#00a8ff' },
            { name: '绿色', value: '#34d399' },
            { name: '橙色', value: '#f59e0b' },
            { name: '红色', value: '#ef4444' },
            { name: '紫色', value: '#a78bfa' },
            { name: '浅灰', value: '#e2e8f0' },
            { name: '默认', value: '' }
        ];

        // 显示批量颜色选择对话框
        const selectedColor = await this.showBatchColorPickerDialog(colors, nodeIds);

        if (selectedColor === null) {
            return; // 取消
        }

        // 在刷新前保存所有节点的当前位置
        await this.saveAllNodePositionsBeforeRefresh();

        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                const persistedColor = selectedColor ? `fill2:${selectedColor}` : '';
                await this.mocHandler.updateNodeColorsInMOC(mocFile, nodeIds, persistedColor);

                // 刷新视图
                await this.refreshBranchMermaid();

                if (selectedColor) {
                    new Notice(`已修改 ${nodeIds.length} 个节点的底色`);
                } else {
                    new Notice(`已重置 ${nodeIds.length} 个节点的底色`);
                }
            }
        } catch (error) {
            console.error('Failed to batch change node color:', error);
            new Notice(`批量修改节点底色失败: ${error.message}`);
        }
    }

    private showNodeFillColorDialog(
        colors: Array<{ name: string; value: string }>,
        title: string,
        targetLabel: string
    ): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(title);
            modal.modalEl.addClass('zk-node-edit-modal');

            const { contentEl } = modal;
            contentEl.empty();
            contentEl.addClass('zk-node-edit-content');

            const meta = contentEl.createDiv('zk-node-edit-meta');
            meta.createSpan({ text: targetLabel });

            const initialColor = this.lastPickedNodeFillColor || colors.find((color) => !!color.value)?.value || '#00a8ff';
            let selectedColor: string | null = null;

            const selectedRow = contentEl.createDiv('zk-node-color-current');
            selectedRow.createSpan({ text: '当前选择' });
            const selectedPreview = selectedRow.createSpan('zk-node-color-preview');
            const selectedValue = selectedRow.createSpan({ cls: 'zk-node-color-value', text: '未选择' });
            const updateSelectedPreview = (color: string) => {
                if (color) {
                    selectedPreview.setCssStyles({
                        backgroundImage: 'none',
                        backgroundColor: color,
                    });
                } else {
                    selectedPreview.setCssStyles({
                        backgroundImage: '',
                        backgroundColor: 'transparent',
                    });
                }
            };
            updateSelectedPreview(initialColor);

            const panel = createSelectionColorPanel(
                initialColor,
                this.lastPickedNodeFillColor,
                '自定义底色',
                (hexColor: string) => {
                    selectedColor = hexColor;
                    this.lastPickedNodeFillColor = hexColor;
                    updateSelectedPreview(hexColor);
                    selectedValue.setText(hexColor);
                }
            );
            panel.addClass('zk-node-color-picker-panel');
            contentEl.appendChild(panel);

            const actions = contentEl.createDiv('zk-node-edit-actions');

            const resetButton = actions.createEl('button', { text: '默认' });
            resetButton.addClass('zk-node-edit-btn');
            resetButton.addEventListener('click', () => {
                selectedColor = '';
                updateSelectedPreview('');
                selectedValue.setText('默认');
            });

            const cancelButton = actions.createEl('button', { text: '取消' });
            cancelButton.addClass('zk-node-edit-btn');
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });

            const confirmButton = actions.createEl('button', { text: '确认' });
            confirmButton.addClass('zk-node-edit-btn');
            confirmButton.addClass('mod-cta');
            confirmButton.addEventListener('click', () => {
                if (selectedColor === null) {
                    new Notice('请选择一个颜色');
                    return;
                }
                modal.close();
                resolve(selectedColor);
            });
            
            modal.open();
        });
    }

    /**
     * 显示批量颜色选择对话框
     */
    private showBatchColorPickerDialog(colors: Array<{ name: string; value: string }>, nodeIds: string[]): Promise<string | null> {
        return this.showNodeFillColorDialog(colors, '批量修改节点底色', `选中节点: ${nodeIds.length} 个`);
    }

    private showColorPickerDialog(colors: Array<{ name: string; value: string }>, node: ZKNode): Promise<string | null> {
        return this.showNodeFillColorDialog(colors, '选择节点底色', `节点: ${node.ID}`);
    }

    /**
     * 修改节点 ID
     */
    async renameNodeID(node: ZKNode) {
        // 显示输入对话框
        const newID = await this.showNodeIDInputDialog(node.IDStr);

        if (!newID || newID === node.IDStr) {
            return; // 取消或未修改
        }

        // 检查新 ID 是否已存在
        const existingNode = this.mocNodes.find(n => n.IDStr === newID);
        if (existingNode) {
            new Notice(`节点 ID "${newID}" 已存在，请使用其他 ID`);
            return;
        }

        // 在刷新前保存所有节点的当前位置
        await this.saveAllNodePositionsBeforeRefresh();

        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                const childCount = await this.mocHandler.updateNodeIDInMOC(mocFile, node.IDStr, newID);

                // 刷新视图
                await this.refreshBranchMermaid();

                const message = childCount > 0
                    ? `已将节点 ID 从 "${node.IDStr}" 修改为 "${newID}"，并更新了 ${childCount} 个子节点`
                    : `已将节点 ID 从 "${node.IDStr}" 修改为 "${newID}"`;
                new Notice(message);
            }
        } catch (error) {
            console.error('Failed to rename node ID:', error);
            new Notice(`修改节点 ID 失败: ${error.message}`);
        }
    }

    /**
     * 修改节点内容
     * - 纯文字节点：更新节点文本
     * - 文件节点：更新显示文本（不改变 wiki link）
     */
    async editNodeContent(node: ZKNode) {
        const dialogTitle = node.isTextOnly ? '修改文本节点内容' : '修改文件节点显示文本';
        const currentContent = node.isTextOnly
            ? this.decodeMultilineText(node.title || '')
            : this.buildFileNodeRawWikiText(node);
        const newContent = await this.showTextNodeContentInputDialog(currentContent, dialogTitle);

        if (!newContent || newContent === currentContent) {
            return; // 取消或未修改
        }

        await this.saveNodeContent(node, newContent);
    }

    /**
     * 删除节点(从画布与 MOC),复用删除键的完整流程:
     * 关系数 > 2 时二次确认 → 落盘当前位置 → 区分跨领域/普通节点删除 → 清理图片 → 刷新 → reflow。
     */
    private async deleteNodeFromGraph(node: ZKNode, relationCount: number = 0) {
        // 关系数量超过2个，删除前需要二次确认(空内容删除与删除键共用此护栏)
        if (relationCount > 2) {
            const confirmed = await this.showDeleteConfirmDialog(node, relationCount);
            if (!confirmed) {
                return;
            }
        }

        // 在刷新前保存所有节点的当前位置，并取消尚未落盘的拖拽位置保存
        await this.flushAndSaveCurrentPositions();

        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (!mocFile) return;

            // 删除前收集本节点内嵌的附件(删除后内容就没了),删除后再判断是否成孤儿
            const embeddedAttachments = this.collectNodeEmbeddedAttachments(node, mocFile.path);

            // 删除前解析真实父级(自由节点父子关系只在边里,删除+刷新后丢失)
            const reflowParentId = node.isCrossDomain
                ? null
                : this.pickAutoLayoutParentForReflow([node.IDStr]);
            // 根据 isCrossDomain 属性选择删除方法
            if (node.isCrossDomain) {
                // 跨领域节点：使用专门的删除方法
                const crossDomainLinkInfo = {
                    sourceNodeId: node.crossDomainSourceNodeId,
                    nodeId: node.crossDomainOriginalNodeId
                };
                await this.mocHandler.deleteCrossDomainNodeFromMOC(
                    mocFile,
                    node.IDStr,
                    crossDomainLinkInfo
                );
            } else {
                // 普通节点：使用常规删除方法
                await this.mocHandler.deleteNodeFromMOC(mocFile, node.IDStr);
            }

            // 如果是嵌入图片节点，删除对应的图片文件
            await this.deleteImageFileIfNeeded(node);

            // 等待一小段时间确保文件保存完成
            await new Promise(resolve => setTimeout(resolve, 20));

            // 文本节点内嵌的附件(录音/图片等):全库已无其它引用则一并回收
            await this.deleteOrphanedAttachments(embeddedAttachments);

            // 刷新视图
            await this.refreshBranchMermaid();

            // 声明式 reflow: 删除后整棵树重排, 回收空缺。
            if (reflowParentId) {
                await this.reflowAutoLayout(reflowParentId);
            }

            new Notice(t("Node deleted").replace("{id}", String(node.ID)));
        } catch (error) {
            console.error('Failed to delete node:', error);
            new Notice(t("Delete node failed").replace("{message}", String(error.message)));
        }
    }

    private async saveNodeContent(
        node: ZKNode,
        newContent: string,
        nodeSize?: { widthModel: number; heightModel: number },
        position?: { x: number; y: number },
        relationCount: number = 0
    ) {
        const currentContent = node.isTextOnly
            ? this.decodeMultilineText(node.title || '')
            : this.buildFileNodeRawWikiText(node);
        // 提交时内容为空 = 删除节点(关系多时由 deleteNodeFromGraph 二次确认)
        if (!newContent || !newContent.trim()) {
            await this.deleteNodeFromGraph(node, relationCount);
            return;
        }

        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                if (newContent !== currentContent) {
                    if (node.isTextOnly) {
                        const contentForSave = this.encodeMultilineText(newContent);
                        await this.mocHandler.updateNodeContentInMOC(mocFile, node.IDStr, contentForSave);
                    } else {
                        const parsed = this.parseRawWikiLinkInput(newContent);
                        if (!parsed) {
                            new Notice('文件节点请使用 [[链接]] 或 [[链接|显示文本]] 格式');
                            return;
                        }

                        await this.mocHandler.updateNodeContentInMOC(
                            mocFile,
                            node.IDStr,
                            parsed.displayText,
                            parsed.wikiLink,
                            parsed.isEmbed
                        );
                    }
                }

                // 允许部分锁定:文本节点编辑后只保留宽度锁，高度走自动适配，heightModel=0 表示"无锁"。
                if (nodeSize && (nodeSize.widthModel > 0 || nodeSize.heightModel > 0)) {
                    await this.saveEmbedNodeSizeToMOC(mocFile, node.IDStr, nodeSize);
                }

                if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
                    await this.saveNodePositionToMOC(mocFile, node.IDStr, position);
                }

                // 刷新视图
                await this.refreshBranchMermaid();

                new Notice(`已更新节点内容`);
            }
        } catch (error) {
            console.error('Failed to edit node content:', error);
            new Notice(`修改节点内容失败: ${error.message}`);
        }
    }

    /**
     * 把音频(或任意文件)以 ![[path]] 形式追加到指定文本节点末尾。
     * 录音回填走这条:读当前 MOC 的最新节点内容再追加,避免用编辑期旧快照覆盖。
     */
    private async appendEmbedToTextNode(nodeIdStr: string, embedPath: string): Promise<void> {
        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile) return;
        const embed = `![[${embedPath}]]`;
        let isText = true;
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                const treeNode = this.findNodeInTree(mocData.nodes, nodeIdStr);
                if (!treeNode) {
                    throw new Error(`未找到节点: ${nodeIdStr}`);
                }
                if (treeNode.nodeType !== 'text') {
                    isText = false;
                    return;
                }
                const decoded = this.decodeMultilineText(treeNode.target || '');
                const newContent = decoded.trim() ? `${decoded}\n${embed}` : embed;
                treeNode.target = this.encodeMultilineText(newContent);
            });
            if (!isText) {
                new Notice(`录音已保存：${embedPath}（当前节点非文本节点，未自动嵌入）`);
                return;
            }
            this.lastRenderSignature = null;
            await this.refreshBranchMermaid();
            new Notice('录音已嵌入当前节点');
        } catch (error: any) {
            console.error('[indexView] appendEmbedToTextNode failed:', error);
            new Notice(`录音嵌入失败: ${error?.message || error}`);
        }
    }

    async editTextNodeContent(node: ZKNode) {
        await this.editNodeContent(node);
    }

    private getNodeRemark(node: ZKNode): string {
        return this.nodeRemarks[node.IDStr] || this.nodeRemarks[node.ID] || '';
    }

    /** 详情侧栏内联编辑保存备注(无弹窗,与画布文本编辑体验一致) */
    private async saveNodeRemarkFromPanel(node: ZKNode, text: string): Promise<void> {
        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (!mocFile) return;
            await this.mocHandler.updateNodeRemarkInMOC(mocFile, node.IDStr, text);
            // 乐观本地更新,避免刷新时序导致侧栏读到旧值
            if (text) this.nodeRemarks[node.IDStr] = text;
            else delete this.nodeRemarks[node.IDStr];
            await this.refreshBranchMermaid();
        } catch (error) {
            console.error('Failed to save node remark from panel:', error);
            new Notice(`修改备注失败: ${error.message}`);
        }
    }

    /**
     * 显示节点 ID 输入对话框
     */
    private showNodeIDInputDialog(currentID: string): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText('修改节点 ID');
            modal.modalEl.addClass('zk-node-edit-modal');
            
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.addClass('zk-node-edit-content');

            const meta = contentEl.createDiv('zk-node-edit-meta');
            meta.createSpan({ text: '当前 ID: ' });
            meta.createSpan({ cls: 'zk-node-edit-strong', text: currentID });
            
            const inputContainer = contentEl.createDiv();
            inputContainer.addClass('zk-node-edit-field');
            
            const label = inputContainer.createEl('label', { text: '新的节点 ID：' });
            
            const input = inputContainer.createEl('input', {
                type: 'text',
                value: currentID
            });
            input.addClass('zk-node-edit-input');
            
            const actions = contentEl.createDiv('zk-node-edit-actions');
            
            const cancelButton = actions.createEl('button', { text: '取消' });
            cancelButton.addClass('zk-node-edit-btn');
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });
            
            const confirmButton = actions.createEl('button', { text: '确认' });
            confirmButton.addClass('zk-node-edit-btn');
            confirmButton.addClass('mod-cta');
            confirmButton.addEventListener('click', () => {
                const newID = input.value.trim();
                if (!newID) {
                    new Notice('节点 ID 不能为空');
                    return;
                }
                modal.close();
                resolve(newID);
            });
            
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const newID = input.value.trim();
                    if (!newID) {
                        new Notice('节点 ID 不能为空');
                        return;
                    }
                    modal.close();
                    resolve(newID);
                } else if (e.key === 'Escape') {
                    modal.close();
                    resolve(null);
                }
            });
            
            modal.open();
            setTimeout(() => {
                input.focus();
                input.select();
            }, 0);
        });
    }

    private showGroupLabelInputDialog(currentLabel: string): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(t('ctx rename group'));

            const { contentEl } = modal;
            contentEl.empty();
            contentEl.setCssStyles({ padding: '20px' });

            const inputContainer = contentEl.createDiv();
            inputContainer.setCssStyles({ marginBottom: '15px' });

            const label = inputContainer.createEl('label', { text: '新的分组名称：' });
            label.setCssStyles({
                display: 'block',
                marginBottom: '5px',
                color: 'var(--text-normal)',
            });

            const input = inputContainer.createEl('input', {
                type: 'text',
                value: currentLabel || ''
            });
            input.setCssStyles({
                width: '100%',
                padding: '8px',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                backgroundColor: 'var(--background-primary)',
                color: 'var(--text-normal)',
            });

            const buttonContainer = contentEl.createDiv();
            buttonContainer.setCssStyles({
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
            });

            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });

            const confirmButton = buttonContainer.createEl('button', { text: '确认' });
            confirmButton.addEventListener('click', () => {
                const newLabel = input.value.trim();
                if (!newLabel) {
                    new Notice('分组名称不能为空');
                    return;
                }
                modal.close();
                resolve(newLabel);
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const newLabel = input.value.trim();
                    if (!newLabel) {
                        new Notice('分组名称不能为空');
                        return;
                    }
                    modal.close();
                    resolve(newLabel);
                } else if (e.key === 'Escape') {
                    modal.close();
                    resolve(null);
                }
            });

            modal.open();
            setTimeout(() => {
                input.focus();
                input.select();
            }, 0);
        });
    }

    private showGroupIDInputDialog(currentID: string): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText('修改分组 ID');

            const { contentEl } = modal;
            contentEl.empty();
            contentEl.setCssStyles({ padding: '20px' });

            const infoDiv = contentEl.createDiv();
            infoDiv.setCssStyles({
                marginBottom: '15px',
                padding: '10px',
                backgroundColor: 'var(--background-secondary)',
                borderRadius: '4px',
                color: 'var(--text-muted)',
            });
            const currentIdLine = infoDiv.createDiv();
            currentIdLine.appendText('当前分组 ID: ');
            currentIdLine.createEl('strong', { text: currentID });

            const inputContainer = contentEl.createDiv();
            inputContainer.setCssStyles({ marginBottom: '15px' });

            const label = inputContainer.createEl('label', { text: '新的分组 ID：' });
            label.setCssStyles({
                display: 'block',
                marginBottom: '5px',
                color: 'var(--text-normal)',
            });

            const input = inputContainer.createEl('input', {
                type: 'text',
                value: currentID
            });
            input.setCssStyles({
                width: '100%',
                padding: '8px',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                backgroundColor: 'var(--background-primary)',
                color: 'var(--text-normal)',
            });

            const buttonContainer = contentEl.createDiv();
            buttonContainer.setCssStyles({
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
            });

            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });

            const confirmButton = buttonContainer.createEl('button', { text: '确认' });
            confirmButton.addEventListener('click', () => {
                const newID = input.value.trim();
                if (!newID) {
                    new Notice('分组 ID 不能为空');
                    return;
                }
                modal.close();
                resolve(newID);
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const newID = input.value.trim();
                    if (!newID) {
                        new Notice('分组 ID 不能为空');
                        return;
                    }
                    modal.close();
                    resolve(newID);
                } else if (e.key === 'Escape') {
                    modal.close();
                    resolve(null);
                }
            });

            modal.open();
            setTimeout(() => {
                input.focus();
                input.select();
            }, 0);
        });
    }

    /**
     * 显示文本节点内容输入对话框
     */
    private showTextNodeContentInputDialog(
        currentContent: string,
        title: string = '修改文本节点内容',
        allowEmpty: boolean = false
    ): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            let isResolved = false;
            const resolveOnce = (value: string | null) => {
                if (isResolved) return;
                isResolved = true;
                resolve(value);
            };
            modal.titleEl.setText(title);

            const { contentEl } = modal;
            contentEl.empty();
            contentEl.setCssStyles({
                padding: '20px',
                position: 'relative',
            });

            const inputContainer = contentEl.createDiv();
            inputContainer.setCssStyles({
                marginBottom: '15px',
                position: 'relative',
            });

            const label = inputContainer.createEl('label', { text: '新内容：' });
            label.setCssStyles({
                display: 'block',
                marginBottom: '5px',
                color: 'var(--text-normal)',
            });

            const input = inputContainer.createEl('textarea');
            input.value = currentContent;
            input.setCssStyles({
                width: '100%',
                padding: '8px',
                minHeight: '140px',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                backgroundColor: 'var(--background-primary)',
                color: 'var(--text-normal)',
                resize: 'vertical',
                lineHeight: '1.5',
            });

            // [[ 文件候选框状态
            const suggesterState: {
                popover: HTMLElement | null;
                searchInput: HTMLInputElement | null;
                selectedIndex: number;
                currentFiles: TFile[];
                triggerStartPos: number;
            } = {
                popover: null,
                searchInput: null,
                selectedIndex: 0,
                currentFiles: [],
                triggerStartPos: 0
            };

            const closeWikiLinkSuggester = () => {
                if (suggesterState.popover?.parentNode) {
                    suggesterState.popover.remove();
                }
                suggesterState.popover = null;
                suggesterState.searchInput = null;
                suggesterState.currentFiles = [];
                suggesterState.selectedIndex = 0;
            };

            const insertWikiLinkAtCursor = (file: TFile) => {
                const start = Math.max(0, suggesterState.triggerStartPos);
                const before = input.value.slice(0, start);
                const after = input.value.slice(input.selectionStart);
                const insertion = `[[${file.basename}]]`;
                const newValue = `${before}${insertion}${after}`;
                const newCursor = before.length + insertion.length;

                input.value = newValue;
                input.focus();
                input.setSelectionRange(newCursor, newCursor);
                input.trigger("input");
                closeWikiLinkSuggester();
            };

            const showWikiLinkSuggester = () => {
                closeWikiLinkSuggester();
                const files = this.app.vault.getMarkdownFiles();
                const inputRect = input.getBoundingClientRect();
                const viewportBottomPadding = 12;
                const maxHeight = Math.max(
                    120,
                    Math.min(240, window.innerHeight - inputRect.bottom - viewportBottomPadding - 8)
                );

                const popover = document.createElement('div');
                popover.className = 'node-link-suggester';
                popover.setCssStyles({
                    position: 'fixed',
                    left: `${inputRect.left}px`,
                    top: `${inputRect.bottom + 6}px`,
                    maxHeight: `${maxHeight}px`,
                    width: `${Math.min(420, inputRect.width)}px`,
                    backgroundColor: 'var(--background-primary)',
                    border: '1px solid var(--background-modifier-border)',
                    borderRadius: '6px',
                    boxShadow: '0 6px 16px rgba(0, 0, 0, 0.35)',
                    zIndex: '1001',
                    overflowY: 'auto',
                    padding: '4px 0',
                });

                const searchInput = document.createElement('input');
                searchInput.type = 'text';
                searchInput.placeholder = 'Search notes...';
                searchInput.setCssStyles({
                    width: 'calc(100% - 16px)',
                    margin: '4px 8px',
                    padding: '6px 8px',
                    border: '1px solid var(--background-modifier-border)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--background-secondary)',
                    color: 'var(--text-normal)',
                    fontSize: '12px',
                    position: 'sticky',
                    top: '0',
                    zIndex: '2',
                });

                const updateSelection = () => {
                    if (!suggesterState.popover) return;
                    const items = suggesterState.popover.querySelectorAll('.suggester-item');
                    items.forEach((item: any, index: number) => {
                        if (index === suggesterState.selectedIndex) {
                            item.setCssStyles({ backgroundColor: 'var(--background-modifier-hover)' });
                            item.scrollIntoView({ block: 'nearest' });
                        } else {
                            item.setCssStyles({ backgroundColor: '' });
                        }
                    });
                };

                const updateFileList = () => {
                    const term = (searchInput.value || '').toLowerCase();
                    const oldItems = popover.querySelectorAll('.suggester-item');
                    oldItems.forEach(item => item.remove());

                    suggesterState.currentFiles = files
                        .filter(file =>
                            file.basename.toLowerCase().includes(term) ||
                            file.path.toLowerCase().includes(term)
                        )
                        .slice(0, 20);

                    suggesterState.selectedIndex = 0;

                    suggesterState.currentFiles.forEach((file, index) => {
                        const item = document.createElement('div');
                        item.className = 'suggester-item';
                        item.setCssStyles({
                            padding: '6px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                        });

                        const basenameEl = item.createEl('span', { text: file.basename });
                        basenameEl.setCssStyles({
                            fontWeight: '500',
                            color: 'var(--text-normal)',
                        });
                        const pathEl = item.createEl('span', { text: file.path });
                        pathEl.setCssStyles({
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                        });

                        item.addEventListener('mouseenter', () => {
                            suggesterState.selectedIndex = index;
                            updateSelection();
                        });

                        item.addEventListener('click', () => insertWikiLinkAtCursor(file));
                        popover.appendChild(item);
                    });

                    updateSelection();
                };

                searchInput.addEventListener('input', (e) => {
                    e.stopPropagation();
                    updateFileList();
                });

                searchInput.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        suggesterState.selectedIndex = Math.min(
                            suggesterState.selectedIndex + 1,
                            Math.max(0, suggesterState.currentFiles.length - 1)
                        );
                        updateSelection();
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        suggesterState.selectedIndex = Math.max(suggesterState.selectedIndex - 1, 0);
                        updateSelection();
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        const file = suggesterState.currentFiles[suggesterState.selectedIndex];
                        if (file) insertWikiLinkAtCursor(file);
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        closeWikiLinkSuggester();
                        input.focus();
                    }
                });

                popover.appendChild(searchInput);
                modal.containerEl.appendChild(popover);
                suggesterState.popover = popover;
                suggesterState.searchInput = searchInput;

                updateFileList();

                const focusSearchInput = () => {
                    searchInput.focus();
                    searchInput.setSelectionRange(0, searchInput.value.length);
                };
                requestAnimationFrame(focusSearchInput);
            };

            const buttonContainer = contentEl.createDiv();
            buttonContainer.setCssStyles({
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
            });

            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.setCssStyles({
                padding: '6px 16px',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                backgroundColor: 'var(--background-primary)',
                color: 'var(--text-normal)',
                cursor: 'pointer',
            });
            cancelButton.addEventListener('click', () => {
                closeWikiLinkSuggester();
                resolveOnce(null);
                modal.close();
            });

            const confirmButton = buttonContainer.createEl('button', { text: '确认' });
            confirmButton.setCssStyles({
                padding: '6px 16px',
                border: 'none',
                borderRadius: '4px',
                backgroundColor: '#5b8fd9',
                color: '#ffffff',
                cursor: 'pointer',
            });
            confirmButton.addEventListener('click', () => {
                const newContent = input.value.trim();
                if (!allowEmpty && !newContent) {
                    new Notice('文本内容不能为空');
                    return;
                }
                closeWikiLinkSuggester();
                resolveOnce(newContent);
                modal.close();
            });

            input.addEventListener('input', () => {
                const cursorPos = input.selectionStart;
                const lastTwoChars = input.value.substring(Math.max(0, cursorPos - 2), cursorPos);
                if (lastTwoChars === '[[' || lastTwoChars === '【【') {
                    suggesterState.triggerStartPos = Math.max(0, cursorPos - 2);
                    showWikiLinkSuggester();
                }
            });

            input.addEventListener('keydown', (e) => {
                if (suggesterState.popover) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const next = e.key === 'ArrowDown'
                            ? Math.min(suggesterState.selectedIndex + 1, Math.max(0, suggesterState.currentFiles.length - 1))
                            : Math.max(suggesterState.selectedIndex - 1, 0);
                        suggesterState.selectedIndex = next;
                        const items = suggesterState.popover.querySelectorAll('.suggester-item');
                        items.forEach((item: any, index: number) => {
                            item.setCssStyles({ backgroundColor: index === suggesterState.selectedIndex
                                ? 'var(--background-modifier-hover)'
                                : '' });
                        });
                        return;
                    }

                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const file = suggesterState.currentFiles[suggesterState.selectedIndex];
                        if (file) {
                            insertWikiLinkAtCursor(file);
                        }
                        return;
                    }

                    if (e.key === 'Escape') {
                        e.preventDefault();
                        closeWikiLinkSuggester();
                        return;
                    }
                }

                if (e.key === 'Enter') {
                    if (e.shiftKey || e.metaKey || e.ctrlKey) {
                        // Shift/Cmd/Ctrl + Enter：换行
                        return;
                    }

                    e.preventDefault();
                    const newContent = input.value.trim();
                    if (!allowEmpty && !newContent) {
                        new Notice('文本内容不能为空');
                        return;
                    }
                    closeWikiLinkSuggester();
                    resolveOnce(newContent);
                    modal.close();
                } else if (e.key === 'Escape') {
                    closeWikiLinkSuggester();
                    resolveOnce(null);
                    modal.close();
                }
            });

            modal.onClose = () => {
                closeWikiLinkSuggester();
                resolveOnce(null);
            };

            modal.open();
            setTimeout(() => {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }, 0);
        });
    }

    private encodeMultilineText(content: string): string {
        return content.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
    }

    private decodeMultilineText(content: string): string {
        return content.replace(/\\n/g, '\n');
    }

    private buildFileNodeRawWikiText(node: ZKNode): string {
        const wikiLink = node.file?.basename || node.title || '';
        const displayText = node.title || wikiLink;
        const prefix = node.isEmbed ? '!' : '';
        if (displayText && displayText !== wikiLink) {
            return `${prefix}[[${wikiLink}|${displayText}]]`;
        }
        return `${prefix}[[${wikiLink}]]`;
    }

    private parseRawWikiLinkInput(input: string): { wikiLink: string; displayText: string; isEmbed: boolean } | null {
        const trimmed = input.trim();
        const normalMatch = trimmed.match(/^(!)?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
        const fullWidthMatch = trimmed.match(/^(！)?【【([^|】]+)(?:\|([^】]+))?】】$/);
        const match = normalMatch || fullWidthMatch;
        if (!match) {
            return null;
        }

        const isEmbed = !!match[1];
        const wikiLink = match[2].trim();
        const displayText = (match[3] || match[2]).trim();
        if (!wikiLink || !displayText) {
            return null;
        }

        return { wikiLink, displayText, isEmbed };
    }

    /**
     * 显示删除确认对话框
     */
    private showDeleteConfirmDialog(node: ZKNode, relationCount: number): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(t("Confirm delete node"));
            
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.setCssStyles({ padding: '20px' });
            
            const warningDiv = contentEl.createDiv();
            warningDiv.setCssStyles({
                marginBottom: '15px',
                padding: '15px',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '4px',
            });
            
            const warningIcon = warningDiv.createEl('div', { text: '⚠️' });
            warningIcon.setCssStyles({
                fontSize: '24px',
                marginBottom: '10px',
            });
            
            const warningText = warningDiv.createEl('div');
            const nodeLine = warningText.createDiv({ text: t("Deleting node").replace("{id}", String(node.ID)) });
            nodeLine.setCssStyles({
                fontWeight: '600',
                marginBottom: '8px',
            });
            const relationLine = warningText.createDiv();
            relationLine.setCssStyles({ color: 'var(--text-muted)' });
            relationLine.appendText(t("This node has"));
            relationLine.createEl('strong', { text: String(relationCount) });
            relationLine.appendText(t("relation connections suffix"));
            const deleteLine = warningText.createDiv({ text: t("Deleting will also remove") });
            deleteLine.setCssStyles({
                color: 'var(--text-muted)',
                marginTop: '8px',
            });
            const list = warningText.createEl('ul');
            list.setCssStyles({
                margin: '8px 0',
                paddingLeft: '20px',
                color: 'var(--text-muted)',
            });
            list.createEl('li', { text: t("Node entry in MOC file") });
            list.createEl('li', { text: t("All arrow relations related to node") });
            list.createEl('li', { text: t("Node position information") });
            const irreversibleLine = warningText.createDiv({ text: t("This operation cannot be undone") });
            irreversibleLine.setCssStyles({
                color: 'var(--text-error)',
                fontWeight: '600',
                marginTop: '8px',
            });
            
            const buttonContainer = contentEl.createDiv();
            buttonContainer.setCssStyles({
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                marginTop: '20px',
            });
            
            const cancelButton = buttonContainer.createEl('button', { text: t("Cancel") });
            cancelButton.setCssStyles({
                padding: '6px 16px',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                backgroundColor: 'var(--background-primary)',
                color: 'var(--text-normal)',
                cursor: 'pointer',
            });
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(false);
            });
            
            const confirmButton = buttonContainer.createEl('button', { text: t("Confirm delete") });
            confirmButton.setCssStyles({
                padding: '6px 16px',
                border: 'none',
                borderRadius: '4px',
                backgroundColor: '#ef4444',
                color: '#ffffff',
                cursor: 'pointer',
            });
            confirmButton.addEventListener('click', () => {
                modal.close();
                resolve(true);
            });
            
            modal.open();
        });
    }



    /**
     * 添加反向连接节点（选择现有节点）
     */
    async addReverseNodeToMOC(targetNode: ZKNode) {
        // 创建节点选择器模态框
        const modal = new Modal(this.app);
        modal.titleEl.setText('选择要连接的节点');
        
        const { contentEl } = modal;
        contentEl.empty();
        contentEl.setCssStyles({ padding: '20px' });
        
        // 创建搜索框
        const searchContainer = contentEl.createDiv({ cls: 'zk-node-search-container' });
        searchContainer.setCssStyles({ marginBottom: '15px' });
        
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: '搜索节点 ID 或标题...'
        });
        searchInput.setCssStyles({
            width: '100%',
            padding: '8px',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            backgroundColor: 'var(--background-primary)',
            color: 'var(--text-normal)',
        });
        
        // 创建节点列表容器
        const nodeListContainer = contentEl.createDiv({ cls: 'zk-node-list-container' });
        nodeListContainer.setCssStyles({
            maxHeight: '400px',
            overflowY: 'auto',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            padding: '10px',
        });
        
        // 关系文本输入框
        const relationContainer = contentEl.createDiv({ cls: 'zk-relation-input-container' });
        relationContainer.setCssStyles({ marginTop: '15px' });
        
        const relationLabel = relationContainer.createEl('label', { text: '关系描述（可选）：' });
        relationLabel.setCssStyles({
            display: 'block',
            marginBottom: '5px',
            color: 'var(--text-normal)',
        });
        
        const relationInput = relationContainer.createEl('input', {
            type: 'text',
            placeholder: '例如：引出、相关、应用等'
        });
        relationInput.setCssStyles({
            width: '100%',
            padding: '8px',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            backgroundColor: 'var(--background-primary)',
            color: 'var(--text-normal)',
        });
        
        let selectedNode: ZKNode | null = null;
        
        // 渲染节点列表
        const renderNodeList = (filterText: string = '') => {
            nodeListContainer.empty();
            
            const filteredNodes = this.mocNodes.filter(node => {
                if (node.ID === targetNode.ID) return false; // 排除目标节点自己
                
                if (!filterText) return true;
                
                const searchLower = filterText.toLowerCase();
                return node.ID.toLowerCase().includes(searchLower) ||
                       node.title.toLowerCase().includes(searchLower) ||
                       node.displayText.toLowerCase().includes(searchLower);
            });
            
            if (filteredNodes.length === 0) {
                const emptyHint = nodeListContainer.createDiv({ text: '没有找到匹配的节点' });
                emptyHint.setCssStyles({
                    textAlign: 'center',
                    padding: '20px',
                    color: 'var(--text-muted)',
                });
                return;
            }
            
            filteredNodes.forEach(node => {
                const nodeItem = nodeListContainer.createDiv({ cls: 'zk-node-item' });
                nodeItem.setCssStyles({
                    padding: '10px',
                    marginBottom: '5px',
                    border: '1px solid var(--background-modifier-border)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                });
                
                const nodeId = nodeItem.createDiv({ text: node.ID });
                nodeId.setCssStyles({
                    fontWeight: '600',
                    color: 'var(--text-accent)',
                    marginBottom: '4px',
                });
                
                const nodeTitle = nodeItem.createDiv({ text: node.title || node.displayText });
                nodeTitle.setCssStyles({
                    fontSize: '0.9em',
                    color: 'var(--text-muted)',
                });
                
                nodeItem.addEventListener('mouseenter', () => {
                    nodeItem.setCssStyles({ backgroundColor: 'var(--background-modifier-hover)' });
                });
                
                nodeItem.addEventListener('mouseleave', () => {
                    if (selectedNode !== node) {
                        nodeItem.setCssStyles({ backgroundColor: 'transparent' });
                    }
                });
                
                nodeItem.addEventListener('click', () => {
                    // 取消之前的选中
                    nodeListContainer.querySelectorAll('.zk-node-item').forEach(item => {
                        (item as HTMLElement).setCssStyles({
                            backgroundColor: 'transparent',
                            borderColor: 'var(--background-modifier-border)',
                        });
                    });
                    
                    // 选中当前节点
                    selectedNode = node;
                    nodeItem.setCssStyles({
                        backgroundColor: 'var(--background-modifier-hover)',
                        borderColor: 'var(--text-accent)',
                    });
                });
                
                // 双击直接确认
                nodeItem.addEventListener('dblclick', async () => {
                    selectedNode = node;
                    await confirmSelection();
                });
            });
        };
        
        // 搜索框输入事件
        searchInput.addEventListener('input', () => {
            renderNodeList(searchInput.value);
        });
        
        // 初始渲染
        renderNodeList();
        
        // 确认选择函数
        const confirmSelection = async () => {
            if (!selectedNode) {
                new Notice(t("Please select a node first"));
                return;
            }
            
            const relationText = relationInput.value.trim();
            
            // 在刷新前保存所有节点的当前位置
            await this.saveAllNodePositionsBeforeRefresh();
            
            // 添加箭头关系到 MOC 文件
            try {
                const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
                if (mocFile) {
                    await this.addArrowRelationToMOC(
                        mocFile,
                        targetNode.IDStr,      // 源节点
                        selectedNode.ID,       // 目标节点
                        relationText
                    );
                    
                    modal.close();
                    
                    // 刷新视图
                    await this.refreshBranchMermaid();
                    
                    new Notice(t("Reverse relation added")
                        .replace("{source}", String(targetNode.ID))
                        .replace("{target}", String(selectedNode.ID)));
                }
            } catch (error) {
                console.error('Failed to add arrow relation:', error);
                new Notice(t("Add reverse relation failed").replace("{message}", String(error.message)));
            }
        };
        
        // 按钮容器
        const buttonContainer = contentEl.createDiv({ cls: 'zk-button-container' });
        buttonContainer.setCssStyles({
            marginTop: '20px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
        });
        
        // 取消按钮
        const cancelButton = buttonContainer.createEl('button', { text: '取消' });
        cancelButton.setCssStyles({
            padding: '6px 16px',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            backgroundColor: 'var(--background-primary)',
            color: 'var(--text-normal)',
            cursor: 'pointer',
        });
        cancelButton.addEventListener('click', () => modal.close());
        
        // 确认按钮
        const confirmButton = buttonContainer.createEl('button', { text: '确认' });
        confirmButton.setCssStyles({
            padding: '6px 16px',
            border: 'none',
            borderRadius: '4px',
            backgroundColor: '#5b8fd9',
            color: '#ffffff',
            cursor: 'pointer',
        });
        confirmButton.addEventListener('click', confirmSelection);
        
        // Enter 键确认
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && selectedNode) {
                confirmSelection();
            }
        });
        
        relationInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmSelection();
            }
        });
        
        modal.open();
        
        // 自动聚焦搜索框
        setTimeout(() => searchInput.focus(), 0);
    }

    /**
     * 为指定节点添加子节点
     */
    async addChildNodeToMOC(parentNode: ZKNode) {
        // 生成子节点 ID
        const suggestedID = this.generateChildNodeID(parentNode.IDStr);
        
        // 计算默认位置（在父节点右边）
        const defaultPosition = this.calculateDefaultPosition(parentNode, 'right');
        
        // 打开对话框，预选父节点
        const modal = new AddFreeNodeModal(
            this.app,
            this.plugin,
            this.mocNodes,
            suggestedID,
            async (result) => {
                // 草稿模式(#20):新建自由节点也先作为草稿
                if (this.divertFreeNodeToDraft(result, defaultPosition || undefined)) return;

                // 在刷新前保存所有节点的当前位置
                await this.saveAllNodePositionsBeforeRefresh();

                // 添加到 MOC 文件
                await this.saveFreeNodeToMOC(result, defaultPosition || undefined);
                
                // 刷新视图
                await this.refreshBranchMermaid();
            }
        );
        
        // 预设父节点
        modal.connectToNodeID = parentNode.IDStr;
        modal.nodeID = suggestedID;
        
        modal.onOpen();
        modal.open();
    }

    /**
     * 计算新节点的默认位置
     * @param referenceNode 参考节点（父节点或目标节点）
     * @param direction 方向：'right' 表示在右边，'left' 表示在左边
     */
    private calculateDefaultPosition(referenceNode: ZKNode, direction: 'right' | 'left' = 'right'): { x: number; y: number } | null {
        // 尝试从 Cytoscape 实例获取节点位置
        if (this.branchRenderer) {
            const cy = this.branchRenderer.getCytoscapeInstance();
            if (cy) {
                const nodeId = referenceNode.ID.replace(/[^a-zA-Z0-9_-]/g, '_');
                const cyNode = cy.$id(nodeId);
                
                if (cyNode.length > 0) {
                    const position = cyNode.position();
                    const offset = direction === 'right' ? 250 : -250; // 右边或左边偏移 250 像素
                    
                    return {
                        x: position.x + offset,
                        y: position.y + 50 // 稍微向下偏移 50 像素
                    };
                }
            }
        }
        
        // 如果无法从 Cytoscape 获取位置，使用保存的位置
        if (referenceNode.savedPosition) {
            const offset = direction === 'right' ? 250 : -250;
            return {
                x: referenceNode.savedPosition.x + offset,
                y: referenceNode.savedPosition.y + 50
            };
        }
        
        // 如果都没有，返回一个默认位置
        return {
            x: direction === 'right' ? 250 : -250,
            y: 100
        };
    }

    /**
     * 生成子节点 ID（基于父节点）
     */
    generateChildNodeID(parentNodeID: string): string {
        const parentParts = parentNodeID.split('.');
        const lastPart = parentParts[parentParts.length - 1];
        
        // 判断父节点最后一级是数字还是字母
        const isLastPartNumber = /^\d+$/.test(lastPart);
        const isLastPartLetter = /^[a-z]+$/.test(lastPart);
        
        if (isLastPartNumber) {
            // 父节点是数字，生成字母后缀
            return this.generateLetterSuffix(parentNodeID);
        } else if (isLastPartLetter) {
            // 父节点是字母，生成数字后缀
            return this.generateNumberSuffix(parentNodeID);
        } else {
            // 如果无法判断类型，默认生成字母后缀
            return this.generateLetterSuffix(parentNodeID);
        }
    }

    /**
     * 生成字母后缀的子节点 ID
     */
    private generateLetterSuffix(parentNodeID: string): string {
        const letters = 'abcdefghijklmnopqrstuvwxyz';

        // 获取父节点的所有子节点
        const existingChildren = this.getDirectChildren(parentNodeID);

        // 提取已存在的字母后缀
        const existingSuffixes = new Set<string>();
        existingChildren.forEach(child => {
            const parts = child.IDStr.split('.');
            const lastPart = parts[parts.length - 1];
            if (/^[a-z]+$/.test(lastPart)) {
                existingSuffixes.add(lastPart);
            }
        });

        // 找到第一个未使用的字母
        for (const letter of letters) {
            if (!existingSuffixes.has(letter)) {
                return `${parentNodeID}.${letter}`;
            }
        }

        // 如果所有单字母都用完了，使用双字母
        for (let i = 0; i < letters.length; i++) {
            for (let j = 0; j < letters.length; j++) {
                const doubleLetter = letters[i] + letters[j];
                if (!existingSuffixes.has(doubleLetter)) {
                    return `${parentNodeID}.${doubleLetter}`;
                }
            }
        }

        return `${parentNodeID}.aaa`;
    }

    /**
     * 生成数字后缀的子节点 ID
     */
    private generateNumberSuffix(parentNodeID: string): string {
        const existingChildren = this.getDirectChildren(parentNodeID);

        const existingNumbers = new Set<number>();
        existingChildren.forEach(child => {
            const parts = child.IDStr.split('.');
            const lastPart = parts[parts.length - 1];
            if (/^\d+$/.test(lastPart)) {
                existingNumbers.add(parseInt(lastPart, 10));
            }
        });

        let nextNumber = 1;
        while (existingNumbers.has(nextNumber)) {
            nextNumber++;
        }

        return `${parentNodeID}.${nextNumber}`;
    }

    /**
     * 为草稿(#20)预测一个「真实」子 id(考虑现有真实子 + 本批已预留的草稿),
     * 让布局引擎按层级把草稿摆在与真实子一致的位置/侧别(避免 id 不入流导致左右乱跳)。
     * 无父则用 free.N。规则与 generateChildNodeID 一致:父为字母→数字子,否则字母子。
     */
    private predictDraftId(parentId: string | undefined, reserved: Set<string>): string {
        if (!parentId) {
            const used = new Set<number>();
            this.mocNodes.filter(n => n.ID.startsWith('free.')).forEach(n => { const m = n.ID.match(/free\.(\d+)/); if (m) used.add(parseInt(m[1])); });
            reserved.forEach(id => { const m = id.match(/^free\.(\d+)$/); if (m) used.add(parseInt(m[1])); });
            let n = 1; while (used.has(n)) n++;
            return `free.${n}`;
        }
        const depth = parentId.split('.').length;
        const last = parentId.split('.').pop() || '';
        const useNumberChild = /^[a-z]+$/.test(last); // 父为字母 → 数字子;数字/其它 → 字母子
        const usedSegs = new Set<string>();
        this.getDirectChildren(parentId).forEach(c => usedSegs.add(c.IDStr.split('.').pop()!));
        reserved.forEach(id => {
            if (id.startsWith(parentId + '.') && id.split('.').length === depth + 1) usedSegs.add(id.split('.').pop()!);
        });
        if (useNumberChild) {
            let n = 1; while (usedSegs.has(String(n))) n++;
            return `${parentId}.${n}`;
        }
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        for (const l of letters) if (!usedSegs.has(l)) return `${parentId}.${l}`;
        for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) { const d = letters[i] + letters[j]; if (!usedSegs.has(d)) return `${parentId}.${d}`; }
        return `${parentId}.aaa`;
    }

    /**
     * 获取指定父节点的直接子节点
     */
    private getDirectChildren(parentNodeID: string): ZKNode[] {
        return this.mocNodes.filter(node => {
            const nodeIdParts = node.IDStr.split('.');
            const parentIdParts = parentNodeID.split('.');
            
            if (nodeIdParts.length !== parentIdParts.length + 1) return false;
            
            return node.IDStr.startsWith(parentNodeID + '.');
        });
    }

    /**
     * 获取节点的父节点 ID（从 ID 字符串推断）
     */
    private getParentNodeId(node: ZKNode): string | null {
        // 从 ID 字符串推断
        const parts = node.IDStr.split('.');
        if (parts.length > 1) {
            return parts.slice(0, -1).join('.');
        }

        return null;
    }
    
    private isFreeNodeID(nodeId?: string | null): boolean {
        return !!nodeId && String(nodeId).startsWith('free.');
    }

    /**
     * 解析节点的真实父级 ID。
     * 普通节点 ID 编码层级,走点号路径快路径;
     * 自由节点 (free.*) ID 是扁平的,父子关系只存在于图的 parent 边里,需查边。
     * 注意:查边依赖 cy 当前状态,删除节点前调用(删除+刷新后边已消失)。
     */
    private resolveRealParentId(nodeId?: string | null): string | null {
        const idStr = String(nodeId || '');
        if (!idStr) return null;
        if (!this.isFreeNodeID(idStr)) {
            const dotIdx = idStr.lastIndexOf('.');
            return dotIdx > 0 ? idStr.substring(0, dotIdx) : null;
        }
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return null;
        let parentId: string | null = null;
        cy.$('edge').filter((edge: any) => edge.data('type') === 'parent').forEach((edge: any) => {
            if (parentId) return;
            const targetOriginal = edge.target().data('originalNode') as ZKNode | undefined;
            const targetId = targetOriginal?.IDStr || targetOriginal?.ID;
            if (targetId !== idStr) return;
            const sourceOriginal = edge.source().data('originalNode') as ZKNode | undefined;
            parentId = sourceOriginal?.IDStr || sourceOriginal?.ID || null;
        });
        return parentId;
    }

    /**
     * 取节点的真实直接子节点 ID(基于图的 parent 边,自由节点同样适用)。
     */
    private getRealChildNodeIds(parentNodeId: string): string[] {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return [];
        const children: string[] = [];
        cy.$('edge').filter((edge: any) => edge.data('type') === 'parent').forEach((edge: any) => {
            const sourceOriginal = edge.source().data('originalNode') as ZKNode | undefined;
            const sourceId = sourceOriginal?.IDStr || sourceOriginal?.ID;
            if (sourceId !== parentNodeId) return;
            const targetOriginal = edge.target().data('originalNode') as ZKNode | undefined;
            const targetId = targetOriginal?.IDStr || targetOriginal?.ID;
            if (targetId) children.push(targetId);
        });
        return children;
    }

    /**
     * 父节点下是否存在 auto 布局子节点(自由父 + 自动子场景判断)。
     */
    private hasAutoLayoutChild(parentNodeId: string): boolean {
        return this.getRealChildNodeIds(parentNodeId).some((id) => this.isNodeAutoLayout(id));
    }

    private getBranchStylePalette(): string[] {
        return ['#ff5a5f', '#ff8a3d', '#f7c948', '#56d364', '#38d9a9', '#4dabf7', '#9775fa', '#f06595'];
    }

    private pickNextBranchStyleColor(existing: Record<string, string>): string {
        const palette = this.getBranchStylePalette();
        const used = new Set(Object.values(existing || {}).filter(Boolean));
        const unused = palette.find((c) => !used.has(c));
        if (unused) return unused;
        return palette[Math.floor(Math.random() * palette.length)];
    }

    /**
     * 生成兄弟节点 ID
     */
    private generateSiblingID(currentNodeId: string): string {
        // 获取父节点 ID
        const parts = currentNodeId.split('.');
        if (parts.length === 1) {
            // 根节点，需要生成新的根节点
            // 找到所有根节点并生成下一个
            const rootNodes = this.mocNodes.filter(n => !n.IDStr.includes('.'));
            if (rootNodes.length === 0) {
                return '1';
            }

            // 检查是否是数字根节点
            const allNumber = rootNodes.every(n => /^\d+$/.test(n.IDStr));
            if (allNumber) {
                const maxNum = Math.max(...rootNodes.map(n => parseInt(n.IDStr, 10)));
                return String(maxNum + 1);
            }

            // 混合类型，返回第一个字母
            return 'a';
        }

        const parentId = parts.slice(0, -1).join('.');

        // 使用现有的 generateChildNodeID 方法，它会在父节点下生成新的子节点 ID
        return this.generateChildNodeID(parentId);
    }

    /**
     * 生成父节点 ID
     */
    private generateParentID(currentNodeId: string): string {
        const parts = currentNodeId.split('.');

        if (parts.length === 1) {
            // 根节点，创建一个新的根级别节点
            return this.generateSiblingID(currentNodeId);
        }

        if (parts.length === 2) {
            // 第一层子节点（如 "1.a"），在根级别创建新的父节点
            const rootId = parts[0];
            return this.generateChildNodeID(rootId);
        }

        // 更深层级的节点，创建一个新的分支
        // 例如："1.1.a" -> 创建 "1.2" 作为新父节点
        const grandParentId = parts.slice(0, -2).join('.');
        const newBranchId = this.generateChildNodeID(grandParentId);

        return newBranchId;
    }

    /**
     * 从活动节点创建子节点（Tab 键）
     */
    /** 在选中的草稿上 Tab/Enter:创建子/兄弟草稿(纯内存),并打开内联编辑器 */
    private createDraftRelativeToActive(activeDraftId: string, mode: 'child' | 'sibling'): void {
        const di = this.draftNodes.get(activeDraftId);
        if (!di) return;
        // child: 父=该草稿;sibling: 父=该草稿的父(草稿父或真实父)
        const parentRef = mode === 'child' ? activeDraftId : (di.parentDraftId || di.parentRealId);
        const ids = this.injectDraftNodes([{ content: '', parentRealId: parentRef }], di.origin);
        const newId = ids[0];
        if (newId) {
            const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
            branchGraphDiv?.dispatchEvent(new CustomEvent('open-inline-editor-for', { detail: { nodeId: newId } }));
        }
    }

    async createChildNodeFromActive(activeNodeId: string, position: { x: number; y: number }) {
        // 选中的是草稿节点(#20):创建子草稿,不走真实节点流程
        if (this.draftNodes.has(activeNodeId)) {
            this.createDraftRelativeToActive(activeNodeId, 'child');
            return;
        }
        // 查找活动节点
        const activeNode = this.mocNodes.find(n => n.IDStr === activeNodeId || n.ID === activeNodeId);
        if (!activeNode) {
            new Notice(t("Active node not found"));
            return;
        }

        const placeholderLayoutStyle = this.resolvePlaceholderLayoutStyle(activeNode.IDStr);
        const finalPosition = placeholderLayoutStyle === 'auto'
            ? this.getAutoPlaceholderPosition(activeNode.IDStr, position)
            : position;

        // 直接创建占位符节点，指定父节点
        await this.createPlaceholderNode(finalPosition, activeNode.IDStr);
    }

    /**
     * 从活动节点创建兄弟节点（Enter 键）
     */
    async createSiblingNodeFromActive(activeNodeId: string, position: { x: number; y: number }) {
        // 选中的是草稿节点(#20):创建兄弟草稿(与其同父)
        if (this.draftNodes.has(activeNodeId)) {
            this.createDraftRelativeToActive(activeNodeId, 'sibling');
            return;
        }
        // 查找活动节点
        const activeNode = this.mocNodes.find(n => n.IDStr === activeNodeId || n.ID === activeNodeId);
        if (!activeNode) {
            console.error('[indexView] 未找到活动节点', activeNodeId);
            new Notice(t("Active node not found"));
            return;
        }

        // 获取父节点 ID
        const parentId = this.getParentNodeId(activeNode);
        if (!parentId) {
            console.error('[indexView] 无法找到父节点', activeNodeId);
            new Notice(t("Parent node not found cannot create sibling"));
            return;
        }

        // 生成兄弟节点 ID
        const siblingId = this.generateSiblingID(activeNodeId);

        // 创建占位符节点，指定父节点
        const tempId = `temp_${Date.now()}`;

        // 存储占位符信息
        const placeholderLayoutStyle = this.resolvePlaceholderLayoutStyle(parentId);
        const effectiveSuggestedId = this.isFreeNodeID(parentId) ? this.generateNextFreeNodeID() : siblingId;
        const finalPosition = placeholderLayoutStyle === 'auto'
            ? this.getAutoPlaceholderPosition(parentId, position, activeNode.IDStr)
            : position;
        this.createPlaceholderRecord(tempId, finalPosition, {
            parentNodeId: parentId,
            suggestedNodeId: effectiveSuggestedId,
            layoutStyle: placeholderLayoutStyle,
        });

        // 通知 Cytoscape 渲染器添加占位符节点
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
 
            branchGraphDiv.dispatchEvent(new CustomEvent('add-placeholder-node', {
                detail: {
                    nodeId: tempId,
                    position: finalPosition,
                    parentNodeId: parentId,
                    suggestedNodeId: effectiveSuggestedId
                }
            }));
            // auto 布局:占位时就让现有兄弟为占位符让位(预览,不落盘)
            if (placeholderLayoutStyle === 'auto') {
                await this.previewReflowForPlaceholder(parentId, tempId, activeNode.IDStr);
            }
        } else {
            console.error('[indexView] 未找到 branchGraphDiv');
        }
    }

    /**
     * 从活动节点创建父节点（Shift+Tab 键）
     */
    async createParentNodeFromActive(activeNodeId: string, position: { x: number; y: number }) {
        // 草稿节点(#20)尚未落地,不支持为其插入父节点
        if (this.draftNodes.has(activeNodeId)) {
            new Notice(t("Draft no parent op"));
            return;
        }
        // 查找活动节点
        const activeNode = this.mocNodes.find(n => n.IDStr === activeNodeId || n.ID === activeNodeId);
        if (!activeNode) {
            new Notice(t("Active node not found"));
            return;
        }

        // 生成父节点 ID
        const parentId = this.generateParentID(activeNodeId);

        // 创建占位符节点（不指定父节点，因为这就是父节点）
        const tempId = `temp_${Date.now()}`;

        // 存储占位符信息
        const placeholderLayoutStyle = this.resolvePlaceholderLayoutStyle(this.getParentNodeId(activeNode) || undefined);
        const effectiveSuggestedId = this.isFreeNodeID(parentId) ? this.generateNextFreeNodeID() : parentId;
        this.createPlaceholderRecord(tempId, position, {
            suggestedNodeId: effectiveSuggestedId,
            childNodeId: activeNodeId,
            layoutStyle: placeholderLayoutStyle
        });

        // 通知 Cytoscape 渲染器添加占位符节点
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('add-placeholder-node', {
                detail: {
                    nodeId: tempId,
                    position: position,
                    parentNodeId: undefined,
                    suggestedNodeId: effectiveSuggestedId,
                    childNodeId: activeNodeId  // 标记需要将当前节点移到新父节点下
                }
            }));
        }
    }

    /**
     * 创建占位符节点（临时节点，未完成编辑）
     * @param position 节点位置
     * @param explicitParentId 显式指定的父节点 ID（可选，如果提供则跳过智能连线并预生成节点 ID）
     */
    async createPlaceholderNode(position: { x: number; y: number }, explicitParentId?: string) {
        const tempId = `temp_${Date.now()}`;

        // 确定父节点 ID、占位符布局风格和预生成的节点 ID
        let parentNodeId: string | undefined = undefined;
        let suggestedNodeId: string | undefined = undefined;
        let placeholderLayoutStyle: 'free' | 'auto' = this.resolvePlaceholderLayoutStyle();

        // 优先使用显式指定的父节点 ID
        if (explicitParentId) {
            parentNodeId = explicitParentId;
            placeholderLayoutStyle = this.resolvePlaceholderLayoutStyle(parentNodeId);
            suggestedNodeId = this.isFreeNodeID(explicitParentId)
                ? this.generateNextFreeNodeID()
                : this.generateChildNodeID(explicitParentId);
    
        }
        // 否则，仅在启用了「智能连线」时才查找最近节点并作为父节点。
        // 注意：auto 布局文件也尊重该开关——关闭时背景新建的节点为游离节点，
        // 不会自动挂到最近节点（不再无视开关强制连边）。
        else if (this.plugin.settings.smartConnection) {
            let nearestNode: ZKNode | null = null;
            let minDistance = Infinity;
            const PROXIMITY_THRESHOLD = 250;  // 250px 范围

            // 优先使用 Cytoscape 实时坐标（最准确），回退到解析后的 savedPosition
            const cy = this.branchRenderer?.getCytoscapeInstance();
            if (cy) {
                cy.nodes('[!isGroup]').forEach((cyNode: any) => {
                    const data = cyNode.data();
                    const originalNode = data?.originalNode as ZKNode | undefined;
                    if (!originalNode || originalNode.isCrossDomain) return;
                    if (data?.isPlaceholder) return;

                    const nodePos = cyNode.position();
                    const distance = Math.hypot(position.x - nodePos.x, position.y - nodePos.y);
                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestNode = originalNode;
                    }
                });
            } else {
                for (const node of this.mocNodes) {
                    if (!node.savedPosition) continue;
                    const distance = Math.hypot(
                        position.x - node.savedPosition.x,
                        position.y - node.savedPosition.y
                    );
                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestNode = node;
                    }
                }
            }

            // auto 模式：只要存在可用节点就挂载到最近节点，避免回落到 free.*
            // free 模式 + smartConnection：继续沿用阈值限制
            if (nearestNode) {
                const shouldAttachByDistance = this.isAutoNodeLayoutStyle() || minDistance < PROXIMITY_THRESHOLD;
                if (shouldAttachByDistance) {
                    parentNodeId = nearestNode.IDStr;
                    placeholderLayoutStyle = this.resolvePlaceholderLayoutStyle(parentNodeId);
                    suggestedNodeId = this.isFreeNodeID(parentNodeId)
                        ? this.generateNextFreeNodeID()
                        : this.generateChildNodeID(parentNodeId);
                }
            }
        }

        const finalPosition = parentNodeId && placeholderLayoutStyle === 'auto'
            ? this.getAutoPlaceholderPosition(parentNodeId, position)
            : position;

        // 存储占位符信息（包括潜在的父节点ID和预生成的节点ID）
        this.createPlaceholderRecord(tempId, finalPosition, {
            parentNodeId: parentNodeId,
            suggestedNodeId: suggestedNodeId,
            layoutStyle: placeholderLayoutStyle
        });

        // 直接通过事件通知 Cytoscape 渲染器添加占位符节点
        // 注意：要在 branchGraphDiv (zk-graph-cytoscape) 上派发事件，而不是 indexMermaidDiv
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('add-placeholder-node', {
                detail: {
                    nodeId: tempId,
                    position: finalPosition,
                    parentNodeId: parentNodeId,  // 传递父节点ID用于显示连接
                    suggestedNodeId: suggestedNodeId  // 传递预生成的节点ID
                }
            }));
            // auto 布局:占位时就让现有兄弟为占位符让位(预览,不落盘)
            if (parentNodeId && placeholderLayoutStyle === 'auto') {
                await this.previewReflowForPlaceholder(parentNodeId, tempId);
            }
        }
    }

    /**
     * 完成占位符节点，创建文件节点
     */
    private async finalizeFileNode(
        tempId: string,
        wikiLink: string,
        label: string,
        position: { x: number; y: number },
        isEmbed: boolean = false,
        alias?: string
    ): Promise<void> {
        // 获取占位符信息
        const placeholderInfo = this.placeholderNodes.get(tempId);

        // 优先使用预生成的节点 ID，否则生成新的自由节点 ID
        const suggestedID = placeholderInfo?.suggestedNodeId || this.generateNextFreeNodeID();

        // 查找文件：剥离 #heading / #^blockRef，只用文件路径部分解析
        const hashIdx = wikiLink.indexOf('#');
        const wikiPathOnly = hashIdx >= 0 ? wikiLink.substring(0, hashIdx) : wikiLink;
        const file = this.app.metadataCache.getFirstLinkpathDest(wikiPathOnly, '');

        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);

        // 检查是否有智能连线确定的父节点
        if (placeholderInfo && placeholderInfo.parentNodeId) {
            // 先创建为自由节点，然后移动到父节点下
            await this.saveFreeNodeToMOC({
                wikiLink: wikiLink,
                alias,
                nodeID: suggestedID,
                relationText: '',
                file: file,
                isTextOnly: false,  // 标记为文件节点
                isEmbed
            });

            // 然后移动到父节点下
            if (mocFile) {
                if (this.isFreeNodeID(suggestedID) || this.isFreeNodeID(placeholderInfo.parentNodeId)) {
                    await this.addArrowRelationToMOC(mocFile, placeholderInfo.parentNodeId, suggestedID, '');
                } else {
                    await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
                }
            }
        } else {
            // 保存到 MOC
            await this.saveFreeNodeToMOC({
                wikiLink: wikiLink,
                alias,
                nodeID: suggestedID,
                relationText: '',
                file: file,
                isTextOnly: false,  // 标记为文件节点
                isEmbed
            });
        }

        if (placeholderInfo?.childNodeId && mocFile) {
            if (this.isFreeNodeID(suggestedID) || this.isFreeNodeID(placeholderInfo.childNodeId)) {
                await this.addArrowRelationToMOC(mocFile, suggestedID, placeholderInfo.childNodeId, '');
            } else {
                const newChildID = this.generateChildNodeID(suggestedID);
                await this.mocHandler.moveNodeToParent(mocFile, placeholderInfo.childNodeId, suggestedID, newChildID);
            }
        }

        // 保存位置
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (mocFile) {
            const finalPosition = placeholderInfo?.position || position;
            await this.savePlaceholderLayoutPositions(
                mocFile,
                suggestedID,
                finalPosition
            );
        }

        // 从占位符追踪中移除
        this.placeholderNodes.delete(tempId);

        // 刷新视图
        await this.refreshBranchMermaid();

        // 声明式 reflow: 让算法重新分配整棵树的空间, 给新节点腾位置,
        // 同时回收被删/移动节点留下的空缺。手动拖过的节点作为锚点保留。
        if (this.isNodeAutoLayout(suggestedID)) {
            await this.applyNewSiblingSide(suggestedID);
            await this.reflowAutoLayout(suggestedID);
        }

        // 清理所有占位符连接线（因为视图已经刷新，占位符节点已不存在）
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('cleanup-all-placeholder-connections'));
        }

        // 自动选中新创建的节点
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('select-node-by-id', {
                detail: {
                    nodeId: suggestedID
                }
            }));
        }
    }

    /**
     * 完成占位符节点，创建纯文字节点
     */
    private async finalizeTextOnlyNode(
        tempId: string,
        text: string,
        position: { x: number; y: number },
        nodeSize?: { width: number; height: number }
    ): Promise<void> {
        // 获取占位符信息
        const placeholderInfo = this.placeholderNodes.get(tempId);

        // 优先使用预生成的节点 ID，否则生成新的自由节点 ID
        const suggestedID = placeholderInfo?.suggestedNodeId || this.generateNextFreeNodeID();

        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);

        // 检查是否有智能连线确定的父节点
        if (placeholderInfo && placeholderInfo.parentNodeId) {
            // 先创建为自由节点，然后移动到父节点下
            await this.saveFreeNodeToMOC({
                text: text,  // 纯文字内容
                nodeID: suggestedID,
                relationText: '',
                file: null,  // 无文件关联
                isTextOnly: true  // 标记为纯文字节点
            });

            // 然后移动到父节点下
            if (mocFile) {
                if (this.isFreeNodeID(suggestedID) || this.isFreeNodeID(placeholderInfo.parentNodeId)) {
                    await this.addArrowRelationToMOC(mocFile, placeholderInfo.parentNodeId, suggestedID, '');
                } else {
                    await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
                }
            }
        } else {
            // 保存到 MOC（不关联文件）
            await this.saveFreeNodeToMOC({
                text: text,  // 纯文字内容
                nodeID: suggestedID,
                relationText: '',
                file: null,  // 无文件关联
                isTextOnly: true  // 标记为纯文字节点
            });
        }

        if (placeholderInfo?.childNodeId && mocFile) {
            if (this.isFreeNodeID(suggestedID) || this.isFreeNodeID(placeholderInfo.childNodeId)) {
                await this.addArrowRelationToMOC(mocFile, suggestedID, placeholderInfo.childNodeId, '');
            } else {
                const newChildID = this.generateChildNodeID(suggestedID);
                await this.mocHandler.moveNodeToParent(mocFile, placeholderInfo.childNodeId, suggestedID, newChildID);
            }
        }

        // 保存位置
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (mocFile) {
            const finalPosition = placeholderInfo?.position || position;
            await this.savePlaceholderLayoutPositions(
                mocFile,
                suggestedID,
                finalPosition
            );
        }

        // 文本节点必须保持自动尺寸。占位符编辑尺寸只用于文件/嵌入节点，
        // 这里主动清掉同 ID 可能残留的尺寸，避免首次创建后被 manual 宽度锁住。
        if (mocFile) {
            await this.clearEmbedNodeSizeFromMOC(mocFile, suggestedID);
        }

        // 从占位符追踪中移除
        this.placeholderNodes.delete(tempId);

        // 刷新视图
        await this.refreshBranchMermaid();

        // 声明式 reflow: 让算法重新分配整棵树的空间, 给新节点腾位置,
        // 同时回收被删/移动节点留下的空缺。手动拖过的节点作为锚点保留。
        if (this.isNodeAutoLayout(suggestedID)) {
            await this.applyNewSiblingSide(suggestedID);
            await this.reflowAutoLayout(suggestedID);
        }

        // 清理所有占位符连接线（因为视图已经刷新，占位符节点已不存在）
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('cleanup-all-placeholder-connections'));
        }

        // 自动选中新创建的节点
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('select-node-by-id', {
                detail: {
                    nodeId: suggestedID
                }
            }));
        }
    }

    /**
     * 如果节点是 ![[image]] 嵌入图片节点，删除 attachments 中对应的图片文件
     */
    private async deleteImageFileIfNeeded(node: ZKNode): Promise<void> {
        if (!node.isEmbed || !node.file) return;

        const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
        const ext = node.file.path.split('.').pop()?.toLowerCase() || '';
        if (!IMAGE_EXTENSIONS.has(ext)) return;

        try {
            const file = this.app.vault.getAbstractFileByPath(node.file.path);
            if (file) {
                const fileManager = this.app.fileManager as any;
                if (typeof fileManager.trashFile === 'function') {
                    await fileManager.trashFile(file);
                } else {
                    await (this.app.vault as any).trash(file, true);
                }
            }
        } catch (error) {
            console.error('Failed to delete image file:', error);
        }
    }

    /** 从文本中抽出所有嵌入 ![[...]] 的 linkpath(去掉别名 | 与锚点 #) */
    private extractEmbedLinkpaths(text: string): string[] {
        const out: string[] = [];
        const re = /!\[\[([^\]\n]+?)\]\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const lp = m[1].split('|')[0].split('#')[0].trim();
            if (lp) out.push(lp);
        }
        return out;
    }

    /** 收集文本节点内容里嵌入的附件文件(非 md / 非 moc)。需在删除前调用(删除后内容已没了)。 */
    private collectNodeEmbeddedAttachments(node: ZKNode, mocPath: string): TFile[] {
        if (!node?.isTextOnly) return [];
        const content = this.decodeMultilineText(node.title || '');
        const files: TFile[] = [];
        const seen = new Set<string>();
        for (const lp of this.extractEmbedLinkpaths(content)) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(lp, mocPath);
            if (dest instanceof TFile && !seen.has(dest.path)) {
                const ext = dest.extension.toLowerCase();
                if (ext !== 'md' && !isMocPath(dest.path)) {
                    files.push(dest);
                    seen.add(dest.path);
                }
            }
        }
        return files;
    }

    /**
     * 判断附件在全库是否仍被引用:
     *  1) 普通笔记的链接/嵌入走 metadataCache.resolvedLinks;
     *  2) MOC 的嵌入写在 JSON 节点里,metadataCache 不索引,需逐个 MOC 读原文解析。
     * 调用时机应在目标节点已从 MOC 移除之后,这样不会把"自己"算成引用。
     */
    private async isFileReferencedAnywhere(file: TFile): Promise<boolean> {
        const resolved = (this.app.metadataCache as any).resolvedLinks || {};
        for (const src of Object.keys(resolved)) {
            if (resolved[src] && resolved[src][file.path]) return true;
        }
        const mocFiles = this.app.vault.getFiles().filter((f) => isMocPath(f.path));
        for (const moc of mocFiles) {
            let text: string;
            try { text = await this.app.vault.cachedRead(moc); } catch { continue; }
            if (!text.includes('![[')) continue;
            for (const lp of this.extractEmbedLinkpaths(text)) {
                const dest = this.app.metadataCache.getFirstLinkpathDest(lp, moc.path);
                if (dest?.path === file.path) return true;
            }
        }
        return false;
    }

    /** 删除节点后:全库再无引用的附件,确认后移入回收站(删除前收集、删除后判断)。 */
    private async deleteOrphanedAttachments(files: TFile[]): Promise<void> {
        if (!files.length) return;
        // 去重 + 仅保留仍存在且全库无引用的孤儿
        const seen = new Set<string>();
        const orphans: TFile[] = [];
        for (const file of files) {
            if (seen.has(file.path)) continue;
            seen.add(file.path);
            const cur = this.app.vault.getAbstractFileByPath(file.path);
            if (!(cur instanceof TFile)) continue;
            if (await this.isFileReferencedAnywhere(cur)) continue;
            orphans.push(cur);
        }
        if (!orphans.length) return;

        const confirmed = await this.showAttachmentDeleteConfirmDialog(orphans);
        if (!confirmed) return;

        for (const file of orphans) {
            try {
                const fileManager = this.app.fileManager as any;
                if (typeof fileManager.trashFile === 'function') {
                    await fileManager.trashFile(file);
                } else {
                    await (this.app.vault as any).trash(file, true);
                }
            } catch (error) {
                console.error('Failed to delete orphaned attachment:', file?.path, error);
            }
        }
    }

    /** 孤儿附件回收前的确认弹窗(列出将被移入回收站的文件)。 */
    private showAttachmentDeleteConfirmDialog(files: TFile[]): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(t("Confirm delete attachments"));

            const { contentEl } = modal;
            contentEl.empty();
            contentEl.setCssStyles({ padding: '20px' });

            const desc = contentEl.createDiv({ text: t("These attachments are no longer referenced") });
            desc.setCssStyles({
                color: 'var(--text-muted)',
                marginBottom: '12px',
            });

            const list = contentEl.createEl('ul');
            list.setCssStyles({
                margin: '0 0 8px 0',
                paddingLeft: '20px',
                maxHeight: '180px',
                overflowY: 'auto',
            });
            files.forEach((file) => {
                const li = list.createEl('li', { text: file.path });
                li.setCssStyles({
                    color: 'var(--text-normal)',
                    marginBottom: '4px',
                    wordBreak: 'break-all',
                });
            });

            const buttonContainer = contentEl.createDiv();
            buttonContainer.setCssStyles({
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                marginTop: '20px',
            });

            const cancelButton = buttonContainer.createEl('button', { text: t("Keep attachments") });
            cancelButton.setCssStyles({
                padding: '6px 16px',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                backgroundColor: 'var(--background-primary)',
                color: 'var(--text-normal)',
                cursor: 'pointer',
            });
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(false);
            });

            const confirmButton = buttonContainer.createEl('button', { text: t("Delete attachments") });
            confirmButton.setCssStyles({
                padding: '6px 16px',
                border: 'none',
                borderRadius: '4px',
                backgroundColor: '#ef4444',
                color: '#ffffff',
                cursor: 'pointer',
            });
            confirmButton.addEventListener('click', () => {
                modal.close();
                resolve(true);
            });

            // 关闭(点遮罩/Esc)= 保留,不删
            const origOnClose = modal.onClose.bind(modal);
            modal.onClose = () => { origOnClose(); resolve(false); };

            modal.open();
        });
    }

    /**
     * 处理剪贴板粘贴图片事件
     * 将图片保存到 attachments 子目录，并创建文件节点
     */
    private async handleImagePaste(event: ClipboardEvent): Promise<void> {
        if (this.isMobileReadOnly()) return;

        const items = event.clipboardData?.items;
        if (!items) return;

        // 查找剪贴板中的图片
        let imageItem: DataTransferItem | null = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                imageItem = items[i];
                break;
            }
        }
        if (!imageItem) return;

        // 阻止默认粘贴行为
        event.preventDefault();

        const blob = imageItem.getAsFile();
        if (!blob) return;

        // 根据 MIME 类型确定扩展名
        const mimeToExt: Record<string, string> = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp'
        };
        const ext = mimeToExt[imageItem.type] || 'png';

        // 获取 MOC 文件信息
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (!mocFilePath) return;
        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (!mocFile) return;

        // 构建保存路径: {mocFileDir}/attachments/{mocBasename}-{timestamp}.{ext}
        const mocDir = mocFile.parent?.path || '';
        const attachDir = mocDir ? `${mocDir}/attachments` : 'attachments';
        const timestamp = Date.now();
        const mocBasename = mocFile.basename;
        const fileName = `${mocBasename}-${timestamp}.${ext}`;
        const savePath = `${attachDir}/${fileName}`;

        try {
            // 确保 attachments 文件夹存在
            if (!this.app.vault.getAbstractFileByPath(attachDir)) {
                await this.app.vault.createFolder(attachDir);
            }

            // 保存图片文件
            const arrayBuffer = await blob.arrayBuffer();
            const savedFile = await this.app.vault.createBinary(savePath, arrayBuffer);

            // 计算视口中心位置（模型坐标）
            const cy = this.branchRenderer?.getCytoscapeInstance();
            let position = { x: 0, y: 0 };
            if (cy) {
                const pan = cy.pan();
                const zoom = cy.zoom();
                position = {
                    x: (cy.width() / 2 - pan.x) / zoom,
                    y: (cy.height() / 2 - pan.y) / zoom
                };
            }

            // 生成节点 ID 并保存到 MOC
            const nodeID = this.generateNextFreeNodeID();
            await this.saveFreeNodeToMOC({
                wikiLink: savedFile.path,
                nodeID: nodeID,
                relationText: '',
                file: savedFile as TFile,
                isTextOnly: false,
                isEmbed: true
            });

            // 保存节点位置
            await this.saveNodePositionToMOC(mocFile, nodeID, position);

            // 刷新视图
            await this.refreshBranchMermaid();

            new Notice(t('Paste image success'));
        } catch (error) {
            console.error('Failed to paste image:', error);
            new Notice(t('Paste image failed'));
        }
    }

    private isAutoNodeLayoutStyle(): boolean {
        return this.currentNodeLayoutStyle === 'auto';
    }

    /**
     * 从节点 ID 向上寻找最近的祖先布局覆盖；找不到则返回文件默认
     */
    private getEffectiveNodeLayoutStyle(
        nodeId: string,
        overrides: Record<string, 'auto' | 'free'> = this.currentNodeLayoutOverrides,
        fileDefault: 'auto' | 'free' = this.currentNodeLayoutStyle
    ): 'auto' | 'free' {
        let current: string = nodeId;
        while (current.length > 0) {
            const override = overrides[current];
            if (override !== undefined) return override;
            const parts: string[] = current.split('.');
            if (parts.length <= 1) break;
            current = parts.slice(0, -1).join('.');
        }
        return fileDefault;
    }

    /**
     * 判断某个节点是否启用自动布局（沿父级链继承，最后回退到文件级默认）
     */
    private isNodeAutoLayout(nodeId: string): boolean {
        // 草稿节点(#20)无自身布局覆盖:其预测 id 即真实层级前缀(如 1.d.4 / 1.d.4.1),
        // 故与真实节点共用同一套溯源逻辑——沿父级链上溯 overrides,最后回退文件默认。
        // 关键:不能只看文件级默认(currentNodeLayoutStyle),否则 free 默认文件里的 auto 分支
        // (如 1.d 有 override:auto)上的草稿会被误判为 free → 退化成固定步长堆叠重叠。
        return this.getEffectiveNodeLayoutStyle(nodeId) === 'auto';
    }

    private resolvePlaceholderLayoutStyle(parentNodeId?: string): 'free' | 'auto' {
        if (parentNodeId) {
            return this.isNodeAutoLayout(parentNodeId) ? 'auto' : 'free';
        }
        return this.isAutoNodeLayoutStyle() ? 'auto' : 'free';
    }

    private getNodePositionForLayout(nodeId: string): { x: number; y: number } | null {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (cy) {
            const cyNode: any = cy.$('node').filter((node: any) => {
                const originalNode = node.data('originalNode');
                return originalNode && (originalNode.IDStr === nodeId || originalNode.ID === nodeId);
            }).first();
            if (cyNode && cyNode.length > 0) {
                const pos = cyNode.position();
                return { x: pos.x, y: pos.y };
            }
        }

        const node = this.mocNodes.find((n) => n.IDStr === nodeId || n.ID === nodeId);
        return node?.savedPosition ? { ...node.savedPosition } : null;
    }

    private getNodeSizeForLayout(nodeId: string): { width: number; height: number } {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (cy) {
            const cyNode: any = cy.$('node').filter((node: any) => {
                const originalNode = node.data('originalNode');
                return originalNode && (originalNode.IDStr === nodeId || originalNode.ID === nodeId);
            }).first();
            if (cyNode && cyNode.length > 0) {
                return { width: cyNode.outerWidth(), height: cyNode.outerHeight() };
            }
        }
        return { width: 200, height: 80 };
    }

    private computeSiblingSlotGap(referenceNodeId: string, axis: { x: number; y: number }): number {
        const size = this.getNodeSizeForLayout(referenceNodeId);
        const projected = Math.abs(size.width * axis.x) + Math.abs(size.height * axis.y);
        return projected + 56;
    }

    private getChildNodeIds(parentNodeId: string): string[] {
        return this.mocNodes
            .filter((node) => this.getParentNodeId(node) === parentNodeId)
            .map((node) => node.IDStr || node.ID);
    }

    private collectAutoLayoutSubtreeIds(parentNodeId: string, includeId?: string): string[] {
        const result = new Set<string>();
        const stack = [...this.getChildNodeIds(parentNodeId)];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (result.has(id)) continue;
            if (!this.isNodeAutoLayout(id)) continue;
            result.add(id);
            for (const childId of this.getChildNodeIds(id)) stack.push(childId);
        }
        if (includeId) result.add(includeId);
        return Array.from(result);
    }

    private isMocRootNodeId(nodeId: string): boolean {
        return this.mocNodes.some((node) => node.isRoot && (node.IDStr === nodeId || node.ID === nodeId));
    }

    private getFirstLevelBranchId(nodeId: string): string | null {
        const parts = nodeId.split('.');
        if (parts.length < 2) return null;
        return parts.slice(0, 2).join('.');
    }

    private getPresetForChildren(parentNodeId: string): LayoutPreset {
        if (this.isMocRootNodeId(parentNodeId)) {
            return this.currentLayoutPreset;
        }
        const branchId = this.getFirstLevelBranchId(parentNodeId);
        if (!branchId) return this.currentLayoutPreset;
        return normalizeLayoutPreset(this.currentNodeLayoutPresets[branchId], this.currentLayoutPreset);
    }

    private getNodeDirectionFromParent(nodeId: string, fallbackPreset: LayoutPreset): GrowthDirection {
        const node = this.mocNodes.find((n) => n.IDStr === nodeId || n.ID === nodeId);
        const parentId = node ? this.getParentNodeId(node) : null;
        const nodePos = this.getNodePositionForLayout(nodeId);
        const parentPos = parentId ? this.getNodePositionForLayout(parentId) : null;
        if (nodePos && parentPos) {
            return quantizeToPool(nodePos.x - parentPos.x, nodePos.y - parentPos.y, PRESET_POOL[fallbackPreset]);
        }
        return PRESET_POOL[fallbackPreset][0];
    }

    private getAutoStackAxis(dir: GrowthDirection, preset: LayoutPreset): { x: number; y: number } {
        if (preset === 'bidirectional') {
            return { x: 0, y: 1 };
        }
        if (preset === 'top-down') {
            return { x: 1, y: 0 };
        }
        return stackAxisOf(dir);
    }

    private getAutoChildDirectionalDistance(parentNodeId: string, dir: GrowthDirection): number {
        const parentSize = this.getNodeSizeForLayout(parentNodeId);
        const dirVec = DIR_VECTORS[dir];
        const isHorizontal = Math.abs(dirVec.x) >= Math.abs(dirVec.y);
        const parentSpan = isHorizontal ? parentSize.width : parentSize.height;
        const placeholderSpan = isHorizontal ? 240 : 90;
        const gap = this.isMocRootNodeId(parentNodeId) ? 120 : 72;
        return Math.max(220, parentSpan / 2 + placeholderSpan / 2 + gap);
    }

    private getAutoPlaceholderPosition(
        parentNodeId: string,
        fallbackPosition: { x: number; y: number },
        referenceNodeId?: string
    ): { x: number; y: number } {
        const parentPos = this.getNodePositionForLayout(parentNodeId);
        if (!parentPos) return fallbackPosition;

        const preset = this.getPresetForChildren(parentNodeId);
        const pool = PRESET_POOL[preset];
        const childIds = this.getChildNodeIds(parentNodeId);
        const sameParentReference = referenceNodeId && childIds.includes(referenceNodeId) ? referenceNodeId : undefined;

        let direction: GrowthDirection;
        if (sameParentReference) {
            direction = this.getNodeDirectionFromParent(sameParentReference, preset);
        } else if (childIds.length > 0) {
            const lastChild = childIds[childIds.length - 1];
            direction = this.getNodeDirectionFromParent(lastChild, preset);
        } else {
            const inherited = this.getNodeDirectionFromParent(parentNodeId, preset);
            direction = pool.includes(inherited) ? inherited : pool[0];
        }
        const stackAxis = this.getAutoStackAxis(direction, preset);

        let referenceId = sameParentReference;
        if (!referenceId && childIds.length > 0) {
            const sameDirSiblings = childIds.filter((childId) =>
                this.getNodeDirectionFromParent(childId, preset) === direction
            );
            if (sameDirSiblings.length > 0) {
                referenceId = sameDirSiblings.reduce((best, candidate) => {
                    const bestPos = this.getNodePositionForLayout(best);
                    const candPos = this.getNodePositionForLayout(candidate);
                    if (!bestPos || !candPos) return best;
                    const bestProj = (bestPos.x - parentPos.x) * stackAxis.x + (bestPos.y - parentPos.y) * stackAxis.y;
                    const candProj = (candPos.x - parentPos.x) * stackAxis.x + (candPos.y - parentPos.y) * stackAxis.y;
                    return candProj > bestProj ? candidate : best;
                });
            }
        }
        const referencePos = referenceId ? this.getNodePositionForLayout(referenceId) : null;

        let initial: { x: number; y: number };
        if (referencePos && referenceId) {
            // 选中参考(同父)时落在参考与其下一个兄弟"之间"(半槽),使排序正好插在参考之后;
            // 否则(追加到同向最远兄弟之后)用整槽接到末尾。
            const siblingGap = this.computeSiblingSlotGap(referenceId, stackAxis)
                * (sameParentReference ? 0.5 : 1);
            initial = {
                x: referencePos.x + stackAxis.x * siblingGap,
                y: referencePos.y + stackAxis.y * siblingGap
            };
        } else {
            const dirVec = DIR_VECTORS[direction];
            const directionalDistance = this.getAutoChildDirectionalDistance(parentNodeId, direction);
            initial = {
                x: parentPos.x + dirVec.x * directionalDistance,
                y: parentPos.y + dirVec.y * directionalDistance
            };
        }

        // 防止占位符落在表兄/其他子树节点上,沿 stackAxis 推开直到无碰撞
        return this.avoidPlaceholderCollision(initial, stackAxis, parentNodeId, childIds, referenceId);
    }

    /**
     * 检测占位符位置是否与现有可见节点发生 AABB 碰撞;
     * 若有则沿 stackAxis 方向递推,直到无碰撞或达到上限
     */
    private avoidPlaceholderCollision(
        initial: { x: number; y: number },
        stackAxis: { x: number; y: number },
        parentNodeId: string,
        sameParentChildIds: string[],
        referenceId?: string
    ): { x: number; y: number } {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return initial;

        const axisLen = Math.hypot(stackAxis.x, stackAxis.y);
        if (axisLen < 1e-6) return initial;

        // 占位符可能尺寸 (与 getAutoChildDirectionalDistance 中的 240/90 保持一致)
        const phW = 240;
        const phH = 90;
        const pad = 12;

        // 同父兄弟由后续 reflowAutoLayout 统一重排,占位符只需避开外部子树
        const ignore = new Set<string>([parentNodeId]);
        if (referenceId) ignore.add(referenceId);
        sameParentChildIds.forEach((id) => ignore.add(id));

        const obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
        cy.$('node').forEach((node: any) => {
            const data = node.data();
            if (data?.isGroup || data?.isPlaceholder) return;
            const original = data?.originalNode;
            const nid = original?.IDStr || original?.ID;
            if (!nid || ignore.has(nid)) return;
            const p = node.position();
            obstacles.push({
                x: p.x,
                y: p.y,
                w: Math.max(Number(node.outerWidth?.() ?? 0), 80),
                h: Math.max(Number(node.outerHeight?.() ?? 0), 44)
            });
        });
        if (obstacles.length === 0) return initial;

        const stepGap = 56;
        const stepX = (stackAxis.x / axisLen) * stepGap;
        const stepY = (stackAxis.y / axisLen) * stepGap;

        let cur = { x: initial.x, y: initial.y };
        for (let i = 0; i < 80; i++) {
            const hit = obstacles.find((o) =>
                Math.abs(cur.x - o.x) < (phW + o.w) / 2 + pad
                && Math.abs(cur.y - o.y) < (phH + o.h) / 2 + pad
            );
            if (!hit) return cur;
            cur = { x: cur.x + stepX, y: cur.y + stepY };
        }
        return cur;
    }

    private getPrimaryMocRootId(): string | null {
        const root = this.mocNodes.find((node) => node.isRoot) || this.mocNodes[0];
        return root ? (root.IDStr || root.ID) : null;
    }

    private isFirstLevelMocChildNode(nodeId: string): boolean {
        if (!nodeId) return false;
        const parentId = nodeId.split('.').slice(0, -1).join('.');
        if (!parentId) return false;
        return this.mocNodes.some((node) => node.isRoot && (node.IDStr === parentId || node.ID === parentId));
    }

    /**
     * 设置节点级布局风格，并持久化到 MOC 文件
     */
    private async setNodeLayoutStyle(node: ZKNode, style: 'auto' | 'free'): Promise<void> {
        const nodeId = node.IDStr || node.ID;
        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile) return;

        const getInherited = (
            overrides: Record<string, 'auto' | 'free'>,
            fileDefault: 'auto' | 'free'
        ): 'auto' | 'free' => {
            const parts = nodeId.split('.');
            if (parts.length <= 1) return fileDefault;
            const parentId = parts.slice(0, -1).join('.');
            return this.getEffectiveNodeLayoutStyle(parentId, overrides, fileDefault);
        };

        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodeLayoutOverrides) mocData.nodeLayoutOverrides = {};
            const fileDefault = this.normalizeNodeLayoutStyle(mocData.nodeLayoutStyle, 'free');
            // 与父链继承值相同则清除覆盖（避免冗余数据）
            const inherited = getInherited(mocData.nodeLayoutOverrides, fileDefault);
            if (style === inherited) {
                delete mocData.nodeLayoutOverrides[nodeId];
            } else {
                mocData.nodeLayoutOverrides[nodeId] = style;
            }
        });

        // 同步本地缓存（与持久化保持一致的清理策略）
        const inheritedLocal = getInherited(this.currentNodeLayoutOverrides, this.currentNodeLayoutStyle);
        if (style === inheritedLocal) {
            delete this.currentNodeLayoutOverrides[nodeId];
        } else {
            this.currentNodeLayoutOverrides[nodeId] = style;
        }

        // 切到 auto: 立即把该节点的子树围绕它重排。以 nodeId 为锚点(保留其当前
        // 位置,父节点即便是 free 也不动),强制忽略子节点的旧保存坐标,让它们重新
        // 对称排布 —— 否则刚切成 auto 的子节点会停在原地,表现为"没反应"(issue #48)。
        // 切到 free: 子节点保留当前坐标(手动模式),无需重排。
        if (style === 'auto') {
            const subtreeIds = this.collectAutoLayoutSubtreeIds(nodeId);
            await this.relayoutAutoLayoutSiblings(nodeId, {
                ignoreSavedPositionsForIds: subtreeIds,
                persistPositions: true,
            });
            this.lastRenderSignature = null;
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        }
    }

    private async setBranchLayoutPreset(nodeId: string, preset: LayoutPreset): Promise<void> {
        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile) return;

        await this.mocHandler.setNodeLayoutPreset(mocFile, nodeId, preset);
        if (preset === this.currentLayoutPreset) {
            delete this.currentNodeLayoutPresets[nodeId];
        } else {
            this.currentNodeLayoutPresets[nodeId] = preset;
        }
        await this.relayoutAutoLayoutSiblings(this.getPrimaryMocRootId() || nodeId);
        this.lastRenderSignature = null;
        this.app.workspace.trigger("zk-navigation:refresh-index-graph");
    }

    private async savePlaceholderLayoutPositions(
        mocFile: TFile,
        nodeId: string,
        position: { x: number; y: number }
    ): Promise<void> {
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodePositions) {
                mocData.nodePositions = {};
            }
            mocData.nodePositions[nodeId] = {
                x: Math.round(position.x * 100) / 100,
                y: Math.round(position.y * 100) / 100
            };
        });
    }

    /** 项目徽章:当前 MOC 是否已挂载到工作区任一容器下 */
    private refreshProjectBadge(mocPath: string | null | undefined): void {
        if (!this.mocChipProjectBadge) return;
        const mounted = !!(mocPath && this.plugin.workspaceStore?.isFileMounted(mocPath));
        this.mocChipProjectBadge.setCssStyles({ display: mounted ? "inline-flex" : "none" });
    }

    private normalizeNodeLayoutStyle(
        style: unknown,
        fallback: unknown = 'free'
    ): 'free' | 'auto' {
        const normalize = (value: unknown): 'free' | 'auto' | null => {
            if (typeof value !== 'string') return null;
            const v = value.trim().toLowerCase();
            if (v === 'auto') return 'auto';
            if (v === 'free') return 'free';
            return null;
        };
        return normalize(style) || normalize(fallback) || 'free';
    }

    private ensureMOCNodeLayoutStyle(mocData: MOCParseResult): void {
        if (mocData.nodeLayoutStyle === 'auto' || mocData.nodeLayoutStyle === 'free') {
            return;
        }
        mocData.nodeLayoutStyle = this.normalizeNodeLayoutStyle(undefined, this.currentNodeLayoutStyle);
    }

    private async persistCollapseState(
        mocFile: TFile,
        collapsedNodeIds: string[]
    ): Promise<void> {
        const normalizedCollapsedIds = Array.from(new Set(collapsedNodeIds));
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            (mocData as any).collapsedNodeIds = normalizedCollapsedIds;
        });
    }

    /**
     * 声明式 reflow: 以 anchorNodeId 所在子树为起点, 上溯到 MOC root, 整棵树按
     * computeAutoLayout 的"子树跨度求和 → 自顶向下分配"算法重排。
     * 已分离的节点 (NODE_FLAG_SEPARATED) 作为锚点保留,且不占父节点排布槽位。
     *
     * 所有创建/删除/移动节点的操作都应该走这个入口。
     */
    private async reflowAutoLayout(anchorNodeId: string): Promise<void> {
        await this.relayoutAutoLayoutSiblings(anchorNodeId, {
            compactVisibleNodes: true,
            collapsedNodeIds: this.collapsedNodeIds,
            rebalanceRootChildren: true,
        });
    }

    /**
     * 新建同级节点跟随"最近创建的兄弟"(children 数组末尾 = 最大 id)的左右侧:
     * 读取该兄弟相对父节点的位置定出左/右,把新节点放到同侧并打 SIDE_PINNED,
     * 随后的 reflow 即据此摆放。把最后一个节点挪到对侧,之后新建的也跟到对侧。
     * 必须在 reflowAutoLayout 之前调用。
     */
    private async applyNewSiblingSide(newNodeId: string): Promise<void> {
        if (!this.isNodeAutoLayout(newNodeId)) return;
        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile) return;
        const parentId = this.resolveRealParentId(newNodeId);
        if (!parentId) return;
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            const parent = this.findNodeInTree(mocData.nodes, parentId);
            const siblings = (parent?.children || []).filter((c: any) => c.nodeID !== newNodeId);
            if (siblings.length === 0) return;
            const pos = mocData.nodePositions || (mocData.nodePositions = {});
            const pp = pos[parentId];
            // 优先用新节点自己的占位坐标(已落在被选中参考节点的槽位旁)定左右侧并保留其 y;
            // 缺失时回退到末尾兄弟。直接用末尾兄弟会把新节点强行对齐到最底下那一行,
            // 导致 reflow 按 y 排序时排到末尾(issue:新建兄弟跑到最下面)。
            const np = pos[newNodeId];
            const ref = np || pos[siblings[siblings.length - 1].nodeID];
            if (!pp || !ref) return;
            const leftSide = (ref.x - pp.x) < 0;
            pos[newNodeId] = {
                x: Math.round((pp.x + (leftSide ? -315 : 315)) * 100) / 100,
                y: ref.y,
            };
            const nn = this.findNodeInTree(mocData.nodes, newNodeId);
            if (nn) nn.extBitMap = ((nn.extBitMap || 0) | NODE_FLAG_SIDE_PINNED) & 0xff;
        });
    }

    /**
     * 占位编辑阶段的预览重排:把占位符当成 parentId 的真实子节点跑一遍布局(不落盘),
     * 现有兄弟即为占位符让出槽位(否则占位符会压在下一个兄弟身上)。
     * referenceNodeId(被选中的兄弟)用于把占位符染入同一颜色排序组。
     */
    private async previewReflowForPlaceholder(
        parentNodeId: string,
        placeholderTempId: string,
        referenceNodeId?: string
    ): Promise<void> {
        if (!this.isNodeAutoLayout(parentNodeId) && !this.hasAutoLayoutChild(parentNodeId)) return;
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return;
        const ph = cy.$id(placeholderTempId);
        if (!ph || ph.length === 0) return;

        // 取参考节点(或父的第一个子节点)的分支色,作为占位符的颜色排序键,
        // 否则占位符落到 __default__ 组会被排到所有同色兄弟之后。
        let colorKey: string | undefined;
        const refId = referenceNodeId || this.getChildNodeIds(parentNodeId)[0];
        if (refId) {
            const refNode: any = cy.$('node').filter((n: any) => {
                const o = n.data('originalNode');
                return o && (o.IDStr === refId || o.ID === refId);
            }).first();
            if (refNode && refNode.length > 0) {
                colorKey = refNode.data('branchNodeBorder') || refNode.data('branchNodeBackground') || undefined;
            }
        }

        await this.relayoutAutoLayoutSiblings(parentNodeId, {
            compactVisibleNodes: true,
            collapsedNodeIds: this.collapsedNodeIds,
            rebalanceRootChildren: true,
            persistPositions: false,
            includePlaceholder: { id: placeholderTempId, parentId: parentNodeId, colorKey },
        });

        // 引擎把占位符摆到了干净槽位,同步占位记录的 position,让后续落盘坐标与所见一致。
        const settled = ph.position();
        const rec = this.placeholderNodes.get(placeholderTempId);
        if (rec) rec.position = { x: settled.x, y: settled.y };
    }

    /**
     * 给定一组被删除的节点 ID, 返回一个仍存活、可用于触发 reflow 的父级 ID。
     * 由于 reflowAutoLayout 会从 anchor 沿父链上溯到 MOC root, 任选一个有效的
     * 祖先即可触发整棵树重排。
     *
     * 用 resolveRealParentId 解析真实父级(自由节点 ID 扁平,父子关系只在边里),
     * 因此**必须在删除节点之前调用**(删除+刷新后 parent 边已消失)。
     * 父级自身为 auto,或父级是自由节点但其下仍有 auto 子节点(issue #48 场景),
     * 都需要 reflow。
     */
    private pickAutoLayoutParentForReflow(deletedNodeIds: string[]): string | null {
        const deleted = new Set(deletedNodeIds.map((id) => String(id)));
        for (const nodeId of deletedNodeIds) {
            const parentId = this.resolveRealParentId(nodeId);
            // 父级自身也在删除集合里 → 刷新后不存在,跳过
            if (!parentId || deleted.has(parentId)) continue;
            if (this.isNodeAutoLayout(parentId) || this.hasAutoLayoutChild(parentId)) {
                return parentId;
            }
        }
        return null;
    }

    private async relayoutAutoLayoutSiblings(
        parentNodeId: string,
        relayoutOptions: {
            collapsedNodeIds?: string[];
            compactVisibleNodes?: boolean;
            persistPositions?: boolean;
            ignoreSavedPositionsForIds?: string[];
            forceResetSeparated?: boolean;
            rebalanceRootChildren?: boolean;
            localOnly?: boolean;
            // 把一个占位符 cy 节点当成 parentId 的真实子节点塞进布局(预览用,配合 persistPositions:false):
            // 让现有兄弟为占位符让出槽位。colorKey 用于让占位符归入参考节点的颜色排序组。
            includePlaceholder?: { id: string; parentId: string; colorKey?: string };
        } = {}
    ): Promise<void> {
        if (!this.branchRenderer) {
            return;
        }

        const cy = this.branchRenderer.getCytoscapeInstance();
        if (!cy) {
            return;
        }

        // 父节点自身为 auto,或它是自由节点但其下仍有 auto 子节点(issue #48):
        // 都需要布局。自由父节点作为固定锚点(保留 savedPosition),
        // 其 auto 子节点围绕它排列。两者皆否(纯 free 子树)才跳过。
        if (!this.isNodeAutoLayout(parentNodeId) && !this.hasAutoLayoutChild(parentNodeId)) {
            return;
        }

        const startNode: any = cy.$('node').filter((node: any) => {
            const originalNode = node.data('originalNode');
            return originalNode && (originalNode.IDStr === parentNodeId || originalNode.ID === parentNodeId);
        }).first();

        if (!startNode || startNode.length === 0) {
            return;
        }

        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile) {
            return;
        }

        const mocData = await parseMOCStructure(this.app, mocFile.path, this.plugin.settings.mocHeadingTitle);
        const getNodeSize = (node: any) => ({
            width: Math.max(Number(node.outerWidth?.() ?? node.width?.() ?? 0), 80),
            height: Math.max(Number(node.outerHeight?.() ?? node.height?.() ?? 0), 44)
        });

        const getColorKey = (node: any): string => {
            return node?.data?.('branchNodeBorder')
                || node?.data?.('branchNodeBackground')
                || '__default__';
        };

        // 分离标志位:已分离节点作为固定锚点保留坐标,且不占父节点排布槽位。
        const bitMapByID = new Map<string, number>();
        const collectBitMap = (ns: MOCTreeNode[]) => {
            for (const n of ns) {
                if (typeof n.extBitMap === 'number' && n.extBitMap !== 0) {
                    bitMapByID.set(n.nodeID, n.extBitMap & 0xff);
                }
                if (n.children?.length) collectBitMap(n.children);
            }
        };
        collectBitMap(mocData.nodes);
        const isSeparated = (nid: string) =>
            !relayoutOptions.forceResetSeparated
            && ((bitMapByID.get(nid) || 0) & NODE_FLAG_SEPARATED) !== 0;
        // 侧别已固定的节点:传给引擎,使其无论层级都按自身保存位置导出方向。
        const sidePinnedIds = new Set<string>(
            Array.from(bitMapByID.entries())
                .filter(([, bm]) => (bm & NODE_FLAG_SIDE_PINNED) !== 0)
                .map(([id]) => id)
        );

        const nodes: Record<string, AutoLayoutNodeInput> = {};
        const parentById: Record<string, string | undefined> = {};
        const childrenById: Record<string, string[]> = {};
        // 未显式传入时回退到视图当前收起状态:所有调用方(拖拽、新建、切换布局风格等)
        // 都不该让隐藏节点参与布局。
        const collapsedIds = new Set(relayoutOptions.collapsedNodeIds ?? this.collapsedNodeIds);
        const isHiddenByCollapse = (nodeId: string): boolean => {
            for (const collapsedId of collapsedIds) {
                if (nodeId !== collapsedId && nodeId.startsWith(`${collapsedId}.`)) {
                    return true;
                }
            }
            return false;
        };
        const includePlaceholder = relayoutOptions.includePlaceholder;
        const cyNodeById = new Map<string, any>();
        cy.$('node').forEach((node: any) => {
            const data = node.data();
            const originalNode = data.originalNode;
            // 预览场景:指定的占位符也作为一等子节点参与排布,让兄弟为它让位。
            const isIncludedPlaceholder = !!(includePlaceholder && data.isPlaceholder && data.id === includePlaceholder.id);
            const nodeId = isIncludedPlaceholder ? data.id : (originalNode?.IDStr || originalNode?.ID);
            // 草稿(#20)作为一等节点参与重排(有 synthetic originalNode);其余占位符/分组排除
            if (!nodeId || data.isGroup || (data.isPlaceholder && !isIncludedPlaceholder)) return;
            // 被收起隐藏的节点(display:none)一律不参与布局:量不到真实尺寸(会被钳到
            // 80×44 兜底值),算出的跨度是错的。不依赖 compactVisibleNodes 开关 ——
            // 任何调用方(切换布局风格/preset 等)都不该让隐藏节点参与。
            if (isHiddenByCollapse(nodeId)) return;
            cyNodeById.set(nodeId, node);
            nodes[nodeId] = {
                id: nodeId,
                size: getNodeSize(node),
                position: node.position(),
                colorKey: isIncludedPlaceholder
                    ? (includePlaceholder!.colorKey || getColorKey(node))
                    : getColorKey(node)
            };
            childrenById[nodeId] = [];
        });

        cy.$('edge').filter((edge: any) => edge.data('type') === 'parent').forEach((edge: any) => {
            const source = edge.source();
            const target = edge.target();
            const sourceOriginal = source.data('originalNode');
            const targetOriginal = target.data('originalNode');
            const sourceId = sourceOriginal?.IDStr || sourceOriginal?.ID;
            const targetId = targetOriginal?.IDStr || targetOriginal?.ID;
            if (!sourceId || !targetId || !nodes[sourceId] || !nodes[targetId]) return;
            parentById[targetId] = sourceId;
            // 已分离的子节点不进父节点的排布列表:其余兄弟据此重新紧凑排布(关闭空位),
            // 分离子树自身保留拖动后坐标,不被本次重排触及。parentById 仍保留映射,
            // 故分离岛内部(以分离节点为锚点)的重排上溯链不受影响。
            if (this.isNodeAutoLayout(targetId) && !isSeparated(targetId)) {
                childrenById[sourceId].push(targetId);
            }
        });

        // 占位符无 parent 边,手动挂到目标父节点下,使其和真实兄弟一起被排布。
        if (includePlaceholder && nodes[includePlaceholder.id] && nodes[includePlaceholder.parentId]) {
            parentById[includePlaceholder.id] = includePlaceholder.parentId;
            const list = childrenById[includePlaceholder.parentId] || (childrenById[includePlaceholder.parentId] = []);
            if (!list.includes(includePlaceholder.id)) list.push(includePlaceholder.id);
        }

        const realMocRootIds = new Set<string>(mocData.nodes.map((node) => node.nodeID));
        let relayoutRootId = parentNodeId;
        // 上溯到 free 非根父节点即停 = 该 auto 子树岛的顶点。
        // 引擎只沿 auto 子链下行(childrenById 仅收 auto 子节点),若 auto 子树挂在
        // free 祖先链下(如深层节点),继续上溯到 MOC root 会让引擎无法穿过 free 链
        // 回到该子树 → 深层 auto 节点完全不被布局(issue:很多层后父节点不居中)。
        // 父节点是 MOC root 时仍上溯到它,保留一级 auto 子节点的对称分组("第一级会平衡")。
        const stopAtAutoIslandTop = (parentId: string): boolean =>
            !this.isNodeAutoLayout(parentId) && !realMocRootIds.has(parentId);
        if (relayoutOptions.localOnly) {
            // 仅局部重排:不上溯,以传入的 parentNodeId 为根,只重排其直接子树。
            // 拖动后(分离/吸附)只需让该父节点的子节点重新紧凑/吸附,不应牵动整棵树。
        } else if (relayoutOptions.compactVisibleNodes) {
            const visitedRelayoutRoots = new Set<string>();
            while (!realMocRootIds.has(relayoutRootId)) {
                // 已分离节点是其子树岛的锚点:上溯到它即停,使岛内 reflow 以它为根。
                if (isSeparated(relayoutRootId)) {
                    break;
                }
                const parentId = parentById[relayoutRootId];
                if (!parentId || !nodes[parentId] || visitedRelayoutRoots.has(parentId)) {
                    break;
                }
                if (stopAtAutoIslandTop(parentId)) {
                    break;
                }
                visitedRelayoutRoots.add(relayoutRootId);
                relayoutRootId = parentId;
            }
        } else {
            const visitedRelayoutRoots = new Set<string>();
            while (!realMocRootIds.has(relayoutRootId)) {
                // 已分离节点是其子树岛的锚点:上溯到它即停,使岛内 reflow 以它为根。
                if (isSeparated(relayoutRootId)) {
                    break;
                }
                const parentId = parentById[relayoutRootId];
                if (!parentId || !nodes[parentId] || visitedRelayoutRoots.has(parentId)) {
                    break;
                }
                if (stopAtAutoIslandTop(parentId)) {
                    break;
                }
                // 当前节点有保存位置(已拖动过)时,以它为锚点,不再向上
                if (mocData.nodePositions?.[relayoutRootId]) {
                    break;
                }
                visitedRelayoutRoots.add(relayoutRootId);
                relayoutRootId = parentId;
            }
        }

        // 草稿(#20)无文件保存位置,把其当前 cy 位置喂给引擎,使方向按"位置相对父节点"判定
        // (而非退化到 sibling-index 交替导致左右乱跳);布局仍因 isNodeAutoLayout=true 进入忽略集重排。
        const draftSavedPositions: Record<string, { x: number; y: number }> = {};
        cy.$('node').forEach((node: any) => {
            if (!node.data('isDraft')) return;
            const id = node.data('originalNode')?.IDStr;
            if (id) { const p = node.position(); draftSavedPositions[id] = { x: p.x, y: p.y }; }
        });
        // 预览占位符同理:把其 cy 坐标喂进 nodePositions,使引擎按"位置相对父节点"定左右侧,
        // 否则缺位置会退回 sibling-index 取 pool,把新节点甩到对侧。
        if (includePlaceholder && nodes[includePlaceholder.id]) {
            draftSavedPositions[includePlaceholder.id] = { ...nodes[includePlaceholder.id].position };
        }

        const nodePositions = computeAutoLayout({
            relayoutRootId,
            nodes,
            parentById,
            childrenById,
            realMocRootIds,
            sidePinnedIds,
            nodePositions: { ...(mocData.nodePositions || {}), ...draftSavedPositions },
            ignoreSavedPositionsForIds: (() => {
                // 已分离节点必须保留其保存位置作为锚点 (复用上方 isSeparated)
                const explicit = relayoutOptions.ignoreSavedPositionsForIds
                    ?.filter((id) => id !== relayoutRootId)
                    .filter((id) => !isSeparated(id));
                if (relayoutOptions.compactVisibleNodes) {
                    const set = new Set(Object.keys(nodes).filter((nodeId) => {
                        if (nodeId === relayoutRootId) return false;
                        if (!this.isNodeAutoLayout(nodeId)) return false;
                        const parentId = parentById[nodeId];
                        // 默认豁免根的一级子节点(收起场景沿用,保持分支根稳定);
                        // rebalanceRootChildren=true 时(新建/移动节点的 reflow)放开,
                        // 让一级子节点也对称重排 → 根节点相对子节点竖直居中。
                        if (!relayoutOptions.rebalanceRootChildren && parentId && realMocRootIds.has(parentId)) return false;
                        if (isSeparated(nodeId)) return false;
                        return true;
                    }));
                    explicit?.forEach((id) => set.add(id));
                    // 占位符不在 mocNodes(isNodeAutoLayout=false),显式加入忽略集,
                    // 使其 cy 位置只用于定方向、不被当锚点 → 落到引擎算出的干净槽位。
                    if (includePlaceholder && nodes[includePlaceholder.id]) set.add(includePlaceholder.id);
                    return set;
                }
                return explicit && explicit.length > 0 ? new Set(explicit) : undefined;
            })(),
            layoutPreset: normalizeLayoutPreset(this.plugin.settings.autoLayoutDefaultGrowthDirection),
            nodeLayoutPresets: mocData.nodeLayoutPresets,
        });

        // 自底向上把每个 auto 父节点重定位到其子节点的横轴中点。
        // 引擎只让"子节点围绕父节点对称",从不反过来"父节点对齐子节点中点";
        // 当子节点被手动拖动或顺序向下追加导致整体偏移时,父节点会停在顶端不居中。
        // 对称健康的子树里 中点==父节点 → 本步是空操作,幂等安全。
        // 只动 auto 节点;根/分支根(分组放置)与 free 锚点(issue #48)保持不动。
        {
            const depthOf = (id: string): number => {
                let depth = 0;
                let cur: string | undefined = id;
                const seen = new Set<string>();
                while (cur && parentById[cur] && !seen.has(cur)) {
                    seen.add(cur);
                    cur = parentById[cur];
                    depth++;
                }
                return depth;
            };
            const round2 = (v: number) => Math.round(v * 100) / 100;
            const order = Object.keys(nodePositions).sort((a, b) => depthOf(b) - depthOf(a));
            for (const id of order) {
                if (!this.isNodeAutoLayout(id)) continue;
                if (realMocRootIds.has(id)) continue;            // 根:分组放置,跳过
                if (relayoutOptions.localOnly && id === relayoutRootId) continue; // 局部重排:锚点(父)固定不动
                const pid = parentById[id];
                if (pid && realMocRootIds.has(pid)) continue;     // 分支根:分组放置,跳过
                const cur = nodePositions[id];
                if (!cur) continue;
                const pts = (childrenById[id] || [])
                    .map((kid) => nodePositions[kid])
                    .filter(Boolean) as { x: number; y: number }[];
                if (pts.length === 0) continue;
                const xs = pts.map((p) => p.x);
                const ys = pts.map((p) => p.y);
                const minX = Math.min(...xs), maxX = Math.max(...xs);
                const minY = Math.min(...ys), maxY = Math.max(...ys);
                // 横轴 = 子节点铺开(跨度更大)的那条轴;沿该轴取中点,前进轴坐标保持不变
                nodePositions[id] = (maxY - minY) >= (maxX - minX)
                    ? { x: cur.x, y: round2((minY + maxY) / 2) }
                    : { x: round2((minX + maxX) / 2), y: cur.y };
            }
        }

        cy.batch(() => {
            Object.entries(nodePositions).forEach(([nodeId, position]) => {
                cyNodeById.get(nodeId)?.position(position);
            });
        });

        if (relayoutOptions.persistPositions === false) {
            return;
        }

        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodePositions) {
                mocData.nodePositions = {};
            }
            Object.entries(nodePositions).forEach(([nodeId, pos]) => {
                // 草稿节点(#20)纯内存,不写入文件
                if (this.draftNodes.has(nodeId)) return;
                mocData.nodePositions[nodeId] = pos;
            });
        });
    }

    private async restoreSavedNodePositions(mocFile: TFile): Promise<void> {
        if (!this.branchRenderer) {
            return;
        }
        const cy = this.branchRenderer.getCytoscapeInstance();
        if (!cy) {
            return;
        }

        const mocData = await parseMOCStructure(this.app, mocFile.path, this.plugin.settings.mocHeadingTitle);
        const savedPositions = mocData.nodePositions || {};
        const cyNodeById = new Map<string, any>();
        cy.$('node').forEach((node: any) => {
            const originalNode = node.data('originalNode');
            if (!originalNode) return;
            if (originalNode.IDStr && !cyNodeById.has(originalNode.IDStr)) cyNodeById.set(originalNode.IDStr, node);
            if (originalNode.ID && !cyNodeById.has(originalNode.ID)) cyNodeById.set(originalNode.ID, node);
        });
        cy.batch(() => {
            Object.entries(savedPositions).forEach(([nodeId, position]) => {
                cyNodeById.get(nodeId)?.position(position);
            });
        });
    }

    /**
     * 移除占位符节点
     */
    private async removePlaceholderNode(tempId: string): Promise<void> {
        // 通过事件通知 Cytoscape 渲染器移除占位符节点
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('remove-placeholder-node', {
                detail: {
                    nodeId: tempId
                }
            }));
        }

        // 从追踪中移除
        this.placeholderNodes.delete(tempId);
    }

    /**
     * 添加自由节点到 MOC
     * @param position 可选的位置参数，用于双击创建时指定位置
     */
    async addFreeNodeToMOC(position?: { x: number; y: number }) {
        // 生成建议的节点 ID
        const suggestedID = this.generateNextFreeNodeID();
        
        // 打开对话框
        new AddFreeNodeModal(
            this.app,
            this.plugin,
            this.mocNodes, // 当前 MOC 的所有节点
            suggestedID,
            async (result) => {
                // 草稿模式(#20):新建自由节点也先作为草稿
                if (this.divertFreeNodeToDraft(result, position)) return;

                // 添加到 MOC 文件，并在同一次写入里持久化新节点位置
                await this.saveFreeNodeToMOC(result, position);

                // 刷新视图
                await this.refreshBranchMermaid();
            }
        ).open();
    }

    /**
     * 保存自由节点到 MOC 文件
     */
    async saveFreeNodeToMOC(result: {
        wikiLink?: string;      // 可选：用于文件节点
        text?: string;          // 可选：用于纯文字节点
        alias?: string;         // 可选：file / embed 节点的 [[link|alias]] 别名
        nodeID: string;
        relationText: string;
        file: TFile | null;
        connectToNodeID?: string;
        connectionRelation?: string;
        reverseRelation?: {
            sourceID: string;
            targetID: string;
            relationText: string;
        };
        isTextOnly?: boolean;   // 新增：标记纯文字节点
        isEmbed?: boolean;      // 新增：标记嵌入节点 ![[...]]
    }, position?: { x: number; y: number }) {
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (!mocFilePath) {
            new Notice(t("No current MOC file selected"));
            return;
        }

        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (!mocFile) {
            new Notice(t("Current MOC file does not exist"));
            return;
        }

        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 创建新节点
                const resTextOnly = !!result.isTextOnly;
                const resEmbed = !!result.isEmbed;
                const resTarget = resTextOnly ? (result.text || '') : (result.wikiLink || '');
                const newNode: MOCTreeNode = {
                    nodeID: result.nodeID,
                    nodeType: resTextOnly ? 'text' : (resEmbed ? 'embed' : 'file'),
                    target: resTarget,
                    depth: 0,
                    children: [],
                    file: resTextOnly ? null : result.file,
                    relationText: result.connectionRelation || result.relationText || '',
                };
                // file / embed 节点支持 alias；alias 与 target 不同时才保留
                if (!resTextOnly && result.alias && result.alias !== resTarget) {
                    newNode.alias = result.alias;
                }

                const isFreeNode = this.isFreeNodeID(result.nodeID);
                const parentNodeId = result.connectToNodeID;
                const shouldAttachAsChild = !!parentNodeId && !isFreeNode;

                // 如果有父节点且不是自由节点，添加为子节点
                if (shouldAttachAsChild) {
                    // 查找父节点
                    const findNodeInTree = (nodes: MOCTreeNode[], nodeID: string): MOCTreeNode | null => {
                        for (const node of nodes) {
                            if (node.nodeID === nodeID) {
                                return node;
                            }
                            if (node.children && node.children.length > 0) {
                                const found = findNodeInTree(node.children, nodeID);
                                if (found) return found;
                            }
                        }
                        return null;
                    };

                    const parentNode = findNodeInTree(mocData.nodes, parentNodeId as string);
                    if (parentNode) {
                        // 计算深度
                        newNode.depth = parentNode.depth + 1;
                        // 添加到父节点的子节点
                        parentNode.children.push(newNode);
                    } else {
                        throw new Error(`未找到父节点: ${result.connectToNodeID}`);
                    }
                } else {
                    // 作为根节点添加
                    newNode.depth = 0;
                    mocData.nodes.push(newNode);
                }

                // 新建一级节点时，自动分配并持久化分支主题色（写入 %% ext 的 node_style_colors）
                if (newNode.nodeID.split('.').length === 2) {
                    if (!(mocData as any).nodeStyleColors) {
                        (mocData as any).nodeStyleColors = {};
                    }
                    if (!(mocData as any).nodeStyleColors[newNode.nodeID]) {
                        (mocData as any).nodeStyleColors[newNode.nodeID] = this.pickNextBranchStyleColor((mocData as any).nodeStyleColors);
                    }
                }
                this.mocHandler.ensureFirstLevelNodeLayoutDefaults(mocData, newNode.nodeID);

                if (position && result.nodeID && !result.nodeID.startsWith('cd-')) {
                    mocData.nodePositions[result.nodeID] = {
                        x: Math.round(position.x * 100) / 100,
                        y: Math.round(position.y * 100) / 100,
                    };
                }

                // 自由节点即使选择了“连接到节点”，也只保留虚线关系，不建立父子关系
                if (isFreeNode && result.connectToNodeID && !result.reverseRelation) {
                    const key = `${result.connectToNodeID}->${result.nodeID}`;
                    mocData.reverseRelations.set(key, {
                        sourceID: result.connectToNodeID,
                        targetID: result.nodeID,
                        relationText: result.connectionRelation || result.relationText || ''
                    });
                }

                // 如果有反向关系，添加到 reverseRelations
                if (result.reverseRelation) {
                    const key = `${result.reverseRelation.sourceID}->${result.reverseRelation.targetID}`;
                    mocData.reverseRelations.set(key, result.reverseRelation);
                }
            });

            new Notice(t("Free node added").replace("{id}", String(result.nodeID)));
        } catch (error) {
            console.error("保存自由节点失败:", error);
            new Notice(t("Save failed").replace("{message}", String(error.message)));
        }
    }

    /**
     * 获取 MOC 文件的视图状态
     */
    private getMOCViewState(mocPath: string): { zoom: number; pan: { x: number; y: number } } | null {
        this.pruneMOCViewStates(mocPath);
        return this.mocViewStates.get(mocPath) || null;
    }

    /**
     * 保存 MOC 文件的视图状态
     */
    private saveMOCViewState(mocPath: string, zoom: number, pan: { x: number; y: number }): void {
        this.mocViewStates.set(mocPath, { zoom, pan });
        this.pruneMOCViewStates(mocPath);
    }

    async onClose() {
        // 保存插件设置
        this.plugin.saveData(this.plugin.settings);

        // 取消 WorkspaceStore 订阅
        if (this.workspaceStoreUnsubscribe) {
            this.workspaceStoreUnsubscribe();
            this.workspaceStoreUnsubscribe = null;
        }

        this.scratchDrawer = null;
        this.detailPanel = null;
        this.detailPanelLastId = null;

        // 销毁内嵌工作区面板(含 store 订阅)
        if (this.workspacePanel) {
            this.workspacePanel.destroy();
            this.workspacePanel = null;
        }
        this.workspaceMode = false;

        // 清理所有防抖定时器
        this.cleanupTimers();

        // 清理所有DOM事件监听器
        this.cleanupEventListeners();
        this.undoShortcutBound = false;
        this.pasteListenerBound = false;
        this.fullscreenBackButtonListenerBound = false;

        // 销毁Cytoscape渲染器
        if (this.branchRenderer) {
            this.branchRenderer.destroy();
            this.branchRenderer = null;
        }

        // 清理缓存数据
        this.nodePositionMap.clear();
        this.renderedBranches.clear();
        this.mocViewStates.clear();
        this.placeholderNodes.clear();
        this.clearAllDrafts();
        this.undoStack = [];
        this.mocNodes = [];
        this.mocTreeStructure = [];
        this.mocReverseRelations.clear();
        this.branchEntranceNodes = [];
        this.indexMermaidContainer = null;
    }

    /**
     * 保存分组到 MOC 文件
     */
    private async saveGroupToMOC(mocFile: TFile, group: { id: string; label: string; nodeIds: string[]; color?: string }): Promise<void> {
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            // 添加或更新分组
            const existingGroupIndex = mocData.groups.findIndex((g: any) => g.id === group.id);
            if (existingGroupIndex !== -1) {
                mocData.groups[existingGroupIndex] = group;
            } else {
                mocData.groups.push(group);
            }
        });

        new Notice(`已创建分组: ${group.label}`);
    }

    /**
     * 重命名 MOC 文件中的分组
     */
    private async renameGroupInMOC(mocFile: TFile, groupId: string, newLabel: string): Promise<void> {
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                const groupIndex = mocData.groups.findIndex((g: any) => g.id === groupId);
                if (groupIndex === -1) {
                    throw new Error(`未找到分组: ${groupId}`);
                }

                mocData.groups[groupIndex].label = newLabel;
            });

            new Notice(`已重命名分组: ${newLabel}`);
        } catch (error) {
            console.error('Failed to rename group:', error);
            new Notice(`重命名分组失败: ${error.message}`);
        }
    }

    /**
     * 修改分组 ID（同时迁移与分组相关的关系与元数据键）
     */
    private async renameGroupIDInMOC(mocFile: TFile, oldGroupId: string, newGroupId: string): Promise<void> {
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                const oldId = String(oldGroupId || '').trim();
                const newId = String(newGroupId || '').trim();
                if (!oldId || !newId) {
                    throw new Error('分组 ID 不能为空');
                }
                if (oldId === newId) {
                    return;
                }

                const groupIndex = mocData.groups.findIndex((g: any) => g.id === oldId);
                if (groupIndex === -1) {
                    throw new Error(`未找到分组: ${oldId}`);
                }

                const hasDuplicate = mocData.groups.some((g: any, index: number) => index !== groupIndex && g.id === newId);
                if (hasDuplicate) {
                    throw new Error(`分组 ID "${newId}" 已存在`);
                }

                // 避免和节点 ID 冲突（分组已支持参与连线，ID 需唯一）
                const hasNodeConflict = this.mocNodes.some((node) => node.IDStr === newId || node.ID === newId);
                if (hasNodeConflict) {
                    throw new Error(`分组 ID "${newId}" 与节点 ID 冲突`);
                }

                mocData.groups[groupIndex].id = newId;

                const remapId = (id: string) => (id === oldId ? newId : id);

                // 迁移 reverseRelations
                const newReverseRelations = new Map<string, any>();
                for (const [, relation] of mocData.reverseRelations) {
                    const sourceID = remapId(relation.sourceID);
                    const targetID = remapId(relation.targetID);
                    newReverseRelations.set(`${sourceID}->${targetID}`, {
                        sourceID,
                        targetID,
                        relationText: relation.relationText || ''
                    });
                }
                mocData.reverseRelations = newReverseRelations;

                // 迁移按节点 ID 存储的对象键
                const remapObjectKeys = (obj: Record<string, any> | undefined) => {
                    if (!obj || typeof obj !== 'object') return obj;
                    if (!(oldId in obj)) return obj;
                    const next: Record<string, any> = {};
                    Object.entries(obj).forEach(([key, value]) => {
                        next[key === oldId ? newId : key] = value;
                    });
                    return next;
                };

                if (mocData.nodePositions) {
                    mocData.nodePositions = remapObjectKeys(mocData.nodePositions) as Record<string, { x: number; y: number }>;
                }
                if (mocData.nodeColors) {
                    mocData.nodeColors = remapObjectKeys(mocData.nodeColors) as Record<string, string>;
                }
                if ((mocData as any).nodeStyleColors) {
                    (mocData as any).nodeStyleColors = remapObjectKeys((mocData as any).nodeStyleColors);
                }
                if ((mocData as any).embedNodeSizes) {
                    (mocData as any).embedNodeSizes = remapObjectKeys((mocData as any).embedNodeSizes);
                }
                if ((mocData as any).nodeRemarks) {
                    (mocData as any).nodeRemarks = remapObjectKeys((mocData as any).nodeRemarks);
                }
                if ((mocData as any).nodeAnchors) {
                    (mocData as any).nodeAnchors = remapObjectKeys((mocData as any).nodeAnchors);
                }

                // 迁移 edgeCurvatures key（格式：source-target）
                if (mocData.edgeCurvatures) {
                    const nextCurvatures: Record<string, { distance: number; weight: number }> = {};
                    Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                        const parts = key.split('-');
                        const remapped = parts.map((part) => remapId(part)).join('-');
                        nextCurvatures[remapped] = value as { distance: number; weight: number };
                    });
                    mocData.edgeCurvatures = nextCurvatures;
                }
            });

            new Notice(`已将分组 ID 从 "${oldGroupId}" 修改为 "${newGroupId}"`);
        } catch (error) {
            console.error('Failed to rename group ID:', error);
            new Notice(`修改分组 ID 失败: ${error.message}`);
        }
    }

    /**
     * 从 MOC 文件中删除分组
     */
    private async deleteGroupFromMOC(mocFile: TFile, groupId: string): Promise<void> {
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 查找并删除分组
                const groupIndex = mocData.groups.findIndex((g: any) => g.id === groupId);
                if (groupIndex === -1) {
                    throw new Error(`未找到分组: ${groupId}`);
                }

                const deletedGroup = mocData.groups[groupIndex];
                mocData.groups.splice(groupIndex, 1);

                new Notice(`已删除分组: ${deletedGroup.label}`);
            });
        } catch (error) {
            console.error('Failed to delete group:', error);
            new Notice(`删除分组失败: ${error.message}`);
        }
    }

    /**
     * 更新 MOC 文件中分组的节点列表
     */
    private async updateGroupNodesInMOC(mocFile: TFile, groupId: string, newNodeIds: string[]): Promise<void> {
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 查找并更新分组
                const groupIndex = mocData.groups.findIndex((g: any) => g.id === groupId);
                if (groupIndex === -1) {
                    throw new Error(`未找到分组: ${groupId}`);
                }

                // 更新节点列表
                mocData.groups[groupIndex].nodeIds = newNodeIds;
            });
        } catch (error) {
            console.error('Failed to update group nodes:', error);
            new Notice(`更新分组失败: ${error.message}`);
        }
    }

    /**
     * 添加箭头关系到 MOC 文件
     */
    private async addArrowRelationToMOC(mocFile: TFile, sourceID: string, targetID: string, relationText: string = ''): Promise<void> {
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 检查是否已存在相同的箭头关系
                const key = `${sourceID}->${targetID}`;
                if (mocData.reverseRelations.has(key)) {
                    throw new Error(`箭头关系已存在: ${sourceID} → ${targetID}`);
                }

                // 添加箭头关系到 reverseRelations
                mocData.reverseRelations.set(key, {
                    sourceID: sourceID,
                    targetID: targetID,
                    relationText: relationText || ''
                });
            });
        } catch (error) {
            console.error('Failed to add arrow relation:', error);
            if (error.message.includes('已存在')) {
                new Notice(error.message);
            } else {
                throw error;
            }
        }
    }

    /**
     * 从 MOC 文件中删除箭头关系
     * @param mocFile - MOC 文件
     * @param sourceID - 源节点 ID
     * @param targetID - 目标节点 ID
     * @param targetNodeSons - 目标节点的子节点数量（用于约束检查）
     * @param edgeType - 边的类型（'parent' 或 'reverse'）
     */
    private async deleteArrowRelationFromMOC(mocFile: TFile, sourceID: string, targetID: string, targetNodeSons?: number, edgeType?: string): Promise<void> {
        try {
            // 约束 1：只能删除目标节点没有子节点的关系
            if (targetNodeSons !== undefined && targetNodeSons > 1) {
                new Notice(`无法删除：目标节点有 ${targetNodeSons} 个子节点`);
                return;
            }

            // 删除反向关系
            await this.mocHandler.modifyMOCData(mocFile, async (mocData) => {
                const key = `${sourceID}->${targetID}`;
                if (mocData.reverseRelations.has(key)) {
                    mocData.reverseRelations.delete(key);
                }
            });

            // 只有删除正向父子关系（edgeType === 'parent'）且目标节点有父节点时，才转换为自由节点
            // 删除反向关系（edgeType === 'reverse' 或 'cross-domain'）时，不应该影响目标节点的父子结构
            if (edgeType === 'parent' || edgeType === 'forward') {
                const targetNodeHasParent = await this.mocHandler.checkNodeHasParent(mocFile, targetID);

                if (targetNodeHasParent) {
                    new Notice(`已删除箭头关系: ${sourceID} → ${targetID}`);

                    // 无论目标节点 ID 是否以 free. 开头，都生成新的自由节点 ID
                    // 例如：free.1.a 会被重命名为 free.2，成为真正的自由节点
                    const newFreeID = this.generateNextFreeNodeID();

                    await this.mocHandler.convertChildToFreeNode(mocFile, targetID, newFreeID);
                    new Notice(`${targetID} 已转换为自由节点: ${newFreeID}`);
                } else {
                    new Notice(`已删除箭头关系: ${sourceID} → ${targetID}`);
                }
            } else {
                // 删除的是反向关系或跨领域关系，不需要转换节点
                const relationType = edgeType === 'cross-domain' ? '跨领域关系' : '反向关系';
                new Notice(`已删除${relationType}: ${sourceID} → ${targetID}`);
            }
        } catch (error) {
            console.error('Failed to delete arrow relation:', error);
            new Notice(`删除箭头关系失败: ${error.message}`);
        }
    }

    /**
     * 更新 MOC 文件中箭头关系的标签
     */
    private async updateArrowRelationLabelInMOC(mocFile: TFile, sourceID: string, targetID: string, newLabel: string): Promise<void> {
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {

                const key = `${sourceID}->${targetID}`;
                let relation = mocData.reverseRelations.get(key);
                if (!relation) {
                    // 兜底父子边可能不在 reverseRelations 中，创建条目
                    relation = { sourceID, targetID, relationText: '' };
                }

                // 更新关系标签
                relation.relationText = newLabel;
                mocData.reverseRelations.set(key, relation);

                // 如果是父子边，还需要更新节点树中的 relationText
                const targetParts = targetID.split('.');
                const isParentChild = targetParts.length > 1 && targetParts.slice(0, -1).join('.') === sourceID;
                if (isParentChild) {
                    const targetNode = this.findNodeInTree(mocData.nodes, targetID);
                    if (targetNode) {
                        targetNode.relationText = newLabel;
                    }
                }
            });

            new Notice(`已更新关系文本: ${sourceID} → ${targetID}`);
        } catch (error) {
            console.error('Failed to update arrow relation label:', error);
            new Notice(`更新关系文本失败: ${error.message}`);
        }
    }

    /**
     * 在节点树中查找指定 nodeID 的节点
     */
    private findNodeInTree(nodes: any[], nodeID: string): any {
        for (const node of nodes) {
            if (node.nodeID === nodeID) {
                return node;
            }
            if (node.children && node.children.length > 0) {
                const found = this.findNodeInTree(node.children, nodeID);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * 更新 MOC 文件中边的起点
     */
    private async updateEdgeSourceInMOC(
        mocFile: TFile,
        oldSource: string,
        newSource: string,
        target: string,
        label: string
    ): Promise<void> {
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 查找并删除旧的关系
                const oldKey = `${oldSource}->${target}`;
                const oldRelation = mocData.reverseRelations.get(oldKey) || { sourceID: oldSource, targetID: target, relationText: '' };

                // 删除旧关系
                mocData.reverseRelations.delete(oldKey);

                // 添加新关系（保留旧标签或使用新标签）
                const newKey = `${newSource}->${target}`;
                const finalLabel = label || oldRelation.relationText || '';
                mocData.reverseRelations.set(newKey, {
                    sourceID: newSource,
                    targetID: target,
                    relationText: finalLabel
                });
            });


        } catch (error) {
            console.error('Failed to update edge source:', error);
            throw error;
        }
    }

    /**
     * 更新 MOC 文件中边的终点（包含 ID 继承）
     */
    private async updateEdgeTargetInMOC(
        mocFile: TFile,
        source: string,
        oldTarget: string,
        newTarget: string,
        label: string
    ): Promise<void> {
        // 箭头关系边：直接修改 reverseRelations 中对应条目的 target
        await this.mocHandler.modifyMOCData(mocFile, (mocData: any) => {
            const oldKey = `${source}->${oldTarget}`;
            const rel = mocData.reverseRelations.get(oldKey);
            if (!rel) throw new Error(`未找到边: ${oldKey}`);
            mocData.reverseRelations.delete(oldKey);
            const newKey = `${source}->${newTarget}`;
            mocData.reverseRelations.set(newKey, { sourceID: source, targetID: newTarget, relationText: label || rel.relationText });
        });
    }

    /**
     * 冲刷待保存的防抖位置并保存当前画面所有节点位置。
     * 在切换 MOC 或刷新前调用，防止:
     * 1) 待保存位置被写入错误的 MOC 文件
     * 2) 当前画面位置丢失
     */
    private async flushAndSaveCurrentPositions(): Promise<void> {
        // 取消待执行的防抖定时器，丢弃 pending 数据（下面会整体保存）
        if (this.nodePositionSaveTimeout) {
            clearTimeout(this.nodePositionSaveTimeout);
            this.nodePositionSaveTimeout = null;
        }
        this.pendingPositionChanges.clear();
        if (this.pendingNodePositionSavePromise) {
            await this.pendingNodePositionSavePromise;
        }

        // 用 lastRenderedMOCPath 保存位置（这是当前 cy 实例真正对应的 MOC 文件）
        await this.saveAllNodePositionsBeforeRefresh(this.lastRenderedMOCPath || undefined);
    }

    /**
     * 在刷新前保存所有节点的当前位置（仅在位置发生变化时）
     * @param targetMOCPath 指定保存到哪个 MOC 文件，默认取当前设置
     */
    private async saveAllNodePositionsBeforeRefresh(targetMOCPath?: string): Promise<void> {
        if (!this.branchRenderer) {
            return;
        }
        // 草稿预览期(#20):真实节点被预览 reflow 临时移动了,此时绝不持久化它们的位置,
        // 否则会把临时布局写进文件,导致丢弃草稿后无法恢复原布局。
        if (this.draftNodes.size > 0) {
            return;
        }

        const cy = this.branchRenderer.getCytoscapeInstance();
        if (!cy) {
            return;
        }

        const mocFilePath = targetMOCPath || this.plugin.settings.mocCurrentFile;
        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (!mocFile) {
            return;
        }

        // 获取所有节点的当前位置
        const positions: Record<string, { x: number; y: number }> = {};

        cy.nodes('[!isGroup]').forEach((node: any) => {
            const data = node.data();
            const originalNode = data.originalNode;
            const nodeId = originalNode?.IDStr || originalNode?.ID;
            if (originalNode && nodeId) {
                // 草稿节点(#20)纯内存,绝不写文件
                if (data.isDraft || originalNode.isDraft) return;
                // 跳过跨领域节点（跨领域节点的位置保存在 cross_domain_links 中）
                if (originalNode.isCrossDomain || nodeId.startsWith('cd-')) {
                    return;
                }

                const pos = node.position();
                positions[nodeId] = {
                    x: Math.round(pos.x * 100) / 100,
                    y: Math.round(pos.y * 100) / 100
                };
            }
        });

        // 批量保存所有位置（仅在位置发生变化时）
        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 检查位置是否发生变化
                const oldPositions = mocData.nodePositions || {};
                let hasChanged = false;

                // 检查节点数量是否变化
                const newKeys = Object.keys(positions);
                const oldKeys = Object.keys(oldPositions);
                if (newKeys.length !== oldKeys.length) {
                    hasChanged = true;
                } else {
                    // 检查每个节点的位置是否变化
                    for (const nodeId of newKeys) {
                        const newPos = positions[nodeId];
                        const oldPos = oldPositions[nodeId];

                        if (!oldPos || newPos.x !== oldPos.x || newPos.y !== oldPos.y) {
                            hasChanged = true;
                            break;
                        }
                    }
                }

                // 只有在位置真正变化时才更新
                if (hasChanged) {
                    mocData.nodePositions = positions;
                } 
            });
        } catch (error) {
            console.error('[saveAllNodePositions] Failed to save:', error);
        }
    }

    /**
     * 保存节点位置到 MOC 文件的思维树标题末尾
     */
    private async saveNodePositionToMOC(mocFile: TFile, nodeID: string, position: { x: number; y: number }): Promise<void> {
        try {
            // 检查是否是跨领域节点（跨领域节点的 ID 以 "cd-" 开头）
            if (nodeID.startsWith('cd-')) {
                return;
            }

            const headingTitle = this.plugin.settings.mocHeadingTitle;

            // 解析当前的 MOC 结构
            const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
            const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);
            this.ensureMOCNodeLayoutStyle(mocData);

            // 更新节点位置
            mocData.nodePositions[nodeID] = {
                x: Math.round(position.x * 100) / 100, // 保留两位小数
                y: Math.round(position.y * 100) / 100
            };

            // 保存更新后的数据
            await saveMOCStructure(this.app, mocFile.path, headingTitle, mocData);

        } catch (error) {
            console.error('Failed to save node position to MOC:', error);
            new Notice(`保存节点位置失败: ${error.message}`);
        }
    }

    /**
     * 保存边弧度到 MOC 文件
     */
    private async saveEdgeCurvatureToMOC(mocFile: TFile, edgeId: string, curvature: { distance: number; weight: number }): Promise<void> {
        try {
            const headingTitle = this.plugin.settings.mocHeadingTitle;

            // 解析当前的 MOC 结构
            const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
            const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);
            this.ensureMOCNodeLayoutStyle(mocData);

            // 更新边弧度
            mocData.edgeCurvatures[edgeId] = {
                distance: Math.round(curvature.distance * 100) / 100, // 保留两位小数
                weight: Math.round(curvature.weight * 100) / 100
            };

            // 保存更新后的数据
            await saveMOCStructure(this.app, mocFile.path, headingTitle, mocData);

        } catch (error) {
            console.error('Failed to save edge curvature:', error);
            new Notice(`保存边弧度失败: ${error.message}`);
        }
    }

    /**
     * 删除边的手动弧度，让渲染器重新使用自动曲线样式
     */
    private async restoreEdgeAutoStyleInMOC(mocFile: TFile, edgeId: string): Promise<void> {
        try {
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
            const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);
            this.ensureMOCNodeLayoutStyle(mocData);

            if (mocData.edgeCurvatures && mocData.edgeCurvatures[edgeId]) {
                delete mocData.edgeCurvatures[edgeId];
            }

            await saveMOCStructure(this.app, mocFile.path, headingTitle, mocData);

        } catch (error) {
            console.error('Failed to restore edge auto style:', error);
            new Notice(`恢复自动样式失败: ${error.message}`);
        }
    }

    /**
     * 保存预览节点尺寸到 MOC 文件 ext（embed_node_sizes）
     */
    private async saveEmbedNodeSizeToMOC(
        mocFile: TFile,
        nodeID: string,
        size: { widthModel: number; heightModel: number }
    ): Promise<void> {
        try {
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
            const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);
            this.ensureMOCNodeLayoutStyle(mocData);

            if (!(mocData as any).embedNodeSizes) {
                (mocData as any).embedNodeSizes = {};
            }

            (mocData as any).embedNodeSizes[nodeID] = {
                width: Math.round(size.widthModel * 100) / 100,
                height: Math.round(size.heightModel * 100) / 100
            };

            await saveMOCStructure(this.app, mocFile.path, headingTitle, mocData);
        } catch (error) {
            console.error('Failed to save embed node size to MOC:', error);
            new Notice(`保存预览节点尺寸失败: ${error.message}`);
        }
    }

    private async clearEmbedNodeSizeFromMOC(mocFile: TFile, nodeID: string): Promise<void> {
        try {
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
            const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);
            this.ensureMOCNodeLayoutStyle(mocData);
            if (!(mocData as any).embedNodeSizes?.[nodeID]) return;

            delete (mocData as any).embedNodeSizes[nodeID];
            await saveMOCStructure(this.app, mocFile.path, headingTitle, mocData);
        } catch (error) {
            console.error('Failed to clear embed node size from MOC:', error);
            new Notice(`清理节点尺寸失败: ${error.message}`);
        }
    }

    private async resetTextNodeAutoSize(node: ZKNode): Promise<void> {
        const nodeID = node.IDStr || node.ID;
        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile || !nodeID) return;

        try {
            await this.clearEmbedNodeSizeFromMOC(mocFile, nodeID);

            const cyNode = this.branchRenderer?.getCytoscapeInstance()?.$id(nodeID);
            if (cyNode?.length) {
                cyNode.removeData('manualWidthModel manualHeightModel');
                if (typeof cyNode.removeStyle === 'function') {
                    cyNode.removeStyle('width height');
                }
            }

            await this.refreshBranchMermaid();
        } catch (error) {
            console.error('Failed to reset text node auto size:', error);
            new Notice(`恢复自动尺寸失败: ${error.message}`);
        }
    }

    /**
     * 保存跨领域节点位置到 cross_domain_links
     */
    private async saveCrossDomainNodePosition(
        mocFile: TFile,
        sourceNodeId: string,
        crossDomainLink: any,
        position: { x: number; y: number }
    ): Promise<void> {
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            const roundedPosition = {
                x: Math.round(position.x * 100) / 100,
                y: Math.round(position.y * 100) / 100
            };

            // 初始化 cross_domain_links
            if (!mocData.crossDomainLinks) {
                mocData.crossDomainLinks = {};
            }

            // 使用源节点 ID 作为键
            if (!mocData.crossDomainLinks[sourceNodeId]) {
                mocData.crossDomainLinks[sourceNodeId] = [];
            }

            // 查找对应的跨领域关联
            const links = mocData.crossDomainLinks[sourceNodeId];
            const link = links.find(l =>
                l.nodeId === crossDomainLink.nodeId &&
                l.mocPath === crossDomainLink.mocPath
            );

            if (link) {
                // 更新位置信息
                link.position = roundedPosition;
            } else {
                // 如果找不到，创建新的链接记录
                links.push({
                    nodeId: crossDomainLink.nodeId,
                    mocPath: crossDomainLink.mocPath,
                    displayText: crossDomainLink.displayText,
                    filePath: crossDomainLink.filePath,
                    position: roundedPosition
                });
            }
        });
    }

    /**
     * 保存跨领域边的关系标签到 cross_domain_links.relationLabel
     * 空标签(或等于默认"跨领域")时清掉字段,回退默认显示。
     */
    private async saveCrossDomainRelationLabel(
        mocFile: TFile,
        sourceNodeId: string,
        crossDomainLink: any,
        newLabel: string
    ): Promise<void> {
        const trimmed = (newLabel || '').trim();
        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            const links = mocData.crossDomainLinks?.[sourceNodeId];
            if (!links) return;
            const link = links.find(l =>
                l.nodeId === crossDomainLink.nodeId &&
                l.mocPath === crossDomainLink.mocPath
            );
            if (!link) return;
            if (!trimmed || trimmed === '跨领域') {
                delete (link as any).relationLabel;
            } else {
                (link as any).relationLabel = trimmed;
            }
        });
    }

    /**
     * 打开跨界思维树
     * @param mocPath - 跨界 MOC 文件路径
     */
    private async openCrossDomainMOC(mocPath: string): Promise<void> {
        try {
            // 验证文件存在
            const mocFile = this.app.vault.getFileByPath(mocPath);
            if (!mocFile) {
                new Notice(`找不到 MOC 文件: ${mocPath}`);
                return;
            }

            // 切换当前 MOC 文件
            this.plugin.settings.mocCurrentFile = mocPath;

            // 刷新视图
            await this.refreshBranchMermaid();

            new Notice(`已切换到: ${mocFile.basename}`);
        } catch (error) {
            console.error('Failed to open cross-domain MOC:', error);
            new Notice(`打开跨界思维树失败: ${error.message}`);
        }
    }

    private isMobileReadOnly(): boolean {
        return Platform.isMobile;
    }

    /**
     * 根据「文件默认打开方式」设置返回一个用于打开笔记的 leaf。
     * 关键:锚定一个真正的文件视图叶(FileView),绝不拿图谱自己的 leaf 去打开,
     * 否则 getLeaf('tab')/getLeaf(false) 会把图谱盖住或覆盖掉。
     * forceTab=true(Cmd/Ctrl+点击)时始终新标签页;主区没有文件叶时退化为在图谱旁开分屏。
     */
    private getFileOpenLeaf(forceTab: boolean): WorkspaceLeaf {
        const ws = this.app.workspace;
        const mode = forceTab ? 'tab' : (this.plugin.settings.defaultFileOpenMode || 'tab');

        // 主区域里真正的文件视图叶(markdown / excalidraw / pdf / image 等),最近用的优先
        const contentLeaves: WorkspaceLeaf[] = [];
        ws.iterateRootLeaves(l => { if (this.isUserFileLeaf(l)) contentLeaves.push(l); });
        const recent = ws.getMostRecentLeaf();
        const anchor: WorkspaceLeaf | null =
            (recent && contentLeaves.includes(recent)) ? recent : (contentLeaves[0] ?? null);

        // 在图谱旁新建分屏(并缓存复用,连续点击不会堆出一排分屏)
        const splitBesideGraph = (before: boolean): WorkspaceLeaf => {
            let alive = false;
            if (this.fileOpenSplitLeaf) ws.iterateAllLeaves(l => { if (l === this.fileOpenSplitLeaf) alive = true; });
            if (alive && this.fileOpenSplitLeaf) return this.fileOpenSplitLeaf;
            // before=true 放图谱左侧,false 放右侧
            const leaf = ws.createLeafBySplit(this.leaf, 'vertical', before);
            this.fileOpenSplitLeaf = leaf;
            return leaf;
        };

        if (mode === 'split-left') return splitBesideGraph(true);
        if (mode === 'split-right') return splitBesideGraph(false);

        if (mode === 'tab') {
            // 有内容叶 → 在其标签组里新建标签(不碰图谱);否则在图谱旁开分屏,避免盖住图谱
            if (anchor) {
                ws.setActiveLeaf(anchor, { focus: false });
                return ws.getLeaf('tab');
            }
            return splitBesideGraph(false);
        }

        // 'replace':覆盖最近的内容叶;主区没有文件叶时在图谱旁开分屏(绝不覆盖图谱)
        return anchor ?? splitBesideGraph(false);
    }

    private getWikiSubpath(wikiLink: string): string {
        const raw = String(wikiLink || '').trim();
        const hashIdx = raw.indexOf('#');
        return hashIdx >= 0 ? raw.substring(hashIdx) : '';
    }

    private isUserFileLeaf(leaf: WorkspaceLeaf): boolean {
        const view = leaf.view as any;
        const viewType = view?.getViewType?.();
        return view instanceof FileView && ![
            ZK_INDEX_TYPE,
            'zk-graph-type',
            'zk-recent-type',
            'zk-moc-preview',
        ].includes(viewType);
    }

    private getExistingFileLeaf(file: TFile): WorkspaceLeaf | null {
        let existingLeaf: WorkspaceLeaf | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!existingLeaf && this.isUserFileLeaf(leaf) && (leaf.view as any)?.file?.path === file.path) {
                existingLeaf = leaf;
            }
        });
        return existingLeaf;
    }

    private shouldReuseExistingFileLeaf(forceTab: boolean): boolean {
        return !forceTab && (this.plugin.settings.defaultFileOpenMode || 'tab') === 'replace';
    }

    private openFileInPreferredLeaf(file: TFile, forceTab: boolean, subpath: string = ''): void {
        if (this.shouldReuseExistingFileLeaf(forceTab)) {
            const existingLeaf = this.getExistingFileLeaf(file);
            if (existingLeaf) {
                this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                if (subpath) (existingLeaf.view as any).setEphemeralState?.({ subpath });
                return;
            }
        }

        const leaf = this.getFileOpenLeaf(forceTab);
        if (subpath) leaf.openFile(file, { eState: { subpath }, active: true } as any);
        else leaf.openFile(file);
    }

    /**
     * 由节点内 wiki 链接(concept/text-only 节点里的 [[..]])点击触发。
     * 解析 linkText → 文件后,按「文件默认打开方式」打开;复用 getFileOpenLeaf,
     * 因此和直接点文件节点行为一致,绝不覆盖图谱。
     */
    private openLinkInPreferredLeaf(linkText: string, sourcePath: string, forceTab: boolean): void {
        const raw = (linkText || '').trim();
        if (!raw) return;
        const subpath = this.getWikiSubpath(raw);
        const hashIdx = raw.indexOf('#');
        const pathPart = (hashIdx >= 0 ? raw.substring(0, hashIdx) : raw).trim();
        const targetFile = this.app.metadataCache.getFirstLinkpathDest(pathPart, sourcePath || '');
        if (!targetFile) {
            // 解析失败(未创建的链接等)→ 退回 Obsidian 默认行为
            this.app.workspace.openLinkText(raw, sourcePath || '', forceTab ? 'tab' : false);
            return;
        }
        this.openFileInPreferredLeaf(targetFile, forceTab, subpath);
    }

    private mocFullscreenExitBtn: HTMLElement | null = null;

    private toggleMocFullscreen(): void {
        const isFullscreen = document.querySelectorAll('.zk-hidden').length > 0;

        const toggleClassList: string[] = [
            '.workspace-ribbon.side-dock-ribbon.mod-left',
            '.workspace-split.mod-horizontal.mod-left-split',
            '.workspace-tab-header-container',
            '.titlebar-button-container.mod-right',
            '.status-bar',
        ];

        if (isFullscreen) {
            // 退出全屏
            toggleClassList.forEach((cls) => {
                document.querySelectorAll(cls).forEach((el) => el.removeClass('zk-hidden'));
            });
            if (this.mocFullscreenExitBtn) {
                this.mocFullscreenExitBtn.remove();
                this.mocFullscreenExitBtn = null;
            }
        } else {
            // 进入全屏
            toggleClassList.forEach((cls) => {
                document.querySelectorAll(cls).forEach((el) => el.addClass('zk-hidden'));
            });
            // 直接挂到 document.body，彻底脱离 Obsidian 视图层级
            const btn = document.createElement('button');
            btn.className = 'zk-moc-fullscreen-exit';
            setIcon(btn, 'arrow-left');
            btn.setCssStyles({
                position: 'fixed',
                top: '20px',
                left: '12px',
                zIndex: '99999',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '52px',
                height: '36px',
                padding: '0',
                borderRadius: '10px',
                border: '1.5px solid #4a4a6a',
                backgroundColor: 'rgba(30, 30, 50, 0.6)',
                color: '#c8c8e0',
                cursor: 'pointer',
                pointerEvents: 'auto',
                touchAction: 'manipulation',
            });
            btn.setCssProps({ '-webkit-tap-highlight-color': 'transparent' });
            const self = this;
            btn.ontouchstart = function(e) {
                e.stopPropagation();
            };
            btn.ontouchend = function(e) {
                e.preventDefault();
                e.stopPropagation();
                self.toggleMocFullscreen();
            };
            btn.onclick = function(e) {
                e.preventDefault();
                e.stopPropagation();
                self.toggleMocFullscreen();
            };
            document.body.appendChild(btn);
            this.mocFullscreenExitBtn = btn;
        }
    }

    // ============================================================
    // 临时工作区(Scratchpad)集成
    // ============================================================

    /**
     * 当前 MOC 文件名(用于来源标记)
     */
    private getCurrentMOCDisplayName(): string {
        const path = this.plugin.settings.mocCurrentFile;
        if (!path) return '';
        const file = this.app.vault.getFileByPath(path);
        return file ? stripMocSuffix(file.basename) : path;
    }

    /**
     * 复制/剪切节点到暂存区。
     * - 不传 explicitNode:用 cytoscape 当前选中的节点(快捷键路径)
     * - 传 explicitNode:用指定节点(右键菜单路径)
     * 返回 true 表示拦截了快捷键。
     */
    private copySelectionToScratchpad(operation: 'cut' | 'copy', explicitNode?: ZKNode): boolean {
        const scratchpad = this.plugin.scratchpad;
        if (!scratchpad) return false;

        const nodes: ZKNode[] = [];
        if (explicitNode) {
            if (!explicitNode.isCrossDomain && !explicitNode.isPlaceholder) {
                nodes.push(explicitNode);
            }
        } else {
            const cy = this.branchRenderer?.getCytoscapeInstance();
            if (!cy) return false;
            const selectedRaw = cy.$(':selected').filter('node[!isGroup]');
            selectedRaw.forEach((cyNode: any) => {
                const data = cyNode.data();
                const original = data?.originalNode as ZKNode | undefined;
                if (!original) return;
                if (data?.isPlaceholder) return;
                if (original.isCrossDomain || original.isPlaceholder) return;
                nodes.push(original);
            });
        }
        if (nodes.length === 0) return false;

        const mocPath = this.plugin.settings.mocCurrentFile;
        const mocName = this.getCurrentMOCDisplayName();
        const mocFile = mocPath ? this.app.vault.getFileByPath(mocPath) : null;

        // copy 立即入暂存(无副作用);cut 先入暂存再删原节点
        void (async () => {
            for (const node of nodes) {
                const entry = scratchpad.buildEntry(node, mocPath, mocName, operation);
                await scratchpad.add(entry);
            }
            if (operation === 'cut' && mocFile) {
                try {
                    await this.saveAllNodePositionsBeforeRefresh();
                    const cutIds: string[] = nodes
                        .filter((node) => !node.isCrossDomain)
                        .map((node) => node.IDStr);
                    // 删除前解析真实父级(自由节点父子关系只在边里,删除+刷新后丢失)
                    const reflowParentId = this.pickAutoLayoutParentForReflow(cutIds);
                    for (const id of cutIds) {
                        await this.mocHandler.deleteNodeFromMOC(mocFile, id);
                    }
                    await new Promise(r => setTimeout(r, 20));
                    await this.refreshBranchMermaid();

                    // 声明式 reflow: scratchpad cut 后整棵树重排
                    if (reflowParentId) {
                        await this.reflowAutoLayout(reflowParentId);
                    }

                    new Notice(t("scratch cut notice").replace('{n}', String(nodes.length)));
                } catch (e) {
                    console.error("[scratchpad] cut 失败", e);
                    new Notice(t("scratch cut failed"));
                }
            } else {
                new Notice(t("scratch copy notice").replace('{n}', String(nodes.length)));
            }
        })();

        return true;
    }

    /**
     * 粘贴暂存区顶部(最新)的一个节点到视口中心。返回 true 表示拦截。
     */
    private pasteTopFromScratchpad(): boolean {
        const scratchpad = this.plugin.scratchpad;
        if (!scratchpad) return false;
        const top = scratchpad.list()[0];
        if (!top) return false;

        const position = this.getViewportCenterModelPosition();
        void this.materializeScratchpadEntryAt(top, position);
        return true;
    }

    /**
     * Cmd+V 统一入口:先让渲染器尝试用外部剪贴板 / 内部节点处理;
     * 若两者皆无可用内容,再退化到 scratchpad 顶部条目。
     */
    private async dispatchPasteShortcut(): Promise<void> {
        if (this.branchRenderer) {
            const handled = await this.branchRenderer.handlePasteShortcut();
            if (handled) return;
        }
        this.pasteTopFromScratchpad();
    }

    private getViewportCenterModelPosition(): { x: number; y: number } {
        const cy = this.branchRenderer?.getCytoscapeInstance();
        if (!cy) return { x: 0, y: 0 };
        const pan = cy.pan();
        const zoom = cy.zoom();
        return {
            x: (cy.width() / 2 - pan.x) / zoom,
            y: (cy.height() / 2 - pan.y) / zoom,
        };
    }

    private getScratchpadTextContent(entry: ScratchpadEntry): string {
        const raw = (entry.target || entry.displayText || '').trim();
        const id = entry.origin?.nodeId || '';
        if (!raw) return '';
        if (!id) return raw.replace(/^[a-zA-Z0-9._]+\s*[:：]\s*/, '').trim() || raw;

        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return raw.replace(new RegExp(`^${escaped}\\s*[:：\\-_\\s]\\s*`), '').trim() || raw;
    }

    /**
     * 把暂存条目落到画布(给定模型坐标)。落地后从暂存区移除该条目。
     */
    private async materializeScratchpadEntryAt(
        entry: ScratchpadEntry,
        position: { x: number; y: number }
    ): Promise<void> {
        const mocPath = this.plugin.settings.mocCurrentFile;
        if (!mocPath) {
            new Notice(t("scratch no current moc"));
            return;
        }
        const mocFile = this.app.vault.getFileByPath(mocPath);
        if (!mocFile) {
            new Notice(t("scratch no current moc"));
            return;
        }

        // 落点处按新 MOC 的层级重新生成 ID
        const newID = this.generateNextFreeNodeID();

        try {
            if (entry.kind === 'text') {
                await this.saveFreeNodeToMOC({
                    text: this.getScratchpadTextContent(entry),
                    nodeID: newID,
                    relationText: '',
                    file: null,
                    isTextOnly: true,
                });
            } else {
                // file / embed:解析 wikiLink 找文件
                const hashIdx = entry.target.indexOf('#');
                const wikiPathOnly = hashIdx >= 0 ? entry.target.substring(0, hashIdx) : entry.target;
                const file = this.app.metadataCache.getFirstLinkpathDest(wikiPathOnly, '');
                await this.saveFreeNodeToMOC({
                    wikiLink: entry.target,
                    alias: entry.alias,
                    nodeID: newID,
                    relationText: '',
                    file: file,
                    isTextOnly: false,
                    isEmbed: entry.kind === 'embed',
                });
            }

            // 保存落点位置
            await this.saveNodePositionToMOC(mocFile, newID, position);

            // 从暂存区移除(粘贴 = 消费)
            await this.plugin.scratchpad?.remove(entry.tempId);

            await new Promise(r => setTimeout(r, 20));
            await this.refreshBranchMermaid();

            // 选中新节点
            const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
            branchGraphDiv?.dispatchEvent(new CustomEvent('select-node-by-id', {
                detail: { nodeId: newID }
            }));
        } catch (e) {
            console.error("[scratchpad] 粘贴失败", e);
            new Notice(t("scratch paste failed"));
        }
    }

    /**
     * 双击暂存卡片 → 落到画布视口中心(替代鼠标拖拽的备用路径)
     */
    private registerScratchpadDocumentListeners(): void {
        const onPasteCenter = (e: any) => {
            const tempId = e?.detail?.tempId;
            if (!tempId) return;
            const found = this.plugin.scratchpad?.get(tempId);
            if (!found) return;
            const pos = this.getViewportCenterModelPosition();
            void this.materializeScratchpadEntryAt(found.entry, pos);
        };
        this.addTrackedListener(document, 'scratchpad-paste-center', onPasteCenter as any);
    }
}
