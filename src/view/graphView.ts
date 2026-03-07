import ZKNavigationPlugin from "main";
import { ExtraButtonComponent, FileView, ItemView, Notice, TFile, WorkspaceLeaf, debounce, loadMermaid } from "obsidian";
import { GitBranch, ZKNode, ZK_NAVIGATION } from "./indexView";
import { t } from "src/lang/helper";
import { convertMOCToZKNodes, displayWidth, mainNoteInit, parseMOCStructure,ReverseRelation } from "src/utils/utils";
import { expandGraphModal } from "src/modal/expandGraphModal";
import { CytoscapeExpandModal } from "src/modal/cytoscapeExpandModal";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { RenderOptions } from "src/renderer/types";

export const ZK_GRAPH_TYPE: string = "zk-graph-type"
export const ZK_GRAPH_VIEW: string = t("zk-local-graph")

export class ZKGraphView extends ItemView {

    plugin: ZKNavigationPlugin;
    currentFile: TFile | null;
    familyNodeArr: ZKNode[] = [];
    graphHeight: number = 0;
    countOfGraphs: number = 0;
    gitBranches: GitBranch[] = [];
    order: number;
    result: GitBranch[];

    // 防抖相关属性
    resizeTimeout: NodeJS.Timeout | null = null;

    // Cytoscape 渲染器
    private familyGraphRenderer: CytoscapeRenderer | null = null;
    private inoutlinksRenderer: CytoscapeRenderer | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ZKNavigationPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return ZK_GRAPH_TYPE;
    }
    getDisplayText(): string {
        return ZK_GRAPH_VIEW;
    }

    getIcon(): string {
        return "network"
    }

    onResize() {

        if (this.app.workspace.getLeavesOfType(ZK_GRAPH_TYPE).length > 0) {

            // 使用防抖来避免频繁触发刷新
            if (this.resizeTimeout) {
                clearTimeout(this.resizeTimeout);
            }

            this.resizeTimeout = setTimeout(() => {
                this.app.workspace.trigger("zk-navigation:refresh-local-graph");
                this.resizeTimeout = null;
            }, 300);
        }
    }

    async onOpen() {
        this.refreshLocalGraph();
    }

    onload() {

        // 增加防抖时间，避免编辑时频繁刷新
        const refresh = debounce(this.refreshLocalGraph, 500, true);

        // 记录上次刷新的文件路径，避免重复刷新
        let lastRefreshedFile: string | null = null;

        this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
            // 只在索引文件或当前活动文件改名时刷新
            if (file instanceof TFile) {
                const activeFile = this.app.workspace.getActiveFile();
                const isActiveFile = activeFile && (file.path === activeFile.path || oldPath === activeFile.path);
                const isInMainNoteFolder = this.isFileInMainNoteFolders(file);
                
                if (isActiveFile || isInMainNoteFolder) {
                    lastRefreshedFile = null;
                    refresh();
                }
            }
        }));

        this.registerEvent(this.app.vault.on("create", (file) => {
            // 只在索引文件创建时刷新
            if (file instanceof TFile && this.isFileInMainNoteFolders(file)) {
                lastRefreshedFile = null;
                refresh();
            }
        }));

        this.registerEvent(this.app.vault.on("delete", (file) => {
            // 只在索引文件删除时刷新
            if (file instanceof TFile && this.isFileInMainNoteFolders(file)) {
                lastRefreshedFile = null;
                refresh();
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
                this.refreshLocalGraph();
                changeRefreshTimer = null;
            }
        };

        this.registerEvent(this.app.metadataCache.on("changed", (file) => {
            const activeFile = this.app.workspace.getActiveFile();
            // 只在当前活动文件变化时刷新
            if (activeFile && file.path === activeFile.path) {
                // 检查当前文件是否在索引笔记目录下
                const isInMainNoteFolder = this.isFileInMainNoteFolders(activeFile);
                
                // 如果不在索引笔记目录下，不监听 change 事件
                if (!isInMainNoteFolder) {
                    return;
                }
                
                lastEditTime = Date.now();
                
                // 如果没有定时器在运行，启动一个
                if (!changeRefreshTimer) {
                    changeRefreshTimer = setTimeout(smartChangeRefresh, 5000);
                }
            }
        }));

        this.registerEvent(this.app.metadataCache.on("deleted", (file) => {
            // 只在索引文件删除时刷新
            if (file instanceof TFile && this.isFileInMainNoteFolders(file)) {
                lastRefreshedFile = null;
                refresh();
            }
        }));

        this.registerEvent(this.app.workspace.on("active-leaf-change", async (leaf) => {

            if (this.app.workspace.getLeavesOfType(ZK_GRAPH_TYPE).length > 0) {
                if (this.app.workspace.getActiveViewOfType(FileView)) {
                    const activeFile = this.app.workspace.getActiveFile();
                    // 只在文件切换时刷新
                    if (activeFile && lastRefreshedFile !== activeFile.path) {
                        lastRefreshedFile = activeFile.path;
                        this.plugin.retrivalforLocaLgraph.type = '2';
                        refresh();
                    }
                }
            }
        }));

        this.registerEvent(this.app.workspace.on("zk-navigation:refresh-local-graph", () => {
            lastRefreshedFile = null; // 强制刷新
            refresh();
        }));

        // MOC 文件变化事件监听（实时同步）
        this.registerEvent(this.app.workspace.on("zk-navigation:moc-file-changed", async (mocFile: TFile) => {
            const activeFile = this.app.workspace.getActiveFile();
            
            if (!activeFile) return;
            
            // 情况1: 当前显示的就是变化的 MOC 文件
            if (this.isMOCFile(activeFile) && activeFile.path === mocFile.path) {
                lastRefreshedFile = null; // 强制刷新
                refresh();
                return;
            }
            
            // 情况2: 当前文件是 MOC 树中的节点
            const result = await this.findNodeInMOCTrees(activeFile);
            if (result && result.mocFile.path === mocFile.path) {
                lastRefreshedFile = null; // 强制刷新
                refresh();
            }
        }));

    }

    refreshLocalGraph = async () => {
        let { containerEl } = this;
        containerEl.empty();

        this.countGraphs();
        // 安全检查：避免除以 0 或 NaN
        const safeCount = Math.max(this.countOfGraphs, 1);
        const containerHeight = containerEl.offsetHeight || 400; // 默认高度 400px
        this.graphHeight = Math.max(Math.floor(containerHeight / safeCount - 10), 200); // 最小高度 200px

        const graphMermaidDiv = containerEl.createDiv().createDiv("zk-graph-mermaid-container");

        // MOC 模式
        if (this.plugin.settings.mocModeEnabled) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                // 检查是否是 MOC 文件
                if (this.isMOCFile(activeFile)) {
                    await this.refreshLocalGraphMOC(graphMermaidDiv, activeFile);
                    return;
                }

                // 检查是否是 MOC 树中的节点，如果是则渲染相关的思维树
                const mocNodeResult = await this.findNodeInMOCTrees(activeFile);
                if (mocNodeResult) {
                    await this.refreshLocalGraphMOCNode(graphMermaidDiv, activeFile, mocNodeResult.allNodes, mocNodeResult.currentNode, mocNodeResult.mocFile);
                    return;
                }
            }
        }

        await mainNoteInit(this.plugin);

        switch (this.plugin.retrivalforLocaLgraph.type) {
            case '1': //click graph
                this.currentFile = this.app.vault.getFileByPath(this.plugin.retrivalforLocaLgraph.filePath);
                break;
            default: // open file

                this.currentFile = this.app.workspace.getActiveFile();
                if (this.currentFile !== null) {
                    let path = this.currentFile.path;
                    let nodes = this.familyNodeArr.filter(n => n.file?.path == path);
                    if (nodes.length > 0) {
                        this.plugin.retrivalforLocaLgraph.ID = nodes[0].ID;
                    } else {
                        nodes = this.plugin.MainNotes.filter(n => n.file?.path == path);

                        if (nodes.length > 0) {
                            this.plugin.retrivalforLocaLgraph.ID = nodes[0].ID;
                        }

                    }

                    this.plugin.retrivalforLocaLgraph.filePath = path;
                }
                break;
        }

        graphMermaidDiv.empty();

        if (this.currentFile !== null) {

            const mermaid = await loadMermaid();
            const svgPanZoom = require("svg-pan-zoom");
            if (this.plugin.settings.FamilyGraphToggle == true) {

                await this.getFamilyNodes(this.currentFile);
                if (this.familyNodeArr.length > 0) {

                    if (this.plugin.settings.graphType === "structure") {
                        // 使用 Cytoscape 渲染家族图
                        await this.renderFamilyGraphWithCytoscape(graphMermaidDiv, this.currentFile);
                    } else {
                        let familyMermaidStr: string = await this.genericGitgraphStr(this.currentFile);
                        const familyGraphContainer = graphMermaidDiv.createDiv("zk-family-graph-container");
                        const familyGraphTextDiv = familyGraphContainer.createDiv("zk-graph-text");

                        familyGraphTextDiv.empty();
                        familyGraphTextDiv.createEl('span', { text: t("close relative") })

                        let graphIconDiv = familyGraphContainer.createDiv("zk-graph-icon");
                        graphIconDiv.empty();
                        
                        // 全屏按钮
                        let fullscreenBtn = new ExtraButtonComponent(graphIconDiv);
                        fullscreenBtn.setIcon("maximize-2").setTooltip(t("fullscreen"));
                        fullscreenBtn.onClick(() => {
                            this.toggleFullscreen(familyGraphContainer);
                        });
                        
                        // 展开按钮
                        let expandBtn = new ExtraButtonComponent(graphIconDiv);
                        expandBtn.setIcon("expand").setTooltip(t("expand graph"));
                        expandBtn.onClick(() => {
                            new expandGraphModal(this.app, this.plugin, this.familyNodeArr, [], familyMermaidStr, 'gitGraph').open();
                        })

                        const familyTreeDiv = familyGraphContainer.createEl("div", { cls: "zk-graph-mermaid" });

                        familyTreeDiv.id = "zk-family-tree";
                        let { svg } = await mermaid.render(`${familyTreeDiv.id}-svg`, `${familyMermaidStr}`);
                        familyTreeDiv.insertAdjacentHTML('beforeend', svg);
                        familyTreeDiv.children[0].removeAttribute('style');
                        familyTreeDiv.children[0].addClass("zk-full-width");
                        familyTreeDiv.children[0].setAttribute('height', `${this.graphHeight}px`);
                        graphMermaidDiv.appendChild(familyTreeDiv);

                        let panZoomTiger = svgPanZoom(`#${familyTreeDiv.id}-svg`, {
                            zoomEnabled: true,
                            controlIconsEnabled: false,
                            fit: false,
                            center: true,
                            minZoom: 0.001,
                            maxZoom: 1000,
                            dblClickZoomEnabled: false,
                            zoomScaleSensitivity: 0.3,
                        })

                        let setSvg = document.getElementById(`${familyTreeDiv.id}-svg`);

                        if (setSvg !== null) {
                            let a = setSvg.children[0].getAttr("style");
                            if (typeof a == 'string') {
                                let b = a.match(/\d([^\,]+)\d/g)
                                if (b !== null && Number(b[0]) > 1) {
                                    panZoomTiger.zoom(1 / Number(b[0]))
                                }
                            }
                        }


                        const gElements = familyTreeDiv.querySelectorAll('g.commit-bullets');


                        const circles = gElements[1].querySelectorAll("circle.commit")
                        const circleNodes = Array.from(circles);
                        gElements[1].textContent = "";

                        for (let j = 0; j < circleNodes.length; j++) {
                            let link = document.createElementNS('http://www.w3.org/2000/svg', 'a');
                            link.appendChild(circleNodes[j]);
                            gElements[1].appendChild(link);

                            let nodeArr = this.familyNodeArr.filter(n => n.gitNodePos === j);
                            if (nodeArr.length > 0) {
                                let node = nodeArr[0];
                                if (!node.file) return;
                                circleNodes[j].addEventListener("click", async (event: MouseEvent) => {
                                    if (!node.file) return;
                                    if (event.ctrlKey) {
                                        this.app.workspace.openLinkText("", node.file.path, 'tab');
                                    } else if (event.shiftKey) {
                                        this.plugin.retrivalforLocaLgraph = {
                                            type: '1',
                                            ID: node.ID,
                                            filePath: node.file.path,
                                        };
                                        this.plugin.openGraphView();
                                    } else if (event.altKey) {
                                        this.plugin.settings.lastRetrival = {
                                            type: 'main',
                                            ID: node.ID,
                                            displayText: node.displayText,
                                            filePath: node.file.path,
                                            openTime: '',
                                        }
                                        this.plugin.RefreshIndexViewFlag = true;
                                        this.plugin.openIndexView();
                                    } else {
                                        this.app.workspace.openLinkText("", node.file.path)
                                    }

                                })
                                circleNodes[j].addEventListener(`mouseover`, (event: MouseEvent) => {
                                    if (!node.file) return;
                                    this.app.workspace.trigger(`hover-link`, {
                                        event,
                                        source: ZK_NAVIGATION,
                                        hoverParent: circleNodes[j],
                                        linktext: "",
                                        targetEl: circleNodes[j],
                                        sourcePath: node.file.path,
                                    })
                                });
                            }
                        }
                    }
                } else {
                    this.countOfGraphs--;
                    // 安全检查：避免除以 0 或 NaN
                    const safeCount = Math.max(this.countOfGraphs, 1);
                    const containerHeight = containerEl.offsetHeight || 400; // 默认高度 400px
                    this.graphHeight = Math.max(Math.floor(containerHeight / safeCount - 10), 200); // 最小高度 200px
                }

            }

            // 出入链合并图
            if (this.plugin.settings.InOutlinksGraphToggle == true) {

                let inlinkArr: TFile[] = await this.getInlinks(this.currentFile);
                let outlinkArr: TFile[] = [];

                if (this.currentFile.extension === 'md') {
                    outlinkArr = await this.getOutlinks(this.currentFile);
                }

                // 使用 Cytoscape 渲染入链出链图
                await this.renderInOutLinksWithCytoscape(graphMermaidDiv, this.currentFile, inlinkArr, outlinkArr);
            }
        }
    }

    async getFamilyNodes(currentFile: TFile) {

        this.familyNodeArr = [];

        let Nodes = this.plugin.MainNotes.filter(n => n.file == currentFile);

        if (Nodes.length > 0) {
            if (this.plugin.retrivalforLocaLgraph.ID !== '') {
                Nodes = Nodes.filter(n => n.ID == this.plugin.retrivalforLocaLgraph.ID);
            } else {
                this.plugin.retrivalforLocaLgraph.ID = Nodes[0].ID;
            }
        }

        if (Nodes.length > 0) {

            let currentNode = Nodes[0];

            if (currentNode.IDArr.length > 1) {
                let fatherArr = currentNode.IDArr.slice(0, currentNode.IDArr.length - 1);

                let fatherNode = this.plugin.MainNotes
                    .filter(n => n.IDStr == fatherArr.toString());

                if (fatherNode.length > 0) {

                    this.familyNodeArr = this.plugin.MainNotes.filter(n => n.IDStr.startsWith(fatherNode[0].IDStr))
                        .filter(n => n.IDArr.length <= currentNode.IDArr.length ||
                            (n.IDStr.startsWith(currentNode.IDStr) && n.IDArr.length == currentNode.IDArr.length + 1)
                        );

                } else {
                    this.familyNodeArr = this.plugin.MainNotes.filter(n => n.IDStr.startsWith(currentNode.IDStr)
                        && n.IDArr.length <= currentNode.IDArr.length + 1);
                }

            } else {
                this.familyNodeArr = this.plugin.MainNotes.filter(n => n.IDStr.startsWith(currentNode.IDStr)
                    && n.IDArr.length <= currentNode.IDArr.length + 1);
            }
        }

        //calculate width for siblings
        if (this.plugin.settings.siblingLenToggle === true) {
            const maxLength = Math.max(...this.familyNodeArr.map(n => n.IDArr.length));
            const minLength = Math.min(...this.familyNodeArr.map(n => n.IDArr.length));

            for (let i = minLength; i <= maxLength; i++) {
                let layerNodes = this.familyNodeArr.filter(n => n.IDArr.length === i);
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
    }

    async getInlinks(currentFile: TFile) {

        let inlinkArr: TFile[] = [];
        const resolvedLinks = this.app.metadataCache.resolvedLinks;

        for (let src of Object.keys(resolvedLinks)) {
            let link = resolvedLinks[src];
            for (let dest of Object.keys(link)) {
                if (dest === currentFile.path) {
                    let inlinkFile = this.app.vault.getFileByPath(src);
                    if (inlinkFile !== null) {
                        inlinkArr.push(inlinkFile);
                    }

                }
            }
        }

        return inlinkArr;

    }

    async getOutlinks(currentFile: TFile) {


        let outlinkArr: TFile[] = [];
        const resolvedLinks = this.app.metadataCache.resolvedLinks;

        // 安全检查：确保 resolvedLinks 中有当前文件的条目
        const fileLinks = resolvedLinks[currentFile.path];
        if (!fileLinks) {
            return outlinkArr;
        }

        let outlinks: string[] = Object.keys(fileLinks);

        if (this.plugin.settings.FileExtension == "md") {
            outlinks = outlinks.filter(link => link.endsWith(".md"))
        }

        for (let outlink of outlinks) {
            let outlinkFile = this.app.vault.getFileByPath(outlink);
            if (outlinkFile !== null) {
                outlinkArr.push(outlinkFile);
            }
        }

        return outlinkArr;

    }

    async genericLinksMermaidStr(currentFile: TFile, linkArr: TFile[], direction1: string = 'in', direction2: string) {

        let mermaidStr: string = `%%{ init: { 'flowchart': { 'curve': 'basis', 'wrappingWidth': '5000' },
        'themeVariables':{ 'fontSize': '12px'}}}%% flowchart ${direction2};\n`

        let currentNode: ZKNode[] = [];

        if (this.familyNodeArr.length > 0) {
            currentNode = this.familyNodeArr.filter(n => n.file == currentFile)
            if (currentNode.length == 0) {
                currentNode = this.plugin.MainNotes.filter(n => n.file === currentFile);
            }
        }

        if (currentNode.length > 0) {
            mermaidStr = mermaidStr + `${linkArr.length}("${this.processDisplayText(currentNode[0].displayText)}");
            style ${linkArr.length} fill:#1a5f8f,stroke:#2a7faf,stroke-width:2px,color:#fff \n`;
        } else {
            mermaidStr = mermaidStr + `${linkArr.length}("${currentFile.basename}");
            style ${linkArr.length} fill:#1a5f8f,stroke:#2a7faf,stroke-width:2px,color:#fff \n`;
        }

        for (let i = 0; i < linkArr.length; i++) {
            let node = this.plugin.MainNotes.find(n => n.file == linkArr[i]);
            if (typeof node !== 'undefined') {
                mermaidStr = mermaidStr + `${i}("${node.displayText}");\n`;
            } else {
                mermaidStr = mermaidStr + `${i}("${linkArr[i].basename}");\n`;
            }
            mermaidStr = mermaidStr + `style ${i} fill:#2a3446,stroke:#5a6f7f,stroke-width:1px,color:#e0e0e0 \n`;
            if (direction1 == 'in') {
                mermaidStr = mermaidStr + `${i} --> ${linkArr.length};\n`;
            } else {
                mermaidStr = mermaidStr + `${linkArr.length} --> ${i};\n`;
            }
        }

        return mermaidStr;

    }

    // 生成合并的出入链 Mermaid 字符串
    async genericInOutLinksMermaidStr(currentFile: TFile, inlinkArr: TFile[], outlinkArr: TFile[], direction: string) {

        let mermaidStr: string = `%%{ init: { 'flowchart': { 'curve': 'basis', 'wrappingWidth': '5000' },
        'themeVariables':{ 'fontSize': '12px'}}}%% flowchart ${direction};\n`

        let currentNode: ZKNode[] = [];

        if (this.familyNodeArr.length > 0) {
            currentNode = this.familyNodeArr.filter(n => n.file == currentFile)
            if (currentNode.length == 0) {
                currentNode = this.plugin.MainNotes.filter(n => n.file === currentFile);
            }
        }

        // 当前文件节点的索引位置 = 入链数组长度
        const currentFileIndex = inlinkArr.length;

        if (currentNode.length > 0) {
            mermaidStr = mermaidStr + `${currentFileIndex}("${this.escapeMermaidText(this.processDisplayText(currentNode[0].displayText))}");
            style ${currentFileIndex} fill:#1a5f8f,stroke:#2a7faf,stroke-width:2px,color:#fff \n`;
        } else {
            mermaidStr = mermaidStr + `${currentFileIndex}("${currentFile.basename}");
            style ${currentFileIndex} fill:#1a5f8f,stroke:#2a7faf,stroke-width:2px,color:#fff \n`;
        }

        // 添加入链节点（索引 0 到 inlinkArr.length - 1）
        for (let i = 0; i < inlinkArr.length; i++) {
            let node = this.plugin.MainNotes.find(n => n.file == inlinkArr[i]);
            if (typeof node !== 'undefined') {
                mermaidStr = mermaidStr + `${i}("${this.escapeMermaidText(this.processDisplayText(node.displayText))}");\n`;
            } else {
                mermaidStr = mermaidStr + `${i}("${inlinkArr[i].basename}");\n`;
            }
            mermaidStr = mermaidStr + `style ${i} fill:#2a3446,stroke:#5a6f7f,stroke-width:1px,color:#e0e0e0 \n`;
            // 入链：节点 -> 当前文件
            mermaidStr = mermaidStr + `${i} --> ${currentFileIndex};\n`;
        }

        // 添加出链节点（索引从 currentFileIndex + 1 开始）
        for (let i = 0; i < outlinkArr.length; i++) {
            const nodeIndex = currentFileIndex + 1 + i;
            let node = this.plugin.MainNotes.find(n => n.file == outlinkArr[i]);
            if (typeof node !== 'undefined') {
                mermaidStr = mermaidStr + `${nodeIndex}("${this.escapeMermaidText(this.processDisplayText(node.displayText))}");\n`;
            } else {
                mermaidStr = mermaidStr + `${nodeIndex}("${outlinkArr[i].basename}");\n`;
            }
            mermaidStr = mermaidStr + `style ${nodeIndex} fill:#2a3446,stroke:#5a6f7f,stroke-width:1px,color:#e0e0e0 \n`;
            // 出链：当前文件 -> 节点
            mermaidStr = mermaidStr + `${currentFileIndex} --> ${nodeIndex};\n`;
        }

        return mermaidStr;

    }

    async genericFamilyMermaidStr(currentFile: TFile, direction: string) {
        let mermaidStr: string = `%%{ init: { 'flowchart': { 'curve': 'basis', 'wrappingWidth': '5000' },
        'themeVariables':{ 'fontSize': '12px'}}}%% flowchart ${direction};`;

        for (let node of this.familyNodeArr) {

            if (this.plugin.settings.siblingLenToggle === true && node.fixWidth !== 0) {
                mermaidStr = mermaidStr + `${node.position}("<p style='width:${node.fixWidth}px;margin:0px;'>${this.processDisplayText(node.displayText)}</p>");\n`;
            } else {
                mermaidStr = mermaidStr + `${node.position}("${this.processDisplayText(node.displayText)}");\n`;
            }

            if (node.file && node.file == currentFile) {
                mermaidStr = mermaidStr + `style ${node.position} fill:#1a5f8f,stroke:#2a7faf,stroke-width:2px,color:#fff \n`;
            } else {
                mermaidStr = mermaidStr + `style ${node.position} fill:#2a3446,stroke:#5a6f7f,stroke-width:1px,color:#e0e0e0 \n`;
            }


        }

        for (let node of this.familyNodeArr) {

            let sonNodes = this.familyNodeArr.filter(n => (n.IDArr.length - 1 == node.IDArr.length)
                && n.IDStr.startsWith(node.IDStr) && n.ID.startsWith(node.ID));

            for (let son of sonNodes) {

                mermaidStr = mermaidStr + `${node.position} --> ${son.position};\n`;

            }
        }

        if (this.plugin.settings.RedDashLine === true) {

            for (let node of this.familyNodeArr) {
                if (node.file && /^[a-zA-Z]$/.test(node.file.basename.slice(-1))) {
                    //红色虚线边
                    mermaidStr = mermaidStr + `style ${node.position} stroke:#f66,stroke-width:2px,stroke-dasharray: 1 \n`;
                }
            }
        }

        return mermaidStr;
    }

    async genericGitgraphStr(currentFile: TFile) {

        this.generateGitBranch();
        this.order = 0;
        this.result = [];
        let temBranches = this.gitBranches.filter(b => b.branchName === "main");
        this.gitBranches = this.gitBranches.filter(b => b.branchName !== "main");

        if (temBranches.length > 0) {
            this.orderGitBranch(temBranches[0]);

        }

        temBranches = this.result.filter(b => b.branchName === "main")
        this.gitBranches = this.result.filter(b => b.branchName !== "main")
        let gitNodePos: number = 0;
        let gitStr: string = '';
        while (temBranches.length > 0) {

            let nextBranch = temBranches.reduce((min, obj) => {

                return min && min.nodes[min.currentPos].ctime < obj.nodes[obj.currentPos].ctime ? min : obj;
            }, temBranches[0])

            let branchIndex = temBranches.indexOf(nextBranch);

            let nextNode = temBranches[branchIndex].nodes[temBranches[branchIndex].currentPos];
            temBranches[branchIndex].currentPos = temBranches[branchIndex].currentPos + 1;

            nextNode.gitNodePos = gitNodePos
            gitNodePos = gitNodePos + 1;

            if (nextBranch.active === false) {
                gitStr = gitStr + `checkout ${nextBranch.branchPoint.branchName}\n`
                nextBranch.active = true;
            }
            gitStr = gitStr + `checkout ${nextBranch.branchName}
            commit id: "${nextNode?.displayText}"`

            if (nextNode?.ID === this.plugin.retrivalforLocaLgraph.ID) {
                gitStr = gitStr + `tag: "index🌿"`// `type: HIGHLIGHT`
            }

            gitStr = gitStr + `\n`

            //if(temBranches[branchIndex].nodes.length === 0){
            if (temBranches[branchIndex].nodes.length === temBranches[branchIndex].currentPos) {
                temBranches.splice(branchIndex, 1);
            }
            let newBranches = this.gitBranches.filter(n => n.branchPoint.ID == nextNode?.ID);
            // 必须先声明分支
            for (let branch of newBranches) {
                temBranches.push(branch);
                gitStr = gitStr + `branch ${branch.branchName} order: ${branch.order}\n`
            }
        }
        let mermaidStr: string = `%%{init: { 'logLevel': 'debug', 'theme': 'base', 'gitGraph': {'showBranches': false, 'parallelCommits': true, 'rotateCommitLabel': true}} }%%
                                gitGraph
                                ${gitStr}
                                `;
        return mermaidStr;
    }

    generateGitBranch() {

        let Nodes = this.familyNodeArr;
        const maxLength = Math.max(...Nodes.map(n => n.IDArr.length));
        const minLength = Math.min(...Nodes.map(n => n.IDArr.length));

        this.gitBranches = [];
        let nodes = Nodes.filter(l => l.IDArr.length === minLength)

        this.gitBranches.push({
            branchName: "main",
            branchPoint: Nodes[0],
            nodes: nodes,
            currentPos: 0,
            order: 0,
            positionX: 0,
            active: true,
        })

        let nodeIndex = Nodes.indexOf(nodes[0]);
        Nodes[nodeIndex].branchName = "main";

        for (let i = minLength; i < maxLength; i++) {
            let layerNodes = Nodes.filter(n => n.IDArr.length === i);
            for (let fatherNode of layerNodes) {
                let numberSons = Nodes.filter(n => n.IDArr.length === i + 1 && /[0-9]/.test(n.ID.slice(-1)) && n.IDArr.slice(0, -1).toString() === fatherNode.IDStr);
                if (numberSons.length > 0) {
                    let branchName = `B${this.gitBranches.length}`;
                    let gitBranch: GitBranch = {
                        branchName: branchName,
                        branchPoint: fatherNode,
                        nodes: numberSons,
                        currentPos: 0,
                        positionX: 0,
                        order: 0,
                        active: false,
                    };
                    this.gitBranches.push(gitBranch);
                    for (let node of numberSons) {
                        let index = Nodes.indexOf(node);
                        Nodes[index].branchName = branchName;
                    }

                }
                let letterSons = Nodes.filter(n => n.IDArr.length === i + 1 && /[a-zA-Z]/.test(n.ID.slice(-1)) && n.IDArr.slice(0, -1).toString() === fatherNode.IDStr);
                if (letterSons.length > 0) {
                    let branchName = `B${this.gitBranches.length}`;
                    let gitBranch: GitBranch = {
                        branchName: branchName,
                        branchPoint: fatherNode,
                        nodes: letterSons,
                        currentPos: 0,
                        order: 0,
                        positionX: 0,
                        active: false,
                    };
                    this.gitBranches.push(gitBranch);
                    for (let node of letterSons) {
                        let index = Nodes.indexOf(node);
                        Nodes[index].branchName = branchName;
                    }
                }
            }
        }
    }

    orderGitBranch(current: GitBranch) {

        current.order = this.order;
        this.result.push(current);

        this.order = this.order + 1;
        for (let i = current.nodes.length - 1; i >= 0; i--) {
            let branches = this.gitBranches.filter(b => b.branchPoint.ID === current.nodes[i].ID);
            if (branches.length > 0) {
                branches.sort((a, b) => a.nodes[0].ctime - b.nodes[0].ctime);
                for (let next of branches) {
                    this.orderGitBranch(next);
                }
            }
        }
    }
    countGraphs() {

        let count = 0;
        if (this.plugin.settings.FamilyGraphToggle === true) {
            count++;
        }
        if (this.plugin.settings.InOutlinksGraphToggle === true) {
            count++;
        }

        this.countOfGraphs = count;
    }

    // 检查文件是否是 MOC 文件
    isMOCFile(file: TFile): boolean {
        const mocFolder = this.plugin.settings.mocFolderPath;
        if (!mocFolder) return false;
        return file.path.startsWith(mocFolder + '/') || file.path.startsWith(mocFolder);
    }

    // MOC 模式下的局部关系视图渲染
    async refreshLocalGraphMOC(graphMermaidDiv: HTMLElement, mocFile: TFile) {
        graphMermaidDiv.empty();

        // 计算要显示的图数量
        let graphCount = 0;
        if (this.plugin.settings.FamilyGraphToggle) graphCount++;
        if (this.plugin.settings.InOutlinksGraphToggle) graphCount++;

        // 安全检查：避免除以 0 或 NaN
        const safeCount = Math.max(graphCount, 1);
        const containerHeight = this.containerEl.offsetHeight || 400; // 默认高度 400px
        const graphHeight = Math.max(Math.floor(containerHeight / safeCount - 10), 200); // 最小高度 200px

        const headingTitle = this.plugin.settings.mocHeadingTitle;
        const mermaid = await loadMermaid();
        const svgPanZoom = require("svg-pan-zoom");

        // ========== 1. MOC 树结构（类似邻近图）==========
        if (this.plugin.settings.FamilyGraphToggle) {
            // 解析 MOC 结构
            const mocParseResult = await parseMOCStructure(this.app, mocFile.path, headingTitle);

            if (mocParseResult.nodes.length > 0) {
                // 转换为 ZKNode 数组用于图形显示（传递 reverseRelations 和 nodePositions）
                const mocNodes = await convertMOCToZKNodes(this.plugin, mocParseResult.nodes, mocParseResult.reverseRelations, [], mocParseResult.nodePositions);

                if (mocNodes.length > 0) {
                    // 不要修改 MainNotes，只用于当前图形显示
                    this.familyNodeArr = mocNodes;

                    // 使用 Cytoscape 渲染 MOC 树（传递 reverseRelations 和 mocFile）
                    await this.renderMOCTreeWithCytoscape(graphMermaidDiv, mocNodes, headingTitle, graphHeight, mocParseResult.reverseRelations, mocFile);
                }
            } else {
                // 没有树结构时显示提示和调试信息
                console.warn(`Graph View: No tree structure found for heading: ${headingTitle}`);
                const emptyContainer = graphMermaidDiv.createDiv("zk-family-graph-container");
                const emptyTextDiv = emptyContainer.createDiv("zk-graph-text");
                emptyTextDiv.createEl('span', { text: `${headingTitle}` });
                
                const errorDiv = emptyContainer.createEl('div', {
                    text: `${t("No tree structure found under heading:")} # ${headingTitle}`,
                    cls: "zk-graph-mermaid"
                });
                errorDiv.style.padding = "20px";
                errorDiv.style.textAlign = "center";
                
                // 显示调试信息
                if (mocParseResult.metadata.parseTime > 0) {
                    const debugInfo = emptyContainer.createDiv("zk-debug-info");
                    debugInfo.style.padding = "20px";
                    debugInfo.style.color = "var(--text-muted)";
                    debugInfo.style.fontSize = "12px";
                    debugInfo.innerHTML = `
                        <p>解析耗时: ${mocParseResult.metadata.parseTime}ms</p>
                        <p>文件路径: ${mocParseResult.metadata.filePath}</p>
                        <p>查找标题: ${mocParseResult.metadata.headingTitle}</p>
                        <p>提示: 请确保 MOC 文件中存在一级标题 "# ${headingTitle}"</p>
                    `;
                }
            }
        }

        // ========== 2. 出入链图 ==========
        if (this.plugin.settings.InOutlinksGraphToggle) {
            const inlinkArr = await this.getInlinks(mocFile);
            const outlinkArr = await this.getOutlinks(mocFile);

            // 使用 Cytoscape 渲染入链出链图
            await this.renderInOutLinksWithCytoscape(graphMermaidDiv, mocFile, inlinkArr, outlinkArr);
        }
    }

    // 为 MOC 树节点添加事件
    async addMOCNodeEvents(treeDiv: HTMLElement, mocNodes: ZKNode[]) {
        const nodeGArr = treeDiv.querySelectorAll("[id^='flowchart-']");
        const nodeArr = treeDiv.getElementsByClassName("nodeLabel");

        for (let i = 0; i < nodeArr.length; i++) {
            const link = document.createElement('a');
            link.addClass("internal-link");
            const nodePosStr = nodeGArr[i].id.split('-')[1];
            const node = mocNodes.filter(n => n.position == Number(nodePosStr))[0];
                if (node && !node.file) return;

                if (node) {
                link.textContent = nodeArr[i].getText();
                nodeArr[i].textContent = "";
                nodeArr[i].appendChild(link);

                nodeGArr[i].addEventListener("click", (event: MouseEvent) => {
                    if (!node.file) return;
                    if (event.ctrlKey) {
                        this.app.workspace.openLinkText("", node.file.path, 'tab');
                    } else {
                        this.app.workspace.openLinkText("", node.file.path);
                    }
                });

                nodeGArr[i].addEventListener("mouseover", (event: MouseEvent) => {
                    if (!node.file) return;
                    this.app.workspace.trigger('hover-link', {
                        event,
                        source: ZK_NAVIGATION,
                        hoverParent: this,
                        linktext: "",
                        targetEl: link,
                        sourcePath: node.file.path,
                    });
                });
            }
        }
    }

    // 为入链/出链节点添加事件
    async addLinkNodeEvents(treeDiv: HTMLElement, linkArr: TFile[], currentFile: TFile) {
        const nodeGArr = treeDiv.querySelectorAll("[id^='flowchart-']");
        const nodeArr = treeDiv.getElementsByClassName("nodeLabel");

        for (let i = 0; i < nodeArr.length; i++) {
            const link = document.createElement('a');
            link.addClass("internal-link");
            link.textContent = nodeArr[i].getText();
            nodeArr[i].textContent = "";
            nodeArr[i].appendChild(link);

            // 查找对应的文件
            const nodeText = link.textContent || '';
            let targetFile: TFile | null = null;

            // 检查是否是当前文件
            if (nodeText === currentFile.basename || nodeText.includes(currentFile.basename)) {
                targetFile = currentFile;
            } else {
                // 从链接数组中查找
                targetFile = linkArr.find(f => nodeText === f.basename || nodeText.includes(f.basename)) || null;
            }

            if (targetFile) {
                nodeGArr[i].addEventListener("click", (event: MouseEvent) => {
                    if (event.ctrlKey) {
                        this.app.workspace.openLinkText("", targetFile!.path, 'tab');
                    } else {
                        this.app.workspace.openLinkText("", targetFile!.path);
                    }
                });

                nodeGArr[i].addEventListener("mouseover", (event: MouseEvent) => {
                    this.app.workspace.trigger('hover-link', {
                        event,
                        source: ZK_NAVIGATION,
                        hoverParent: this,
                        linktext: "",
                        targetEl: link,
                        sourcePath: targetFile!.path,
                    });
                });
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


    
    // 生成 MOC 树的 Mermaid 字符串
    async generateMOCTreeMermaidStr(nodes: ZKNode[], direction: string, 
        reverseRelations: Map<string, ReverseRelation>, highlightFile?: TFile): Promise<string> {
    const reverseRelationsMap = new Map<string, ReverseRelation[]>();
    
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

        const nodeMap = new Map<string, ZKNode>();
    

        let mermaidStr = `%%{ init: { 'flowchart': { 'curve': 'basis', 'wrappingWidth': '5000' },
        'themeVariables':{ 'fontSize': '12px'}}}%% flowchart ${direction};\n`;

        // 添加节点
        for (const node of nodes) {
            nodeMap.set(node.IDStr,node);

            const nodeText = this.escapeMermaidText(this.processDisplayText(node.displayText));
            mermaidStr += `${node.position}("${nodeText}");\n`;
            // 高亮当前文件对应的节点
            if (highlightFile && node.file && node.file.path === highlightFile.path) {
                mermaidStr += `style ${node.position} fill:#1a5f8f,stroke:#2a7faf,stroke-width:2px,color:#fff\n`;
            } else {
                mermaidStr += `style ${node.position} fill:#2a3446,stroke:#5a6f7f,stroke-width:1px,color:#e0e0e0\n`;
            }
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
        for (const node of nodes) {
            if (node.IDArr.length > 1) {
                const parentID = node.IDArr.at(-2);
                const parentNode = nodes.find(n => n.IDStr === parentID);
                if (parentNode) {
                    //如果存在任意关系就把默认关系去掉
                    if (node.relationText){
                        links.push({
                            from: parentNode.position,
                            to: node.position,
                            text: this.escapeMermaidText(node.relationText),
                            isDashed: false,
                            isReverse: false,
                            sourceIDStr: parentNode.IDStr,
                            targetIDStr: node.IDStr
                        });
                    } else {
                        const nodeRel = reverseRelationsMap.get(node.IDStr)?.find(n => {
                            return ((n.targetID === node.IDStr && n.sourceID === parentID) || 
                            (n.targetID === parentID && n.sourceID === node.IDStr))
                        });
                        
                        if(!nodeRel){
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
        for (const relNode of reverseRelations.values()) { 
            const sourceNode = nodeMap.get(relNode.sourceID);
            if(sourceNode === undefined) continue;

            const targetNode = nodeMap.get(relNode.targetID);
            if (targetNode) {
                if(targetNode.IDArr.contains(sourceNode.IDStr)){
                    //如果是正向父子推导关系
                    links.push({
                        from: sourceNode.position,
                        to: targetNode.position,
                        text: this.escapeMermaidText(relNode.relationText),
                        isDashed: false,
                        isReverse: false,
                        sourceIDStr: sourceNode.IDStr,
                        targetIDStr: targetNode.IDStr
                    });
                } else {
                    // 反向连线：从当前节点指向目标节点，使用虚线和不同颜色
                    links.push({
                        from: sourceNode.position,
                        to: targetNode.position,
                        text: this.escapeMermaidText(relNode.relationText),
                        isDashed: true,
                        isReverse: true,
                        sourceIDStr: sourceNode.IDStr,
                        targetIDStr: targetNode.IDStr
                    });
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

        return mermaidStr;
    }

    // 辅助方法：计算当前已有的连线数量
    private countLinks(mermaidStr: string): number {
        const linkMatches = mermaidStr.match(/-->/g) || [];
        const dashedLinkMatches = mermaidStr.match(/\.->/g) || [];
        return linkMatches.length + dashedLinkMatches.length;
    }

    // 查找当前文件是否在某个 MOC 树中
    async findNodeInMOCTrees(file: TFile): Promise<{ allNodes: ZKNode[], currentNode: ZKNode, mocFile: TFile } | null> {
        const mocFolder = this.plugin.settings.mocFolderPath;
        const headingTitle = this.plugin.settings.mocHeadingTitle;

        if (!mocFolder) return null;

        // 获取 MOC 文件夹中的所有文件
        const mocFiles = this.app.vault.getFiles().filter(f =>
            f.path.startsWith(mocFolder + '/') || f.path.startsWith(mocFolder)
        ).filter(f => f.extension === 'md');


        // 遍历每个 MOC 文件，查找当前文件
        for (const mocFile of mocFiles) {
            const mocParseResult = await parseMOCStructure(this.app, mocFile.path, headingTitle);

            if (mocParseResult.nodes.length > 0) {
                const mocNodes = await convertMOCToZKNodes(this.plugin, mocParseResult.nodes, mocParseResult.reverseRelations, [], mocParseResult.nodePositions);

                // 查找当前文件对应的节点
                const currentNode = mocNodes.find(n => n.file && n.file.path === file.path);

                if (currentNode) {
                    return {
                        allNodes: mocNodes,
                        currentNode: currentNode,
                        mocFile: mocFile
                    };
                }
            }
        }

        return null;
    }

    // 获取相关节点（上级、当前级、下级，默认3级）
    getRelatedNodes(allNodes: ZKNode[], currentNode: ZKNode, levels: number = 3): ZKNode[] {
        const currentDepth = currentNode.IDArr.length;
        const relatedNodes: ZKNode[] = [];

        // 计算要显示的层级范围
        // 默认显示：上级(currentDepth-1)、当前级(currentDepth)、下级(currentDepth+1)
        const minDepth = Math.max(1, currentDepth - Math.floor(levels / 2));
        const maxDepth = currentDepth + Math.ceil(levels / 2) - 1;

        for (const node of allNodes) {
            const nodeDepth = node.IDArr.length;

            // 检查是否在层级范围内
            if (nodeDepth < minDepth || nodeDepth > maxDepth) continue;

            // 检查是否是相关节点（需要在同一条路径上或是兄弟节点）
            if (this.isRelatedNode(currentNode, node, minDepth, maxDepth)) {
                relatedNodes.push(node);
            }
        }

        // 重新分配 position 以便渲染
        relatedNodes.forEach((node, index) => {
            node.position = index;
        });

        return relatedNodes;
    }

    // 判断节点是否与当前节点相关
    isRelatedNode(currentNode: ZKNode, targetNode: ZKNode, minDepth: number, maxDepth: number): boolean {
        const currentIDArr = currentNode.IDArr;
        const targetIDArr = targetNode.IDArr;
        const targetDepth = targetIDArr.length;

        // 如果是当前节点本身
        if (currentNode.IDStr === targetNode.IDStr) return true;

        // 上级节点：targetIDArr 是 currentIDArr 的前缀
        if (targetDepth < currentIDArr.length) {
            const currentPrefix = currentIDArr.slice(0, targetDepth);
            if (currentPrefix.join(',') === targetIDArr.join(',')) {
                return true;
            }
        }

        // 下级节点：currentIDArr 是 targetIDArr 的前缀
        if (targetDepth > currentIDArr.length) {
            const targetPrefix = targetIDArr.slice(0, currentIDArr.length);
            if (targetPrefix.join(',') === currentIDArr.join(',')) {
                return true;
            }
        }

        // 兄弟节点：有相同的父节点
        if (targetDepth === currentIDArr.length && targetDepth > 1) {
            const currentParent = currentIDArr.slice(0, -1).join(',');
            const targetParent = targetIDArr.slice(0, -1).join(',');
            if (currentParent === targetParent) {
                return true;
            }
        }

        return false;
    }

    // 渲染 MOC 节点的相关思维树
    async refreshLocalGraphMOCNode(graphMermaidDiv: HTMLElement, currentFile: TFile, allNodes: ZKNode[], currentNode: ZKNode, mocFile: TFile) {
        graphMermaidDiv.empty();

        // 计算要显示的图数量
        let graphCount = 0;
        if (this.plugin.settings.FamilyGraphToggle) graphCount++;
        if (this.plugin.settings.InOutlinksGraphToggle) graphCount++;

        // 安全检查：避免除以 0 或 NaN
        const safeCount = Math.max(graphCount, 1);
        const containerHeight = this.containerEl.offsetHeight || 400; // 默认高度 400px
        const graphHeight = Math.max(Math.floor(containerHeight / safeCount - 10), 200); // 最小高度 200px

        const mermaid = await loadMermaid();
        const svgPanZoom = require("svg-pan-zoom");

        // ========== 1. 思维树上下文 ==========
        if (this.plugin.settings.FamilyGraphToggle) {
            // 获取相关节点（上级、当前级、下级）
            const relatedNodes = this.getRelatedNodes(allNodes, currentNode, 3);

            if (relatedNodes.length > 0) {
                // 设置到 familyNodeArr 供其他功能使用
                this.familyNodeArr = relatedNodes;

                // 创建思维树容器
                const mocNodeGraphContainer = graphMermaidDiv.createDiv("zk-family-graph-container");
                const mocNodeGraphTextDiv = mocNodeGraphContainer.createDiv("zk-graph-text");
                mocNodeGraphTextDiv.empty();
                mocNodeGraphTextDiv.createEl('span', { text: t("mind tree context") });

                // 检查当前文件在哪些MOC文件中出现
                const mocFolder = this.plugin.settings.mocFolderPath;
                const headingTitle = this.plugin.settings.mocHeadingTitle;
                const availableMOCs: Array<{file: TFile, hasCurrentFile: boolean, allNodes: ZKNode[], currentNode: ZKNode | null}> = [];
                
                if (mocFolder) {
                    const mocFiles = this.app.vault.getMarkdownFiles()
                        .filter(f => f.path.startsWith(mocFolder + '/'));
                        
                    // 检查每个MOC文件是否包含当前文件
                    for (const mocFileCandidate of mocFiles) {
                        const tempParseResult = await parseMOCStructure(this.app, mocFileCandidate.path, headingTitle);
                        const tempNodes = await convertMOCToZKNodes(this.plugin, tempParseResult.nodes, tempParseResult.reverseRelations, [], tempParseResult.nodePositions);
                        const tempCurrentNode = tempNodes.find(n => n.file && n.file.path === currentFile.path);
                        const hasCurrentFile = !!tempCurrentNode;
                        availableMOCs.push({
                            file: mocFileCandidate, 
                            hasCurrentFile, 
                            allNodes: tempNodes, 
                            currentNode: tempCurrentNode || null
                        });
                    }
                }
                
                // 显示MOC选择器（始终显示下拉框，方便切换）
                if (availableMOCs.length > 0) {
                    // 创建下拉选择器
                    const mocSelector = mocNodeGraphTextDiv.createEl('select', { cls: 'zk-moc-selector' });
                    mocSelector.style.marginLeft = '10px';
                    mocSelector.style.padding = '4px 8px';
                    mocSelector.style.borderRadius = '4px';
                    mocSelector.style.border = '1px solid var(--background-modifier-border)';
                    mocSelector.style.backgroundColor = 'var(--background-primary)';
                    mocSelector.style.color = 'var(--text-normal)';
                    mocSelector.style.fontSize = '12px';
                    mocSelector.style.minWidth = '120px';
                    mocSelector.style.cursor = 'pointer';

                    // 优先显示包含当前文件的MOC
                    const sortedMOCs = [...availableMOCs].sort((a, b) => {
                        if (a.hasCurrentFile && !b.hasCurrentFile) return -1;
                        if (!a.hasCurrentFile && b.hasCurrentFile) return 1;
                        return a.file.basename.localeCompare(b.file.basename);
                    });

                    sortedMOCs.forEach((mocInfo) => {
                        const option = mocSelector.createEl('option');
                        option.value = mocInfo.file.path;
                        option.textContent = `${mocInfo.file.basename}${mocInfo.hasCurrentFile ? ' ✓' : ''}`;
                        if (mocInfo.file.path === mocFile.path) {
                            option.selected = true;
                        }
                    });

                    mocSelector.addEventListener('change', async () => {
                        const selectedMOC = sortedMOCs.find(m => m.file.path === mocSelector.value);
                        if (selectedMOC) {
                            if (selectedMOC.currentNode) {
                                // 刷新视图显示选中的MOC
                                await this.refreshLocalGraphMOCNode(
                                    graphMermaidDiv,
                                    currentFile,
                                    selectedMOC.allNodes,
                                    selectedMOC.currentNode,
                                    selectedMOC.file
                                );
                            } else {
                                // 选中的MOC不包含当前笔记，显示提示
                                new Notice(`"${selectedMOC.file.basename}" 不包含当前笔记`);
                            }
                        } else {
                            console.error('[graphView] 未找到选中的 MOC:', mocSelector.value);
                        }
                    });

                    // 如果当前文件在多个思维树中，添加提示
                    const mocsWithCurrentFile = availableMOCs.filter(m => m.hasCurrentFile);
                    if (mocsWithCurrentFile.length > 1) {
                        const hintSpan = mocNodeGraphTextDiv.createEl('small', {
                            text: ` (在${mocsWithCurrentFile.length}个思维树中)`,
                            cls: 'zk-moc-hint'
                        });
                        hintSpan.style.color = 'var(--text-muted)';
                        hintSpan.style.marginLeft = '4px';
                    }
                } else {
                    // 没有MOC文件时，显示当前MOC文件名（只读）
                    const mocFileInput = mocNodeGraphTextDiv.createEl('input', {
                        type: 'text',
                        cls: 'zk-moc-file-input',
                        value: mocFile.basename
                    });
                    mocFileInput.readOnly = true;
                    mocFileInput.style.marginLeft = '10px';
                    mocFileInput.style.padding = '2px 8px';
                    mocFileInput.style.border = '1px solid var(--background-modifier-border)';
                    mocFileInput.style.borderRadius = '4px';
                    mocFileInput.style.backgroundColor = 'var(--background-secondary)';
                    mocFileInput.style.color = 'var(--text-muted)';
                    mocFileInput.style.fontSize = '12px';
                    mocFileInput.style.cursor = 'pointer';
                    mocFileInput.title = mocFile.path;
                    // 点击输入框打开 MOC 文件
                    mocFileInput.addEventListener('click', () => {
                        this.app.workspace.openLinkText('', mocFile.path, 'tab');
                    });
                }

                // 添加图标按钮
                const graphIconDiv = mocNodeGraphContainer.createDiv("zk-graph-icon");
                graphIconDiv.empty();
                const expandBtn = new ExtraButtonComponent(graphIconDiv);
                expandBtn.setIcon("expand").setTooltip(t("expand graph"));

                // 创建图形容器
                const mocNodeTreeDiv = mocNodeGraphContainer.createEl("div", {
                    cls: "zk-graph-cytoscape"
                });
                mocNodeTreeDiv.id = "zk-moc-node-tree-cytoscape";
                mocNodeTreeDiv.style.height = `${graphHeight}px`;
                mocNodeTreeDiv.style.width = "100%";

                // 构建图形数据
                const graphData = GraphDataBuilder.fromFamilyNodes(relatedNodes, currentFile);

                // 配置渲染选项
                const options: RenderOptions = {
                    direction: (this.plugin.settings.DirectionOfFamilyGraph || 'TB') as 'TB' | 'BT' | 'LR' | 'RL',
                    layoutType: 'dagre',
                    animate: true,
                    animationDuration: 500,
                    nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
                    themeMode: this.plugin.settings.themeMode
                };
                expandBtn.onClick(() => {
                    try {
                        new CytoscapeExpandModal(this.app, t("mind tree context"), graphData, options).open();
                    } catch (error) {
                        console.error('[GraphView] expand mind tree failed', error);
                        new Notice('放大失败：思维树');
                    }
                });

                // 创建或复用渲染器
                if (this.familyGraphRenderer) {
                    this.familyGraphRenderer.destroy();
                }
                this.familyGraphRenderer = new CytoscapeRenderer();

                // 渲染图形
                await this.familyGraphRenderer.render(mocNodeTreeDiv, graphData, options);

                // 局部视图：禁用节点拖动（只查看）
                const cy = this.familyGraphRenderer.getCytoscapeInstance();
                if (cy) {
                    cy.nodes().ungrabify(); // 禁止拖动节点
                }

                // 监听节点点击事件
                mocNodeTreeDiv.addEventListener('node-click', (event: any) => {
                    const { node, ctrlKey, shiftKey, altKey } = event.detail;
                    if (!node.file) return;

                    if (ctrlKey) {
                        this.app.workspace.openLinkText("", node.file.path, 'tab');
                    } else if (shiftKey) {
                        this.plugin.retrivalforLocaLgraph = {
                            type: '1',
                            ID: node.ID,
                            filePath: node.file.path,
                        };
                        this.plugin.openGraphView();
                    } else if (altKey) {
                        this.plugin.clearShowingSettings();
                        this.plugin.settings.lastRetrival = {
                            type: 'main',
                            ID: node.ID,
                            displayText: node.displayText,
                            filePath: node.file.path,
                            openTime: '',
                        };
                        this.plugin.RefreshIndexViewFlag = true;
                        this.plugin.openIndexView();
                    } else {
                        this.app.workspace.openLinkText("", node.file.path);
                    }
                });

                // 监听节点悬停事件
                mocNodeTreeDiv.addEventListener('node-hover', (event: any) => {
                    const { node, event: mouseEvent } = event.detail;
                    if (!node || !node.file || !mouseEvent) return;

                    this.app.workspace.trigger('hover-link', {
                        event: mouseEvent,
                        source: 'zk-navigation',
                        hoverParent: mocNodeTreeDiv,
                        linktext: "",
                        targetEl: mouseEvent.target,
                        sourcePath: node.file.path,
                    });
                });
            }
        }

        // ========== 2. 出入链图 ==========
        if (this.plugin.settings.InOutlinksGraphToggle) {
            const inlinkArr = await this.getInlinks(currentFile);
            const outlinkArr = await this.getOutlinks(currentFile);

            // 使用 Cytoscape 渲染入链出链图
            await this.renderInOutLinksWithCytoscape(graphMermaidDiv, currentFile, inlinkArr, outlinkArr);
        }
    }

    // 检查文件是否在主笔记（索引笔记）目录下
    isFileInMainNoteFolders(file: TFile): boolean {
        // 如果没有配置文件夹列表，返回 true（默认监听所有文件）
        if (!this.plugin.settings.FolderList || this.plugin.settings.FolderList.length === 0) {
            return true;
        }

        const validFolders = [...new Set(this.plugin.settings.FolderList)].filter(folder => folder !== "");
        
        // 如果没有有效的文件夹配置，返回 true
        if (validFolders.length === 0) {
            return true;
        }

        // 检查文件是否在配置的文件夹中
        for (const folder of validFolders) {
            if (folder === '/') {
                // 根目录
                if (file.parent && file.parent.name === "") {
                    return true;
                }
            } else {
                // 检查文件路径是否以文件夹路径开头
                if (file.path.startsWith(folder + '/') || file.path === folder) {
                    return true;
                }
            }
        }

        // 如果配置了标签，检查文件是否有该标签
        if (this.plugin.settings.TagOfMainNotes && this.plugin.settings.TagOfMainNotes !== '') {
            const fileCache = this.app.metadataCache.getFileCache(file);
            if (fileCache) {
                // 检查 frontmatter 标签
                const fmTags = fileCache.frontmatter?.tags;
                if (fmTags) {
                    const tags = Array.isArray(fmTags) ? fmTags : [fmTags];
                    if (tags.some(tag => `#${tag}` === this.plugin.settings.TagOfMainNotes || tag === this.plugin.settings.TagOfMainNotes)) {
                        return true;
                    }
                }
                
                // 检查内容中的标签
                if (fileCache.tags) {
                    if (fileCache.tags.some(tagCache => tagCache.tag === this.plugin.settings.TagOfMainNotes)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    async onClose() {
        // 清理 Cytoscape 渲染器
        if (this.familyGraphRenderer) {
            this.familyGraphRenderer.destroy();
            this.familyGraphRenderer = null;
        }
        if (this.inoutlinksRenderer) {
            this.inoutlinksRenderer.destroy();
            this.inoutlinksRenderer = null;
        }
    }

    /**
     * 使用 Cytoscape 渲染家族图
     */
    async renderFamilyGraphWithCytoscape(
        container: HTMLElement,
        currentFile: TFile
    ): Promise<void> {
        // 创建家族图容器
        const familyGraphContainer = container.createDiv("zk-family-graph-container");
        const familyGraphTextDiv = familyGraphContainer.createDiv("zk-graph-text");
        familyGraphTextDiv.empty();
        familyGraphTextDiv.createEl('span', { text: t("close relative") });

        // 添加图标按钮
        const graphIconDiv = familyGraphContainer.createDiv("zk-graph-icon");
        graphIconDiv.empty();
        const expandBtn = new ExtraButtonComponent(graphIconDiv);
        expandBtn.setIcon("expand").setTooltip(t("expand graph"));

        // 创建图形容器
        const familyTreeDiv = familyGraphContainer.createEl("div", {
            cls: "zk-graph-cytoscape"
        });
        familyTreeDiv.id = "zk-family-tree-cytoscape";
        familyTreeDiv.style.height = `${this.graphHeight}px`;
        familyTreeDiv.style.width = "100%";

        // 构建图形数据
        const graphData = GraphDataBuilder.fromFamilyNodes(this.familyNodeArr, currentFile);

        // 配置渲染选项
        const options: RenderOptions = {
            direction: (this.plugin.settings.DirectionOfFamilyGraph || 'TB') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'dagre',  // 使用 dagre 布局，适合层级结构
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
            themeMode: this.plugin.settings.themeMode
        };
        expandBtn.onClick(() => {
            try {
                new CytoscapeExpandModal(this.app, t("close relative"), graphData, options).open();
            } catch (error) {
                console.error('[GraphView] expand family failed', error);
                new Notice('放大失败：思维树');
            }
        });

        // 创建或复用渲染器
        if (this.familyGraphRenderer) {
            this.familyGraphRenderer.destroy();
        }
        this.familyGraphRenderer = new CytoscapeRenderer();

        // 渲染图形
        await this.familyGraphRenderer.render(familyTreeDiv, graphData, options);

        // 监听节点点击事件
        familyTreeDiv.addEventListener('node-click', (event: any) => {
            const { node, ctrlKey, shiftKey, altKey } = event.detail;
                    if (!node.file) return;

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
            } else if (altKey) {
                // Alt + 点击：在索引视图中打开
                this.plugin.clearShowingSettings();
                this.plugin.settings.lastRetrival = {
                    type: 'main',
                    ID: node.ID,
                    displayText: node.displayText,
                    filePath: node.file.path,
                    openTime: '',
                };
                this.plugin.RefreshIndexViewFlag = true;
                this.plugin.openIndexView();
            } else {
                // 普通点击：打开文件
                this.app.workspace.openLinkText("", node.file.path);
            }
        });

        // 监听节点悬停事件（显示预览）
        familyTreeDiv.addEventListener('node-hover', (event: any) => {
            const { node, event: mouseEvent } = event.detail;
            if (!node || !node.file || !mouseEvent) return;

            // 触发 Obsidian 的悬停预览
            this.app.workspace.trigger('hover-link', {
                event: mouseEvent,
                source: 'zk-navigation',
                hoverParent: familyTreeDiv,
                linktext: "",
                targetEl: mouseEvent.target,
                sourcePath: node.file.path,
            });
        });
    }

    /**
     * 使用 Cytoscape 渲染 MOC 树
     */
    async renderMOCTreeWithCytoscape(
        container: HTMLElement,
        mocNodes: ZKNode[],
        headingTitle: string,
        graphHeight: number,
        reverseRelations: Map<string, ReverseRelation>,
        mocFile: TFile
    ): Promise<void> {
        // 创建 MOC 树图容器
        const mocGraphContainer = container.createDiv("zk-family-graph-container");
        const mocGraphTextDiv = mocGraphContainer.createDiv("zk-graph-text");
        mocGraphTextDiv.empty();
        mocGraphTextDiv.createEl('span', { text: `${headingTitle}` });

        // 添加图标按钮
        const graphIconDiv = mocGraphContainer.createDiv("zk-graph-icon");
        graphIconDiv.empty();
        
        // 全屏按钮
        const fullscreenBtn = new ExtraButtonComponent(graphIconDiv);
        fullscreenBtn.setIcon("maximize-2").setTooltip(t("fullscreen"));
        fullscreenBtn.onClick(() => {
            this.toggleFullscreen(mocGraphContainer);
        });
        
        // 展开按钮
        const expandBtn = new ExtraButtonComponent(graphIconDiv);
        expandBtn.setIcon("expand").setTooltip(t("expand graph"));

        // 创建图形容器
        const mocTreeDiv = mocGraphContainer.createEl("div", {
            cls: "zk-graph-cytoscape"
        });
        mocTreeDiv.id = "zk-moc-tree-cytoscape";
        mocTreeDiv.style.height = `${graphHeight}px`;
        mocTreeDiv.style.width = "100%";

        // 构建图形数据（使用 MOC 树专用方法）
        const graphData = GraphDataBuilder.fromMOCTree(mocNodes, reverseRelations, null);


        // 配置渲染选项
        const options: RenderOptions = {
            direction: (this.plugin.settings.DirectionOfFamilyGraph || 'TB') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'dagre',  // 使用 dagre 布局，适合层级结构
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
            themeMode: this.plugin.settings.themeMode
        };
        expandBtn.onClick(() => {
            try {
                new CytoscapeExpandModal(this.app, headingTitle, graphData, options).open();
            } catch (error) {
                console.error('[GraphView] expand moc tree failed', error);
                new Notice('放大失败：思维树');
            }
        });

        // 创建或复用渲染器（使用 familyGraphRenderer）
        if (this.familyGraphRenderer) {
            this.familyGraphRenderer.destroy();
        }
        this.familyGraphRenderer = new CytoscapeRenderer();

        // 渲染图形
        await this.familyGraphRenderer.render(mocTreeDiv, graphData, options);

        // GraphView：禁用节点拖动（只查看）
        const cy = this.familyGraphRenderer.getCytoscapeInstance();
        if (cy) {
            cy.nodes().ungrabify(); // 禁止拖动节点
        }

        // 监听节点点击事件
        mocTreeDiv.addEventListener('node-click', (event: any) => {
            const { node, ctrlKey, shiftKey, altKey } = event.detail;
                    if (!node.file) return;

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
            } else if (altKey) {
                // Alt + 点击：在索引视图中打开
                this.plugin.clearShowingSettings();
                this.plugin.settings.lastRetrival = {
                    type: 'main',
                    ID: node.ID,
                    displayText: node.displayText,
                    filePath: node.file.path,
                    openTime: '',
                };
                this.plugin.RefreshIndexViewFlag = true;
                this.plugin.openIndexView();
            } else {
                // 普通点击：打开文件
                this.app.workspace.openLinkText("", node.file.path);
            }
        });

        // 监听节点悬停事件
        mocTreeDiv.addEventListener('node-hover', (event: any) => {
            const { node, event: mouseEvent } = event.detail;
            if (!node || !node.file || !mouseEvent) return;

            this.app.workspace.trigger('hover-link', {
                event: mouseEvent,
                source: 'zk-navigation',
                hoverParent: mocTreeDiv,
                linktext: "",
                targetEl: mouseEvent.target,
                sourcePath: node.file.path,
            });
        });
    }

    /**
     * 使用 Cytoscape 渲染入链出链图
     */
    async renderInOutLinksWithCytoscape(
        container: HTMLElement,
        currentFile: TFile,
        inlinkArr: TFile[],
        outlinkArr: TFile[]
    ): Promise<void> {
        // 创建入链出链图容器
        const inoutlinksGraphContainer = container.createDiv("zk-inoutlinks-graph-container");
        const inoutlinksGraphTextDiv = inoutlinksGraphContainer.createDiv("zk-graph-text");
        inoutlinksGraphTextDiv.empty();
        inoutlinksGraphTextDiv.createEl('span', { text: t("inoutlinks") });

        // 添加图标按钮
        const graphIconDiv = inoutlinksGraphContainer.createDiv("zk-graph-icon");
        graphIconDiv.empty();
        
        // 展开按钮
        const expandBtn = new ExtraButtonComponent(graphIconDiv);
        expandBtn.setIcon("expand").setTooltip(t("expand graph"));

        // 创建图形容器
        const inoutlinksDiv = inoutlinksGraphContainer.createEl("div", {
            cls: "zk-graph-cytoscape"
        });
        inoutlinksDiv.id = "zk-inoutlinks-cytoscape";
        inoutlinksDiv.style.height = `${this.graphHeight}px`;
        inoutlinksDiv.style.width = "100%";

        // 构建图形数据
        const graphData = GraphDataBuilder.fromInOutLinks(currentFile, inlinkArr, outlinkArr);

        // 配置渲染选项
        const options: RenderOptions = {
            direction: (this.plugin.settings.DirectionOfInlinksGraph || 'TB') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'cose',  // 使用力导向布局，适合网络结构
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
            themeMode: this.plugin.settings.themeMode
        };
        expandBtn.onClick(() => {
            try {
                new CytoscapeExpandModal(this.app, t("inoutlinks"), graphData, options).open();
            } catch (error) {
                console.error('[GraphView] expand inoutlinks failed', error);
                new Notice('放大失败：出入链');
            }
        });

        // 创建或复用渲染器
        if (this.inoutlinksRenderer) {
            this.inoutlinksRenderer.destroy();
        }
        this.inoutlinksRenderer = new CytoscapeRenderer();

        // 渲染图形
        await this.inoutlinksRenderer.render(inoutlinksDiv, graphData, options);

        // 监听节点点击事件
        inoutlinksDiv.addEventListener('node-click', (event: any) => {
            const { node, ctrlKey, shiftKey, altKey } = event.detail;
            if (!node.file) return;

            if (ctrlKey) {
                // Ctrl + 点击：在新标签页打开
                this.app.workspace.openLinkText("", node.file.path, 'tab');
            } else if (shiftKey) {
                // Shift + 点击：在图形视图中打开
                this.plugin.retrivalforLocaLgraph = {
                    type: '1',
                    ID: '',
                    filePath: node.file.path,
                };
                this.plugin.openGraphView();
            } else if (altKey) {
                // Alt + 点击：在索引视图中打开
                if (this.plugin.settings.FolderOfIndexes !== '' && node.file && node.file.path.startsWith(this.plugin.settings.FolderOfIndexes)) {
                    this.plugin.clearShowingSettings();
                    this.plugin.settings.lastRetrival = {
                        type: 'index',
                        ID: '',
                        displayText: '',
                        filePath: node.file.path,
                        openTime: '',
                    };
                    this.plugin.RefreshIndexViewFlag = true;
                    this.plugin.openIndexView();
                } else {
                    const mainNote = this.plugin.MainNotes.find((n: any) => node.file && n.file.path === node.file.path);
                    if (mainNote && mainNote.file) {
                        this.plugin.clearShowingSettings();
                        this.plugin.settings.lastRetrival = {
                            type: 'main',
                            ID: mainNote.ID,
                            displayText: mainNote.displayText,
                            filePath: mainNote.file?.path,
                            openTime: '',
                        };
                        this.plugin.RefreshIndexViewFlag = true;
                        this.plugin.openIndexView();
                    }
                }
            } else {
                // 普通点击：打开文件
                this.app.workspace.openLinkText("", node.file.path);
            }
        });

        // 监听节点悬停事件
        inoutlinksDiv.addEventListener('node-hover', (event: any) => {
            const { node, event: mouseEvent } = event.detail;
            if (!node || !node.file || !mouseEvent) return;

            this.app.workspace.trigger('hover-link', {
                event: mouseEvent,
                source: 'zk-navigation',
                hoverParent: inoutlinksDiv,
                linktext: "",
                targetEl: mouseEvent.target,
                sourcePath: node.file.path,
            });
        });
    }

    /**
     * 切换图形容器的全屏状态
     */
    private toggleFullscreen(container: HTMLElement): void {
        if (!container.hasClass('zk-graph-fullscreen')) {
            // 进入全屏
            container.addClass('zk-graph-fullscreen');
            
            // 添加退出全屏的遮罩层
            const overlay = container.createDiv('zk-fullscreen-overlay');
            overlay.addEventListener('click', () => {
                this.exitFullscreen(container);
            });
            
            // 添加 ESC 键退出全屏
            const escHandler = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    this.exitFullscreen(container);
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
            container.dataset.escHandler = 'true';
        } else {
            // 退出全屏
            this.exitFullscreen(container);
        }
    }

    /**
     * 退出全屏
     */
    private exitFullscreen(container: HTMLElement): void {
        container.removeClass('zk-graph-fullscreen');
        const overlay = container.querySelector('.zk-fullscreen-overlay');
        if (overlay) {
            overlay.remove();
        }
    }


}
