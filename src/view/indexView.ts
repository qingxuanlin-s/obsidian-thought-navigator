import ZKNavigationPlugin from "main";
import { ExtraButtonComponent, FuzzySuggestModal, ItemView, Menu, Modal, Notice, Platform, Scope, Setting, TFile, WorkspaceLeaf, debounce, moment, setIcon, setTooltip } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { AddFreeNodeModal } from "src/modal/addFreeNodeModal";
import { expandGraphModal } from "src/modal/expandGraphModal";
import { MOCSelectorModal } from "src/modal/mocSelectorModal";
import { NoteSearchModal } from "src/modal/noteSearchModal";
import { convertMOCToZKNodes, getMOCFilesInFolder, MOCParseResult, MOCTreeNode, parseMOCStructure } from "src/utils/utils";
import { MermaidParser } from "src/utils/mermaidParser";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { RenderOptions } from "src/renderer/types";
import { MOCHandler } from "src/view/index/mocHandler";
import {
    DEBOUNCE_DELAY,
    ERROR_MESSAGES,
    SUCCESS_MESSAGES,
    KEYBOARD,
    MODAL_BUTTONS
} from "src/view/index/constants";

export const ZK_INDEX_TYPE: string = "zk-index-type";
export const ZK_INDEX_VIEW: string = t("zk-index-graph");
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
    isTextOnly?: boolean; // 是否为纯文字节点（不关联文件）
    isEmbed?: boolean; // 是否为嵌入节点（![[...]]）
    wikiLink?: string; // 原始 wikilink（用于官方预览解析）
}

interface BrancAllhNodes {
    branchTab: number;
    branchNodes: ZKNode[];
}

export class ZKIndexView extends ItemView {

    plugin: ZKNavigationPlugin;
    branchAllNodes: BrancAllhNodes[];


    // 按需渲染相关属性
    branchEntranceNodes: ZKNode[] = [];
    renderedBranches: Set<number> = new Set();
    indexMermaidContainer: HTMLElement | null = null;

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
    private currentNodeLayoutStyle: 'free' | 'auto' = 'free'; // 当前 MOC 文件的节点布局风格（从 ext 读取，新建时锁定）

    // 防抖相关属性
    resizeTimeout: NodeJS.Timeout | null = null;
    edgeCurvatureSaveTimeout: NodeJS.Timeout | null = null;
    nodePositionSaveTimeout: NodeJS.Timeout | null = null;
    pendingPositionChanges: Map<string, { node: any; position: { x: number; y: number } }> = new Map();
    crossDomainPositionSaveTimeout: NodeJS.Timeout | null = null;
    embedNodeSizeSaveTimeout: NodeJS.Timeout | null = null;

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

    // 占位符节点追踪（用于未完成编辑的临时节点）
    private placeholderNodes: Map<string, {
        nodeId: string;
        tempId: string;
        content: string;
        position: { x: number; y: number };
        timestamp: number;
        parentNodeId?: string;
        suggestedNodeId?: string;  // 预生成的节点 ID
        childNodeId?: string;  // 需要移动到此节点下的子节点 ID（用于创建父节点时）
    }> = new Map();

    // MOC 芯片标签引用（用于更新显示）
    private mocChipLabel: HTMLElement | null = null;
    private multiverseContainer: HTMLElement | null = null;

    // 性能优化：防止重复刷新的标志位
    private isRefreshing: boolean = false;
    private pendingRefresh: boolean = false;

    // 性能优化：静态 UI 层标记
    private staticUICreated: boolean = false;
    private staticToolbarDiv: HTMLElement | null = null;

    // 性能优化：追踪事件监听器初始化状态，避免重复添加
    private branchGraphListenersInitialized: boolean = false;
    private currentBranchGraphDiv: HTMLElement | null = null;
    private fullscreenBackButtonListenerBound: boolean = false;
    private lastHoverPreviewPath: string | null = null;
    private lastHoverPreviewAt = 0;
    private undoStack: Array<{ filePath: string; content: string; timestamp: number }> = [];
    private readonly MAX_UNDO_STEPS = 7;
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

        backBtn.style.display = this.getFullscreenElement() === branchGraphDiv ? 'inline-flex' : 'none';
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

