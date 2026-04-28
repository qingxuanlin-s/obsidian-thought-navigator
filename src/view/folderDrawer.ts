import { App, EventRef, Notice, setIcon, setTooltip, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { FolderNode, SpaceTemplate } from "src/types/folder";
import { VaultIndex } from "src/index/VaultIndex";
import { SpaceService } from "src/services/SpaceService";
import { BUILTIN_TEMPLATES } from "src/templates";
import { isMocFile, stripMocSuffix } from "src/utils/utils";
import { FolderMountModal } from "src/modal/folderMountModal";

/**
 * 文件夹抽屉(Layer 1)
 *
 * - 渲染来自 VaultIndex 的自建 Space 树(单文件持久化在插件数据目录的 spaces.json)
 * - 空树时展示模板卡片(PARA / GTD / 空白)
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
    // MOC 拖拽载荷:跨节点共享,避免依赖 DataTransfer 序列化
    private dragMocPayload: { mocPath: string; fromFolderId: string } | null = null;
    // 上次定位过的 MOC 路径:仅在切换到新 MOC 时自动展开祖先文件夹,避免反复覆盖用户折叠操作
    private lastFocusedMoc: string = '';

    constructor(parent: HTMLElement, app: App, plugin: ZKNavigationPlugin, index: VaultIndex, service: SpaceService) {
        this.app = app;
        this.plugin = plugin;
        this.index = index;
        this.service = service;

        this.root = parent.createDiv("zk-folder-drawer");
        this.root.setAttribute("aria-hidden", "true");

        const header = this.root.createDiv("zk-folder-drawer-header");
        header.createSpan("zk-folder-drawer-title").setText("Space");
        const addBtn = header.createDiv("zk-folder-drawer-action");
        setIcon(addBtn, "plus");
        setTooltip(addBtn, "新建 Space");
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showNewSpaceInput();
        });
        const closeBtn = header.createDiv("zk-folder-drawer-close");
        setIcon(closeBtn, "x");
        setTooltip(closeBtn, "关闭");
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

        // 渲染完成后把高亮行滚入视口
        requestAnimationFrame(() => {
            const target = this.bodyEl.querySelector(".zk-folder-drawer-row.is-current") as HTMLElement | null;
            if (target) target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
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
        text.createDiv("zk-folder-drawer-unmounted-hint").setText("当前 MOC 未挂载到任何文件夹");
        const mountBtn = banner.createDiv("zk-folder-drawer-unmounted-action");
        setIcon(mountBtn, "folder-plus");
        setTooltip(mountBtn, "挂载到文件夹");
        mountBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            new FolderMountModal(this.app, this.index, this.service, file).open();
        });
    }

    private renderEmptyState(): void {
        const empty = this.bodyEl.createDiv("zk-folder-drawer-empty");
        empty.createDiv("zk-folder-drawer-empty-title").setText("还没有 Space");
        empty.createDiv("zk-folder-drawer-empty-desc").setText("从下面挑一个模板,或自己新建一个空 Space。");

        const cards = empty.createDiv("zk-folder-drawer-templates");
        for (const tmpl of BUILTIN_TEMPLATES) {
            const card = cards.createDiv("zk-folder-drawer-template-card");
            const icon = card.createDiv("zk-folder-drawer-template-icon");
            icon.setText(tmpl.icon || "📁");
            card.createDiv("zk-folder-drawer-template-name").setText(tmpl.name);
            card.createDiv("zk-folder-drawer-template-desc").setText(tmpl.description);
            card.addEventListener("click", () => this.applyTemplate(tmpl.id));
        }

        const newSpaceBtn = empty.createDiv("zk-folder-drawer-new-space-btn");
        setIcon(newSpaceBtn.createSpan(), "plus");
        newSpaceBtn.createSpan().setText("新建空 Space");
        newSpaceBtn.addEventListener("click", () => this.showNewSpaceInput());
    }

    private renderNode(parent: HTMLElement, node: FolderNode): void {
        const row = parent.createDiv("zk-folder-drawer-row");
        row.style.paddingLeft = `${10 + node.depth * 14}px`;

        const chev = row.createSpan("zk-folder-drawer-chev");
        const mocList = (node.mocRefs ?? []).filter(p => !!this.app.vault.getFileByPath(p));
        const hasChildren = node.childIds.length > 0 || mocList.length > 0;
        if (hasChildren) {
            setIcon(chev, node.collapsed ? "chevron-right" : "chevron-down");
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
        const addBtn = actions.createDiv("zk-folder-drawer-row-action");
        setIcon(addBtn, "plus");
        setTooltip(addBtn, "新建子文件夹");
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showNewChildInput(node, parent, row);
        });
        const delBtn = actions.createDiv("zk-folder-drawer-row-action zk-folder-drawer-row-action-danger");
        setIcon(delBtn, "trash-2");
        setTooltip(delBtn, "删除");
        delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.confirmDelete(node);
        });

        row.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleCollapse(node);
        });

        // 接受 MOC 拖拽:仅当存在 dragMocPayload 且目标 ≠ 源时高亮 + 接收
        row.addEventListener("dragover", (e: DragEvent) => {
            const payload = this.dragMocPayload;
            if (!payload || payload.fromFolderId === node.id) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            row.addClass("zk-folder-drawer-row-drop-target");
        });
        row.addEventListener("dragleave", () => {
            row.removeClass("zk-folder-drawer-row-drop-target");
        });
        row.addEventListener("drop", async (e: DragEvent) => {
            row.removeClass("zk-folder-drawer-row-drop-target");
            const payload = this.dragMocPayload;
            if (!payload || payload.fromFolderId === node.id) return;
            e.preventDefault();
            e.stopPropagation();
            try {
                await this.service.moveMoc(payload.fromFolderId, node.id, payload.mocPath);
            } catch (err: any) {
                new Notice(`移动失败: ${err?.message || err}`);
            } finally {
                this.dragMocPayload = null;
            }
        });

        if (hasChildren && !node.collapsed) {
            const childrenEl = parent.createDiv("zk-folder-drawer-children");
            for (const child of this.index.getChildren(node.id)) {
                this.renderNode(childrenEl, child);
            }
            for (const mocPath of mocList) {
                this.renderMocRef(childrenEl, node, mocPath);
            }
        }
    }

    private renderMocRef(parent: HTMLElement, ownerFolder: FolderNode, mocPath: string): void {
        const file = this.app.vault.getFileByPath(mocPath);
        if (!file || !(file instanceof TFile) || !isMocFile(file)) return;
        const isCurrent = this.plugin.settings.mocCurrentFile === mocPath;

        const row = parent.createDiv("zk-folder-drawer-row zk-folder-drawer-row-moc");
        row.style.paddingLeft = `${10 + (ownerFolder.depth + 1) * 14}px`;
        if (isCurrent) row.addClass("is-current");

        // 拖拽到其他文件夹下
        row.draggable = true;
        row.addEventListener("dragstart", (e: DragEvent) => {
            this.dragMocPayload = { mocPath, fromFolderId: ownerFolder.id };
            row.addClass("zk-folder-drawer-row-dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                // 设一个不会被外部消费的占位,避免某些浏览器把空 dataTransfer 视为非法拖拽
                e.dataTransfer.setData("application/x-zk-moc-ref", mocPath);
            }
        });
        row.addEventListener("dragend", () => {
            row.removeClass("zk-folder-drawer-row-dragging");
            this.dragMocPayload = null;
        });

        // 占位 chev 保持对齐
        const chev = row.createSpan("zk-folder-drawer-chev");
        chev.addClass("is-leaf");

        const icon = row.createSpan("zk-folder-drawer-icon");
        setIcon(icon, "git-branch");

        row.createSpan("zk-folder-drawer-name").setText(stripMocSuffix(file.basename));

        const actions = row.createDiv("zk-folder-drawer-row-actions");
        const unmount = actions.createDiv("zk-folder-drawer-row-action zk-folder-drawer-row-action-danger");
        setIcon(unmount, "x");
        setTooltip(unmount, "从该文件夹取消挂载");
        unmount.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                await this.service.unmountMoc(ownerFolder.id, mocPath);
                new Notice(`已从「${ownerFolder.name}」取消挂载`);
            } catch (err: any) {
                new Notice(`取消挂载失败: ${err?.message || err}`);
            }
        });

        row.addEventListener("click", async (e) => {
            e.stopPropagation();
            this.plugin.settings.mocCurrentFile = mocPath;
            await this.plugin.saveData(this.plugin.settings);
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
            this.render();
        });
    }

    // ---------- 交互 ----------

    private async toggleCollapse(node: FolderNode): Promise<void> {
        const mocCount = (node.mocRefs ?? []).filter(p => !!this.app.vault.getFileByPath(p)).length;
        if (node.childIds.length === 0 && mocCount === 0) return;
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
        const input = inputRow.createEl("input", { type: "text", placeholder: "Space 名称(回车 = 空白)" });
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
                    await this.service.applyTemplate(tmpl, name || tmpl.name);
                } else {
                    await this.service.createSpace(name);
                }
            } catch (e: any) {
                new Notice(`创建失败: ${e?.message || e}`);
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
        chipsRow.createSpan("zk-folder-drawer-chips-label").setText("模板:");
        for (const tmpl of BUILTIN_TEMPLATES) {
            const chip = chipsRow.createDiv("zk-folder-drawer-chip");
            chip.createSpan("zk-folder-drawer-chip-icon").setText(tmpl.icon || "📁");
            chip.createSpan("zk-folder-drawer-chip-name").setText(tmpl.name);
            setTooltip(chip, tmpl.description);
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

    private showNewChildInput(parentNode: FolderNode, parentEl: HTMLElement, anchorRow: HTMLElement): void {
        // 临时输入行插入到当前 row 之后
        const inputRow = parentEl.createDiv("zk-folder-drawer-input-row");
        inputRow.style.paddingLeft = `${10 + (parentNode.depth + 1) * 14}px`;
        anchorRow.after(inputRow);
        const input = inputRow.createEl("input", { type: "text", placeholder: "新文件夹名称" });
        input.addClass("zk-folder-drawer-input");
        this.bindInputSubmit(input, async (name) => {
            try {
                // 自动展开父节点
                if (parentNode.collapsed) {
                    await this.service.setCollapsed(parentNode.id, false);
                }
                await this.service.createFolder(parentNode.id, name);
            } catch (e: any) {
                new Notice(`创建失败: ${e?.message || e}`);
            }
        }, () => inputRow.remove());
        setTimeout(() => input.focus(), 0);
    }

    private async confirmDelete(node: FolderNode): Promise<void> {
        const ok = window.confirm(`确认删除「${node.name}」及其下所有子文件夹?(只删除虚拟分类,不会动到 MOC 文件本身)`);
        if (!ok) return;
        try {
            await this.service.delete(node.id);
        } catch (e: any) {
            new Notice(`删除失败: ${e?.message || e}`);
        }
    }

    private async applyTemplate(templateId: string): Promise<void> {
        const tmpl = BUILTIN_TEMPLATES.find(t => t.id === templateId);
        if (!tmpl) return;
        // 让用户输入 Space 名(用模板名作为默认)
        this.bodyEl.empty();
        const inputRow = this.bodyEl.createDiv("zk-folder-drawer-input-row");
        const label = inputRow.createSpan("zk-folder-drawer-input-label");
        label.setText(`用 ${tmpl.name} 模板创建 Space:`);
        const input = inputRow.createEl("input", { type: "text", value: tmpl.name });
        input.addClass("zk-folder-drawer-input");
        this.bindInputSubmit(input, async (name) => {
            try {
                await this.service.applyTemplate(tmpl, name);
            } catch (e: any) {
                new Notice(`创建失败: ${e?.message || e}`);
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
}
