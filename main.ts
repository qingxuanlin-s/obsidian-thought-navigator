import { FileView, MarkdownView, moment, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { t } from "src/lang/helper";
import { indexFuzzyModal, indexModal } from "src/modal/indexModal";
import { mainNoteFuzzyModal, mainNoteModal } from "src/modal/mainNoteModal";
import { ZKNavigationSettngTab } from "src/settings/settings";
import { mainNoteInit, getMOCFilesInFolder, isMocFile, isMocPath, MOC_FILE_SUFFIX } from "src/utils/utils";
import { createMOCJsonWithInitialNode } from "src/utils/mocJsonCodec";
import { MOCHandler, MOCNodeView, MOCQueryOptions } from "src/view/index/mocHandler";
import { MOCFileMonitor } from "src/utils/mocMonitor";
import { ensureMOCPreviewPNG } from "src/embed/mocEmbedExporter";
import { MOCReverseIndex } from "src/utils/mocReverseIndex";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { ensureWorkspaceSeed } from "src/workspace/seed";
import { ZKWorkspaceView, ZK_WORKSPACE_TYPE } from "src/view/workspaceView";
import { ContainerMountModal } from "src/modal/containerMountModal";
import { ZKGraphView, ZK_GRAPH_TYPE } from "src/view/graphView";
import { ZKIndexView, ZKNode, ZK_INDEX_TYPE, ZK_NAVIGATION } from "src/view/indexView";
import { ZK_RECENT_TYPE, ZKRecentView } from "src/view/recentView";
import { MOCPreviewView, MOC_PREVIEW_VIEW_TYPE } from "src/view/mocPreviewView";
import { LayoutPreset, normalizeLayoutPreset } from "src/utils/growthDirection";
import { ScratchpadManager } from "src/scratch/scratchpadManager";
import { resolveThemeMode } from "src/utils/themeMode";
import { ChangelogModal } from "src/modal/changelogModal";
import { getUnreadEntries } from "src/utils/changelog";
import { GettingStartedModal } from "src/modal/gettingStartedModal";

interface Point {
    x: number;
    y: number;
}

interface NotebookNavigatorMenuItem {
    setTitle(title: string): NotebookNavigatorMenuItem;
    setIcon(icon: string): NotebookNavigatorMenuItem;
    onClick(callback: () => void | Promise<void>): NotebookNavigatorMenuItem;
}

interface NotebookNavigatorMenuContext {
    addItem(callback: (item: NotebookNavigatorMenuItem) => void): void;
    folder: TFolder;
}

interface NotebookNavigatorApi {
    menus?: {
        registerFolderMenu?: (handler: (context: NotebookNavigatorMenuContext) => void) => (() => void) | void;
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export interface CreateMOCOptions {
    folderPath?: string;       // 不含文件名,'' 或省略 = vault 根
    name?: string;             // 不含后缀,省略 = 默认前缀+时间戳
    title?: string;            // 根节点文本,省略 = t('Default node title')
    layout?: 'free' | 'auto';  // 省略 = settings.nodeLayoutStyle
    overwrite?: boolean;       // 目标已存在时是否覆盖,默认 false
    rootId?: string;           // 指定根节点 ID(便于脚本后续 add-node);省略 = 随机
}

export interface ZKNavigationExternalAPI {
    version(): string;
    /** 创建新 .moc.md,返回文件路径 */
    createMOC(opts?: CreateMOCOptions): Promise<string>;
    /** 向已有 .moc 的父节点追加子节点,返回新节点 ID */
    addNode(filePath: string, parentID: string, title: string, kind?: 'text' | 'file'): Promise<string>;
    /** 一次性批量追加多个子节点(单次读改写,适合 CLI 一次建整棵树),返回新 ID 数组 */
    addNodes(filePath: string, items: Array<{ parent: string; title: string; kind?: 'text' | 'file' }>): Promise<string[]>;
    /**
     * 批量新增「反向连线」(关联箭头边):在任意两个已存在节点间建立关联边,
     * 区别于树的父子边,画布上渲染为虚线箭头,可带文字标签。单次读改写,只写一次文件。
     * @param items 每项 {source, target, label?},source/target 为已存在节点的 nodeID。
     * @returns 实际新增的边 key 数组(`source->target`);已存在的同向边被跳过。端点不存在或自环时抛错。
     */
    addRelations(filePath: string, items: Array<{ source: string; target: string; label?: string }>): Promise<string[]>;
    /**
     * 删除指定节点(连同其全部后代),并清理其位置/颜色/备注等元数据。直接写文件。
     * 若该 MOC 正在思维树视图打开,删除后自动刷新画布。nodeID 不存在则静默无操作。
     */
    deleteNode(filePath: string, nodeID: string): Promise<void>;
    /**
     * 批量删除节点(#20),区分草稿与真实:草稿节点直接丢弃(不弹确认);真实节点**逐个弹删除确认对话框**,
     * 用户确认才真删(连同后代,清元数据并刷新画布)。需该 MOC 已在思维树视图打开(确认框 / 草稿都依赖视图)。
     * 与 deleteNode(直接删、无确认)不同,本命令面向"删前要人过目"的场景。
     * @returns {deleted, draftsDiscarded, cancelled, notFound} 各类结果的 nodeID 汇总
     */
    deleteNodes(filePath: string, nodeIDs: string[]): Promise<{
        deleted: string[]; draftsDiscarded: string[]; cancelled: string[]; notFound: string[];
    }>;
    /**
     * 只读查询节点(精确 by nodeID / 模糊 by 文本 / 整棵树),返回精简嵌套节点树。
     * opts.nodeID 精确定位单节点(连同后代);opts.query 模糊匹配 nodeID/target/alias;
     * 都不传则返回整棵树;opts.recursive=false 只返回直接子节点。
     */
    queryNodes(filePath: string, opts?: MOCQueryOptions): Promise<MOCNodeView[]>;
    /**
     * 注入一批「草稿节点」到当前打开的思维树视图(#20)。纯内存渲染、不写文件,
     * 用户在画布上审阅后点「确认落地」才经正式流程写入,或「丢弃」不影响真实数据。
     * 走本 API(CLI/脚本)的草稿标记为 origin='ai'。filePath 必须是当前已打开的 MOC。
     * @param items 每项 {content, kind?, parentRealId?, parentLocalId?, localId?, position?}
     *   - content:节点文本;kind:'text'(默认)/'file'
     *   - parentRealId:挂到某个已存在真实节点(其 nodeID/IDStr)
     *   - localId + parentLocalId:同批草稿内部父子关系(localId 为本批内引用名)
     *   - position:节点的画布坐标 {x,y}。**自由布局(free layout)MOC 必传**——该类文件无自动排布,
     *     需调用方自算坐标;传了 position 则跳过预览自动重排,原样落在该坐标。自动布局(auto)可省略。
     * @returns 生成的 draftId 列表;若目标 MOC 未在思维树视图中打开则返回 []
     */
    addDraftNodes(
        filePath: string,
        items: Array<{ content: string; kind?: 'text' | 'file'; parentRealId?: string; parentLocalId?: string; localId?: string; position?: { x: number; y: number } }>,
        batchId?: string
    ): Promise<string[]>;
    /**
     * 注入一批「草稿关联」(待审批的关联反向连线,#20)到当前打开的思维树视图。纯内存渲染、不写文件,
     * 用户在画布上审阅后点「确认落地」才经 addRelations 流程写入,或「丢弃」不影响真实数据。
     * 走本 API(CLI/脚本)的草稿标记为 origin='ai'。filePath 必须是当前已打开的 MOC。
     * @param items 每项 {source, target, label?};source/target 为已存在真实节点的 nodeID,或同期草稿节点的 draftId。
     * @returns 实际新增的边 key 数组(`source->target`);端点不存在 / 自环 / 已存在同向草稿边会被跳过;MOC 未打开则返回 []
     */
    addDraftRelations(
        filePath: string,
        items: Array<{ source: string; target: string; label?: string }>,
        batchId?: string
    ): Promise<string[]>;
    /**
     * 开启/关闭某个已打开 MOC 的「草稿模式」(#20)。开启后该视图里新建的节点都先作为草稿,
     * 待用户审批落地或丢弃。filePath 必须是当前已在思维树视图中打开的 MOC。
     * @returns 设置后的草稿模式状态(true=开启)
     */
    setDraftMode(filePath: string, on: boolean): Promise<boolean>;
    /**
     * 丢弃「待审批草稿节点」(#20)。纯内存,不影响真实数据。filePath 必须是当前已打开的 MOC。
     * @param draftId 省略 = 丢弃该视图全部草稿并退出草稿模式;传入则只丢弃这一个草稿节点。
     * @returns true=已丢弃;false=目标 MOC 未在思维树视图打开
     */
    discardDrafts(filePath: string, draftId?: string): Promise<boolean>;
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
    projectFolderPath: string;         // 工作区项目背书笔记(next action 任务)所在文件夹
    wsTaskPrefix: string;              // 新建任务/子任务自动插在 `[ ]` 后的前缀字符(如 "🎯 ")
    mocHeadingTitle: string;           // 要解析的一级标题名称，如 "思维树"
    mocCurrentFile: string;            // 当前选中的 MOC 文件路径
    mocNodePositions: Record<string, Record<string, { x: number; y: number }>>; // MOC 节点位置存储 {mocFilePath: {nodeId: {x, y}}}
    smartConnection: boolean;          // 智能连线开关
    themeMode: 'dark' | 'light' | 'auto';       // 主题模式(auto = 跟随 Obsidian)
    themeStyle: 'default' | 'modern' | 'nebula';   // 主题风格（淡雅/现代/星云）
    edgeStyle: 'straight' | 'bezier' | 'polyline'; // 连线风格
    nodeLayoutStyle: 'free' | 'auto';  // 节点布局风格（自由/自动）
    autoLayoutDefaultGrowthDirection: LayoutPreset; // 自动布局默认生长方向
    showNoteIdInBranchView: boolean;   // 分支视图是否显示笔记编号
    lastShownChangelogVersion: string;  // 上次已展示更新公告的版本号(用于避免重复弹窗)
    hasSeenFirstUseTutorial: boolean;    // 是否已看过首次使用教程
    detailPanelSide: 'left' | 'right';  // 节点详情侧栏停靠侧
    detailPanelAutoOpen: boolean;       // 单击选中是否自动展开详情侧栏(false = 再点一下才展开)
    detailPanelWidth: number;           // 侧栏宽度(px,可拖拽调整),0 = CSS 默认
    detailPanelPinned: boolean;         // 侧栏是否钉住常驻(背景点击/Esc 不收起)
    defaultFileOpenMode: 'replace' | 'tab' | 'split-left' | 'split-right'; // 点击文件节点的默认打开方式
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
    projectFolderPath: 'config/workspace',
    wsTaskPrefix: '',
    mocHeadingTitle: t('default MOC heading title'),
    mocCurrentFile: '',
    mocNodePositions: {}, // MOC 节点位置存储
    smartConnection: false, // 智能连线默认关闭
    themeMode: 'auto', // 默认跟随 Obsidian
    themeStyle: 'nebula', // 默认星云风格
    edgeStyle: 'bezier', // 默认贝塞尔曲线
    nodeLayoutStyle: 'auto', // 默认自动节点布局
    autoLayoutDefaultGrowthDirection: 'bidirectional',
    showNoteIdInBranchView: true,
    lastShownChangelogVersion: '',
    hasSeenFirstUseTutorial: false,
    detailPanelSide: 'right',
    detailPanelAutoOpen: false,
    detailPanelWidth: 0,
    detailPanelPinned: false,
    defaultFileOpenMode: 'tab',
}

export default class ZKNavigationPlugin extends Plugin {

    settings: ZKNavigationSettings;
    MainNotes: ZKNode[] = [];
    retrivalforLocaLgraph: LocalRetrival = {
        type: '2',
        ID: '',
        filePath: '',
    };
    indexViewOffsetWidth = 0;
    indexViewOffsetHeight = 0;
    RefreshIndexViewFlag = false;
    mainNoteModal = false;
    indexModal = false;
    
    // MOC 文件监听器
    mocFileMonitor: MOCFileMonitor | null = null;
    // MOC 反向索引
    mocReverseIndex: MOCReverseIndex | null = null;
    // 供 URI / 外部脚本复用的轻量 MOCHandler(懒加载)
    cliMocHandler?: MOCHandler;
    // 外部 API(Obsidian CLI eval / 其他插件),onload 末尾注册
    api!: ZKNavigationExternalAPI;
    // typed-node 工作区数据层(workspace.json),三栏工作区视图的数据源
    workspaceStore: WorkspaceStore | null = null;
    /** 旧 spaces.json 路径,仅用于工作区首启/升级时的一次性迁移读取 */
    private get spacesStorePath(): string {
        return `${this.app.vault.configDir}/plugins/${this.manifest.id}/spaces.json`;
    }
    // 临时工作区(跨 MOC 共享的节点暂存)
    scratchpad: ScratchpadManager | null = null;
    private originalWindowOnError: OnErrorEventHandler | null = null;
    // notebook-navigator 文件夹右键菜单注销函数
    private nnFolderMenuDispose: (() => void) | null = null;

    async loadSettings() {
        const rawSettings = (await this.loadData()) as unknown;
        const loadedData = isRecord(rawSettings) ? rawSettings as Partial<ZKNavigationSettings> : {};
        const hasExistingData = Object.keys(loadedData).length > 0;
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...loadedData,
        };
        if (typeof loadedData.hasSeenFirstUseTutorial !== 'boolean') {
            this.settings.hasSeenFirstUseTutorial = hasExistingData;
        }
        const localizedDefaultMOCHeading = t('default MOC heading title');
        if (localizedDefaultMOCHeading !== '思维树' && this.settings.mocHeadingTitle === '思维树') {
            this.settings.mocHeadingTitle = localizedDefaultMOCHeading;
        }
        if (typeof (loadedData as { themeStyle?: unknown }).themeStyle === 'string' && (loadedData as { themeStyle?: unknown }).themeStyle === 'vivid') {
            this.settings.themeStyle = 'modern';
        }
        const legacyFileIcon = String.fromCodePoint(0x1F4C4);
        if (this.settings.MainNoteButtonText.startsWith(legacyFileIcon)) {
            this.settings.MainNoteButtonText = this.settings.MainNoteButtonText.slice(legacyFileIcon.length);
        }
        const localizedMainNoteButtonText = t("Main notes");
        const legacyMainNoteButtonDefaults = new Set(["Main notes", "主笔记"]);
        if (legacyMainNoteButtonDefaults.has(this.settings.MainNoteButtonText)) {
            this.settings.MainNoteButtonText = localizedMainNoteButtonText;
        }
        if (this.settings.graphType !== "structure") {
            this.settings.graphType = "structure";
        }
        this.settings.autoLayoutDefaultGrowthDirection = normalizeLayoutPreset(
            this.settings.autoLayoutDefaultGrowthDirection
        );
    }

    applyTheme() {
        // 移除所有主题类
        activeDocument.body.removeClass('zk-theme-dark');
        activeDocument.body.removeClass('zk-theme-light');

        // 根据设置(auto 时跟随 Obsidian)添加对应的主题类
        if (resolveThemeMode(this.settings.themeMode) === 'light') {
            activeDocument.body.addClass('zk-theme-light');
        } else {
            activeDocument.body.addClass('zk-theme-dark');
        }
    }

    private registerMocExtension(): void {
        try {
            // 注册 .moc 扩展名，使 Obsidian 在文件浏览器中显示并正确索引这些文件
            this.registerExtensions(['moc'], 'markdown');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('Attempting to register an existing file extension "moc"')) {
                console.warn('[thought-navigator] .moc extension is already registered, skipping registration.');
                return;
            }
            throw error;
        }
    }

    async onload() {

        await this.loadSettings();

        this.registerMocExtension();

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
                const img = activeDocument.createElement('img');
                img.className = 'zk-moc-embed-img';
                img.dataset.mocFile = mocFile.path;
                img.src = this.app.vault.getResourcePath(pngFile);
                img.setCssStyles({
                    display: 'block',
                    width: '100%',
                    height: 'auto',
                    borderRadius: '6px',
                });
                img.alt = mocFile.basename;
                img.draggable = false;
                img.addEventListener('dblclick', (evt: MouseEvent) => { void (async () => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    this.settings.mocCurrentFile = mocFile.path;
                    await this.saveData(this.settings);
                    await this.openIndexView();
                    this.app.workspace.trigger("zk-navigation:refresh-index-graph");
                })(); });
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
            while (curr && curr !== activeDocument.body) {
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
                const containerEl = (context as { containerEl?: HTMLElement }).containerEl;
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

            if(para.action === 'create'){
                try {
                    const file = await this.createMOCFile({
                        name: para.name,
                        folderPath: para.folder,
                        title: para.title,
                        layout: para.layout === 'auto' ? 'auto'
                              : para.layout === 'free' ? 'free' : undefined,
                        overwrite: para.overwrite === 'true',
                        rootId: para.rootId,
                    });

                    this.settings.mocCurrentFile = file.path;
                    await this.saveData(this.settings);
                    new Notice(t('MOC created').replace('{path}', file.path));

                    if(para.open !== 'false'){
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
                    this.app.workspace.trigger('zk-navigation:refresh-index-graph');
                } catch (e) {
                    new Notice(t('MOC create failed').replace('{message}', e.message));
                    console.error('[zk-navigation] create via uri failed', e);
                }
                return;
            }

            if(para.action === 'add-node'){
                try {
                    const target = this.app.vault.getAbstractFileByPath(para.file ?? '');
                    if(!(target instanceof TFile) || !isMocFile(target)){
                        throw new Error(t('MOC not a moc file').replace('{path}', para.file ?? ''));
                    }
                    if(!para.parent){
                        throw new Error('missing parent node id');
                    }
                    if(!para.title){
                        throw new Error('missing node title');
                    }
                    const kind = para.kind === 'file' ? 'file' : 'text';
                    const handler = this.cliMocHandler ??= new MOCHandler(this, this.app);
                    const newID = await handler.addChildNodeToMOC(target, para.parent, para.title, kind);

                    this.settings.mocCurrentFile = target.path;
                    await this.saveData(this.settings);
                    new Notice(t('MOC node added').replace('{id}', newID));

                    if(para.open !== 'false'){
                        this.settings.lastRetrival = {
                            type: 'index',
                            ID: '',
                            displayText: '',
                            filePath: target.path,
                            openTime: '',
                        };
                        this.settings.zoomPanScaleArr = [];
                        this.settings.BranchTab = 0;
                        this.RefreshIndexViewFlag = true;
                        await this.openIndexView();
                    }
                    this.app.workspace.trigger('zk-navigation:refresh-index-graph');
                } catch (e) {
                    new Notice(t('MOC create failed').replace('{message}', e.message));
                    console.error('[zk-navigation] add-node via uri failed', e);
                }
                return;
            }

            if(para.file){
                
                const file = this.app.vault.getFileByPath(para.file);

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

                let indexFlag = false;
                
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
                // 文件夹右键:任何来源都允许新建 MOC(兼容 Notebook Navigator 等第三方文件管理器)
                if (file instanceof TFolder) {
                    menu.addItem((item) => {
                        item.setTitle(t("New MOC file"))
                            .setIcon("git-branch")
                            .setSection("plugin")
                            .onClick(async () => {
                                await this.createMOCInFolder(file as TFolder);
                            });
                    });
                    return;
                }

                // 文件右键:限制来源,避免在 link-context 等无关菜单中出现多余项
                if (
                    !(
                        source === "more-options" ||
                        source === "tab-header" ||
                        source === "file-explorer-context-menu"
                    )
                ) {
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

        this.registerView(ZK_WORKSPACE_TYPE, (leaf) => new ZKWorkspaceView(leaf, this));

        // 只前置拦截 .moc / .moc.md 的打开，避免 Obsidian 先渲染成 markdown 再由 file-open 切换造成闪屏。
        const originalOpenFile = WorkspaceLeaf.prototype.openFile;
        const plugin = this;
            const openMocFile = async function (this: WorkspaceLeaf, file: TFile, ...rest: unknown[]) {
                if (file instanceof TFile && isMocFile(file)) {
                    const openState = isRecord(rest[0]) ? rest[0] : {};
                    plugin.settings.mocCurrentFile = file.path;
                    await plugin.saveData(plugin.settings);
                    await this.setViewState({
                        type: ZK_INDEX_TYPE,
                        state: { file: file.path },
                        active: typeof openState.active === 'boolean' ? openState.active : true,
                    });
                    if (openState.active !== false) {
                        void plugin.app.workspace.revealLeaf(this);
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
              
        this.addRibbonIcon("tree-pine", t("Open tree graph"), async () => {
            
            void this.openIndexView();
            
        })

        this.addCommand({
            id: "thought-tree-graph",
            name: t("Open tree graph"),
            callback:async ()=>{

                void this.openIndexView();
            }
        });

        // 工作区统一入口:思维树视图工具栏的「工作区」按钮(图谱 ⇄ 工作区 模式切换),
        // 不再提供独立侧边栏 ribbon / 打开命令。

        this.addCommand({
            id: "thought-local-graph",
            name: t("Open local graph"),
            callback: async ()=>{
                
                void this.openGraphView();
            }
        });

        this.addCommand({
            id: "thought-tree-graph-by-file",
            name: t("Reveal current file in tree graph"),
            callback: async ()=>{
                await this.revealFileInIndexView();
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
                    const newFile = await this.createMOCFile({ folderPath: folder?.path ?? '' });
                    editor.replaceSelection('![[' + newFile.name + ']]');
                    await this.openCreatedMOC(newFile);
                    this.app.workspace.trigger('zk-navigation:refresh-index-graph');
                } catch (e) {
                    new Notice('新建失败: ' + e.message);
                }
            }
        })

        // 添加当前 MOC 到项目文件夹(挂载/取消挂载)
        this.addCommand({
            id: "zk-mount-moc-to-folder",
            name: t("Mount current MOC to project folder"),
            callback: async () => {
                const currentPath = this.settings.mocCurrentFile;
                if (!currentPath) {
                    new Notice(t("No current MOC file selected"));
                    return;
                }
                const file = this.app.vault.getFileByPath(currentPath);
                if (!file) {
                    new Notice(t("Current MOC file does not exist"));
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
        // typed-node 工作区存储(workspace.json)
        const wsStorePath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/workspace.json`;
        this.workspaceStore = new WorkspaceStore(this.app, wsStorePath);
        this.addChild(this.workspaceStore);
        // 临时工作区管理器(跨 MOC 暂存,持久化到独立的 scratchpads.json)
        this.scratchpad = new ScratchpadManager(this);
        await this.scratchpad.load();
        // 等 layout-ready 后再构建索引，确保 metadataCache 已初始化
        this.app.workspace.onLayoutReady(async () => {
            await this.mocReverseIndex?.initialize(
                this.settings.mocFolderPath,
                this.settings.mocHeadingTitle
            );
            if (this.workspaceStore) {
                await this.workspaceStore.bootstrap();
                await ensureWorkspaceSeed(this.workspaceStore, this.app.vault.adapter, this.spacesStorePath);
            }
            this.registerNotebookNavigatorFolderMenu();
            if (this.showFirstUseTutorialIfNeeded()) return;
            this.showChangelogIfNeeded();
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
                    (activeLeaf.view as FileView).file?.path === file.path
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
                    void this.app.workspace.revealLeaf(reuseLeaf);
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
                    void this.app.workspace.revealLeaf(activeLeaf);
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
                    // 工作区:任意文件改名都可能命中 note/moc/map 节点的 filePath
                    await this.workspaceStore?.handleFileRename(oldPath, file.path);
                    if (isMocFile(file) && this.settings.mocCurrentFile === oldPath) {
                        this.settings.mocCurrentFile = file.path;
                        if (this.settings.lastRetrival.filePath === oldPath) {
                            this.settings.lastRetrival.filePath = file.path;
                        }
                        await this.saveData(this.settings);
                        this.RefreshIndexViewFlag = true;
                        await this.openIndexView();
                    }
                }
            })
        );

        // 监听文件删除,清理挂载/关联
        this.registerEvent(
            this.app.vault.on("delete", async (file) => {
                if (!(file instanceof TFile)) return;
                // 工作区:任意文件删除都可能命中节点的 filePath
                await this.workspaceStore?.handleFileDelete(file.path);
            })
        );

        // 外部 API:供 Obsidian CLI `obsidian eval` / 其他插件复用,与 URI 走同一份内部逻辑
        this.api = {
            version: () => this.manifest.version,
            createMOC: async (opts: CreateMOCOptions = {}) => {
                const file = await this.createMOCFile(opts);
                return file.path;
            },
            addNode: async (filePath: string, parentID: string, title: string, kind: 'text' | 'file' = 'text') => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                const handler = this.cliMocHandler ??= new MOCHandler(this, this.app);
                return await handler.addChildNodeToMOC(target, parentID, title, kind === 'file' ? 'file' : 'text');
            },
            addNodes: async (filePath: string, items: Array<{ parent: string; title: string; kind?: 'text' | 'file' }>) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                const handler = this.cliMocHandler ??= new MOCHandler(this, this.app);
                return await handler.addNodesToMOC(target, items || []);
            },
            addRelations: async (filePath: string, items: Array<{ source: string; target: string; label?: string }>) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                const handler = this.cliMocHandler ??= new MOCHandler(this, this.app);
                const keys = await handler.addRelationsToMOC(target, items || []);
                // 若该 MOC 正在思维树视图打开,刷新画布让新连线即时可见
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const open = leaves.some((l) => (l.view as FileView).file?.path === filePath);
                if (open) {
                    this.RefreshIndexViewFlag = true;
                    this.app.workspace.trigger('zk-navigation:refresh-index-graph');
                }
                return keys;
            },
            deleteNode: async (filePath: string, nodeID: string) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                const handler = this.cliMocHandler ??= new MOCHandler(this, this.app);
                await handler.deleteNodeFromMOC(target, nodeID);
                // 若该 MOC 正在思维树视图打开,刷新画布让删除即时可见
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const open = leaves.some((l) => (l.view as FileView).file?.path === filePath);
                if (open) {
                    this.RefreshIndexViewFlag = true;
                    this.app.workspace.trigger('zk-navigation:refresh-index-graph');
                }
            },
            deleteNodes: async (filePath: string, nodeIDs: string[]) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                // 真实节点删除要弹确认框、草稿删除依赖视图内存 → 必须有一个已打开该 MOC 的思维树视图
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const leaf = leaves.find((l) => (l.view as FileView).file?.path === filePath) ?? leaves[0];
                const view = leaf?.view as ZKIndexView | undefined;
                if (!view || typeof view.requestDeleteNodes !== 'function') {
                    throw new Error(t('Draft view not open').replace('{path}', filePath));
                }
                return await view.requestDeleteNodes(nodeIDs || []) as {
                    deleted: string[]; draftsDiscarded: string[]; cancelled: string[]; notFound: string[];
                };
            },
            queryNodes: async (filePath: string, opts: MOCQueryOptions = {}) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                const handler = this.cliMocHandler ??= new MOCHandler(this, this.app);
                const base = await handler.queryMOC(target, opts || {});
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const view = leaves.find((l) => (l.view as FileView).file?.path === filePath)?.view as ZKIndexView | undefined;
                // 视图已打开时,用 cy 上的实时坐标覆盖存档坐标(auto 布局未必把每个节点写进 nodePositions)
                const live = typeof view?.getLivePositions === 'function'
                    ? view!.getLivePositions() as Record<string, { x: number; y: number }>
                    : {};
                // #20:把当前视图里未落地的草稿节点也并入结果(扁平,带 isDraft 标记与父引用)
                const drafts = typeof view?.getDraftNodeViews === 'function'
                    ? view!.getDraftNodeViews(opts || {}) as MOCNodeView[]
                    : [];
                const result = drafts.length ? [...base, ...drafts] : base;
                if (Object.keys(live).length) {
                    const applyLive = (n: MOCNodeView) => {
                        const p = live[n.nodeID];
                        if (p) { n.x = p.x; n.y = p.y; }
                        (n.children || []).forEach(applyLive);
                    };
                    result.forEach(applyLive);
                }
                return result;
            },
            addDraftNodes: async (
                filePath: string,
                items: Array<{ content: string; kind?: 'text' | 'file'; parentRealId?: string; parentLocalId?: string; localId?: string; position?: { x: number; y: number } }>,
                batchId?: string
            ) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                // 草稿是纯内存渲染层能力,必须有一个已打开该 MOC 的思维树视图来承载
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const leaf = leaves.find((l) => (l.view as FileView).file?.path === filePath) ?? leaves[0];
                const view = leaf?.view as ZKIndexView | undefined;
                if (!view || typeof view.injectDraftNodes !== 'function') {
                    throw new Error(t('Draft view not open').replace('{path}', filePath));
                }
                return view.injectDraftNodes(items || [], 'ai', batchId) as string[];
            },
            addDraftRelations: async (
                filePath: string,
                items: Array<{ source: string; target: string; label?: string }>,
                batchId?: string
            ) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                // 草稿关联是纯内存渲染层能力,必须有一个已打开该 MOC 的思维树视图来承载
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const leaf = leaves.find((l) => (l.view as FileView).file?.path === filePath) ?? leaves[0];
                const view = leaf?.view as ZKIndexView | undefined;
                if (!view || typeof view.injectDraftRelations !== 'function') {
                    throw new Error(t('Draft view not open').replace('{path}', filePath));
                }
                return view.injectDraftRelations(items || [], 'ai', batchId) as string[];
            },
            setDraftMode: async (filePath: string, on: boolean) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const leaf = leaves.find((l) => (l.view as FileView).file?.path === filePath) ?? leaves[0];
                const view = leaf?.view as ZKIndexView | undefined;
                if (!view || typeof view.setDraftMode !== 'function') {
                    throw new Error(t('Draft view not open').replace('{path}', filePath));
                }
                view.setDraftMode(!!on);
                return !!on;
            },
            discardDrafts: async (filePath: string, draftId?: string) => {
                const target = this.app.vault.getAbstractFileByPath(filePath);
                if (!(target instanceof TFile) || !isMocFile(target)) {
                    throw new Error(t('MOC not a moc file').replace('{path}', filePath));
                }
                const leaves = this.app.workspace.getLeavesOfType(ZK_INDEX_TYPE);
                const view = leaves.find((l) => (l.view as FileView).file?.path === filePath)?.view as ZKIndexView | undefined;
                if (!view) return false;
                if (draftId) {
                    if (typeof view.deleteDraftNode !== 'function') return false;
                    view.deleteDraftNode(draftId);
                } else {
                    if (typeof view.discardAllDrafts !== 'function') return false;
                    view.discardAllDrafts();
                }
                return true;
            },
        };

    }

    async openWorkspaceView() {
        if (this.workspaceStore) {
            // bootstrap 幂等;命令早于 layout-ready 触发时确保数据已就绪
            await this.workspaceStore.bootstrap();
            await ensureWorkspaceSeed(this.workspaceStore, this.app.vault.adapter, this.spacesStorePath);
        }
        const leaves = this.app.workspace.getLeavesOfType(ZK_WORKSPACE_TYPE);
        if (leaves.length === 0) {
            await this.app.workspace.getLeaf('tab')?.setViewState({ type: ZK_WORKSPACE_TYPE, active: true });
        }
        const leaf = this.app.workspace.getLeavesOfType(ZK_WORKSPACE_TYPE)[0];
        if (leaf) void this.app.workspace.revealLeaf(leaf);
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
        
        void this.app.workspace.revealLeaf(
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
                    void this.clearShowingSettings();
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
                    void this.clearShowingSettings();
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
                    void this.clearShowingSettings();
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
                    void this.clearShowingSettings();
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
       void this.app.workspace.revealLeaf(
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
        void this.app.workspace.revealLeaf(
         this.app.workspace.getLeavesOfType(ZK_RECENT_TYPE)[0]
        );
        this.app.workspace.trigger("zk-navigation:refresh-recent-view");
    
    }

    async clearShowingSettings(BranchTab=0){
        this.settings.zoomPanScaleArr = [];
        this.settings.BranchTab = BranchTab;
    }

    async revealFileInIndexView(){
        
        const filePath = this.app.workspace.getActiveViewOfType(FileView)?.file?.path

        if(filePath){

            let indexFlag = false;

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
                    void this.clearShowingSettings();
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
                void this.clearShowingSettings();
                this.RefreshIndexViewFlag = true;
                await this.openIndexView();
            }
            return;            
        }
    }

    /**
     * 打开"挂载到容器"选择器,把指定 MOC 加入/移出某个工作区容器(Space/MOC)。
     */
    openFolderMountModal(file: TFile): void {
        if (!isMocFile(file)) {
            new Notice("仅支持 .moc / .moc.md 文件");
            return;
        }
        if (!this.workspaceStore) {
            new Notice(t("Space index is not ready"));
            return;
        }
        if (this.workspaceStore.getContainers().length === 0) {
            new Notice(t("No Spaces yet. Create one in the right drawer first."));
            return;
        }
        new ContainerMountModal(this.app, this.workspaceStore, file.path).open();
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
                const content = await this.app.vault.read(mocFile);
                let modified = false;

                let parsedJson: unknown;
                try {
                    parsedJson = JSON.parse(content);
                } catch {
                    continue;
                }
                if (!isRecord(parsedJson)) {
                    continue;
                }
                const json = parsedJson as {
                    nodes?: unknown[];
                    crossDomainLinks?: Record<string, unknown>;
                };

                // rename 事件触发时,oldPath 对应的文件已不存在,无法走 metadataCache 解析,
                // 只能按原字符串形式直接匹配 JSON 节点的 target/wikiLink。
                const oldName = oldPath.split('/').pop() || '';
                const oldPathNoExt = this.getPathWithoutExtension(oldPath);
                const newPathNoExt = this.getPathWithoutExtension(file.path);

                const nextWikiLinkFor = (wl: unknown): string | null => {
                    if (typeof wl !== 'string') return null;
                    if (wl === oldBasename) return file.basename;
                    if (wl === oldPath) return file.path;
                    if (wl === oldPathNoExt) return newPathNoExt;
                    if (wl === oldName) return file.name;
                    return null;
                };

                const walkNodes = (nodes: unknown[]) => {
                    for (const node of nodes || []) {
                        if (!isRecord(node)) continue;
                        const isText = node.nodeType === 'text' || node.isTextOnly === true;
                        const linkKey = typeof node.target === 'string'
                            ? 'target'
                            : (typeof node.wikiLink === 'string' ? 'wikiLink' : null);
                        if (!isText && linkKey) {
                            const current = node[linkKey];
                            const next = nextWikiLinkFor(current);
                            if (next !== null && next !== current) {
                                // alias/displayText 与原链接一致时跟随变化;用户自定义别名保留
                                if (linkKey === 'target') {
                                    if (node.alias === current) {
                                        node.alias = next;
                                    }
                                } else if (node.displayText === current) {
                                    node.displayText = next;
                                }
                                node[linkKey] = next;
                                modified = true;
                            }
                        }
                        if (Array.isArray(node.children) && node.children.length > 0) {
                            walkNodes(node.children);
                        }
                    }
                };

                walkNodes(Array.isArray(json.nodes) ? json.nodes : []);

                // 跨域关联存的是完整 filePath,直接按路径比对
                if (isRecord(json.crossDomainLinks)) {
                    for (const links of Object.values(json.crossDomainLinks)) {
                        if (!Array.isArray(links)) continue;
                        for (const link of links) {
                            if (isRecord(link) && link.filePath === oldPath) {
                                link.filePath = file.path;
                                modified = true;
                            }
                        }
                    }
                }

                if (modified) {
                    await this.app.vault.modify(mocFile, JSON.stringify(json, null, 2));
                }
            }

        } catch (error: unknown) {
            console.error('Error updating MOC links after rename:', error);
            new Notice(`更新 MOC 文件链接失败: ${error instanceof Error ? error.message : String(error)}`);
        }
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

    private async openCreatedMOC(file: TFile): Promise<void> {
        this.settings.mocCurrentFile = file.path;
        await this.saveData(this.settings);
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

    /**
     * 共享创建逻辑:校验目录 → 文件名安全化 → 已存在策略 → 写入合法 .moc.md。
     * 三处入口(右键文件夹 / zk-new-moc-embed / URI create)共用,消除行为漂移。
     */
    async createMOCFile(opts: CreateMOCOptions = {}): Promise<TFile> {
        const layout = opts.layout
            ?? (this.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free');
        const baseName = opts.name?.trim()
            || (t('default MOC file prefix') + '-' + moment().format('YYYYMMDDHHmmss'));

        // 1) 目录校验:不存在则报错(不静默新建,避免脚本误写)
        const folderPath = (opts.folderPath ?? '').replace(/\/+$/, '');
        if (folderPath) {
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folder) throw new Error(t('MOC folder not found').replace('{path}', folderPath));
            if (!(folder instanceof TFolder)) throw new Error(t('MOC not a folder').replace('{path}', folderPath));
        }

        // 2) 文件名安全化(去掉非法字符 / 路径分隔符)
        const safeName = baseName.replace(/[\\/:*?"<>|]/g, '_');
        const filePath = folderPath
            ? `${folderPath}/${safeName}${MOC_FILE_SUFFIX}`
            : `${safeName}${MOC_FILE_SUFFIX}`;

        // 3) 已存在策略
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        const rootId = opts.rootId?.trim();
        const content = rootId
            ? createMOCJsonWithInitialNode(layout, opts.title?.trim() || t('Default node title'), rootId)
            : createMOCJsonWithInitialNode(layout, opts.title?.trim() || t('Default node title'));
        if (existing) {
            if (!(existing instanceof TFile)) throw new Error(t('MOC path occupied').replace('{path}', filePath));
            if (!opts.overwrite) throw new Error(t('MOC file already exists').replace('{path}', filePath));
            await this.app.vault.modify(existing, content);
            return existing;
        }
        return await this.app.vault.create(filePath, content);
    }

    private async createMOCInFolder(folder: TFolder): Promise<TFile | null> {
        try {
            const file = await this.createMOCFile({ folderPath: folder.path });
            await this.openCreatedMOC(file);
            return file;
        } catch (e) {
            console.error('[zk-navigation] 新建思维树失败', e);
            new Notice(`新建失败: ${e.message}`);
            return null;
        }
    }

    /**
     * 版本升级后弹出更新公告。无 lastShownChangelogVersion 记录时(新安装 / 老用户首次升级),
     * 弹出当前版本对应的那一条;后续升级弹出 lastShown→current 之间的所有新条目。
     * 弹完或无内容可弹时都会把 lastShown 更新为当前版本,保证下次不重复。
     */
    private showChangelogIfNeeded(): void {
        const currentVersion = this.manifest.version;
        const lastShown = this.settings.lastShownChangelogVersion;
        if (lastShown === currentVersion) return;

        const entries = getUnreadEntries(lastShown, currentVersion);
        if (entries.length === 0) {
            this.settings.lastShownChangelogVersion = currentVersion;
            void this.saveData(this.settings);
            return;
        }

        new ChangelogModal(this.app, entries, currentVersion, () => {
            this.settings.lastShownChangelogVersion = currentVersion;
            void this.saveData(this.settings);
        }).open();
    }

    /**
     * 首次安装时弹出操作教程。已有配置数据的老用户升级时不弹,避免误判为第一次使用。
     * 新用户看完教程后同时标记当前版本更新公告已读,避免连续弹两个启动弹窗。
     */
    private showFirstUseTutorialIfNeeded(): boolean {
        if (this.settings.hasSeenFirstUseTutorial) return false;

        new GettingStartedModal(this.app, () => {
            this.settings.hasSeenFirstUseTutorial = true;
            if (!this.settings.lastShownChangelogVersion) {
                this.settings.lastShownChangelogVersion = this.manifest.version;
            }
            void this.saveData(this.settings);
        }).open();
        return true;
    }

    private registerNotebookNavigatorFolderMenu() {
        const nnPlugin = (this.app as { plugins?: { plugins?: Record<string, { api?: NotebookNavigatorApi } | undefined> } }).plugins?.plugins?.['notebook-navigator'] as { api?: NotebookNavigatorApi } | undefined;
        const nn = nnPlugin?.api;
        const register = nn?.menus?.registerFolderMenu;
        if (typeof register !== 'function') return;
        try {
            this.nnFolderMenuDispose = register.call(
                nn?.menus,
                ({ addItem, folder }: NotebookNavigatorMenuContext) => {
                    addItem((item: NotebookNavigatorMenuItem) => {
                        item.setTitle(t('New MOC file'))
                            .setIcon('git-branch')
                            .onClick(async () => {
                                await this.createMOCInFolder(folder);
                            });
                    });
                }
            );
        } catch (e: unknown) {
            console.error('[zk-navigation] 注册 notebook-navigator 文件夹菜单失败', e);
        }
    }

    async onunload() {
        await this.detachPluginViews();

        // 移除工作区注入的 <style>,避免热重载后残留旧 CSS
        activeDocument.getElementById('zkw-styles')?.remove();

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

        void this.saveData(this.settings);
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