        backBtn.classList.toggle('zk-branch-fullscreen-back-btn-light', this.plugin.settings.themeMode === 'light');
        backBtn.classList.toggle('zk-branch-fullscreen-back-btn-dark', this.plugin.settings.themeMode !== 'light');
        backBtn.setAttribute('aria-label', t("exit fullscreen"));
        setTooltip(backBtn, t("exit fullscreen"));
        this.syncBranchFullscreenBackButtonVisibility();
    }

    constructor(leaf: WorkspaceLeaf, plugin: ZKNavigationPlugin) {
        super(leaf);
        this.plugin = plugin;
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
        this.mocHandler = new MOCHandler(plugin, (this.app as any), {
            onBeforeModify: ({ filePath, content }) => {
                if (this.isApplyingUndo) return;
                this.pushUndoSnapshot(filePath, content);
            }
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
            // 清理解析缓存，确保读取到最新回退内容
            const { MermaidParser } = await import('src/utils/mermaidParser');
            MermaidParser.clearCacheForFile(snapshot.filePath);

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
        indicator.innerHTML = `
            <div class="zk-spinner"></div>
            <span>${t("Updating...")}</span>
        `;
        indicator.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--background-primary);
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            z-index: 1000;
            display: flex;
            align-items: center;
            gap: 10px;
        `;
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
            setIcon(mainNoteChip.createSpan("zk-chip-icon"), "file-text");
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

        // 获取当前MOC名称
        const currentMOCPath = this.plugin.settings.mocCurrentFile;
        const currentMOCFile = currentMOCPath ? this.app.vault.getAbstractFileByPath(currentMOCPath) : null;
        let currentMOCName = currentMOCFile instanceof TFile ? currentMOCFile.basename : "未命名";
        const maxLength = 12;
        if (currentMOCName.length > maxLength) {
            currentMOCName = currentMOCName.substring(0, maxLength) + "...";
        }
        mocLabel.setText(currentMOCName);

        // 保存引用以便后续更新
        this.mocChipLabel = mocLabel;
        mocChip.addEventListener("click", () => {
            this.openMOCSelectorModal();
        });

        breadcrumbNav.createSpan("zk-breadcrumb-sep").setText("\u203A");

        // 风格选择（药丸下拉）
        const graphTypeChip = breadcrumbNav.createDiv("zk-chip zk-chip-outlined zk-chip-dropdown");
        const graphTypeLabel = graphTypeChip.createSpan("zk-chip-label");
        graphTypeLabel.setText(t("structure"));
        setIcon(graphTypeChip.createSpan("zk-chip-chevron"), "chevron-down");

        const graphTypeSelect = graphTypeChip.createEl("select", { cls: "zk-chip-select" });
        graphTypeSelect.createEl("option", { value: "structure", text: t("structure") });
        graphTypeSelect.createEl("option", { value: "roadmap", text: t("roadmap") + " (Future)" });
        graphTypeSelect.value = this.plugin.settings.graphType || "structure";
        graphTypeLabel.setText(graphTypeSelect.options[graphTypeSelect.selectedIndex].text);
        graphTypeSelect.addEventListener("change", () => {
            let val = graphTypeSelect.value;
            if (val === "roadmap") {
                new Notice("路线图功能即将推出");
                val = "structure";
                graphTypeSelect.value = "structure";
            }
            this.plugin.settings.graphType = val;
            graphTypeLabel.setText(graphTypeSelect.options[graphTypeSelect.selectedIndex].text);
            this.plugin.clearShowingSettings(this.plugin.settings.BranchTab);
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
            this.app.workspace.trigger("zk-navigation:refresh-local-graph");
        });

        // 平行宇宙面包屑：选中节点 + MOC 徽章（动态区域）
        this.multiverseContainer = breadcrumbNav.createDiv("zk-multiverse-container");
        this.multiverseContainer.style.display = "none";

        // 右侧工具按钮（用 spacer 推到右边）
        const spacer = toolbarDiv.createDiv("zk-toolbar-spacer");

        // 创建右侧按钮容器
        const rightBtns = toolbarDiv.createDiv("zk-toolbar-right-buttons");

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
        let changeRefreshTimer: NodeJS.Timeout | null = null;

        const smartChangeRefresh = () => {
            const now = Date.now();
            const timeSinceLastEdit = now - lastEditTime;

            // 如果最后编辑在 2 秒内，说明还在编辑，再延迟 5 秒
            if (timeSinceLastEdit < 2000) {
                if (changeRefreshTimer) {
                    clearTimeout(changeRefreshTimer);
                }
                changeRefreshTimer = setTimeout(smartChangeRefresh, 5000);
            } else {
                // 超过 2 秒没有编辑，执行刷新
                this.plugin.RefreshIndexViewFlag = true;
                changeRefreshTimer = null;
            }
        };

        this.registerEvent(this.app.metadataCache.on("changed", async (file) => {
            const activeFile = this.app.workspace.getActiveFile();
            // 只在当前活动文件变化时刷新
            if (activeFile && file.path === activeFile.path) {
                lastEditTime = Date.now();
                
                // 如果没有定时器在运行，启动一个
                if (!changeRefreshTimer) {                
                    changeRefreshTimer = setTimeout(smartChangeRefresh, 5000);
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
            t === 'Files'
        );
    }

    private resolveDroppedVaultFiles(event: DragEvent): TFile[] {
        const dt = event.dataTransfer;
        if (!dt) return [];

        const candidateValues = new Set<string>();
        const addCandidate = (value?: string | null) => {
            if (!value) return;
            const trimmed = value.trim();
            if (!trimmed) return;
            candidateValues.add(trimmed);
        };

        addCandidate(dt.getData('text/plain'));
        addCandidate(dt.getData('text/uri-list'));
        addCandidate(dt.getData('text/x-obsidian-uri'));
        addCandidate(dt.getData('application/x-obsidian-uri'));
        addCandidate(dt.getData('application/x-obsidian-file'));

        for (const type of Array.from(dt.types || [])) {
            try {
                addCandidate(dt.getData(type));
            } catch (_) {
                // 某些类型不可读，忽略即可
            }
        }

        const vaultFiles = this.app.vault.getFiles();
        const tryResolvePath = (raw: string): TFile | null => {
            const normalized = decodeURIComponent(raw)
                .replace(/^file:\/\//, '')
                .replace(/^obsidian:\/\/open\?file=/, '')
                .replace(/^obsidian:\/\/advanced-uri\?.*?file=/, '')
                .replace(/^\//, '');

            if (!normalized) return null;

            const exact = this.app.vault.getFileByPath(normalized);
            if (exact instanceof TFile) return exact;

            const withoutVaultPrefix = normalized.replace(/^.*?\/(?=[^/]+\/[^/]+$)/, '');
            const maybeExact = this.app.vault.getFileByPath(withoutVaultPrefix);
            if (maybeExact instanceof TFile) return maybeExact;

            const basename = normalized
                .replace(/\[\[|\]\]/g, '')
                .split('|')[0]
                .split('#')[0]
                .split('/')
                .pop();
            if (!basename) return null;

            return vaultFiles.find(f =>
                f.path === basename ||
                f.basename === basename ||
                f.path.endsWith(`/${basename}`)
            ) || null;
        };

        const resolvedFiles: TFile[] = [];
        const seenPaths = new Set<string>();
        const pushResolved = (file: TFile | null) => {
            if (!file) return;
            if (seenPaths.has(file.path)) return;
            seenPaths.add(file.path);
            resolvedFiles.push(file);
        };

        for (const value of candidateValues) {
            const resolved = tryResolvePath(value);
            if (resolved) {
                pushResolved(resolved);
                continue;
            }

            try {
                const parsed = JSON.parse(value);
                if (typeof parsed === 'string') {
                    pushResolved(tryResolvePath(parsed));
                } else if (parsed && typeof parsed === 'object') {
                    const pathLike = parsed.path || parsed.file || parsed.filePath || parsed.sourcePath;
                    pushResolved(tryResolvePath(pathLike));
                }
            } catch (_) {
                // 非 JSON，忽略
            }
        }

        return resolvedFiles;
    }

    private async createDroppedFileNode(file: TFile, position: { x: number; y: number }): Promise<void> {
        const nodeID = this.generateNextFreeNodeID();
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (!mocFilePath) return;

        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (!mocFile) return;

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
                    wikiLink: file.basename,
                    nodeID,
                    displayText: file.basename,
                    depth: 0,
                    children: [],
                    file,
                    relationText: '',
                    isTextOnly: false,
                    isEmbed: false
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

    async refreshBranchMermaid() {

        this.plugin.RefreshIndexViewFlag = false;
        const indexMermaidDiv = document.getElementById("zk-index-mermaid-container");

        if (!indexMermaidDiv) return;

        await this.refreshBranchMermaidMOC(indexMermaidDiv);
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
            // 主题 / 视觉
            s.themeMode,
            s.themeStyle || 'modern',
            s.edgeStyle || 'bezier',
            s.nodeColor || '',
            // 布局
            s.DirectionOfBranchGraph || 'LR',
            s.nodeLayoutStyle || 'free',
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

    // MOC 模式专用的刷新方法
    // MOC 模式专用的刷新方法 - 使用 Cytoscape 渲染
    async refreshBranchMermaidMOC(indexMermaidDiv: HTMLElement) {
        // 仅在 MOC 文件真正切换时才冲刷保存旧画面位置，避免同文件刷新覆盖刚写入的位置
        const incomingMOCPath = this.plugin.settings.mocCurrentFile;

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

        // 解析当前 MOC 文件
        let currentMOCPath = this.plugin.settings.mocCurrentFile;

        // 性能优化：仅在未设置当前 MOC 时才做全 vault 扫描回退；
        // 否则直接 O(1) 读设置，避免每次刷新都 O(V) 过滤整个 vault 文件列表
        if (!currentMOCPath) {
            const mocFiles = getMOCFilesInFolder(this.app, mocFolder);
            if (mocFiles.length === 0) {
                new Notice(t("No MOC files found in the specified folder"));
                return;
            }
            currentMOCPath = mocFiles[0].path;
            this.plugin.settings.mocCurrentFile = currentMOCPath;
            await this.plugin.saveData(this.plugin.settings);
        }

        const currentMOCFile = this.app.vault.getAbstractFileByPath(currentMOCPath);

        if (!(currentMOCFile instanceof TFile)) {
            new Notice("Invalid MOC file");
            return;
        }

        // 性能优化：如果文件 mtime 和影响渲染的设置都没变，且 cy 实例仍对应同一文件，
        // 说明这是一次无实质变化的刷新（如窗口 resize、其他模块触发的事件），直接跳过
        // parse → convert → build → render 整条热路径，只同步容器尺寸即可。
        const renderSignature = this.computeRenderSignature(currentMOCPath, currentMOCFile.stat.mtime);
        const cyInstance = this.branchRenderer?.getCytoscapeInstance();
        if (
            cyInstance
            && this.lastRenderedMOCPath === currentMOCPath
            && this.lastRenderSignature === renderSignature
        ) {
            const existingGraphDiv = document.getElementById("zk-branch-cytoscape") as HTMLElement | null;
            if (existingGraphDiv) {
                const graphHeight = Math.max(220, this.containerEl.offsetHeight - 80);
                if (existingGraphDiv.style.height !== `${graphHeight}px`) {
                    existingGraphDiv.style.height = `${graphHeight}px`;
                    cyInstance.resize();
                }
                return;
            }
        }

        const mocParseResult = await parseMOCStructure(this.app, currentMOCPath, headingTitle);

        // 读取 MOC 文件中持久化的节点布局风格；若未记录则使用全局设置
        this.currentNodeLayoutStyle = this.normalizeNodeLayoutStyle(
            mocParseResult.nodeLayoutStyle,
            this.plugin.settings.nodeLayoutStyle
        );

        // 转换为 ZKNode（即使为空也继续）
        this.mocNodes = mocParseResult.nodes.length > 0
            ? await convertMOCToZKNodes(this.plugin, mocParseResult.nodes, mocParseResult.reverseRelations, [], mocParseResult.nodePositions)
            : [];
        // 克隆 reverseRelations Map，避免修改缓存中的数据
        this.mocReverseRelations = new Map(Array.from(mocParseResult.reverseRelations.entries()));

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
        branchGraphDiv.style.height = `${graphHeight}px`;
        branchGraphDiv.style.width = "100%";

        if (this.isMobileReadOnly()) {
            branchGraphDiv.style.border = 'none';
            branchGraphDiv.style.boxShadow = 'none';
            branchGraphDiv.style.outline = 'none';
        } else {
            branchGraphDiv.style.border = '';
            branchGraphDiv.style.boxShadow = '';
            branchGraphDiv.style.outline = '';
        }
        branchGraphDiv.style.backgroundColor = this.plugin.settings.themeMode === 'light' ? '#f5f5f5' : '#2a2a2a';
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
            this.nodeAnchors
        );

        // 配置渲染选项
        const options: RenderOptions = {
            direction: (this.plugin.settings.DirectionOfBranchGraph || 'LR') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'dagre',
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
            themeMode: this.plugin.settings.themeMode,
            themeStyle: this.plugin.settings.themeStyle || 'modern',
            edgeStyle: this.plugin.settings.edgeStyle || 'bezier',
            nodeLayoutStyle: this.currentNodeLayoutStyle,
            showNoteId: this.plugin.settings.showNoteIdInBranchView,
            smartConnection: this.plugin.settings.smartConnection === true,
            readOnly: this.isMobileReadOnly(),
            mocPreviewExporter: async (mocFile: TFile) => {
                try {
                    const { ensureMOCPreviewPNG } = await import('src/embed/mocEmbedExporter');
                    return await ensureMOCPreviewPNG(mocFile, this.plugin);
                } catch (error) {
                    console.error('[indexView] ensureMOCPreviewPNG failed:', error);
                    return null;
                }
            }
        };

        // 性能优化：复用或创建渲染器，避免每次都销毁重建
        if (!this.branchRenderer) {
            this.branchRenderer = new CytoscapeRenderer();
        }

        // 渲染或更新图形
        // CytoscapeRenderer 内部会智能判断是否需要完全重建或增量更新
        await this.branchRenderer.render(branchGraphDiv, graphData, options);
        this.lastRenderedMOCPath = currentMOCPath;
        this.lastRenderSignature = renderSignature;

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
                    branchGraphDiv.style.boxShadow = 'inset 0 0 0 2px rgba(91, 143, 217, 0.9)';
                } else if (this.isMobileReadOnly()) {
                    branchGraphDiv.style.boxShadow = 'none';
                } else {
                    branchGraphDiv.style.boxShadow = '';
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
                    event.dataTransfer.dropEffect = 'copy';
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
                    new Notice("未找到当前 MOC 文件");
                    return;
                }

                // 自由节点不建立父子关系，只创建虚线关系
                await this.addArrowRelationToMOC(mocFile, parentNode.IDStr, childNode.IDStr, '');

                // 保存位置（保持原 ID）
                await this.saveNodePositionToMOC(mocFile, childNode.IDStr, position);

                // 刷新视图
                await this.refreshBranchMermaid();

                new Notice(`已创建关系: ${parentNode.displayText} → ${childNode.displayText}`);
            } catch (error) {
                console.error('[auto-connect-node] 连接失败:', error);
                new Notice(`连接失败: ${error.message}`);
            }
        });

        // 监听节点位置变化事件（拖动后保存到 MOC 文件）
        // 多节点拖动时 dragfree 会对每个节点触发，先累积到 pendingPositionChanges，防抖后批量保存
        let pendingMOCPath: string | null = null; // 事件发生时的 MOC 路径
        this.addTrackedListener(branchGraphDiv, 'node-position-changed', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node, position } = event.detail;
            const nodeKey = node?.ID || node?.IDStr;

            // 检查节点是否有效
            if (!node || !nodeKey) {
                console.warn('Invalid node in position-changed event:', node);
                return;
            }

            // 在事件发生时立即捕获当前 MOC 路径，而不是等 200ms 后再读
            pendingMOCPath = this.plugin.settings.mocCurrentFile;

            // 累积待保存的位置变化
            this.pendingPositionChanges.set(nodeKey, { node, position });

            // 使用防抖，等所有 dragfree 事件到达后一次性保存
            if (this.nodePositionSaveTimeout) {
                clearTimeout(this.nodePositionSaveTimeout);
            }

            this.nodePositionSaveTimeout = setTimeout(async () => {
                const changes = new Map(this.pendingPositionChanges);
                this.pendingPositionChanges.clear();

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

                    // 批量保存普通节点位置（一次 parse-modify-save）
                    if (normalChanges.size > 0) {
                        const headingTitle = this.plugin.settings.mocHeadingTitle;
                        const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
                        const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);
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
                        await saveMOCStructure(this.app, mocFile.path, headingTitle, mocData);
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
                } catch (error) {
                    console.error('Failed to save node positions:', error);
                }
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

        // 监听预览节点尺寸变化事件（右下角拖拽后保存到 ext）
        // 使用 debounce 合并连续 resize 事件，避免高频写入触发 MermaidParser 同秒缓存问题
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
            const openInNewLeaf = isMouseEvent && (triggerEvent.metaKey || triggerEvent.ctrlKey || triggerEvent.button === 1);

            // 如果不是强制新开，先查已有 tab
            if (!openInNewLeaf) {
                const existingLeaf = this.app.workspace.getLeavesOfType('markdown').find(
                    leaf => (leaf.view as any)?.file?.path === targetFile.path
                );
                if (existingLeaf) {
                    this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                    return;
                }
            }
            this.app.workspace.getLeaf(openInNewLeaf).openFile(targetFile);
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

        // 监听节点选中事件（单击）— 更新平行宇宙面包屑
        this.addTrackedListener(branchGraphDiv, 'node-select', (event: any) => {
            const { node } = event.detail;
            this.updateMultiverseBadge(node);
        });

        // 点击画布空白处 — 隐藏平行宇宙面包屑
        this.addTrackedListener(branchGraphDiv, 'background-click', () => {
            this.updateMultiverseBadge(null);
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
            const { node, content } = event.detail;
            if (!node) {
                return;
            }
            await this.saveNodeContent(node, content);
        });

        this.addTrackedListener(branchGraphDiv, 'node-remark-edit', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { node } = event.detail;
            if (!node) {
                return;
            }
            await this.editNodeRemark(node);
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
                if (name.toLowerCase().endsWith('.moc')) {
                    return name; // .moc 需要保留扩展名
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

        // 监听节点复制事件（Cmd+C）
        this.addTrackedListener(branchGraphDiv, 'node-copy', (event: any) => {
            const { count } = event.detail;
            new Notice(`已复制 ${count} 个节点`);
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

                    const newNode: MOCTreeNode = {
                        wikiLink: originalNode.isTextOnly
                            ? (originalNode.displayText || '')
                            : (originalNode.wikiLink || originalNode.displayText || ''),
                        nodeID: newID,
                        displayText: originalNode.displayText || '',
                        depth: 0,
                        children: [],
                        file: originalNode.isTextOnly ? null : (originalNode.file || null),
                        relationText: '',
                        isTextOnly: originalNode.isTextOnly || false,
                        isEmbed: originalNode.isEmbed || false
                    };
                    mocData.nodes.push(newNode);

                    if (!mocData.nodePositions) mocData.nodePositions = {};
                    mocData.nodePositions[newID] = {
                        x: pasteCenter.x + (position.x - origCenterX) + PASTE_OFFSET,
                        y: pasteCenter.y + (position.y - origCenterY) + PASTE_OFFSET
                    };
                }
            });

            await this.refreshBranchMermaid();
            new Notice(`已粘贴 ${nodes.length} 个节点`);
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

            // 如果关系数量超过2个，需要二次确认
            if (relationCount > 2) {
                const confirmed = await this.showDeleteConfirmDialog(node, relationCount);
                if (!confirmed) {
                    return;
                }
            }

            // 在刷新前保存所有节点的当前位置
            await this.saveAllNodePositionsBeforeRefresh();

            // 删除节点
            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
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

                    // 刷新视图
                    await this.refreshBranchMermaid();

                    new Notice(`已删除节点: ${node.ID}`);
                }
            } catch (error) {
                console.error('Failed to delete node:', error);
                new Notice(`删除节点失败: ${error.message}`);
            }
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

            // 创建占位符节点，而不是直接打开模态框
            await this.createPlaceholderNode(position);
        });

        // 监听占位符节点编辑事件
        this.addTrackedListener(branchGraphDiv, 'placeholder-node-edit', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeId, label, position, suggestedNodeId } = event.detail;

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
                await this.finalizeFileNode(nodeId, parsed.wikiLink, label, position, parsed.isEmbed);
            } else if (label.trim()) {
                // 情况 2：无 wiki link → 创建纯文字节点
                await this.finalizeTextOnlyNode(nodeId, label.trim(), position);
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
            await this.removePlaceholderNode(nodeId);
        });

        // 监听占位符节点完成事件（从 suggester 选择文件后触发）
        this.addTrackedListener(branchGraphDiv, 'placeholder-node-complete', async (event: any) => {
            if (this.isMobileReadOnly()) {
                return;
            }
            const { nodeId, wikiLink, file, isEmbed } = event.detail;

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
                await this.saveNodePositionToMOC(mocFile, suggestedID, placeholderInfo.position);
            }

            // 从占位符追踪中移除
            this.placeholderNodes.delete(nodeId);

            // 刷新视图
            await this.refreshBranchMermaid();

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
                await this.saveNodePositionToMOC(mocFile, suggestedID, placeholderInfo.position);
            }

            // 从占位符追踪中移除
            this.placeholderNodes.delete(nodeId);

            // 刷新视图
            await this.refreshBranchMermaid();

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
            const { edgeId, source, target, oldLabel, newLabel } = event.detail;

            try {
                const mocFile = getLatestMOCFile();
                if (mocFile) {
                    await this.updateArrowRelationLabelInMOC(mocFile, source, target, newLabel);
                    // 刷新视图
                    await this.refreshBranchMermaid();
                }
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
                    await this.mocHandler.deleteNodesFromMOC(mocFile, batchNodes);

                    // 删除嵌入图片节点对应的图片文件
                    for (const n of nodes) {
                        if (n.originalNode) {
                            await this.deleteImageFileIfNeeded(n.originalNode);
                        }
                    }

                    await this.refreshBranchMermaid();
                    new Notice(`已删除 ${nodeIds.length} 个节点`);
                }
            } catch (error) {
                console.error('Failed to batch delete nodes:', error);
                new Notice(`批量删除失败: ${error.message}`);
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
        this.multiverseContainer.style.display = "none";

        if (!node || !node.file) return;

        const reverseIndex = this.plugin.mocReverseIndex;
        if (!reverseIndex || !reverseIndex.isInitialized) return;

        const currentMOC = this.plugin.settings.mocCurrentFile;
        const otherMOCs = reverseIndex.query(node.file.path, currentMOC);

        if (otherMOCs.length === 0) return;

        // 显示容器
        this.multiverseContainer.style.display = "flex";

        // 分隔符
        this.multiverseContainer.createSpan("zk-breadcrumb-sep").setText("\u203A");

        // 当前节点名称
        const nodeChip = this.multiverseContainer.createDiv("zk-chip zk-chip-outlined zk-multiverse-node");
        let nodeLabel = node.title || node.displayText || node.IDStr;
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
        panel.style.display = "none";

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
            panel.style.display = panel.style.display === "none" ? "block" : "none";
        });

        // 点击其他区域关闭面板
        const closePanel = (e: MouseEvent) => {
            if (!panel.contains(e.target as Node) && !badge.contains(e.target as Node)) {
                panel.style.display = "none";
                document.removeEventListener("click", closePanel);
            }
        };
        badge.addEventListener("click", () => {
            setTimeout(() => document.addEventListener("click", closePanel), 0);
        });
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
        new MOCSelectorModal(this.app, mocFiles, async (item) => {
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

        // 添加分隔符
        menu.addSeparator();

        // 添加"路线图 (Future)"选项
        menu.addItem((item) => {
            item.setTitle("路线图 (Future)")
                .setIcon("map")
                .onClick(() => {
                    new Notice("路线图功能即将推出！");
                });
        });

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
        menu.style.position = 'fixed';
        menu.style.zIndex = '10000';

        const isAnchor = !!(this.nodeAnchors[node.IDStr] || this.nodeAnchors[node.ID]);

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

        // 分隔线
        menu.createDiv('zk-node-ctx-sep');

        // 底部两列：修改节点 ID + 修改节点颜色
        const row = menu.createDiv('zk-node-ctx-row');
        this.addContextMenuItem(row, menu, closeMenu, 'fingerprint', t('ctx rename id'), () => this.renameNodeID(node));
        this.addContextMenuItem(row, menu, closeMenu, 'palette', t('ctx change color'), () => this.changeNodeColor(node));

        // 定位：先在屏幕外渲染以获取尺寸
        menu.style.visibility = 'hidden';
        menu.style.left = '0';
        menu.style.top = '0';

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
        menu.style.position = 'fixed';
        menu.style.zIndex = '10000';

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
        menu.style.visibility = 'hidden';
        menu.style.left = '0';
        menu.style.top = '0';
        requestAnimationFrame(() => {
            const mw = menu.offsetWidth;
            const mh = menu.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            let x = mouseEvent.clientX;
            let y = mouseEvent.clientY;
            if (x + mw > vw) x = vw - mw - 4;
            if (y + mh > vh) y = vh - mh - 4;
            menu.style.left = `${x}px`;
            menu.style.top = `${y}px`;
            menu.style.visibility = 'visible';
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
        menu.style.position = 'fixed';
        // 菜单显示在按钮右侧
        menu.style.left = `${btnRect.right + 10}px`;
        menu.style.top = `${btnRect.top - 20}px`;
        menu.style.zIndex = '10000';

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
        const sourceDisplayText = sourceNode.displayText || sourceNode.title;
        const targetDisplayText = targetNode.title || targetNode.displayText;
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
        const sourceDisplayText = sourceNode.displayText || sourceNode.title;
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
                const targetDisplayText = targetNode.title || targetNode.displayText;
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
            { name: '青色', value: '#0891b2' },
            { name: '蓝色', value: '#2563eb' },
            { name: '深紫', value: '#7c3aed' },
            { name: '紫红', value: '#c026d3' },
            { name: '玫红', value: '#db2777' },
            { name: '绿色', value: '#16a34a' },
            { name: '深绿', value: '#047857' },
            { name: '橙色', value: '#ea580c' },
            { name: '深橙', value: '#dc2626' },
            { name: '红色', value: '#dc2626' },
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
                await this.mocHandler.updateNodeColorInMOC(mocFile, node.IDStr, selectedColor);
                
                // 刷新视图
                await this.refreshBranchMermaid();
                
                if (selectedColor) {
                    new Notice(`已设置节点 ${node.ID} 的颜色`);
                } else {
                    new Notice(`已重置节点 ${node.ID} 的颜色`);
                }
            }
        } catch (error) {
            console.error('Failed to change node color:', error);
            new Notice(`修改节点颜色失败: ${error.message}`);
        }
    }

    /**
     * 批量修改节点颜色
     */
    async batchChangeNodeColor(nodeIds: string[]) {
        // 预设颜色
        const colors = [
            { name: '青色', value: '#0891b2' },
            { name: '蓝色', value: '#2563eb' },
            { name: '深紫', value: '#7c3aed' },
            { name: '紫红', value: '#c026d3' },
            { name: '玫红', value: '#db2777' },
            { name: '绿色', value: '#16a34a' },
            { name: '深绿', value: '#047857' },
            { name: '橙色', value: '#ea580c' },
            { name: '深橙', value: '#dc2626' },
            { name: '红色', value: '#dc2626' },
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
                await this.mocHandler.updateNodeColorsInMOC(mocFile, nodeIds, selectedColor);

                // 刷新视图
                await this.refreshBranchMermaid();

                if (selectedColor) {
                    new Notice(`已修改 ${nodeIds.length} 个节点的颜色`);
                } else {
                    new Notice(`已重置 ${nodeIds.length} 个节点的颜色`);
                }
            }
        } catch (error) {
            console.error('Failed to batch change node color:', error);
            new Notice(`批量修改节点颜色失败: ${error.message}`);
        }
    }

    /**
     * 显示批量颜色选择对话框
     */
    private showBatchColorPickerDialog(colors: Array<{ name: string; value: string }>, nodeIds: string[]): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText('批量修改节点颜色');

            const { contentEl } = modal;
            contentEl.empty();
            contentEl.style.padding = '20px';

            const infoDiv = contentEl.createDiv();
            infoDiv.style.marginBottom = '15px';
            infoDiv.style.padding = '10px';
            infoDiv.style.backgroundColor = 'var(--background-secondary)';
            infoDiv.style.borderRadius = '4px';
            infoDiv.style.color = 'var(--text-muted)';
            infoDiv.innerHTML = `
                <div>选中节点: <strong>${nodeIds.length} 个</strong></div>
                <div style="font-size: 0.9em; margin-top: 5px;">选择一个颜色应用到所有选中的节点</div>
            `;

            const colorGrid = contentEl.createDiv();
            colorGrid.style.display = 'grid';
            colorGrid.style.gridTemplateColumns = 'repeat(5, 1fr)';
            colorGrid.style.gap = '10px';
            colorGrid.style.marginBottom = '20px';

            let selectedColor: string | null = null;

            colors.forEach((color) => {
                const colorButton = colorGrid.createDiv();
                colorButton.style.cssText = `
                    width: 80px;
                    height: 80px;
                    border-radius: 16px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 14px;
                    font-weight: 600;
                    color: white;
                    transition: all 0.2s;
                    border: 3px solid transparent;
                `;

                if (color.value) {
                    colorButton.style.backgroundColor = color.value;
                } else {
                    colorButton.style.backgroundColor = 'var(--background-secondary)';
                    colorButton.style.border = '3px solid var(--background-modifier-border)';
                    colorButton.style.color = 'var(--text-normal)';
                }

                colorButton.textContent = color.name;

                colorButton.addEventListener('mouseenter', () => {
                    colorButton.style.transform = 'scale(1.1)';
                    colorButton.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
                });

                colorButton.addEventListener('mouseleave', () => {
                    if (selectedColor !== color.value) {
                        colorButton.style.transform = 'scale(1)';
                        colorButton.style.boxShadow = 'none';
                    }
                });

                colorButton.addEventListener('click', () => {
                    colorGrid.querySelectorAll('div').forEach(btn => {
                        btn.style.transform = 'scale(1)';
                        btn.style.border = color.value ? '3px solid transparent' : '3px solid var(--background-modifier-border)';
                    });

                    selectedColor = color.value;
                    colorButton.style.transform = 'scale(1.1)';
                    colorButton.style.border = '3px solid white';
                    colorButton.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
                });

                colorButton.addEventListener('dblclick', () => {
                    selectedColor = color.value;
                    modal.close();
                    resolve(selectedColor);
                });
            });

            const buttonContainer = contentEl.createDiv();
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.gap = '10px';

            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.style.padding = '6px 16px';
            cancelButton.style.border = '1px solid var(--background-modifier-border)';
            cancelButton.style.borderRadius = '4px';
            cancelButton.style.backgroundColor = 'var(--background-primary)';
            cancelButton.style.color = 'var(--text-normal)';
            cancelButton.style.cursor = 'pointer';
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });

            const confirmButton = buttonContainer.createEl('button', { text: '确认' });
            confirmButton.style.padding = '6px 16px';
            confirmButton.style.border = 'none';
            confirmButton.style.borderRadius = '4px';
            confirmButton.style.backgroundColor = '#5b8fd9';
            confirmButton.style.color = '#ffffff';
            confirmButton.style.cursor = 'pointer';
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

    private showColorPickerDialog(colors: Array<{ name: string; value: string }>, node: ZKNode): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText('选择节点颜色');
            
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.style.padding = '20px';
            
            const infoDiv = contentEl.createDiv();
            infoDiv.style.marginBottom = '15px';
            infoDiv.style.padding = '10px';
            infoDiv.style.backgroundColor = 'var(--background-secondary)';
            infoDiv.style.borderRadius = '4px';
            infoDiv.style.color = 'var(--text-muted)';
            infoDiv.innerHTML = `
                <div>节点: <strong>${node.ID}</strong></div>
                <div style="font-size: 0.9em; margin-top: 5px;">选择一个颜色作为节点的外框颜色</div>
            `;
            
            const colorGrid = contentEl.createDiv();
            colorGrid.style.display = 'grid';
            colorGrid.style.gridTemplateColumns = 'repeat(5, 1fr)';
            colorGrid.style.gap = '10px';
            colorGrid.style.marginBottom = '20px';
            
            let selectedColor: string | null = null;
            
            colors.forEach((color) => {
                const colorButton = colorGrid.createDiv();
                colorButton.style.cssText = `
                    width: 80px;
                    height: 80px;
                    border-radius: 16px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 14px;
                    font-weight: 600;
                    color: white;
                    transition: all 0.2s;
                    border: 3px solid transparent;
                `;
                
                if (color.value) {
                    colorButton.style.backgroundColor = color.value;
                } else {
                    // 默认颜色显示为灰色边框
                    colorButton.style.backgroundColor = 'var(--background-secondary)';
                    colorButton.style.border = '3px solid var(--background-modifier-border)';
                    colorButton.style.color = 'var(--text-normal)';
                }
                
                colorButton.textContent = color.name;
                
                // 悬停效果
                colorButton.addEventListener('mouseenter', () => {
                    colorButton.style.transform = 'scale(1.1)';
                    colorButton.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
                });
                
                colorButton.addEventListener('mouseleave', () => {
                    if (selectedColor !== color.value) {
                        colorButton.style.transform = 'scale(1)';
                        colorButton.style.boxShadow = 'none';
                    }
                });
                
                // 点击选择
                colorButton.addEventListener('click', () => {
                    // 取消之前的选中
                    colorGrid.querySelectorAll('div').forEach(btn => {
                        btn.style.transform = 'scale(1)';
                        btn.style.border = color.value ? '3px solid transparent' : '3px solid var(--background-modifier-border)';
                    });
                    
                    // 选中当前颜色
                    selectedColor = color.value;
                    colorButton.style.transform = 'scale(1.1)';
                    colorButton.style.border = '3px solid white';
                    colorButton.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
                });
                
                // 双击直接确认
                colorButton.addEventListener('dblclick', () => {
                    selectedColor = color.value;
                    modal.close();
                    resolve(selectedColor);
                });
            });
            
            const buttonContainer = contentEl.createDiv();
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.gap = '10px';
            
            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.style.padding = '6px 16px';
            cancelButton.style.border = '1px solid var(--background-modifier-border)';
            cancelButton.style.borderRadius = '4px';
            cancelButton.style.backgroundColor = 'var(--background-primary)';
            cancelButton.style.color = 'var(--text-normal)';
            cancelButton.style.cursor = 'pointer';
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });
            
            const confirmButton = buttonContainer.createEl('button', { text: '确认' });
            confirmButton.style.padding = '6px 16px';
            confirmButton.style.border = 'none';
            confirmButton.style.borderRadius = '4px';
            confirmButton.style.backgroundColor = '#5b8fd9';
            confirmButton.style.color = '#ffffff';
            confirmButton.style.cursor = 'pointer';
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

    private async saveNodeContent(node: ZKNode, newContent: string) {
        const currentContent = node.isTextOnly
            ? this.decodeMultilineText(node.title || '')
            : this.buildFileNodeRawWikiText(node);
        if (!newContent || newContent === currentContent) {
            return;
        }

        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
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

                // 刷新视图
                await this.refreshBranchMermaid();

                new Notice(`已更新节点内容`);
            }
        } catch (error) {
            console.error('Failed to edit node content:', error);
            new Notice(`修改节点内容失败: ${error.message}`);
        }
    }

    async editTextNodeContent(node: ZKNode) {
        await this.editNodeContent(node);
    }

    private getNodeRemark(node: ZKNode): string {
        return this.nodeRemarks[node.IDStr] || this.nodeRemarks[node.ID] || '';
    }

    async editNodeRemark(node: ZKNode) {
        const currentRemark = this.getNodeRemark(node);
        const newRemark = await this.showTextNodeContentInputDialog(currentRemark, '编辑备注', true);

        if (newRemark === null || newRemark === currentRemark) {
            return;
        }

        try {
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                await this.mocHandler.updateNodeRemarkInMOC(mocFile, node.IDStr, newRemark);
                await this.refreshBranchMermaid();
                new Notice(newRemark.trim() ? '已更新备注' : '已删除备注');
            }
        } catch (error) {
            console.error('Failed to edit node remark:', error);
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
            
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.style.padding = '20px';
            
            const infoDiv = contentEl.createDiv();
            infoDiv.style.marginBottom = '15px';
            infoDiv.style.padding = '10px';
            infoDiv.style.backgroundColor = 'var(--background-secondary)';
            infoDiv.style.borderRadius = '4px';
            infoDiv.style.color = 'var(--text-muted)';
            infoDiv.innerHTML = `
                <div style="margin-bottom: 5px;">当前 ID: <strong>${currentID}</strong></div>
                <div style="font-size: 0.9em;">注意：修改 ID 后，所有子节点的 ID 前缀也会自动更新（例如：1.a 改为 1.c，则 1.a.1 会改为 1.c.1）</div>
            `;
            
            const inputContainer = contentEl.createDiv();
            inputContainer.style.marginBottom = '15px';
            
            const label = inputContainer.createEl('label', { text: '新的节点 ID：' });
            label.style.display = 'block';
            label.style.marginBottom = '5px';
            label.style.color = 'var(--text-normal)';
            
            const input = inputContainer.createEl('input', {
                type: 'text',
                value: currentID
            });
            input.style.width = '100%';
            input.style.padding = '8px';
            input.style.border = '1px solid var(--background-modifier-border)';
            input.style.borderRadius = '4px';
            input.style.backgroundColor = 'var(--background-primary)';
            input.style.color = 'var(--text-normal)';
            
            const buttonContainer = contentEl.createDiv();
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.gap = '10px';
            
            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.style.padding = '6px 16px';
            cancelButton.style.border = '1px solid var(--background-modifier-border)';
            cancelButton.style.borderRadius = '4px';
            cancelButton.style.backgroundColor = 'var(--background-primary)';
            cancelButton.style.color = 'var(--text-normal)';
            cancelButton.style.cursor = 'pointer';
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(null);
            });
            
            const confirmButton = buttonContainer.createEl('button', { text: '确认' });
            confirmButton.style.padding = '6px 16px';
            confirmButton.style.border = 'none';
            confirmButton.style.borderRadius = '4px';
            confirmButton.style.backgroundColor = '#5b8fd9';
            confirmButton.style.color = '#ffffff';
            confirmButton.style.cursor = 'pointer';
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
            contentEl.style.padding = '20px';

            const inputContainer = contentEl.createDiv();
            inputContainer.style.marginBottom = '15px';

            const label = inputContainer.createEl('label', { text: '新的分组名称：' });
            label.style.display = 'block';
            label.style.marginBottom = '5px';
            label.style.color = 'var(--text-normal)';

            const input = inputContainer.createEl('input', {
                type: 'text',
                value: currentLabel || ''
            });
            input.style.width = '100%';
            input.style.padding = '8px';
            input.style.border = '1px solid var(--background-modifier-border)';
            input.style.borderRadius = '4px';
            input.style.backgroundColor = 'var(--background-primary)';
            input.style.color = 'var(--text-normal)';

            const buttonContainer = contentEl.createDiv();
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.gap = '10px';

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
            contentEl.style.padding = '20px';

            const infoDiv = contentEl.createDiv();
            infoDiv.style.marginBottom = '15px';
            infoDiv.style.padding = '10px';
            infoDiv.style.backgroundColor = 'var(--background-secondary)';
            infoDiv.style.borderRadius = '4px';
            infoDiv.style.color = 'var(--text-muted)';
            infoDiv.innerHTML = `<div>当前分组 ID: <strong>${currentID}</strong></div>`;

            const inputContainer = contentEl.createDiv();
            inputContainer.style.marginBottom = '15px';

            const label = inputContainer.createEl('label', { text: '新的分组 ID：' });
            label.style.display = 'block';
            label.style.marginBottom = '5px';
            label.style.color = 'var(--text-normal)';

            const input = inputContainer.createEl('input', {
                type: 'text',
                value: currentID
            });
            input.style.width = '100%';
            input.style.padding = '8px';
            input.style.border = '1px solid var(--background-modifier-border)';
            input.style.borderRadius = '4px';
            input.style.backgroundColor = 'var(--background-primary)';
            input.style.color = 'var(--text-normal)';

            const buttonContainer = contentEl.createDiv();
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.gap = '10px';

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
            contentEl.style.padding = '20px';
            contentEl.style.position = 'relative';

            const inputContainer = contentEl.createDiv();
            inputContainer.style.marginBottom = '15px';
            inputContainer.style.position = 'relative';

            const label = inputContainer.createEl('label', { text: '新内容：' });
            label.style.display = 'block';
            label.style.marginBottom = '5px';
            label.style.color = 'var(--text-normal)';

            const input = inputContainer.createEl('textarea');
            input.value = currentContent;
            input.style.width = '100%';
            input.style.padding = '8px';
            input.style.minHeight = '140px';
            input.style.border = '1px solid var(--background-modifier-border)';
            input.style.borderRadius = '4px';
            input.style.backgroundColor = 'var(--background-primary)';
            input.style.color = 'var(--text-normal)';
            input.style.resize = 'vertical';
            input.style.lineHeight = '1.5';

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
                popover.style.cssText = `
                    position: fixed;
                    left: ${inputRect.left}px;
                    top: ${inputRect.bottom + 6}px;
                    max-height: ${maxHeight}px;
                    width: ${Math.min(420, inputRect.width)}px;
                    background-color: var(--background-primary);
                    border: 1px solid var(--background-modifier-border);
                    border-radius: 6px;
                    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
                    z-index: 1001;
                    overflow-y: auto;
                    padding: 4px 0;
                `;

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

                const updateSelection = () => {
                    if (!suggesterState.popover) return;
                    const items = suggesterState.popover.querySelectorAll('.suggester-item');
                    items.forEach((item: any, index: number) => {
                        if (index === suggesterState.selectedIndex) {
                            item.style.backgroundColor = 'var(--background-modifier-hover)';
                            item.scrollIntoView({ block: 'nearest' });
                        } else {
                            item.style.backgroundColor = '';
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
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.gap = '10px';

            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.style.padding = '6px 16px';
            cancelButton.style.border = '1px solid var(--background-modifier-border)';
            cancelButton.style.borderRadius = '4px';
            cancelButton.style.backgroundColor = 'var(--background-primary)';
            cancelButton.style.color = 'var(--text-normal)';
            cancelButton.style.cursor = 'pointer';
            cancelButton.addEventListener('click', () => {
                closeWikiLinkSuggester();
                resolveOnce(null);
                modal.close();
            });

            const confirmButton = buttonContainer.createEl('button', { text: '确认' });
            confirmButton.style.padding = '6px 16px';
            confirmButton.style.border = 'none';
            confirmButton.style.borderRadius = '4px';
            confirmButton.style.backgroundColor = '#5b8fd9';
            confirmButton.style.color = '#ffffff';
            confirmButton.style.cursor = 'pointer';
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
                            item.style.backgroundColor = index === suggesterState.selectedIndex
                                ? 'var(--background-modifier-hover)'
                                : '';
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
                    if (e.shiftKey) {
                        // Shift + Enter：换行
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
            modal.titleEl.setText('确认删除节点');
            
            const { contentEl } = modal;
            contentEl.empty();
            contentEl.style.padding = '20px';
            
            const warningDiv = contentEl.createDiv();
            warningDiv.style.marginBottom = '15px';
            warningDiv.style.padding = '15px';
            warningDiv.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
            warningDiv.style.border = '1px solid rgba(239, 68, 68, 0.3)';
            warningDiv.style.borderRadius = '4px';
            
            const warningIcon = warningDiv.createEl('div', { text: '⚠️' });
            warningIcon.style.fontSize = '24px';
            warningIcon.style.marginBottom = '10px';
            
            const warningText = warningDiv.createEl('div');
            warningText.innerHTML = `
                <div style="font-weight: 600; margin-bottom: 8px;">即将删除节点：${node.ID}</div>
                <div style="color: var(--text-muted);">该节点有 <strong>${relationCount}</strong> 个关系连接</div>
                <div style="color: var(--text-muted); margin-top: 8px;">删除后将同时删除：</div>
                <ul style="margin: 8px 0; padding-left: 20px; color: var(--text-muted);">
                    <li>节点在 MOC 文件中的条目</li>
                    <li>所有与该节点相关的箭头关系</li>
                    <li>节点的位置信息</li>
                </ul>
                <div style="color: var(--text-error); font-weight: 600; margin-top: 8px;">此操作不可撤销！</div>
            `;
            
            const buttonContainer = contentEl.createDiv();
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.gap = '10px';
            buttonContainer.style.marginTop = '20px';
            
            const cancelButton = buttonContainer.createEl('button', { text: '取消' });
            cancelButton.style.padding = '6px 16px';
            cancelButton.style.border = '1px solid var(--background-modifier-border)';
            cancelButton.style.borderRadius = '4px';
            cancelButton.style.backgroundColor = 'var(--background-primary)';
            cancelButton.style.color = 'var(--text-normal)';
            cancelButton.style.cursor = 'pointer';
            cancelButton.addEventListener('click', () => {
                modal.close();
                resolve(false);
            });
            
            const confirmButton = buttonContainer.createEl('button', { text: '确认删除' });
            confirmButton.style.padding = '6px 16px';
            confirmButton.style.border = 'none';
            confirmButton.style.borderRadius = '4px';
            confirmButton.style.backgroundColor = '#ef4444';
            confirmButton.style.color = '#ffffff';
            confirmButton.style.cursor = 'pointer';
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
        contentEl.style.padding = '20px';
        
        // 创建搜索框
        const searchContainer = contentEl.createDiv({ cls: 'zk-node-search-container' });
        searchContainer.style.marginBottom = '15px';
        
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: '搜索节点 ID 或标题...'
        });
        searchInput.style.width = '100%';
        searchInput.style.padding = '8px';
        searchInput.style.border = '1px solid var(--background-modifier-border)';
        searchInput.style.borderRadius = '4px';
        searchInput.style.backgroundColor = 'var(--background-primary)';
        searchInput.style.color = 'var(--text-normal)';
        
        // 创建节点列表容器
        const nodeListContainer = contentEl.createDiv({ cls: 'zk-node-list-container' });
        nodeListContainer.style.maxHeight = '400px';
        nodeListContainer.style.overflowY = 'auto';
        nodeListContainer.style.border = '1px solid var(--background-modifier-border)';
        nodeListContainer.style.borderRadius = '4px';
        nodeListContainer.style.padding = '10px';
        
        // 关系文本输入框
        const relationContainer = contentEl.createDiv({ cls: 'zk-relation-input-container' });
        relationContainer.style.marginTop = '15px';
        
        const relationLabel = relationContainer.createEl('label', { text: '关系描述（可选）：' });
        relationLabel.style.display = 'block';
        relationLabel.style.marginBottom = '5px';
        relationLabel.style.color = 'var(--text-normal)';
        
        const relationInput = relationContainer.createEl('input', {
            type: 'text',
            placeholder: '例如：引出、相关、应用等'
        });
        relationInput.style.width = '100%';
        relationInput.style.padding = '8px';
        relationInput.style.border = '1px solid var(--background-modifier-border)';
        relationInput.style.borderRadius = '4px';
        relationInput.style.backgroundColor = 'var(--background-primary)';
        relationInput.style.color = 'var(--text-normal)';
        
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
                emptyHint.style.textAlign = 'center';
                emptyHint.style.padding = '20px';
                emptyHint.style.color = 'var(--text-muted)';
                return;
            }
            
            filteredNodes.forEach(node => {
                const nodeItem = nodeListContainer.createDiv({ cls: 'zk-node-item' });
                nodeItem.style.padding = '10px';
                nodeItem.style.marginBottom = '5px';
                nodeItem.style.border = '1px solid var(--background-modifier-border)';
                nodeItem.style.borderRadius = '4px';
                nodeItem.style.cursor = 'pointer';
                nodeItem.style.transition = 'background-color 0.2s';
                
                const nodeId = nodeItem.createDiv({ text: node.ID });
                nodeId.style.fontWeight = '600';
                nodeId.style.color = 'var(--text-accent)';
                nodeId.style.marginBottom = '4px';
                
                const nodeTitle = nodeItem.createDiv({ text: node.title || node.displayText });
                nodeTitle.style.fontSize = '0.9em';
                nodeTitle.style.color = 'var(--text-muted)';
                
                nodeItem.addEventListener('mouseenter', () => {
                    nodeItem.style.backgroundColor = 'var(--background-modifier-hover)';
                });
                
                nodeItem.addEventListener('mouseleave', () => {
                    if (selectedNode !== node) {
                        nodeItem.style.backgroundColor = 'transparent';
                    }
                });
                
                nodeItem.addEventListener('click', () => {
                    // 取消之前的选中
                    nodeListContainer.querySelectorAll('.zk-node-item').forEach(item => {
                        (item as HTMLElement).style.backgroundColor = 'transparent';
                        (item as HTMLElement).style.borderColor = 'var(--background-modifier-border)';
                    });
                    
                    // 选中当前节点
                    selectedNode = node;
                    nodeItem.style.backgroundColor = 'var(--background-modifier-hover)';
                    nodeItem.style.borderColor = 'var(--text-accent)';
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
                new Notice('请选择一个节点');
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
                    
                    new Notice(`已添加反向关系: ${targetNode.ID} → ${selectedNode.ID}`);
                }
            } catch (error) {
                console.error('Failed to add arrow relation:', error);
                new Notice(`添加反向关系失败: ${error.message}`);
            }
        };
        
        // 按钮容器
        const buttonContainer = contentEl.createDiv({ cls: 'zk-button-container' });
        buttonContainer.style.marginTop = '20px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '10px';
        
        // 取消按钮
        const cancelButton = buttonContainer.createEl('button', { text: '取消' });
        cancelButton.style.padding = '6px 16px';
        cancelButton.style.border = '1px solid var(--background-modifier-border)';
        cancelButton.style.borderRadius = '4px';
        cancelButton.style.backgroundColor = 'var(--background-primary)';
        cancelButton.style.color = 'var(--text-normal)';
        cancelButton.style.cursor = 'pointer';
        cancelButton.addEventListener('click', () => modal.close());
        
        // 确认按钮
        const confirmButton = buttonContainer.createEl('button', { text: '确认' });
        confirmButton.style.padding = '6px 16px';
        confirmButton.style.border = 'none';
        confirmButton.style.borderRadius = '4px';
        confirmButton.style.backgroundColor = '#5b8fd9';
        confirmButton.style.color = '#ffffff';
        confirmButton.style.cursor = 'pointer';
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
                // 在刷新前保存所有节点的当前位置
                await this.saveAllNodePositionsBeforeRefresh();
                
                // 添加到 MOC 文件
                await this.saveFreeNodeToMOC(result);
                
                // 保存新节点的位置
                if (defaultPosition && result.nodeID) {
                    const mocFilePath = this.plugin.settings.mocCurrentFile;
                    const mocFile = this.app.vault.getFileByPath(mocFilePath);
                    if (mocFile) {
                        await this.saveNodePositionToMOC(mocFile, result.nodeID, defaultPosition);
                    }
                }
                
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
    async createChildNodeFromActive(activeNodeId: string, position: { x: number; y: number }) {
        // 查找活动节点
        const activeNode = this.mocNodes.find(n => n.IDStr === activeNodeId || n.ID === activeNodeId);
        if (!activeNode) {
            new Notice('未找到活动节点');
            return;
        }

        // 直接创建占位符节点，指定父节点
        await this.createPlaceholderNode(position, activeNode.IDStr);
    }

    /**
     * 从活动节点创建兄弟节点（Enter 键）
     */
    async createSiblingNodeFromActive(activeNodeId: string, position: { x: number; y: number }) {
        // 查找活动节点
        const activeNode = this.mocNodes.find(n => n.IDStr === activeNodeId || n.ID === activeNodeId);
        if (!activeNode) {
            console.error('[indexView] 未找到活动节点', activeNodeId);
            new Notice('未找到活动节点');
            return;
        }

        // 获取父节点 ID
        const parentId = this.getParentNodeId(activeNode);
        if (!parentId) {
            console.error('[indexView] 无法找到父节点', activeNodeId);
            new Notice('无法找到父节点，无法创建兄弟节点');
            return;
        }

        // 生成兄弟节点 ID
        const siblingId = this.generateSiblingID(activeNodeId);

        // 创建占位符节点，指定父节点
        const tempId = `temp_${Date.now()}`;

        // 存储占位符信息
        this.placeholderNodes.set(tempId, {
            nodeId: tempId,
            tempId: tempId,
            content: '',
            position,
            timestamp: Date.now(),
            parentNodeId: parentId,
            suggestedNodeId: siblingId
        });

        // 通知 Cytoscape 渲染器添加占位符节点
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
 
            branchGraphDiv.dispatchEvent(new CustomEvent('add-placeholder-node', {
                detail: {
                    nodeId: tempId,
                    position: position,
                    parentNodeId: parentId,
                    suggestedNodeId: siblingId
                }
            }));
        } else {
            console.error('[indexView] 未找到 branchGraphDiv');
        }
    }

    /**
     * 从活动节点创建父节点（Shift+Tab 键）
     */
    async createParentNodeFromActive(activeNodeId: string, position: { x: number; y: number }) {
        // 查找活动节点
        const activeNode = this.mocNodes.find(n => n.IDStr === activeNodeId || n.ID === activeNodeId);
        if (!activeNode) {
            new Notice('未找到活动节点');
            return;
        }

        // 生成父节点 ID
        const parentId = this.generateParentID(activeNodeId);

        // 创建占位符节点（不指定父节点，因为这就是父节点）
        const tempId = `temp_${Date.now()}`;

        // 存储占位符信息
        this.placeholderNodes.set(tempId, {
            nodeId: tempId,
            tempId: tempId,
            content: '',
            position,
            timestamp: Date.now(),
            parentNodeId: undefined,  // 新父节点没有父节点
            suggestedNodeId: parentId,
            childNodeId: activeNodeId  // 标记当前节点应该成为这个新节点的子节点
        });

        // 通知 Cytoscape 渲染器添加占位符节点
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('add-placeholder-node', {
                detail: {
                    nodeId: tempId,
                    position: position,
                    parentNodeId: undefined,
                    suggestedNodeId: parentId,
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

        // 确定父节点 ID 和预生成的节点 ID
        let parentNodeId: string | undefined = undefined;
        let suggestedNodeId: string | undefined = undefined;

        // 优先使用显式指定的父节点 ID
        if (explicitParentId) {
            parentNodeId = explicitParentId;
            // 预生成子节点 ID
            suggestedNodeId = this.generateChildNodeID(explicitParentId);
    
        }
        // 否则，在以下场景查找最近节点并作为父节点：
        // 1) 启用了智能连线
        // 2) 当前文件是自动布局风格（auto 模式下新增节点应优先遵循层级规则）
        else if (this.plugin.settings.smartConnection || this.isAutoNodeLayoutStyle()) {
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
                    // 预生成子节点 ID
                    suggestedNodeId = this.generateChildNodeID(parentNodeId);
                }
            }
        }

        // 存储占位符信息（包括潜在的父节点ID和预生成的节点ID）
        this.placeholderNodes.set(tempId, {
            nodeId: tempId,
            tempId: tempId,
            content: '',
            position,
            timestamp: Date.now(),
            parentNodeId: parentNodeId,
            suggestedNodeId: suggestedNodeId  // 保存预生成的节点ID
        });

        // 直接通过事件通知 Cytoscape 渲染器添加占位符节点
        // 注意：要在 branchGraphDiv (zk-graph-cytoscape) 上派发事件，而不是 indexMermaidDiv
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('add-placeholder-node', {
                detail: {
                    nodeId: tempId,
                    position: position,
                    parentNodeId: parentNodeId,  // 传递父节点ID用于显示连接
                    suggestedNodeId: suggestedNodeId  // 传递预生成的节点ID
                }
            }));
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
        isEmbed: boolean = false
    ): Promise<void> {
        // 获取占位符信息
        const placeholderInfo = this.placeholderNodes.get(tempId);

        // 优先使用预生成的节点 ID，否则生成新的自由节点 ID
        const suggestedID = placeholderInfo?.suggestedNodeId || this.generateNextFreeNodeID();

        // 查找文件
        const file = this.app.metadataCache.getFirstLinkpathDest(wikiLink, '');

        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);

        // 检查是否有智能连线确定的父节点
        if (placeholderInfo && placeholderInfo.parentNodeId) {
            // 先创建为自由节点，然后移动到父节点下
            await this.saveFreeNodeToMOC({
                wikiLink: wikiLink,
                nodeID: suggestedID,
                relationText: '',
                file: file,
                isTextOnly: false,  // 标记为文件节点
                isEmbed
            });

            // 清除缓存，确保 moveNodeToParent 能读到刚保存的节点
            MermaidParser.clearCacheForFile(this.plugin.settings.mocCurrentFile);

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
                nodeID: suggestedID,
                relationText: '',
                file: file,
                isTextOnly: false,  // 标记为文件节点
                isEmbed
            });
        }

        if (placeholderInfo?.childNodeId && mocFile) {
            MermaidParser.clearCacheForFile(this.plugin.settings.mocCurrentFile);
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
            await this.saveNodePositionToMOC(mocFile, suggestedID, position);
        }

        // 从占位符追踪中移除
        this.placeholderNodes.delete(tempId);

        // 刷新视图
        await this.refreshBranchMermaid();

        if (placeholderInfo?.childNodeId) {
            await this.relayoutAutoLayoutSiblings(suggestedID);
        } else if (placeholderInfo?.parentNodeId) {
            await this.relayoutAutoLayoutSiblings(placeholderInfo.parentNodeId);
        }

        // 清理所有占位符连接线（因为视图已经刷新，占位符节点已不存在）
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('cleanup-all-placeholder-connections'));
        }

        // 自动选中新创建的节点
        console.log('[indexView] 文件节点创建完成，准备选中节点', suggestedID);
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
        position: { x: number; y: number }
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

            // 清除缓存，确保 moveNodeToParent 能读到刚保存的节点
            MermaidParser.clearCacheForFile(this.plugin.settings.mocCurrentFile);

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
            MermaidParser.clearCacheForFile(this.plugin.settings.mocCurrentFile);
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
            await this.saveNodePositionToMOC(mocFile, suggestedID, position);
        }

        // 从占位符追踪中移除
        this.placeholderNodes.delete(tempId);

        // 刷新视图
        await this.refreshBranchMermaid();

        if (placeholderInfo?.childNodeId) {
            await this.relayoutAutoLayoutSiblings(suggestedID);
        } else if (placeholderInfo?.parentNodeId) {
            await this.relayoutAutoLayoutSiblings(placeholderInfo.parentNodeId);
        }

        // 清理所有占位符连接线（因为视图已经刷新，占位符节点已不存在）
        const branchGraphDiv = document.getElementById("zk-branch-cytoscape");
        if (branchGraphDiv) {
            branchGraphDiv.dispatchEvent(new CustomEvent('cleanup-all-placeholder-connections'));
        }

        // 自动选中新创建的节点
        console.log('[indexView] 文件节点创建完成，准备选中节点', suggestedID);
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
                await this.app.vault.delete(file);
            }
        } catch (error) {
            console.error('Failed to delete image file:', error);
        }
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

    private async relayoutAutoLayoutSiblings(parentNodeId: string): Promise<void> {
        if (!this.isAutoNodeLayoutStyle() || !this.branchRenderer) {
            return;
        }

        const cy = this.branchRenderer.getCytoscapeInstance();
        if (!cy) {
            return;
        }

        const startNode: any = cy.$('node').filter((node: any) => {
            const originalNode = node.data('originalNode');
            return originalNode && (originalNode.IDStr === parentNodeId || originalNode.ID === parentNodeId);
        }).first();

        if (!startNode || startNode.length === 0) {
            return;
        }

        const HORIZONTAL_GAP = 150;
        const VERTICAL_GAP = 56;
        const getNodeSize = (node: any) => ({
            width: Math.max(Number(node.width?.() || 0), 80),
            height: Math.max(Number(node.height?.() || 0), 44)
        });

        const getChildNodes = (node: any): any[] => {
            return node.outgoers('edge').targets().filter((child: any) => {
                const data = child.data();
                return !data.isGroup && !data.isPlaceholder;
            }).toArray();
        };

        const getColorKey = (node: any): string => {
            return node?.data?.('branchNodeBorder')
                || node?.data?.('branchNodeBackground')
                || '__default__';
        };

        const getDirectParent = (node: any): any | null => {
            const parents = node.incomers('edge').sources().filter((parent: any) => {
                const data = parent.data();
                return !data.isGroup && !data.isPlaceholder;
            });
            return parents && parents.length > 0 ? parents.first() : null;
        };

        const quantizeDirection = (fromPos: { x: number; y: number }, toPos: { x: number; y: number }): { x: number; y: number } => {
            const dx = toPos.x - fromPos.x;
            const dy = toPos.y - fromPos.y;
            if (Math.abs(dx) >= Math.abs(dy)) {
                return { x: dx >= 0 ? 1 : -1, y: 0 };
            }
            return { x: 0, y: dy >= 0 ? 1 : -1 };
        };

        const getLayoutDirection = (node: any): { x: number; y: number } => {
            const parent = getDirectParent(node);
            if (!parent) {
                return { x: 1, y: 0 };
            }

            const grandParent = getDirectParent(parent);
            if (!grandParent) {
                return quantizeDirection(parent.position(), node.position());
            }

            return getLayoutDirection(parent);
        };

        const getStackAxis = (dir: { x: number; y: number }): { x: number; y: number } => {
            return Math.abs(dir.x) > 0.5 ? { x: 0, y: 1 } : { x: 1, y: 0 };
        };

        const getNodeSpan = (size: { width: number; height: number }, dir: { x: number; y: number }): number => {
            return Math.abs(dir.x) > 0.5 ? size.height : size.width;
        };

        const directionKey = (dir: { x: number; y: number }): 'right' | 'left' | 'down' | 'up' => {
            if (Math.abs(dir.x) >= Math.abs(dir.y)) {
                return dir.x >= 0 ? 'right' : 'left';
            }
            return dir.y >= 0 ? 'down' : 'up';
        };

        const sortChildren = (children: any[], stackAxis: { x: number; y: number }, center: { x: number; y: number }): any[] => {
            const sorted = [...children].sort((a, b) => {
                const ap = a.position();
                const bp = b.position();
                const aproj = (ap.x - center.x) * stackAxis.x + (ap.y - center.y) * stackAxis.y;
                const bproj = (bp.x - center.x) * stackAxis.x + (bp.y - center.y) * stackAxis.y;
                return aproj - bproj;
            });
            const colorOrder = new Map<string, number>();
            sorted.forEach((child) => {
                const colorKey = getColorKey(child);
                if (!colorOrder.has(colorKey)) {
                    colorOrder.set(colorKey, colorOrder.size);
                }
            });

            return sorted.sort((a, b) => {
                const colorRankA = colorOrder.get(getColorKey(a)) ?? Number.MAX_SAFE_INTEGER;
                const colorRankB = colorOrder.get(getColorKey(b)) ?? Number.MAX_SAFE_INTEGER;
                if (colorRankA !== colorRankB) {
                    return colorRankA - colorRankB;
                }
                const ap = a.position();
                const bp = b.position();
                const aproj = (ap.x - center.x) * stackAxis.x + (ap.y - center.y) * stackAxis.y;
                const bproj = (bp.x - center.x) * stackAxis.x + (bp.y - center.y) * stackAxis.y;
                return aproj - bproj;
            });
        };

        const buildLayout = (node: any, inheritedDir?: { x: number; y: number }): any => {
            const size = getNodeSize(node);
            const parents = node.incomers('edge').sources().filter((parent: any) => {
                const data = parent.data();
                return !data.isGroup && !data.isPlaceholder;
            });
            const isRoot = !parents || parents.length === 0;
            const dir = isRoot ? { x: 1, y: 0 } : (inheritedDir || getLayoutDirection(node));
            const stackAxis = getStackAxis(dir);
            const center = node.position();
            const children = sortChildren(getChildNodes(node), stackAxis, center).map((child) => buildLayout(child, dir));
            const childrenSpan = children.reduce((sum: number, child: any) => sum + child.subtreeSpan, 0)
                + Math.max(0, children.length - 1) * VERTICAL_GAP;
            return {
                node,
                dir,
                stackAxis,
                size,
                children,
                isRoot,
                subtreeSpan: Math.max(getNodeSpan(size, dir), childrenSpan)
            };
        };

        const layoutTree = buildLayout(startNode);
        const rootPos = startNode.position();
        const nodePositions: Record<string, { x: number; y: number }> = {};

        const placeLayout = (layoutNode: any, centerX: number, centerY: number) => {
            const { node, size, children, dir, stackAxis, isRoot } = layoutNode;
            node.position({ x: centerX, y: centerY });

            const originalNode = node.data('originalNode');
            const nodeId = originalNode?.IDStr || originalNode?.ID;
            if (nodeId) {
                nodePositions[nodeId] = {
                    x: Math.round(centerX * 100) / 100,
                    y: Math.round(centerY * 100) / 100
                };
            }

            if (children.length === 0) {
                return;
            }

            if (isRoot) {
                const groups: Record<'right' | 'left' | 'down' | 'up', any[]> = {
                    right: [],
                    left: [],
                    down: [],
                    up: []
                };

                children.forEach((childLayout: any) => {
                    groups[directionKey(childLayout.dir)].push(childLayout);
                });

                const placeGroup = (groupDir: 'right' | 'left' | 'down' | 'up', groupChildren: any[]) => {
                    if (groupChildren.length === 0) return;

                    const groupVector =
                        groupDir === 'right' ? { x: 1, y: 0 } :
                        groupDir === 'left' ? { x: -1, y: 0 } :
                        groupDir === 'down' ? { x: 0, y: 1 } :
                        { x: 0, y: -1 };
                    const groupStackAxis = getStackAxis(groupVector);
                    const totalGroupSpan = groupChildren.reduce((sum: number, child: any) => sum + child.subtreeSpan, 0)
                        + Math.max(0, groupChildren.length - 1) * VERTICAL_GAP;
                    let groupCursor = (Math.abs(groupStackAxis.x) > 0.5 ? centerX : centerY) - totalGroupSpan / 2;

                    groupChildren.forEach((childLayout: any) => {
                        const childSpanCenter = groupCursor + childLayout.subtreeSpan / 2;
                        const childCenterX = Math.abs(groupVector.x) > 0.5
                            ? centerX + groupVector.x * (size.width / 2 + HORIZONTAL_GAP + childLayout.size.width / 2)
                            : childSpanCenter;
                        const childCenterY = Math.abs(groupVector.y) > 0.5
                            ? centerY + groupVector.y * (size.height / 2 + HORIZONTAL_GAP + childLayout.size.height / 2)
                            : childSpanCenter;
                        placeLayout(childLayout, childCenterX, childCenterY);
                        groupCursor += childLayout.subtreeSpan + VERTICAL_GAP;
                    });
                };

                placeGroup('right', groups.right);
                placeGroup('left', groups.left);
                placeGroup('down', groups.down);
                placeGroup('up', groups.up);
                return;
            }

            const totalChildrenSpan = children.reduce((sum: number, child: any) => sum + child.subtreeSpan, 0)
                + Math.max(0, children.length - 1) * VERTICAL_GAP;
            let cursor = (Math.abs(stackAxis.x) > 0.5 ? centerX : centerY) - totalChildrenSpan / 2;

            children.forEach((childLayout: any) => {
                const childSpanCenter = cursor + childLayout.subtreeSpan / 2;
                const childCenterX = Math.abs(dir.x) > 0.5
                    ? centerX + dir.x * (size.width / 2 + HORIZONTAL_GAP + childLayout.size.width / 2)
                    : childSpanCenter;
                const childCenterY = Math.abs(dir.y) > 0.5
                    ? centerY + dir.y * (size.height / 2 + HORIZONTAL_GAP + childLayout.size.height / 2)
                    : childSpanCenter;
                placeLayout(childLayout, childCenterX, childCenterY);
                cursor += childLayout.subtreeSpan + VERTICAL_GAP;
            });
        };

        cy.batch(() => {
            placeLayout(layoutTree, rootPos.x, rootPos.y);
        });

        const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
        if (!mocFile) {
            return;
        }

        await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodePositions) {
                mocData.nodePositions = {};
            }
            Object.entries(nodePositions).forEach(([nodeId, pos]) => {
                mocData.nodePositions[nodeId] = pos;
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
                // 添加到 MOC 文件
                await this.saveFreeNodeToMOC(result);
                
                // 如果提供了位置信息，保存节点位置
                if (position && result.file) {
                    const mocFilePath = this.plugin.settings.mocCurrentFile;
                    const mocFile = this.app.vault.getFileByPath(mocFilePath);
                    if (mocFile && result.nodeID) {
                        await this.saveNodePositionToMOC(mocFile, result.nodeID, position);
                    }
                }
                
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
    }) {
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (!mocFilePath) {
            new Notice("未找到当前 MOC 文件");
            return;
        }

        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (!mocFile) {
            new Notice("MOC 文件不存在");
            return;
        }

        try {
            await this.mocHandler.modifyMOCData(mocFile, (mocData) => {
                // 创建新节点
                const newNode: MOCTreeNode = {
                    wikiLink: result.isTextOnly
                        ? (result.text || '')  // 纯文字节点使用 text
                        : (result.wikiLink || ''),  // 文件节点使用 wikiLink
                    nodeID: result.nodeID,
                    displayText: result.isTextOnly
                        ? (result.text || '')
                        : (result.wikiLink || ''),
                    depth: 0,
                    children: [],
                    file: result.isTextOnly ? null : result.file,  // 纯文字节点无文件
                    relationText: result.connectionRelation || result.relationText || '',
                    isTextOnly: result.isTextOnly || false,  // 新增标记
                    isEmbed: result.isEmbed || false
                };

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

            new Notice(`已添加自由节点: ${result.nodeID}`);
        } catch (error) {
            console.error("保存自由节点失败:", error);
            new Notice(`保存失败: ${error.message}`);
        }
    }

    /**
     * 获取 MOC 文件的视图状态
     */
    private getMOCViewState(mocPath: string): { zoom: number; pan: { x: number; y: number } } | null {
        return this.mocViewStates.get(mocPath) || null;
    }

    /**
     * 保存 MOC 文件的视图状态
     */
    private saveMOCViewState(mocPath: string, zoom: number, pan: { x: number; y: number }): void {
        this.mocViewStates.set(mocPath, { zoom, pan });
    }

    async onClose() {
        // 保存插件设置
        this.plugin.saveData(this.plugin.settings);

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
            if (originalNode && originalNode.ID) {
                // 跳过跨领域节点（跨领域节点的位置保存在 cross_domain_links 中）
                if (originalNode.isCrossDomain || originalNode.ID.startsWith('cd-')) {
                    return;
                }

                const pos = node.position();
                positions[originalNode.ID] = {
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
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`;
            btn.style.cssText = `
                position: fixed;
                top: 20px;
                left: 12px;
                z-index: 99999;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 52px;
                height: 36px;
                padding: 0;
                border-radius: 10px;
                border: 1.5px solid #4a4a6a;
                background-color: rgba(30, 30, 50, 0.6);
                color: #c8c8e0;
                cursor: pointer;
                pointer-events: auto;
                touch-action: manipulation;
                -webkit-tap-highlight-color: transparent;
            `;
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
}
