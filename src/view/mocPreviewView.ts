import { TextFileView, TFile, WorkspaceLeaf, Menu, IconName } from "obsidian";
import ZKNavigationPlugin from "main";
import { ensureMOCPreviewPNG } from "src/embed/mocEmbedExporter";

export const MOC_PREVIEW_VIEW_TYPE = 'moc-preview';

export class MOCPreviewView extends TextFileView {
    private plugin: ZKNavigationPlugin;
    private imageEl: HTMLImageElement | null = null;
    private renderToken = 0;

    constructor(leaf: WorkspaceLeaf, plugin: ZKNavigationPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return MOC_PREVIEW_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.file?.basename ?? 'MOC Preview';
    }

    getIcon(): IconName {
        return 'image';
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('zk-moc-preview-view');

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile && this.file && file.path === this.file.path) {
                void this.refreshImage();
            }
        }));
    }

    async onClose(): Promise<void> {
        this.imageEl = null;
        this.contentEl.empty();
    }

    getViewData(): string {
        return this.data ?? '';
    }

    setViewData(data: string, _clear: boolean): void {
        this.data = data;
        void this.renderPreview();
    }

    clear(): void {
        this.data = '';
        this.contentEl.empty();
    }

    onPaneMenu(menu: Menu, source: string): void {
        super.onPaneMenu(menu, source);
        menu.addItem((item) => {
            item.setTitle('以 Markdown 打开')
                .setIcon('file-code')
                .onClick(() => this.openAsMarkdown());
        });
    }

    private async renderPreview(): Promise<void> {
        if (!this.file) return;
        const token = ++this.renderToken;

        this.contentEl.empty();
        const loading = this.contentEl.createDiv('zk-moc-preview-loading');
        loading.setText('渲染思维树...');

        try {
            const pngFile = await ensureMOCPreviewPNG(this.file, this.plugin);
            if (token !== this.renderToken) return;
            this.contentEl.empty();
            const img = this.contentEl.createEl('img', { cls: 'zk-moc-preview-img' });
            img.src = this.app.vault.getResourcePath(pngFile);
            img.alt = this.file.basename;
            img.draggable = false;
            this.imageEl = img;
        } catch (e: any) {
            if (token !== this.renderToken) return;
            this.contentEl.empty();
            this.contentEl.createDiv('zk-moc-preview-error')
                .setText(`预览生成失败: ${e?.message ?? e}`);
        }
    }

    private async refreshImage(): Promise<void> {
        if (!this.file || !this.imageEl) return;
        try {
            const pngFile = await ensureMOCPreviewPNG(this.file, this.plugin);
            this.imageEl.src = this.app.vault.getResourcePath(pngFile) + '?t=' + Date.now();
        } catch {
            // 忽略刷新失败
        }
    }

    private async openAsMarkdown(): Promise<void> {
        const leaf = this.leaf;
        const currentState = leaf.getViewState();
        await leaf.setViewState({
            type: 'markdown',
            state: {
                ...(currentState.state ?? {}),
                file: this.file?.path,
                isSwitchToMarkdownViewFromMocView: true,
            },
        } as any);
    }
}
