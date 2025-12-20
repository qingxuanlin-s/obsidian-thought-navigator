import ZKNavigationPlugin, { FoldNode, Retrival } from "main";
import { ButtonComponent, DropdownComponent, ExtraButtonComponent, HeadingCache, ItemView, Menu, Notice, TFile, WorkspaceLeaf, debounce, moment, setTooltip } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { mainNoteFuzzyModal, mainNoteModal } from "src/modal/mainNoteModal";
import { tableModal } from "src/modal/tableModal";
import { addSvgPanZoom, convertMOCToZKNodes, displayWidth, mainNoteInit, MOCTreeNode, parseMOCStructure, random } from "src/utils/utils";

export const ZK_INDEX_TYPE: string = "zk-index-type";
export const ZK_INDEX_VIEW: string = t("zk-index-graph");
export const ZK_NAVIGATION: string = "zk-navigation";

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

    // 性能优化：节点位置缓存 Map，O(1) 查找替代 O(n) filter
    nodePositionMap: Map<number, ZKNode> = new Map();

    // 防抖：避免折叠时频繁重新渲染
    private foldRefreshTimeout: NodeJS.Timeout | null = null;

    // MOC 模式相关属性
    mocNodes: ZKNode[] = [];                    // MOC 解析后的节点
    mocTreeStructure: MOCTreeNode[] = [];       // MOC 原始树结构

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

        this.registerEvent(this.app.metadataCache.on("changed", async () => {
            this.plugin.RefreshIndexViewFlag = true;
        }));

        this.registerEvent(this.app.metadataCache.on("deleted", async () => {
            this.plugin.RefreshIndexViewFlag = true;
        }));

        const refresh = debounce(this.refreshIndexLayout, 300, true);
        this.registerEvent(this.app.workspace.on("zk-navigation:refresh-index-graph", refresh));
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
                        this.plugin.settings.FoldNodeArr = [];
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
                    if (this.plugin.settings.graphType === "structure") {
                        await this.generateCanvasStr();
                    } else {
                        await this.generateCanvasStrGit();
                    }
                    await this.exportToCanvas();
                });
            }

            if (this.plugin.settings.TableView === true) {
                const tableBtn = new ExtraButtonComponent(toolButtonsDiv);
                tableBtn.setIcon("table").setTooltip(t("table view"));
                tableBtn.onClick(async () => {
                    if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                        this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
                        await this.plugin.openTableView();
                        this.plugin.clearShowingSettings(this.plugin.settings.BranchTab);
                    }
                });
            }

            if (this.plugin.settings.ListTree === true) {
                const listBtn = new ExtraButtonComponent(toolButtonsDiv);
                listBtn.setIcon("list-tree").setTooltip(t("list tree"));
                listBtn.onClick(async () => {
                    if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                        this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes.sort((a, b) => a.IDStr.localeCompare(b.IDStr));
                        await this.plugin.openOutlineView();
                    }
                });
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
                    });

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
                    });

                const playBtn = new ExtraButtonComponent(playControllerDiv);
                playBtn.setIcon("wand-2").setTooltip(t("growing animation"));
                playBtn.onClick(async () => {
                    if (this.plugin.settings.graphType === "structure") {
                        this.plugin.settings.FoldNodeArr = [];
                        await this.branchGrowing();
                    } else {
                        await this.branchGrowingGit();
                    }
                });
            }
        }

        // 获取 MOC 文件夹中的所有文件
        const mocFolder = this.plugin.settings.mocFolderPath;
        const headingTitle = this.plugin.settings.mocHeadingTitle;

        if (!mocFolder) {
            indexLinkDiv.createEl('abbr', { text: t("Please configure MOC folder path in settings") });
            return;
        }

        // 获取当前选中的 MOC 文件或使用配置的文件
        let mocFilePath = this.plugin.settings.mocCurrentFile;

        // 如果没有选中的文件，尝试从文件夹获取第一个
        if (!mocFilePath) {
            const mocFiles = this.app.vault.getMarkdownFiles()
                .filter(f => f.path.startsWith(mocFolder + '/'));
            if (mocFiles.length > 0) {
                mocFilePath = mocFiles[0].path;
                this.plugin.settings.mocCurrentFile = mocFilePath;
            }
        }

        if (!mocFilePath) {
            indexLinkDiv.createEl('abbr', { text: t("No MOC files found in the specified folder") });
            return;
        }

        // 解析 MOC 笔记结构
        this.mocTreeStructure = await parseMOCStructure(this.app, mocFilePath, headingTitle);
        if (this.mocTreeStructure.length === 0) {
            indexLinkDiv.createEl('abbr', { text: `${t("No tree structure found under heading:")} # ${headingTitle}` });
            return;
        }

        // 转换为 ZKNode 数组
        this.mocNodes = await convertMOCToZKNodes(this.plugin, this.mocTreeStructure);
        
        // 调试信息
        console.log("MOC Tree Structure:", this.mocTreeStructure);
        console.log("Converted MOC Nodes:", this.mocNodes);
        console.log("MOC Nodes IDStr mapping:", this.mocNodes.map(n => ({ id: n.ID, idStr: n.IDStr, isRoot: n.isRoot })));

        // 将 MOC 节点保存到本地变量，不要替换 MainNotes
        // MainNotes 应该保持原有的 Zettelkasten 笔记系统

        // 显示当前 MOC 文件链接
        const mocFile = this.app.vault.getFileByPath(mocFilePath);
        indexLinkDiv.createEl('abbr', { text: t("Current MOC: ") });

        if (mocFile instanceof TFile) {
            const link = indexLinkDiv.createEl('a', { text: `【${mocFile.basename} - ${headingTitle}】` });
            link.addEventListener("click", (event: MouseEvent) => {
                if (event.ctrlKey) {
                    this.app.workspace.openLinkText("", mocFile.path, 'tab');
                } else {
                    this.app.workspace.openLinkText("", mocFile.path);
                }
            });
            link.addEventListener(`mouseover`, (event: MouseEvent) => {
                this.app.workspace.trigger(`hover-link`, {
                    event,
                    source: ZK_NAVIGATION,
                    hoverParent: link,
                    linktext: "",
                    targetEl: link,
                    sourcePath: mocFile.path,
                });
            });
        }

        // 添加 MOC 文件选择器（如果文件夹中有多个文件）
        const mocFiles = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(mocFolder + '/'));

        if (mocFiles.length > 1) {
            indexLinkDiv.createEl('small', { text: ` >> ` });
            for (let i = 0; i < mocFiles.length; i++) {
                const file = mocFiles[i];
                const fileTab = indexLinkDiv.createEl('span').createEl('a', {
                    text: `📄${i + 1} `,
                    cls: "zk-branch-tab"
                });
                setTooltip(fileTab, file.basename);

                if (file.path === mocFilePath) {
                    fileTab.addClass("zk-branch-tab-select");
                }

                fileTab.addEventListener("click", async () => {
                    this.plugin.settings.mocCurrentFile = file.path;
                    this.plugin.settings.BranchTab = 0;
                    this.renderedBranches.clear();
                    await this.refreshBranchMermaid();
                });
            }
        }

        // 构建分支入口节点（MOC 模式下的特殊处理）
        let branchEntranceNodeArr: ZKNode[] = [];
        
        // 检查当前活动文件是否在MOC节点中
        const activeFile = this.app.workspace.getActiveFile();
        let currentActiveNode: ZKNode | null = null;
        
        if (activeFile) {
            currentActiveNode = this.mocNodes.find(n => n.file.path === activeFile.path) || null;
        }
        
        if (currentActiveNode) {
            // 如果当前活动文件对应一个MOC节点，显示以它为根的子树
            console.log("Found active node:", currentActiveNode);
            branchEntranceNodeArr = [currentActiveNode];
        } else {
            // 否则显示所有根节点
            branchEntranceNodeArr = this.mocNodes.filter(n => n.isRoot);
        }

        if (branchEntranceNodeArr.length > 0) {
            // 保存分支入口节点和容器引用，用于按需渲染
            this.branchEntranceNodes = branchEntranceNodeArr;
            this.indexMermaidContainer = indexMermaidDiv;
            this.renderedBranches.clear();

            switch (this.plugin.settings.graphType) {
                case "structure":
                    await this.generateFlowchartMOC(branchEntranceNodeArr, indexMermaidDiv, 0);
                    break;
                case "roadmap":
                    await this.generateGitgraphMOC(branchEntranceNodeArr, indexMermaidDiv, 0);
                    break;
                default:
                // do nothing
            }

            // 添加分支图标（如果有多个根节点）
            await this.addBranchIcon(branchEntranceNodeArr, indexLinkDiv);
        }

        if (this.plugin.settings.ListTree === true) {
            if (this.branchAllNodes && this.branchAllNodes[this.plugin.settings.BranchTab]) {
                this.plugin.tableArr = this.branchAllNodes[this.plugin.settings.BranchTab].branchNodes;
                this.app.workspace.trigger("zk-navigation:refresh-outline-view");
            }
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
            
            // 调试信息
            console.log(`Branch ${i} - Entrance Node:`, entranceNode);
            console.log(`Branch ${i} - Filtered Nodes:`, branchNodes);
            console.log(`Branch ${i} - All MOC Nodes:`, this.mocNodes);

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

            const mermaidStr = await this.generateFlowchartStr(branchNodes, entranceNode, this.plugin.settings.DirectionOfBranchGraph);
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

                        if (this.plugin.settings.displayTimeToggle === true) {
                            const nodePosStr = nodeGArr[j].id.split('-')[1];
                            const node = this.nodePositionMap.get(Number(nodePosStr));
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

                // 处理折叠节点
                for (let foldNode of this.plugin.settings.FoldNodeArr.filter(n => n.graphID == zkGraph.id)) {
                    const hideNodes = this.mocNodes.filter(n =>
                        n.IDStr.startsWith(foldNode.nodeIDstr) && (n.IDStr !== foldNode.nodeIDstr)
                    );

                    for (let hideNode of hideNodes) {
                        const hideNodeGArr = indexMermaid.querySelectorAll(`[id^='flowchart-${hideNode.position}']`);
                        hideNodeGArr.forEach((item) => {
                            item.setAttr("style", "display:none");
                        });

                        const hideLines = indexMermaid.querySelectorAll(`[id^='L_${hideNode.position}']`);
                        hideLines.forEach((item) => {
                            item.setAttr("style", "display:none");
                        });
                    }

                    const hideLines = indexMermaid.querySelectorAll(`[id^='L_${foldNode.position}']`);
                    hideLines.forEach((item) => {
                        item.setAttr("style", "display:none");
                    });
                }

                if (this.plugin.settings.FoldToggle === true) {
                    await this.addFoldIconMOC(indexMermaid);
                }
            }

            this.renderedBranches.add(i);
        }
    }

    // MOC 模式专用的层级列表渲染
    async generateHierarchicalListMOC(indexMermaidDiv: HTMLElement) {
        console.log("generateHierarchicalListMOC called, mocTreeStructure length:", this.mocTreeStructure?.length);

        // 检查是否有树结构
        if (!this.mocTreeStructure || this.mocTreeStructure.length === 0) {
            console.warn("MOC tree structure is empty");
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
                text: node.displayText,
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
        console.log("Rendering root nodes, count:", this.mocTreeStructure.length);
        let renderedCount = 0;
        for (const rootNode of this.mocTreeStructure) {
            renderTreeNode(rootNode, listContainer, 0);
            renderedCount++;
        }
        console.log("Rendered", renderedCount, "root nodes");

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

    // MOC 模式专用的折叠图标添加
    async addFoldIconMOC(indexMermaid: HTMLElement) {
        const rects = indexMermaid.getElementsByTagName('rect');
        let rectArr: SVGRectElement[] = [];
        Array.from(rects).forEach(item => {
            if (item.classList.contains("label-container")) {
                rectArr.push(item);
            }
        });

        rectArr.forEach(item => {
            const circleX = Number(item.getAttr("x")) + Number(item.getAttr("width"));
            const circleY = Number(item.getAttr("y")) + Number(item.getAttr("height")) / 2;
            const newCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            newCircle.setAttr('cx', circleX);
            newCircle.setAttr('cy', circleY);
            newCircle.setAttr('r', 8);

            if (item.parentElement) {
                const nodePosStr = item.parentElement.id.split('-')[1];
                const node = this.mocNodes.filter(n => n.position == Number(nodePosStr))[0];

                if (!node) return;

                if (this.plugin.settings.FoldNodeArr.filter(n =>
                    (n.nodeIDstr == node.IDStr) && (n.graphID == indexMermaid.id)).length === 0) {
                    newCircle.addClass('zk-fold-yellow');
                } else {
                    newCircle.addClass('zk-fold-green');
                }

                item.parentElement.insertAfter(newCircle, item.nextSibling);

                newCircle.addEventListener("click", async (event) => {
                    const clickNode: FoldNode = {
                        graphID: indexMermaid.id,
                        nodeIDstr: node.IDStr,
                        position: node.position,
                    };

                    if (this.plugin.settings.FoldNodeArr.filter(n =>
                        (n.nodeIDstr == node.IDStr) && (n.graphID == indexMermaid.id)).length === 0) {
                        this.plugin.settings.FoldNodeArr.push(clickNode);
                    } else {
                        const index = this.plugin.settings.FoldNodeArr.findIndex(
                            item => (item.graphID === clickNode.graphID) && (item.nodeIDstr === clickNode.nodeIDstr));
                        if (index !== -1) {
                            this.plugin.settings.FoldNodeArr.splice(index, 1);
                        }
                    }

                    if (event.ctrlKey && newCircle.hasClass('zk-fold-green')) {
                        this.plugin.settings.FoldNodeArr = this.plugin.settings.FoldNodeArr.filter(
                            n => !(n.nodeIDstr.startsWith(clickNode.nodeIDstr) && (n.graphID == clickNode.graphID))
                        );
                    }
                    event.stopPropagation();

                    if (this.foldRefreshTimeout) {
                        clearTimeout(this.foldRefreshTimeout);
                    }
                    this.foldRefreshTimeout = setTimeout(async () => {
                        await this.refreshBranchMermaid();
                        this.foldRefreshTimeout = null;
                    }, 300);
                });

                newCircle.addEventListener("touchend", async (event) => {
                    const clickNode: FoldNode = {
                        graphID: indexMermaid.id,
                        nodeIDstr: node.IDStr,
                        position: node.position,
                    };

                    if (this.plugin.settings.FoldNodeArr.filter(n =>
                        (n.nodeIDstr == node.IDStr) && (n.graphID == indexMermaid.id)).length === 0) {
                        this.plugin.settings.FoldNodeArr.push(clickNode);
                    } else {
                        const index = this.plugin.settings.FoldNodeArr.findIndex(
                            item => (item.graphID === clickNode.graphID) && (item.nodeIDstr === clickNode.nodeIDstr));
                        if (index !== -1) {
                            this.plugin.settings.FoldNodeArr.splice(index, 1);
                        }
                    }

                    event.stopPropagation();

                    if (this.foldRefreshTimeout) {
                        clearTimeout(this.foldRefreshTimeout);
                    }
                    this.foldRefreshTimeout = setTimeout(async () => {
                        await this.refreshBranchMermaid();
                        this.foldRefreshTimeout = null;
                    }, 300);
                });
            }
        });
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
                for (let foldNode of this.plugin.settings.FoldNodeArr.filter(n => n.graphID == zkGraph.id)) {

                    let hideNodes = this.plugin.MainNotes.filter(n =>
                        n.IDStr.startsWith(foldNode.nodeIDstr) && (n.IDStr !== foldNode.nodeIDstr)
                    );

                    for (let hideNode of hideNodes) {
                        let hideNodeGArr = indexMermaid.querySelectorAll(`[id^='flowchart-${hideNode.position}']`);

                        hideNodeGArr.forEach((item) => {
                            item.setAttr("style", "display:none");
                        })

                        let hideLines = indexMermaid.querySelectorAll(`[id^='L_${hideNode.position}']`);

                        hideLines.forEach((item) => {
                            item.setAttr("style", "display:none");
                        })
                    }

                    let hideLines = indexMermaid.querySelectorAll(`[id^='L_${foldNode.position}']`);
                    hideLines.forEach((item) => {
                        item.setAttr("style", "display:none");
                    })

                }
                if (this.plugin.settings.FoldToggle == true) {
                    await this.addFoldIcon(indexMermaid);
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

    async generateFlowchartStr(Nodes: ZKNode[], entranceNode: ZKNode, direction: string) {

        let mermaidStr: string = `%%{ init: { 'flowchart': { 'curve': 'base', 'wrappingWidth': '3000' },
        'themeVariables':{ 'fontSize': '12px'}}}%% flowchart ${direction};\n`;

        for (let node of Nodes) {

            let nodeText = this.escapeMermaidText(node.displayText);
            let fixWidth = node.fixWidth;

            if (this.plugin.settings.siblingLenToggle === true && node.fixWidth > 0) {
                mermaidStr = mermaidStr + `${node.position}("<p style='width:${fixWidth}px;'>${nodeText}</p>");\n`;
            } else {
                mermaidStr = mermaidStr + `${node.position}("${nodeText}");`;
            }

            if (node.IDStr.startsWith(entranceNode.IDStr)) {
                mermaidStr = mermaidStr + `style ${node.position} fill:${this.plugin.settings.nodeColor},stroke:#333,stroke-width:1px \n`;
            } else {
                mermaidStr = mermaidStr + `style ${node.position} fill:#fff; \n`;
            }

        }

        for (let node of Nodes) {

            // 基于节点ID的层级关系查找直接子节点
            let sonNodes = Nodes.filter(n => {
                if (!n.IDStr || !node.IDStr) return false;

                // 检查是否是直接子节点
                const nodeIdParts = node.IDStr.split('.');
                const childIdParts = n.IDStr.split('.');

                // 子节点的层级应该比父节点多1
                if (childIdParts.length !== nodeIdParts.length + 1) return false;

                // 子节点的ID应该以父节点ID开头
                return n.IDStr.startsWith(node.IDStr + '.');
            });
            
            // 调试信息
            if (sonNodes.length > 0) {
                console.log(`Node ${node.IDStr} has children:`, sonNodes.map(s => s.IDStr));
            }

            for (let son of sonNodes) {

                mermaidStr = mermaidStr + `${node.position} --> ${son.position};\n`;

            }
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

    async addFoldIcon(indexMermaid: HTMLElement) {
        const rects = indexMermaid.getElementsByTagName('rect');
        let rectArr: SVGRectElement[] = [];
        Array.from(rects).forEach(item => {
            if (item.classList.contains("label-container")) {
                rectArr.push(item)
            }
        })

        rectArr.forEach(item => {
            const circleX = Number(item.getAttr("x")) + Number(item.getAttr("width"));
            const circleY = Number(item.getAttr("y")) + Number(item.getAttr("height")) / 2;
            const newCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            newCircle.setAttr('cx', circleX);
            newCircle.setAttr('cy', circleY);
            newCircle.setAttr('r', 8);

            if (item.parentElement) {

                let nodePosStr = item.parentElement.id.split('-')[1];
                let node = this.plugin.MainNotes.filter(n => n.position == Number(nodePosStr))[0];

                if (this.plugin.settings.FoldNodeArr.filter(n =>
                    (n.nodeIDstr == node.IDStr) && (n.graphID == indexMermaid.id)).length === 0) {
                    newCircle.addClass('zk-fold-yellow');
                } else {
                    newCircle.addClass('zk-fold-green');
                }

                item.parentElement.insertAfter(newCircle, item.nextSibling);

                newCircle.addEventListener("click", async (event) => {

                    const clickNode: FoldNode = {
                        graphID: indexMermaid.id,
                        nodeIDstr: node.IDStr,
                        position: node.position,
                    };

                    if (this.plugin.settings.FoldNodeArr.filter(n =>
                        (n.nodeIDstr == node.IDStr) && (n.graphID == indexMermaid.id)).length === 0) {
                        this.plugin.settings.FoldNodeArr.push(clickNode);
                    } else {
                        let index = this.plugin.settings.FoldNodeArr.findIndex(
                            item => (item.graphID === clickNode.graphID) && (item.nodeIDstr === clickNode.nodeIDstr));
                        if (index !== -1) {
                            this.plugin.settings.FoldNodeArr.splice(index, 1);
                        }
                    }

                    if (event.ctrlKey && newCircle.hasClass('zk-fold-green')) {

                        this.plugin.settings.FoldNodeArr = this.plugin.settings.FoldNodeArr.filter(
                            n => !(n.nodeIDstr.startsWith(clickNode.nodeIDstr) && (n.graphID == clickNode.graphID))
                        )
                    }
                    event.stopPropagation();

                    // 性能优化：使用防抖，避免连续点击时多次重新渲染
                    if (this.foldRefreshTimeout) {
                        clearTimeout(this.foldRefreshTimeout);
                    }
                    this.foldRefreshTimeout = setTimeout(async () => {
                        await this.refreshBranchMermaid();
                        this.foldRefreshTimeout = null;
                    }, 300);
                })

                newCircle.addEventListener("touchend", async (event) => {

                    const clickNode: FoldNode = {
                        graphID: indexMermaid.id,
                        nodeIDstr: node.IDStr,
                        position: node.position,
                    };

                    if (this.plugin.settings.FoldNodeArr.filter(n =>
                        (n.nodeIDstr == node.IDStr) && (n.graphID = indexMermaid.id)).length === 0) {
                        this.plugin.settings.FoldNodeArr.push(clickNode);
                    } else {
                        let index = this.plugin.settings.FoldNodeArr.findIndex(
                            item => (item.graphID === clickNode.graphID) && (item.nodeIDstr === clickNode.nodeIDstr));
                        if (index !== -1) {
                            this.plugin.settings.FoldNodeArr.splice(index, 1);
                        }
                    }

                    event.stopPropagation();

                    // 性能优化：使用防抖，避免连续点击时多次重新渲染
                    if (this.foldRefreshTimeout) {
                        clearTimeout(this.foldRefreshTimeout);
                    }
                    this.foldRefreshTimeout = setTimeout(async () => {
                        await this.refreshBranchMermaid();
                        this.foldRefreshTimeout = null;
                    }, 300);
                })
            }

        })
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

    async onClose() {
        this.plugin.saveData(this.plugin.settings);
    }
}