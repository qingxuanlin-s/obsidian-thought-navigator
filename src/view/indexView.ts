import ZKNavigationPlugin, { Retrival } from "main";
import { ButtonComponent, DropdownComponent, ExtraButtonComponent, FuzzySuggestModal, HeadingCache, ItemView, Menu, Modal, Notice, Setting, TFile, WorkspaceLeaf, debounce, moment, setTooltip } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { mainNoteFuzzyModal, mainNoteModal } from "src/modal/mainNoteModal";
import { tableModal } from "src/modal/tableModal";
import { AddFreeNodeModal } from "src/modal/addFreeNodeModal";
import { expandGraphModal } from "src/modal/expandGraphModal";
import { MOCSelectorModal } from "src/modal/mocSelectorModal";
import { convertMOCToZKNodes, displayWidth, mainNoteInit, MOCTreeNode, parseMOCStructure, random, addSvgPanZoom } from "src/utils/utils";
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

interface PlayStates {
    current: number;
    total: number;
    nodeGArr: Element[];
    lines: Element[];
    labels: Element[];
}

export interface GitBranch {
    branchName: string;
    branchPoint: ZKNode;
    nodes: ZKNode[];
    currentPos: number
    order: number;
    positionX: number;
    active: boolean;
}

interface AllGitBranch {
    branchTab: number;
    gitBranches: GitBranch[];
    indexNode: ZKNode;
}

export class ZKIndexView extends ItemView {

    plugin: ZKNavigationPlugin;
    branchAllNodes: BrancAllhNodes[];

    playStatus: PlayStates = {
        current: 0,
        total: 0,
        nodeGArr: [],
        lines: [],
        labels: []
    };

    gitBranches: GitBranch[];
    order: number;
    result: GitBranch[];
    allGitBranch: AllGitBranch[];
    fileContent: string;

    // 按需渲染相关属性
    branchEntranceNodes: ZKNode[] = [];
    renderedBranches: Set<number> = new Set();
    indexMermaidContainer: HTMLElement | null = null;

    // Cytoscape 渲染器
    private branchRenderer: CytoscapeRenderer | null = null;

    // 性能优化：节点位置缓存 Map，O(1) 查找替代 O(n) filter
    nodePositionMap: Map<number, ZKNode> = new Map();

    // MOC 模式相关属性
    mocNodes: ZKNode[] = [];                    // MOC 解析后的节点
    mocTreeStructure: MOCTreeNode[] = [];       // MOC 原始树结构
    mocReverseRelations: Map<string, ReverseRelation> = new Map(); // MOC 反向关系

    // 防抖相关属性
    resizeTimeout: NodeJS.Timeout | null = null;
    edgeCurvatureSaveTimeout: NodeJS.Timeout | null = null;
    nodePositionSaveTimeout: NodeJS.Timeout | null = null;
    crossDomainPositionSaveTimeout: NodeJS.Timeout | null = null;
    embedNodeSizeSaveTimeout: NodeJS.Timeout | null = null;

