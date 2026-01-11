import { App, FuzzySuggestModal, TFile, Notice, Setting } from "obsidian";

/**
 * 跨领域节点选择器
 * 第一步：选择 MOC 文件
 */
export class CrossDomainMOCModal extends FuzzySuggestModal<TFile> {
    mocFiles: TFile[];
    currentNode: any;
    currentMOCPath: string;
    onSubmit: (mocFile: TFile, currentNode: any, currentMOCPath: string) => void;

    constructor(
        app: App,
        mocFiles: TFile[],
        currentNode: any,
        currentMOCPath: string,
        onSubmit: (mocFile: TFile, currentNode: any, currentMOCPath: string) => void
    ) {
        super(app);
        this.mocFiles = mocFiles;
        this.currentNode = currentNode;
        this.currentMOCPath = currentMOCPath;
        this.onSubmit = onSubmit;
        this.setPlaceholder("选择要关联的 MOC 文件...");
    }

    getItems(): TFile[] {
        // 过滤掉当前 MOC 文件
        return this.mocFiles.filter(f => f.path !== this.currentMOCPath);
    }

    getItemText(item: TFile): string {
        return item.basename;
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent) {
        this.onSubmit(item, this.currentNode, this.currentMOCPath);
    }
}

/**
 * 跨领域节点选择器
 * 第二步：选择 MOC 文件中的节点，并选择是否包含子节点
 */
export class CrossDomainNodeModal extends FuzzySuggestModal<any> {
    nodes: any[];
    sourceNode: any;
    sourceMOCPath: string;
    targetMOCFile: TFile;
    onSubmit: (sourceNode: any, sourceMOCPath: string, targetNodes: any[], targetMOCFile: TFile) => void;
    includeChildren: boolean = false; // 是否包含子节点

    constructor(
        app: App,
        nodes: any[],
        sourceNode: any,
        sourceMOCPath: string,
        targetMOCFile: TFile,
        onSubmit: (sourceNode: any, sourceMOCPath: string, targetNodes: any[], targetMOCFile: TFile) => void
    ) {
        super(app);
        this.nodes = nodes;
        this.sourceNode = sourceNode;
        this.sourceMOCPath = sourceMOCPath;
        this.targetMOCFile = targetMOCFile;
        this.onSubmit = onSubmit;
        this.setPlaceholder(`选择 ${targetMOCFile.basename} 中的节点...`);
        this.includeChildren = false;
    }

    onOpen() {
        super.onOpen();
        // 在模态框底部添加设置区域
        const promptContainer = this.modalEl.querySelector('.prompt');
        if (promptContainer) {
            const settingContainer = document.createElement('div');
            settingContainer.addClass('cross-domain-setting');
            settingContainer.style.padding = '10px 20px';
            settingContainer.style.borderTop = '1px solid var(--background-modifier-border)';

            // 添加标题说明
            const heading = settingContainer.createEl('div');
            heading.textContent = '是否包含子节点';
            heading.style.fontWeight = 'bold';
            heading.style.marginBottom = '10px';

            new Setting(settingContainer)
                .addToggle((toggle) => {
                    toggle.setValue(false);
                    toggle.onChange((value) => {
                        this.includeChildren = value;
                    });
                });

            promptContainer.appendChild(settingContainer);
        }
    }

    getItems(): any[] {
        // 展开所有节点，包括子节点
        const flatNodes: any[] = [];
        const flattenNodes = (nodes: any[], level: number = 0) => {
            for (const node of nodes) {
                // 添加缩进级别到节点对象
                node._level = level;
                flatNodes.push(node);
                // 递归展开子节点
                if (node.children && node.children.length > 0) {
                    flattenNodes(node.children, level + 1);
                }
            }
        };
        flattenNodes(this.nodes);
        return flatNodes;
    }

    getItemText(item: any): string {
        // 兼容 MOCTreeNode 和 ZKNode 两种类型
        const nodeId = item.nodeID || item.IDStr || item.ID;
        const title = item.title || item.displayText || '';

        // 根据层级添加缩进
        const indent = '  '.repeat(item._level || 0);
        const prefix = item._level > 0 ? '└' : '';

        return `${indent}${prefix} ${nodeId} - ${title}`;
    }

    onChooseItem(item: any, evt: MouseEvent | KeyboardEvent) {
        // 根据选择决定返回的节点列表
        const targetNodes = this.includeChildren && item.children
            ? [item, ...this.getAllDescendants(item)]
            : [item];

        this.onSubmit(this.sourceNode, this.sourceMOCPath, targetNodes, this.targetMOCFile);
    }

    /**
     * 递归获取所有子孙节点
     */
    private getAllDescendants(node: any): any[] {
        const descendants: any[] = [];
        if (node.children && node.children.length > 0) {
            for (const child of node.children) {
                descendants.push(child);
                descendants.push(...this.getAllDescendants(child));
            }
        }
        return descendants;
    }
}
