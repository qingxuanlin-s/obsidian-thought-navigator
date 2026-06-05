import { App, EventRef, Notice, setIcon, setTooltip, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { FolderNode, SpaceTemplate } from "src/types/folder";
import { VaultIndex } from "src/index/VaultIndex";
import { SpaceService } from "src/services/SpaceService";
import { BUILTIN_TEMPLATES } from "src/templates";
import { isMocFile, isMocPath, stripMocSuffix } from "src/utils/utils";
import { FolderMountModal } from "src/modal/folderMountModal";
import { FilePickerModal } from "src/modal/filePickerModal";
import { t } from "src/lang/helper";

/**
 * 文件夹抽屉(Layer 1)
 *
 * - 渲染来自 VaultIndex 的自建 Space 树(单文件持久化在插件数据目录的 spaces.json)
 * - 空树时展示模板卡片(PARA / 空白)
 * - 顶部「+ 新建 Space」原位输入
 * - 单击行 = 折叠/展开;子节点行末尾按钮 = 新建子文件夹;垃圾桶 = 删除
 */
export class FolderDrawer {
    private app: App;
    private plugin: ZKNavigationPlugin;
    private index: VaultIndex;
    private service: SpaceService;
    private root: HTMLElement;
    private bodyEl: HTMLElement;
    private isOpen: boolean = false;
    private unsubscribe: (() => void) | null = null;
    private mocChangeRef: EventRef | null = null;
    // 节点拖拽载荷:跨节点共享,避免依赖 DataTransfer 序列化(可拖 file 节点重新挂载)
    private dragPayload: { nodeId: string } | null = null;
    // 上次定位过的 MOC 路径:仅在切换到新 MOC 时自动展开祖先文件夹,避免反复覆盖用户折叠操作
    private lastFocusedMoc: string = '';
    private revealCurrentOnNextRender = false;

    constructor(parent: HTMLElement, app: App, plugin: ZKNavigationPlugin, index: VaultIndex, service: SpaceService) {
        this.app = app;
        this.plugin = plugin;
        this.index = index;
        this.service = service;

        this.root = parent.createDiv("zk-folder-drawer");
        this.root.setAttribute("aria-hidden", "true");

        const header = this.root.createDiv("zk-folder-drawer-header");
        header.createSpan("zk-folder-drawer-title").setText(t("Spaces"));
        const addBtn = header.createDiv("zk-folder-drawer-action");
        setIcon(addBtn, "plus");
        setTooltip(addBtn, t("New Space"));
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showNewSpaceInput();
        });
        const closeBtn = header.createDiv("zk-folder-drawer-close");
        setIcon(closeBtn, "x");
        setTooltip(closeBtn, t("Close"));
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.close();
        });

        this.bodyEl = this.root.createDiv("zk-folder-drawer-body");
    }

    toggle(): void { this.isOpen ? this.close() : this.open(); }

    open(): void {
        if (this.isOpen) return;
        this.subscribe();
        this.revealCurrentOnNextRender = true;
        this.render();
        this.root.addClass("is-open");
        this.root.setAttribute("aria-hidden", "false");
        this.isOpen = true;
    }

    close(): void {
        if (!this.isOpen) return;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.mocChangeRef) {
            this.app.workspace.offref(this.mocChangeRef);
            this.mocChangeRef = null;
        }
        this.root.removeClass("is-open");
        this.root.setAttribute("aria-hidden", "true");
        this.isOpen = false;
    }

    private subscribe(): void {
        if (!this.unsubscribe) {
            this.unsubscribe = this.index.onChange(() => {
                if (this.isOpen) this.render();
            });
        }
        if (!this.mocChangeRef) {
            // 思维树视图切换 MOC 时,本抽屉跟随刷新并定位到当前 MOC
            this.mocChangeRef = this.app.workspace.on(
                "zk-navigation:refresh-index-graph",
                () => { if (this.isOpen) this.render(); },
            );
        }
    }

    // ---------- 渲染 ----------

    private render(): void {
        this.bodyEl.empty();
        if (this.index.isEmpty()) {
            this.renderEmptyState();
            return;
        }

        // 切换到新 MOC 时自动展开其所在文件夹链(只触发一次,允许用户随后再折叠)
        const currentMoc = this.plugin.settings.mocCurrentFile;
        if (currentMoc && currentMoc !== this.lastFocusedMoc) {
            this.lastFocusedMoc = currentMoc;
            this.revealCurrentOnNextRender = true;
            this.expandAncestorsForMoc(currentMoc);
        }

        // 当前 MOC 未挂载到任何文件夹时,顶部展示快捷挂载入口(主要解决"新建 MOC 看不到"的问题)
        if (currentMoc) {
            const hostFolders = this.index.getFoldersHostingMoc(currentMoc);
            if (hostFolders.length === 0) {
                this.renderUnmountedCurrentBanner(currentMoc);
            }
        }

        const tree = this.bodyEl.createDiv("zk-folder-drawer-tree");
        for (const root of this.index.getRoots()) {
            this.renderNode(tree, root);
        }

        if (this.revealCurrentOnNextRender) {
            this.revealCurrentOnNextRender = false;
            requestAnimationFrame(() => this.revealCurrentRow());
        }
    }

    private revealCurrentRow(): void {
        const target = this.bodyEl.querySelector(".zk-folder-drawer-row.is-current") as HTMLElement | null;
        if (!target) return;

        const bodyRect = this.bodyEl.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (targetRect.top < bodyRect.top) {
            this.bodyEl.scrollTop -= bodyRect.top - targetRect.top + 12;
        } else if (targetRect.bottom > bodyRect.bottom) {
            this.bodyEl.scrollTop += targetRect.bottom - bodyRect.bottom + 12;
        }
    }

    /**
     * 把承载该 MOC 的文件夹及其所有祖先标记为展开。
     * 通过 SpaceService 一次性 commit 所有要展开的祖先,持久化到 spaces.json。
     */
    private expandAncestorsForMoc(mocPath: string): void {
        const hosts = this.index.getFoldersHostingMoc(mocPath);
        if (hosts.length === 0) return;
        const toExpand: string[] = [];
        const visited = new Set<string>();
        for (const host of hosts) {
            let cur: FolderNode | undefined = host;
            while (cur && !visited.has(cur.id)) {
                visited.add(cur.id);
                if (cur.collapsed) toExpand.push(cur.id);
                cur = cur.parentId ? this.index.getNode(cur.parentId) : undefined;
            }
        }
        if (toExpand.length === 0) return;
        this.service.expandAncestors(toExpand).catch((e) => {
            console.error("[zk-navigation] 自动展开持久化失败", e);
        });
    }

    private renderUnmountedCurrentBanner(mocPath: string): void {
        const file = this.app.vault.getFileByPath(mocPath);
        if (!file || !(file instanceof TFile) || !isMocFile(file)) return;

        const banner = this.bodyEl.createDiv("zk-folder-drawer-unmounted-banner");
        const icon = banner.createSpan("zk-folder-drawer-unmounted-icon");
        setIcon(icon, "git-branch");
        const text = banner.createDiv("zk-folder-drawer-unmounted-text");
        text.createDiv("zk-folder-drawer-unmounted-name").setText(stripMocSuffix(file.basename));
        text.createDiv("zk-folder-drawer-unmounted-hint").setText(t("Current MOC is not mounted to any folder"));
        const mountBtn = banner.createDiv("zk-folder-drawer-unmounted-action");
        setIcon(mountBtn, "folder-plus");
        setTooltip(mountBtn, t("Mount to folder"));
        mountBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            new FolderMountModal(this.app, this.index, this.service, file).open();
        });
    }

    private renderEmptyState(): void {
        const empty = this.bodyEl.createDiv("zk-folder-drawer-empty");
        empty.createDiv("zk-folder-drawer-empty-title").setText(t("No Spaces yet"));
        empty.createDiv("zk-folder-drawer-empty-desc").setText(t("Choose a template below or create an empty Space."));

        const newSpaceBtn = empty.createDiv("zk-folder-drawer-new-space-btn zk-folder-drawer-new-space-btn-primary");
        setIcon(newSpaceBtn.createSpan(), "plus");
        newSpaceBtn.createSpan().setText(t("New empty Space"));
        newSpaceBtn.addEventListener("click", () => this.showNewSpaceInput());

        const cards = empty.createDiv("zk-folder-drawer-templates");
        for (const tmpl of BUILTIN_TEMPLATES) {
            const card = cards.createDiv("zk-folder-drawer-template-card");
            const icon = card.createDiv("zk-folder-drawer-template-icon");
            this.setTemplateIcon(icon, tmpl.icon || "folder");
            const localizedTemplate = this.localizeTemplate(tmpl);
            card.createDiv("zk-folder-drawer-template-name").setText(localizedTemplate.name);
            card.createDiv("zk-folder-drawer-template-desc").setText(localizedTemplate.description);
            card.addEventListener("click", () => this.applyTemplate(tmpl.id));
        }
    }

    private renderNode(parent: HTMLElement, node: FolderNode): void {
        if (node.kind === 'file') {
            this.renderFileNode(parent, node);
            return;
        }
        this.renderFolderNode(parent, node);
    }

    private renderFolderNode(parent: HTMLElement, node: FolderNode): void {
        const row = parent.createDiv("zk-folder-drawer-row zk-folder-drawer-row-folder");
        row.style.paddingLeft = `${10 + node.depth * 14}px`;

        const hasChildren = node.childIds.length > 0;
        const chev = row.createSpan("zk-folder-drawer-chev");
        if (hasChildren) {
            setIcon(chev, node.collapsed ? "chevron-right" : "chevron-down");
            chev.addEventListener("click", (e) => { e.stopPropagation(); this.toggleCollapse(node); });
        } else {
            chev.addClass("is-leaf");
        }

        const icon = row.createSpan("zk-folder-drawer-icon");
        if (node.icon && /^\p{Extended_Pictographic}/u.test(node.icon)) {
            icon.setText(node.icon);
        } else {
            setIcon(icon, node.icon || (hasChildren ? "folder" : "folder-closed"));
        }

        row.createSpan("zk-folder-drawer-name").setText(node.name);

        // 行末尾操作:仅鼠标悬停显示
        const actions = row.createDiv("zk-folder-drawer-row-actions");
        const mountBtn = actions.createDiv("zk-folder-drawer-row-action");
        setIcon(mountBtn, "file-plus");
        setTooltip(mountBtn, t("Mount files here"));
        mountBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.openFilePicker(node);
        });
        const addBtn = actions.createDiv("zk-folder-drawer-row-action");
        setIcon(addBtn, "folder-plus");
        setTooltip(addBtn, t("New child folder"));
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showNewChildInput(node, parent, row);
        });
        const delBtn = actions.createDiv("zk-folder-drawer-row-action zk-folder-drawer-row-action-danger");
        setIcon(delBtn, "trash-2");
        setTooltip(delBtn, t("Delete"));
        delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.confirmDelete(node);
        });

        row.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleCollapse(node);
        });
        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openFilePicker(node);
        });
        this.attachDropTarget(row, node);

        this.renderChildren(parent, node);
    }

    private renderFileNode(parent: HTMLElement, node: FolderNode): void {
        const filePath = node.filePath || "";
        const file = this.app.vault.getFileByPath(filePath);
        const exists = file instanceof TFile;
        const isCurrent = this.plugin.settings.mocCurrentFile === filePath;

        const row = parent.createDiv("zk-folder-drawer-row zk-folder-drawer-row-moc");
        row.style.paddingLeft = `${10 + node.depth * 14}px`;
        if (isCurrent) row.addClass("is-current");
        if (!exists) row.style.opacity = "0.5";

        const hasChildren = node.childIds.length > 0;
        const chev = row.createSpan("zk-folder-drawer-chev");
        if (hasChildren) {
            setIcon(chev, node.collapsed ? "chevron-right" : "chevron-down");
            chev.addEventListener("click", (e) => { e.stopPropagation(); this.toggleCollapse(node); });
        } else {
            chev.addClass("is-leaf");
        }

        // 拖拽:把该 file 节点重新挂到其他节点下
        row.draggable = true;
        row.addEventListener("dragstart", (e: DragEvent) => {
            this.dragPayload = { nodeId: node.id };
            row.addClass("zk-folder-drawer-row-dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("application/x-zk-node", node.id);
            }
        });
        row.addEventListener("dragend", () => {
            row.removeClass("zk-folder-drawer-row-dragging");
            this.dragPayload = null;
        });

        const icon = row.createSpan("zk-folder-drawer-icon");
        setIcon(icon, isMocPath(filePath) ? "git-branch" : "file-text");

        const display = isMocPath(filePath)
            ? stripMocSuffix(file ? file.basename : (node.name.replace(/\.md$/i, "")))
            : (file ? file.basename : node.name.replace(/\.md$/i, ""));
        row.createSpan("zk-folder-drawer-name").setText(display);

        const actions = row.createDiv("zk-folder-drawer-row-actions");
        const mountBtn = actions.createDiv("zk-folder-drawer-row-action");
        setIcon(mountBtn, "file-plus");
        setTooltip(mountBtn, t("Mount files here"));
        mountBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.openFilePicker(node);
        });
        const addBtn = actions.createDiv("zk-folder-drawer-row-action");
        setIcon(addBtn, "folder-plus");
        setTooltip(addBtn, t("New child folder"));
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showNewChildInput(node, parent, row);
        });
        const unmount = actions.createDiv("zk-folder-drawer-row-action zk-folder-drawer-row-action-danger");
        setIcon(unmount, "x");
        setTooltip(unmount, t("Unmount from this folder"));
        unmount.addEventListener("click", async (e) => {
            e.stopPropagation();
            const parentNode = node.parentId ? this.index.getNode(node.parentId) : null;
            try {
                if (parentNode) {
                    await this.service.unmountMoc(parentNode.id, filePath);
                    new Notice(t("Unmounted from folder").replace("{name}", parentNode.name));
                }
            } catch (err: any) {
                new Notice(t("Unmount failed").replace("{message}", String(err?.message || err)));
            }
        });

        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openFilePicker(node);
        });
        this.attachDropTarget(row, node);

        row.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.openFileNode(node);
        });

        this.renderChildren(parent, node);
    }

    /** 渲染某节点的子节点(folder/file 混合),折叠时跳过 */
    private renderChildren(parent: HTMLElement, node: FolderNode): void {
        if (node.childIds.length === 0 || node.collapsed) return;
        const childrenEl = parent.createDiv("zk-folder-drawer-children");
        for (const child of this.index.getChildren(node.id)) {
            this.renderNode(childrenEl, child);
        }
    }

    /** 给行绑定"接受节点拖拽 → 重新挂载"的 drop 行为 */
    private attachDropTarget(row: HTMLElement, node: FolderNode): void {
        row.addEventListener("dragover", (e: DragEvent) => {
            const payload = this.dragPayload;
            if (!payload || payload.nodeId === node.id) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            row.addClass("zk-folder-drawer-row-drop-target");
        });
        row.addEventListener("dragleave", () => {
            row.removeClass("zk-folder-drawer-row-drop-target");
        });
        row.addEventListener("drop", async (e: DragEvent) => {
            row.removeClass("zk-folder-drawer-row-drop-target");
            const payload = this.dragPayload;
            if (!payload || payload.nodeId === node.id) return;
            e.preventDefault();
            e.stopPropagation();
            try {
                await this.service.moveNode(payload.nodeId, node.id);
            } catch (err: any) {
                new Notice(t("Move failed").replace("{message}", String(err?.message || err)));
            } finally {
                this.dragPayload = null;
            }
        });
    }

    /** 点击 file 节点:moc → 设为当前思维树并刷新;普通文件 → 在 Obsidian 中打开 */
    private async openFileNode(node: FolderNode): Promise<void> {
        const filePath = node.filePath || "";
        const file = this.app.vault.getFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice(t("File no longer exists"));
            return;
        }
        if (isMocFile(file)) {
            this.plugin.settings.mocCurrentFile = filePath;
            await this.plugin.saveData(this.plugin.settings);
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
            this.render();
        } else {
            await this.app.workspace.getLeaf(false).openFile(file);
        }
    }

    /** 打开多选文件框,把选中的文件挂到该节点下 */
    private openFilePicker(node: FolderNode): void {
        const mounted = this.index.getChildren(node.id)
            .filter(c => c.kind === 'file' && c.filePath)
            .map(c => c.filePath!);
        const label = node.kind === 'file'
            ? stripMocSuffix(node.name)
            : node.name;
        new FilePickerModal(this.app, label, mounted, async (paths) => {
            try {
                if (node.collapsed) await this.service.setCollapsed(node.id, false);
                const n = await this.service.mountFiles(node.id, paths);
                if (n > 0) new Notice(t("Mounted files notice").replace("{count}", String(n)));
            } catch (err: any) {
                new Notice(t("Operation failed").replace("{message}", String(err?.message || err)));
            }
        }).open();
    }

    // ---------- 交互 ----------

    private async toggleCollapse(node: FolderNode): Promise<void> {
        if (node.childIds.length === 0) return;
        try {
            await this.service.setCollapsed(node.id, !node.collapsed);
        } catch (e) {
            console.error("[zk-navigation] 折叠状态保存失败", e);
        }
    }

    private showNewSpaceInput(): void {
        if (!this.isOpen) this.open();
        // 在 body 顶部插入临时输入行
        this.bodyEl.empty();
        const inputRow = this.bodyEl.createDiv("zk-folder-drawer-input-row");
        const input = inputRow.createEl("input", { type: "text", placeholder: t("Space name placeholder") });
        input.addClass("zk-folder-drawer-input");

        let submitted = false;
        const restore = () => this.render();
        const commit = async (tmpl?: SpaceTemplate) => {
            if (submitted) return;
            submitted = true;
            input.removeEventListener("keydown", onKey);
            input.removeEventListener("blur", onBlur);
            const name = input.value.trim();
            if (!name && !tmpl) { restore(); return; }
            try {
                if (tmpl) {
                    const localizedTemplate = this.localizeTemplate(tmpl);
                    await this.service.applyTemplate(localizedTemplate, name || localizedTemplate.name.replace(/\s*[\\/:*?"<>|]\s*/g, ' ').trim());
                } else {
                    await this.service.createSpace(name);
                }
            } catch (e: any) {
                new Notice(t("Create failed").replace("{message}", String(e?.message || e)));
                restore();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); submitted = true; restore(); }
        };
        const onBlur = () => commit();
        input.addEventListener("keydown", onKey);
        input.addEventListener("blur", onBlur);

        // 模板 chip 行:点击 = 用该模板提交(名字空则用模板名作默认)
        const chipsRow = this.bodyEl.createDiv("zk-folder-drawer-chips-row");
        chipsRow.createSpan("zk-folder-drawer-chips-label").setText(t("Templates label"));
        for (const tmpl of BUILTIN_TEMPLATES) {
            const localizedTemplate = this.localizeTemplate(tmpl);
            const chip = chipsRow.createDiv("zk-folder-drawer-chip");
            this.setTemplateIcon(chip.createSpan("zk-folder-drawer-chip-icon"), tmpl.icon || "folder");
            chip.createSpan("zk-folder-drawer-chip-name").setText(localizedTemplate.name);
            setTooltip(chip, localizedTemplate.description);
            // mousedown + preventDefault:抢在 input.blur 之前,且不让输入框失焦
            chip.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                commit(tmpl);
            });
        }

        // 在输入框下方继续展示已有的树(若有)
        if (!this.index.isEmpty()) {
            const tree = this.bodyEl.createDiv("zk-folder-drawer-tree");
            for (const root of this.index.getRoots()) this.renderNode(tree, root);
        }

        setTimeout(() => input.focus(), 0);
    }

    private setTemplateIcon(target: HTMLElement, iconName: string): void {
        if (/^\p{Extended_Pictographic}/u.test(iconName)) {
            target.setText(iconName);
            return;
        }
        setIcon(target, iconName);
    }

    private showNewChildInput(parentNode: FolderNode, parentEl: HTMLElement, anchorRow: HTMLElement): void {
        // 临时输入行插入到当前 row 之后
        const inputRow = parentEl.createDiv("zk-folder-drawer-input-row");
        inputRow.style.paddingLeft = `${10 + (parentNode.depth + 1) * 14}px`;
        anchorRow.after(inputRow);
        const input = inputRow.createEl("input", { type: "text", placeholder: t("New folder name") });
        input.addClass("zk-folder-drawer-input");
        this.bindInputSubmit(input, async (name) => {
            try {
                // 自动展开父节点
                if (parentNode.collapsed) {
                    await this.service.setCollapsed(parentNode.id, false);
                }
                await this.service.createFolder(parentNode.id, name);
            } catch (e: any) {
                new Notice(t("Create failed").replace("{message}", String(e?.message || e)));
            }
        }, () => inputRow.remove());
        setTimeout(() => input.focus(), 0);
    }

    private async confirmDelete(node: FolderNode): Promise<void> {
        const ok = window.confirm(t("Confirm delete Space folder").replace("{name}", node.name));
        if (!ok) return;
        try {
            await this.service.delete(node.id);
        } catch (e: any) {
            new Notice(t("Delete failed").replace("{message}", String(e?.message || e)));
        }
    }

    private async applyTemplate(templateId: string): Promise<void> {
        const tmpl = BUILTIN_TEMPLATES.find(t => t.id === templateId);
        if (!tmpl) return;
        const localizedTemplate = this.localizeTemplate(tmpl);
        // 让用户输入 Space 名(用模板名作为默认)
        this.bodyEl.empty();
        const inputRow = this.bodyEl.createDiv("zk-folder-drawer-input-row");
        const label = inputRow.createSpan("zk-folder-drawer-input-label");
        label.setText(t("Create Space from template").replace("{name}", localizedTemplate.name));
        const input = inputRow.createEl("input", { type: "text", value: localizedTemplate.name.replace(/\s*[\\/:*?"<>|]\s*/g, ' ').trim() });
        input.addClass("zk-folder-drawer-input");
        this.bindInputSubmit(input, async (name) => {
            try {
                await this.service.applyTemplate(localizedTemplate, name);
            } catch (e: any) {
                new Notice(t("Create failed").replace("{message}", String(e?.message || e)));
                this.render();
            }
        }, () => this.render());
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    /**
     * 给输入框绑定 Enter/blur 提交 + Esc 取消,带幂等守卫:
     * 一旦提交开始,立刻摘掉 keydown/blur 监听并标记 submitted,避免 blur 二次触发。
     */
    private bindInputSubmit(
        input: HTMLInputElement,
        onSubmit: (name: string) => Promise<void>,
        onCancel: () => void,
    ): void {
        let submitted = false;
        const trigger = async (mode: 'submit' | 'cancel') => {
            if (submitted) return;
            submitted = true;
            input.removeEventListener("keydown", onKeydown);
            input.removeEventListener("blur", onBlur);
            const name = input.value.trim();
            if (mode === 'cancel' || !name) { onCancel(); return; }
            await onSubmit(name);
        };
        const onKeydown = (e: KeyboardEvent) => {
            if (e.key === "Enter") { e.preventDefault(); trigger('submit'); }
            else if (e.key === "Escape") { e.preventDefault(); trigger('cancel'); }
        };
        const onBlur = () => trigger('submit');
        input.addEventListener("keydown", onKeydown);
        input.addEventListener("blur", onBlur);
    }

    private localizeTemplate(tmpl: SpaceTemplate): SpaceTemplate {
        if (tmpl.id === 'blank') {
            return {
                ...tmpl,
                name: t("Blank Space template name"),
                description: t("Blank Space template description"),
                roots: [{ ...tmpl.roots[0], name: t("My Space template root") }],
            };
        }
        if (tmpl.id === 'zk-three-layer') {
            return {
                ...tmpl,
                name: t("ZK three layer template name"),
                description: t("ZK three layer template description"),
                roots: [
                    { ...tmpl.roots[0], name: t("Overview template root") },
                    { ...tmpl.roots[1], name: t("Topics template root") },
                    { ...tmpl.roots[2], name: t("Local knowledge template root") },
                ],
            };
        }
        if (tmpl.id === 'para') {
            return {
                ...tmpl,
                description: t("PARA template description"),
            };
        }
        return tmpl;
    }
}
