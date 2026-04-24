import { Editor, FileView, loadMermaid, moment, Notice, Plugin, TFile, TFolder } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { mainNoteFuzzyModal, mainNoteModal } from "src/modal/mainNoteModal";
import { ZKNavigationSettngTab } from "src/settings/settings";
import { mainNoteInit, getMOCFilesInFolder } from "src/utils/utils";
import { createEmptyMOCJson } from "src/utils/mocJsonCodec";
import { MOCFileMonitor } from "src/utils/mocMonitor";
import { MOCEmbedRenderChild } from "src/embed/mocEmbedExporter";
import { MOCReverseIndex } from "src/utils/mocReverseIndex";
import { ZKGraphView, ZK_GRAPH_TYPE } from "src/view/graphView";
import { ZKIndexView, ZKNode, ZK_INDEX_TYPE, ZK_NAVIGATION } from "src/view/indexView";
import { ZK_RECENT_TYPE, ZKRecentView } from "src/view/recentView";
import { LayoutPreset, normalizeLayoutPreset } from "src/utils/growthDirection";

interface Point {
    x: number;
    y: number;
}

export interface ZoomPanScale{
    graphID: string;
    zoomScale: number;
    pan:Point;
}

export interface Retrival {
    type: string;
    ID: string;
    displayText: string;
    filePath: string;
    openTime: string;
}

export interface LocalRetrival {
    type: string; //'1': click graph to refresh localgraph; '2': open file to refresh localgraph
    ID: string;
    filePath: string;
}

export interface NodeCommand {
    id: string;
    name: string;
    icon: string;
    copyType:number;
    active: boolean;
}

//settings fields
interface ZKNavigationSettings {
    FolderOfMainNotes: string;
    FolderList:string[];
    FolderOfIndexes: string;
    MainNoteExt: string; // "all" or ".md only"
    StartingPoint: string;
    DisplayLevel: string;
    NodeText: string;
    FamilyGraphToggle: boolean;
    InlinksGraphToggle: boolean;
    OutlinksGraphToggle: boolean;
    InOutlinksGraphToggle: boolean;  // 出入链合并开关
    TagOfMainNotes: string; 
    IDFieldOption: string; // 3 options for ID field
    TitleField: string; // ID field option 1, specify a frontmatter field as note title
    IDField: string;    // ID field option 2, specify a frontmatter field as note ID
    Separator: string;  // ID field option 3, specify a separator to split filename
    OtherSeparator: string;
    IndexButtonText: string;
    SuggestMode: string;
    RedDashLine: boolean;
    zoomPanScaleArr:ZoomPanScale[];
    CustomCreatedTime: string;
    BranchTab: number;
    FileExtension:string; // "all" or ".md only"
    SectionTab:number;    
    DirectionOfBranchGraph: string;
    DirectionOfOutlinksGraph: string;
    BranchToolbra: boolean;
    RandomIndex: boolean;
    RandomMainNote: boolean;
    IndexButton: boolean;
    MainNoteButton: boolean;
    MainNoteButtonText: string;
    settingIcon:boolean;
    MainNoteSuggestMode: string;
    ListTree: boolean;
    HistoryList: Retrival[];
    HistoryToggle: boolean;
    HistoryMaxCount: number;
    exportCanvas: boolean;
    cardWidth: number;
    cardHeight: number;
    canvasFilePath: string;
    siblingsOrder: string;
    showAllToggle: boolean;
    showAll: boolean;
    outlineLayer: number;
    maxLenMainModel: number;
    maxLenIndexModel: number;
    lastRetrival: Retrival;
    NodeCommands: NodeCommand[];
    siblingLenToggle: boolean;
    displayTimeToggle: boolean;
    playControllerToggle: boolean;
    nodeColor: string;
    datetimeFormat: string;
    graphType: string;
    nodeClose: boolean;
    gitUncrossing: boolean;
    canvasSubpath: string;
    canvasCardColor: string;
    canvasArrowColor: string;
    headingMatchMode: string; // "string" or "regex"
    // MOC 模式相关设置
    mocModeEnabled: boolean;           // 是否启用 MOC 模式
    mocFolderPath: string;             // MOC 索引笔记所在文件夹
    mocHeadingTitle: string;           // 要解析的一级标题名称，如 "思维树"
    mocCurrentFile: string;            // 当前选中的 MOC 文件路径
    mocNodePositions: Record<string, Record<string, { x: number; y: number }>>; // MOC 节点位置存储 {mocFilePath: {nodeId: {x, y}}}
    smartConnection: boolean;          // 智能连线开关
    themeMode: 'dark' | 'light';       // 主题模式
    themeStyle: 'default' | 'modern';   // 主题风格（默认/现代）
    edgeStyle: 'straight' | 'bezier' | 'polyline'; // 连线风格
    nodeLayoutStyle: 'free' | 'auto';  // 节点布局风格（自由/自动）
    autoLayoutDefaultGrowthDirection: LayoutPreset; // 自动布局默认生长方向
    showNoteIdInBranchView: boolean;   // 分支视图是否显示笔记编号
}