    // 事件监听器跟踪（用于清理，防止内存泄漏）
    private registeredEventListeners: Array<{
        element: HTMLElement | Window;
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

    // MOC 按钮引用（用于更新显示）
    private mocButton: ButtonComponent | null = null;

    // 性能优化：防止重复刷新的标志位
    private isRefreshing: boolean = false;
    private pendingRefresh: boolean = false;

    // 性能优化：静态 UI 层标记
    private staticUICreated: boolean = false;
    private staticToolbarDiv: HTMLElement | null = null;

    // 性能优化：追踪事件监听器初始化状态，避免重复添加
    private branchGraphListenersInitialized: boolean = false;
    private currentBranchGraphDiv: HTMLElement | null = null;
    private undoStack: Array<{ filePath: string; content: string; timestamp: number }> = [];
    private readonly MAX_UNDO_STEPS = 7;
    private isApplyingUndo = false;
    private undoShortcutBound = false;

    constructor(leaf: WorkspaceLeaf, plugin: ZKNavigationPlugin) {
        super(leaf);
        this.plugin = plugin;
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
        return "ghost";
    }

    /**
     * 添加可跟踪的事件监听器（用于后续清理，防止内存泄漏）
     */
    private addTrackedListener<T extends HTMLElement | Window>(
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
        
        // 添加淡出效果
        container.style.opacity = '0.7';
        container.style.transition = 'opacity 0.2s ease-in-out';
        
        try {
            // 执行更新
            await updateFn();
            
            // 淡入效果
            container.style.opacity = '1';
        } catch (error) {
            console.error("Index View: Error during smooth update", error);
            container.style.opacity = '1';
        } finally {
            // 移除加载指示器
            setTimeout(() => {
                indicator.remove();
            }, 200);
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
            // 如果已创建过静态 UI，只清空图形容器
            const indexMermaidDiv = document.getElementById("zk-index-mermaid-container");
            if (indexMermaidDiv) {
                indexMermaidDiv.empty();
            }
        }

        // 刷新图形内容（动态层）
        await this.refreshBranchMermaid();
    }

    /**
     * 创建静态工具栏 UI（只创建一次）
     */
    private async createStaticToolbarUI(toolbarDiv: HTMLElement): Promise<void> {
        if (this.plugin.settings.MainNoteButton == true) {
            const mainNoteButtonDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
            const mainNoteButton = new ButtonComponent(mainNoteButtonDiv).setClass("zk-index-toolbar-button");
            mainNoteButton.setButtonText(this.plugin.settings.MainNoteButtonText);
            mainNoteButton.setCta();
            mainNoteButton.onClick(() => {
                if (this.plugin.settings.MainNoteSuggestMode === "IDOrder") {
                    new mainNoteModal(this.app, this.plugin, this.plugin.MainNotes, (selectZKNode) => {
                        if (!selectZKNode.file) return;
                        this.plugin.settings.lastRetrival = {
                            type: 'main',
                            ID: selectZKNode.ID,
                            displayText: selectZKNode.displayText,
                            filePath: selectZKNode.file.path,
                            openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                        }
                        this.plugin.clearShowingSettings();
                        this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                    }).open();
                } else {
                    new mainNoteFuzzyModal(this.app, this.plugin, this.plugin.MainNotes, (selectZKNode) => {
                        if (!selectZKNode.file) return;
                        this.plugin.settings.lastRetrival = {
                            type: 'main',
                            ID: selectZKNode.ID,
                            displayText: selectZKNode.displayText,
                            filePath: selectZKNode.file.path,
                            openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                        }
                        this.plugin.clearShowingSettings();
                        this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                    }).open()
                }
            })
        }

        if (this.plugin.settings.IndexButton == true) {
            const indexButtonDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
            const indexButton = new ButtonComponent(indexButtonDiv).setClass("zk-index-toolbar-button");
            indexButton.setButtonText(this.plugin.settings.IndexButtonText);
            indexButton.setCta();
            indexButton.onClick(() => {
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
        }

        // MOC 选择器
        if (this.plugin.settings.mocModeEnabled == true) {
            const mocSelectorDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
            this.mocButton = new ButtonComponent(mocSelectorDiv);
            this.mocButton.buttonEl.addClass("zk-index-toolbar-button");
            this.mocButton.buttonEl.addClass("zk-moc-button");

            // 获取当前MOC名称
            const currentMOCPath = this.plugin.settings.mocCurrentFile;
            const currentMOCFile = currentMOCPath ? this.app.vault.getAbstractFileByPath(currentMOCPath) : null;
            let currentMOCName = currentMOCFile instanceof TFile ? currentMOCFile.basename : "未命名";

            // 截断过长的文件名
            const maxLength = 9;
            if (currentMOCName.length > maxLength) {
                currentMOCName = currentMOCName.substring(0, maxLength) + "...";
            }

            this.mocButton.setButtonText(`🔍 ${currentMOCName}`);
            this.mocButton.setCta();
            this.mocButton.onClick(() => {
                this.openMOCSelectorModal();
            });
        }

        // 文本显示模式
        const nodeTextDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
        nodeTextDiv.createEl("b", { text: t("Text : ") });
        const nodeText = new DropdownComponent(nodeTextDiv);
        nodeText
            .addOption("id", t("id"))
            .addOption("title", t("title"))
            .addOption("both", t("both"))
            .addOption("id-title", t("id-title"))
            .setValue(this.plugin.settings.NodeText)
            .onChange((NodeText) => {
                this.plugin.settings.NodeText = NodeText;
                this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                this.app.workspace.trigger("zk-navigation:refresh-local-graph");
            });

        const noteIdDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
        noteIdDiv.createEl("b", { text: t("Note ID : ") });
        const noteIdToggle = new DropdownComponent(noteIdDiv);
        noteIdToggle
            .addOption("show", t("show"))
            .addOption("hide", t("hide"))
            .setValue(this.plugin.settings.showNoteIdInBranchView ? "show" : "hide")
            .onChange((value) => {
                this.plugin.settings.showNoteIdInBranchView = value === "show";
                this.plugin.saveData(this.plugin.settings);
                this.app.workspace.trigger("zk-navigation:refresh-index-graph");
            });

        // 风格选择
        const graphTypeDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
        graphTypeDiv.createEl("b", { text: t("style : ") });
        const graphType = new DropdownComponent(graphTypeDiv);
        graphType
            .addOption("structure", t("structure"))
            .addOption("roadmap", t("roadmap") + " (Future)")
            .setValue(this.plugin.settings.graphType || "structure")
            .onChange((graphType) => {
                // 路线图功能暂未实现，保持为结构图
                if (graphType === "roadmap") {
                    new Notice("路线图功能即将推出");
                    graphType = "structure";
                    this.plugin.settings.graphType = "structure";
                } else {
                    this.plugin.settings.graphType = graphType;
                }
                this.plugin.clearShowingSettings(this.plugin.settings.BranchTab);
                this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                this.app.workspace.trigger("zk-navigation:refresh-local-graph");
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

        this.registerEvent(this.app.vault.on("create", async () => {
            this.plugin.RefreshIndexViewFlag = true;
        }));

        this.registerEvent(this.app.vault.on("delete", async () => {
            this.plugin.RefreshIndexViewFlag = true;
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
            if (this.plugin.settings.mocModeEnabled && this.isDisplayingMOC(mocFile)) {
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

        if (this.app.workspace.layoutReady) {

            this.refreshIndexLayout();
        } else {
            this.app.workspace.onLayoutReady(() => {

                this.refreshIndexLayout();

            });
        }
    }

    refreshIndexLayout = async () => {

        await this.IndexViewInterfaceInit();

    }

    async refreshBranchMermaid() {

        this.plugin.RefreshIndexViewFlag = false;
        const indexMermaidDiv = document.getElementById("zk-index-mermaid-container");

        if (!indexMermaidDiv) return;

        // MOC 模式处理
        if (this.plugin.settings.mocModeEnabled) {
            await this.refreshBranchMermaidMOC(indexMermaidDiv);
            return;
        }

        await mainNoteInit(this.plugin);

        // 性能优化：只清空图形容器，保留其他元素
        indexMermaidDiv.empty();

        let branchEntranceNodeArr: ZKNode[] = [];
        let indexFile: any;

        // 创建图形容器（只创建一次，或复用已存在的）
        let graphTopContainer = document.getElementById("zk-graph-top-container") as HTMLElement;
        let indexLinkDiv: HTMLElement;

        if (!graphTopContainer) {
            // 首次创建
            graphTopContainer = indexMermaidDiv.createDiv("zk-graph-top");
            graphTopContainer.id = "zk-graph-top-container";
            indexLinkDiv = graphTopContainer.createDiv();
            indexLinkDiv.id = "zk-index-link-div";
        } else {
            // 复用已有容器
            indexLinkDiv = document.getElementById("zk-index-link-div") as HTMLElement;
            if (indexLinkDiv) {
                indexLinkDiv.empty();
            }
        }

        if (this.plugin.settings.BranchToolbra == true) {
            const toolButtonsDiv = graphTopContainer.createDiv("zk-tool-buttons");
            toolButtonsDiv.empty();
            if (this.plugin.settings.settingIcon == true) {
                const settingBtn = new ExtraButtonComponent(toolButtonsDiv);
                settingBtn.setIcon("settings").setTooltip(t("settings"));
                settingBtn.onClick(() => {
                    //@ts-ignore
                    this.app.setting.open();
                    //@ts-ignore
                    this.app.setting.openTabById("zettelkasten-navigation");
                })
            }


            if (this.plugin.settings.RandomMainNote == true && this.plugin.settings.MainNoteButton) {

                const randomBtn = new ExtraButtonComponent(toolButtonsDiv);
                randomBtn.setIcon("dice-3").setTooltip(t("random main note"));
                randomBtn.onClick(async () => {

                    let randomMainNoteNode = this.plugin.MainNotes[Math.floor(Math.random() * this.plugin.MainNotes.length)];

				if (!randomMainNoteNode.file) return;
                    this.plugin.settings.lastRetrival = {
                        type: 'main',
                        ID: randomMainNoteNode.ID,
                        displayText: randomMainNoteNode.displayText,
                        filePath: randomMainNoteNode.file.path,
                        openTime: moment().format("YYYY-MM-DD HH:mm:ss"),

                    }
                    await this.plugin.clearShowingSettings();
                    await this.IndexViewInterfaceInit();

                })
            }

            if (this.plugin.settings.RandomIndex == true && this.plugin.settings.IndexButton) {

                const randomBtn = new ExtraButtonComponent(toolButtonsDiv);
                randomBtn.setIcon("dices").setTooltip(t("random index"));
                randomBtn.onClick(async () => {

                    const indexFiles = this.app.vault.getMarkdownFiles()
                        .filter(f => f.path.startsWith(this.plugin.settings.FolderOfIndexes + '/'));

                    let randomIndex = indexFiles[Math.floor(Math.random() * indexFiles.length)];

                    this.plugin.settings.lastRetrival = {
                        type: 'index',
                        ID: '',
                        displayText: randomIndex.name,
                        filePath: randomIndex.path,
                        openTime: moment().format("YYYY-MM-DD HH:mm:ss"),

                    }
                    await this.plugin.clearShowingSettings();
                    await this.IndexViewInterfaceInit();

                })
            }

            if (this.plugin.settings.showAllToggle == true) {
                const showAllBtn = new ExtraButtonComponent(toolButtonsDiv);
                showAllBtn.setIcon("trees").setTooltip(t("all trees"));
                showAllBtn.onClick(async () => {
                    this.plugin.settings.lastRetrival = {
                        type: 'all',
                        ID: '',
                        displayText: 'all trees',
                        filePath: '',
                        openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                    }
                    this.plugin.settings.showAll = true;
                    this.plugin.settings.DisplayLevel = "end";
                    await this.plugin.clearShowingSettings();
                    await this.IndexViewInterfaceInit();
                })
            }

            if (this.plugin.settings.playControllerToggle === true) {

                const playControllerDiv = indexMermaidDiv.createDiv("zk-play-controller");

                const previousBtn = new ExtraButtonComponent(playControllerDiv);
                previousBtn
                    .setIcon('arrow-left')
                    .setTooltip(t("playPrevious"))
                    .onClick(async () => {
                        this.playStatus.current = (this.playStatus.current - 1 + this.playStatus.total) % this.playStatus.total;
                        if (this.plugin.settings.graphType === "structure") {
                            await this.branchPlaying();
                        } else {
                            await this.branchPlayingGit();
                        }

                    })

                const nextBtn = new ExtraButtonComponent(playControllerDiv);
                nextBtn
                    .setIcon('arrow-right')
                    .setTooltip(t("playNext"))
                    .onClick(async () => {
                        this.playStatus.current = (this.playStatus.current + 1) % this.playStatus.total;
                        if (this.plugin.settings.graphType === "structure") {
                            await this.branchPlaying();
                        } else {
                            await this.branchPlayingGit();
                        }
                    })

                const fullScreenBtn = new ExtraButtonComponent(playControllerDiv);
                fullScreenBtn
                    .setIcon('fullscreen')
                    .setTooltip(t("fullscreen"))
                    .onClick(() => {

                        let toggleClassList: string[] = [
                            '.workspace-ribbon.side-dock-ribbon.mod-left',
                            '.workspace-split.mod-horizontal.mod-left-split',
                            '.workspace-tab-header-container',
                            '.titlebar-button-container.mod-right',
                            `.status-bar`,
                        ];
                        toggleClassList.forEach((cls) => {
                            const elements = document.querySelectorAll(cls);
                            if (cls && elements) {
                                elements.forEach((element, i) => {
                                    const cname = 'zk-hidden';
                                    if (element.classList.contains(cname)) {
                                        element.removeClass(cname);
                                    } else {
                                        element.addClass(cname);
                                    }
                                });
                            }
                        });
                    })

                const playBtn = new ExtraButtonComponent(playControllerDiv);
                playBtn.setIcon("wand-2").setTooltip(t("growing animation"));
                playBtn.onClick(async () => {
                    if (this.plugin.settings.graphType === "structure") {
                        await this.branchGrowing();
                    } else {
                        await this.branchGrowingGit();
                    }
                })

            }

            if (this.plugin.settings.TableView == true) {
                const tableBtn = new ExtraButtonComponent(toolButtonsDiv);
                tableBtn.setIcon("table").setTooltip(t("table view"))
                tableBtn.onClick(async () => {
                    if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                        this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
                        //new tableModal(this.app, this.plugin, this.plugin.tableArr).open();
                        await this.plugin.openTableView();
                        this.plugin.clearShowingSettings(this.plugin.settings.BranchTab);
                    }
                })
            }


            if (this.plugin.settings.HistoryToggle == true) {

                const historyBtn = new ExtraButtonComponent(toolButtonsDiv);
                historyBtn.setIcon("history").setTooltip(t("History List"));
                historyBtn.onClick(async () => {
                    this.plugin.openRecentView();
                })
            }

        }

        switch (this.plugin.settings.lastRetrival.type) {
            case 'main':
                let selectZKNodes = this.plugin.MainNotes.filter(n =>
                    n.file?.path == this.plugin.settings.lastRetrival.filePath)

                if (selectZKNodes.length > 0) {
                    if (this.plugin.settings.lastRetrival.ID !== '') {
                        let nodeIndex = selectZKNodes.findIndex(n => n.ID == this.plugin.settings.lastRetrival.ID);
                        if (nodeIndex !== -1) {
                            this.plugin.settings.BranchTab = nodeIndex;
                        }
                    } else {
                        this.plugin.settings.lastRetrival.ID = selectZKNodes[0].ID;
                        this.plugin.settings.lastRetrival.displayText = selectZKNodes[0].displayText;
                    }
                }

                if (selectZKNodes.length == 0) {
                    new Notice(`Invalid main note: ${this.plugin.settings.lastRetrival.filePath}`)
                    return;
                }

                branchEntranceNodeArr.push(...selectZKNodes);

                indexLinkDiv.createEl('abbr', { text: t("Current note: ") });

                indexFile = this.app.vault.getFileByPath(this.plugin.settings.lastRetrival.filePath);

                this.unshiftHistoryList(this.plugin.settings.lastRetrival);

                break;

            case 'index':
                if (!this.plugin.settings.lastRetrival.filePath.startsWith(this.plugin.settings.FolderOfIndexes))

                    return;

                branchEntranceNodeArr = await this.getBranchEntranceNode(this.plugin.settings.lastRetrival);

                indexLinkDiv.createEl('abbr', { text: t("Current index: ") });

                indexFile = this.app.vault.getFileByPath(this.plugin.settings.lastRetrival.filePath);

                this.plugin.settings.lastRetrival.displayText = indexFile.basename;

                this.unshiftHistoryList(this.plugin.settings.lastRetrival)

                break;

            case 'all':
                indexLinkDiv.createEl('abbr', { text: t("all trees") });
                branchEntranceNodeArr = this.plugin.MainNotes.filter(n => n.isRoot == true);
                this.plugin.settings.lastRetrival = {
                    type: 'all',
                    ID: '',
                    displayText: t("all trees"),
                    filePath: '',
                    openTime: '',
                }
                this.unshiftHistoryList(this.plugin.settings.lastRetrival);
                break;
            default:

                let node = this.plugin.MainNotes[Math.floor(Math.random() * (this.plugin.MainNotes.length))];
                if (node) {
					if (!node.file) return;
                    this.plugin.settings.lastRetrival = {
                        type: 'main',
                        ID: node.ID,
                        displayText: node.displayText,
                        filePath: node.file.path,
                        openTime: '',
                    }
                }
                branchEntranceNodeArr.push(node);

                indexLinkDiv.createEl('abbr', { text: t("Current note: ") });
                this.unshiftHistoryList(this.plugin.settings.lastRetrival)
                indexFile = this.app.vault.getFileByPath(this.plugin.settings.lastRetrival.filePath);
                break;
        }

        if (indexFile instanceof TFile) {

            let link = indexLinkDiv.createEl('a', { text: `【${this.plugin.settings.lastRetrival.displayText}】` });

            link.addEventListener("click", (event: MouseEvent) => {
                if (event.ctrlKey) {
                    this.app.workspace.openLinkText("", indexFile.path, 'tab');
                } else {
                    this.app.workspace.openLinkText("", indexFile.path);
                }

            });
            link.addEventListener(`mouseover`, (event: MouseEvent) => {
                this.app.workspace.trigger(`hover-link`, {
                    event,
                    source: ZK_NAVIGATION,
                    hoverParent: link,
                    linktext: "",
                    targetEl: link,
                    sourcePath: indexFile.path,
                })
            });
        }

        if (branchEntranceNodeArr.length > 0) {

            // 保存分支入口节点和容器引用，用于按需渲染
            this.branchEntranceNodes = branchEntranceNodeArr;
            this.indexMermaidContainer = indexMermaidDiv;
            this.renderedBranches.clear();

            switch (this.plugin.settings.graphType) {
                case "structure":
                    // 只渲染第一个分支
                    await this.generateFlowchart(branchEntranceNodeArr, indexMermaidDiv, 0);
                    break;
                case "roadmap":
                    // 只渲染第一个分支
                    await this.generateGitgraph(branchEntranceNodeArr, indexMermaidDiv, 0);
                    break;
                default:
                //do nothing
            }

            await this.addBranchIcon(branchEntranceNodeArr, indexLinkDiv as HTMLDivElement);

        }

        if (this.plugin.settings.HistoryToggle === true) {
            this.app.workspace.trigger("zk-navigation:refresh-recent-view");
        }


        if (this.plugin.settings.TableView === true) {
            if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
                this.app.workspace.trigger("zk-navigation:refresh-table-view");
            }
        }

        if (this.plugin.settings.playControllerToggle === true) {
            this.resetController();
        }

        this.plugin.indexViewOffsetWidth = this.containerEl.offsetWidth;
        this.plugin.indexViewOffsetHeight = this.containerEl.offsetHeight;
    }

    // MOC 模式专用的刷新方法
    // MOC 模式专用的刷新方法 - 使用 Cytoscape 渲染
    async refreshBranchMermaidMOC(indexMermaidDiv: HTMLElement) {
        // 性能优化：不复用整体容器，而是复用各个子容器

        // 复用或创建顶部容器
        let graphTopContainer = document.getElementById("zk-moc-graph-top") as HTMLElement;

        if (!graphTopContainer) {
            // 首次创建
            graphTopContainer = indexMermaidDiv.createDiv("zk-graph-top");
            graphTopContainer.id = "zk-moc-graph-top";
        }

        // 添加工具栏
        if (this.plugin.settings.BranchToolbra === true) {
            // 复用或创建工具栏容器
            let toolButtonsDiv = document.getElementById("zk-moc-tool-buttons") as HTMLElement;

            if (!toolButtonsDiv) {
                // 首次创建
                toolButtonsDiv = graphTopContainer.createDiv("zk-tool-buttons");
                toolButtonsDiv.id = "zk-moc-tool-buttons";
            } else {
                // 复用：清空内容
                toolButtonsDiv.empty();
            }

            if (this.plugin.settings.settingIcon === true) {
                const settingBtn = new ExtraButtonComponent(toolButtonsDiv);
                settingBtn.setIcon("settings").setTooltip(t("settings"));
                settingBtn.onClick(() => {
                    //@ts-ignore
                    this.app.setting.open();
                    //@ts-ignore
                    this.app.setting.openTabById("zettelkasten-navigation");
                });
            }


            if (this.plugin.settings.TableView === true) {
                const tableBtn = new ExtraButtonComponent(toolButtonsDiv);
                tableBtn.setIcon("table").setTooltip(t("table view"));
                tableBtn.onClick(async () => {
                    if (this.mocNodes && this.mocNodes.length > 0) {
                        this.plugin.tableArr = this.mocNodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
                        await this.plugin.openTableView();
                    }
                });
            }


            // “添加自由节点”按钮已隐藏（功能保留）
        }

        // 添加播放控制器（底部居中）
        if (this.plugin.settings.playControllerToggle === true) {
            const playControllerDiv = indexMermaidDiv.createDiv("zk-play-controller");

            // 居中按钮
            const centerBtn = new ExtraButtonComponent(playControllerDiv);
            centerBtn.setIcon("target").setTooltip("居中");
            centerBtn.onClick(() => {
                if (this.branchRenderer) {
                    this.branchRenderer.fitAndCenter();
                }
            });

            // 放大按钮
            const expandBtn = new ExtraButtonComponent(playControllerDiv);
            expandBtn.setIcon("expand").setTooltip(t("expand graph"));
            expandBtn.onClick(() => {
                // 使用 Cytoscape 的全屏功能
                const branchGraphDiv = document.getElementById('zk-branch-cytoscape');
                if (branchGraphDiv) {
                    if (branchGraphDiv.requestFullscreen) {
                        branchGraphDiv.requestFullscreen();
                    }
                }
            });
        }

        // 获取 MOC 配置
        const mocFolder = this.plugin.settings.mocFolderPath;
        const headingTitle = this.plugin.settings.mocHeadingTitle;

        if (!mocFolder) {
            new Notice(t("Please configure MOC folder path in settings"));
            return;
        }

        // 获取 MOC 文件
        const mocFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(mocFolder));

        if (mocFiles.length === 0) {
            new Notice(t("No MOC files found in the specified folder"));
            return;
        }

        // 解析当前 MOC 文件
        let currentMOCPath = this.plugin.settings.mocCurrentFile;
        
        // 如果没有设置当前 MOC，使用第一个 MOC 文件并保存设置
        if (!currentMOCPath && mocFiles.length > 0) {
            currentMOCPath = mocFiles[0].path;
            this.plugin.settings.mocCurrentFile = currentMOCPath;
            await this.plugin.saveData(this.plugin.settings);
        }
        
        const currentMOCFile = this.app.vault.getAbstractFileByPath(currentMOCPath);

        if (!(currentMOCFile instanceof TFile)) {
            new Notice("Invalid MOC file");
            return;
        }

        const mocParseResult = await parseMOCStructure(this.app, currentMOCPath, headingTitle);

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

            // 为顶部工具栏和底部留出空间
            branchGraphDiv.style.height = `${this.containerEl.offsetHeight - 150}px`;
            branchGraphDiv.style.width = "100%";
            branchGraphDiv.style.marginBottom = "10px"; // 为底部按钮留出空间
        }
        // 注意：不再清空 branchGraphDiv，让 CytoscapeRenderer 内部的增量更新逻辑处理

        // 构建图形数据（包含分组信息和边弧度信息）
        const groups = mocParseResult.groups || [];
        const edgeCurvatures = mocParseResult.edgeCurvatures || {};
        const nodeColors = mocParseResult.nodeColors || {};
        const nodeStyleColors = (mocParseResult as any).nodeStyleColors || {};
        const crossDomainLinks = mocParseResult.crossDomainLinks || {};
        const nodePositions = mocParseResult.nodePositions || {};
        const embedNodeSizes = (mocParseResult as any).embedNodeSizes || {};
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
            embedNodeSizes
        );

        // 配置渲染选项
        const options: RenderOptions = {
            direction: (this.plugin.settings.DirectionOfBranchGraph || 'LR') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'dagre',
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
            themeMode: this.plugin.settings.themeMode,
            themeStyle: this.plugin.settings.themeStyle || 'default',
            edgeStyle: this.plugin.settings.edgeStyle || 'bezier',
            showNoteId: this.plugin.settings.showNoteIdInBranchView,
            smartConnection: this.plugin.settings.smartConnection === true
        };

        // 性能优化：复用或创建渲染器，避免每次都销毁重建
        if (!this.branchRenderer) {
            this.branchRenderer = new CytoscapeRenderer();
        }

        // 渲染或更新图形
        // CytoscapeRenderer 内部会智能判断是否需要完全重建或增量更新
        await this.branchRenderer.render(branchGraphDiv, graphData, options);

        // 恢复或自动居中视图
        const cy = this.branchRenderer.getCytoscapeInstance();
        if (cy) {
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

        // 性能优化：只在容器变化或首次初始化时重建事件监听器
        // Cytoscape 增量更新不会替换容器，所以监听器可以复用
        const needsListenerInit = !this.branchGraphListenersInitialized || this.currentBranchGraphDiv !== branchGraphDiv;

        if (needsListenerInit) {
            // 清理该图形容器上的旧事件监听器（如果是新容器）
            if (this.currentBranchGraphDiv && this.currentBranchGraphDiv !== branchGraphDiv) {
                this.cleanupElementListeners(this.currentBranchGraphDiv);
            }

            // 监听视图状态变化事件（缩放和平移）
            this.addTrackedListener(branchGraphDiv, 'viewStateChanged', async (event: any) => {
            const { zoom, pan } = event.detail;
            this.saveMOCViewState(currentMOCPath, zoom, pan);
        });

        // 监听自动连接事件（拖动节点到附近节点时触发）
        this.addTrackedListener(branchGraphDiv, 'auto-connect-node', async (event: any) => {
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
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (!mocFile) {
                    new Notice("未找到当前 MOC 文件");
                    return;
                }

                // 生成新的子节点 ID
                const newChildID = this.generateChildNodeID(parentNode.IDStr);

                // 使用 moveNodeToParent 方法移动节点到新的父节点
                await this.mocHandler.moveNodeToParent(mocFile, childNode.IDStr, parentNode.IDStr, newChildID);

                // 保存位置
                await this.saveNodePositionToMOC(mocFile, newChildID, position);

                // 刷新视图
                await this.refreshBranchMermaid();

                new Notice(`已连接节点: ${childNode.displayText} → ${parentNode.displayText} (新 ID: ${newChildID})`);
            } catch (error) {
                console.error('[auto-connect-node] 连接失败:', error);
                new Notice(`连接失败: ${error.message}`);
            }
        });

        // 监听节点位置变化事件（拖动后保存到 MOC 文件）
        this.addTrackedListener(branchGraphDiv, 'node-position-changed', async (event: any) => {
            const { node, position } = event.detail;

            // 检查节点是否有效
            if (!node || !node.ID) {
                console.warn('Invalid node in position-changed event:', node);
                return;
            }

            // 使用防抖，避免拖动时频繁保存
            if (this.nodePositionSaveTimeout) {
                clearTimeout(this.nodePositionSaveTimeout);
            }

            this.nodePositionSaveTimeout = setTimeout(async () => {
                // 保存位置到 MOC 文件
                try {
                    const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                    if (mocFile) {
                        // 检查是否是跨领域节点
                        if (node.isCrossDomain && node.crossDomainSourceNodeId && node.crossDomainOriginalNodeId) {
                            // 跨领域节点：保存到 cross_domain_links
                            const crossDomainLink = {
                                nodeId: node.crossDomainOriginalNodeId,
                                mocPath: node.filePath, // 跨领域节点链接到的 MOC 文件
                                displayText: node.displayText,
                                filePath: node.filePath
                            };
                            await this.saveCrossDomainNodePosition(
                                mocFile,
                                node.crossDomainSourceNodeId,
                                crossDomainLink,
                                position
                            );
                        } else {
                            // 普通节点：保存到 node_positions
                            await this.saveNodePositionToMOC(mocFile, node.ID, position);
                        }
                    }
                } catch (error) {
                    console.error('Failed to save node position:', error);
                }
            }, DEBOUNCE_DELAY.POSITION_SAVE);
        });

        // 监听跨领域节点位置变化事件（拖动后保存到 cross_domain_links）
        this.addTrackedListener(branchGraphDiv, 'cross-domain-node-position-changed', async (event: any) => {
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
                    const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { edgeId, source, target, distance, weight } = event.detail;

            // 使用防抖，避免拖动时频繁保存
            if (this.edgeCurvatureSaveTimeout) {
                clearTimeout(this.edgeCurvatureSaveTimeout);
            }

            this.edgeCurvatureSaveTimeout = setTimeout(async () => {
                // 保存弧度到 MOC 文件
                try {
                    const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                    if (mocFile) {
                        await this.saveEdgeCurvatureToMOC(mocFile, edgeId, { distance, weight });
                    }
                } catch (error) {
                    console.error('Failed to save edge curvature:', error);
                }
            }, DEBOUNCE_DELAY.EDGE_CURVATURE_SAVE);
        });

        // 监听预览节点尺寸变化事件（右下角拖拽后保存到 ext）
        this.addTrackedListener(branchGraphDiv, 'embed-node-size-changed', async (event: any) => {
            const { node, size } = event.detail || {};
            if (!node?.ID || !size) return;

            if (this.embedNodeSizeSaveTimeout) {
                clearTimeout(this.embedNodeSizeSaveTimeout);
            }

            this.embedNodeSizeSaveTimeout = setTimeout(async () => {
                try {
                    const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                    if (mocFile) {
                        await this.saveEmbedNodeSizeToMOC(mocFile, node.ID, size);
                    }
                } catch (error) {
                    console.error('Failed to save embed node size:', error);
                }
            }, DEBOUNCE_DELAY.POSITION_SAVE);
        });

        // 监听分组创建事件
        this.addTrackedListener(branchGraphDiv, 'group-create', async (event: any) => {
            const { groupId, groupLabel, nodeIds } = event.detail;
            
            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { groupId, oldLabel, newLabel } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { groupId, groupLabel, nodeIds } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { groupId, groupLabel, position } = event.detail;

            // 创建右键菜单
            const menu = new Menu();

            menu.addItem((item) => {
                item.setTitle('删除分组')
                    .setIcon('trash')
                    .onClick(async () => {
                        try {
                            const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                            if (mocFile) {
                                await this.deleteGroupFromMOC(mocFile, groupId);
                                // 刷新视图
                                await this.refreshBranchMermaid();
                            }
                        } catch (error) {
                            console.error('Failed to delete group:', error);
                        }
                    });
            });

            menu.showAtPosition(position);
        });

        // 监听节点点击事件
        this.addTrackedListener(branchGraphDiv, 'node-click', (event: any) => {
            const { node, ctrlKey, metaKey, shiftKey } = event.detail;

            // 检查节点是否有效
            if (!node || !node.file) {
                console.warn('Invalid node clicked:', node);
                return;
            }

            if (ctrlKey || metaKey) {
                // Ctrl/Command + 点击：在新标签页打开
                this.app.workspace.openLinkText("", node.file.path, 'tab');
            } else if (shiftKey) {
                // Shift + 点击：在图形视图中打开
                this.plugin.retrivalforLocaLgraph = {
                    type: '1',
                    ID: node.ID,
                    filePath: node.file.path,
                };
                this.plugin.openGraphView();
            }
        });

        // 监听节点悬停事件
        this.addTrackedListener(branchGraphDiv, 'node-hover', (event: any) => {
            const { node, event: mouseEvent } = event.detail;

            // 检查节点是否有效
            if (!node || !node.file) {
                return;
            }

            // Command/Ctrl 多选过程中，不触发悬浮预览
            if (mouseEvent?.metaKey || mouseEvent?.ctrlKey) {
                return;
            }

            this.app.workspace.trigger('hover-link', {
                event: mouseEvent,
                source: 'zk-navigation',
                hoverParent: branchGraphDiv,
                // 使用 Obsidian 常规参数组合，避免 [[...]] 解析差异导致误判“未创建”
                linktext: "",
                targetEl: mouseEvent.target,
                sourcePath: node.file.path,
            });
        });

        // 监听节点选中事件（单击）
        this.addTrackedListener(branchGraphDiv, 'node-select', (event: any) => {
            const { node } = event.detail;
            // 可以在这里添加选中节点的其他逻辑
        });

        // 监听节点编辑事件（双击）
        this.addTrackedListener(branchGraphDiv, 'node-edit', async (event: any) => {
            const { node } = event.detail;

            if (!node) {
                return;
            }

            await this.editNodeContent(node);
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

        // 监听节点删除键事件
        this.addTrackedListener(branchGraphDiv, 'node-delete-key', async (event: any) => {
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
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { node, event: mouseEvent, position } = event.detail;
            
            // 检查节点是否有效（允许纯文字节点，即 file 为 null 的节点）
            if (!node) {
                console.warn('Invalid node for context menu:', node);
                return;
            }
            
            // 阻止默认右键菜单
            mouseEvent.preventDefault();
            mouseEvent.stopPropagation();
            
            // 创建菜单
            const menu = new Menu();

            // 纯文字节点：修改内容选项
            if (node.isTextOnly) {
                menu.addItem((item) => {
                    item.setTitle("📝 修改内容")
                        .setIcon("pencil")
                        .onClick(async () => {
                            await this.editTextNodeContent(node);
                        });
                });

                menu.addSeparator();
            }

            // 关联跨领域节点选项
            menu.addItem((item) => {
                item.setTitle("🌐 关联跨领域节点")
                    .setIcon("network")
                    .onClick(async () => {
                        await this.linkCrossDomainNode(node);
                    });
            });

            menu.addSeparator();

            // 修改节点 ID 选项
            menu.addItem((item) => {
                item.setTitle("✏️ 修改节点 ID")
                    .setIcon("pencil")
                    .onClick(async () => {
                        await this.renameNodeID(node);
                    });
            });

            // 修改节点颜色选项
            menu.addItem((item) => {
                item.setTitle("🎨 修改节点颜色")
                    .setIcon("palette")
                    .onClick(async () => {
                        await this.changeNodeColor(node);
                    });
            });

            // 显示菜单
            menu.showAtMouseEvent(mouseEvent);
        });

        // 监听背景双击事件（创建占位符节点）
        this.addTrackedListener(branchGraphDiv, 'background-dblclick', async (event: any) => {
            const { position } = event.detail;

            // 创建占位符节点，而不是直接打开模态框
            await this.createPlaceholderNode(position);
        });

        // 监听占位符节点编辑事件
        this.addTrackedListener(branchGraphDiv, 'placeholder-node-edit', async (event: any) => {
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
            const { nodeId } = event.detail;
            await this.removePlaceholderNode(nodeId);
        });

        // 监听占位符节点完成事件（从 suggester 选择文件后触发）
        this.addTrackedListener(branchGraphDiv, 'placeholder-node-complete', async (event: any) => {
            const { nodeId, wikiLink, file, isEmbed } = event.detail;

            // 查找对应的节点
            const node = this.mocNodes.find(n => n.ID === nodeId);
            if (!node) return;

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
                    await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
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
                    await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
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
            const { edgeId, source, target, type, label, position, targetNodeSons } = event.detail;
            // 创建右键菜单
            const menu = new Menu();

            menu.addItem((item) => {
                item.setTitle('删除箭头关系')
                    .setIcon('trash')
                    .onClick(async () => {
                        try {
                            const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { groupId, groupLabel } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { edgeId, source, target, type, label, targetNodeSons } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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
            const { edgeId, source, target, oldLabel, newLabel } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
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

        // 监听边起点修改事件
        this.addTrackedListener(branchGraphDiv, 'edge-source-changed', async (event: any) => {
            const { edgeId, oldSource, newSource, target, label } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
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
            const { edgeId, source, oldTarget, newTarget, label } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
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
            const { sourceNode, targetNode } = event.detail;

            if (!sourceNode || !targetNode) {
                console.warn('Invalid nodes for arrow relation:', { sourceNode, targetNode });
                return;
            }

            // 检查目标节点是否是自由节点（ID 以 "free." 开头）
            const isFreeNode = targetNode.IDStr.startsWith('free.');
            let finalTargetID = targetNode.IDStr;
            let relationText = '';

            if (isFreeNode) {
                // 生成新的子节点 ID
                const newChildID = this.generateChildNodeID(sourceNode.IDStr);

                // 在刷新前保存所有节点的当前位置
                await this.saveAllNodePositionsBeforeRefresh();

                // 将自由节点移动为源节点的子节点（而不是只改 ID）
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
                    await this.mocHandler.moveNodeToParent(mocFile, targetNode.IDStr, sourceNode.IDStr, newChildID);
                    finalTargetID = newChildID;
                    new Notice(`自由节点 ${targetNode.IDStr} 已转换为子节点 ${newChildID}`);

                    // 刷新视图
                    await this.refreshBranchMermaid();
                }
            } else {
                // 不是自由节点，直接创建箭头关系（不显示输入对话框）
                relationText = '';

                // 在刷新前保存所有节点的当前位置
                await this.saveAllNodePositionsBeforeRefresh();

                try {
                    const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                    if (mocFile) {
                        await this.addArrowRelationToMOC(
                            mocFile,
                            sourceNode.IDStr,
                            finalTargetID,
                            relationText
                        );

                        // 刷新视图
                        await this.refreshBranchMermaid();

                        new Notice(`已创建箭头关系: ${sourceNode.ID} → ${finalTargetID}`);
                    }
                } catch (error) {
                    console.error('Failed to create arrow relation:', error);
                    new Notice(`创建箭头关系失败: ${error.message}`);
                }
            }
        });

        // 监听创建子节点事件（拖动连线到空白处）- 改为创建占位符节点
        this.addTrackedListener(branchGraphDiv, 'create-child-node', async (event: any) => {
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
            const { activeNodeId, position } = event.detail;
            await this.createChildNodeFromActive(activeNodeId, position);
        });

        // 监听创建兄弟节点快捷键事件（Enter）
        this.addTrackedListener(branchGraphDiv, 'create-sibling-node-shortcut', async (event: any) => {
            const { activeNodeId, position } = event.detail;
            await this.createSiblingNodeFromActive(activeNodeId, position);
        });

        // 监听创建父节点快捷键事件（Shift+Tab）
        this.addTrackedListener(branchGraphDiv, 'create-parent-node-shortcut', async (event: any) => {
            const { activeNodeId, position } = event.detail;
            await this.createParentNodeFromActive(activeNodeId, position);
        });

        // 监听批量分组事件
        this.addTrackedListener(branchGraphDiv, 'batch-create-group', async (event: any) => {
            const { nodeIds, groupName } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
                    await this.mocHandler.createGroupInMOC(mocFile, nodeIds, groupName);
                    await this.refreshBranchMermaid();
                    new Notice(`已创建分组 "${groupName}"，包含 ${nodeIds.length} 个节点`);
                } else {
                    console.error('MOC file not found:', currentMOCPath);
                }
            } catch (error) {
                console.error('Failed to create batch group:', error);
                new Notice(`批量分组失败: ${error.message}`);
            }
        });

        // 监听批量删除节点事件
        this.addTrackedListener(branchGraphDiv, 'batch-delete-nodes', async (event: any) => {
            const { nodeIds, nodes } = event.detail;

            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
                    // 逐个删除节点，根据 isCrossDomain 属性选择删除方法
                    for (let i = 0; i < nodeIds.length; i++) {
                        const nodeId = nodeIds[i];
                        const nodeData = nodes[i];

        
                        if (nodeData && nodeData.isCrossDomain) {
                            // 跨领域节点：使用专门的删除方法
                            const crossDomainLinkInfo = {
                                sourceNodeId: nodeData.originalNode.crossDomainSourceNodeId,
                                nodeId: nodeData.originalNode.crossDomainOriginalNodeId
                            };
                            await this.mocHandler.deleteCrossDomainNodeFromMOC(
                                mocFile,
                                nodeId,
                                crossDomainLinkInfo
                            );
                        } else {
                            // 普通节点：使用常规删除方法
                            await this.mocHandler.deleteNodeFromMOC(mocFile, nodeId);
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
            const { nodeIds } = event.detail;
            await this.batchChangeNodeColor(nodeIds);
        });

        // 标记监听器已初始化，保存当前容器引用
        this.branchGraphListenersInitialized = true;
        this.currentBranchGraphDiv = branchGraphDiv;
        }

        this.plugin.indexViewOffsetWidth = this.containerEl.offsetWidth;
        this.plugin.indexViewOffsetHeight = this.containerEl.offsetHeight;
    }

    // MOC 模式专用的流程图生成
    async generateFlowchartMOC(branchEntranceNodeArr: ZKNode[], indexMermaidDiv: HTMLElement, onlyRenderIndex?: number) {
        if (!this.branchAllNodes || this.branchAllNodes.length === 0) {
            this.branchAllNodes = [];
        }

        const startIndex = onlyRenderIndex !== undefined ? onlyRenderIndex : 0;
        const endIndex = onlyRenderIndex !== undefined ? onlyRenderIndex + 1 : branchEntranceNodeArr.length;

        for (let i = startIndex; i < endIndex; i++) {
            if (this.renderedBranches.has(i)) {
                continue;
            }

            // MOC 模式：获取当前根节点及其所有子节点
            const entranceNode = branchEntranceNodeArr[i];
            const branchNodes = this.mocNodes.filter(n =>
                n.IDStr === entranceNode.IDStr || n.IDStr.startsWith(entranceNode.IDStr + '.')
            );
            

            while (this.branchAllNodes.length <= i) {
                this.branchAllNodes.push({ branchTab: this.branchAllNodes.length, branchNodes: [] });
            }
            this.branchAllNodes[i] = { branchTab: i, branchNodes: branchNodes };

            // 构建节点位置缓存
            for (let node of branchNodes) {
                this.nodePositionMap.set(node.position, node);
            }

            if (branchNodes.length > 100) {
                new Notice(`正在渲染 ${branchNodes.length} 个节点...`, 2000);
            }

            const mermaidStr = await this.generateFlowchartStr(branchNodes, entranceNode, this.plugin.settings.DirectionOfBranchGraph, this.mocReverseRelations);
            
            const zkGraph = indexMermaidDiv.createEl("div", { cls: "zk-index-mermaid" });
            zkGraph.id = `zk-index-mermaid-${i}`;

            await addSvgPanZoom(zkGraph, indexMermaidDiv, i, this.plugin, mermaidStr, (this.containerEl.offsetHeight - 100));

            const indexMermaid = document.getElementById(zkGraph.id);

            if (indexMermaid !== null) {
                const nodeGArr = indexMermaid.querySelectorAll("[id^='flowchart-']");
                const flowchartG = indexMermaid.querySelector("g.nodes");

                if (flowchartG !== null) {
                    const nodeArr = flowchartG.getElementsByClassName("nodeLabel");

                    for (let j = 0; j < nodeArr.length; j++) {
                        const link = document.createElement('a');
                        link.addClass("internal-link");
                        link.textContent = nodeArr[j].getText();
                        nodeArr[j].textContent = "";
                        nodeArr[j].appendChild(link);

                        // 添加 "+" 按钮到节点后面
                        const nodePosStr = nodeGArr[j].id.split('-')[1];
                        const node = this.nodePositionMap.get(Number(nodePosStr));
                        
                        if (node) {
                            // 获取节点的矩形元素
                            const nodeRect = nodeGArr[j].querySelector('rect');
                            if (nodeRect) {
                                // 创建 SVG 文本元素作为按钮
                                const svgNS = "http://www.w3.org/2000/svg";
                                const btnGroup = document.createElementNS(svgNS, 'g');
                                btnGroup.setAttribute('class', 'zk-node-add-btn');
                                btnGroup.style.cursor = 'pointer';
                                
                                // 获取节点矩形的位置和大小
                                const rectX = parseFloat(nodeRect.getAttribute('x') || '0');
                                const rectY = parseFloat(nodeRect.getAttribute('y') || '0');
                                const rectWidth = parseFloat(nodeRect.getAttribute('width') || '0');
                                const rectHeight = parseFloat(nodeRect.getAttribute('height') || '0');
                                
                                // 创建按钮圆圈背景（位置更靠近节点边缘）
                                const btnCircle = document.createElementNS(svgNS, 'circle');
                                btnCircle.setAttribute('cx', (rectX + rectWidth + 5).toString());
                                btnCircle.setAttribute('cy', (rectY + rectHeight / 2).toString());
                                btnCircle.setAttribute('r', '10');
                                btnCircle.setAttribute('fill', '#4a9eff');
                                btnCircle.setAttribute('opacity', '0.8');
                                
                                // 创建按钮文本 "+"
                                const btnText = document.createElementNS(svgNS, 'text');
                                btnText.setAttribute('x', (rectX + rectWidth + 5).toString());
                                btnText.setAttribute('y', (rectY + rectHeight / 2 + 4).toString());
                                btnText.setAttribute('text-anchor', 'middle');
                                btnText.setAttribute('fill', 'white');
                                btnText.setAttribute('font-size', '16');
                                btnText.setAttribute('font-weight', 'bold');
                                btnText.textContent = '+';
                                
                                btnGroup.appendChild(btnCircle);
                                btnGroup.appendChild(btnText);
                                
                                // 鼠标悬停效果
                                btnGroup.addEventListener('mouseenter', () => {
                                    btnCircle.setAttribute('opacity', '1');
                                    btnCircle.setAttribute('r', '12');
                                });
                                btnGroup.addEventListener('mouseleave', () => {
                                    btnCircle.setAttribute('opacity', '0.8');
                                    btnCircle.setAttribute('r', '10');
                                });
                                
                                // 点击事件 - 显示菜单
                                btnGroup.addEventListener('click', async (e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    
                                    // 获取按钮的屏幕坐标
                                    const btnRect = btnCircle.getBoundingClientRect();
                                    
                                    // 显示弹出菜单，位置在按钮右侧
                                    this.showAddNodeMenu(btnRect, node, indexMermaidDiv);
                                });
                                
                                // 添加到节点组中
                                nodeGArr[j].appendChild(btnGroup);
                            }
                        }

                        if (this.plugin.settings.displayTimeToggle === true) {
                            const parentEl = nodeArr[j].parentElement;
                            if (node && parentEl) {
                                setTooltip(parentEl, `${t("created")}: ${moment(node.ctime).format(this.plugin.settings.datetimeFormat)}`);
                            }
                        }
                    }

                    const mermaidEl = indexMermaid as HTMLElement;
                    mermaidEl.addEventListener('click', this.handleNodeClick.bind(this, mermaidEl));
                    mermaidEl.addEventListener('contextmenu', this.handleNodeContextMenu.bind(this, mermaidEl));
                    mermaidEl.addEventListener('mouseover', this.handleNodeHover.bind(this, mermaidEl));

                    mermaidEl.addEventListener('touchend', (event) => {
                        const target = event.target as HTMLElement;
                        const nodeG = target.closest('[id^="flowchart-"]') as HTMLElement;
                        if (!nodeG) return;

                        const nodePosStr = nodeG.id.split('-')[1];
                        const node = this.nodePositionMap.get(Number(nodePosStr));
                        if (node) {
                            if (!node.file) return;
                            this.app.workspace.openLinkText("", node.file.path);
                        }
                    });
                }

            }

            this.renderedBranches.add(i);
        }
    }

    // MOC 模式专用的层级列表渲染
    async generateHierarchicalListMOC(indexMermaidDiv: HTMLElement) {    

        // 检查是否有树结构
        if (!this.mocTreeStructure || this.mocTreeStructure.length === 0) {
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            const errorDiv = indexMermaidDiv.createEl('div', {
                text: `${t("No tree structure found under heading:")} # ${headingTitle}`,
                cls: "zk-graph-text"
            });
            errorDiv.style.padding = "20px";
            errorDiv.style.textAlign = "center";
            return;
        }

        // 创建一个独立的容器用于层级列表（在 graphTopContainer 之后）
        // 确保层级列表在工具栏下方显示
        const listContainer = indexMermaidDiv.createDiv("zk-hierarchical-list");
        listContainer.style.padding = "20px";
        listContainer.style.minHeight = "200px";
        listContainer.style.width = "100%";
        listContainer.style.boxSizing = "border-box";
        listContainer.style.display = "block";
        listContainer.style.overflow = "auto";

        // 递归渲染树节点
        const renderTreeNode = (node: MOCTreeNode, container: HTMLElement, depth: number = 0) => {
            if (!node.file) {
                // 即使没有文件，也继续渲染子节点
                if (node.children && node.children.length > 0) {
                    for (const child of node.children) {
                        renderTreeNode(child, container, depth);
                    }
                }
                return;
            }

            const listItem = container.createDiv("zk-hierarchical-item");
            listItem.style.marginLeft = `${depth * 20}px`;
            listItem.style.marginTop = "4px";
            listItem.style.padding = "4px 8px";
            listItem.style.borderLeft = depth > 0 ? "2px solid var(--background-modifier-border)" : "none";
            listItem.style.cursor = "pointer";
            listItem.style.borderRadius = "4px";

            // 鼠标悬停效果
            listItem.addEventListener("mouseenter", () => {
                listItem.style.backgroundColor = "var(--background-modifier-hover)";
            });
            listItem.addEventListener("mouseleave", () => {
                listItem.style.backgroundColor = "transparent";
            });

            // 创建内容容器
            const contentDiv = listItem.createDiv();
            contentDiv.style.display = "flex";
            contentDiv.style.alignItems = "center";
            contentDiv.style.gap = "8px";

            // 关系文本（如果有）
            if (node.relationText) {
                const relationSpan = contentDiv.createEl("span", { text: node.relationText });
                relationSpan.style.color = "var(--text-muted)";
                relationSpan.style.fontSize = "14px";
            }

            // Wiki 链接
            const linkEl = contentDiv.createEl("a", {
                text: this.processDisplayText(node.displayText),
                cls: "internal-link"
            });
            linkEl.setAttribute("href", node.file.path);
            linkEl.style.textDecoration = "underline";
            linkEl.style.color = "var(--link-color)";

            // 编号（如果有，用反引号包裹）
            if (node.nodeID) {
                const idSpan = contentDiv.createEl("span", { text: `\`${node.nodeID}\`` });
                idSpan.style.color = "var(--text-normal)";
                idSpan.style.fontSize = "14px";
                idSpan.style.marginLeft = "4px";
                idSpan.style.fontFamily = "var(--font-monospace)";
            }

            // 点击打开文件
            listItem.addEventListener("click", (event: MouseEvent) => {
                if (event.ctrlKey || event.metaKey) {
                    this.app.workspace.openLinkText("", node.file!.path, "tab");
                } else {
                    this.app.workspace.openLinkText("", node.file!.path);
                }
            });

            // 递归渲染子节点
            if (node.children && node.children.length > 0) {
                for (const child of node.children) {
                    renderTreeNode(child, container, depth + 1);
                }
            }
        };

        // 渲染所有根节点
        let renderedCount = 0;
        for (const rootNode of this.mocTreeStructure) {
            renderTreeNode(rootNode, listContainer, 0);
            renderedCount++;
        }

        // 保存到 branchAllNodes 供其他功能使用
        if (this.branchAllNodes.length === 0) {
            this.branchAllNodes.push({ branchTab: 0, branchNodes: this.mocNodes });
        } else {
            this.branchAllNodes[0] = { branchTab: 0, branchNodes: this.mocNodes };
        }

        // 确保容器可见
        if (listContainer.children.length === 0) {
            console.warn("No items rendered in hierarchical list");
            const emptyDiv = listContainer.createEl('div', { text: "没有可渲染的节点" });
            emptyDiv.style.padding = "20px";
            emptyDiv.style.textAlign = "center";
            emptyDiv.style.color = "var(--text-muted)";
        }
    }

    // MOC 模式专用的 Git 图生成
    async generateGitgraphMOC(branchEntranceNodeArr: ZKNode[], indexMermaidDiv: HTMLElement, onlyRenderIndex?: number) {
        if (!this.branchAllNodes || this.branchAllNodes.length === 0) {
            this.branchAllNodes = [];
        }
        if (!this.allGitBranch || this.allGitBranch.length === 0) {
            this.allGitBranch = [];
        }

        const startIndex = onlyRenderIndex !== undefined ? onlyRenderIndex : 0;
        const endIndex = onlyRenderIndex !== undefined ? onlyRenderIndex + 1 : branchEntranceNodeArr.length;

        for (let i = startIndex; i < endIndex; i++) {
            if (this.renderedBranches.has(i)) {
                continue;
            }

            const entranceNode = branchEntranceNodeArr[i];
            const branchNodes = this.mocNodes.filter(n =>
                n.IDStr === entranceNode.IDStr || n.IDStr.startsWith(entranceNode.IDStr + ',')
            );

            while (this.branchAllNodes.length <= i) {
                this.branchAllNodes.push({ branchTab: this.branchAllNodes.length, branchNodes: [] });
            }
            this.branchAllNodes[i] = { branchTab: i, branchNodes: branchNodes };

            for (let node of branchNodes) {
                this.nodePositionMap.set(node.position, node);
            }

            if (branchNodes.length > 100) {
                new Notice(`正在渲染 ${branchNodes.length} 个节点...`, 2000);
            }

            const mermaidStr = await this.generateGitgraphStr(branchNodes, entranceNode, i);
            const zkGraph = indexMermaidDiv.createEl("div", { cls: "zk-index-mermaid" });
            zkGraph.id = `zk-index-mermaid-${i}`;

            await addSvgPanZoom(zkGraph, indexMermaidDiv, i, this.plugin, mermaidStr, (this.containerEl.offsetHeight - 100));

            const indexMermaid = document.getElementById(zkGraph.id);

            if (indexMermaid !== null) {
                const gElements = indexMermaid.querySelectorAll('g.commit-bullets');
                const circles = gElements[1].querySelectorAll("circle.commit");
                const circleNodes = Array.from(circles);
                gElements[1].textContent = "";

                for (let j = 0; j < circleNodes.length; j++) {
                    const link = document.createElementNS('http://www.w3.org/2000/svg', "a");
                    link.appendChild(circleNodes[j]);
                    gElements[1].appendChild(link);

                    const nodes = this.branchAllNodes[i].branchNodes;
                    const nodeArr = nodes.filter(n => n.gitNodePos === j);

                    if (nodeArr.length > 0) {
                        const node = nodeArr[0];
                        circleNodes[j].addEventListener("click", async (event: MouseEvent) => {
                            if (!node.file) return;
                            if (event.ctrlKey) {
                                this.app.workspace.openLinkText("", node.file.path, 'tab');
                            } else if (event.shiftKey) {
                                this.plugin.settings.lastRetrival = {
                                    type: 'main',
                                    ID: node.ID,
                                    displayText: node.displayText,
                                    filePath: node.file.path,
                                    openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                                };
                                await this.plugin.clearShowingSettings();
                                await this.IndexViewInterfaceInit();
                            } else if (event.altKey) {
                                this.plugin.retrivalforLocaLgraph = {
                                    type: '1',
                                    ID: node.ID,
                                    filePath: node.file.path,
                                };
                                this.plugin.openGraphView();
                            } else {
                                if (!node.file) return;
                                this.app.workspace.openLinkText("", node.file.path);
                            }
                        });

                        circleNodes[j].addEventListener("touchend", () => {
                            if (!node.file) return;
                            this.app.workspace.openLinkText("", node.file.path);
                        });

                        circleNodes[j].addEventListener('contextmenu', (event: MouseEvent) => {
                            event.preventDefault();
                            event.stopPropagation();

                            const menu = new Menu();

                            // 跨领域节点关联选项
                            menu.addItem((item) =>
                                item
                                    .setTitle("🌐 关联跨领域节点")
                                    .setIcon("network")
                                    .onClick(async () => {
                                        await this.linkCrossDomainNode(node);
                                    })
                            );

                            menu.addSeparator();

                            // 修改节点 ID 选项
                            menu.addItem((item) =>
                                item
                                    .setTitle("✏️ 修改节点 ID")
                                    .setIcon("pencil")
                                    .onClick(async () => {
                                        await this.renameNodeID(node);
                                    })
                            );

                            // 修改节点颜色选项
                            menu.addItem((item) =>
                                item
                                    .setTitle("🎨 修改节点颜色")
                                    .setIcon("palette")
                                    .onClick(async () => {
                                        await this.changeNodeColor(node);
                                    })
                            );

                            menu.addSeparator();

                            // 复制命令选项
                            for (let command of this.plugin.settings.NodeCommands) {
                                menu.addItem((item) =>
                                    item
                                        .setTitle(command.name)
                                        .setIcon(command.icon)
                                        .onClick(async () => {
                                            let copyStr: string = '';
                                            switch (command.copyType) {
                                                case 1:
                                                    copyStr = node.ID;
                                                    break;
                                                case 2:
                                                    if (!node.file) return;
                                                    copyStr = node.file.path;
                                                    copyStr = node.file.path;
                                                    break;
                                                case 3:
                                                    copyStr = moment(node.ctime).format(this.plugin.settings.datetimeFormat);
                                                    break;
                                                default:
                                                    break;
                                            }
                                            if (copyStr !== '') {
                                                await navigator.clipboard.writeText(copyStr);
                                            }
                                            this.app.commands.executeCommandById(command.id);
                                        })
                                );
                            }

                            menu.showAtMouseEvent(event);
                        });

                        circleNodes[j].addEventListener(`mouseover`, (event: MouseEvent) => {
                            this.app.workspace.trigger(`hover-link`, {
                                event,
                                source: ZK_NAVIGATION,
                                hoverParent: "",
                                linktext: "",
                                targetEl: circleNodes[j],
                                sourcePath: node.file?.path,
                            });
                        });
                    }
                }
            }

            this.renderedBranches.add(i);
        }
    }

    async addBranchIcon(branchEntranceNodeArr: ZKNode[], indexLinkDiv: HTMLDivElement) {
        if (branchEntranceNodeArr.length > 1) {

            indexLinkDiv.createEl('small', { text: ` >> ` });

            for (let i = 0; i < branchEntranceNodeArr.length; i++) {

                let branchTab = indexLinkDiv.createEl('span').createEl('a', { text: `🌿${i + 1} `, cls: "zk-branch-tab" });

                let node = branchEntranceNodeArr[i];
                setTooltip(branchTab, `${node.displayText} (${this.plugin.MainNotes.filter(n => n.IDStr.startsWith(node.IDStr)).length})`)

                branchTab.addEventListener("click", async () => {
                    await this.openBranchTab(i);
                    this.resetController();
                });

            }

            await this.openBranchTab(this.plugin.settings.BranchTab);
        }
    }

    async generateFlowchart(branchEntranceNodeArr: ZKNode[], indexMermaidDiv: HTMLElement, onlyRenderIndex?: number) {
        // 如果是首次调用，初始化 branchAllNodes
        if (!this.branchAllNodes || this.branchAllNodes.length === 0) {
            this.branchAllNodes = [];
        }

        // 确定要渲染的分支索引范围
        const startIndex = onlyRenderIndex !== undefined ? onlyRenderIndex : 0;
        const endIndex = onlyRenderIndex !== undefined ? onlyRenderIndex + 1 : branchEntranceNodeArr.length;

        for (let i = startIndex; i < endIndex; i++) {
            // 如果已经渲染过，跳过
            if (this.renderedBranches.has(i)) {
                continue;
            }

            const branchNodes = await this.getBranchNodes(branchEntranceNodeArr[i]);

            // 如果 branchAllNodes 中还没有这个索引的数据，添加占位
            while (this.branchAllNodes.length <= i) {
                this.branchAllNodes.push({ branchTab: this.branchAllNodes.length, branchNodes: [] });
            }
            this.branchAllNodes[i] = { branchTab: i, branchNodes: branchNodes };

            // 性能优化：构建节点位置缓存，O(1) 查找
            for (let node of branchNodes) {
                this.nodePositionMap.set(node.position, node);
            }

            // 性能优化：显示加载提示（2秒后自动消失）
            if (branchNodes.length > 100) {
                new Notice(`正在渲染 ${branchNodes.length} 个节点...`, 2000);
            }

            let mermaidStr = await this.generateFlowchartStr(branchNodes, branchEntranceNodeArr[i], this.plugin.settings.DirectionOfBranchGraph);
            let zkGraph = indexMermaidDiv.createEl("div", { cls: "zk-index-mermaid" });
            zkGraph.id = `zk-index-mermaid-${i}`;

            await addSvgPanZoom(zkGraph, indexMermaidDiv, i, this.plugin, mermaidStr, (this.containerEl.offsetHeight - 100));

            const indexMermaid = document.getElementById(zkGraph.id)

            if (indexMermaid !== null) {

                let nodeGArr = indexMermaid.querySelectorAll("[id^='flowchart-']");
                let flowchartG = indexMermaid.querySelector("g.nodes");

                if (flowchartG !== null) {

                    let nodeArr = flowchartG.getElementsByClassName("nodeLabel");

                    // 性能优化：只遍历一次添加链接和tooltip
                    for (let i = 0; i < nodeArr.length; i++) {
                        let link = document.createElement('a');
                        link.addClass("internal-link");
                        link.textContent = nodeArr[i].getText();
                        nodeArr[i].textContent = "";
                        nodeArr[i].appendChild(link);

                        // Tooltip - 使用缓存查找
                        if (this.plugin.settings.displayTimeToggle === true) {
                            let nodePosStr = nodeGArr[i].id.split('-')[1];
                            let node = this.nodePositionMap.get(Number(nodePosStr));
                            const parentEl = nodeArr[i].parentElement;
                            if (node && parentEl) {
                                setTooltip(parentEl, `${t("created")}: ${moment(node.ctime).format(this.plugin.settings.datetimeFormat)}`)
                            }
                        }
                    }

                    // 性能优化：事件委托 - 整个图表只需4个监听器（替代 n*5 个）
                    const mermaidEl = indexMermaid as HTMLElement;
                    mermaidEl.addEventListener('click', this.handleNodeClick.bind(this, mermaidEl));
                    mermaidEl.addEventListener('contextmenu', this.handleNodeContextMenu.bind(this, mermaidEl));
                    mermaidEl.addEventListener('mouseover', this.handleNodeHover.bind(this, mermaidEl));

                    // Touch 事件委托
                    mermaidEl.addEventListener('touchend', (event) => {
                        const target = event.target as HTMLElement;
                        const nodeG = target.closest('[id^="flowchart-"]') as HTMLElement;
                        if (!nodeG) return;

                        const nodePosStr = nodeG.id.split('-')[1];
                        const node = this.nodePositionMap.get(Number(nodePosStr));
                        if (node) {
                            if (!node.file) return;
                            this.app.workspace.openLinkText("", node.file.path);
                        }
                    });
                }

            }

            // 标记该分支已渲染
            this.renderedBranches.add(i);
        }
    }

    async generateGitgraph(branchEntranceNodeArr: ZKNode[], indexMermaidDiv: HTMLElement, onlyRenderIndex?: number) {
        // 如果是首次调用，初始化数组
        if (!this.branchAllNodes || this.branchAllNodes.length === 0) {
            this.branchAllNodes = [];
        }
        if (!this.allGitBranch || this.allGitBranch.length === 0) {
            this.allGitBranch = [];
        }

        // 确定要渲染的分支索引范围
        const startIndex = onlyRenderIndex !== undefined ? onlyRenderIndex : 0;
        const endIndex = onlyRenderIndex !== undefined ? onlyRenderIndex + 1 : branchEntranceNodeArr.length;

        for (let i = startIndex; i < endIndex; i++) {
            // 如果已经渲染过，跳过
            if (this.renderedBranches.has(i)) {
                continue;
            }

            const branchNodes = await this.getBranchNodes(branchEntranceNodeArr[i]);

            // 如果 branchAllNodes 中还没有这个索引的数据，添加占位
            while (this.branchAllNodes.length <= i) {
                this.branchAllNodes.push({ branchTab: this.branchAllNodes.length, branchNodes: [] });
            }
            this.branchAllNodes[i] = { branchTab: i, branchNodes: branchNodes };

            // 性能优化：构建节点位置缓存
            for (let node of branchNodes) {
                this.nodePositionMap.set(node.position, node);
            }

            // 性能优化：显示加载提示（2秒后自动消失）
            if (branchNodes.length > 100) {
                new Notice(`正在渲染 ${branchNodes.length} 个节点...`, 2000);
            }

            let mermaidStr = await this.generateGitgraphStr(branchNodes, branchEntranceNodeArr[i], i);
            let zkGraph = indexMermaidDiv.createEl("div", { cls: "zk-index-mermaid" });
            zkGraph.id = `zk-index-mermaid-${i}`;

            await addSvgPanZoom(zkGraph, indexMermaidDiv, i, this.plugin, mermaidStr, (this.containerEl.offsetHeight - 100));

            const indexMermaid = document.getElementById(zkGraph.id)

            if (indexMermaid !== null) {

                const gElements = indexMermaid.querySelectorAll('g.commit-bullets');

                let temNode = gElements[1];
                const circles = gElements[1].querySelectorAll("circle.commit")
                const circleNodes = Array.from(circles);
                gElements[1].textContent = "";
                for (let j = 0; j < circleNodes.length; j++) {

                    let link = document.createElementNS('http://www.w3.org/2000/svg', "a");
                    link.appendChild(circleNodes[j]);
                    gElements[1].appendChild(link);

                    let nodes = this.branchAllNodes[i].branchNodes;

                    let nodeArr = nodes.filter(n => n.gitNodePos === j);
                    if (nodeArr.length > 0) {
                        let node = nodeArr[0];
                        circleNodes[j].addEventListener("click", async (event: MouseEvent) => {
                            if (!node.file) return;
                            if (event.ctrlKey) {
                                this.app.workspace.openLinkText("", node.file.path, 'tab');
                            } else if (event.shiftKey) {
                                this.plugin.settings.lastRetrival = {
                                    type: 'main',
                                    ID: node.ID,
                                    displayText: node.displayText,
                                    filePath: node.file.path,
                                    openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                                }
                                await this.plugin.clearShowingSettings();
                                await this.IndexViewInterfaceInit();
                            } else if (event.altKey) {
                                this.plugin.retrivalforLocaLgraph = {
                                    type: '1',
                                    ID: node.ID,
                                    filePath: node.file.path,

                                };
                                this.plugin.openGraphView();
                            } else {
                                if (!node.file) return;
                                this.app.workspace.openLinkText("", node.file.path)
                            }

                        })
                        circleNodes[j].addEventListener("touchend", () => {
                            if (!node.file) return;
                            this.app.workspace.openLinkText("", node.file.path)
                        })
                        circleNodes[j].addEventListener('contextmenu', (event: MouseEvent) => {

                            const menu = new Menu();
                            for (let command of this.plugin.settings.NodeCommands) {
                                menu.addItem((item) =>
                                    item
                                        .setTitle(command.name)
                                        .setIcon(command.icon)
                                        .onClick(async () => {
                                            let copyStr: string = '';
                                            switch (command.copyType) {
                                                case 1:
                                                    copyStr = node.ID;
                                                    break;
                                                case 2:
                                                    if (!node.file) return;
                                                    copyStr = node.file.path;
                                                    copyStr = node.file.path;
                                                    break;
                                                case 3:
                                                    copyStr = moment(node.ctime).format(this.plugin.settings.datetimeFormat);
                                                    break;
                                                default:
                                                    break;
                                            }
                                            if (copyStr !== '') {
                                                await navigator.clipboard.writeText(copyStr);
                                            }
                                            this.app.commands.executeCommandById(command.id);
                                        })
                                )
                            }
                            menu.showAtMouseEvent(event);
                        });
                        circleNodes[j].addEventListener(`mouseover`, (event: MouseEvent) => {
                            this.app.workspace.trigger(`hover-link`, {
                                event,
                                source: ZK_NAVIGATION,
                                hoverParent: "",
                                linktext: "",
                                targetEl: circleNodes[j],
                                sourcePath: node.file?.path,
                            })
                        });
                    }
                }
            }

            // 标记该分支已渲染
            this.renderedBranches.add(i);
        }
    }

    resetController() {

        // 检查 branchAllNodes 是否存在且有对应的分支数据
        if (!this.branchAllNodes || !this.branchAllNodes[this.plugin.settings.BranchTab]) {
            return;
        }

        this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes.sort((a, b) => a.ctime - b.ctime);

        const branchMermaid = document.getElementById(`zk-index-mermaid-${this.plugin.settings.BranchTab}-svg`)

        if (branchMermaid == null) return;
        if (this.plugin.settings.graphType === "structure") {
            this.playStatus = {
                current: -1,
                total: this.plugin.tableArr.length,
                nodeGArr: Array.from(branchMermaid.querySelectorAll("[id^='flowchart-']")),
                lines: Array.from(branchMermaid.querySelectorAll(`[id^='L_']`)),
                labels: [],
            }

            this.playStatus.nodeGArr.forEach((item) => {
                item.removeClass("zk-hidden");
            })

            this.playStatus.lines.forEach((item) => {
                item.removeClass("zk-hidden");
            })
        } else {

            let nodeGArr: Element[] = [];
            let lines: Element[] = [];
            let lables: Element[] = [];

            const gElements = branchMermaid.querySelectorAll('g.commit-bullets');
            gElements.forEach((gElement) => {
                const circleNodes = gElement.querySelectorAll("circle.commit");
                if (circleNodes.length > 0) {
                    nodeGArr = Array.from(circleNodes);
                }
            })

            const aElements = branchMermaid.querySelectorAll('g.commit-arrows');
            aElements.forEach((aElement) => {
                const pathNodes = aElement.querySelectorAll("path.arrow");
                if (pathNodes.length > 0) {
                    lines = Array.from(pathNodes);
                }
            })

            const lElements = branchMermaid.querySelectorAll('g.commit-labels');
            lElements.forEach((lElement) => {
                const pathNodes = lElement.querySelectorAll("g");
                if (pathNodes.length > 0) {
                    lables = Array.from(pathNodes);
                }
            })

            this.playStatus = {
                current: -1,
                total: this.plugin.tableArr.length,
                nodeGArr: nodeGArr,
                lines: lines,
                labels: lables,
            }
            this.playStatus.nodeGArr.forEach((item) => {
                item.removeClass("zk-hidden");
            })

            this.playStatus.lines.forEach((item) => {
                item.removeClass("zk-hidden");
            })
            this.playStatus.labels.forEach((item) => {
                item.removeClass("zk-hidden");
            })
        }



    }

    async openBranchTab(tabNo: number) {

        this.plugin.settings.BranchTab = tabNo;

        // 如果该分支还未渲染，先渲染它
        if (!this.renderedBranches.has(tabNo) && this.branchEntranceNodes.length > 0 && this.indexMermaidContainer) {
            switch (this.plugin.settings.graphType) {
                case "structure":
                    await this.generateFlowchart(this.branchEntranceNodes, this.indexMermaidContainer, tabNo);
                    break;
                case "roadmap":
                    await this.generateGitgraph(this.branchEntranceNodes, this.indexMermaidContainer, tabNo);
                    break;
                default:
                //do nothing
            }
        }

        const branchGraph = document.getElementsByClassName("zk-index-mermaid");
        const branchTabs = document.getElementsByClassName("zk-branch-tab");

        for (let i = 0; i < branchGraph.length; i++) {
            branchGraph[i].addClass("zk-hidden");
            branchTabs[i].removeClass("zk-branch-tab-select");

        }

        if (branchGraph[tabNo]) {
            branchGraph[tabNo].removeClass("zk-hidden");
        }
        if (branchTabs[tabNo]) {
            branchTabs[tabNo].addClass("zk-branch-tab-select");
        }

        if (this.plugin.settings.TableView === true) {
            if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes;
                this.app.workspace.trigger("zk-navigation:refresh-table-view");
            }
        }

    }

    async getBranchEntranceNode(lastRetrival: Retrival) {

        let branchNodeArr: ZKNode[] = [];

        const indexFile = this.app.vault.getFileByPath(lastRetrival.filePath);

        if (indexFile !== null) {

            const resolvedLinks = this.app.metadataCache.resolvedLinks;
            let frontLinks: string[] = Object.keys(resolvedLinks[indexFile.path])
                .filter(l => l.endsWith("md"));

            if (frontLinks.length > 0) {
                for (let link of frontLinks) {
                    let branchFile = this.app.vault.getFileByPath(link);

                    if (branchFile) {
                        let nodes = this.plugin.MainNotes.filter(l => l.file?.path == branchFile?.path);
                        if (nodes.length > 0) {
                            branchNodeArr.push(...nodes);
                        }
                    }
                }
            }

            if (this.plugin.settings.lastRetrival.type !== 'index' && branchNodeArr.length == 0) {
                new Notice(`${t("Index: ")}【${indexFile.basename}】${t("has no valid main note outlinks")}`);
            }
        }

        return branchNodeArr;
    }

    async getBranchNodes(entranceNode: ZKNode) {

        let branchNodes: ZKNode[] = [];
        let startNode = entranceNode;

        // Starting node
        switch (this.plugin.settings.StartingPoint) {
            case "root":
                let frontNodes = this.plugin.MainNotes.filter(n => entranceNode.IDStr.startsWith(n.IDStr));

                if (frontNodes.length > 0) {
                    startNode = frontNodes[0];

                } else {
                    new Notice("Can't find the root of the branch!");
                }

                branchNodes = this.plugin.MainNotes.filter(n => n.IDStr.startsWith(startNode.IDStr));

                break;

            case "parent":
                if (entranceNode.IDArr.length > 1) {
                    let fatherArr = entranceNode.IDArr.slice(0, entranceNode.IDArr.length - 1);

                    let fatherNode = this.plugin.MainNotes
                        .find(n => n.IDStr == fatherArr.toString());

                    if (typeof fatherNode !== 'undefined') {
                        startNode = fatherNode;

                    } else {
                        startNode = entranceNode;
                    }

                } else {
                    startNode = entranceNode;
                }

                // only keep the father, siblings and sons of entranceNode
                branchNodes = this.plugin.MainNotes
                    .filter(n => n.IDStr.startsWith(startNode.IDStr))
                    .filter(n => n.IDStr.startsWith(entranceNode.IDStr) || (n.IDArr.length <= entranceNode.IDArr.length));

                break;
            default:
                branchNodes = this.plugin.MainNotes.filter(n => n.IDStr.startsWith(entranceNode.IDStr));

        }

        // branch level
        if (this.plugin.settings.DisplayLevel == "next") {

            branchNodes = branchNodes.filter(n => !n.IDStr.startsWith(entranceNode.IDStr) ||
                n.IDArr.length <= entranceNode.IDArr.length + 1);
        }

        //calculate width for siblings
        if (this.plugin.settings.siblingLenToggle === true) {
            const maxLength = Math.max(...branchNodes.map(n => n.IDArr.length));
            const minLength = Math.min(...branchNodes.map(n => n.IDArr.length));

            for (let i = minLength; i <= maxLength; i++) {
                let layerNodes = branchNodes.filter(n => n.IDArr.length === i);
                if (layerNodes.length > 1) {
                    let maxTextLen = Math.max(...layerNodes.map(n => displayWidth(n.displayText)));
                    for (let node of layerNodes) {
                        node.fixWidth = 6 * maxTextLen + 6;
                    }
                } else {
                    layerNodes[0].fixWidth = 0;
                }

            }

        }

        return branchNodes;

    }

    async generateGitgraphStr(Nodes: ZKNode[], entranceNode: ZKNode, branchTab: number) {

        this.generateGitBranch(Nodes, branchTab);
        this.order = 0;
        this.result = [];
        let temBranches = this.gitBranches.filter(b => b.branchName === "main");
        this.gitBranches = this.gitBranches.filter(b => b.branchName !== "main");

        if (temBranches.length > 0) {

            if (this.plugin.settings.gitUncrossing === true) {
                this.orderGitBranch_uncrossing(temBranches[0]);
            } else {
                this.result = temBranches.concat(this.gitBranches);
            }
            let git: AllGitBranch = {
                branchTab: branchTab,
                gitBranches: this.result,
                indexNode: entranceNode,
            }
            this.allGitBranch.push(git);

        }

        temBranches = this.result.filter(b => b.branchName === "main")
        this.gitBranches = this.result.filter(b => b.branchName !== "main")
        let gitNodePos: number = 0;
        let gitStr: string = '';
        // 跟踪已声明的分支，避免重复声明
        const declaredBranches = new Set<string>();
        declaredBranches.add("main"); // main 分支默认已存在

        while (temBranches.length > 0) {

            let nextBranch = temBranches.reduce((min, obj) => {
                // 性能优化：添加边界检查，避免访问 undefined
                if (!min || !min.nodes[min.currentPos]) return obj;
                if (!obj || !obj.nodes[obj.currentPos]) return min;

                return min.nodes[min.currentPos].ctime < obj.nodes[obj.currentPos].ctime ? min : obj;
            }, temBranches[0])

            let branchIndex = temBranches.indexOf(nextBranch);

            // 边界检查
            if (branchIndex === -1 || !temBranches[branchIndex].nodes[temBranches[branchIndex].currentPos]) {
                break;
            }

            let nextNode = temBranches[branchIndex].nodes[temBranches[branchIndex].currentPos];
            temBranches[branchIndex].currentPos = temBranches[branchIndex].currentPos + 1;

            nextNode.gitNodePos = gitNodePos
            gitNodePos = gitNodePos + 1;

            if (nextBranch.active === false) {
                gitStr = gitStr + `checkout ${nextBranch.branchPoint.branchName}\n`
                nextBranch.active = true;
            }
            gitStr = gitStr + `checkout ${nextBranch.branchName}
            commit id: "${this.escapeMermaidText(nextNode.displayText)}"`

            if (nextNode.ID === entranceNode.ID) {
                gitStr = gitStr + `tag: "index🌿"`// `type: HIGHLIGHT`
            }

            gitStr = gitStr + `\n`

            //if(temBranches[branchIndex].nodes.length === 0){
            if (temBranches[branchIndex].nodes.length === temBranches[branchIndex].currentPos) {
                temBranches.splice(branchIndex, 1);
            }
            let newBranches = this.gitBranches.filter(n => n.branchPoint.ID == nextNode.ID);
            // 必须先声明分支
            for (let branch of newBranches) {
                // 检查分支是否已经被声明过，避免重复声明
                if (!declaredBranches.has(branch.branchName)) {
                    temBranches.push(branch);
                    gitStr = gitStr + `branch ${branch.branchName} order: ${branch.order}\n`
                    declaredBranches.add(branch.branchName);
                }
            }
        }

        let mermaidStr: string = `%%{init: { 'logLevel': 'debug', 'theme': 'base', 'gitGraph': {'showBranches': false, 'parallelCommits': ${this.plugin.settings.nodeClose}, 'rotateCommitLabel': true}} }%%
                                gitGraph
                                ${gitStr}
                                `;
        return mermaidStr;
    }

    generateGitBranch(Nodes: ZKNode[], branchTab: number) {
        const maxLength = Math.max(...Nodes.map(n => n.IDArr.length));
        const minLength = Math.min(...Nodes.map(n => n.IDArr.length));

        this.gitBranches = [];

        this.gitBranches.push({
            branchName: "main",
            branchPoint: Nodes[0],
            nodes: Nodes.filter(l => l.IDArr.length === minLength),
            currentPos: 0,
            order: 0,
            positionX: 0,
            active: true,
        })

        let index = this.branchAllNodes[branchTab].branchNodes.indexOf(Nodes[0])

        if (index > -1) {
            this.branchAllNodes[branchTab].branchNodes[index].branchName = "main"
        }

        for (let i = minLength; i < maxLength; i++) {
            let layerNodes = Nodes.filter(n => n.IDArr.length === i);
            for (let fatherNode of layerNodes) {
                let sons = Nodes.filter(n => n.IDArr.length === i + 1 && n.IDArr.slice(0, -1).toString() === fatherNode.IDStr);
                if (sons.length > 0) {
                    let firstSon = sons.reduce((min, obj) => {
                        // 安全检查：确保节点存在
                        if (!min || !min.ctime) return obj;
                        if (!obj || !obj.ctime) return min;
                        return min.ctime < obj.ctime ? min : obj;
                    }, sons[0]);

                    if (/[0-9]/.test(firstSon.ID.slice(-1))) {
                        this.distinguishSons(Nodes, fatherNode, branchTab, i, /[0-9]/);
                        this.distinguishSons(Nodes, fatherNode, branchTab, i, /[a-zA-Z]/);
                    } else {
                        this.distinguishSons(Nodes, fatherNode, branchTab, i, /[a-zA-Z]/);
                        this.distinguishSons(Nodes, fatherNode, branchTab, i, /[0-9]/);
                    }
                }
            }
        }
    }

    distinguishSons(Nodes: ZKNode[], fatherNode: ZKNode, branchTab: number, i: number, regExp: RegExp) {
        let sons = Nodes.filter(n => n.IDArr.length === i + 1 && regExp.test(n.ID.slice(-1)) && n.IDArr.slice(0, -1).toString() === fatherNode.IDStr);
        if (sons.length > 0) {
            let branchName = `B${this.gitBranches.length}`;
            let gitBranch: GitBranch = {
                branchName: branchName,
                branchPoint: fatherNode,
                nodes: sons,
                currentPos: 0,
                positionX: 0,
                order: this.gitBranches.length,
                active: false,
            };
            this.gitBranches.push(gitBranch);
            for (let node of sons) {
                let index = this.branchAllNodes[branchTab].branchNodes.indexOf(node);
                // 边界检查：确保索引有效
                if (index !== -1 && this.branchAllNodes[branchTab].branchNodes[index]) {
                    this.branchAllNodes[branchTab].branchNodes[index].branchName = branchName;
                }
            }

        }
    }

    orderGitBranch_uncrossing(current: GitBranch) {

        current.order = this.order;
        this.result.push(current);

        this.order = this.order + 1;
        for (let i = current.nodes.length - 1; i >= 0; i--) {
            let branches = this.gitBranches.filter(b => b.branchPoint.ID === current.nodes[i].ID);
            if (branches.length > 0) {
                branches.sort((a, b) => {
                    // 安全检查：确保节点存在
                    const aTime = a.nodes[0]?.ctime || 0;
                    const bTime = b.nodes[0]?.ctime || 0;
                    return aTime - bTime;
                });
                for (let next of branches) {
                    this.orderGitBranch_uncrossing(next);
                }
            }
        }
    }

    // 转义 Mermaid 文本中的特殊字符（用于节点标签）
    escapeMermaidText(text: string): string {
        // 移除反引号，但保留编号内容
        // 将 `编号` 转换为 编号（保留编号，移除反引号）
        return text.replace(/`([^`]+)`/g, '$1')
            .replace(/"/g, '&quot;')  // 转义双引号
            .replace(/\n/g, ' ');     // 替换换行符
    }

    /**
     * 根据设置处理显示文本
     * - "id-title": 去掉数字前缀，只显示标题部分
     * - 其他模式: 保持原样
     */
    processDisplayText(text: string): string {
        if (this.plugin.settings.NodeText === "id-title") {
            // 去掉开头的任意数字和空格
            return text.replace(/(: )\d+\s+/, "$1");
        }
        return text;
    }

    async generateFlowchartStr(Nodes: ZKNode[], entranceNode: ZKNode, direction: string, reverseRelations?: Map<string, ReverseRelation>) {

        let mermaidStr: string = `%%{ init: { 'flowchart': { 'curve': 'base', 'wrappingWidth': '5000' },
        'themeVariables':{ 'fontSize': '12px'}}}%% flowchart ${direction};\n`;

        // 构建反向关系映射
        const reverseRelationsMap = new Map<string, ReverseRelation[]>();
        const nodeMap = new Map<string, ZKNode>();
        
        if (reverseRelations) {
            for (const [_, relation] of reverseRelations) {
                // 将关系添加到 sourceID 下
                if (reverseRelationsMap.has(relation.sourceID)) {
                    reverseRelationsMap.get(relation.sourceID)!.push(relation);
                } else {
                    reverseRelationsMap.set(relation.sourceID, [relation]);
                }
                
                // 将关系添加到 targetID 下
                if (reverseRelationsMap.has(relation.targetID)) {
                    reverseRelationsMap.get(relation.targetID)!.push(relation);
                } else {
                    reverseRelationsMap.set(relation.targetID, [relation]);
                }
            }
        }

        for (let node of Nodes) {
            nodeMap.set(node.IDStr, node);

            let nodeText = this.escapeMermaidText(this.processDisplayText(node.displayText));
            let fixWidth = node.fixWidth;

            if (this.plugin.settings.siblingLenToggle === true && node.fixWidth > 0) {
                mermaidStr = mermaidStr + `${node.position}("<p style='width:${fixWidth}px;'>${nodeText}</p>");\n`;
            } else {
                mermaidStr = mermaidStr + `${node.position}("${nodeText}");`;
            }

            mermaidStr = mermaidStr + `style ${node.position} fill:#2a3446,stroke:#5a6f7f,stroke-width:1px,color:#e0e0e0 \n`;
        }

        // 收集所有关系连线
        const links: Array<{
            from: number;
            to: number;
            text?: string;
            isDashed: boolean;
            isReverse: boolean;
            sourceIDStr: string;
            targetIDStr: string;
        }> = [];

        // 添加父子关系连线（根据 IDArr 确定父子关系）
        for (let node of Nodes) {
            if (node.IDArr.length > 1) {
                // 获取父节点ID（倒数第二个元素）
                const parentID = node.IDArr.at(-2);
                const parentNode = Nodes.find(n => n.IDStr === parentID);
                
                if (parentNode) {
                    if (node.relationText){
                        // 转义 relationText 中的特殊字符
                        const escapedRelation = this.escapeMermaidText(node.relationText);
                        links.push({
                            from: parentNode.position,
                            to: node.position,
                            text: escapedRelation,
                            isDashed: false,
                            isReverse: false,
                            sourceIDStr: parentNode.IDStr,
                            targetIDStr: node.IDStr
                        });
                    } else{
                        // 检查是否有反向关系覆盖了这条父子连线
                        const hasReverseRelation = reverseRelationsMap.get(node.IDStr)?.find(rel => 
                            (rel.targetID === node.IDStr && rel.sourceID === parentID) || 
                            (rel.targetID === parentID && rel.sourceID === node.IDStr)
                        );

                        if (!hasReverseRelation) {
                            // 没有 relationText 时使用普通连接线
                            links.push({
                                from: parentNode.position,
                                to: node.position,
                                isDashed: false,
                                isReverse: false,
                                sourceIDStr: parentNode.IDStr,
                                targetIDStr: node.IDStr
                            });
                        }
                    }
                }
            }
        }

        // 添加反向关系连线
        if (reverseRelations) {
            for (const [_, relation] of reverseRelations) {
                const sourceNode = nodeMap.get(relation.sourceID);
                const targetNode = nodeMap.get(relation.targetID);
                
                if (sourceNode && targetNode) {
                    // 检查是否是正向父子关系
                    const isParentChild = targetNode.IDStr.startsWith(sourceNode.IDStr + '.') || 
                                         targetNode.IDStr.startsWith(sourceNode.IDStr + ',');
                    
                    if (isParentChild) {
                        // 如果是正向父子推导关系，使用实线
                        const reverseRelationText = this.escapeMermaidText(relation.relationText);
                        links.push({
                            from: sourceNode.position,
                            to: targetNode.position,
                            text: reverseRelationText,
                            isDashed: false,
                            isReverse: false,
                            sourceIDStr: sourceNode.IDStr,
                            targetIDStr: targetNode.IDStr
                        });
                    } else {
                        // 反向连线：从当前节点指向目标节点，使用虚线和不同颜色
                        const reverseRelationText = this.escapeMermaidText(relation.relationText);
                        links.push({
                            from: sourceNode.position,
                            to: targetNode.position,
                            text: reverseRelationText,
                            isDashed: true,
                            isReverse: true,
                            sourceIDStr: sourceNode.IDStr,
                            targetIDStr: targetNode.IDStr
                        });
                    }
                }
            }
        }

        // 排序关系连线：按照 sourceIDStr 和 targetIDStr 排序
        links.sort((a, b) => {
            // 首先按 sourceIDStr 排序
            const sourceCompare = a.sourceIDStr.localeCompare(b.sourceIDStr);
            if (sourceCompare !== 0) return sourceCompare;
            
            // 如果 sourceIDStr 相同，按 targetIDStr 排序
            return a.targetIDStr.localeCompare(b.targetIDStr);
        });

        // 添加排序后的连线到 mermaid 字符串
        let linkIndex = 0;
        for (const link of links) {
            if (link.text) {
                if (link.isDashed) {
                    mermaidStr += `${link.from} -.->|${link.text}| ${link.to};\n`;
                } else {
                    mermaidStr += `${link.from} -->|${link.text}| ${link.to};\n`;
                }
            } else {
                if (link.isDashed) {
                    mermaidStr += `${link.from} -.-> ${link.to};\n`;
                } else {
                    mermaidStr += `${link.from} --> ${link.to};\n`;
                }
            }
            
            // 为反向连线添加样式（红色虚线）
            if (link.isReverse) {
                mermaidStr += `linkStyle ${linkIndex} stroke:#f66,stroke-width:2px,stroke-dasharray:5\n`;
            }
            
            linkIndex++;
        }

        if (this.plugin.settings.RedDashLine === true) {
            for (let node of Nodes) {
                if (/^[a-zA-Z]$/.test(node.ID.slice(-1))) {
                    //红色虚线边
                    mermaidStr = mermaidStr + `style ${node.position} stroke:#f66,stroke-width:2px,stroke-dasharray: 1 \n`;
                }
            }
        }

        return mermaidStr;
    }

    // 辅助方法：计算当前已有的连线数量
    private countLinks(mermaidStr: string): number {
        const linkMatches = mermaidStr.match(/-->/g) || [];
        const dashedLinkMatches = mermaidStr.match(/\.->/g) || [];
        return linkMatches.length + dashedLinkMatches.length;
    }

    unshiftHistoryList(lastRetrival: Retrival) {

        let a = this.plugin.settings.HistoryList.find(n => n.type == lastRetrival.type
            && n.filePath == lastRetrival.filePath && n.ID == lastRetrival.ID);

        if (a) {
            let index = this.plugin.settings.HistoryList.indexOf(a);
            if (index > -1) {
                this.plugin.settings.HistoryList.splice(index, 1);
            }
        }

        lastRetrival.openTime = moment().format("YYYY-MM-DD HH:mm:ss");

        this.plugin.settings.HistoryList.unshift(lastRetrival);

        if (this.plugin.settings.HistoryList.length > this.plugin.settings.HistoryMaxCount) {
            this.plugin.settings.HistoryList = this.plugin.settings.HistoryList.slice(0, this.plugin.settings.HistoryMaxCount);
        }
    }

    async generateCanvasStr() {
        let nodes = this.branchAllNodes.find(b => b.branchTab == this.plugin.settings.BranchTab)?.branchNodes;
        if (typeof nodes === 'undefined') return;
        nodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));

        let cardWidth = this.plugin.settings.cardWidth;
        let cardHeight = this.plugin.settings.cardHeight;
        let intervalX = cardWidth / 2;
        let intervalY = cardHeight / 8;
        let fromSide = "right";
        let toSide = "left";
        let direction = this.plugin.settings.DirectionOfBranchGraph;


        switch (direction) {
            case "RL":
                cardWidth = -cardWidth;
                cardHeight = cardHeight;
                intervalX = cardWidth / 2;
                intervalY = cardHeight / 8;
                fromSide = "left";
                toSide = "right";
                break;
            case "TB":
                cardWidth = cardWidth;
                cardHeight = cardHeight;
                intervalX = cardHeight / 8;
                intervalY = cardWidth / 2;
                fromSide = "bottom";
                toSide = "top";
                break;
            case "BT":
                cardWidth = -cardWidth;
                cardHeight = cardHeight;
                intervalX = -cardHeight / 8;
                intervalY = -cardWidth / 2;
                fromSide = "top";
                toSide = "bottom";
                break;
            default:

                break;
        }

        const maxLength = Math.max(...nodes.map(n => n.IDArr.length));
        const minLength = Math.min(...nodes.map(n => n.IDArr.length));


        for (let i = maxLength - 1; i >= minLength; i--) {
            let layerNodes = nodes.filter(n => n.IDArr.length === i);

            for (let node of layerNodes) {
                let sons = nodes.filter(n => n.IDStr.startsWith(node.IDStr) && n.IDArr.length == i + 1)
                if (sons.length > 0) {
                    let target = nodes.indexOf(node)
                    if (target >= 0) {
                        nodes[target].nodeSons = sons.reduce((count, node) => count + node.nodeSons, 0);
                    }
                } else {
                    node.nodeSons = 1;
                }
            }
        }

        for (let i = minLength; i <= maxLength; i++) {
            let layerNodes = nodes.filter(n => n.IDArr.length === i);
            let deep: number = 0;
            for (let j = 0; j < layerNodes.length; j++) {

                let father = nodes.find(n => layerNodes[j].IDStr.startsWith(n.IDStr) && (n.IDArr.length === i - 1));
                if (typeof father !== 'undefined') {

                    layerNodes[j].startY = father.startY + deep;

                    let height = intervalY * (layerNodes[j].nodeSons - 1) + cardHeight * layerNodes[j].nodeSons;

                    layerNodes[j].height = father.startY + deep + height / 2;

                    deep = deep + height + intervalY;

                    if (j < layerNodes.length - 1) {
                        let nextFather = nodes.find(n => layerNodes[j + 1].IDStr.startsWith(n.IDStr) && (n.IDArr.length === i - 1));
                        if (typeof nextFather !== 'undefined' && father !== nextFather) {
                            deep = 0;
                        }
                    }

                } else {
                    layerNodes[j].height = (intervalY * (layerNodes[j].nodeSons - 1) + cardHeight * layerNodes[j].nodeSons) / 2;
                }
            }
        }

        this.tightCards(nodes, intervalY, cardHeight);

        let canvasNodeStr: string = "";
        let canvasEdgeStr: string = "";
        for (let i = 0; i < nodes.length; i++) {
				if (!nodes[i].file) continue;

            let positionX: number = (nodes[i].IDArr.length - nodes[0].IDArr.length) * (cardWidth + intervalX);
            let positionY: number = nodes[i].height;
            if (direction === "LR" || direction === "RL") {
                canvasNodeStr = canvasNodeStr + `
                {"id":"${nodes[i].randomId}","x":${positionX},"y":${positionY},"width":${Math.abs(cardWidth)},"height":${Math.abs(cardHeight)},"type":"file","file":"${nodes[i].file!.path}"${this.getCanvasCardSetting(nodes[i].file!)},`
            } else {
                canvasNodeStr = canvasNodeStr + `
                {"id":"${nodes[i].randomId}","x":${positionY},"y":${positionX},"width":${Math.abs(cardWidth)},"height":${Math.abs(cardHeight)},"type":"file","file":"${nodes[i].file!.path}"${this.getCanvasCardSetting(nodes[i].file!)}},`

            }
            let IDStr = nodes[i].IDStr;
            let IDArr = nodes[i].IDArr;

            let sonNodes = nodes.filter(n => n.IDStr.startsWith(IDStr) && n.IDArr.length == IDArr.length + 1);

            for (let son of sonNodes) {
                canvasEdgeStr = canvasEdgeStr + `
                {"id":"${random(16)}","fromNode":"${nodes[i].randomId}","fromSide":"${fromSide}","toNode":"${son.randomId}","toSide":"${toSide}"${this.getCanvasArrowSetting()}},`
            }

        }

        if (canvasNodeStr.length > 0) {
            canvasNodeStr = canvasNodeStr.slice(0, -1);
        }
        if (canvasEdgeStr.length > 0) {
            canvasEdgeStr = canvasEdgeStr.slice(0, -1);
        }
        this.fileContent = `{
        "nodes":[${canvasNodeStr}
        ],
        "edges":[${canvasEdgeStr}
	    ]
        }`;
    }

    tightCards(nodes: ZKNode[], intervalY: number, cardHeight: number) {

        const maxLength = Math.max(...nodes.map(n => n.IDArr.length));
        const minLength = Math.min(...nodes.map(n => n.IDArr.length));

        for (let i = maxLength - 1; i >= minLength; i--) {
            let layerNodes = nodes.filter(n => n.IDArr.length === i);

            for (let node of layerNodes) {
                let sons = nodes.filter(n => n.IDStr.startsWith(node.IDStr) && n.IDArr.length == i + 1)
                if (sons.length > 1) {
                    //上半子节点
                    let upSons = sons.filter(n => n.height + cardHeight < node.height + (cardHeight + intervalY) / 2);
                    for (let j = upSons.length - 1; j >= 0; j--) {
                        let gapYArr: number[] = [];
                        let sequentNodes = nodes.filter(n => n.IDStr.startsWith(upSons[j].IDStr));
                        let maxLen = Math.max(...sequentNodes.map(n => n.IDArr.length));
                        for (let k = upSons[j].IDArr.length; k <= maxLen; k++) {
                            let temLayerNodes = sequentNodes.filter(n => n.IDArr.length === k);
                            let maxHeightNode = temLayerNodes.find(n => n.height == Math.max(...temLayerNodes.map(n => n.height)));
                            if (typeof maxHeightNode !== 'undefined') {
                                let columnNodes = nodes.filter(n => n.IDArr.length === k);
                                let nextNodeIndex = columnNodes.indexOf(maxHeightNode) + 1;
                                let nextNode = columnNodes[nextNodeIndex];
                                if (typeof nextNode !== 'undefined') {
                                    let gapY = nextNode.height - maxHeightNode.height - cardHeight;
                                    if (gapY >= intervalY) {
                                        gapYArr.push(gapY);
                                    }
                                }
                            }
                        }
                        if (gapYArr.length > 0) {
                            if (j == upSons.length - 1) {
                                let firstGapY = node.height + (cardHeight + intervalY) / 2 - upSons[upSons.length - 1].height - cardHeight;
                                if (firstGapY > intervalY) {
                                    gapYArr.push(firstGapY);
                                } else {
                                    continue;
                                }
                                gapYArr.push(firstGapY);
                            }
                            let minGapY = Math.min(...gapYArr);
                            if (minGapY > intervalY) {
                                for (let item of sequentNodes) {
                                    nodes[nodes.indexOf(item)].height += (minGapY - intervalY);
                                }
                            }
                        }
                    }

                    //下半子节点
                    let bottomSons = sons.filter(n => n.height > node.height + (cardHeight + intervalY) / 2);
                    for (let j = 0; j < bottomSons.length; j++) {
                        let gapYArr: number[] = [];
                        let sequentNodes = nodes.filter(n => n.IDStr.startsWith(bottomSons[j].IDStr));
                        let maxLen = Math.max(...sequentNodes.map(n => n.IDArr.length));
                        for (let k = bottomSons[j].IDArr.length; k <= maxLen; k++) {
                            let temLayerNodes = sequentNodes.filter(n => n.IDArr.length === k);

                            let minHeightNode = temLayerNodes.find(n => n.height == Math.min(...temLayerNodes.map(n => n.height)));
                            if (typeof minHeightNode !== 'undefined') {
                                let columnNodes = nodes.filter(n => n.IDArr.length === k);
                                let previousNodeIndex = columnNodes.indexOf(minHeightNode) - 1;
                                let previousNode = columnNodes[previousNodeIndex];
                                if (typeof previousNode !== 'undefined') {
                                    let gapY = minHeightNode.height - previousNode.height - cardHeight;
                                    if (gapY >= intervalY) {
                                        gapYArr.push(gapY);
                                    }
                                }
                            }
                        }
                        if (gapYArr.length > 0) {
                            if (j == 0) {
                                let firstGapY = bottomSons[0].height - node.height - (cardHeight - intervalY) / 2;
                                if (firstGapY > intervalY) {
                                    gapYArr.push(firstGapY);
                                } else {
                                    continue;
                                }
                                gapYArr.push(firstGapY);
                            }
                            let minGapY = Math.min(...gapYArr);
                            if (minGapY > intervalY) {
                                for (let item of sequentNodes) {
                                    nodes[nodes.indexOf(item)].height -= (minGapY - intervalY);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    async generateCanvasStrGit() {
        const cardWidth = this.plugin.settings.cardWidth;
        const cardHeight = this.plugin.settings.cardHeight;
        const intervalX = cardWidth / 4;
        const intervalY = cardHeight / 4;

        let gitBranches = this.allGitBranch.filter(n => n.branchTab === this.plugin.settings.BranchTab)[0].gitBranches;

        gitBranches.sort((a, b) => a.order - b.order);
        for (let i = 1; i < gitBranches.length; i++) {

            for (let j = i - 1; j >= 0; j--) {

                let node = gitBranches[j].nodes.find(n => n.ID === gitBranches[i].branchPoint.ID)

                if (node !== undefined) {
                    let index = gitBranches[j].nodes.indexOf(node);
                    gitBranches[i].positionX = gitBranches[j].positionX + (cardWidth + intervalX) * (index + 1);
                    break;
                }
            }
        }

        let canvasNodeStr: string = "";
        let canvasEdgeStr: string = "";

        for (let branch of gitBranches) {

            for (let i = 0; i < branch.nodes.length; i++) {
				if (!branch.nodes[i].file) continue;
				const branchFile = branch.nodes[i].file;
				canvasNodeStr = canvasNodeStr + `
				{"id":"${branch.nodes[i].randomId}","x":${branch.positionX + (cardWidth + intervalX) * i},"y":${(cardHeight + intervalY) * branch.order},"width":${cardWidth},"height":${cardHeight},"type":"file","file":"${branchFile!.path}"${this.getCanvasCardSetting(branchFile!)}},`
			}

            for (let i = 1; i < branch.nodes.length; i++) {
                canvasEdgeStr = canvasEdgeStr + `
                {"id":"${random(16)}","fromNode":"${branch.nodes[i - 1].randomId}","fromSide":"right","toNode":"${branch.nodes[i].randomId}","toSide":"left"${this.getCanvasArrowSetting()}},`
            }

            if (gitBranches.indexOf(branch) > 0) {
                canvasEdgeStr = canvasEdgeStr + `
                {"id":"${random(16)}","fromNode":"${branch.branchPoint.randomId}","fromSide":"bottom","toNode":"${branch.nodes[0].randomId}","toSide":"left"${this.getCanvasArrowSetting()}},`
            }
        }
        if (canvasNodeStr.length > 0) {
            canvasNodeStr = canvasNodeStr.slice(0, -1);
        }
        if (canvasEdgeStr.length > 0) {
            canvasEdgeStr = canvasEdgeStr.slice(0, -1);
        }
        this.fileContent = `{
        "nodes":[${canvasNodeStr}
        ],
        "edges":[${canvasEdgeStr}
	    ]
        }`;
    }

    async exportToCanvas() {

        let targetfile: any;
        let filePath: string = "";
        if (this.plugin.settings.canvasFilePath.endsWith(".canvas")) {
            filePath = this.plugin.settings.canvasFilePath;
            targetfile = this.app.vault.getAbstractFileByPath(filePath);
            if (targetfile && targetfile instanceof TFile) {
                await this.app.vault.modify(targetfile, this.fileContent);
            }
        }

        if (!(targetfile instanceof TFile)) {
            if (filePath == "") {
                filePath = `${moment().format("YYYY-MM-DD HH.mm.ss")}.canvas`;
            }
            new Notice("create new canvas file: " + filePath);
            targetfile = await this.app.vault.create(filePath, this.fileContent);
        }

        if (targetfile instanceof TFile) {
            let leaf = this.app.workspace.getLeavesOfType("canvas").filter(l => l.getDisplayText() == targetfile.basename);

            if (leaf.length > 0) {
                this.app.workspace.revealLeaf(leaf[0]);
            } else {
                this.app.workspace.openLinkText("", targetfile.path);
            }
        }

        this.fileContent = '';
    }

    async branchGrowing() {

        await this.hideBranchElements();

        let sec: number = 500;
        for (let node of this.plugin.tableArr) {

            setTimeout(() => {
                let nodeG = this.playStatus.nodeGArr.find(n => n.id.startsWith(`flowchart-${node.position}`));
                if (nodeG) {
                    nodeG.removeClass('zk-hidden');
                }
                let line = this.playStatus.lines.find(n => n.id.split('_')[2] == node.position.toString());
                if (line) {
                    line.removeClass('zk-hidden');
                }
            }, sec);

            sec = sec + 500;
        }

    }

    async branchGrowingGit() {

        await this.hideBranchElements();

        let sec: number = 500;
        for (let i = 0; i < this.playStatus.nodeGArr.length; i++) {

            setTimeout(() => {
                this.playStatus.current = i;
                this.branchPlayingGit()
            }, sec);

            sec = sec + 500;
        }
    }

    async hideBranchElements() {

        this.playStatus.nodeGArr.forEach((item) => {
            item.addClass('zk-hidden');
        })
        this.playStatus.lines.forEach((item) => {
            item.addClass('zk-hidden');
        })
        this.playStatus.labels.forEach((item) => {
            item.addClass('zk-hidden');
        })

        await this.toggleTagGit(true);
    }

    async branchPlaying() {
        let split = this.playStatus.current + 1;
        let showNodes = this.plugin.tableArr.slice(0, split);
        let hideNodes = this.plugin.tableArr.slice(split);

        for (let node of showNodes) {

            let nodeG = this.playStatus.nodeGArr.find(n => n.id.startsWith(`flowchart-${node.position}`));
            if (nodeG) {
                nodeG.removeClass('zk-hidden');
            }
            let line = this.playStatus.lines.find(n => n.id.split('_')[2] == node.position.toString());
            if (line) {
                line.removeClass('zk-hidden');
            }
        }

        for (let node of hideNodes) {

            let nodeG = this.playStatus.nodeGArr.find(n => n.id.startsWith(`flowchart-${node.position}`));
            if (nodeG) {
                nodeG.addClass('zk-hidden');
            }
            let line = this.playStatus.lines.find(n => n.id.split('_')[2] == node.position.toString());
            if (line) {
                line.addClass('zk-hidden');
            }
        }
    }

    async branchPlayingGit() {

        let split = this.playStatus.current + 1;

        for (let el of this.playStatus.nodeGArr.slice(0, split)) {
            el.removeClass('zk-hidden');
        }
        for (let el of this.playStatus.lines.slice(0, split - 1)) {
            el.removeClass('zk-hidden');
        }
        for (let el of this.playStatus.labels.slice(0, split)) {
            el.removeClass('zk-hidden');
        }

        for (let el of this.playStatus.nodeGArr.slice(split)) {
            el.addClass('zk-hidden');
        }
        for (let el of this.playStatus.lines.slice(split - 1)) {
            el.addClass('zk-hidden');
        }
        for (let el of this.playStatus.labels.slice(split)) {
            el.addClass('zk-hidden');
        }

        let indexPos = this.allGitBranch[this.plugin.settings.BranchTab].indexNode.gitNodePos;

        if (indexPos >= split) {
            await this.toggleTagGit(true);
        } else {
            await this.toggleTagGit(false);
        }
    }

    // 性能优化：事件委托 - 点击处理
    handleNodeClick = (indexMermaid: HTMLElement, event: MouseEvent) => {
        const target = event.target as HTMLElement;
        const nodeG = target.closest('[id^="flowchart-"]') as HTMLElement;
        if (!nodeG) return;

        const nodePosStr = nodeG.id.split('-')[1];
        const node = this.nodePositionMap.get(Number(nodePosStr));
        if (!node) return;

        if (event.ctrlKey) {
            if (!node.file) return;
            if (target.classList.contains('internal-link')) {
                this.app.workspace.openLinkText("", node.file.path, 'tab');
                event.stopPropagation();
            } else {
                navigator.clipboard.writeText(node.ID);
                new Notice(node.ID + " copied");
            }
        } else if (event.shiftKey) {
				if (!node.file) return;
				if (!node.file) return;
            this.plugin.settings.lastRetrival = {
                type: 'main',
                ID: node.ID,
                displayText: node.displayText,
                filePath: node.file.path,
                openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
            };
            this.plugin.clearShowingSettings();
            this.IndexViewInterfaceInit();
        } else if (event.altKey) {
				if (!node.file) return;
            this.plugin.retrivalforLocaLgraph = {
                type: '1',
                ID: node.ID,
                filePath: node.file.path,
            }
            if (!node.file) return;;
            this.plugin.openGraphView();
        } else if (target.classList.contains('internal-link')) {
            if (!node.file) return;
            this.app.workspace.openLinkText("", node.file.path);
        }
    }

    // 性能优化：事件委托 - 右键菜单处理
    handleNodeContextMenu = (indexMermaid: HTMLElement, event: MouseEvent) => {
        const target = event.target as HTMLElement;
        const nodeG = target.closest('[id^="flowchart-"]') as HTMLElement;
        if (!nodeG) return;

        const nodePosStr = nodeG.id.split('-')[1];
        const node = this.nodePositionMap.get(Number(nodePosStr));
        if (!node) return;

        event.preventDefault();
        const menu = new Menu();

        for (let command of this.plugin.settings.NodeCommands) {
            menu.addItem((item) =>
                item
                    .setTitle(command.name)
                    .setIcon(command.icon)
                    .onClick(async () => {
                        let copyStr = '';
                        switch (command.copyType) {
                            case 1: copyStr = node.ID; break;
                            case 2: if (!node.file) return; copyStr = node.file.path; break;
                            case 3: copyStr = moment(node.ctime).format(this.plugin.settings.datetimeFormat); break;
                        }
                        if (copyStr) await navigator.clipboard.writeText(copyStr);
                        this.app.commands.executeCommandById(command.id);
                    })
            );
        }
        menu.showAtMouseEvent(event);
    }

    // 性能优化：事件委托 - Hover 处理
    handleNodeHover = (indexMermaid: HTMLElement, event: MouseEvent) => {
        const target = event.target as HTMLElement;
        if (!target.classList.contains('internal-link')) return;

        const nodeG = target.closest('[id^="flowchart-"]') as HTMLElement;
        if (!nodeG) return;

        const nodePosStr = nodeG.id.split('-')[1];
        const node = this.nodePositionMap.get(Number(nodePosStr));
        if (!node) return;

        this.app.workspace.trigger('hover-link', {
            event,
            source: ZK_NAVIGATION,
            hoverParent: this,
            linktext: "",
            targetEl: target,
            sourcePath: node.file?.path,
        });
    }

    async toggleTagGit(toggle: boolean) {

        const indexMermaid = document.getElementById(`zk-index-mermaid-${this.plugin.settings.BranchTab}`)
        if (!indexMermaid) return;

        let polygonEls = indexMermaid.querySelectorAll("polygon");
        if (polygonEls.length > 0) {
            if (toggle) {
                let nextEl1 = polygonEls[0].nextElementSibling
                polygonEls[0].addClass('zk-hidden');
                if (nextEl1) {
                    nextEl1.addClass('zk-hidden');
                    let nextEl2 = nextEl1.nextElementSibling;
                    if (nextEl2) {
                        nextEl2.addClass('zk-hidden');
                    }
                }

            } else {
                let nextEl1 = polygonEls[0].nextElementSibling
                polygonEls[0].removeClass('zk-hidden');
                if (nextEl1) {
                    nextEl1.removeClass('zk-hidden');
                    let nextEl2 = nextEl1.nextElementSibling;
                    if (nextEl2) {
                        nextEl2.removeClass('zk-hidden');
                    }
                }
            }
        }
    }

    getCanvasCardSetting(file: TFile) {

        let cardSetting: string = ",";
        let subpath = this.plugin.settings.canvasSubpath;
        if (subpath !== "" && file.extension === "md") {
            let headings = this.app.metadataCache.getFileCache(file)?.headings
            if (headings) {
                let heading: HeadingCache | undefined = undefined;
                if (this.plugin.settings.headingMatchMode === 'regex') {
                    try {
                        const pattern = new RegExp(subpath);
                        heading = headings.find(h => pattern.test(h.heading));
                    } catch (error) {

                    }
                } else {
                    heading = headings.find(h => h.heading === subpath) || headings.find(h => h.heading.includes(subpath));
                }

                if (heading) {
                    cardSetting = cardSetting + `"subpath":"#${heading.heading}",`
                }
            }
        }
        if (this.plugin.settings.canvasCardColor !== "#C0C0C0") {
            cardSetting = cardSetting + `"color":"${this.plugin.settings.canvasCardColor}",`
        }

        return cardSetting.slice(0, -1)
    }

    getCanvasArrowSetting() {

        let arrowSetting: string = ","
        if (this.plugin.settings.canvasArrowColor !== "#C0C0C0") {
            arrowSetting = arrowSetting + `"color":"${this.plugin.settings.canvasArrowColor}",`
        }
        return arrowSetting.slice(0, -1)
    }

    // MOC 文件选择器
    openMOCSelectorModal() {
        const mocFolder = this.plugin.settings.mocFolderPath;
        if (!mocFolder) {
            new Notice(t("Please configure MOC folder path in settings"));
            return;
        }

        const mocFiles = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(mocFolder + '/'));

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
                if (this.mocButton) {
                    let mocName = item.file.basename;
                    const maxLength = 9;
                    if (mocName.length > maxLength) {
                        mocName = mocName.substring(0, maxLength) + "...";
                    }
                    this.mocButton.setButtonText(`🔍 ${mocName}`);
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

        const mocFiles = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(mocFolder + '/'));

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
        forwardOption.innerHTML = '➡️ 正向';
        forwardOption.addEventListener('click', async (e) => {
            e.stopPropagation();
            menu.remove();
            await this.addChildNodeToMOC(node);
        });

        // 反向连接选项
        const reverseOption = menu.createDiv('zk-menu-option');
        reverseOption.innerHTML = '⬅️ 反向';
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

            // 获取所有 MOC 文件
            const mocFolder = this.plugin.settings.mocFolderPath;
            const mocFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(mocFolder));

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
                // 批量更新节点颜色
                for (const nodeId of nodeIds) {
                    await this.mocHandler.updateNodeColorInMOC(mocFile, nodeId, selectedColor);
                }

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

    /**
     * 显示文本节点内容输入对话框
     */
    private showTextNodeContentInputDialog(currentContent: string, title: string = '修改文本节点内容'): Promise<string | null> {
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
                setTimeout(focusSearchInput, 0);
                requestAnimationFrame(() => requestAnimationFrame(focusSearchInput));
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
                if (!newContent) {
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
                    if (!newContent) {
                        new Notice('文本内容不能为空');
                        return;
                    }
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
        // 否则，如果启用了智能连线，查找最近的节点作为父节点
        else if (this.plugin.settings.smartConnection) {
            let nearestNode: ZKNode | null = null;
            let minDistance = Infinity;
            const PROXIMITY_THRESHOLD = 250;  // 250px 范围

            // 获取当前 MOC 文件的节点位置
            const currentMOCPath = this.plugin.settings.mocCurrentFile;
            const mocNodePositions = this.plugin.settings.mocNodePositions[currentMOCPath] || {};

            // 遍历所有节点，找到最近的节点
            for (const node of this.mocNodes) {
                const nodePos = mocNodePositions[node.ID];
                if (!nodePos) continue;

                const distance = Math.sqrt(
                    Math.pow(position.x - nodePos.x, 2) +
                    Math.pow(position.y - nodePos.y, 2)
                );

                if (distance < minDistance && distance < PROXIMITY_THRESHOLD) {
                    minDistance = distance;
                    nearestNode = node;
                }
            }

            if (nearestNode) {
                parentNodeId = nearestNode.IDStr;
                // 预生成子节点 ID
                suggestedNodeId = this.generateChildNodeID(parentNodeId);

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

            // 然后移动到父节点下
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
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

        // 保存位置
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (mocFile) {
            await this.saveNodePositionToMOC(mocFile, suggestedID, position);
        }

        // 从占位符追踪中移除
        this.placeholderNodes.delete(tempId);

        // 刷新视图
        await this.refreshBranchMermaid();

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
            const mocFile = this.app.vault.getFileByPath(this.plugin.settings.mocCurrentFile);
            if (mocFile) {
                await this.mocHandler.moveNodeToParent(mocFile, suggestedID, placeholderInfo.parentNodeId, suggestedID);
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

        // 保存位置
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        if (mocFile) {
            await this.saveNodePositionToMOC(mocFile, suggestedID, position);
        }

        // 从占位符追踪中移除
        this.placeholderNodes.delete(tempId);

        // 刷新视图
        await this.refreshBranchMermaid();

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

                // 如果有父节点，添加为子节点
                if (result.connectToNodeID) {
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

                    const parentNode = findNodeInTree(mocData.nodes, result.connectToNodeID);
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

                // 检查箭头关系是否存在
                const key = `${sourceID}->${targetID}`;
                const relation = mocData.reverseRelations.get(key);
                if (!relation) {
                    throw new Error(`未找到箭头关系: ${sourceID} --> ${targetID}`);
                }


                // 更新关系标签
                relation.relationText = newLabel;
                mocData.reverseRelations.set(key, relation);

                // 如果是父子边，还需要更新节点树中的 relationText
                const targetNode = this.findNodeInTree(mocData.nodes, targetID);
                if (targetNode && targetNode.relationText !== undefined) {
                    targetNode.relationText = newLabel;
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
                const oldRelation = mocData.reverseRelations.get(oldKey);
                if (!oldRelation) {
                    throw new Error(`未找到箭头关系: ${oldSource} --> ${target}`);
                }

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
        _source: string,
        oldTarget: string,
        newTarget: string,
        _label: string
    ): Promise<void> {
        try {
            // 交换节点ID：使用 updateNodeIDInMOC 来完成ID互换
            // 第一步：将 oldTarget 临时改为 tempID
            const tempID = `temp_${Date.now()}`;
            await this.mocHandler.updateNodeIDInMOC(mocFile, oldTarget, tempID);

            // 第二步：将 newTarget 改为 oldTarget（继承ID）
            await this.mocHandler.updateNodeIDInMOC(mocFile, newTarget, oldTarget);

            // 第三步：将 tempID 改为 newTarget
            await this.mocHandler.updateNodeIDInMOC(mocFile, tempID, newTarget);

        } catch (error) {
            console.error('Failed to update edge target:', error);
            throw error;
        }
    }

    /**
     * 在刷新前保存所有节点的当前位置（仅在位置发生变化时）
     */
    private async saveAllNodePositionsBeforeRefresh(): Promise<void> {
        if (!this.branchRenderer) {
            return;
        }

        const cy = this.branchRenderer.getCytoscapeInstance();
        if (!cy) {
            return;
        }

        const mocFilePath = this.plugin.settings.mocCurrentFile;
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
}
