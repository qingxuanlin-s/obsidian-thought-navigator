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

        new Setting(containerEl).setName(t("Zettelkasten Navigation")).setHeading();

        // ========== 通用功能 (General) ==========
        const generalTitle = new Setting(containerEl).setName(t("General")).setHeading().settingEl;
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
                .addOption("nebula", t("Nebula style"))
                .setValue(this.plugin.settings.themeStyle || "modern")
                .onChange((value) => {
                    this.plugin.settings.themeStyle = value as 'default' | 'modern' | 'nebula';
                    this.plugin.applyTheme();
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
        new Setting(containerEl).setName(t("thought-tree-graph-view")).setHeading();
        const branchSection = containerEl.createDiv("zk-setting-card");
        this.plugin.settings.graphType = "structure";
        const structureSettingDiv = branchSection.createDiv("zk-local-section")

        await this.updateSructureSettings(structureSettingDiv);

        new Setting(branchSection)
            .setName(t("detail panel side"))
            .setDesc(t("detail panel side desc"))
            .addDropdown(options => options
                .addOption("right", t("detail side right"))
                .addOption("left", t("detail side left"))
                .setValue(this.plugin.settings.detailPanelSide || "right")
                .onChange((value) => {
                    this.plugin.settings.detailPanelSide = value as 'left' | 'right';
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(branchSection)
            .setName(t("detail auto open"))
            .setDesc(t("detail auto open desc"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.detailPanelAutoOpen === true)
                .onChange((value) => {
                    this.plugin.settings.detailPanelAutoOpen = value;
                })
            );

        new Setting(branchSection)
            .setName(t("default file open mode"))
            .setDesc(t("default file open mode desc"))
            .addDropdown(options => options
                .addOption("replace", t("open mode replace"))
                .addOption("tab", t("open mode tab"))
                .addOption("split-left", t("open mode split-left"))
                .addOption("split-right", t("open mode split-right"))
                .setValue(this.plugin.settings.defaultFileOpenMode || "tab")
                .onChange((value) => {
                    this.plugin.settings.defaultFileOpenMode = value as 'replace' | 'tab' | 'split-left' | 'split-right';
                    void this.plugin.saveData(this.plugin.settings);
                })
            );

        // ========== 工作区 (Workspace) ==========
        new Setting(containerEl).setName(t("ws settings section")).setHeading();
        const workspaceSection = containerEl.createDiv("zk-setting-card");

        new Setting(workspaceSection)
            .setName(t("ws project folder"))
            .setDesc(t("ws project folder desc"))
            .addSearch((cb) => {
                new FolderSuggest(this.app, cb.inputEl);
                cb.setPlaceholder("config/workspace")
                    .setValue(this.plugin.settings.projectFolderPath)
                    .onChange((value) => {
                        this.plugin.settings.projectFolderPath = value.trim();
                        void this.plugin.saveData(this.plugin.settings);
                        this.notifyWorkspaceTaskSettingsChanged();
                    });
            });

        new Setting(workspaceSection)
            .setName(t("ws task prefix"))
            .setDesc(t("ws task prefix desc"))
            .addText((cb) => {
                cb.setPlaceholder(t("ws task prefix placeholder"))
                    .setValue(this.plugin.settings.wsTaskPrefix)
                    .onChange((value) => {
                        this.plugin.settings.wsTaskPrefix = value;
                        void this.plugin.saveData(this.plugin.settings);
                        this.notifyWorkspaceTaskSettingsChanged();
                    });
            });

        const autoPrefixSetting = new Setting(workspaceSection)
            .setName(t("ws task prefix auto"))
            .setDesc(t("ws task prefix auto desc"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.wsTaskPrefixAuto !== false)
                .onChange((value) => {
                    this.plugin.settings.wsTaskPrefixAuto = value;
                    void this.plugin.saveData(this.plugin.settings);
                    this.notifyWorkspaceTaskSettingsChanged();
                })
            );
        autoPrefixSetting.settingEl.addClass('zk-setting-subsetting');

        new Setting(workspaceSection)
            .setName(t("ws task file tag"))
            .setDesc(t("ws task file tag desc"))
            .addText((cb) => {
                cb.setPlaceholder(t("ws task file tag placeholder"))
                    .setValue(this.plugin.settings.wsTaskFileTag)
                    .onChange((value) => {
                        this.plugin.settings.wsTaskFileTag = value.trim();
                        void this.plugin.saveData(this.plugin.settings);
                        this.notifyWorkspaceTaskSettingsChanged();
                    });
            });

        // ========== 局部视图 (Local Graph) ==========
        new Setting(containerEl).setName(t("thought-local-graph-view")).setHeading();
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
        const hiddenSectionTitle = new Setting(containerEl).setName("隐藏选项").setHeading().settingEl;
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

    private notifyWorkspaceTaskSettingsChanged(): void {
        window.dispatchEvent(new CustomEvent('zkw-workspace-task-settings-change', {
            detail: {
                projectFolderPath: this.plugin.settings.projectFolderPath,
                taskPrefix: this.plugin.settings.wsTaskPrefix,
                taskPrefixAuto: this.plugin.settings.wsTaskPrefixAuto !== false,
                taskFileTag: this.plugin.settings.wsTaskFileTag,
            },
        }));
    }

    async udpateFolderList(folderListDiv:HTMLDivElement){
        folderListDiv.empty();

        for(let i=0;i<this.plugin.settings.FolderList.length;i++){
            const folder = this.plugin.settings.FolderList[i];
            const folderDiv = folderListDiv.createEl('div');
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
            .setName(t("Node text display mode"))
            .setDesc(t("Control whether branch nodes show ID, title, or combined text"))
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
            .setName(t("Node layout style"))
            .setDesc(t("Free nodes keep manual placement; auto nodes create new nodes in a fixed mind-map layout"))
            .addDropdown(options => options
                .addOption("free", t("Free nodes"))
                .addOption("auto", t("Auto nodes"))
                .setValue(this.plugin.settings.nodeLayoutStyle || "auto")
                .onChange((value) => {
                    this.plugin.settings.nodeLayoutStyle = value as 'free' | 'auto';
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );

        new Setting(structureSettingDiv)
            .setName(t("Default growth direction for auto layout"))
            .setDesc(t("Used when an auto-layout branch has no separate growth direction"))
            .addDropdown(options => options
                .addOption("bidirectional", t("Bidirectional"))
                .addOption("top-down", t("Top down"))
                .addOption("radial", t("Radial"))
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
        quickActionSummary.setText(t("Quick actions"));
        quickActionSummary.addClass('zk-details-summary');

        const quickActionContent = quickActionDetails.createDiv('zk-details-content');

        new Setting(quickActionContent)
            .setName(t("Smart connection"))
            .setDesc(t("When enabled, dragging a placeholder or unconnected free node near another node automatically attaches it as a child"))
            .addToggle(toggle => toggle.setValue(this.plugin.settings.smartConnection)
                .onChange((value) => {
                    this.plugin.settings.smartConnection = value;
                    this.plugin.RefreshIndexViewFlag = true;
                })
            );
    }

    private bindGeneralTitleUnlock(
        generalTitleEl: HTMLElement,
        hiddenTitleEl: HTMLElement,
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
                    .setPlaceholder(t("default MOC heading title"))
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
        void this.plugin.saveData(this.plugin.settings);
    }


}