//Default value for setting field
const DEFAULT_SETTINGS: ZKNavigationSettings = {
    FolderOfMainNotes: '',
    FolderList: [],
    FolderOfIndexes: '',
    MainNoteExt:"md",
    StartingPoint: 'parent',
    DisplayLevel: 'end',
    NodeText: "id-title",
    FamilyGraphToggle: true,
    InlinksGraphToggle: true,
    OutlinksGraphToggle: true,
    InOutlinksGraphToggle: true,  // 出入链默认开启
    TagOfMainNotes: '',
    IDFieldOption: '1',
    TitleField: '',
    IDField: '',
    Separator: ' ',
    OtherSeparator: "",
    IndexButtonText: t('📖index'),
    SuggestMode: 'fuzzySuggest',
    RedDashLine:false,
    zoomPanScaleArr:[],
    CustomCreatedTime: '',
    BranchTab: 0,
    FileExtension: "md",
    SectionTab: 0,
    DirectionOfBranchGraph: "LR",
    DirectionOfOutlinksGraph: "TB",
    BranchToolbra: true,
    RandomIndex: true,
    RandomMainNote: true,
    IndexButton: false,
    MainNoteButton: true,
    MainNoteButtonText: t("Main notes"),
    settingIcon: true,
    MainNoteSuggestMode: 'fuzzySuggest',
    ListTree: true,
    HistoryList: [],
    HistoryToggle: true,
    HistoryMaxCount: 20,
    exportCanvas: true,
    cardWidth: 400,
    cardHeight: 240,
    canvasFilePath: "",
    siblingsOrder: "number", 
    showAll: false,
    showAllToggle: true,
    outlineLayer: 2,
    maxLenMainModel: 100,
    maxLenIndexModel: 100,
    lastRetrival: {type:'', ID:'',displayText:'', filePath:'', openTime:''},
    NodeCommands: [],
    siblingLenToggle: false,
    displayTimeToggle: false,
    playControllerToggle: true,
    nodeColor: "#FFFFAA",
    datetimeFormat: "yyyy-MM-DD HH:mm",
    graphType: "structure",
    nodeClose: false,
    gitUncrossing: false,
    canvasSubpath: "",
    canvasCardColor: "#C0C0C0",
    canvasArrowColor: "#C0C0C0",
    headingMatchMode: "string",
    // MOC 模式默认值
    mocModeEnabled: true,
    mocFolderPath: '/',
    mocHeadingTitle: '思维树',
    mocCurrentFile: '',
    mocNodePositions: {}, // MOC 节点位置存储
    smartConnection: false, // 智能连线默认关闭
    themeMode: 'dark', // 默认深色主题
    themeStyle: 'modern', // 默认风格
    edgeStyle: 'bezier', // 默认贝塞尔曲线
    nodeLayoutStyle: 'free', // 默认自由节点布局
    autoLayoutDefaultGrowthDirection: 'bidirectional',
    showNoteIdInBranchView: true,
}

