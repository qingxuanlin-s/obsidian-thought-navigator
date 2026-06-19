import ZKNavigationPlugin from "main";
import { ExtraButtonComponent, FileView, ItemView, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { ZKNode, ZK_INDEX_TYPE, ZK_NAVIGATION } from "./indexView";
import { t } from "src/lang/helper";
import { convertMOCToZKNodes, getMOCFilesInFolder, isMocFile, parseMOCStructure, ReverseRelation } from "src/utils/utils";

import { CytoscapeExpandModal } from "src/modal/cytoscapeExpandModal";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { RenderOptions } from "src/renderer/types";
import { resolveThemeMode } from "src/utils/themeMode";

export const ZK_GRAPH_TYPE: string = "zk-graph-type"
export const ZK_GRAPH_VIEW: string = t("thought-local-graph")

type LocalGraphMode = 'overview' | 'navigation';
type LocalRelationCanvasMode = 'overview' | 'navigation';

interface LocalMocContext {
    file: TFile;
    allNodes: ZKNode[];
    currentNode: ZKNode | null;
}

export class ZKGraphView extends ItemView {

    plugin: ZKNavigationPlugin;
    familyNodeArr: ZKNode[] = [];
    graphHeight: number = 0;
    countOfGraphs: number = 0;

    // 防抖相关属性
    resizeTimeout: number | null = null;

    // Cytoscape 渲染器
    private familyGraphRenderer: CytoscapeRenderer | null = null;
    private inoutlinksRenderer: CytoscapeRenderer | null = null;
    private localGraphMode: LocalGraphMode = 'overview';

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

    private isUserFileLeaf(leaf: WorkspaceLeaf): boolean {
        const view = leaf.view as any;
        const viewType = view?.getViewType?.();
        return view instanceof FileView && ![
            ZK_INDEX_TYPE,
            ZK_GRAPH_TYPE,
            'zk-recent-type',
            'zk-moc-preview',
        ].includes(viewType);
    }

    private getFileOpenLeaf(forceTab: boolean): WorkspaceLeaf {
        const ws = this.app.workspace;
        const mode = forceTab ? 'tab' : (this.plugin.settings.defaultFileOpenMode || 'tab');
        const contentLeaves: WorkspaceLeaf[] = [];
        ws.iterateRootLeaves((leaf) => { if (this.isUserFileLeaf(leaf)) contentLeaves.push(leaf); });
        const recent = ws.getMostRecentLeaf();
        const anchor = recent && contentLeaves.includes(recent) ? recent : (contentLeaves[0] ?? null);

        const splitBesideGraph = (before: boolean): WorkspaceLeaf => ws.createLeafBySplit(this.leaf, 'vertical', before);
        if (mode === 'split-left') return splitBesideGraph(true);
        if (mode === 'split-right') return splitBesideGraph(false);
        if (mode === 'tab') {
            if (anchor) {
                ws.setActiveLeaf(anchor, { focus: false });
                return ws.getLeaf('tab');
            }
            return splitBesideGraph(false);
        }
        return anchor ?? splitBesideGraph(false);
    }

    private openFileInPreferredLeaf(file: TFile, forceTab: boolean): void {
        this.getFileOpenLeaf(forceTab).openFile(file);
    }

    onResize() {

        if (this.app.workspace.getLeavesOfType(ZK_GRAPH_TYPE).length > 0) {

            // 使用防抖来避免频繁触发刷新
            if (this.resizeTimeout) {
                window.clearTimeout(this.resizeTimeout);
            }

            this.resizeTimeout = window.setTimeout(() => {
                this.app.workspace.trigger("zk-navigation:refresh-local-graph");
                this.resizeTimeout = null;
            }, 300);
        }
    }

    private isIndexViewActive(): boolean {
        return this.app.workspace.activeLeaf?.view.getViewType() === ZK_INDEX_TYPE;
    }

    async onOpen() {
        this.refreshLocalGraph();
    }

    private applyLocalGraphTheme(containerEl: HTMLElement): void {
        containerEl.addClass('zk-view-content');
        containerEl.toggleClass('zk-theme-light', resolveThemeMode(this.plugin.settings.themeMode) === 'light');
        containerEl.toggleClass('zk-theme-dark', resolveThemeMode(this.plugin.settings.themeMode) !== 'light');
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
        let changeRefreshTimer: number | null = null;

        const smartChangeRefresh = () => {
            const now = Date.now();
            const timeSinceLastEdit = now - lastEditTime;

            // 如果最后编辑在 2 秒内，说明还在编辑，再延迟 5 秒
            if (timeSinceLastEdit < 2000) {
                if (changeRefreshTimer) {
                    window.clearTimeout(changeRefreshTimer);
                }
                changeRefreshTimer = window.setTimeout(smartChangeRefresh, 5000);
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
                    changeRefreshTimer = window.setTimeout(smartChangeRefresh, 5000);
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
            if (leaf?.view.getViewType() === ZK_INDEX_TYPE) return;

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
        if (this.isIndexViewActive()) return;

        let { containerEl } = this;
        containerEl.empty();
        this.applyLocalGraphTheme(containerEl);

        this.countGraphs();
        // 安全检查：避免除以 0 或 NaN
        const safeCount = Math.max(this.countOfGraphs, 1);
        const containerHeight = containerEl.offsetHeight || 400; // 默认高度 400px
        this.graphHeight = Math.max(Math.floor(containerHeight / safeCount - 10), 200); // 最小高度 200px

        const graphWrapper = containerEl.createDiv("zk-graph-mermaid-wrapper");
        const graphMermaidDiv = graphWrapper.createDiv("zk-graph-mermaid-container");
        graphWrapper.toggleClass('zk-local-light-surface', resolveThemeMode(this.plugin.settings.themeMode) === 'light');
        graphWrapper.toggleClass('zk-local-dark-surface', resolveThemeMode(this.plugin.settings.themeMode) !== 'light');
        graphMermaidDiv.toggleClass('zk-local-light-surface', resolveThemeMode(this.plugin.settings.themeMode) === 'light');
        graphMermaidDiv.toggleClass('zk-local-dark-surface', resolveThemeMode(this.plugin.settings.themeMode) !== 'light');

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
        return isMocFile(file);
    }

    // MOC 模式下的局部关系视图渲染
    async refreshLocalGraphMOC(graphMermaidDiv: HTMLElement, mocFile: TFile) {
        graphMermaidDiv.empty();
        graphMermaidDiv.addClass('zk-moc-file-local-view');

        // 计算要显示的图数量
        let graphCount = 0;
        if (this.plugin.settings.FamilyGraphToggle) graphCount++;
        if (this.plugin.settings.InOutlinksGraphToggle) graphCount++;

        // 安全检查：避免除以 0 或 NaN
        const safeCount = Math.max(graphCount, 1);
        const containerHeight = this.containerEl.offsetHeight || 400; // 默认高度 400px
        const containerWidth = this.containerEl.clientWidth || 720;
        const isNarrow = containerWidth < 760;
        const targetGraphHeight = safeCount > 1 ? containerHeight * 0.52 : containerHeight - 16;
        const graphHeight = Math.round(Math.max(isNarrow ? 320 : 420, Math.min(targetGraphHeight, isNarrow ? 540 : 680)));

        const headingTitle = this.plugin.settings.mocHeadingTitle;
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
                errorDiv.setCssStyles({
                    padding: "20px",
                    textAlign: "center",
                });
                
                // 显示调试信息
                if (mocParseResult.metadata.parseTime > 0) {
                    const debugInfo = emptyContainer.createDiv("zk-debug-info");
                    debugInfo.setCssStyles({
                        padding: "20px",
                        color: "var(--text-muted)",
                        fontSize: "12px",
                    });
                    debugInfo.createEl('p', { text: `${t("parse time")}: ${mocParseResult.metadata.parseTime}ms` });
                    debugInfo.createEl('p', { text: `${t("file path")}: ${mocParseResult.metadata.filePath}` });
                    debugInfo.createEl('p', { text: `${t("heading title")}: ${mocParseResult.metadata.headingTitle}` });
                    debugInfo.createEl('p', { text: `${t("moc heading missing hint")} "# ${headingTitle}"` });
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
            const link = activeDocument.createElement('a');
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
                    this.openFileInPreferredLeaf(node.file, event.ctrlKey || event.metaKey);
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
            const link = activeDocument.createElement('a');
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
                    this.openFileInPreferredLeaf(targetFile!, event.ctrlKey || event.metaKey);
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

    // 查找当前文件是否在某个 MOC 树中
    async findNodeInMOCTrees(file: TFile): Promise<{ allNodes: ZKNode[], currentNode: ZKNode, mocFile: TFile } | null> {
        const mocFolder = this.plugin.settings.mocFolderPath;
        const headingTitle = this.plugin.settings.mocHeadingTitle;
        const scanned = new Set<string>();

        // 优先使用反向索引，只解析候选 MOC
        const candidateMocFiles: TFile[] = [];
        if (this.plugin.mocReverseIndex?.isInitialized) {
            const locations = this.plugin.mocReverseIndex.query(file.path);
            for (const location of locations) {
                const mocFile = this.app.vault.getFileByPath(location.mocFilePath);
                if (mocFile) {
                    candidateMocFiles.push(mocFile);
                    scanned.add(mocFile.path);
                }
            }
        }

        // 兜底：反向索引未初始化或无结果时，做全量扫描
        if (candidateMocFiles.length === 0) {
            candidateMocFiles.push(...getMOCFilesInFolder(this.app, mocFolder || ''));
        } else if (mocFolder) {
            // 补充同目录 MOC，避免索引延迟导致漏查
            for (const mocFile of getMOCFilesInFolder(this.app, mocFolder)) {
                if (!scanned.has(mocFile.path)) {
                    candidateMocFiles.push(mocFile);
                }
            }
        }

        // 遍历候选 MOC 文件，查找当前文件
        for (const mocFile of candidateMocFiles) {
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

    private getLocalNodeLabel(node: ZKNode): string {
        return this.cleanLocalLabel(node.title || node.displayText || node.file?.basename || node.IDStr || node.ID);
    }

    private getLocalFileLabel(file: TFile): string {
        return this.cleanLocalLabel(file.basename);
    }

    private cleanLocalLabel(label: string): string {
        return label
            .replace(/\\n/g, ' ')
            .replace(/^\s*[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)+(?:[:：]?\s+|$)/, '')
            .replace(/^\s*\d{8,14}(?:[-_]\d{4,6})?(?:[\s:：-]+|$)/, '')
            .trim() || label;
    }

    private truncateLabel(label: string, max = 10): string {
        const chars = Array.from(label);
        return chars.length > max ? chars.slice(0, max).join('') + '…' : label;
    }

    private isNodeMatchFile(node: ZKNode, file: TFile, mocPath: string, resolvedLinkCache: Map<string, TFile | null>): boolean {
        if (node.file?.path === file.path) return true;

        const wikiLink = (node.wikiLink || '').trim();
        if (!wikiLink) return false;
        if (wikiLink === file.path || wikiLink === file.name || wikiLink === file.basename) return true;
        if (wikiLink.replace(/\.md$/i, '') === file.basename) return true;

        const basePath = mocPath.includes('/') ? mocPath.substring(0, mocPath.lastIndexOf('/')) : '';
        const cacheKey = `${basePath}::${wikiLink}`;
        let resolved: TFile | null;
        if (resolvedLinkCache.has(cacheKey)) {
            resolved = resolvedLinkCache.get(cacheKey) || null;
        } else {
            resolved = this.app.metadataCache.getFirstLinkpathDest(wikiLink, basePath);
            resolvedLinkCache.set(cacheKey, resolved);
        }
        return !!resolved && resolved.path === file.path;
    }

    private async getAvailableMocContexts(currentFile: TFile): Promise<LocalMocContext[]> {
        const mocFolder = this.plugin.settings.mocFolderPath;
        if (!mocFolder) return [];

        const headingTitle = this.plugin.settings.mocHeadingTitle;
        const resolvedLinkCache = new Map<string, TFile | null>();
        const contexts: LocalMocContext[] = [];

        for (const mocFileCandidate of getMOCFilesInFolder(this.app, mocFolder)) {
            const tempParseResult = await parseMOCStructure(this.app, mocFileCandidate.path, headingTitle);
            const tempNodes = await convertMOCToZKNodes(
                this.plugin,
                tempParseResult.nodes,
                tempParseResult.reverseRelations,
                [],
                tempParseResult.nodePositions
            );
            const tempCurrentNode = tempNodes.find(n => this.isNodeMatchFile(n, currentFile, mocFileCandidate.path, resolvedLinkCache)) || null;
            if (tempCurrentNode) {
                contexts.push({
                    file: mocFileCandidate,
                    allNodes: tempNodes,
                    currentNode: tempCurrentNode
                });
            }
        }

        return contexts.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
    }

    private renderLocalModeHeader(
        parent: HTMLElement,
        currentFile: TFile,
        allNodes: ZKNode[],
        currentNode: ZKNode,
        mocFile: TFile
    ): void {
        const header = parent.createDiv('zk-local-mode-header');
        const titleWrap = header.createDiv('zk-local-mode-title-wrap');
        titleWrap.createDiv('zk-local-mode-title').setText(this.getLocalFileLabel(currentFile));
        titleWrap.createDiv('zk-local-mode-subtitle').setText(mocFile.basename);

        const switcher = header.createDiv('zk-local-mode-switch');
        const modes: Array<{ mode: LocalGraphMode; label: string }> = [
            { mode: 'overview', label: t("overview") },
            { mode: 'navigation', label: t("navigation") }
        ];

        for (const item of modes) {
            const btn = switcher.createEl('button', {
                type: 'button',
                cls: `zk-local-mode-btn${this.localGraphMode === item.mode ? ' is-active' : ''}`,
                text: item.label
            });
            btn.addEventListener('click', async () => {
                if (this.localGraphMode === item.mode) return;
                this.localGraphMode = item.mode;
                await this.refreshLocalGraphMOCNode(parent, currentFile, allNodes, currentNode, mocFile);
            });
        }
    }

    private createLocalSection(parent: HTMLElement, title: string, subtitle?: string): {
        container: HTMLElement;
        body: HTMLElement;
        actions: HTMLElement;
    } {
        const container = parent.createDiv('zk-local-section-panel');
        const header = container.createDiv('zk-local-section-header');
        const titleWrap = header.createDiv('zk-local-section-title-wrap');
        titleWrap.createDiv('zk-local-section-title').setText(title);
        if (subtitle) {
            titleWrap.createDiv('zk-local-section-subtitle').setText(subtitle);
        }
        const actions = header.createDiv('zk-local-section-actions');
        const body = container.createDiv('zk-local-section-body');
        return { container, body, actions };
    }

    private renderMocContextControl(
        actions: HTMLElement,
        graphMermaidDiv: HTMLElement,
        currentFile: TFile,
        allNodes: ZKNode[],
        currentNode: ZKNode,
        mocFile: TFile,
        availableMOCs: LocalMocContext[]
    ): void {
        if (availableMOCs.length > 0) {
            const mocSelector = actions.createEl('select', { cls: 'zk-local-section-select' });
            availableMOCs.forEach((mocInfo) => {
                const option = mocSelector.createEl('option');
                option.value = mocInfo.file.path;
                option.textContent = mocInfo.file.basename;
                if (mocInfo.file.path === mocFile.path) {
                    option.selected = true;
                }
            });

            mocSelector.addEventListener('change', async () => {
                const selectedMOC = availableMOCs.find(m => m.file.path === mocSelector.value);
                if (selectedMOC && selectedMOC.currentNode) {
                    await this.refreshLocalGraphMOCNode(
                        graphMermaidDiv,
                        currentFile,
                        selectedMOC.allNodes,
                        selectedMOC.currentNode,
                        selectedMOC.file
                    );
                }
            });

            if (availableMOCs.length > 1) {
                actions.createDiv('zk-local-section-count').setText(`${availableMOCs.length}`);
            }
            return;
        }

        const mocButton = actions.createEl('button', {
            type: 'button',
            cls: 'zk-local-section-file',
            text: mocFile.basename
        });
        mocButton.title = mocFile.path;
        mocButton.addEventListener('click', () => {
            this.app.workspace.openLinkText('', mocFile.path, 'tab');
        });
    }

    private findNodeForFile(allNodes: ZKNode[], file: TFile): ZKNode | null {
        return allNodes.find((node) => node.file?.path === file.path) || null;
    }

    private async focusLocalFile(graphMermaidDiv: HTMLElement, file: TFile): Promise<void> {
        const result = await this.findNodeInMOCTrees(file);
        if (result) {
            await this.refreshLocalGraphMOCNode(
                graphMermaidDiv,
                file,
                result.allNodes,
                result.currentNode,
                result.mocFile
            );
            return;
        }

        this.openFileInPreferredLeaf(file, false);
    }

    private resolveLocalGraphNode(allNodes: ZKNode[], rawNode: ZKNode | null | undefined): ZKNode | null {
        if (!rawNode) return null;
        return allNodes.find((node) =>
            node.IDStr === rawNode.IDStr ||
            node.ID === rawNode.ID ||
            node.IDStr === rawNode.ID ||
            node.ID === rawNode.IDStr
        ) || rawNode;
    }

    private async focusLocalMocNode(
        graphMermaidDiv: HTMLElement,
        currentFile: TFile,
        allNodes: ZKNode[],
        mocFile: TFile,
        node: ZKNode
    ): Promise<void> {
        await this.refreshLocalGraphMOCNode(
            graphMermaidDiv,
            node.file || currentFile,
            allNodes,
            node,
            mocFile
        );
    }

    // 渲染 MOC 节点的相关思维树
    async refreshLocalGraphMOCNode(graphMermaidDiv: HTMLElement, currentFile: TFile, allNodes: ZKNode[], currentNode: ZKNode, mocFile: TFile) {
        graphMermaidDiv.empty();
        this.renderLocalModeHeader(graphMermaidDiv, currentFile, allNodes, currentNode, mocFile);

        const availableMOCs = await this.getAvailableMocContexts(currentFile);

        if (this.localGraphMode === 'navigation') {
            await this.renderFocusNavigation(graphMermaidDiv, currentFile, allNodes, currentNode, mocFile, availableMOCs);
            return;
        }

        await this.renderOverviewMode(graphMermaidDiv, currentFile, allNodes, currentNode, mocFile, availableMOCs);
    }

    private async renderOverviewMode(
        graphMermaidDiv: HTMLElement,
        currentFile: TFile,
        allNodes: ZKNode[],
        currentNode: ZKNode,
        mocFile: TFile,
        availableMOCs: LocalMocContext[]
    ): Promise<void> {
        const containerHeight = this.containerEl.offsetHeight || 400;

        if (this.plugin.settings.FamilyGraphToggle) {
            const relatedNodes = this.getRelatedNodes(allNodes, currentNode, 3);
            this.familyNodeArr = relatedNodes;
            const inlinkArr = this.plugin.settings.InOutlinksGraphToggle ? await this.getInlinks(currentFile) : [];
            const outlinkArr = this.plugin.settings.InOutlinksGraphToggle ? await this.getOutlinks(currentFile) : [];
            const showRail = this.plugin.settings.InOutlinksGraphToggle && (inlinkArr.length > 0 || outlinkArr.length > 0);
            const railReserve = showRail ? 110 : 0;
            const graphHeight = Math.max(containerHeight - 110 - railReserve, 220);

            const section = this.createLocalSection(graphMermaidDiv, t("overview"));
            section.container.addClass('zk-family-graph-container');
            section.container.addClass('zk-overview-graph-container');
            this.renderMocContextControl(section.actions, graphMermaidDiv, currentFile, allNodes, currentNode, mocFile, availableMOCs);

            if (relatedNodes.length === 0 && inlinkArr.length === 0 && outlinkArr.length === 0) {
                section.body.createDiv('zk-local-empty').setText(t("no local relations"));
            } else {
                const mocNodeTreeDiv = section.body.createEl("div", {
                    cls: "zk-graph-cytoscape zk-local-cytoscape"
                });
                mocNodeTreeDiv.id = "zk-moc-node-tree-cytoscape";
                mocNodeTreeDiv.setCssStyles({
                    height: `${graphHeight}px`,
                    width: "100%",
                });

                const graphData = GraphDataBuilder.fromFamilyNodes(relatedNodes, currentFile);
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
                    readOnly: true,
                    showMinimap: false
                };

                const expandBtn = new ExtraButtonComponent(section.actions);
                expandBtn.setIcon("expand").setTooltip(t("expand graph"));
                expandBtn.onClick(() => {
                    try {
                        new CytoscapeExpandModal(this.app, t("local relations"), graphData, options).open();
                    } catch (error) {
                        console.error('[GraphView] expand mind tree failed', error);
                        new Notice(t("expand local relations failed"));
                    }
                });

                if (this.familyGraphRenderer) {
                    this.familyGraphRenderer.destroy();
                }
                this.familyGraphRenderer = new CytoscapeRenderer();
                await this.familyGraphRenderer.render(mocNodeTreeDiv, graphData, options);

                const cy = this.familyGraphRenderer.getCytoscapeInstance();
                if (cy) {
                    cy.nodes().ungrabify();
                }
                this.familyGraphRenderer.fitAndCenter();

                const handleLocalNodeClick = async (event: any, textNodeOnly: boolean = false) => {
                    const detail = event.detail || {};
                    const triggerEvent = detail.event as MouseEvent | undefined;
                    const ctrlKey = detail.ctrlKey || triggerEvent?.ctrlKey;
                    const metaKey = detail.metaKey || triggerEvent?.metaKey;
                    const shiftKey = detail.shiftKey || triggerEvent?.shiftKey;
                    const altKey = detail.altKey || triggerEvent?.altKey;
                    const clicked = this.resolveLocalGraphNode(allNodes, detail.node);
                    if (!clicked) return;

                    if (!clicked?.file) {
                        await this.focusLocalMocNode(graphMermaidDiv, currentFile, allNodes, mocFile, clicked);
                        return;
                    }

                    if (textNodeOnly) return;

                    if (ctrlKey || metaKey) {
                        this.openFileInPreferredLeaf(clicked.file, true);
                    } else if (shiftKey) {
                        this.plugin.retrivalforLocaLgraph = {
                            type: '1',
                            ID: clicked.ID,
                            filePath: clicked.file.path,
                        };
                        this.plugin.openGraphView();
                    } else if (altKey) {
                        this.plugin.clearShowingSettings();
                        this.plugin.settings.lastRetrival = {
                            type: 'main',
                            ID: clicked.ID,
                            displayText: clicked.displayText,
                            filePath: clicked.file.path,
                            openTime: '',
                        };
                        this.plugin.RefreshIndexViewFlag = true;
                        this.plugin.openIndexView();
                    } else {
                        this.openFileInPreferredLeaf(clicked.file, false);
                    }
                };

                mocNodeTreeDiv.addEventListener('node-click', (event: any) => {
                    void handleLocalNodeClick(event);
                });

                mocNodeTreeDiv.addEventListener('node-select', (event: any) => {
                    void handleLocalNodeClick(event, true);
                });

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

            if (showRail) {
                this.renderFocusLinkRail(section.body, inlinkArr, outlinkArr);
            }
            return;
        }

        if (this.plugin.settings.InOutlinksGraphToggle) {
            const inlinkArr = await this.getInlinks(currentFile);
            const outlinkArr = await this.getOutlinks(currentFile);
            await this.renderInOutLinksWithCytoscape(graphMermaidDiv, currentFile, inlinkArr, outlinkArr);
        }
    }

    private getParentNode(allNodes: ZKNode[], currentNode: ZKNode): ZKNode | null {
        const currentId = currentNode.IDStr || currentNode.ID;
        if (currentId?.includes('.')) {
            const parentId = currentId.split('.').slice(0, -1).join('.');
            return allNodes.find((node) => node.IDStr === parentId || node.ID === parentId) || null;
        }
        if (currentNode.IDArr.length <= 1) return null;
        const parentId = currentNode.IDArr.slice(0, -1).toString();
        return allNodes.find((node) => node.IDArr.toString() === parentId || node.IDStr === parentId || node.ID === parentId) || null;
    }

    private getChildNodes(allNodes: ZKNode[], currentNode: ZKNode): ZKNode[] {
        const currentId = currentNode.IDStr || currentNode.ID;
        if (currentId) {
            const currentDepth = currentId.split('.').length;
            return allNodes.filter((node) => {
                const nodeId = node.IDStr || node.ID;
                return nodeId.startsWith(`${currentId}.`) && nodeId.split('.').length === currentDepth + 1;
            });
        }
        return allNodes.filter((node) =>
            node.IDArr.length === currentNode.IDArr.length + 1 &&
            node.IDArr.slice(0, currentNode.IDArr.length).join(',') === currentNode.IDArr.join(',')
        );
    }

    private getSiblingNodes(allNodes: ZKNode[], currentNode: ZKNode): ZKNode[] {
        const currentId = currentNode.IDStr || currentNode.ID;
        if (currentId?.includes('.')) {
            const parentId = currentId.split('.').slice(0, -1).join('.');
            const currentDepth = currentId.split('.').length;
            return allNodes.filter((node) => {
                const nodeId = node.IDStr || node.ID;
                return nodeId !== currentId &&
                    nodeId.startsWith(`${parentId}.`) &&
                    nodeId.split('.').length === currentDepth;
            });
        }
        if (currentNode.IDArr.length <= 1) return [];
        const parentPrefix = currentNode.IDArr.slice(0, -1).join(',');
        return allNodes.filter((node) =>
            node.IDStr !== currentNode.IDStr &&
            node.IDArr.length === currentNode.IDArr.length &&
            node.IDArr.slice(0, -1).join(',') === parentPrefix
        );
    }

    private async renderLocalRelationCanvas(
        section: { body: HTMLElement },
        graphMermaidDiv: HTMLElement,
        currentFile: TFile,
        allNodes: ZKNode[],
        currentNode: ZKNode,
        mocFile: TFile,
        inlinkArr: TFile[],
        outlinkArr: TFile[],
        mode: LocalRelationCanvasMode
    ): Promise<void> {
        const parentNode = this.getParentNode(allNodes, currentNode);
        const childNodes = this.getChildNodes(allNodes, currentNode);
        const siblingNodes = this.getSiblingNodes(allNodes, currentNode);
        const orderedPeers = [...siblingNodes, currentNode].sort((a, b) =>
            a.IDStr.localeCompare(b.IDStr, undefined, { numeric: true, sensitivity: 'base' })
        );
        const activePeerIndex = orderedPeers.findIndex((node) => node.IDStr === currentNode.IDStr);
        const leftSiblings = activePeerIndex >= 0 ? orderedPeers.slice(0, activePeerIndex) : siblingNodes.slice(0, Math.ceil(siblingNodes.length / 2));
        const rightSiblings = activePeerIndex >= 0 ? orderedPeers.slice(activePeerIndex + 1) : siblingNodes.slice(Math.ceil(siblingNodes.length / 2));

        const canvas = section.body.createDiv('zk-focus-radial-canvas');
        const canvasWidth = section.body.clientWidth || this.containerEl.clientWidth || 720;
        const canvasHeight = section.body.clientHeight || this.containerEl.clientHeight || 520;
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

        // ─── 默认全宽常量 & 估算 ───────────────────────────────
        const FULL_SIDE_W = 190;
        const FULL_CENTER_MAX_W = 320;
        const FULL_CENTER_MIN_W = 220;
        const SIBLING_CARD_H = 32;
        const CENTER_CARD_H = 80;
        const SIBLING_SPACING = 58;
        // sibling 半高 + 中心卡半高 + 间隔 → 死区半高(避让中心卡的纵向最小距离)
        const DEAD_ZONE_HALF = CENTER_CARD_H / 2 + SIBLING_CARD_H / 2 + 8;

        const parentRadius = clamp(canvasHeight * 0.3, 170, 235);
        const childRadius = clamp(canvasHeight * 0.25, 150, 190);

        // 默认 sideRadius(全宽假设)
        const defaultSideRadius = clamp(canvasWidth / 2 - 150, 150, 260);
        // 默认假设下,sibling 与中心卡是否会水平撞击
        const horizontalOverlap = defaultSideRadius - FULL_SIDE_W / 2 < FULL_CENTER_MAX_W / 2 + 8;

        // 评估「纵向避让」是否塞得下:
        // 同侧 sibling 数 N → 上方 ⌈N/2⌉ 槽,下方 N - ⌈N/2⌉ 槽,
        // 上方占用从中心向上 deadZone + (above-1)*spacing + sibling/2,
        // 还要给 parent 在更上方留位置;下方同理给 child 留位置。
        const visibleLeft = Math.min(leftSiblings.length, 4);
        const visibleRight = Math.min(rightSiblings.length, 4);
        const maxSidePerSide = Math.max(visibleLeft, visibleRight);
        const aboveSlots = Math.ceil(maxSidePerSide / 2);
        const belowSlots = maxSidePerSide - aboveSlots;
        const verticalUp = aboveSlots > 0
            ? DEAD_ZONE_HALF + (aboveSlots - 1) * SIBLING_SPACING + SIBLING_CARD_H / 2
            : 0;
        const verticalDown = belowSlots > 0
            ? DEAD_ZONE_HALF + (belowSlots - 1) * SIBLING_SPACING + SIBLING_CARD_H / 2
            : 0;
        // 还要保证 parent / child 不被挤
        const verticalNeededUp = Math.max(verticalUp, parentRadius + 16);
        const verticalNeededDown = Math.max(verticalDown, childRadius + 16);
        const verticalBudget = canvasHeight / 2 - 8;
        const verticallyFits = verticalNeededUp <= verticalBudget && verticalNeededDown <= verticalBudget;

        // 两段式决策:
        //   - 宽屏正常:全宽 + 对称 y(useVerticalAvoidance=false, horizontalOverlap=false)
        //   - 窄宽 & 纵向塞得下:保留全宽,sibling 改纵向避让(useVerticalAvoidance=true)
        //   - 窄宽 & 纵向塞不下:阶段 2,缩宽 + 联动 sideRadius + scale 兜底
        const useVerticalAvoidance = horizontalOverlap && verticallyFits;

        let sideCardMaxW: number;
        let centerCardMaxW: number;
        let centerCardMinW: number;
        let sideRadius: number;

        if (horizontalOverlap && !useVerticalAvoidance) {
            // 阶段 2:缩宽 + 联动
            sideCardMaxW = Math.round(clamp(canvasWidth * 0.28, 92, FULL_SIDE_W));
            centerCardMaxW = Math.round(clamp(canvasWidth * 0.42, 150, FULL_CENTER_MAX_W));
            centerCardMinW = Math.round(clamp(canvasWidth * 0.32, 130, FULL_CENTER_MIN_W));
            const minSideRadius = centerCardMaxW / 2 + sideCardMaxW / 2 + 8;
            sideRadius = clamp(
                Math.max(canvasWidth / 2 - sideCardMaxW * 0.6, minSideRadius),
                110,
                280
            );
        } else {
            // 宽屏 or 纵向避让:都用全宽
            sideCardMaxW = FULL_SIDE_W;
            centerCardMaxW = FULL_CENTER_MAX_W;
            centerCardMinW = FULL_CENTER_MIN_W;
            sideRadius = defaultSideRadius;
        }

        const childCount = Math.min(childNodes.length, 8);
        const childGap = childCount > 1
            ? clamp((canvasWidth - 280) / Math.max(1, childCount - 1), 100, 210)
            : 0;

        // intrinsic 宽度:辐射结构在不缩放时实际占据的水平像素
        const intrinsicWidth = 2 * sideRadius + sideCardMaxW + 24;
        const intrinsicHeight = parentRadius + childRadius + 180;
        const radialScale = clamp(
            Math.min(canvasWidth / intrinsicWidth, canvasHeight / intrinsicHeight, 1),
            0.55,
            1
        );

        // sibling y 计算:纵向避让模式下,跳过中心死区,先填上方再填下方
        const computeSiblingYs = (count: number): number[] => {
            if (count === 0) return [];
            if (!useVerticalAvoidance) {
                return Array.from({ length: count }, (_, i) =>
                    (i - (count - 1) / 2) * SIBLING_SPACING
                );
            }
            const above = Math.ceil(count / 2);
            const ys: number[] = [];
            for (let i = 0; i < above; i++) {
                ys.push(-DEAD_ZONE_HALF - (above - 1 - i) * SIBLING_SPACING);
            }
            for (let i = 0; i < count - above; i++) {
                ys.push(DEAD_ZONE_HALF + i * SIBLING_SPACING);
            }
            return ys;
        };

        const stage = canvas.createDiv('zk-focus-radial-stage');
        stage.setCssProps({ '--zk-focus-scale': String(radialScale) });
        stage.setCssProps({ '--zk-focus-card-max-w': `${sideCardMaxW}px` });
        stage.setCssProps({ '--zk-focus-center-min-w': `${centerCardMinW}px` });
        stage.setCssProps({ '--zk-focus-center-max-w': `${centerCardMaxW}px` });
        const edgeLayer = stage.createEl('div', { cls: 'zk-focus-edge-layer', attr: { 'aria-hidden': 'true' } });
        const centerZone = stage.createDiv('zk-focus-center-zone zk-focus-radial-center-zone');

        const openFile = (file: TFile, event?: MouseEvent | KeyboardEvent) => {
            this.openFileInPreferredLeaf(file, !!(event && ('ctrlKey' in event) && (event.ctrlKey || event.metaKey)));
        };

        const focusNode = async (node: ZKNode) => {
            const focusFile = node.file || currentFile;
            await this.refreshLocalGraphMOCNode(graphMermaidDiv, focusFile, allNodes, node, mocFile);
        };

        const appendNode = (
            label: string,
            variant: string,
            posClass: string,
            node?: ZKNode | null,
            file?: TFile | null,
            options: { index?: number; total?: number; x?: number; y?: number; parent?: HTMLElement; drawEdge?: boolean } = {}
        ) => {
            const host = options.parent || stage;
            const card = host.createEl('button', {
                type: 'button',
                cls: `zk-focus-card zk-focus-card-${variant} ${posClass}`,
                text: this.truncateLabel(label),
                attr: { title: label },
            });
            const targetFile = file || node?.file || null;
            if (typeof options.index === 'number') {
                card.setCssProps({ '--i': String(options.index) });
            }
            if (typeof options.total === 'number') {
                card.setCssProps({ '--n': String(Math.max(1, options.total)) });
            }
            if (typeof options.x === 'number' && typeof options.y === 'number') {
                card.setCssProps({ '--focus-card-transform': `translate(calc(-50% + ${options.x}px), calc(-50% + ${options.y}px))` });
            }

            card.addEventListener('click', async (event: MouseEvent) => {
                if (mode === 'overview') {
                    if (targetFile) openFile(targetFile, event);
                    return;
                }
                if (node) {
                    await focusNode(node);
                } else if (targetFile) {
                    await this.focusLocalFile(graphMermaidDiv, targetFile);
                }
            });
            card.addEventListener('dblclick', (event) => {
                if (targetFile) openFile(targetFile, event);
            });
            card.addEventListener('keydown', async (event: KeyboardEvent) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (targetFile) openFile(targetFile, event);
                } else if (event.key === ' ') {
                    event.preventDefault();
                    if (mode === 'overview') {
                        if (targetFile) openFile(targetFile, event);
                    } else if (node) {
                        await focusNode(node);
                    } else if (targetFile) {
                        await this.focusLocalFile(graphMermaidDiv, targetFile);
                    }
                }
            });

            if (targetFile) {
                card.addEventListener('mouseover', (event: MouseEvent) => {
                    this.app.workspace.trigger('hover-link', {
                        event,
                        source: 'zk-navigation',
                        hoverParent: canvas,
                        linktext: '',
                        targetEl: card,
                        sourcePath: targetFile.path,
                    });
                });
            }

            if (options.drawEdge === false) return card;

            const edge = edgeLayer.createDiv('zk-focus-edge zk-focus-edge-solid');
            const x = options.x ?? 0;
            const y = options.y ?? 0;
            const angle = Math.atan2(y, x) * 180 / Math.PI;
            const distance = Math.sqrt(x * x + y * y);
            const startInset = 104;
            const endInset = 72;
            const length = Math.max(18, distance - startInset - endInset);
            const startX = distance > 0 ? (x / distance) * startInset : 0;
            const startY = distance > 0 ? (y / distance) * startInset : 0;
            edge.setCssStyles({
                left: `calc(50% + ${startX}px)`,
                top: `calc(50% + ${startY}px)`,
                width: `${length}px`,
                transform: `translate(0, -50%) rotate(${angle}deg)`,
            });
            return card;
        };

        const focusLabel = this.getLocalNodeLabel(currentNode);
        const focusCard = centerZone.createEl('button', {
            type: 'button',
            cls: 'zk-focus-current-card',
            attr: { title: focusLabel },
        });
        focusCard.createSpan('zk-focus-current-title').setText(this.truncateLabel(focusLabel));
        focusCard.addEventListener('click', (event: MouseEvent) => {
            if (mode === 'overview' && currentNode.file) openFile(currentNode.file, event);
        });
        focusCard.addEventListener('dblclick', (event) => {
            if (currentNode.file) openFile(currentNode.file, event);
        });
        focusCard.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' && currentNode.file) {
                event.preventDefault();
                openFile(currentNode.file, event);
            }
        });

        if (parentNode) {
            appendNode(this.getLocalNodeLabel(parentNode), 'parent', 'zk-focus-pos-parent', parentNode, null, {
                x: 0,
                y: -parentRadius
            });
        }
        const leftSiblingArr = leftSiblings.slice(-4);
        const leftYs = computeSiblingYs(leftSiblingArr.length);
        leftSiblingArr.forEach((node, index, arr) => {
            appendNode(this.getLocalNodeLabel(node), 'sibling', 'zk-focus-pos-left', node, null, {
                index,
                total: arr.length,
                x: -sideRadius,
                y: leftYs[index]
            });
        });
        const rightSiblingArr = rightSiblings.slice(0, 4);
        const rightYs = computeSiblingYs(rightSiblingArr.length);
        rightSiblingArr.forEach((node, index, arr) => {
            appendNode(this.getLocalNodeLabel(node), 'sibling', 'zk-focus-pos-right', node, null, {
                index,
                total: arr.length,
                x: sideRadius,
                y: rightYs[index]
            });
        });
        childNodes.slice(0, 8).forEach((node, index, arr) => {
            const x = (index - (arr.length - 1) / 2) * childGap;
            appendNode(this.getLocalNodeLabel(node), 'child', 'zk-focus-pos-child', node, null, {
                index,
                total: arr.length,
                x,
                y: childRadius
            });
        });
        const overflow = Math.max(0, childNodes.length - 8);
        if (overflow > 0) {
            canvas.createDiv('zk-focus-radial-more').setText(`+${overflow}`);
        }

        this.renderFocusLinkRail(section.body, inlinkArr, outlinkArr);
    }

    private renderFocusLinkRail(
        sectionBody: HTMLElement,
        inlinkArr: TFile[],
        outlinkArr: TFile[]
    ): void {
        if (inlinkArr.length === 0 && outlinkArr.length === 0) return;

        const rail = sectionBody.createDiv('zk-focus-link-rail');

        const appendRow = (title: string, files: TFile[], variant: 'inlink' | 'outlink') => {
            if (files.length === 0) return;
            const row = rail.createDiv(`zk-focus-link-row zk-focus-link-row-${variant}`);
            const label = row.createDiv('zk-focus-link-row-label');
            label.createSpan('zk-focus-link-row-label-text').setText(title);
            label.createSpan('zk-focus-link-row-label-count').setText(String(files.length));
            const list = row.createDiv('zk-focus-link-row-list');

            files.forEach((file) => {
                const chip = list.createEl('button', {
                    type: 'button',
                    cls: `zk-focus-link-chip zk-focus-link-chip-${variant}`,
                    text: this.truncateLabel(this.getLocalFileLabel(file)),
                    attr: { title: file.basename },
                });
                chip.addEventListener('click', (event: MouseEvent) => {
                    this.openFileInPreferredLeaf(file, event.ctrlKey || event.metaKey);
                });
                chip.addEventListener('mouseover', (event: MouseEvent) => {
                    this.app.workspace.trigger('hover-link', {
                        event,
                        source: 'zk-navigation',
                        hoverParent: rail,
                        linktext: '',
                        targetEl: chip,
                        sourcePath: file.path,
                    });
                });
            });
        };

        appendRow(t("inlinks"), inlinkArr, 'inlink');
        appendRow(t("outlinks"), outlinkArr, 'outlink');
    }

    private async renderFocusNavigation(
        graphMermaidDiv: HTMLElement,
        currentFile: TFile,
        allNodes: ZKNode[],
        currentNode: ZKNode,
        mocFile: TFile,
        availableMOCs: LocalMocContext[]
    ): Promise<void> {
        const linkFile = currentNode.file || currentFile;
        const inlinkArr = await this.getInlinks(linkFile);
        const outlinkArr = await this.getOutlinks(linkFile);

        const section = this.createLocalSection(graphMermaidDiv, t("navigation"));
        section.container.addClass('zk-focus-nav-section');
        this.renderMocContextControl(section.actions, graphMermaidDiv, currentFile, allNodes, currentNode, mocFile, availableMOCs);
        await this.renderLocalRelationCanvas(
            section,
            graphMermaidDiv,
            currentFile,
            allNodes,
            currentNode,
            mocFile,
            inlinkArr,
            outlinkArr,
            'navigation'
        );
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
        mocGraphContainer.addClass('zk-moc-tree-section');
        const mocGraphTextDiv = mocGraphContainer.createDiv("zk-graph-text");
        mocGraphTextDiv.empty();
        mocGraphTextDiv.createEl('span', { text: `${headingTitle}` });

        // 添加图标按钮
        const graphIconDiv = mocGraphContainer.createDiv("zk-graph-icon");
        graphIconDiv.empty();
        
        // 全屏按钮
        const fullscreenBtn = new ExtraButtonComponent(graphIconDiv);
        fullscreenBtn.setIcon("expand").setTooltip(t("fullscreen"));
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
        mocTreeDiv.setCssStyles({
            height: `${graphHeight}px`,
            width: "100%",
            backgroundColor: resolveThemeMode(this.plugin.settings.themeMode) === 'light' ? '#f5f5f5' : '#2a2a2a',
        });

        // 构建图形数据（使用 MOC 树专用方法）
        const graphData = GraphDataBuilder.fromMOCTree(mocNodes, reverseRelations, null);


        // 配置渲染选项
        const options: RenderOptions = {
            app: this.app,
            direction: (this.plugin.settings.DirectionOfBranchGraph || 'LR') as 'TB' | 'BT' | 'LR' | 'RL',
            layoutType: 'dagre',  // 使用 dagre 布局，适合层级结构
            animate: true,
            animationDuration: 500,
            nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
            themeMode: resolveThemeMode(this.plugin.settings.themeMode),
            themeStyle: this.plugin.settings.themeStyle || 'modern',
            edgeStyle: this.plugin.settings.edgeStyle || 'bezier',
            readOnly: true,
            showMinimap: false
        };
        expandBtn.onClick(() => {
            try {
                new CytoscapeExpandModal(this.app, headingTitle, graphData, options).open();
            } catch (error) {
                console.error('[GraphView] expand moc tree failed', error);
                new Notice(t("expand mind tree failed"));
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
        mocTreeDiv.addEventListener('node-click', async (event: any) => {
            const detail = event.detail || {};
            const triggerEvent = detail.event as MouseEvent | undefined;
            const node = this.resolveLocalGraphNode(mocNodes, detail.node);
            const ctrlKey = detail.ctrlKey || triggerEvent?.ctrlKey;
            const shiftKey = detail.shiftKey || triggerEvent?.shiftKey;
            const altKey = detail.altKey || triggerEvent?.altKey;
            if (!node) return;
            if (!node.file) {
                await this.focusLocalMocNode(container, mocFile, mocNodes, mocFile, node);
                return;
            }

            if (ctrlKey) {
                // Ctrl + 点击：在新标签页打开
                this.openFileInPreferredLeaf(node.file, true);
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
                this.openFileInPreferredLeaf(node.file, false);
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
        const section = this.createLocalSection(
            container,
            t("inoutlinks"),
            `${t("inlinks")} ${inlinkArr.length} · ${t("outlinks")} ${outlinkArr.length}`
        );
        section.container.addClass('zk-inoutlinks-graph-container');
        if (this.isMOCFile(currentFile)) {
            section.container.addClass('zk-moc-inoutlinks-section');
        }
        const expandBtn = new ExtraButtonComponent(section.actions);
        expandBtn.setIcon("expand").setTooltip(t("expand graph"));

        // 创建卡片内容容器
        const inoutlinksContainer = section.body.createDiv("zk-inoutlinks-container");

        // 通用点击处理
        const handleFileClick = (file: TFile, e: MouseEvent) => {
            if (e.ctrlKey || e.metaKey) {
                this.openFileInPreferredLeaf(file, true);
            } else if (e.shiftKey) {
                this.plugin.retrivalforLocaLgraph = { type: '1', ID: '', filePath: file.path };
                this.plugin.openGraphView();
            } else {
                this.openFileInPreferredLeaf(file, false);
            }
        };

        // 悬停预览处理
        const handleFileHover = (file: TFile, e: MouseEvent, parent: HTMLElement) => {
            this.app.workspace.trigger('hover-link', {
                event: e,
                source: 'zk-navigation',
                hoverParent: parent,
                linktext: "",
                targetEl: e.target,
                sourcePath: file.path,
            });
        };

        // 获取文件图标名
        const getFileIcon = (file: TFile): string => {
            const ext = file.extension;
            if (ext === 'excalidraw' || file.basename.endsWith('.excalidraw')) return 'pen-tool';
            if (ext === 'canvas') return 'layout-dashboard';
            if (ext === 'pdf') return 'file-text';
            return 'file-text';
        };

        // 创建节点卡片
        const createNodeCard = (file: TFile, type: 'inlink' | 'outlink'): HTMLElement => {
            const card = activeDocument.createElement('div');
            card.className = `zk-iol-card zk-iol-card-${type}`;
            card.addEventListener('click', (e) => handleFileClick(file, e));
            card.addEventListener('mouseover', (e) => handleFileHover(file, e, inoutlinksContainer));

            const iconEl = card.createDiv('zk-iol-card-icon');
            setIcon(iconEl, getFileIcon(file));

            card.createEl('span', { cls: 'zk-iol-card-name', text: file.basename });

            return card;
        };

        // === 入链区域 ===
        // 入链标题（始终保留，避免只有出链时上半区塌陷）
        const inHeader = inoutlinksContainer.createDiv('zk-iol-header zk-iol-header-inlink');
        inHeader.createEl('span', { text: `${t("inlinks")} · ${inlinkArr.length}` });

        // 入链卡片网格
        const inGrid = inoutlinksContainer.createDiv('zk-iol-grid');
        if (inlinkArr.length > 0) {
            inlinkArr.forEach((file) => inGrid.appendChild(createNodeCard(file, 'inlink')));
        } else {
            inGrid.createDiv('zk-iol-empty').setText(t("no inlinks"));
        }

        // 连接线（始终保留，保持上下分区对称）
        inoutlinksContainer.createDiv('zk-iol-connector');

        // === 当前文件卡片 ===
        const centerCard = inoutlinksContainer.createDiv('zk-iol-center');
        const centerIcon = centerCard.createDiv('zk-iol-center-icon');
        setIcon(centerIcon, 'git-branch');
        centerCard.createEl('div', { cls: 'zk-iol-center-title', text: currentFile.basename });
        centerCard.addEventListener('click', (e) => handleFileClick(currentFile, e));

        // === 出链区域 ===
        // 连接线（始终保留，保证下半区结构稳定）
        inoutlinksContainer.createDiv('zk-iol-connector');

        // 出链卡片网格
        const outGrid = inoutlinksContainer.createDiv('zk-iol-grid');
        if (outlinkArr.length > 0) {
            outlinkArr.forEach((file) => outGrid.appendChild(createNodeCard(file, 'outlink')));
        } else {
            outGrid.createDiv('zk-iol-empty').setText(t("no outlinks"));
        }

        // 出链标题（始终放在底部）
        const outHeader = inoutlinksContainer.createDiv('zk-iol-header zk-iol-header-outlink');
        outHeader.createEl('span', { text: `${t("outlinks")} · ${outlinkArr.length}` });

        // 展开按钮：用 Cytoscape 渲染放大视图
        expandBtn.onClick(() => {
            try {
                const graphData = GraphDataBuilder.fromInOutLinks(currentFile, inlinkArr, outlinkArr);
                const options: RenderOptions = {
                    app: this.app,
                    direction: 'TB' as 'TB' | 'BT' | 'LR' | 'RL',
                    layoutType: 'preset',
                    animate: true,
                    animationDuration: 500,
                    nodeText: (this.plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
                    themeMode: resolveThemeMode(this.plugin.settings.themeMode),
                    themeStyle: this.plugin.settings.themeStyle || 'modern',
                    edgeStyle: this.plugin.settings.edgeStyle || 'bezier'
                };
                new CytoscapeExpandModal(this.app, t("inoutlinks"), graphData, options).open();
            } catch (error) {
                console.error('[GraphView] expand inoutlinks failed', error);
                new Notice(t("expand inoutlinks failed"));
            }
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
                    activeDocument.removeEventListener('keydown', escHandler);
                }
            };
            activeDocument.addEventListener('keydown', escHandler);
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
