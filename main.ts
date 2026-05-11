import { Editor, FileView, loadMermaid, MarkdownView, moment, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { mainNoteFuzzyModal, mainNoteModal } from "src/modal/mainNoteModal";
import { ZKNavigationSettngTab } from "src/settings/settings";
import { mainNoteInit, getMOCFilesInFolder, isMocFile, isMocPath, MOC_FILE_SUFFIX } from "src/utils/utils";
import { createEmptyMOCJson } from "src/utils/mocJsonCodec";
import { MOCFileMonitor } from "src/utils/mocMonitor";
import { ensureMOCPreviewPNG } from "src/embed/mocEmbedExporter";
import { MOCReverseIndex } from "src/utils/mocReverseIndex";
import { VaultIndex } from "src/index/VaultIndex";
import { SpaceService } from "src/services/SpaceService";
import { FolderMountModal } from "src/modal/folderMountModal";
import { ZKGraphView, ZK_GRAPH_TYPE } from "src/view/graphView";
import { ZKIndexView, ZKNode, ZK_INDEX_TYPE, ZK_NAVIGATION } from "src/view/indexView";
import { ZK_RECENT_TYPE, ZKRecentView } from "src/view/recentView";
import { MOCPreviewView, MOC_PREVIEW_VIEW_TYPE } from "src/view/mocPreviewView";
import { LayoutPreset, normalizeLayoutPreset } from "src/utils/growthDirection";
import { Scratchpad, ScratchpadEntry, ScratchpadManager } from "src/scratch/scratchpadManager";
import { resolveThemeMode } from "src/utils/themeMode";

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
    themeMode: 'dark' | 'light' | 'auto';       // 主题模式(auto = 跟随 Obsidian)
    themeStyle: 'default' | 'modern';   // 主题风格（淡雅/现代）
    edgeStyle: 'straight' | 'bezier' | 'polyline'; // 连线风格
    nodeLayoutStyle: 'free' | 'auto';  // 节点布局风格（自由/自动）
    autoLayoutDefaultGrowthDirection: LayoutPreset; // 自动布局默认生长方向
    showNoteIdInBranchView: boolean;   // 分支视图是否显示笔记编号
    scratchpads: Scratchpad[];          // 临时工作区:跨 MOC 共享的节点暂存(支持多 pad)
    activeScratchpadId: string;         // 当前激活的暂存区 id
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
    themeMode: 'auto', // 默认跟随 Obsidian
    themeStyle: 'modern', // 默认现代风格
    edgeStyle: 'bezier', // 默认贝塞尔曲线
    nodeLayoutStyle: 'free', // 默认自由节点布局
    autoLayoutDefaultGrowthDirection: 'bidirectional',
    showNoteIdInBranchView: true,
    scratchpads: [],
    activeScratchpadId: '',
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
    // 自建 Space 树索引(spaces.json,只虚拟存在,不创建真实文件夹)
    vaultIndex: VaultIndex | null = null;
    spaceService: SpaceService | null = null;
    // 临时工作区(跨 MOC 共享的节点暂存)
    scratchpad: ScratchpadManager | null = null;
    private originalWindowOnError: OnErrorEventHandler | null = null;
    // notebook-navigator 文件夹右键菜单注销函数
    private nnFolderMenuDispose: (() => void) | null = null;

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        )
        if ((this.settings as any).themeStyle === 'vivid') {
            this.settings.themeStyle = 'modern';
        }
        const legacyFileIcon = String.fromCodePoint(0x1F4C4);
        if (this.settings.MainNoteButtonText.startsWith(legacyFileIcon)) {
            this.settings.MainNoteButtonText = this.settings.MainNoteButtonText.slice(legacyFileIcon.length);
        }
        this.settings.autoLayoutDefaultGrowthDirection = normalizeLayoutPreset(
            this.settings.autoLayoutDefaultGrowthDirection
        );
        if (!Array.isArray(this.settings.scratchpads)) {
            this.settings.scratchpads = [];
        }
        // 旧版 scratchpadItems(单一暂存区)迁移为单 pad
        const legacyItems = (this.settings as any).scratchpadItems;
        if (Array.isArray(legacyItems) && legacyItems.length > 0 && this.settings.scratchpads.length === 0) {
            this.settings.scratchpads.push({
                id: `pad-legacy-${Date.now().toString(36)}`,
                name: '默认',
                items: legacyItems as ScratchpadEntry[],
                createdAt: Date.now(),
            });
        }
        delete (this.settings as any).scratchpadItems;
        // 至少保证有一个 pad
        if (this.settings.scratchpads.length === 0) {
            this.settings.scratchpads.push({
                id: `pad-default-${Date.now().toString(36)}`,
                name: '默认',
                items: [],
                createdAt: Date.now(),
            });
        }
        // active id 必须指向已有 pad
        if (!this.settings.scratchpads.some((p) => p.id === this.settings.activeScratchpadId)) {
            this.settings.activeScratchpadId = this.settings.scratchpads[0].id;
        }
    }

    applyTheme() {
        // 移除所有主题类
        document.body.removeClass('zk-theme-dark');
        document.body.removeClass('zk-theme-light');

        // 根据设置(auto 时跟随 Obsidian)添加对应的主题类
        if (resolveThemeMode(this.settings.themeMode) === 'light') {
            document.body.addClass('zk-theme-light');
        } else {
            document.body.addClass('zk-theme-dark');
        }
    }

    async onload() {

        await this.loadSettings();

        // 注册 .moc 扩展名，使 Obsidian 在文件浏览器中显示并正确索引这些文件
        this.registerExtensions(['moc'], 'markdown');

        const updateMOCPreviewImageSize = (img: HTMLImageElement, containerEl: HTMLElement): void => {
            if (containerEl.parentElement?.classList.contains('popover')) {
                containerEl.addClass('zk-moc-popover-img-preview-content');
                return;
            }

            const width = Number(containerEl.getAttribute('width') || 0);
            const height = Number(containerEl.getAttribute('height') || 0);
            if (width > 0) img.width = width;
            if (height > 0) img.height = height;
        };

        const createMOCPreviewImage = async (mocFile: TFile): Promise<HTMLImageElement | null> => {
            try {
                const pngFile = await ensureMOCPreviewPNG(mocFile, this);
                const img = document.createElement('img');
                img.className = 'zk-moc-embed-img';
                img.dataset.mocFile = mocFile.path;
                img.src = this.app.vault.getResourcePath(pngFile);
                img.style.cssText = 'display:block;width:100%;height:auto;border-radius:6px;';
                img.alt = mocFile.basename;
                img.draggable = false;
                img.addEventListener('dblclick', async (evt: MouseEvent) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    this.settings.mocCurrentFile = mocFile.path;
                    await this.saveData(this.settings);
                    await this.openIndexView();
                    this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                });
                return img;
            } catch {
                return null;
            }
        };

        const resolveMOCLink = (linkText: string | null | undefined, sourcePath: string): TFile | null => {
            const fileName = linkText?.split('#')[0]?.trim();
            if (!fileName) return null;
            const file = this.app.metadataCache.getFirstLinkpathDest(fileName, sourcePath)
                ?? this.app.vault.getFileByPath(fileName);
            return file instanceof TFile && isMocFile(file) ? file : null;
        };

        // 向上找 embed 包裹元素;只匹配 .internal-embed / .markdown-embed / canvas / excalidraw,
        // 不匹配 .markdown-reading-view —— 那是「文件被作为 markdown 直接打开」的容器,不能动
        const findMocEmbedWrapper = (el: HTMLElement): HTMLElement | null => {
            let curr: HTMLElement | null = el;
            while (curr && curr !== document.body) {
                if (curr.classList.contains('dataview') ||
                    curr.classList.contains('cm-preview-code-block') ||
                    curr.classList.contains('cm-embed-block')) {
                    return null;
                }
                if (curr.classList.contains('internal-embed') ||
                    curr.classList.contains('markdown-embed') ||
                    curr.classList.contains('excalidraw-md-host') ||
                    curr.classList.contains('canvas-node-content')) {
                    return curr;
                }
                curr = curr.parentElement;
            }
            return null;
        };

        this.registerMarkdownPostProcessor((element, context) => {
            // Case 1 (Reading View / 宿主文件):宿主文件渲染时,element 内含 .internal-embed,直接替换
            const embeddedItems = Array.from(element.querySelectorAll<HTMLElement>('.internal-embed'));
            embeddedItems.forEach((item) => {
                const mocFile = resolveMOCLink(item.getAttribute('src'), context.sourcePath);
                if (!mocFile) return;
                void createMOCPreviewImage(mocFile).then((img) => {
                    if (!img || !item.parentElement) return;
                    updateMOCPreviewImageSize(img, item);
                    item.parentElement.replaceChild(img, item);
                });
            });

            // Case 2 (Live Preview / 被嵌入文件自身):post-processor 是为 .moc 文件本身触发的,
            // 从 ctx.containerEl(渲染目标容器,Obsidian 内部属性)向上找 embed 包裹并替换
            if (isMocPath(context.sourcePath)) {
                const file = this.app.vault.getFileByPath(context.sourcePath);
                if (!(file instanceof TFile) || !isMocFile(file)) return;
                const containerEl = (context as any).containerEl as HTMLElement | undefined;
                const startEl = containerEl ?? element;
                const wrapper = findMocEmbedWrapper(startEl);
                if (!wrapper) return;
                if (wrapper.dataset.mocHandled) return;
                wrapper.dataset.mocHandled = '1';
                void createMOCPreviewImage(file).then((img) => {
                    if (!img) return;
                    wrapper.empty();
                    wrapper.addClass('zk-moc-embed');
                    if (wrapper.classList.contains('canvas-node-content')) {
                        wrapper.addClass('zk-moc-canvas-node-content');
                    }
                    if (wrapper.classList.contains('markdown-embed')) {
                        wrapper.classList.remove('markdown-embed', 'inline-embed');
                    }
                    updateMOCPreviewImageSize(img, wrapper);
                    wrapper.appendChild(img);
                });
            }
        });

        // 注册自定义 View:打开 .moc.md / .moc 文件时显示 PNG 预览(参考 SimpleMindMap)
        this.registerView(MOC_PREVIEW_VIEW_TYPE, (leaf) => new MOCPreviewView(leaf, this));

        // 启动后:把已经打开的 markdown leaf 中的 .moc.md / .moc 文件转成预览 view
        this.app.workspace.onLayoutReady(() => {
            this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
                const view = leaf.view;
                if (view instanceof MarkdownView && view.file && isMocFile(view.file)) {
                    void leaf.setViewState({
                        type: MOC_PREVIEW_VIEW_TYPE,
                        state: { file: view.file.path },
                    });
                }
            });
        });

        // 应用主题
        this.applyTheme();

        // auto 模式下,Obsidian 主题切换时同步刷新插件视图
        this.registerEvent(this.app.workspace.on('css-change', () => {
            if (this.settings.themeMode !== 'auto') return;
            this.applyTheme();
            this.RefreshIndexViewFlag = true;
            this.app.workspace.trigger('zk-navigation:refresh-index-graph');
            this.app.workspace.trigger('zk-navigation:refresh-local-graph');
        }));

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
                                    const filePath = folder.path ? `${folder.path}/${baseName}${MOC_FILE_SUFFIX}` : `${baseName}${MOC_FILE_SUFFIX}`;
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

        // 只前置拦截 .moc / .moc.md 的打开，避免 Obsidian 先渲染成 markdown 再由 file-open 切换造成闪屏。
        const originalOpenFile = WorkspaceLeaf.prototype.openFile;
        const plugin = this;
        const openMocFile = async function (this: WorkspaceLeaf, file: TFile, ...rest: any[]) {
            if (file instanceof TFile && isMocFile(file)) {
                const openState = rest[0] ?? {};
                plugin.settings.mocCurrentFile = file.path;
                await plugin.saveData(plugin.settings);
                await this.setViewState({
                    type: ZK_INDEX_TYPE,
                    state: { file: file.path },
                    active: openState.active ?? true,
                });
                if (openState.active !== false) {
                    plugin.app.workspace.revealLeaf(this);
                }
                plugin.app.workspace.trigger('zk-navigation:refresh-index-graph');
                return;
            }
            return originalOpenFile.apply(this, [file, ...rest]);
        };
        WorkspaceLeaf.prototype.openFile = openMocFile as typeof WorkspaceLeaf.prototype.openFile;
        this.register(() => {
            if (WorkspaceLeaf.prototype.openFile === openMocFile) {
                WorkspaceLeaf.prototype.openFile = originalOpenFile;
            }
        });
              
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
                    const filePath = folder?.path ? folder.path + '/' + baseName + MOC_FILE_SUFFIX : baseName + MOC_FILE_SUFFIX;
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

        // 添加当前 MOC 到项目文件夹(挂载/取消挂载)
        this.addCommand({
            id: "zk-mount-moc-to-folder",
            name: "添加当前 MOC 到项目文件夹",
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
                this.openFolderMountModal(file);
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
        // 初始化自建 Space 树索引(单文件存储,纯虚拟分类)
        const storePath = `${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/spaces.json`;
        this.vaultIndex = new VaultIndex(this.app, storePath);
        this.addChild(this.vaultIndex);
        this.spaceService = new SpaceService(this.app, this.vaultIndex);
        // 临时工作区管理器(跨 MOC 暂存,持久化到 plugin data)
        this.scratchpad = new ScratchpadManager(this);
        // 等 layout-ready 后再构建索引，确保 metadataCache 已初始化
        this.app.workspace.onLayoutReady(async () => {
            await this.mocReverseIndex?.initialize(
                this.settings.mocFolderPath,
                this.settings.mocHeadingTitle
            );
            await this.vaultIndex?.bootstrap();
            this.registerNotebookNavigatorFolderMenu();
        });

        // 拦截 .moc 文件打开，用分支视图（IndexView）代替默认编辑器
        this.registerEvent(
            this.app.workspace.on('file-open', async (file) => {
                if (!file || !isMocFile(file)) return;

                const activeLeaf = this.app.workspace.activeLeaf;
                this.settings.mocCurrentFile = file.path;
                await this.saveData(this.settings);

                if (
                    activeLeaf?.view?.getViewType() === ZK_INDEX_TYPE &&
                    (activeLeaf.view as any)?.file?.path === file.path
                ) {
                    this.app.workspace.trigger('zk-navigation:refresh-index-graph');
                    return;
                }

                // 优先复用已存在的思维树视图，避免重复打开
                const existingLeaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const reuseLeaf = existingLeaves.find((l) => l !== activeLeaf);

                if (reuseLeaf) {
                    await reuseLeaf.setViewState({
                        type: ZK_INDEX_TYPE,
                        state: { file: file.path },
                        active: true,
                    });
                    this.app.workspace.revealLeaf(reuseLeaf);
                    // 已经把焦点切到现有思维树视图后，再关闭刚被 Obsidian 打开的 .moc markdown 标签
                    if (activeLeaf?.view?.getViewType() === 'markdown') {
                        activeLeaf.detach();
                    }
                } else if (activeLeaf?.view?.getViewType() === 'markdown') {
                    // 无现有视图：复用当前刚打开 .moc 的 markdown leaf，直接切换成 IndexView，
                    // 避免 detach markdown leaf 后 Obsidian 回退到上一个 markdown 文件，
                    // 从而触发文件树错误定位。
                    await activeLeaf.setViewState({
                        type: ZK_INDEX_TYPE,
                        state: { file: file.path },
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
                    // MOC 文件改名:同步 spaces.json 里所有 mocRefs
                    if (isMocFile(file) || isMocPath(oldPath)) {
                        await this.spaceService?.handleMocRename(oldPath, file.path);
                    }
                }
            })
        );

        // 监听 MOC 文件删除,清理 mocRefs
        this.registerEvent(
            this.app.vault.on("delete", async (file) => {
                if (file instanceof TFile && isMocFile(file)) {
                    await this.spaceService?.handleMocDelete(file.path);
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
     * 打开"挂载到项目文件夹"选择器,把指定 MOC 加入/移出某个 FolderNode 的 mocRefs
     */
    openFolderMountModal(file: TFile): void {
        if (!isMocFile(file)) {
            new Notice("仅支持 .moc / .moc.md 文件");
            return;
        }
        if (!this.vaultIndex || !this.spaceService) {
            new Notice("Space 索引尚未就绪,请稍候再试");
            return;
        }
        if (this.vaultIndex.isEmpty()) {
            new Notice("还没有任何 Space,先在右侧抽屉创建一个吧");
            return;
        }
        new FolderMountModal(this.app, this.vaultIndex, this.spaceService, file).open();
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

                if (isMocFile(mocFile)) {
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

    private async createMOCInFolder(folder: TFolder): Promise<TFile | null> {
        try {
            const baseName = '思维树-' + moment().format('YYYYMMDDHHmmss');
            const filePath = folder.path
                ? `${folder.path}/${baseName}${MOC_FILE_SUFFIX}`
                : `${baseName}${MOC_FILE_SUFFIX}`;
            const content = createEmptyMOCJson(
                this.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free'
            );
            return await this.app.vault.create(filePath, content);
        } catch (e) {
            console.error('[zk-navigation] 新建思维树失败', e);
            new Notice(`新建失败: ${e.message}`);
            return null;
        }
    }

    private registerNotebookNavigatorFolderMenu() {
        const nn = (this.app as any).plugins?.plugins?.['notebook-navigator']?.api;
        const register = nn?.menus?.registerFolderMenu;
        if (typeof register !== 'function') return;
        try {
            this.nnFolderMenuDispose = register.call(
                nn.menus,
                ({ addItem, folder }: { addItem: (cb: (item: any) => void) => void; folder: TFolder }) => {
                    addItem((item: any) => {
                        item.setTitle(t('New MOC file'))
                            .setIcon('git-branch')
                            .onClick(async () => {
                                await this.createMOCInFolder(folder);
                            });
                    });
                }
            );
        } catch (e) {
            console.error('[zk-navigation] 注册 notebook-navigator 文件夹菜单失败', e);
        }
    }

    async onunload() {
        await this.detachPluginViews();

        // 清理 MOC 文件监听器
        if (this.mocFileMonitor) {
            this.mocFileMonitor.cleanup();
            this.mocFileMonitor = null;
        }
        // 注销 notebook-navigator 文件夹右键菜单
        if (this.nnFolderMenuDispose) {
            try { this.nnFolderMenuDispose(); } catch {}
            this.nnFolderMenuDispose = null;
        }
        window.onerror = this.originalWindowOnError;
        this.originalWindowOnError = null;

        this.saveData(this.settings);
    }

    private async detachPluginViews(): Promise<void> {
        const viewTypes = [
            ZK_GRAPH_TYPE,
            ZK_INDEX_TYPE,
            ZK_RECENT_TYPE,
        ];

        for (const viewType of viewTypes) {
            try {
                await this.app.workspace.detachLeavesOfType(viewType);
            } catch (e) {
                console.error(`[zk-navigation] failed to detach ${viewType} on unload`, e);
            }
        }
    }
}
