import ZKNavigationPlugin from "main";
import { App, PluginSettingTab, Setting, SettingDefinitionItem, requireApiVersion } from "obsidian";
import { FolderSuggest } from "../suggester/FolderSuggester";
import { t } from "../lang/helper";
import { FileSuggest } from "src/suggester/FileSuggester";

interface SearchableSetting {
    name: string;
    desc?: string;
    render: (setting: Setting) => void;
}

export class ZKNavigationSettngTab extends PluginSettingTab {

    plugin: ZKNavigationPlugin
    private showFileExtensionSettings = false;
    private hiddenMOCOptionsUnlocked = false;
    private generalTitleClickCount = 0;
    private lastGeneralTitleClickTime = 0;
    private readonly unlockIntervalMs = 450;

    constructor(app: App, plugin: ZKNavigationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            { name: t("Zettelkasten Navigation"), render: (setting) => { setting.setHeading(); } },
            {
                name: t("General"),
                render: (setting) => {
                    setting.setHeading();
                    this.bindGeneralTitleUnlock(setting.settingEl);
                },
            },
            { type: 'group', cls: 'zk-setting-card', items: this.getGeneralSettings() },
            {
                type: 'group', heading: t("thought-tree-graph-view"), cls: 'zk-setting-card',
                items: [...this.getStructureSettings(), ...this.getQuickActionSettings(), ...this.getBranchSettings()],
            },
            { type: 'group', heading: t("ws settings section"), cls: 'zk-setting-card', items: this.getWorkspaceSettings() },
            {
                type: 'group', heading: t("thought-local-graph-view"), cls: 'zk-setting-card',
                items: [
                    ...this.getLocalSettings(() => {
                        this.showFileExtensionSettings = !this.showFileExtensionSettings;
                        if (requireApiVersion('1.13.0')) this.refreshDomState();
                    }),
                    ...this.getFileExtensionSettings().map(item => ({ ...item, visible: () => this.showFileExtensionSettings })),
                ],
            },
            {
                type: 'group', heading: "隐藏选项", cls: 'zk-setting-card',
                visible: () => this.hiddenMOCOptionsUnlocked,
                items: this.getHiddenSettings(),
            },
        ];
    }

    // Obsidian 1.13 之前沿用原布局，控件与声明式设置共用定义。
    display(): void {

        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl).setName(t("Zettelkasten Navigation")).setHeading();

        // ========== 通用功能 (General) ==========
        const generalTitle = new Setting(containerEl).setName(t("General")).setHeading().settingEl;
        const generalSection = containerEl.createDiv("zk-setting-card");

        // 主题模式设置
        this.renderSettings(generalSection, this.getGeneralSettings());

        // ========== 分支视图 (Index Graph) ==========
        new Setting(containerEl).setName(t("thought-tree-graph-view")).setHeading();
        const branchSection = containerEl.createDiv("zk-setting-card");
        this.plugin.settings.graphType = "structure";
        const structureSettingDiv = branchSection.createDiv("zk-local-section")

        void this.updateSructureSettings(structureSettingDiv);

        this.renderSettings(branchSection, this.getBranchSettings());

        // ========== 工作区 (Workspace) ==========
        new Setting(containerEl).setName(t("ws settings section")).setHeading();
        const workspaceSection = containerEl.createDiv("zk-setting-card");

        this.renderSettings(workspaceSection, this.getWorkspaceSettings());

        // ========== 局部视图 (Local Graph) ==========
        new Setting(containerEl).setName(t("thought-local-graph-view")).setHeading();
        const localSection = containerEl.createDiv("zk-setting-card");

        this.renderSettings(localSection, this.getLocalSettings(() => this.hideDiv(inoutlinksSectionDiv)));

        const inoutlinksSectionDiv = localSection.createDiv("zk-local-section zk-hidden")

        this.renderSettings(inoutlinksSectionDiv, this.getFileExtensionSettings());

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

    private getGeneralSettings(): SearchableSetting[] {
        return [
            {
                name: t("Theme mode"),
                render: (setting) => {
                    setting
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
                },
            },
            {
                name: t("Theme style"),
                render: (setting) => {
                    setting
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
                },
            },
            {
                name: t("Edge style"),
                render: (setting) => {
                    setting
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
                },
            }
        ];
    }

    private getBranchSettings(): SearchableSetting[] {
        return [
            {
                name: t("detail panel side"),
                desc: t("detail panel side desc"),
                render: (setting) => {
                    setting
                    .addDropdown(options => options
                        .addOption("right", t("detail side right"))
                        .addOption("left", t("detail side left"))
                        .setValue(this.plugin.settings.detailPanelSide || "right")
                        .onChange((value) => {
                            this.plugin.settings.detailPanelSide = value as 'left' | 'right';
                            this.plugin.RefreshIndexViewFlag = true;
                        })
                    );
                },
            },
            {
                name: t("detail auto open"),
                desc: t("detail auto open desc"),
                render: (setting) => {
                    setting
                    .addToggle(toggle => toggle.setValue(this.plugin.settings.detailPanelAutoOpen === true)
                        .onChange((value) => {
                            this.plugin.settings.detailPanelAutoOpen = value;
                        })
                    );
                },
            },
            {
                name: t("default file open mode"),
                desc: t("default file open mode desc"),
                render: (setting) => {
                    setting
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
                },
            }
        ];
    }

    private getWorkspaceSettings(): SearchableSetting[] {
        return [
            {
                name: t("ws project folder"),
                desc: t("ws project folder desc"),
                render: (setting) => {
                    setting
                    .addSearch((cb) => {
                        new FolderSuggest(this.app, cb.inputEl);
                cb.setPlaceholder(t("Example: folder1/folder2"))
                            .setValue(this.plugin.settings.projectFolderPath)
                            .onChange((value) => {
                                this.plugin.settings.projectFolderPath = value.trim();
                                void this.plugin.saveData(this.plugin.settings);
                                this.notifyWorkspaceTaskSettingsChanged();
                            });
                    });
                },
            },
            {
                name: t("ws task prefix"),
                desc: t("ws task prefix desc"),
                render: (setting) => {
                    setting
                    .addText((cb) => {
                        cb.setPlaceholder(t("ws task prefix placeholder"))
                            .setValue(this.plugin.settings.wsTaskPrefix)
                            .onChange((value) => {
                                this.plugin.settings.wsTaskPrefix = value;
                                void this.plugin.saveData(this.plugin.settings);
                                this.notifyWorkspaceTaskSettingsChanged();
                            });
                    });
                },
            },
            {
                name: t("ws task prefix auto"),
                desc: t("ws task prefix auto desc"),
                render: (setting) => {
                    setting
                    .addToggle(toggle => toggle.setValue(this.plugin.settings.wsTaskPrefixAuto !== false)
                        .onChange((value) => {
                            this.plugin.settings.wsTaskPrefixAuto = value;
                            void this.plugin.saveData(this.plugin.settings);
                            this.notifyWorkspaceTaskSettingsChanged();
                        })
                    );
                        setting.settingEl.addClass('zk-setting-subsetting');
                },
            },
            {
                name: t("ws task file tag"),
                desc: t("ws task file tag desc"),
                render: (setting) => {
                    setting
                    .addText((cb) => {
                        cb.setPlaceholder(t("ws task file tag placeholder"))
                            .setValue(this.plugin.settings.wsTaskFileTag)
                            .onChange((value) => {
                                this.plugin.settings.wsTaskFileTag = value.trim();
                                void this.plugin.saveData(this.plugin.settings);
                                this.notifyWorkspaceTaskSettingsChanged();
                            });
                    });
                },
            }
        ];
    }

    private getLocalSettings(onToggleDetails: () => void): SearchableSetting[] {
        return [
            {
                name: t("Open close-relative graph"),
                desc: t("Mermaid graph to display parent, siblings and sons"),
                render: (setting) => {
                    setting
                    .addToggle(toggle => toggle.setValue(this.plugin.settings.FamilyGraphToggle)
                        .onChange((value) => {
                            this.plugin.settings.FamilyGraphToggle = value;
                            this.plugin.RefreshIndexViewFlag = true;
                        })
                    );
                },
            },
            {
                name: t("Open inoutlinks graph"),
                desc: t("Mermaid graph to display inlinks and outlinks"),
                render: (setting) => {
                    setting
                    .addToggle(toggle => toggle.setValue(this.plugin.settings.InOutlinksGraphToggle)
                        .onChange((value) => {
                            this.plugin.settings.InOutlinksGraphToggle = value;
                            this.plugin.RefreshIndexViewFlag = true;
                        })
                    ).addExtraButton((cb)=>{
                        cb.setIcon("settings")
                        .onClick(()=>{
                            onToggleDetails();
                        })
                    });
                },
            }
        ];
    }

    private getFileExtensionSettings(): SearchableSetting[] {
        return [
            {
                name: t("Detect file extensions"),
                render: (setting) => {
                    setting
                    .addDropdown(options => options
                        .addOption("all", t("all file extension"))
                        .addOption("md", t(".md only"))
                        .setValue(this.plugin.settings.FileExtension)
                            .onChange((value) => {
                            this.plugin.settings.FileExtension = value;
                                this.plugin.RefreshIndexViewFlag = true;
                            })
                    );
                },
            }
        ];
    }

    private getStructureSettings(): SearchableSetting[] {
        return [
            {
                name: t("Show note ID in branch view"),
                desc: t("Display note IDs on cards in branch view"),
                render: (setting) => {
                    setting
                    .addToggle(toggle => toggle.setValue(this.plugin.settings.showNoteIdInBranchView)
                        .onChange((value) => {
                            this.plugin.settings.showNoteIdInBranchView = value;
                            this.plugin.RefreshIndexViewFlag = true;
                        })
                    );
                },
            },
            {
                name: t("Node text display mode"),
                desc: t("Control whether branch nodes show ID, title, or combined text"),
                render: (setting) => {
                    setting
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
                },
            },
            {
                name: t("Node layout style"),
                desc: t("Free nodes keep manual placement; auto nodes create new nodes in a fixed mind-map layout"),
                render: (setting) => {
                    setting
                    .addDropdown(options => options
                        .addOption("free", t("Free nodes"))
                        .addOption("auto", t("Auto nodes"))
                        .setValue(this.plugin.settings.nodeLayoutStyle || "auto")
                        .onChange((value) => {
                            this.plugin.settings.nodeLayoutStyle = value as 'free' | 'auto';
                            this.plugin.RefreshIndexViewFlag = true;
                        })
                    );
                },
            },
            {
                name: t("Default growth direction for auto layout"),
                desc: t("Used when an auto-layout branch has no separate growth direction"),
                render: (setting) => {
                    setting
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
                },
            }
        ];
    }

    private getQuickActionSettings(): SearchableSetting[] {
        return [
            {
                name: t("Smart connection"),
                desc: t("When enabled, dragging a placeholder or unconnected free node near another node automatically attaches it as a child"),
                render: (setting) => {
                    setting
                    .addToggle(toggle => toggle.setValue(this.plugin.settings.smartConnection)
                        .onChange((value) => {
                            this.plugin.settings.smartConnection = value;
                            this.plugin.RefreshIndexViewFlag = true;
                        })
                    );
                },
            }
        ];
    }

    private getHiddenSettings(): SearchableSetting[] {
        return [
            {
                name: t("MOC Folder Location"),
                desc: t("Folder containing MOC index notes"),
                render: (setting) => {
                    setting
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
                },
            },
            {
                name: t("Heading Title"),
                desc: t("The heading title to parse (e.g. '思维树' for '# 思维树')"),
                render: (setting) => {
                    setting
                    .addText((cb) =>
                        cb.setValue(this.plugin.settings.mocHeadingTitle)
                            .setPlaceholder(t("default MOC heading title"))
                            .onChange((value) => {
                                this.plugin.settings.mocHeadingTitle = value;
                                this.plugin.RefreshIndexViewFlag = true;
                            })
                    );
                },
            }
        ];
    }

    private renderSettings(container: HTMLElement, definitions: SearchableSetting[]): void {
        for (const definition of definitions) {
            const setting = new Setting(container).setName(definition.name);
            if (definition.desc) setting.setDesc(definition.desc);
            definition.render(setting);
        }
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
            const folderDiv = folderListDiv.createDiv();
            new Setting(folderDiv)
            .addSearch((cb) => {
                new FolderSuggest(this.app, cb.inputEl);
                cb.setPlaceholder(t("Example: folder1/folder2"))
                    .setValue(folder)
                    .onChange((value) => {
                        this.plugin.settings.FolderList[i] = value;
                        this.plugin.RefreshIndexViewFlag = true;
                    });
                    (cb as unknown as { containerEl: HTMLElement }).containerEl.addClass("zk-full-search");

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

        this.renderSettings(structureSettingDiv, this.getStructureSettings());

        // 添加"快捷操作"展开项
        const quickActionDetails = structureSettingDiv.createEl('details');
        quickActionDetails.addClass('zk-details');

        const quickActionSummary = quickActionDetails.createEl('summary');
        quickActionSummary.setText(t("Quick actions"));
        quickActionSummary.addClass('zk-details-summary');

        const quickActionContent = quickActionDetails.createDiv('zk-details-content');

        this.renderSettings(quickActionContent, this.getQuickActionSettings());
    }

    private bindGeneralTitleUnlock(
        generalTitleEl: HTMLElement,
        hiddenTitleEl?: HTMLElement,
        hiddenSectionEl?: HTMLDivElement
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
                hiddenTitleEl?.removeClass("zk-hidden");
                hiddenSectionEl?.removeClass("zk-hidden");
                if (requireApiVersion('1.13.0')) {
                    if (!hiddenSectionEl) this.refreshDomState();
                }
                this.generalTitleClickCount = 0;
            }
        });
    }

    private renderHiddenMOCSettings(container: HTMLDivElement) {
        container.empty();

        this.renderSettings(container, this.getHiddenSettings());

    }

    hide(): void {
        if(this.plugin.RefreshIndexViewFlag === true){
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        }
        void this.plugin.saveData(this.plugin.settings);
    }

}
