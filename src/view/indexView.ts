import ZKNavigationPlugin, { Retrival } from "main";
import { ButtonComponent, DropdownComponent, ExtraButtonComponent, HeadingCache, ItemView, Menu, Modal, Notice, Setting, TFile, WorkspaceLeaf, debounce, moment, setTooltip } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { mainNoteFuzzyModal, mainNoteModal } from "src/modal/mainNoteModal";
import { tableModal } from "src/modal/tableModal";
import { AddFreeNodeModal } from "src/modal/addFreeNodeModal";
import { expandGraphModal } from "src/modal/expandGraphModal";
import { convertMOCToZKNodes, displayWidth, mainNoteInit, MOCTreeNode, parseMOCStructure, random, addSvgPanZoom } from "src/utils/utils";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { RenderOptions } from "src/renderer/types";

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
    file: TFile;
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

    constructor(leaf: WorkspaceLeaf, plugin: ZKNavigationPlugin) {
        super(leaf);
        this.plugin = plugin;
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
                }, 300);
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
        containerEl.empty();
        containerEl.addClass("zk-view-content");

        const toolbarDiv = containerEl.createDiv("zk-index-toolbar");

        const indexMermaidDiv = containerEl.createDiv("zk-index-mermaid-container");
        indexMermaidDiv.id = "zk-index-mermaid-container";

        indexMermaidDiv.empty();

        if (this.plugin.settings.MainNoteButton == true) {

            const mainNoteButtonDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
            const mainNoteButton = new ButtonComponent(mainNoteButtonDiv).setClass("zk-index-toolbar-button");
            mainNoteButton.setButtonText(this.plugin.settings.MainNoteButtonText);
            mainNoteButton.setCta();
            mainNoteButton.onClick(() => {
                if (this.plugin.settings.MainNoteSuggestMode === "IDOrder") {
                    new mainNoteModal(this.app, this.plugin, this.plugin.MainNotes, (selectZKNode) => {
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

        // MOC 按钮
        if (this.plugin.settings.mocModeEnabled == true) {

            const mocButtonDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
            const mocButton = new ButtonComponent(mocButtonDiv).setClass("zk-index-toolbar-button");
            mocButton.setButtonText(t("MOC"));
            mocButton.setCta();
            mocButton.onClick(() => {
                this.openMOCSelector();
            });

        }

        const startingDiv = toolbarDiv.createDiv("zk-index-toolbar-block");

        startingDiv.createEl("b", { text: t("Display from : ") });

        const startPoint = new DropdownComponent(startingDiv);
        startPoint
            .addOption("index", t("index"))
            .addOption("parent", t("parent"))
            .addOption("root", t("root"))
            .setValue(this.plugin.settings.StartingPoint)
            .onChange((StartPoint) => {
                this.plugin.settings.StartingPoint = StartPoint;
                this.plugin.clearShowingSettings(this.plugin.settings.BranchTab);
                this.app.workspace.trigger("zk-navigation:refresh-index-graph");
            });

        const displayLevelDiv = toolbarDiv.createDiv("zk-index-toolbar-block");

        displayLevelDiv.createEl("b", { text: t("To : ") });
        const displayLevel = new DropdownComponent(displayLevelDiv);
        displayLevel
            .addOption("next", t("next"))
            .addOption("end", t("end"))
            .setValue(this.plugin.settings.DisplayLevel)
            .onChange((DisplayLevel) => {
                this.plugin.settings.DisplayLevel = DisplayLevel;
                this.plugin.clearShowingSettings(this.plugin.settings.BranchTab);
                this.app.workspace.trigger("zk-navigation:refresh-index-graph");
            });

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

        const graphTypeDiv = toolbarDiv.createDiv("zk-index-toolbar-block");
        graphTypeDiv.createEl("b", { text: t("style : ") });
        const graphType = new DropdownComponent(graphTypeDiv);
        graphType
            .addOption("structure", t("structure"))
            .addOption("roadmap", t("roadmap"))
            .setValue(this.plugin.settings.graphType)
            .onChange((graphType) => {
                this.plugin.settings.graphType = graphType;
                this.plugin.clearShowingSettings(this.plugin.settings.BranchTab);
                this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                this.app.workspace.trigger("zk-navigation:refresh-local-graph");
            })

        await this.refreshBranchMermaid();
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

        const refresh = debounce(this.refreshIndexLayout, 300, true);
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

        indexMermaidDiv.empty();

        let branchEntranceNodeArr: ZKNode[] = [];
        let indexFile: any;

        const graphTopContainer = indexMermaidDiv.createDiv("zk-graph-top");

        const indexLinkDiv = graphTopContainer.createDiv("zk-index-link");
        indexLinkDiv.empty();

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

            if (this.plugin.settings.exportCanvas == true) {
                const canvasBtn = new ExtraButtonComponent(toolButtonsDiv);
                canvasBtn.setIcon("layout-dashboard").setTooltip(t("export to canvas"));
                canvasBtn.onClick(async () => {
                    if (this.plugin.settings.graphType === "structure") {
                        await this.generateCanvasStr();
                    } else {
                        await this.generateCanvasStrGit();
                    }
                    await this.exportToCanvas();

                })

            }

            if (this.plugin.settings.RandomMainNote == true && this.plugin.settings.MainNoteButton) {

                const randomBtn = new ExtraButtonComponent(toolButtonsDiv);
                randomBtn.setIcon("dice-3").setTooltip(t("random main note"));
                randomBtn.onClick(async () => {

                    let randomMainNoteNode = this.plugin.MainNotes[Math.floor(Math.random() * this.plugin.MainNotes.length)];

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

            if (this.plugin.settings.ListTree == true) {
                const listBtn = new ExtraButtonComponent(toolButtonsDiv);
                listBtn.setIcon("list-tree").setTooltip(t("list tree"))
                listBtn.onClick(async () => {
                    if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                        this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
                        await this.plugin.openOutlineView();
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
                    n.file.path == this.plugin.settings.lastRetrival.filePath)

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

            await this.addBranchIcon(branchEntranceNodeArr, indexLinkDiv);

        }

        if (this.plugin.settings.ListTree === true) {
            if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes;
                this.app.workspace.trigger("zk-navigation:refresh-outline-view");
            }
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
        indexMermaidDiv.empty();

        const graphTopContainer = indexMermaidDiv.createDiv("zk-graph-top");
        const indexLinkDiv = graphTopContainer.createDiv("zk-index-link");
        indexLinkDiv.empty();

        // 添加工具栏
        if (this.plugin.settings.BranchToolbra === true) {
            const toolButtonsDiv = graphTopContainer.createDiv("zk-tool-buttons");
            toolButtonsDiv.empty();

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

            if (this.plugin.settings.exportCanvas === true) {
                const canvasBtn = new ExtraButtonComponent(toolButtonsDiv);
                canvasBtn.setIcon("layout-dashboard").setTooltip(t("export to canvas"));
                canvasBtn.onClick(async () => {
                    await this.generateCanvasStr();
                    await this.exportToCanvas();
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

            if (this.plugin.settings.ListTree === true) {
                const listBtn = new ExtraButtonComponent(toolButtonsDiv);
                listBtn.setIcon("list-tree").setTooltip(t("list tree"));
                listBtn.onClick(async () => {
                    if (this.mocNodes && this.mocNodes.length > 0) {
                        this.plugin.tableArr = this.mocNodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
                        await this.plugin.openOutlineView();
                    }
                });
            }

            // 添加自由节点按钮
            const addNodeBtn = new ExtraButtonComponent(toolButtonsDiv);
            addNodeBtn.setIcon("plus-circle").setTooltip("添加自由节点");
            addNodeBtn.onClick(async () => {
                await this.addFreeNodeToMOC();
            });
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
            indexLinkDiv.createEl('abbr', { text: t("Please configure MOC folder path in settings") });
            return;
        }

        // 获取 MOC 文件
        const mocFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(mocFolder));

        if (mocFiles.length === 0) {
            indexLinkDiv.createEl('abbr', { text: t("No MOC files found in the specified folder") });
            return;
        }

        // 创建 MOC 文件选择器
        indexLinkDiv.createEl('abbr', { text: t("Current MOC: ") });
        const mocSelector = indexLinkDiv.createEl('select', { cls: 'zk-moc-selector' });
        mocSelector.style.marginLeft = '8px';
        mocSelector.style.padding = '4px 8px';
        mocSelector.style.borderRadius = '4px';
        mocSelector.style.border = '1px solid var(--background-modifier-border)';
        mocSelector.style.backgroundColor = 'var(--background-primary)';
        mocSelector.style.color = 'var(--text-normal)';
        mocSelector.style.fontSize = '14px';
        mocSelector.style.minWidth = '120px';

        mocFiles.forEach(file => {
            const option = mocSelector.createEl('option');
            option.value = file.path;
            option.text = file.basename;
            if (this.plugin.settings.mocCurrentFile === file.path) {
                option.selected = true;
            }
        });

        mocSelector.addEventListener('change', async () => {
            this.plugin.settings.mocCurrentFile = mocSelector.value;
            await this.plugin.saveData(this.plugin.settings);
            await this.refreshBranchMermaidMOC(indexMermaidDiv);
        });

        // 解析当前 MOC 文件
        const currentMOCPath = this.plugin.settings.mocCurrentFile || mocFiles[0].path;
        const currentMOCFile = this.app.vault.getAbstractFileByPath(currentMOCPath);

        if (!(currentMOCFile instanceof TFile)) {
            indexLinkDiv.createEl('abbr', { text: "Invalid MOC file" });
            return;
        }

        const mocContent = await this.app.vault.read(currentMOCFile);
        const mocParseResult = await parseMOCStructure(this.app, currentMOCPath, headingTitle);

        // 转换为 ZKNode（即使为空也继续）
        this.mocNodes = mocParseResult.nodes.length > 0 
            ? await convertMOCToZKNodes(this.plugin, mocParseResult.nodes, mocParseResult.reverseRelations, [], mocParseResult.nodePositions)
            : [];
        this.mocReverseRelations = mocParseResult.reverseRelations;

        // 创建图形容器（即使没有节点也创建，以便支持双击添加）
        const branchGraphContainer = indexMermaidDiv.createDiv("zk-branch-graph-container");
        const branchGraphDiv = branchGraphContainer.createEl("div", {
            cls: "zk-graph-cytoscape"
        });
        branchGraphDiv.id = "zk-branch-cytoscape";
        // 为顶部工具栏和底部留出空间
        branchGraphDiv.style.height = `${this.containerEl.offsetHeight - 150}px`;
        branchGraphDiv.style.width = "100%";
        branchGraphDiv.style.marginBottom = "60px"; // 为底部按钮留出空间

        // 如果没有节点，显示提示信息
        if (this.mocNodes.length === 0) {
            const emptyHint = branchGraphContainer.createDiv("zk-empty-hint");
            emptyHint.style.textAlign = "center";
            emptyHint.style.padding = "40px 20px";
            emptyHint.style.color = "var(--text-muted)";
            emptyHint.innerHTML = `
                <div style="font-size: 16px; margin-bottom: 10px;">📝 思维树为空</div>
                <div style="font-size: 14px;">双击空白处或点击右上角按钮创建第一个节点</div>
            `;
        }

        // 构建图形数据（包含分组信息和边弧度信息）
        const groups = mocParseResult.groups || [];
        const edgeCurvatures = mocParseResult.edgeCurvatures || {};
        const graphData = GraphDataBuilder.fromMOCTree(this.mocNodes, this.mocReverseRelations, null, groups, edgeCurvatures);

        // 配置渲染选项
        const options: RenderOptions = {
            direction: (this.plugin.settings.DirectionOfBranchGraph || 'LR') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'dagre',
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title'
        };

        // 创建或复用渲染器
        if (this.branchRenderer) {
            this.branchRenderer.destroy();
        }
        this.branchRenderer = new CytoscapeRenderer();

        // 渲染图形
        await this.branchRenderer.render(branchGraphDiv, graphData, options);

        // 监听节点位置变化事件（拖动后保存到 MOC 文件）
        branchGraphDiv.addEventListener('node-position-changed', async (event: any) => {
            const { node, position } = event.detail;
            
            // 检查节点是否有效
            if (!node || !node.ID) {
                console.warn('Invalid node in position-changed event:', node);
                return;
            }
            
            // 保存位置到 MOC 文件
            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
                    await this.saveNodePositionToMOC(mocFile, node.ID, position);
                }
            } catch (error) {
                console.error('Failed to save node position:', error);
            }
        });

        // 监听边弧度变化事件（拖动控制点后保存到 MOC 文件）
        branchGraphDiv.addEventListener('edge-curvature-changed', async (event: any) => {
            const { edgeId, source, target, distance, weight } = event.detail;
            
            // 保存弧度到 MOC 文件
            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
                    await this.saveEdgeCurvatureToMOC(mocFile, edgeId, { distance, weight });
                }
            } catch (error) {
                console.error('Failed to save edge curvature:', error);
            }
        });

        // 监听分组创建事件
        branchGraphDiv.addEventListener('group-create', async (event: any) => {
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
        branchGraphDiv.addEventListener('group-rename', async (event: any) => {
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

        // 监听分组右键菜单事件
        branchGraphDiv.addEventListener('group-contextmenu', async (event: any) => {
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
        branchGraphDiv.addEventListener('node-click', (event: any) => {
            const { node, ctrlKey, shiftKey } = event.detail;

            // 检查节点是否有效
            if (!node || !node.file) {
                console.warn('Invalid node clicked:', node);
                return;
            }

            if (ctrlKey) {
                // Ctrl + 点击：在新标签页打开
                this.app.workspace.openLinkText("", node.file.path, 'tab');
            } else if (shiftKey) {
                // Shift + 点击：在图形视图中打开
                this.plugin.retrivalforLocaLgraph = {
                    type: '1',
                    ID: node.ID,
                    filePath: node.file.path,
                };
                this.plugin.openGraphView();
            } else {
                // 普通点击：打开文件
                this.app.workspace.openLinkText("", node.file.path);
            }
        });

        // 监听节点悬停事件
        branchGraphDiv.addEventListener('node-hover', (event: any) => {
            const { node, event: mouseEvent } = event.detail;

            // 检查节点是否有效
            if (!node || !node.file) {
                return;
            }

            this.app.workspace.trigger('hover-link', {
                event: mouseEvent,
                source: 'zk-navigation',
                hoverParent: branchGraphDiv,
                linktext: "",
                targetEl: mouseEvent.target,
                sourcePath: node.file.path,
            });
        });

        // 监听节点右键菜单事件
        branchGraphDiv.addEventListener('node-contextmenu', (event: any) => {
            const { node, event: mouseEvent, position } = event.detail;
            
            // 检查节点是否有效
            if (!node || !node.file) {
                console.warn('Invalid node for context menu:', node);
                return;
            }
            
            // 阻止默认右键菜单
            mouseEvent.preventDefault();
            mouseEvent.stopPropagation();
            
            // 创建菜单
            const menu = new Menu();
            
            // 添加子节点选项
            menu.addItem((item) => {
                item.setTitle("➕ 添加子节点")
                    .setIcon("plus-circle")
                    .onClick(async () => {
                        await this.addChildNodeToMOC(node);
                    });
            });
            
            // 添加反向连接选项
            menu.addItem((item) => {
                item.setTitle("🔗 添加反向连接")
                    .setIcon("link")
                    .onClick(async () => {
                        await this.addReverseNodeToMOC(node);
                    });
            });
            
            menu.addSeparator();
            
            // 打开文件选项
            menu.addItem((item) => {
                item.setTitle("📄 打开文件")
                    .setIcon("file")
                    .onClick(() => {
                        this.app.workspace.openLinkText("", node.file.path);
                    });
            });
            
            // 在新标签页打开
            menu.addItem((item) => {
                item.setTitle("🗂️ 在新标签页打开")
                    .setIcon("file-plus")
                    .onClick(() => {
                        this.app.workspace.openLinkText("", node.file.path, 'tab');
                    });
            });
            
            // 显示菜单
            menu.showAtMouseEvent(mouseEvent);
        });

        // 监听背景双击事件（创建自由节点）
        branchGraphDiv.addEventListener('background-dblclick', async (event: any) => {
            const { position } = event.detail;
            console.log('Background double-clicked at:', position);
            
            // 调用添加自由节点方法，传递位置信息
            await this.addFreeNodeToMOC(position);
        });

        // 监听边点击事件
        branchGraphDiv.addEventListener('edge-click', (event: any) => {
            const { edgeId, source, target, type, label } = event.detail;
            console.log('Edge clicked:', { edgeId, source, target, type, label });
            // 可以在这里添加边的高亮或其他交互
        });

        // 监听边右键菜单事件（删除边）
        branchGraphDiv.addEventListener('edge-contextmenu', async (event: any) => {
            const { edgeId, source, target, type, label, position } = event.detail;
            
            // 只允许删除箭头关系（type === 'reverse'），不允许删除父子关系
            if (type !== 'reverse') {
                new Notice('只能删除箭头关系，不能删除父子关系');
                return;
            }
            
            // 创建右键菜单
            const menu = new Menu();
            
            menu.addItem((item) => {
                item.setTitle('删除箭头关系')
                    .setIcon('trash')
                    .onClick(async () => {
                        try {
                            const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                            if (mocFile) {
                                await this.deleteArrowRelationFromMOC(mocFile, source, target);
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
        branchGraphDiv.addEventListener('group-delete-key', async (event: any) => {
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
        branchGraphDiv.addEventListener('edge-delete-key', async (event: any) => {
            const { edgeId, source, target, type, label } = event.detail;
            
            try {
                const mocFile = this.app.vault.getFileByPath(currentMOCPath);
                if (mocFile) {
                    await this.deleteArrowRelationFromMOC(mocFile, source, target);
                    // 刷新视图
                    await this.refreshBranchMermaid();
                }
            } catch (error) {
                console.error('Failed to delete arrow relation:', error);
                new Notice(`删除箭头关系失败: ${error.message}`);
            }
        });

        // 监听边标签编辑事件（双击边）
        branchGraphDiv.addEventListener('edge-label-edit', async (event: any) => {
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
                                this.app.workspace.openLinkText("", node.file.path);
                            }
                        });

                        circleNodes[j].addEventListener("touchend", () => {
                            this.app.workspace.openLinkText("", node.file.path);
                        });

                        circleNodes[j].addEventListener('contextmenu', (event: MouseEvent) => {
                            const menu = new Menu();
                            
                            // 添加"添加子节点"选项
                            menu.addItem((item) =>
                                item
                                    .setTitle("添加子节点")
                                    .setIcon("plus-circle")
                                    .onClick(async () => {
                                        await this.addChildNodeToMOC(node);
                                    })
                            );
                            
                            menu.addSeparator();
                            
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
                                sourcePath: node.file.path,
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
                                this.app.workspace.openLinkText("", node.file.path)
                            }

                        })
                        circleNodes[j].addEventListener("touchend", () => {
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
                                sourcePath: node.file.path,
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

        if (this.plugin.settings.ListTree === true) {
            if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes;
                this.app.workspace.trigger("zk-navigation:refresh-outline-view");
            }
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
                        let nodes = this.plugin.MainNotes.filter(l => l.file.path == branchFile?.path);
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
            // 去掉开头的数字和空格
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

            let positionX: number = (nodes[i].IDArr.length - nodes[0].IDArr.length) * (cardWidth + intervalX);
            let positionY: number = nodes[i].height;
            if (direction === "LR" || direction === "RL") {
                canvasNodeStr = canvasNodeStr + `
                {"id":"${nodes[i].randomId}","x":${positionX},"y":${positionY},"width":${Math.abs(cardWidth)},"height":${Math.abs(cardHeight)},"type":"file","file":"${nodes[i].file.path}"${this.getCanvasCardSetting(nodes[i].file)}},`
            } else {
                canvasNodeStr = canvasNodeStr + `
                {"id":"${nodes[i].randomId}","x":${positionY},"y":${positionX},"width":${Math.abs(cardWidth)},"height":${Math.abs(cardHeight)},"type":"file","file":"${nodes[i].file.path}"${this.getCanvasCardSetting(nodes[i].file)}},`

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
                canvasNodeStr = canvasNodeStr + `
                {"id":"${branch.nodes[i].randomId}","x":${branch.positionX + (cardWidth + intervalX) * i},"y":${(cardHeight + intervalY) * branch.order},"width":${cardWidth},"height":${cardHeight},"type":"file","file":"${branch.nodes[i].file.path}"${this.getCanvasCardSetting(branch.nodes[i].file)}},`
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
            if (target.classList.contains('internal-link')) {
                this.app.workspace.openLinkText("", node.file.path, 'tab');
                event.stopPropagation();
            } else {
                navigator.clipboard.writeText(node.ID);
                new Notice(node.ID + " copied");
            }
        } else if (event.shiftKey) {
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
            this.plugin.retrivalforLocaLgraph = {
                type: '1',
                ID: node.ID,
                filePath: node.file.path,
            };
            this.plugin.openGraphView();
        } else if (target.classList.contains('internal-link')) {
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
                            case 2: copyStr = node.file.path; break;
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
            sourcePath: node.file.path,
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
    openMOCSelector() {
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

        // 在按钮位置显示菜单
        const mocButton = document.querySelector('.zk-index-toolbar-button:last-child');
        if (mocButton) {
            const rect = mocButton.getBoundingClientRect();
            menu.showAtPosition({ x: rect.left, y: rect.bottom });
        } else {
            menu.showAtMouseEvent(new MouseEvent('click'));
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
     * 添加反向连接节点
     */
    async addReverseNodeToMOC(targetNode: ZKNode) {
        // 生成建议的节点 ID（基于目标节点，和正向连接一致）
        const suggestedID = this.generateChildNodeID(targetNode.IDStr);
        
        // 计算默认位置（在目标节点左边）
        const defaultPosition = this.calculateDefaultPosition(targetNode, 'left');
        
        // 打开对话框
        const modal = new AddFreeNodeModal(
            this.app,
            this.plugin,
            this.mocNodes,
            suggestedID,
            async (result) => {
                // 添加反向关系：新节点 -> 目标节点
                result.reverseRelation = {
                    sourceID: result.nodeID,
                    targetID: targetNode.IDStr,
                    relationText: result.connectionRelation || ''
                };
                
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
        
        // 预设连接到目标节点（反向）
        modal.connectToNodeID = targetNode.IDStr;
        modal.nodeID = suggestedID;
        modal.isReverseConnection = true; // 标记为反向连接
        
        modal.onOpen();
        modal.open();
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
        wikiLink: string;
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
    }) {
        const mocFilePath = this.plugin.settings.mocCurrentFile;
        if (!mocFilePath) {
            new Notice("未找到当前 MOC 文件");
            return;
        }
        
        const file = this.app.vault.getFileByPath(mocFilePath);
        if (!file) {
            new Notice("MOC 文件不存在");
            return;
        }
        
        try {
            // 读取文件内容
            let content = await this.app.vault.read(file);
            const lines = content.split('\n');
            
            // 构建新节点的 Markdown
            const nodeID = result.nodeID || this.generateNextFreeNodeID();
            
            // 构建节点行
            let newNodeLine: string;
            
            // 如果有连接关系描述（正向连接的关系），添加到前面
            if (result.connectionRelation) {
                newNodeLine = `- ${result.connectionRelation} [[${result.wikiLink}]] \`${nodeID}\``;
            } else if (result.relationText) {
                // 兼容旧的 relationText 字段
                newNodeLine = `- ${result.relationText} [[${result.wikiLink}]] \`${nodeID}\``;
            } else {
                newNodeLine = `- [[${result.wikiLink}]] \`${nodeID}\``;
            }
            
            // 查找指定的标题
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            let insertIndex = -1;
            let insertParentIndex = -1;
            let foundHeading = false;
            
            // 如果有父节点 ID，尝试查找父节点
            const hasParentNode = result.connectToNodeID && result.connectToNodeID.trim() !== '';
            
            for (let i = 0; i < lines.length; i++) {
                const originLine = lines[i];
                
                // 如果有父节点，查找父节点位置
                if (hasParentNode && originLine.contains('`' + result.connectToNodeID + '`') && originLine.contains('[[')) {
                    insertParentIndex = i + 1;   
                    newNodeLine = (" ".repeat(((originLine.indexOf('-') / 4) + 1) * 4)) + newNodeLine;
                }

                const line = lines[i].trim();

                // 找到目标标题
                if (line === `# ${headingTitle}` || line.startsWith(`# ${headingTitle}`)) {
                    foundHeading = true;
                    insertIndex = i + 1;
                    continue;
                }
                
                // 如果已经找到标题，遇到下一个一级标题就停止
                if (foundHeading && line.startsWith('# ')) {
                    break;
                }
                
                // 如果已经找到标题，更新插入位置到最后一个非空行之后
                if (foundHeading && line.trim() !== '') {
                    insertIndex = i + 1;
                }
            }
            
            if (!foundHeading) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 确定最终插入位置
            let finalInsertIndex: number;
            if (hasParentNode && insertParentIndex !== -1) {
                // 如果找到了父节点，插入到父节点下方
                finalInsertIndex = insertParentIndex;
            } else if (!hasParentNode) {
                // 如果没有父节点（创建初始节点），插入到标题下方
                finalInsertIndex = insertIndex;
            } else {
                // 如果指定了父节点但未找到，提示错误
                new Notice(`未找到父节点: ${result.connectToNodeID}`);
                return;
            }
            
            // 在指定位置插入新节点
            lines.splice(finalInsertIndex, 0, newNodeLine);
            
            // 如果是反向连接，添加箭头语法
            if (result.reverseRelation) {
                const arrowLine = `- \`${result.reverseRelation.sourceID}\` -- ${result.reverseRelation.relationText} --> \`${result.reverseRelation.targetID}\``;
                lines.splice(finalInsertIndex + 1, 0, '', arrowLine);
            }
            
            // 重新组合内容
            content = lines.join('\n');
            
            // 保存文件
            await this.app.vault.modify(file, content);
            
            new Notice(`已添加自由节点: ${nodeID}`);
        } catch (error) {
            console.error("保存自由节点失败:", error);
            new Notice("保存失败，请查看控制台");
        }
    }

    async onClose() {
        this.plugin.saveData(this.plugin.settings);
    }

    /**
     * 保存分组到 MOC 文件
     */
    private async saveGroupToMOC(mocFile: TFile, group: { id: string; label: string; nodeIds: string[]; color?: string }): Promise<void> {
        try {
            // 读取 MOC 文件内容
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            
            // 查找思维树标题的范围
            let headingIndex = -1;
            let sectionEndIndex = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === `# ${headingTitle}`) {
                    headingIndex = i;
                    
                    // 查找下一个一级标题，确定当前标题的范围
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('# ')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }
            
            if (headingIndex === -1) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 查找 ext 行
            let posLineIndex = -1;
            let nodePositions: Record<string, { x: number; y: number }> = {};
            let groups: any[] = [];
            
            for (let i = sectionEndIndex - 1; i > headingIndex; i--) {
                const line = lines[i].trim();
                const match = line.match(/^%%\s*ext:\s*(\{.*\})\s*%%$/);
                if (match) {
                    try {
                        const extData = JSON.parse(match[1]);
                        if (extData.node_positions) {
                            posLineIndex = i;
                            nodePositions = extData.node_positions;
                            groups = extData.groups || [];
                            break;
                        }
                    } catch (e) {
                        console.error('Failed to parse ext data:', e);
                    }
                }
            }
            
            // 添加或更新分组
            const existingGroupIndex = groups.findIndex((g: any) => g.id === group.id);
            if (existingGroupIndex !== -1) {
                groups[existingGroupIndex] = group;
            } else {
                groups.push(group);
            }
            
            // 构建新的 ext 行
            const extData: any = { node_positions: nodePositions, groups };
            const newPosLine = `%% ext:${JSON.stringify(extData)} %%`;
            
            // 重新构建文件内容
            let newLines: string[];
            
            if (posLineIndex !== -1) {
                // 替换现有的 ext 行
                newLines = [
                    ...lines.slice(0, posLineIndex),
                    newPosLine,
                    ...lines.slice(posLineIndex + 1)
                ];
            } else {
                // 在标题范围末尾插入新的 ext 行
                let lastContentIndex = sectionEndIndex - 1;
                while (lastContentIndex > headingIndex && lines[lastContentIndex].trim() === '') {
                    lastContentIndex--;
                }
                
                newLines = [
                    ...lines.slice(0, lastContentIndex + 1),
                    '',
                    newPosLine,
                    ...lines.slice(sectionEndIndex)
                ];
            }
            
            const newContent = newLines.join('\n');
            
            // 写回文件
            await this.app.vault.modify(mocFile, newContent);
            
            new Notice(`已创建分组: ${group.label}`);
            console.log(`Saved group:`, group);
        } catch (error) {
            console.error('Failed to save group:', error);
            new Notice(`保存分组失败: ${error.message}`);
        }
    }

    /**
     * 重命名 MOC 文件中的分组
     */
    private async renameGroupInMOC(mocFile: TFile, groupId: string, newLabel: string): Promise<void> {
        try {
            // 读取 MOC 文件内容
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            
            // 查找思维树标题的范围
            let headingIndex = -1;
            let sectionEndIndex = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === `# ${headingTitle}`) {
                    headingIndex = i;
                    
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('# ')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }
            
            if (headingIndex === -1) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 查找 ext 行
            let posLineIndex = -1;
            let nodePositions: Record<string, { x: number; y: number }> = {};
            let groups: any[] = [];
            
            for (let i = sectionEndIndex - 1; i > headingIndex; i--) {
                const line = lines[i].trim();
                const match = line.match(/^%%\s*ext:\s*(\{.*\})\s*%%$/);
                if (match) {
                    try {
                        const extData = JSON.parse(match[1]);
                        if (extData.node_positions) {
                            posLineIndex = i;
                            nodePositions = extData.node_positions;
                            groups = extData.groups || [];
                            break;
                        }
                    } catch (e) {
                        console.error('Failed to parse ext data:', e);
                    }
                }
            }
            
            // 查找并更新分组
            const groupIndex = groups.findIndex((g: any) => g.id === groupId);
            if (groupIndex === -1) {
                new Notice(`未找到分组: ${groupId}`);
                return;
            }
            
            const oldLabel = groups[groupIndex].label;
            groups[groupIndex].label = newLabel;
            
            // 构建新的 ext 行
            const extData: any = { node_positions: nodePositions, groups };
            const newPosLine = `%% ext:${JSON.stringify(extData)} %%`;
            
            // 重新构建文件内容
            const newLines = [
                ...lines.slice(0, posLineIndex),
                newPosLine,
                ...lines.slice(posLineIndex + 1)
            ];
            
            const newContent = newLines.join('\n');
            
            // 写回文件
            await this.app.vault.modify(mocFile, newContent);
            
            
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
            // 读取 MOC 文件内容
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            
            // 查找思维树标题的范围
            let headingIndex = -1;
            let sectionEndIndex = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === `# ${headingTitle}`) {
                    headingIndex = i;
                    
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('# ')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }
            
            if (headingIndex === -1) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 查找 ext 行
            let posLineIndex = -1;
            let nodePositions: Record<string, { x: number; y: number }> = {};
            let groups: any[] = [];
            
            for (let i = sectionEndIndex - 1; i > headingIndex; i--) {
                const line = lines[i].trim();
                const match = line.match(/^%%\s*ext:\s*(\{.*\})\s*%%$/);
                if (match) {
                    try {
                        const extData = JSON.parse(match[1]);
                        if (extData.node_positions) {
                            posLineIndex = i;
                            nodePositions = extData.node_positions;
                            groups = extData.groups || [];
                            break;
                        }
                    } catch (e) {
                        console.error('Failed to parse ext data:', e);
                    }
                }
            }
            
            // 查找并删除分组
            const groupIndex = groups.findIndex((g: any) => g.id === groupId);
            if (groupIndex === -1) {
                new Notice(`未找到分组: ${groupId}`);
                return;
            }
            
            const deletedGroup = groups[groupIndex];
            groups.splice(groupIndex, 1);
            
            // 构建新的 ext 行
            const extData: any = { node_positions: nodePositions, groups };
            const newPosLine = `%% ext:${JSON.stringify(extData)} %%`;
            
            // 重新构建文件内容
            const newLines = [
                ...lines.slice(0, posLineIndex),
                newPosLine,
                ...lines.slice(posLineIndex + 1)
            ];
            
            const newContent = newLines.join('\n');
            
            // 写回文件
            await this.app.vault.modify(mocFile, newContent);
            
            new Notice(`已删除分组: ${deletedGroup.label}`);
            console.log(`Deleted group:`, deletedGroup);
        } catch (error) {
            console.error('Failed to delete group:', error);
            new Notice(`删除分组失败: ${error.message}`);
        }
    }

    /**
     * 从 MOC 文件中删除箭头关系
     */
    private async deleteArrowRelationFromMOC(mocFile: TFile, sourceID: string, targetID: string): Promise<void> {
        try {
            // 读取 MOC 文件内容
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            
            // 查找思维树标题的范围
            let headingIndex = -1;
            let sectionEndIndex = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === `# ${headingTitle}`) {
                    headingIndex = i;
                    
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('# ')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }
            
            if (headingIndex === -1) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 查找并删除箭头关系行
            // 箭头关系格式：`sourceID` -- label --> `targetID` 或 `sourceID` --> `targetID`
            let arrowLineIndex = -1;
            const arrowPattern = new RegExp(`\`${sourceID}\`\\s*--.*?-->\\s*\`${targetID}\``);
            
            for (let i = headingIndex + 1; i < sectionEndIndex; i++) {
                const line = lines[i];
                if (arrowPattern.test(line)) {
                    arrowLineIndex = i;
                    break;
                }
            }
            
            if (arrowLineIndex === -1) {
                new Notice(`未找到箭头关系: ${sourceID} --> ${targetID}`);
                return;
            }
            
            // 删除该行
            const newLines = [
                ...lines.slice(0, arrowLineIndex),
                ...lines.slice(arrowLineIndex + 1)
            ];
            
            const newContent = newLines.join('\n');
            
            // 写回文件
            await this.app.vault.modify(mocFile, newContent);
            
            new Notice(`已删除箭头关系: ${sourceID} → ${targetID}`);
            console.log(`Deleted arrow relation: ${sourceID} --> ${targetID}`);
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
            // 读取 MOC 文件内容
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            
            // 查找思维树标题的范围
            let headingIndex = -1;
            let sectionEndIndex = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === `# ${headingTitle}`) {
                    headingIndex = i;
                    
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('# ')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }
            
            if (headingIndex === -1) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 查找箭头关系行
            // 箭头关系格式：`sourceID` -- label --> `targetID` 或 `sourceID` --> `targetID`
            let arrowLineIndex = -1;
            const arrowPattern = new RegExp(`\`${sourceID}\`\\s*--.*?-->\\s*\`${targetID}\``);
            
            for (let i = headingIndex + 1; i < sectionEndIndex; i++) {
                const line = lines[i];
                if (arrowPattern.test(line)) {
                    arrowLineIndex = i;
                    break;
                }
            }
            
            if (arrowLineIndex === -1) {
                new Notice(`未找到箭头关系: ${sourceID} --> ${targetID}`);
                return;
            }
            
            // 构建新的箭头关系行
            const oldLine = lines[arrowLineIndex];
            const indentMatch = oldLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1] : '';
            
            let newLine: string;
            if (newLabel) {
                // 有标签：`sourceID` -- label --> `targetID`
                newLine = `${indent}\`${sourceID}\` -- ${newLabel} --> \`${targetID}\``;
            } else {
                // 无标签：`sourceID` --> `targetID`
                newLine = `${indent}\`${sourceID}\` --> \`${targetID}\``;
            }
            
            // 替换该行
            const newLines = [
                ...lines.slice(0, arrowLineIndex),
                newLine,
                ...lines.slice(arrowLineIndex + 1)
            ];
            
            const newContent = newLines.join('\n');
            
            // 写回文件
            await this.app.vault.modify(mocFile, newContent);
            
            new Notice(`已更新关系文本: ${sourceID} → ${targetID}`);
            console.log(`Updated arrow relation label: ${sourceID} -- ${newLabel} --> ${targetID}`);
        } catch (error) {
            console.error('Failed to update arrow relation label:', error);
            new Notice(`更新关系文本失败: ${error.message}`);
        }
    }

    /**
     * 保存节点位置到 MOC 文件的思维树标题末尾
     */
    private async saveNodePositionToMOC(mocFile: TFile, nodeID: string, position: { x: number; y: number }): Promise<void> {
        try {
            // 读取 MOC 文件内容
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            
            // 查找思维树标题的范围
            let headingIndex = -1;
            let sectionEndIndex = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === `# ${headingTitle}`) {
                    headingIndex = i;
                    
                    // 查找下一个一级标题，确定当前标题的范围
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('# ')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }
            
            if (headingIndex === -1) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 查找位置行（新格式：%% ext:{"node_positions":{...},"groups":[...]} %%）
            let posLineIndex = -1;
            let nodePositions: Record<string, { x: number; y: number }> = {};
            let groups: any[] = [];
            
            // 从后往前查找位置行
            for (let i = sectionEndIndex - 1; i > headingIndex; i--) {
                const line = lines[i].trim();
                const match = line.match(/^%%\s*ext:\s*(\{.*\})\s*%%$/);
                if (match) {
                    try {
                        const extData = JSON.parse(match[1]);
                        if (extData.node_positions) {
                            posLineIndex = i;
                            nodePositions = extData.node_positions;
                            groups = extData.groups || [];
                            break;
                        }
                    } catch (e) {
                        console.error('Failed to parse node_positions:', e);
                    }
                }
            }
            
            // 更新或添加当前节点的位置
            nodePositions[nodeID] = {
                x: Math.round(position.x * 100) / 100, // 保留两位小数
                y: Math.round(position.y * 100) / 100
            };
            
            // 构建新的位置行（包含分组信息）
            const extData: any = { node_positions: nodePositions };
            if (groups.length > 0) {
                extData.groups = groups;
            }
            const newPosLine = `%% ext:${JSON.stringify(extData)} %%`;
            
            // 重新构建文件内容
            let newLines: string[];
            
            if (posLineIndex !== -1) {
                // 替换现有的位置行
                newLines = [
                    ...lines.slice(0, posLineIndex),
                    newPosLine,
                    ...lines.slice(posLineIndex + 1)
                ];
            } else {
                // 在标题范围末尾插入新的位置行
                // 找到最后一个非空行
                let lastContentIndex = sectionEndIndex - 1;
                while (lastContentIndex > headingIndex && lines[lastContentIndex].trim() === '') {
                    lastContentIndex--;
                }
                
                newLines = [
                    ...lines.slice(0, lastContentIndex + 1),
                    '',
                    newPosLine,
                    ...lines.slice(sectionEndIndex)
                ];
            }
            
            const newContent = newLines.join('\n');
            
            // 写回文件
            await this.app.vault.modify(mocFile, newContent);
            
            console.log(`Saved position for node ${nodeID}:`, position);
        } catch (error) {
            console.error('Failed to save node position:', error);
            new Notice(`保存节点位置失败: ${error.message}`);
        }
    }

    /**
     * 保存边弧度到 MOC 文件
     */
    private async saveEdgeCurvatureToMOC(mocFile: TFile, edgeId: string, curvature: { distance: number; weight: number }): Promise<void> {
        try {
            // 读取 MOC 文件内容
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;
            
            // 查找思维树标题的范围
            let headingIndex = -1;
            let sectionEndIndex = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === `# ${headingTitle}`) {
                    headingIndex = i;
                    
                    // 查找下一个一级标题，确定当前标题的范围
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('# ')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }
            
            if (headingIndex === -1) {
                new Notice(`未找到标题: # ${headingTitle}`);
                return;
            }
            
            // 查找 ext 行
            let posLineIndex = -1;
            let nodePositions: Record<string, { x: number; y: number }> = {};
            let groups: any[] = [];
            let edgeCurvatures: Record<string, { distance: number; weight: number }> = {};
            
            // 从后往前查找 ext 行
            for (let i = sectionEndIndex - 1; i > headingIndex; i--) {
                const line = lines[i].trim();
                const match = line.match(/^%%\s*ext:\s*(\{.*\})\s*%%$/);
                if (match) {
                    try {
                        const extData = JSON.parse(match[1]);
                        posLineIndex = i;
                        nodePositions = extData.node_positions || {};
                        groups = extData.groups || [];
                        edgeCurvatures = extData.edge_curvatures || {};
                        break;
                    } catch (e) {
                        console.error('Failed to parse ext data:', e);
                    }
                }
            }
            
            // 更新或添加当前边的弧度
            edgeCurvatures[edgeId] = {
                distance: Math.round(curvature.distance * 100) / 100, // 保留两位小数
                weight: Math.round(curvature.weight * 100) / 100
            };
            
            // 构建新的 ext 行
            const extData: any = { node_positions: nodePositions, edge_curvatures: edgeCurvatures };
            if (groups.length > 0) {
                extData.groups = groups;
            }
            const newPosLine = `%% ext:${JSON.stringify(extData)} %%`;
            
            // 重新构建文件内容
            let newLines: string[];
            
            if (posLineIndex !== -1) {
                // 替换现有的 ext 行
                newLines = [
                    ...lines.slice(0, posLineIndex),
                    newPosLine,
                    ...lines.slice(posLineIndex + 1)
                ];
            } else {
                // 在标题范围末尾插入新的 ext 行
                let lastContentIndex = sectionEndIndex - 1;
                while (lastContentIndex > headingIndex && lines[lastContentIndex].trim() === '') {
                    lastContentIndex--;
                }
                
                newLines = [
                    ...lines.slice(0, lastContentIndex + 1),
                    '',
                    newPosLine,
                    ...lines.slice(sectionEndIndex)
                ];
            }
            
            const newContent = newLines.join('\n');
            
            // 写回文件
            await this.app.vault.modify(mocFile, newContent);
            
            console.log(`Saved curvature for edge ${edgeId}:`, curvature);
        } catch (error) {
            console.error('Failed to save edge curvature:', error);
            new Notice(`保存边弧度失败: ${error.message}`);
        }
    }
}