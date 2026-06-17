import { App, EventRef, Notice, setIcon, setTooltip, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { WorkspaceNode } from "src/types/workspace";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { isMocFile, isMocPath, stripMocSuffix } from "src/utils/utils";
import { FilePickerModal } from "src/modal/filePickerModal";
import { ContainerMountModal } from "src/modal/containerMountModal";
import { t } from "src/lang/helper";

/**
 * 文件夹抽屉(Layer 1)
 *
 * 数据源:WorkspaceStore(typed-node + link,workspace.json)。
 * 容器语义采用 Option A —— Space / MOC 节点当容器:
 *   - 子 MOC(childMoc) = 子文件夹;note/map/project(partOf/serves) = 挂在容器下的项
 *   - "挂载文件" = 把文件建成 note 节点并 partOf 到该容器
 * 空库时展示「新建 Space」入口;单击容器行 = 折叠/展开;行末按钮 = 挂文件 / 新建子文件夹 / 删除。
 */
export class FolderDrawer {
    private app: App;
    private plugin: ZKNavigationPlugin;
    private store: WorkspaceStore;
    private root: HTMLElement;
    private bodyEl: HTMLElement;
    private isOpen: boolean = false;
    private unsubscribe: (() => void) | null = null;
    private mocChangeRef: EventRef | null = null;
    // 节点拖拽载荷:跨节点共享,避免依赖 DataTransfer 序列化
    private dragPayload: { nodeId: string } | null = null;
    // 上次定位过的 MOC 路径:仅在切换到新 MOC 时自动展开祖先,避免反复覆盖用户折叠操作
    private lastFocusedMoc: string = '';
    private revealCurrentOnNextRender = false;

    constructor(parent: HTMLElement, app: App, plugin: ZKNavigationPlugin, store: WorkspaceStore) {
        this.app = app;
        this.plugin = plugin;
        this.store = store;

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
            this.unsubscribe = this.store.onChange(() => {
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

    private isContainer(n: WorkspaceNode): boolean {
        return n.type === 'space' || n.type === 'moc';
    }

    private render(): void {
        this.bodyEl.empty();
        const spaces = this.store.getSpaces();
        if (spaces.length === 0) {
            this.renderEmptyState();
            return;
        }

        // 切换到新 MOC 时自动展开其所在容器链(只触发一次,允许用户随后再折叠)
        const currentMoc = this.plugin.settings.mocCurrentFile;
        if (currentMoc && currentMoc !== this.lastFocusedMoc) {
            this.lastFocusedMoc = currentMoc;
            this.revealCurrentOnNextRender = true;
            this.expandAncestorsForMoc(currentMoc);
        }

        // 当前 MOC 在工作区里还没有节点时,顶部展示快捷挂载入口
        if (currentMoc && !this.store.isFileMounted(currentMoc)) {
            this.renderUnmountedCurrentBanner(currentMoc);
        }

        const tree = this.bodyEl.createDiv("zk-folder-drawer-tree");
        for (const space of spaces) {
            this.renderNode(tree, space, 0);
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

    /** 把承载当前 MOC 的容器及其所有祖先标记为展开(一次 commit 持久化) */
    private expandAncestorsForMoc(mocPath: string): void {
        const hosts = this.store.containersHostingFile(mocPath);
        if (hosts.length === 0) return;
        const toExpand: string[] = [];
        const visited = new Set<string>();
        for (const host of hosts) {
            let curId: string | null = host.id;
            while (curId && !visited.has(curId)) {
                visited.add(curId);
                const cur = this.store.getNode(curId);
                if (cur?.collapsed) toExpand.push(curId);
                curId = this.store.parentContainerOf(curId);
            }
        }
        if (toExpand.length === 0) return;
        this.store.expandNodes(toExpand).catch((e) => {
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
            this.pickContainerForFile(mocPath);
        });
    }

    /** 让用户选一个容器(Space/MOC),把当前 MOC 文件挂进去 */
    private pickContainerForFile(filePath: string): void {
        if (this.store.getContainers().length === 0) {
            new Notice(t("No Spaces yet"));
            return;
        }
        new ContainerMountModal(this.app, this.store, filePath).open();
    }

    private renderEmptyState(): void {
        const empty = this.bodyEl.createDiv("zk-folder-drawer-empty");
        empty.createDiv("zk-folder-drawer-empty-title").setText(t("No Spaces yet"));
        empty.createDiv("zk-folder-drawer-empty-desc").setText(t("Create a Space to organize your MOCs and notes."));

        const newSpaceBtn = empty.createDiv("zk-folder-drawer-new-space-btn zk-folder-drawer-new-space-btn-primary");
        setIcon(newSpaceBtn.createSpan(), "plus");
        newSpaceBtn.createSpan().setText(t("New empty Space"));
        newSpaceBtn.addEventListener("click", () => this.showNewSpaceInput());
    }

    /** 统一渲染:容器(space/moc)带折叠+子树,叶子(note/map/project)可打开 */
    private renderNode(parent: HTMLElement, node: WorkspaceNode, depth: number): void {
        const isContainer = this.isContainer(node);
        const children = isContainer ? this.store.containerChildren(node.id) : [];
        const hasChildren = children.length > 0;
        const filePath = (node as any).filePath as string | undefined;
        const isCurrent = !!filePath && this.plugin.settings.mocCurrentFile === filePath;

        const rowCls = node.type === 'space'
            ? "zk-folder-drawer-row zk-folder-drawer-row-folder"
            : isContainer
                ? "zk-folder-drawer-row zk-folder-drawer-row-folder"
                : "zk-folder-drawer-row zk-folder-drawer-row-moc";
        const row = parent.createDiv(rowCls);
        row.setCssStyles({ paddingLeft: `${10 + depth * 14}px` });
        if (isCurrent) row.addClass("is-current");
        if (filePath && !(this.app.vault.getFileByPath(filePath) instanceof TFile)) {
            row.setCssStyles({ opacity: "0.5" });
        }

        // 折叠箭头(仅容器且有子节点)
        const chev = row.createSpan("zk-folder-drawer-chev");
        if (isContainer && hasChildren) {
            setIcon(chev, node.collapsed ? "chevron-right" : "chevron-down");
            chev.addEventListener("click", (e) => { e.stopPropagation(); this.toggleCollapse(node); });
        } else {
            chev.addClass("is-leaf");
        }

        // 图标
        const icon = row.createSpan("zk-folder-drawer-icon");
        if (node.icon && /^\p{Extended_Pictographic}/u.test(node.icon)) {
            icon.setText(node.icon);
        } else {
            setIcon(icon, this.glyphFor(node, hasChildren));
        }

        // 名称
        const display = filePath && isMocPath(filePath) ? stripMocSuffix(node.title) : node.title;
        row.createSpan("zk-folder-drawer-name").setText(display);

        // 拖拽:非 Space 节点可拖动重挂
        if (node.type !== 'space') {
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
        }

        // 行末操作
        const actions = row.createDiv("zk-folder-drawer-row-actions");
        if (isContainer) {
            this.mkAction(actions, "file-plus", t("Mount files here"), () => this.openFilePicker(node));
            this.mkAction(actions, "folder-plus", t("New child folder"), () => this.showNewChildInput(node, parent, row, depth));
        }
        if (node.type === 'space') {
            this.mkAction(actions, "trash-2", t("Delete"), () => this.confirmDelete(node), true);
        } else {
            // 子节点:解挂(浮回 Space 顶层)+ 删除子树
            this.mkAction(actions, "x", t("Unmount from this folder"), () => this.unmount(node), true);
            this.mkAction(actions, "trash-2", t("Delete"), () => this.confirmDelete(node), true);
        }

        // 容器作为 drop 目标
        if (isContainer) this.attachDropTarget(row, node);

        // 行点击:纯容器(无 filePath)折叠/展开;可打开的(有 filePath)打开
        row.addEventListener("click", (e) => {
            e.stopPropagation();
            if (filePath) { this.openNode(node); }
            else if (isContainer) { this.toggleCollapse(node); }
        });
        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isContainer) this.openFilePicker(node);
        });

        // 子树
        if (isContainer && hasChildren && !node.collapsed) {
            const childrenEl = parent.createDiv("zk-folder-drawer-children");
            for (const child of children) this.renderNode(childrenEl, child, depth + 1);
        }
    }

    private glyphFor(node: WorkspaceNode, hasChildren: boolean): string {
        const filePath = (node as any).filePath as string | undefined;
        switch (node.type) {
            case 'space': return node.icon || 'folder';
            case 'moc': return filePath && isMocPath(filePath) ? 'git-branch' : (hasChildren ? 'folder' : 'folder-closed');
            case 'map': return 'git-fork';
            case 'project': return 'target';
            default: return 'file-text';
        }
    }

    private mkAction(parent: HTMLElement, iconName: string, tip: string, onClick: (e: MouseEvent) => void, danger = false): void {
        const btn = parent.createDiv("zk-folder-drawer-row-action" + (danger ? " zk-folder-drawer-row-action-danger" : ""));
        setIcon(btn, iconName);
        setTooltip(btn, tip);
        btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    }

    /** 给容器行绑定"接受节点拖拽 → 重新挂载" */
    private attachDropTarget(row: HTMLElement, node: WorkspaceNode): void {
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
                await this.store.reparent(payload.nodeId, node.id);
            } catch (err: any) {
                new Notice(t("Move failed").replace("{message}", String(err?.message || err)));
            } finally {
                this.dragPayload = null;
            }
        });
    }

    /** 打开节点:有 filePath 时,.moc → 设为当前思维树;普通文件 → 在 Obsidian 打开 */
    private async openNode(node: WorkspaceNode): Promise<void> {
        const filePath = (node as any).filePath as string | undefined;
        if (!filePath) return;
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

    /** 打开多选文件框,把选中的文件挂到该容器下 */
    private openFilePicker(node: WorkspaceNode): void {
        const mounted = this.store.containerChildren(node.id)
            .map(c => (c as any).filePath as string | undefined)
            .filter((p): p is string => !!p);
        const label = node.title;
        new FilePickerModal(this.app, label, mounted, async (paths) => {
            try {
                if (node.collapsed) await this.store.setCollapsed(node.id, false);
                await this.store.mountFilesToContainer(node.id, paths);
                if (paths.length > 0) new Notice(t("Mounted files notice").replace("{count}", String(paths.length)));
            } catch (err: any) {
                new Notice(t("Operation failed").replace("{message}", String(err?.message || err)));
            }
        }).open();
    }

    // ---------- 交互 ----------

    private async toggleCollapse(node: WorkspaceNode): Promise<void> {
        try {
            await this.store.setCollapsed(node.id, !node.collapsed);
        } catch (e) {
            console.error("[zk-navigation] 折叠状态保存失败", e);
        }
    }

    private async unmount(node: WorkspaceNode): Promise<void> {
        try {
            const ok = await this.store.unmountFromContainer(node.id);
            if (ok) new Notice(t("Unmounted from folder").replace("{name}", node.title));
        } catch (err: any) {
            new Notice(t("Unmount failed").replace("{message}", String(err?.message || err)));
        }
    }

    private showNewSpaceInput(): void {
        if (!this.isOpen) this.open();
        this.bodyEl.empty();
        const inputRow = this.bodyEl.createDiv("zk-folder-drawer-input-row");
        const input = inputRow.createEl("input", { type: "text", placeholder: t("Space name placeholder") });
        input.addClass("zk-folder-drawer-input");
        this.bindInputSubmit(input, async (name) => {
            try {
                await this.store.createSpace(name);
            } catch (e: any) {
                new Notice(t("Create failed").replace("{message}", String(e?.message || e)));
            }
            this.render();
        }, () => this.render());

        // 输入框下方继续展示已有树
        if (this.store.getSpaces().length > 0) {
            const tree = this.bodyEl.createDiv("zk-folder-drawer-tree");
            for (const space of this.store.getSpaces()) this.renderNode(tree, space, 0);
        }
        setTimeout(() => input.focus(), 0);
    }

    private showNewChildInput(parentNode: WorkspaceNode, parentEl: HTMLElement, anchorRow: HTMLElement, depth: number): void {
        const inputRow = parentEl.createDiv("zk-folder-drawer-input-row");
        inputRow.setCssStyles({ paddingLeft: `${10 + (depth + 1) * 14}px` });
        anchorRow.after(inputRow);
        const input = inputRow.createEl("input", { type: "text", placeholder: t("New folder name") });
        input.addClass("zk-folder-drawer-input");
        this.bindInputSubmit(input, async (name) => {
            try {
                if (parentNode.collapsed) await this.store.setCollapsed(parentNode.id, false);
                await this.store.createChildMoc(parentNode.id, name);
            } catch (e: any) {
                new Notice(t("Create failed").replace("{message}", String(e?.message || e)));
            }
        }, () => inputRow.remove());
        setTimeout(() => input.focus(), 0);
    }

    private async confirmDelete(node: WorkspaceNode): Promise<void> {
        const ok = window.confirm(t("Confirm delete Space folder").replace("{name}", node.title));
        if (!ok) return;
        try {
            await this.store.deleteSubtree(node.id);
        } catch (e: any) {
            new Notice(t("Delete failed").replace("{message}", String(e?.message || e)));
        }
    }

    /**
     * Enter/blur 提交 + Esc 取消,带幂等守卫:提交开始即摘监听并标记,避免 blur 二次触发。
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
}
