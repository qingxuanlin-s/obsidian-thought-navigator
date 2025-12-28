import { AbstractInputSuggest, App, Modal, Notice, Setting, TAbstractFile, TFile } from "obsidian";
import { t } from "src/lang/helper";
import ZKNavigationPlugin from "main";
import { ZKNode } from "src/view/indexView";

// Markdown 文件建议器
class MarkdownFileSuggest extends AbstractInputSuggest<TFile> {
    private inputEl: HTMLInputElement;

    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.inputEl = inputEl;
    }

    getSuggestions(inputStr: string): TFile[] {
        const abstractFiles = this.app.vault.getAllLoadedFiles().filter(f => f.path.endsWith(".md"));
        const files: TFile[] = [];
        const lowerCaseInputStr = inputStr.toLowerCase();

        abstractFiles.forEach((file: TAbstractFile) => {
            if (
                file instanceof TFile &&
                (file.basename.toLowerCase().contains(lowerCaseInputStr) ||
                 file.path.toLowerCase().contains(lowerCaseInputStr))
            ) {
                files.push(file);
            }
        });

        return files.slice(0, 10); // 限制显示10个结果
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.setText(file.basename);
        el.createDiv({ text: file.path, cls: "suggestion-note" });
    }

    selectSuggestion(file: TFile): void {
        this.inputEl.value = file.basename;
        this.inputEl.trigger("input");
        this.close();
    }
}

export class AddFreeNodeModal extends Modal {
    plugin: ZKNavigationPlugin;
    availableNodes: ZKNode[];
    onSubmit: (result: {
        wikiLink: string;
        nodeID: string;
        relationText: string;
        file: TFile | null;
        connectToNodeID?: string;
        connectionRelation?: string;
    }) => void;

    wikiLink: string = "";
    nodeID: string = "";
    relationText: string = "";
    connectToNodeID: string = "";
    connectionRelation: string = "";

    // UI 元素引用
    nodeIDSetting: Setting | null = null;
    nodeIDInputEl: HTMLInputElement | null = null;

    constructor(
        app: App,
        plugin: ZKNavigationPlugin,
        availableNodes: ZKNode[],
        suggestedID: string,
        onSubmit: (result: {
            wikiLink: string;
            nodeID: string;
            relationText: string;
            file: TFile | null;
            connectToNodeID?: string;
            connectionRelation?: string;
        }) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.availableNodes = availableNodes;
        this.nodeID = suggestedID;
        this.onSubmit = onSubmit;
    }

    /**
     * 根据父节点 ID 自动生成子节点 ID
     * 规则：数字和字母间隔生成
     * - 如果父节点最后一级是数字，则生成字母后缀：a.1 -> a.1.a
     * - 如果父节点最后一级是字母，则生成数字后缀：a.1.a -> a.1.a.1
     * 如果生成的 ID 已存在，则顺延（字母：a,b,c... 数字：1,2,3...）
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
     * 如：a.1 -> a.1.a, a.1.b, a.1.c...
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
            // 只考虑字母后缀
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

        // 如果所有单字母都用完了，使用双字母 aa, ab, ac...
        for (let i = 0; i < letters.length; i++) {
            for (let j = 0; j < letters.length; j++) {
                const doubleLetter = letters[i] + letters[j];
                if (!existingSuffixes.has(doubleLetter)) {
                    return `${parentNodeID}.${doubleLetter}`;
                }
            }
        }

        // 如果双字母也用完了，使用三字母
        return `${parentNodeID}.aaa`;
    }

    /**
     * 生成数字后缀的子节点 ID
     * 如：a.1.a -> a.1.a.1, a.1.a.2, a.1.a.3...
     */
    private generateNumberSuffix(parentNodeID: string): string {
        // 获取父节点的所有子节点
        const existingChildren = this.getDirectChildren(parentNodeID);

        // 提取已存在的数字后缀
        const existingNumbers = new Set<number>();
        existingChildren.forEach(child => {
            const parts = child.IDStr.split('.');
            const lastPart = parts[parts.length - 1];
            // 只考虑数字后缀
            if (/^\d+$/.test(lastPart)) {
                existingNumbers.add(parseInt(lastPart, 10));
            }
        });

        // 找到第一个未使用的数字（从1开始）
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
        return this.availableNodes.filter(node => {
            // 检查是否是直接子节点
            const nodeIdParts = node.IDStr.split('.');
            const parentIdParts = parentNodeID.split('.');
            
            // 子节点的层级应该比父节点多1
            if (nodeIdParts.length !== parentIdParts.length + 1) return false;
            
            // 子节点的 ID 应该以父节点 ID 开头
            return node.IDStr.startsWith(parentNodeID + '.');
        });
    }

