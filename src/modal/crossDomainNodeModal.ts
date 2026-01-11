import { App, FuzzySuggestModal, TFile, Notice } from "obsidian";

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
 * 第二步：选择 MOC 文件中的节点
 */
export class CrossDomainNodeModal extends FuzzySuggestModal<any> {
    nodes: any[];
    sourceNode: any;
    sourceMOCPath: string;
    targetMOCFile: TFile;
    onSubmit: (sourceNode: any, sourceMOCPath: string, targetNode: any, targetMOCFile: TFile) => void;

    constructor(
        app: App,
        nodes: any[],
        sourceNode: any,
        sourceMOCPath: string,
        targetMOCFile: TFile,
        onSubmit: (sourceNode: any, sourceMOCPath: string, targetNode: any, targetMOCFile: TFile) => void
    ) {
        super(app);
        this.nodes = nodes;
        this.sourceNode = sourceNode;
        this.sourceMOCPath = sourceMOCPath;
        this.targetMOCFile = targetMOCFile;
        this.onSubmit = onSubmit;
        this.setPlaceholder(`选择 ${targetMOCFile.basename} 中的节点...`);
    }

    getItems(): any[] {
        return this.nodes;
    }

    getItemText(item: any): string {
        // 兼容 MOCTreeNode 和 ZKNode 两种类型
        const nodeId = item.nodeID || item.IDStr || item.ID;
        const title = item.title || item.displayText || '';
        return `${nodeId} - ${title}`;
    }

    onChooseItem(item: any, evt: MouseEvent | KeyboardEvent) {
        this.onSubmit(this.sourceNode, this.sourceMOCPath, item, this.targetMOCFile);
    }
}
