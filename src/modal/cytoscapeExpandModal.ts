import { App, Modal, Notice } from "obsidian";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { GraphData, RenderOptions } from "src/renderer/types";

export class CytoscapeExpandModal extends Modal {
    private renderer: CytoscapeRenderer | null = null;
    private graphContainer: HTMLElement | null = null;
    private readonly titleText: string;
    private readonly graphData: GraphData;
    private readonly renderOptions: RenderOptions;

    constructor(app: App, titleText: string, graphData: GraphData, renderOptions: RenderOptions) {
        super(app);
        this.titleText = titleText;
        this.graphData = graphData;
        this.renderOptions = renderOptions;
    }

    async onOpen(): Promise<void> {
        try {
            const { contentEl } = this;
            this.containerEl.addClass("zk-modal-container");
            this.modalEl.addClass("zk-expand-modal");

            contentEl.empty();

            const header = contentEl.createDiv();
            header.setCssStyles({
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px 8px',
            });
            header.createEl("div", { text: this.titleText });

            this.graphContainer = contentEl.createDiv({ cls: "zk-graph-cytoscape" });
            this.graphContainer.setCssStyles({
                width: "100%",
                height: `${Math.max(320, window.innerHeight - 180)}px`,
                margin: "0",
            });

            this.renderer = new CytoscapeRenderer();
            await this.renderer.render(this.graphContainer, this.graphData, this.renderOptions);

            // 复用局部图常用交互：点击打开文件、悬浮预览
            this.graphContainer.addEventListener('node-click', this.handleNodeClick as EventListener);
            this.graphContainer.addEventListener('node-hover', this.handleNodeHover as EventListener);
        } catch (error) {
            console.error('[CytoscapeExpandModal] failed to open', error);
            new Notice('放大视图打开失败，请查看控制台日志');
        }
    }

    onClose(): void {
        if (this.graphContainer) {
            this.graphContainer.removeEventListener('node-click', this.handleNodeClick as EventListener);
            this.graphContainer.removeEventListener('node-hover', this.handleNodeHover as EventListener);
        }
        if (this.renderer) {
            this.renderer.destroy();
            this.renderer = null;
        }
        this.graphContainer = null;
        this.contentEl.empty();
    }

    private handleNodeClick = (event: Event): void => {
        const detail = (event as CustomEvent).detail as { node?: { file?: { path?: string } | null } };
        const node = detail?.node;
        if (!node?.file?.path) return;
        void this.app.workspace.openLinkText("", node.file.path, 'tab');
    };

    private handleNodeHover = (event: Event): void => {
        const detail = (event as CustomEvent).detail;
        const node = detail?.node;
        const mouseEvent = detail?.event as MouseEvent | undefined;
        if (!node?.file?.path || !mouseEvent) return;

        this.app.workspace.trigger('hover-link', {
            event: mouseEvent,
            source: 'zk-navigation',
            hoverParent: this,
            linktext: "",
            targetEl: mouseEvent.target,
            sourcePath: node.file.path,
        });
    };
}