    /**
     * 更新节点 ID 输入框
     */
    updateNodeIDInput(newID: string) {
        this.nodeID = newID;
        if (this.nodeIDInputEl) {
            this.nodeIDInputEl.value = newID;
            this.nodeIDInputEl.placeholder = newID;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "添加自由节点" });

        // 连接到节点（必选，移到最前面）
        if (this.availableNodes.length > 0) {
            const nodeOptions: Record<string, string> = {};
            this.availableNodes.forEach((node) => {
                nodeOptions[node.IDStr] = `${node.ID}: ${node.title || node.displayText}`;
            });

            new Setting(contentEl)
                .setName("连接到节点 *")
                .setDesc("必选，选择要连接的父节点，将自动生成子节点 ID")
                .addDropdown((dropdown) => {
                    // 添加空选项作为提示
                    dropdown.addOption("", "-- 请选择父节点 --");
                    
                    Object.keys(nodeOptions).forEach((key) => {
                        dropdown.addOption(key, nodeOptions[key]);
                    });
                    
                    dropdown.setValue(this.connectToNodeID).onChange((value) => {
                        this.connectToNodeID = value;
                        
                        // 当选择父节点后，自动生成子节点 ID
                        if (value) {
                            const generatedID = this.generateChildNodeID(value);
                            this.updateNodeIDInput(generatedID);
                        } else {
                            this.updateNodeIDInput("");
                        }
                    });
                });
        } else {
            // 如果没有可用节点，显示提示
            contentEl.createEl("p", {
                text: "当前 MOC 中没有可用节点，无法添加自由节点。",
                cls: "mod-warning"
            });
            return;
        }

        // Wiki 链接输入（支持搜索）
        new Setting(contentEl)
            .setName("Wiki 链接 *")
            .setDesc("搜索现有文件或输入新文件名")
            .addText((text) => {
                text
                    .setPlaceholder("搜索文件或输入新文件名")
                    .setValue(this.wikiLink)
                    .onChange((value) => {
                        this.wikiLink = value;
                    });

                // 添加文件建议器
                new MarkdownFileSuggest(this.app, text.inputEl);
            });

        // 节点 ID 输入（自动生成，只读显示）
        this.nodeIDSetting = new Setting(contentEl)
            .setName("节点 ID")
            .setDesc("自动生成，基于父节点 ID")
            .addText((text) => {
                this.nodeIDInputEl = text.inputEl;
                text
                    .setPlaceholder(this.nodeID || "请先选择父节点")
                    .setValue(this.nodeID)
                    .setDisabled(true) // 设置为只读
                    .onChange((value) => {
                        this.nodeID = value;
                    });
            });

        // 连接关系描述
        new Setting(contentEl)
            .setName("连接关系")
            .setDesc("可选，描述与父节点的关系")
            .addText((text) =>
                text
                    .setPlaceholder("如：补充、扩展、澄清")
                    .setValue(this.connectionRelation)
                    .onChange((value) => {
                        this.connectionRelation = value;
                    })
            );

        // 按钮
        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("创建")
                    .setCta()
                    .onClick(() => {
                        // 验证必填字段
                        if (!this.connectToNodeID) {
                            new Notice("请先选择要连接的父节点");
                            return;
                        }

                        if (!this.wikiLink.trim()) {
                            new Notice("Wiki 链接不能为空");
                            return;
                        }

                        if (!this.nodeID.trim()) {
                            new Notice("节点 ID 生成失败，请重新选择父节点");
                            return;
                        }

                        // 查找或创建文件
                        let file = this.app.metadataCache.getFirstLinkpathDest(
                            this.wikiLink,
                            ""
                        );

                        this.onSubmit({
                            wikiLink: this.wikiLink,
                            nodeID: this.nodeID.trim(),
                            relationText: this.relationText.trim(),
                            file,
                            connectToNodeID: this.connectToNodeID,
                            connectionRelation: this.connectionRelation.trim() || undefined,
                        });
                        this.close();
                    })
            )
            .addButton((btn) =>
                btn.setButtonText("取消").onClick(() => {
                    this.close();
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
