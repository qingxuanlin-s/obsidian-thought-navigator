import ZKNavigationPlugin from "main";
import { App, PluginSettingTab, Setting } from "obsidian";
import { FolderSuggest } from "../suggester/FolderSuggester";
import { t } from "../lang/helper";
import { FileSuggest } from "src/suggester/FileSuggester";

export class ZKNavigationSettngTab extends PluginSettingTab {

    plugin: ZKNavigationPlugin
    private hiddenMOCOptionsUnlocked = false;
    private generalTitleClickCount = 0;
    private lastGeneralTitleClickTime = 0;
    private readonly unlockIntervalMs = 450;

    constructor(app: App, plugin: ZKNavigationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display() {

        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h1", {text: t("Zettelkasten Navigation")});

        // ========== 通用功能 (General) ==========
        const generalTitle = containerEl.createEl("h3", { text: t("General") });
        const generalSection = containerEl.createDiv("zk-setting-card");

        // 主题模式设置
        new Setting(generalSection)
            .setName(t("Theme mode"))
            .addDropdown(options => options
                .addOption("auto", t("Follow Obsidian theme"))
                .addOption("dark", t("Dark theme"))
                .addOption("light", t("Light theme"))
                .setValue(this.plugin.settings.themeMode)
                .onChange((value) => {
                    this.plugin.settings.themeMode = value as 'dark' | 'light' | 'auto';
                    this.plugin.applyTheme();
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(generalSection)
            .setName(t("Theme style"))
            .addDropdown(options => options
                .addOption("default", t("Default style"))
                .addOption("modern", t("Modern style"))
                .setValue(this.plugin.settings.themeStyle || "modern")
                .onChange((value) => {
                    this.plugin.settings.themeStyle = value as 'default' | 'modern';
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(generalSection)
            .setName(t("Edge style"))
            .addDropdown(options => options
                .addOption("straight", t("Straight line"))
                .addOption("bezier", t("Bezier curve"))
                .addOption("polyline", t("Polyline"))
                .setValue(this.plugin.settings.edgeStyle || "bezier")
                .onChange((value) => {
                    this.plugin.settings.edgeStyle = value as 'straight' | 'bezier' | 'polyline';
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        // ========== 分支视图 (Index Graph) ==========
        containerEl.createEl("h3", { text: t("zk-index-graph-view") });
        const branchSection = containerEl.createDiv("zk-setting-card");
        let structureSettingDiv: HTMLDivElement;
        let roadmapSettingDiv: HTMLDivElement;
        const updateBranchSettingsVisibility = () => {
            if (this.plugin.settings.graphType === "roadmap") {
                structureSettingDiv.addClass("zk-hidden");
                roadmapSettingDiv.removeClass("zk-hidden");
            } else {
                roadmapSettingDiv.addClass("zk-hidden");
                structureSettingDiv.removeClass("zk-hidden");
            }
        };

        new Setting(branchSection)
            .setName(t("Index graph styles"))
            .addDropdown(options => options
                .addOption("structure", t("structure"))
                .addOption("roadmap",t("roadmap"))
                .setValue(this.plugin.settings.graphType)
                .onChange((value) => {
                    this.plugin.settings.graphType = value;
                    this.plugin.RefreshIndexViewFlag = true;
                    updateBranchSettingsVisibility();
                })
            );

        roadmapSettingDiv = branchSection.createDiv("zk-local-section zk-hidden")

        new Setting(roadmapSettingDiv)
            .setName(t("Shorten the distance between adjacent nodes"))
            .setDesc(t("⚠Required restart to take effect"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.nodeClose)
            .onChange((value) => {
                this.plugin.settings.nodeClose = value;
                this.plugin.RefreshIndexViewFlag = true;
            })
        );

        new Setting(roadmapSettingDiv)
            .setName(t("Branches uncrossing"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.gitUncrossing)
            .onChange((value) => {
                this.plugin.settings.gitUncrossing = value;
                this.plugin.RefreshIndexViewFlag = true;
            })
        );

        structureSettingDiv = branchSection.createDiv("zk-local-section zk-hidden")

        await this.updateSructureSettings(structureSettingDiv);
        updateBranchSettingsVisibility();

        // ========== 局部视图 (Local Graph) ==========
        containerEl.createEl("h3", { text: t("zk-local-graph-view") });
        const localSection = containerEl.createDiv("zk-setting-card");

        new Setting(localSection)
            .setName(t("Open close-relative graph"))
            .setDesc(t("Mermaid graph to display parent, siblings and sons"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.FamilyGraphToggle)
                .onChange((value) => {
                    this.plugin.settings.FamilyGraphToggle = value;
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(localSection)
            .setName(t("Open inoutlinks graph"))
            .setDesc(t("Mermaid graph to display inlinks and outlinks"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.InOutlinksGraphToggle)
                .onChange((value) => {
                    this.plugin.settings.InOutlinksGraphToggle = value;
                    this.plugin.RefreshIndexViewFlag = true;
                })
            ).addExtraButton((cb)=>{
                cb.setIcon("settings")
                .onClick(()=>{
                    this.hideDiv(inoutlinksSectionDiv);
                })
            })

        const inoutlinksSectionDiv = localSection.createDiv("zk-local-section zk-hidden")

        new Setting(inoutlinksSectionDiv)
        .setName(t("Detect file extensions"))
        .addDropdown(options => options
            .addOption("all", t("all file extension"))
            .addOption("md", t(".md only"))
            .setValue(this.plugin.settings.FileExtension)
                .onChange((value) => {
                this.plugin.settings.FileExtension = value;
                    this.plugin.RefreshIndexViewFlag = true;
                })
        )

        // ========== 隐藏选项（通过通用功能标题快速点击 3 次解锁） ==========
        const hiddenSectionTitle = containerEl.createEl("h3", { text: "隐藏选项" });
        hiddenSectionTitle.addClass("zk-hidden");
        const hiddenSection = containerEl.createDiv("zk-setting-card");
        hiddenSection.addClass("zk-hidden");

        this.renderHiddenMOCSettings(hiddenSection);
        if (this.hiddenMOCOptionsUnlocked) {
            hiddenSectionTitle.removeClass("zk-hidden");
            hiddenSection.removeClass("zk-hidden");
        }

        this.bindGeneralTitleUnlock(generalTitle, hiddenSectionTitle, hiddenSection);
    }

    hideDiv(div:HTMLDivElement){

        if(!div.classList.contains("zk-hidden")){
            div.addClass("zk-hidden");
        }else{
            div.removeClass("zk-hidden");
        }
    }

    async udpateFolderList(folderListDiv:HTMLDivElement){
        folderListDiv.empty();

        for(let i=0;i<this.plugin.settings.FolderList.length;i++){
            let folder = this.plugin.settings.FolderList[i];
            let folderDiv = folderListDiv.createEl('div');
            new Setting(folderDiv)
            .addSearch((cb) => {
                new FolderSuggest(this.app, cb.inputEl);
                cb.setPlaceholder(t("Example: folder1/folder2"))
                    .setValue(folder)
                    .onChange((value) => {
                        this.plugin.settings.FolderList[i] = value;
                        this.plugin.RefreshIndexViewFlag = true;
                    });
                    // @ts-ignore
                    cb.containerEl.addClass("zk-full-search");

            })
            .addExtraButton((cb)=>{
                cb.setIcon("trash")
                .onClick(async()=>{
                    this.plugin.settings.FolderList.splice(i,1);
                    await this.udpateFolderList(folderListDiv);
                })
            })
        }
    }

    async updateCanvasAddSettings(canvasAdditionSection:HTMLDivElement){
        canvasAdditionSection.empty();
        new Setting(canvasAdditionSection)
            .setName(t("set the fixed path for exported canvas file"))
            .setDesc(t("if empty, it will create a new canvas file every time"))
                .addSearch((cb) =>{
                    new FileSuggest(this.app, cb.inputEl);
                    cb.setPlaceholder(t("Example: folder/filename.canvas"))
                    .setValue(this.plugin.settings.canvasFilePath)
                    .onChange((value) => {
                        if(value.endsWith(".canvas")){
                            this.plugin.settings.canvasFilePath = value;
                        }else{
                            this.plugin.settings.canvasFilePath = "";
                        }
                    })
                }
        )
        new Setting(canvasAdditionSection)
            .setName(t("set default width and height for cards"))
            .addText((cb) => {

                cb.inputEl.placeholder = t("card width");
                cb.setValue(this.plugin.settings.cardWidth.toString())
                    .onChange((value) => {
                        if(/^[1-9]\d*$/.test(value)){
                            this.plugin.settings.cardWidth = Number(value);
                        }else{
                            this.plugin.settings.cardWidth = 400;
                        }

                    })
                }
            )
            .addText((cb) => {
                cb.inputEl.placeholder = t("card height");
                cb.setValue(this.plugin.settings.cardHeight.toString())
                    .onChange((value) => {
                        if(/^[1-9]\d*$/.test(value)){
                            this.plugin.settings.cardHeight = Number(value);
                        }else{
                            this.plugin.settings.cardHeight = 240;
                        }

                    })
                }
            )

        new Setting(canvasAdditionSection)
            .setName(t("Narrow to heading"))
            .addText((cb) => {
                cb.setValue(this.plugin.settings.canvasSubpath.toString())
                    .onChange((value) => {
                        this.plugin.settings.canvasSubpath = value;
                    })
                })
                .addDropdown(options => options
                    .addOption("string",t("string match"))
                    .addOption("regex", t("regex match"))
                    .setValue(this.plugin.settings.headingMatchMode)
                    .onChange((value)=>{
                        this.plugin.settings.headingMatchMode = value;
                    })
                );


        new Setting(canvasAdditionSection)
            .setName(t("Set color for cards"))
            .addExtraButton((cb)=>{
                cb.setIcon("rotate-ccw")
                .onClick(async ()=>{
                    this.plugin.settings.canvasCardColor = "#C0C0C0";
                    await this.updateCanvasAddSettings(canvasAdditionSection);
                })
            })
            .addColorPicker(color => color.setValue(this.plugin.settings.canvasCardColor)
                .onChange((value)=>{
                    this.plugin.settings.canvasCardColor =  value;
                })
            )

        new Setting(canvasAdditionSection)
            .setName(t("Set color for arrow"))
            .addExtraButton((cb)=>{
                cb.setIcon("rotate-ccw")
                .onClick(async()=>{
                    this.plugin.settings.canvasArrowColor = "#C0C0C0";
                    await this.updateCanvasAddSettings(canvasAdditionSection);
                })
            })
            .addColorPicker(color => color.setValue(this.plugin.settings.canvasArrowColor)
                .onChange((value)=>{
                    this.plugin.settings.canvasArrowColor =  value;
                })
            )

    }

    async updateSructureSettings(structureSettingDiv:HTMLDivElement){

        structureSettingDiv.empty();

        new Setting(structureSettingDiv)
            .setName(t("Show note ID in branch view"))
            .setDesc(t("Display note IDs on cards in branch view"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.showNoteIdInBranchView)
                .onChange((value) => {
                    this.plugin.settings.showNoteIdInBranchView = value;
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(structureSettingDiv)
            .setName("文本显示模式")
            .setDesc("控制分支视图节点显示 ID、标题或组合文本")
            .addDropdown(options => options
                .addOption("id", t("id"))
                .addOption("title", t("title"))
                .addOption("both", t("both"))
                .addOption("id-title", t("id-title"))
                .setValue(this.plugin.settings.NodeText || "both")
                .onChange((value) => {
                    this.plugin.settings.NodeText = value;
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(structureSettingDiv)
            .setName("节点布局风格")
            .setDesc("自由节点保留当前自由放置逻辑；自动节点按固定思维导图布局创建新节点")
            .addDropdown(options => options
                .addOption("free", "自由节点")
                .addOption("auto", "自动节点")
                .setValue(this.plugin.settings.nodeLayoutStyle || "free")
                .onChange((value) => {
                    this.plugin.settings.nodeLayoutStyle = value as 'free' | 'auto';
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(structureSettingDiv)
            .setName("自动风格默认生长方向")
            .setDesc("自动节点未单独设置分支布局时使用的默认生长方向")
            .addDropdown(options => options
                .addOption("bidirectional", "双向")
                .addOption("top-down", "上下")
                .addOption("radial", "斜角")
                .setValue(this.plugin.settings.autoLayoutDefaultGrowthDirection || "bidirectional")
                .onChange((value) => {
                    this.plugin.settings.autoLayoutDefaultGrowthDirection = value as 'bidirectional' | 'top-down' | 'radial';
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        // 添加"快捷操作"展开项
        const quickActionDetails = structureSettingDiv.createEl('details');
        quickActionDetails.addClass('zk-details');

        const quickActionSummary = quickActionDetails.createEl('summary');
        quickActionSummary.setText('快捷操作');
        quickActionSummary.addClass('zk-details-summary');

        const quickActionContent = quickActionDetails.createDiv('zk-details-content');

        new Setting(quickActionContent)
            .setName("智能连线")
            .setDesc("开启后，拖拽占位符节点时如果在某节点200px范围内，会自动成为该节点的子节点")
            .addToggle(toggle => toggle.setValue(this.plugin.settings.smartConnection)
                .onChange((value) => {
                    this.plugin.settings.smartConnection = value;
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );
    }

    private bindGeneralTitleUnlock(
        generalTitleEl: HTMLHeadingElement,
        hiddenTitleEl: HTMLHeadingElement,
        hiddenSectionEl: HTMLDivElement
    ) {
        generalTitleEl.addEventListener("click", () => {
            const now = Date.now();
            if (now - this.lastGeneralTitleClickTime > this.unlockIntervalMs) {
                this.generalTitleClickCount = 0;
            }

            this.generalTitleClickCount += 1;
            this.lastGeneralTitleClickTime = now;

            if (this.generalTitleClickCount >= 3) {
                this.hiddenMOCOptionsUnlocked = true;
                hiddenTitleEl.removeClass("zk-hidden");
                hiddenSectionEl.removeClass("zk-hidden");
                this.generalTitleClickCount = 0;
            }
        });
    }

    private renderHiddenMOCSettings(container: HTMLDivElement) {
        container.empty();

        new Setting(container)
            .setName(t("MOC Folder Location"))
            .setDesc(t("Folder containing MOC index notes"))
            .addSearch((cb) => {
                new FolderSuggest(this.app, cb.inputEl);
                cb.setPlaceholder(t("Example: folder1/folder2"))
                    .setValue(this.plugin.settings.mocFolderPath)
                    .onChange((value) => {
                        this.plugin.settings.mocFolderPath = value;
                        this.plugin.settings.mocCurrentFile = '';
                        this.plugin.RefreshIndexViewFlag = true;
                    });
            });

        new Setting(container)
            .setName(t("Heading Title"))
            .setDesc(t("The heading title to parse (e.g. '思维树' for '# 思维树')"))
            .addText((cb) =>
                cb.setValue(this.plugin.settings.mocHeadingTitle)
                    .setPlaceholder("思维树")
                    .onChange((value) => {
                        this.plugin.settings.mocHeadingTitle = value;
                        this.plugin.RefreshIndexViewFlag = true;
                    })
            );
    }

    async hide() {
        if(this.plugin.RefreshIndexViewFlag === true){
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        }
        this.plugin.saveData(this.plugin.settings);
    }


}
