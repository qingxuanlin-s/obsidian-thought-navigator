import { App, Modal, TFile, setIcon } from "obsidian";
import { t } from "src/lang/helper";

/**
 * 多选文件挂载框。
 * - 右键 Space 文件夹/文件节点弹出,搜索 + 勾选多个 vault 文件
 * - 已挂载在目标节点下的文件用「已挂载」标记并默认禁用
 * - 确认后回调选中的路径数组
 */
export class FilePickerModal extends Modal {
    private allFiles: TFile[];
    private mountedPaths: Set<string>;
    private selected: Set<string> = new Set();
    private targetName: string;
    private onSubmit: (paths: string[]) => void;

    private listEl!: HTMLElement;
    private confirmBtn!: HTMLButtonElement;
    private query = "";
    private readonly RENDER_CAP = 300;

    constructor(
        app: App,
        targetName: string,
        mountedPaths: string[],
        onSubmit: (paths: string[]) => void,
    ) {
        super(app);
        this.targetName = targetName;
        this.mountedPaths = new Set(mountedPaths);
        this.onSubmit = onSubmit;
        // 按修改时间倒序,最近的更可能被挂
        this.allFiles = app.vault.getFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText(t("Add files to node").replace("{name}", this.targetName));
        contentEl.addClass("zk-file-picker");

        const search = contentEl.createEl("input", {
            type: "text",
            placeholder: t("Search files to mount placeholder"),
        });
        search.style.cssText = "width: 100%; margin-bottom: 8px;";
        search.addEventListener("input", () => {
            this.query = search.value.trim().toLowerCase();
            this.renderList();
        });

        this.listEl = contentEl.createDiv("zk-file-picker-list");
        this.listEl.style.cssText =
            "max-height: 50vh; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 6px;";

        const footer = contentEl.createDiv("zk-file-picker-footer");
        footer.style.cssText = "display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;";
        const cancel = footer.createEl("button", { text: t("Cancel") });
        cancel.addEventListener("click", () => this.close());
        this.confirmBtn = footer.createEl("button", { cls: "mod-cta" });
        this.confirmBtn.addEventListener("click", () => {
            if (this.selected.size === 0) return;
            const paths = Array.from(this.selected);
            this.close();
            this.onSubmit(paths);
        });

        this.renderList();
        this.updateConfirm();
        setTimeout(() => search.focus(), 0);
    }

    private renderList(): void {
        this.listEl.empty();
        const q = this.query;
        const matched = (q
            ? this.allFiles.filter(f => f.path.toLowerCase().includes(q))
            : this.allFiles
        ).slice(0, this.RENDER_CAP);

        if (matched.length === 0) {
            const empty = this.listEl.createDiv();
            empty.style.cssText = "padding: 16px; text-align: center; color: var(--text-muted);";
            empty.setText(t("No matching files"));
            return;
        }

        for (const file of matched) {
            const mounted = this.mountedPaths.has(file.path);
            const row = this.listEl.createDiv("zk-file-picker-row");
            row.style.cssText =
                "display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--background-modifier-border-hover);" +
                (mounted ? " opacity: 0.5; cursor: default;" : "");

            const box = row.createSpan();
            box.style.cssText = "flex-shrink: 0; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center;";
            const checked = this.selected.has(file.path);
            setIcon(box, mounted ? "check" : (checked ? "check-square" : "square"));
            box.style.color = (checked || mounted) ? "var(--interactive-accent)" : "var(--text-muted)";

            const name = row.createSpan();
            name.style.cssText = "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
            name.setText(file.basename);

            const path = row.createSpan();
            path.style.cssText = "flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted);";
            path.setText(file.parent && file.parent.path !== "/" ? file.parent.path : "");

            if (mounted) {
                const tag = row.createSpan();
                tag.style.cssText = "flex-shrink: 0; font-size: 11px; color: var(--text-muted);";
                tag.setText(t("Already mounted tag"));
                continue;
            }

            row.addEventListener("click", () => {
                if (this.selected.has(file.path)) this.selected.delete(file.path);
                else this.selected.add(file.path);
                this.renderList();
                this.updateConfirm();
            });
        }
    }

    private updateConfirm(): void {
        const n = this.selected.size;
        this.confirmBtn.setText(t("Add files confirm").replace("{count}", String(n)));
        this.confirmBtn.disabled = n === 0;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