export default class ZKNavigationPlugin extends Plugin {

    settings: ZKNavigationSettings;
    MainNotes: ZKNode[] = [];
    retrivalforLocaLgraph: LocalRetrival = {
        type: '2',
        ID: '',
        filePath: '',
    };
    indexViewOffsetWidth: number = 0;
    indexViewOffsetHeight: number = 0;
    RefreshIndexViewFlag: boolean = false;
    mainNoteModal: boolean = false;
    indexModal: boolean = false;
    
    // MOC 文件监听器
    mocFileMonitor: MOCFileMonitor | null = null;
    // MOC 反向索引
    mocReverseIndex: MOCReverseIndex | null = null;
    private originalWindowOnError: OnErrorEventHandler | null = null;

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        )
        if ((this.settings as any).themeStyle === 'vivid') {
            this.settings.themeStyle = 'modern';
        }
        this.settings.autoLayoutDefaultGrowthDirection = normalizeLayoutPreset(
            this.settings.autoLayoutDefaultGrowthDirection
        );
    }

    applyTheme() {
        // 移除所有主题类
        document.body.removeClass('zk-theme-dark');
        document.body.removeClass('zk-theme-light');

        // 根据设置添加对应的主题类
        if (this.settings.themeMode === 'light') {
            document.body.addClass('zk-theme-light');
        } else {
            document.body.addClass('zk-theme-dark');
        }
    }

    async onload() {

        await this.loadSettings();

        // 注册 .moc 扩展名，使 Obsidian 在文件浏览器中显示并正确索引这些文件
        this.registerExtensions(['moc'], 'markdown');

        // 注册 ![[xxx.moc]] 内嵌处理：渲染为 PNG 图片附件
        // Reading View 通过 post-processor 处理
        this.registerMarkdownPostProcessor((element, context) => {
            const embeds = element.querySelectorAll<HTMLElement>('.internal-embed[src$=".moc"]');
            embeds.forEach(embedEl => {
                const src = embedEl.getAttribute('src');
                if (!src || embedEl.dataset.mocHandled) return;
                embedEl.dataset.mocHandled = '1';

                const basePath = context.sourcePath.includes('/')
                    ? context.sourcePath.substring(0, context.sourcePath.lastIndexOf('/'))
                    : '';
                const mocFile = this.app.metadataCache.getFirstLinkpathDest(src, basePath)
                    ?? this.app.vault.getFileByPath(src);
                if (!mocFile || !(mocFile instanceof TFile) || mocFile.extension !== 'moc') return;

                const child = new MOCEmbedRenderChild(embedEl, mocFile, this);
                context.addChild(child);
            });
        });

        // Live Preview 通过 MutationObserver 处理动态插入的 embed 元素
        const livePreviewEmbedChildren = new WeakMap<HTMLElement, MOCEmbedRenderChild>();
        const handleMocEmbed = (embedEl: HTMLElement) => {
            const src = embedEl.getAttribute('src');
            if (!src?.endsWith('.moc') || embedEl.dataset.mocHandled) return;
            embedEl.dataset.mocHandled = '1';

            const mocFile = this.app.metadataCache.getFirstLinkpathDest(src, '')
                ?? this.app.vault.getFileByPath(src);
            if (!mocFile || !(mocFile instanceof TFile) || mocFile.extension !== 'moc') return;

            const child = new MOCEmbedRenderChild(embedEl, mocFile, this);
            livePreviewEmbedChildren.set(embedEl, child);
            child.load();
        };

        const cleanupRemovedEmbed = (root: HTMLElement) => {
            const embeds: HTMLElement[] = [];
            if (root.dataset.mocHandled === '1') embeds.push(root);
            root.querySelectorAll<HTMLElement>('[data-moc-handled="1"]').forEach((el) => embeds.push(el));

            embeds.forEach((embedEl) => {
                const child = livePreviewEmbedChildren.get(embedEl);
                if (child) {
                    child.unload();
                    livePreviewEmbedChildren.delete(embedEl);
                }
            });
        };

        const mocEmbedObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (node.classList.contains('internal-embed')) handleMocEmbed(node);
                    node.querySelectorAll<HTMLElement>('.internal-embed').forEach(handleMocEmbed);
                }
                for (const node of Array.from(mutation.removedNodes)) {
                    if (!(node instanceof HTMLElement)) continue;
                    cleanupRemovedEmbed(node);
                }
            }
        });
        mocEmbedObserver.observe(document.body, { childList: true, subtree: true });
        this.register(() => mocEmbedObserver.disconnect());

        // 应用主题
        this.applyTheme();

        // 添加全局错误处理来忽略ResizeObserver错误
        this.originalWindowOnError = window.onerror;
        window.onerror = (message, source, lineno, colno, error) => {
            if (typeof message === 'string' && message.includes('ResizeObserver loop completed')) {
                // 忽略ResizeObserver循环错误
                return true;
            }
            if (this.originalWindowOnError) {
                return this.originalWindowOnError(message, source, lineno, colno, error);
            }
            return false;
        };
        
        this.registerObsidianProtocolHandler("zk-navigation",async (para)=>{

            if(para.file){             
                
                let file = this.app.vault.getFileByPath(para.file);

                if(!file){
                    new Notice(`zk-navigation: file "${para.file}" can't be found!`);
                    return;

                } 
                
                if(para.from && ["root","parent","index"].includes(para.from)){
                    this.settings.StartingPoint = para.from;
                    
                }
                if(para.to && ["next","end"].includes(para.to)){
                    this.settings.DisplayLevel = para.to;
                }
                if(para.text && ["id","title","both"].includes(para.text)){
                    this.settings.NodeText = para.text;
                }
                if(para.type && ["structure","roadmap"].includes(para.type)){
                    this.settings.graphType = para.type;
                }

                let indexFlag:boolean = false;
                
                if(this.settings.FolderOfIndexes !== ""){
                    if(para.file.startsWith(this.settings.FolderOfIndexes)){
                        indexFlag = true;
                        
                        this.settings.lastRetrival = {
                            type: 'index',
                            ID: '',
                            displayText: '',
                            filePath: file.path,
                            openTime: '',  
                        };
                        this.settings.zoomPanScaleArr = [];
                        this.settings.BranchTab = 0;
                        this.RefreshIndexViewFlag = true;
                        await this.openIndexView();
                    }
                }

                if(!indexFlag){
                    
                    this.settings.lastRetrival = {
                        type: 'main',
                        ID: '',
                        displayText: '',
                        filePath: file.path,
                        openTime: '',  
                    };
                    this.settings.zoomPanScaleArr = [];
                    this.settings.BranchTab = 0;
                    this.RefreshIndexViewFlag = true;
                    await this.openIndexView();
                }

            } else {
                new Notice(`zk-navigation: invalid uri`);
            }
        })

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, source) => {

                if (
                    !(
                        source === "more-options" ||
                        source === "tab-header" ||
                        source == "file-explorer-context-menu"
                    )
                ) {
                    return;
                }

                // 文件夹右键：新建思维树
                if (file instanceof TFolder) {
                    menu.addItem((item) => {
                        item.setTitle(t("New MOC file"))
                            .setIcon("git-branch")
                            .setSection("plugin")
                            .onClick(async () => {
                                try {
                                    const folder = file as TFolder;
                                    const baseName = '思维树-' + moment().format('YYYYMMDDHHmmss');
                                    const filePath = folder.path ? `${folder.path}/${baseName}.moc` : `${baseName}.moc`;
                                    const content = createEmptyMOCJson(
                                        this.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free'
                                    );
                                    await this.app.vault.create(filePath, content);
                                } catch (e) {
                                    console.error('[zk-navigation] 新建思维树失败', e);
                                    new Notice(`新建失败: ${e.message}`);
                                }
                            });
                    });
                    return;
                }

                if (!(file instanceof TFile)) {
                    return;
                }

                menu.addItem((item) => {
                    item.setTitle(t("Copy zk-navigation URI"))
                        .setIcon("copy")
                        .setSection("info")
                        .onClick(() =>

                            navigator.clipboard.writeText(`obsidian://zk-navigation?file=${encodeURI(file.path)}`)
                        );
                });
            })
        );

        this.addSettingTab(new ZKNavigationSettngTab(this.app, this));

        this.registerView(ZK_INDEX_TYPE, (leaf) => new ZKIndexView(leaf, this));

        this.registerView(ZK_GRAPH_TYPE, (leaf) => new ZKGraphView(leaf, this));

        this.registerView(ZK_RECENT_TYPE, (leaf) => new ZKRecentView(leaf, this));
              
        this.addRibbonIcon("tree-pine", t("open zk-index-graph"), async () => {
            
            this.openIndexView();
            
        })

        this.addCommand({
            id: "zk-index-graph",
            name: t("open zk-index-graph"),
            callback:async ()=>{
                
                this.openIndexView();
            }
        });

        this.addCommand({
            id: "zk-local-graph",
            name: t("open zk-local-graph"),
            callback: async ()=>{
                
                this.openGraphView();
            }
        });

        this.addCommand({
            id: "zk-index-graph-by-file",
            name: t("reveal current file in zk-index-graph"),
            callback: async ()=>{
                await this.revealFileInIndexView();
            }
        })


        this.addCommand({
            id: "zk-mainnote-modal",
            name: t("select a main note"),
            callback: async ()=>{
                this.mainNoteModal = true;
                await this.openIndexView();
            }
        })


        this.addCommand({
            id: "zk-index-modal",
            name: t("select an index"),
            callback: async ()=>{
                this.indexModal = true;
                await this.openIndexView();
            }
        })

        this.addCommand({
            id: "zk-new-moc-embed",
            name: t("New MOC file"),
            editorCallback: async (editor, view) => {
                const activeFile = view.file;
                if (!activeFile) return;
                try {
                    const folder = activeFile.parent;
                    const baseName = '思维树-' + moment().format('YYYYMMDDHHmmss');
                    const filePath = folder?.path ? folder.path + '/' + baseName + '.moc' : baseName + '.moc';
                    const mocContent = createEmptyMOCJson(this.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free');
                    const newFile = await this.app.vault.create(filePath, mocContent);
                    editor.replaceSelection('![[' + newFile.name + ']]');
                    this.settings.mocCurrentFile = newFile.path;
                    await this.saveData(this.settings);
                    this.app.workspace.trigger('zk-navigation:refresh-index-graph');
                } catch (e) {
                    new Notice('新建失败: ' + e.message);
                }
            }
        })

        // v0.5: 切换当前 MOC 的项目标记
        this.addCommand({
            id: "zk-toggle-project-flag",
            name: "切换当前 MOC 的项目标记",
            callback: async () => {
                const currentPath = this.settings.mocCurrentFile;
                if (!currentPath) {
                    new Notice("当前未选中 MOC 文件");
                    return;
                }
                const file = this.app.vault.getFileByPath(currentPath);
                if (!file) {
                    new Notice("当前 MOC 文件不存在");
                    return;
                }
                await this.toggleMOCProjectFlag(file);
            }
        })

        this.registerHoverLinkSource(
        ZK_NAVIGATION,
        {
            defaultMod:true,
            display:ZK_NAVIGATION,
        });     

        // 初始化 MOC 文件监听器（用于实时同步）
        this.mocFileMonitor = new MOCFileMonitor(this);
        this.mocFileMonitor.initialize();

        // 初始化 MOC 反向索引（后台构建）
        this.mocReverseIndex = new MOCReverseIndex(this.app);
        // 等 layout-ready 后再构建索引，确保 metadataCache 已初始化
        this.app.workspace.onLayoutReady(async () => {
            await this.mocReverseIndex?.initialize(
                this.settings.mocFolderPath,
                this.settings.mocHeadingTitle
            );
        });

        // 拦截 .moc 文件打开，用分支视图（IndexView）代替默认编辑器
        this.registerEvent(
            this.app.workspace.on('file-open', async (file) => {
                if (!file || !file.path.endsWith('.moc')) return;

                // 复用当前刚打开 .moc 的 leaf，直接切换成 IndexView，
                // 避免 detach markdown leaf 后 Obsidian 回退到上一个 markdown 文件，
                // 从而触发文件树错误定位。
                const activeLeaf = this.app.workspace.activeLeaf;
                this.settings.mocCurrentFile = file.path;
                await this.saveData(this.settings);

                if (activeLeaf?.view?.getViewType() === 'markdown') {
                    await activeLeaf.setViewState({
                        type: ZK_INDEX_TYPE,
                        state: {
                            file: file.path,
                        },
                        active: true,
                    });
                    this.app.workspace.revealLeaf(activeLeaf);
                } else {
                    await this.openIndexView();
                }

                this.app.workspace.trigger('zk-navigation:refresh-index-graph');
            })
        );

        // 监听文件重命名事件，更新 MOC 文件中的链接和反向索引
        this.registerEvent(
            this.app.vault.on("rename", async (file, oldPath) => {
                if (file instanceof TFile) {
                    // 更新反向索引中的笔记路径
                    if (this.mocReverseIndex) {
                        this.mocReverseIndex.handleNoteRename(oldPath, file.path);
                    }
                    await this.updateMOCLinksAfterRename(file, oldPath);
                }
            })
        );

    }

    async openIndexView() {
        const viewState = this.settings.mocCurrentFile
            ? {
                type: ZK_INDEX_TYPE,
                state: {
                    file: this.settings.mocCurrentFile,
                },
                active: true,
            }
            : {
                type: ZK_INDEX_TYPE,
                active: true,
            };
        const indexLeaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);

        if(indexLeaves.length === 0){
         await this.app.workspace.getLeaf('tab')?.setViewState(viewState);
        } else if (this.settings.mocCurrentFile) {
            await indexLeaves[0].setViewState(viewState);
        }
        
        this.app.workspace.revealLeaf(
         this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE)[0]
         
        );

        if(this.RefreshIndexViewFlag === true){
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        }

        if(this.mainNoteModal === true){

            if (this.settings.MainNoteSuggestMode === "IDOrder") {
                new mainNoteModal(this.app, this, this.MainNotes, (selectZKNode) =>{
                    if (!selectZKNode.file) return;
                    this.settings.lastRetrival = {
                        type: 'main',
                        ID: selectZKNode.ID,
                        displayText: selectZKNode.displayText,
                        filePath: selectZKNode.file.path,
                        openTime: moment().format("YYYY-MM-DD HH:mm:ss"),

                    }
                    this.clearShowingSettings();
                    this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                }).open();
            }else {
                new mainNoteFuzzyModal(this.app, this, this.MainNotes, (selectZKNode) =>{
                    if (!selectZKNode.file) return;
                    this.settings.lastRetrival = {
                        type: 'main',
                        ID: selectZKNode.ID,
                        displayText: selectZKNode.displayText,
                        filePath: selectZKNode.file.path,
                        openTime: moment().format("YYYY-MM-DD HH:mm:ss"),

                    }
                    this.clearShowingSettings();
                    this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                }).open()
            }

            this.mainNoteModal = false;
        }

        if(this.indexModal === true){

            if (this.settings.SuggestMode === "keywordOrder") {
                new indexModal(this.app, this, this.MainNotes, (index) => {
                    this.settings.lastRetrival = {
                        type: 'index',
                        ID: '',
                        displayText: index.keyword,
                        filePath: index.path,
                        openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                    
                    }
                    this.clearShowingSettings();
                    this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                }).open();
            } else {
                new indexFuzzyModal(this.app, this, this.MainNotes, (index) => {
                    this.settings.lastRetrival = {
                        type: 'index',
                        ID: '',
                        displayText: index.keyword,
                        filePath: index.path,
                        openTime: moment().format("YYYY-MM-DD HH:mm:ss"),
                    
                    }
                    this.clearShowingSettings();
                    this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                }).open();
            }

            this.indexModal = false;
        }

    }

    async openGraphView() {

       if(this.app.workspace.getLeavesOfType(ZK_GRAPH_TYPE).length === 0){
        await this.app.workspace.getRightLeaf(false)?.setViewState({
            type:ZK_GRAPH_TYPE,
            active:true,
        });
        
       }
       this.app.workspace.revealLeaf(
        this.app.workspace.getLeavesOfType(ZK_GRAPH_TYPE)[0]
       );
       this.app.workspace.trigger("zk-navigation:refresh-local-graph");
    }

    async openRecentView() {
        if(this.app.workspace.getLeavesOfType(ZK_RECENT_TYPE).length === 0){
         await this.app.workspace.getRightLeaf(false)?.setViewState({
             type:ZK_RECENT_TYPE,
             active:true,
         });
        }
        this.app.workspace.revealLeaf(
         this.app.workspace.getLeavesOfType(ZK_RECENT_TYPE)[0]
        );
        this.app.workspace.trigger("zk-navigation:refresh-recent-view");
    
    }

    async clearShowingSettings(BranchTab:number=0){
        this.settings.zoomPanScaleArr = [];
        this.settings.BranchTab = BranchTab;
    }

    async revealFileInIndexView(){
        
        let filePath = this.app.workspace.getActiveViewOfType(FileView)?.file?.path

        if(filePath){

            let indexFlag:boolean = false;

            if(this.settings.FolderOfIndexes !== "" && filePath.endsWith(".md")){
                if(filePath.startsWith(this.settings.FolderOfIndexes)){
                    indexFlag = true;
                    
                    this.settings.lastRetrival = {
                        type: 'index',
                        ID: '',
                        displayText: '',
                        filePath: filePath,
                        openTime: '',  
                    };
                    this.clearShowingSettings();
                    this.RefreshIndexViewFlag = true;
                    await this.openIndexView();
                    
                }
            }

            if(!indexFlag){

                await mainNoteInit(this);
                
                this.settings.lastRetrival = {
                    type: 'main',
                    ID: '',
                    displayText: '',
                    filePath: filePath,
                    openTime: '',  
                };
                this.clearShowingSettings();
                this.RefreshIndexViewFlag = true;
                await this.openIndexView();
            }
            return;            
        }
    }

    /**
     * v0.5: 切换 MOC 文件的项目标记(.moc JSON 里的 isProject 字段)
     * 命令面板和视图头部菜单共用
     */
    async toggleMOCProjectFlag(file: TFile): Promise<void> {
        if (file.extension !== 'moc') {
            new Notice("项目标记仅支持 .moc 文件");
            return;
        }
        try {
            const content = await this.app.vault.read(file);
            let json: any;
            try {
                json = JSON.parse(content);
            } catch {
                new Notice("MOC 文件格式异常,无法修改");
                return;
            }
            const next = !(json.isProject === true);
            if (next) {
                json.isProject = true;
            } else {
                delete json.isProject;
            }
            await this.app.vault.modify(file, JSON.stringify(json, null, 2));
            new Notice(next ? `📐 已标记为项目: ${file.basename}` : `已取消项目标记: ${file.basename}`);
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        } catch (e) {
            console.error('[zk-navigation] 切换项目标记失败', e);
            new Notice(`操作失败: ${e.message}`);
        }
    }

    /**
     * 文件重命名后更新所有 MOC 文件中的链接
     */
    async updateMOCLinksAfterRename(file: TFile, oldPath: string): Promise<void> {
        try {
            const mocFolder = this.settings.mocFolderPath;

            // 获取旧文件名和新文件名（不含扩展名）
            const oldBasename = this.getPathBasenameWithoutExtension(oldPath);
            const newBasename = file.basename;

            // 如果文件名没变，不需要更新
            if (oldBasename === newBasename) return;

            // 获取所有 MOC 文件
            const mocFiles = getMOCFilesInFolder(this.app, mocFolder || '');

            // 遍历所有 MOC 文件，更新链接
            for (const mocFile of mocFiles) {
                let content = await this.app.vault.read(mocFile);
                let modified = false;

                if (mocFile.extension === 'moc') {
                    let json: any;
                    try {
                        json = JSON.parse(content);
                    } catch {
                        continue;
                    }

                    // rename 事件触发时,oldPath 对应的文件已不存在,无法走 metadataCache 解析,
                    // 只能按原字符串形式直接匹配 node.wikiLink。
                    const oldName = oldPath.split('/').pop() || '';
                    const oldPathNoExt = this.getPathWithoutExtension(oldPath);
                    const newPathNoExt = this.getPathWithoutExtension(file.path);

                    const nextWikiLinkFor = (wl: string): string | null => {
                        if (wl === oldBasename) return file.basename;
                        if (wl === oldPath) return file.path;
                        if (wl === oldPathNoExt) return newPathNoExt;
                        if (wl === oldName) return file.name;
                        return null;
                    };

                    const walkNodes = (nodes: any[]) => {
                        for (const node of nodes || []) {
                            if (!node?.isTextOnly && typeof node?.wikiLink === 'string') {
                                const next = nextWikiLinkFor(node.wikiLink);
                                if (next !== null && next !== node.wikiLink) {
                                    // displayText 与 wikiLink 一致时跟随变化;用户自定义别名保留
                                    if (node.displayText === node.wikiLink) {
                                        node.displayText = next;
                                    }
                                    node.wikiLink = next;
                                    modified = true;
                                }
                            }
                            if (node?.children?.length) walkNodes(node.children);
                        }
                    };

                    walkNodes(json.nodes || []);

                    // 跨域关联存的是完整 filePath,直接按路径比对
                    if (json.crossDomainLinks && typeof json.crossDomainLinks === 'object') {
                        for (const links of Object.values(json.crossDomainLinks) as any[]) {
                            if (!Array.isArray(links)) continue;
                            for (const link of links) {
                                if (link?.filePath === oldPath) {
                                    link.filePath = file.path;
                                    modified = true;
                                }
                            }
                        }
                    }

                    if (modified) {
                        await this.app.vault.modify(mocFile, JSON.stringify(json, null, 2));
                    }
                    continue;
                }

                // 替换 [[oldName]] 格式的链接
                const wikiLinkRegex = new RegExp(`\\[\\[${this.escapeRegex(oldBasename)}\\]\\]`, 'g');
                if (wikiLinkRegex.test(content)) {
                    content = content.replace(wikiLinkRegex, `[[${newBasename}]]`);
                    modified = true;
                }

                // 替换 [[oldName|alias]] 格式的链接
                const wikiLinkWithAliasRegex = new RegExp(`\\[\\[${this.escapeRegex(oldBasename)}\\|([^\\]]+)\\]\\]`, 'g');
                if (wikiLinkWithAliasRegex.test(content)) {
                    content = content.replace(wikiLinkWithAliasRegex, `[[${newBasename}|$1]]`);
                    modified = true;
                }

                // 如果内容被修改，保存文件
                if (modified) {
                    await this.app.vault.modify(mocFile, content);
                }
            }

        } catch (error) {
            console.error('Error updating MOC links after rename:', error);
            new Notice(`更新 MOC 文件链接失败: ${error.message}`);
        }
    }

    /**
     * 转义正则表达式特殊字符
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private getPathBasenameWithoutExtension(path: string): string {
        const name = path.split('/').pop() || '';
        const extIndex = name.lastIndexOf('.');
        return extIndex > 0 ? name.slice(0, extIndex) : name;
    }

    private getPathWithoutExtension(path: string): string {
        const extIndex = path.lastIndexOf('.');
        return extIndex > path.lastIndexOf('/') ? path.slice(0, extIndex) : path;
    }

    onunload() {
        // 清理 MOC 文件监听器
        if (this.mocFileMonitor) {
            this.mocFileMonitor.cleanup();
            this.mocFileMonitor = null;
        }
        window.onerror = this.originalWindowOnError;
        this.originalWindowOnError = null;
        
        this.saveData(this.settings);
    }
}
