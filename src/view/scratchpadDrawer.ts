import { App, FuzzySuggestModal, Menu, Notice, setIcon, setTooltip, TFile } from "obsidian";
import { Scratchpad, ScratchpadEntry, ScratchpadManager, ScratchpadSplitRule } from "src/scratch/scratchpadManager";
import { resolveDroppedVaultFiles, hasVaultFileDragTypes } from "src/utils/dropFileResolver";
import { t } from "src/lang/helper";

const IDLE_FADE_MS = 3000;
const NEAR_HANDLE_PX = 60; // 鼠标距离句柄多近算"靠近"

export type CurrentMOCInfo = { path: string; name: string };

class ScratchpadFileSuggestModal extends FuzzySuggestModal<TFile> {
    private onChoose: (file: TFile) => void;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder(t("scratch file picker placeholder"));
    }

    getItems(): TFile[] {
        return this.app.vault.getFiles();
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.onChoose(file);
    }
}

/**
 * 临时工作区抽屉(Scratchpad Drawer)
 *
 * 跨 MOC 共享的节点暂存区,支持多 pad。
 * - 左侧画布边缘的三角句柄:既是徽标(显示总条目数)也是开关
 * - 闲置 3 秒淡出至半透明,鼠标靠近恢复
 * - 顶部 Tab 栏切换 pad,右键菜单重命名/删除,"+" 新建
 * - 拖出卡片到画布 → 落点处生成节点(由 indexView 监听 drop 事件处理)
 */
export class ScratchpadDrawer {
    private manager: ScratchpadManager;
    private app: App;
    private getCurrentMOC: () => CurrentMOCInfo;
    private root: HTMLElement;
    private panel: HTMLElement;
    private handle: HTMLElement;
    private handleArrow: HTMLElement;
    private handleBadge: HTMLElement;
    private tabsEl: HTMLElement;
    private bodyEl: HTMLElement;
    private countBadge: HTMLElement;
    private isOpen = false;
    private isTextComposerOpen = false;
    private textComposerValue = "";
    private textComposerSourceTempIds: Set<string> = new Set();
    private draggingScratchTempId: string | null = null;
    private unsubscribe: (() => void) | null = null;
    private idleTimer: number | null = null;
    private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;

    constructor(
        parent: HTMLElement,
        manager: ScratchpadManager,
        app: App,
        getCurrentMOC: () => CurrentMOCInfo,
    ) {
        this.manager = manager;
        this.app = app;
        this.getCurrentMOC = getCurrentMOC;

        this.root = parent.createDiv("zk-scratch-drawer");
        this.root.setAttribute("aria-hidden", "true");

        // ---- panel (slides in/out) ----
        this.panel = this.root.createDiv("zk-scratch-drawer-panel");

        const header = this.panel.createDiv("zk-scratch-drawer-header");
        const titleWrap = header.createDiv("zk-scratch-drawer-title-wrap");
        const titleIcon = titleWrap.createSpan("zk-scratch-drawer-title-icon");
        setIcon(titleIcon, "package");
        titleWrap.createSpan("zk-scratch-drawer-title").setText(t("scratch drawer title"));
        this.countBadge = titleWrap.createSpan("zk-scratch-drawer-count");

        const addBtn = header.createDiv("zk-scratch-drawer-action");
        setIcon(addBtn, "plus");
        setTooltip(addBtn, t("scratch add item"));
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showAddMenu(e);
        });

        const clearBtn = header.createDiv("zk-scratch-drawer-action");
        setIcon(clearBtn, "trash-2");
        setTooltip(clearBtn, t("scratch clear all"));
        clearBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const active = this.manager.activePad();
            if (!active || active.items.length === 0) return;
            await this.manager.clear();
        });

        this.tabsEl = this.panel.createDiv("zk-scratch-tabs");
        this.bodyEl = this.panel.createDiv("zk-scratch-drawer-body");

        this.registerVaultFileDrop();

        // ---- handle (triangle on the right edge) ----
        this.handle = this.root.createDiv("zk-scratch-drawer-handle");
        setTooltip(this.handle, t("scratch toolbar tooltip"));
        this.handleArrow = this.handle.createSpan("zk-scratch-drawer-handle-arrow");
        setIcon(this.handleArrow, "chevron-right");
        this.handleBadge = this.handle.createSpan("zk-scratch-drawer-handle-badge");
        this.handle.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggle();
        });
        // 鼠标进入句柄区域 → 立即恢复并重置闲置计时
        this.handle.addEventListener("mouseenter", () => this.wakeFromIdle());

        // 永远订阅 manager,用于刷新 handle 徽标(即使关闭时也要)
        this.unsubscribe = this.manager.onChange(() => {
            this.refreshHandleBadge();
            this.refreshHeaderCount();
            if (this.isOpen) {
                this.renderTabs();
                this.render();
            }
        });

        // 全局 mousemove 监听:鼠标靠近左边缘时唤醒,远离 3s 后淡出
        this.mouseMoveHandler = (e: MouseEvent) => this.onGlobalMouseMove(e);
        activeDocument.addEventListener("mousemove", this.mouseMoveHandler);

        this.refreshHandleBadge();
        this.refreshHeaderCount();
        this.scheduleIdle();
    }

    toggle(): void { this.isOpen ? this.close() : this.open(); }

    open(): void {
        if (this.isOpen) return;
        this.renderTabs();
        this.render();
        this.root.addClass("is-open");
        this.root.setAttribute("aria-hidden", "false");
        setIcon(this.handleArrow, "chevron-left");
        this.isOpen = true;
        this.wakeFromIdle();
    }

    close(): void {
        if (!this.isOpen) return;
        this.root.removeClass("is-open");
        this.root.setAttribute("aria-hidden", "true");
        setIcon(this.handleArrow, "chevron-right");
        this.isOpen = false;
        this.scheduleIdle();
    }

    isVisible(): boolean { return this.isOpen; }

    refreshContext(): void {
        this.refreshHandleBadge();
        this.refreshHeaderCount();
        if (this.isOpen) {
            this.renderTabs();
            this.render();
        }
    }

    destroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        activeDocument.querySelector(".zk-scratch-context-menu")?.remove();
        if (this.mouseMoveHandler) {
            activeDocument.removeEventListener("mousemove", this.mouseMoveHandler);
            this.mouseMoveHandler = null;
        }
        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.root.remove();
    }

    // ---------- vault file drop ----------

    private registerVaultFileDrop(): void {
        const isScratchCardDrag = (e: DragEvent): boolean =>
            !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("application/x-zk-scratch");

        this.panel.addEventListener("dragenter", (e: DragEvent) => {
            if (isScratchCardDrag(e)) return;
            if (!hasVaultFileDragTypes(e)) return;
            e.preventDefault();
            this.panel.addClass("is-drop-target");
        });

        this.panel.addEventListener("dragover", (e: DragEvent) => {
            if (isScratchCardDrag(e)) return;
            if (!hasVaultFileDragTypes(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
            this.panel.addClass("is-drop-target");
        });

        this.panel.addEventListener("dragleave", (e: DragEvent) => {
            const related = e.relatedTarget as Node | null;
            if (related && this.panel.contains(related)) return;
            this.panel.removeClass("is-drop-target");
        });

        this.panel.addEventListener("drop", async (e: DragEvent) => {
            this.panel.removeClass("is-drop-target");
            if (isScratchCardDrag(e)) return;

            const files = resolveDroppedVaultFiles(this.app, e);
            if (files.length === 0) return;

            e.preventDefault();
            e.stopPropagation();

            const moc = this.getCurrentMOC();
            for (const file of files) {
                const entry = this.manager.buildEntryFromFile(file, moc.path || "", moc.name || "");
                await this.manager.add(entry);
            }
            new Notice(t("scratch added file count").replace("{n}", String(files.length)));
        });
    }

    // ---------- handle / idle ----------

    private refreshHandleBadge(): void {
        const moc = this.getCurrentMOC();
        const n = this.manager.visibleSizeForMOC(moc.path || "");
        this.handleBadge.setText(n > 0 ? String(n) : "");
        this.handleBadge.toggleClass("is-empty", n === 0);
    }

    private refreshHeaderCount(): void {
        const n = this.manager.size();
        this.countBadge.setText(n > 0 ? String(n) : "");
        this.countBadge.toggleClass("is-empty", n === 0);
    }

    private onGlobalMouseMove(e: MouseEvent): void {
        // 计算鼠标跟句柄的距离;近就唤醒
        const rect = this.handle.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        if (Math.hypot(dx, dy) <= NEAR_HANDLE_PX) {
            this.wakeFromIdle();
        }
    }

    private wakeFromIdle(): void {
        this.root.removeClass("is-idle");
        this.scheduleIdle();
    }

    private scheduleIdle(): void {
        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
        }
        // 抽屉打开时不做闲置淡出
        if (this.isOpen) {
            this.idleTimer = null;
            return;
        }
        this.idleTimer = window.setTimeout(() => {
            this.root.addClass("is-idle");
            this.idleTimer = null;
        }, IDLE_FADE_MS);
    }

    // ---------- tab strip ----------

    private renderTabs(): void {
        this.tabsEl.empty();
        const moc = this.getCurrentMOC();
        const pads = this.manager.listPadsForMOC(moc.path || "");
        const activeId = this.manager.activePad()?.id ?? "";

        for (const pad of pads) {
            this.renderTab(pad, pad.id === activeId);
        }

        const addBtn = this.tabsEl.createDiv("zk-scratch-tab-add");
        setIcon(addBtn, "plus");
        setTooltip(addBtn, t("scratch new pad"));
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.startCreatePad();
        });
    }

    private renderTab(pad: Scratchpad, active: boolean): void {
        const tab = this.tabsEl.createDiv(active ? "zk-scratch-tab is-active" : "zk-scratch-tab");
        tab.dataset.padId = pad.id;
        const moc = this.getCurrentMOC();
        const boundToCurrentMOC = this.manager.isPadBoundToMOC(pad, moc.path || "");

        if (boundToCurrentMOC) {
            const boundIcon = tab.createSpan("zk-scratch-tab-bound");
            setIcon(boundIcon, "link");
            setTooltip(boundIcon, t("scratch bound current moc"));
        }

        const label = tab.createSpan("zk-scratch-tab-label");
        label.setText(pad.name);

        const count = tab.createSpan("zk-scratch-tab-count");
        if (pad.items.length > 0) count.setText(String(pad.items.length));

        tab.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!active) this.manager.setActivePad(pad.id);
        });

        tab.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            this.startRenameTab(tab, pad);
        });

        tab.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();
            if (moc.path) {
                menu.addItem((item) => {
                    if (boundToCurrentMOC) {
                        item.setTitle(t("scratch unbind current moc"))
                            .setIcon("unlink")
                            .onClick(() => {
                                if (this.manager.unbindPadFromMOC(pad.id, moc.path)) {
                                    new Notice(t("scratch unbind current moc success"));
                                }
                            });
                    } else {
                        item.setTitle(t("scratch bind current moc"))
                            .setIcon("link")
                            .onClick(() => {
                                if (this.manager.bindPadToMOC(pad.id, moc.path)) {
                                    new Notice(t("scratch bind current moc success"));
                                }
                            });
                    }
                });
            }
            menu.addItem((item) =>
                item.setTitle(t("scratch rename pad"))
                    .setIcon("pencil")
                    .onClick(() => this.startRenameTab(tab, pad))
            );
            menu.addItem((item) =>
                item.setTitle(t("scratch delete pad"))
                    .setIcon("trash-2")
                    .onClick(() => this.confirmDeletePad(pad))
            );
            menu.showAtMouseEvent(e);
        });

        // 接受卡片拖入(跨 pad 移动)
        tab.addEventListener("dragover", (e) => {
            if (!e.dataTransfer?.types.includes("application/x-zk-scratch")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            tab.addClass("is-drop-target");
        });
        tab.addEventListener("dragleave", () => {
            tab.removeClass("is-drop-target");
        });
        tab.addEventListener("drop", async (e) => {
            tab.removeClass("is-drop-target");
            const tempId = e.dataTransfer?.getData("application/x-zk-scratch");
            if (!tempId) return;
            e.preventDefault();
            e.stopPropagation();
            await this.movePadItem(tempId, pad.id);
        });
    }

    private startCreatePad(): void {
        const tab = this.tabsEl.createDiv("zk-scratch-tab is-editing");
        const addBtn = this.tabsEl.querySelector(".zk-scratch-tab-add");
        if (addBtn) this.tabsEl.appendChild(addBtn);

        const input = tab.createEl("input", { cls: "zk-scratch-tab-input" });
        input.type = "text";
        input.placeholder = t("scratch pad name placeholder");
        input.value = "";
        input.focus();

        const commit = () => {
            const name = input.value.trim() || t("scratch default pad name");
            this.manager.createPad(name);
        };
        const cancel = () => {
            this.renderTabs();
        };

        let done = false;
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { done = true; commit(); }
            else if (e.key === "Escape") { done = true; cancel(); }
        });
        input.addEventListener("blur", () => {
            if (done) return;
            if (input.value.trim()) commit();
            else cancel();
        });
    }

    private startRenameTab(tab: HTMLElement, pad: Scratchpad): void {
        tab.empty();
        tab.addClass("is-editing");
        const input = tab.createEl("input", { cls: "zk-scratch-tab-input" });
        input.type = "text";
        input.value = pad.name;
        input.select();
        input.focus();

        let done = false;
        const commit = () => {
            const next = input.value.trim();
            if (next && next !== pad.name) this.manager.renamePad(pad.id, next);
            else this.renderTabs();
        };
        const cancel = () => this.renderTabs();
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { done = true; commit(); }
            else if (e.key === "Escape") { done = true; cancel(); }
        });
        input.addEventListener("blur", () => {
            if (done) return;
            commit();
        });
    }

    private confirmDeletePad(pad: Scratchpad): void {
        const ok = window.confirm(
            t("scratch confirm delete pad").replace("{name}", pad.name)
        );
        if (!ok) return;
        this.manager.deletePad(pad.id);
    }

    private async movePadItem(tempId: string, targetPadId: string): Promise<void> {
        const found = this.manager.get(tempId);
        if (!found) return;
        if (found.padId === targetPadId) return;
        await this.manager.remove(tempId);
        await this.manager.add(found.entry, targetPadId);
        new Notice(`→ ${this.manager.listPads().find(p => p.id === targetPadId)?.name ?? ""}`);
    }

    // ---------- body ----------

    private render(): void {
        this.bodyEl.empty();
        const items = this.manager.list();
        if (this.isTextComposerOpen) {
            this.renderTextComposer(this.bodyEl);
        }
        if (items.length === 0) {
            if (!this.isTextComposerOpen) this.renderEmpty();
            return;
        }
        const list = this.bodyEl.createDiv("zk-scratch-list");
        for (const entry of items) {
            this.renderCard(list, entry);
        }
    }

    private renderEmpty(): void {
        const empty = this.bodyEl.createDiv("zk-scratch-empty");
        const icon = empty.createDiv("zk-scratch-empty-icon");
        setIcon(icon, "inbox");
        empty.createDiv("zk-scratch-empty-title").setText(t("scratch empty title"));
        empty.createDiv("zk-scratch-empty-hint").setText(t("scratch empty hint"));
    }

    private showAddMenu(e: MouseEvent): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item.setTitle(t("scratch add text"))
                .setIcon("type")
                .onClick(() => this.startTextComposer())
        );
        menu.addItem((item) =>
            item.setTitle(t("scratch add file"))
                .setIcon("file-plus")
                .onClick(() => this.openFilePicker())
        );
        menu.showAtMouseEvent(e);
    }

    private startTextComposer(): void {
        this.isTextComposerOpen = true;
        this.render();
        window.requestAnimationFrame(() => {
            const textarea = this.bodyEl.querySelector(".zk-scratch-composer-textarea") as HTMLTextAreaElement | null;
            textarea?.focus();
        });
    }

    private editEntryInComposer(entry: ScratchpadEntry): void {
        const text = this.manager.toEditableText(entry);
        if (!text) return;

        this.isTextComposerOpen = true;
        this.textComposerValue = text;
        this.textComposerSourceTempIds.clear();
        this.textComposerSourceTempIds.add(entry.tempId);
        this.render();
        window.requestAnimationFrame(() => {
            const textarea = this.bodyEl.querySelector(".zk-scratch-composer-textarea") as HTMLTextAreaElement | null;
            if (!textarea) return;
            textarea.focus();
            textarea.setSelectionRange(0, textarea.value.length);
            this.autosizeTextarea(textarea);
        });
    }

    private renderTextComposer(parent: HTMLElement): void {
        const composer = parent.createDiv("zk-scratch-composer");
        const textarea = composer.createEl("textarea", { cls: "zk-scratch-composer-textarea" });
        textarea.placeholder = t("scratch text placeholder");
        textarea.rows = 5;
        textarea.value = this.textComposerValue;

        const footer = composer.createDiv("zk-scratch-composer-footer");
        const hint = footer.createSpan("zk-scratch-composer-hint");
        hint.setText(t("scratch text hint"));

        const actions = footer.createDiv("zk-scratch-composer-actions");
        const splitHeadingBtn = actions.createDiv("zk-scratch-composer-btn");
        setIcon(splitHeadingBtn, "heading");
        setTooltip(splitHeadingBtn, t("scratch save by heading"));

        const splitLineBtn = actions.createDiv("zk-scratch-composer-btn");
        setIcon(splitLineBtn, "list");
        setTooltip(splitLineBtn, t("scratch save by line"));

        const cancelBtn = actions.createDiv("zk-scratch-composer-btn");
        setIcon(cancelBtn, "x");
        setTooltip(cancelBtn, t("scratch cancel"));

        const saveBtn = actions.createDiv("zk-scratch-composer-btn is-primary");
        setIcon(saveBtn, "check");
        setTooltip(saveBtn, t("scratch save text"));

        const save = async (splitRule?: ScratchpadSplitRule) => {
            const moc = this.getCurrentMOC();
            const entries = this.manager.buildEntriesFromText(textarea.value, moc.path || "", moc.name || "", splitRule);
            if (entries.length === 0) {
                new Notice(t("scratch text empty"));
                return;
            }
            await this.manager.addMany(entries);
            for (const tempId of this.textComposerSourceTempIds) {
                await this.manager.remove(tempId);
            }
            this.textComposerSourceTempIds.clear();
            this.textComposerValue = "";
            this.render();
            window.requestAnimationFrame(() => {
                const nextTextarea = this.bodyEl.querySelector(".zk-scratch-composer-textarea") as HTMLTextAreaElement | null;
                nextTextarea?.focus();
            });
        };

        const cancel = () => {
            this.isTextComposerOpen = false;
            this.textComposerValue = "";
            this.textComposerSourceTempIds.clear();
            this.render();
        };

        splitHeadingBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void save("heading");
        });
        splitLineBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void save("line");
        });
        saveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void save();
        });
        cancelBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            cancel();
        });
        textarea.addEventListener("keydown", (e) => {
            if (e.shiftKey && e.key === "Enter") {
                e.preventDefault();
                const start = textarea.selectionStart ?? textarea.value.length;
                const end = textarea.selectionEnd ?? start;
                textarea.setRangeText("\n", start, end, "end");
                this.textComposerValue = textarea.value;
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (e.key === "Enter") {
                e.preventDefault();
                void save();
            } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
            }
        });
        textarea.addEventListener("input", () => {
            this.textComposerValue = textarea.value;
            this.autosizeTextarea(textarea);
        });
        const onDragOver = (e: DragEvent) => {
            if (!e.dataTransfer?.types.includes("application/x-zk-scratch")) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            composer.addClass("is-drop-target");
        };
        const onDragLeave = (e: DragEvent) => {
            const related = e.relatedTarget as Node | null;
            if (related && composer.contains(related)) return;
            composer.removeClass("is-drop-target");
        };
        const onDrop = (e: DragEvent) => {
            composer.removeClass("is-drop-target");
            const tempId = e.dataTransfer?.getData("application/x-zk-scratch");
            if (!tempId) return;

            const found = this.manager.get(tempId);
            if (!found) return;

            e.preventDefault();
            e.stopPropagation();

            const text = this.manager.toEditableText(found.entry);
            if (!text) return;

            const current = textarea.value;
            const start = textarea.selectionStart ?? current.length;
            const end = textarea.selectionEnd ?? start;
            const before = current.slice(0, start);
            const after = current.slice(end);
            const prefix = before && !before.endsWith("\n") ? "\n" : "";
            const suffix = after && !text.endsWith("\n") ? "\n" : "";
            const nextText = `${before}${prefix}${text}${suffix}${after}`;
            const cursor = before.length + prefix.length + text.length;

            textarea.value = nextText;
            textarea.setSelectionRange(cursor, cursor);
            this.textComposerValue = nextText;
            this.textComposerSourceTempIds.add(tempId);
            this.autosizeTextarea(textarea);
            textarea.focus();
        };
        composer.addEventListener("dragover", onDragOver);
        composer.addEventListener("dragleave", onDragLeave);
        composer.addEventListener("drop", onDrop);
        window.requestAnimationFrame(() => this.autosizeTextarea(textarea));
    }

    private autosizeTextarea(textarea: HTMLTextAreaElement): void {
        textarea.setCssStyles({ height: "auto" });
        textarea.setCssStyles({ height: `${Math.min(Math.max(textarea.scrollHeight, 108), 260)}px` });
    }

    private openFilePicker(): void {
        const modal = new ScratchpadFileSuggestModal(this.app, async (file) => {
            const moc = this.getCurrentMOC();
            const entry = this.manager.buildEntryFromFile(file, moc.path || "", moc.name || "");
            await this.manager.add(entry);
            new Notice(t("scratch added file count").replace("{n}", "1"));
        });
        modal.open();
    }

    private renderCard(parent: HTMLElement, entry: ScratchpadEntry): void {
        const card = parent.createDiv("zk-scratch-card");
        card.draggable = true;
        card.dataset.tempId = entry.tempId;

        const opTag = card.createDiv(`zk-scratch-op zk-scratch-op-${entry.origin.operation}`);
        opTag.setText(entry.origin.operation === "cut" ? t("scratch op cut") : t("scratch op copy"));

        const body = card.createDiv("zk-scratch-card-body");

        const head = body.createDiv("zk-scratch-card-head");
        const kindIcon = head.createSpan("zk-scratch-card-kind");
        setIcon(kindIcon, entry.kind === "text" ? "type" : (entry.kind === "embed" ? "image" : "file-text"));
        const titleEl = head.createSpan("zk-scratch-card-title");
        titleEl.setText(this.truncate(entry.displayText, 60));
        setTooltip(titleEl, entry.displayText);

        const meta = body.createDiv("zk-scratch-card-meta");
        const idChip = meta.createSpan("zk-scratch-card-id");
        const originNodeId = entry.origin.nodeId === "draft" ? t("scratch draft source") : entry.origin.nodeId;
        idChip.setText(originNodeId);
        setTooltip(idChip, t("scratch original id tooltip") + originNodeId);
        const sep = meta.createSpan("zk-scratch-card-meta-sep");
        sep.setText("·");
        const fromIcon = meta.createSpan("zk-scratch-card-from-icon");
        setIcon(fromIcon, "git-fork");
        const fromName = meta.createSpan("zk-scratch-card-from");
        fromName.setText(this.truncate(entry.origin.mocName, 18));
        setTooltip(fromName, entry.origin.mocPath);

        const delBtn = card.createDiv("zk-scratch-card-del");
        setIcon(delBtn, "x");
        setTooltip(delBtn, t("scratch remove"));
        delBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.manager.remove(entry.tempId);
        });

        card.addEventListener("dragstart", (e) => {
            if (!e.dataTransfer) return;
            e.dataTransfer.setData("application/x-zk-scratch", entry.tempId);
            e.dataTransfer.effectAllowed = "copyMove";
            this.draggingScratchTempId = entry.tempId;
            card.addClass("is-dragging");
        });
        card.addEventListener("dragend", () => {
            this.draggingScratchTempId = null;
            card.removeClass("is-dragging");
        });

        card.addEventListener("dragover", (e) => {
            if (!e.dataTransfer?.types.includes("application/x-zk-scratch")) return;
            if (this.draggingScratchTempId === entry.tempId) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            card.addClass("is-merge-target");
        });

        card.addEventListener("dragleave", (e) => {
            const related = e.relatedTarget as Node | null;
            if (related && card.contains(related)) return;
            card.removeClass("is-merge-target");
        });

        card.addEventListener("drop", (e) => {
            card.removeClass("is-merge-target");
            const tempId = e.dataTransfer?.getData("application/x-zk-scratch");
            if (!tempId || tempId === entry.tempId) return;
            e.preventDefault();
            e.stopPropagation();
            if (this.manager.mergeEntries(tempId, entry.tempId)) {
                new Notice(t("scratch merge success"));
            }
        });

        card.addEventListener("dblclick", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.editEntryInComposer(entry);
        });

        card.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showCardMenu(e, entry);
        });
    }

    private showCardMenu(e: MouseEvent, entry: ScratchpadEntry): void {
        activeDocument.querySelector(".zk-scratch-context-menu")?.remove();

        const menu = activeDocument.body.createDiv("zk-node-ctx-menu zk-scratch-context-menu");
        menu.setCssStyles({
            position: "fixed",
            zIndex: "10000",
        });

        const closeMenu = (evt: MouseEvent) => {
            if (!menu.contains(evt.target as Node)) {
                menu.remove();
                activeDocument.removeEventListener("click", closeMenu);
            }
        };

        if (entry.kind === "text") {
            this.addCardMenuItem(menu, menu, closeMenu, "heading", t("scratch split by heading"), () => {
                this.splitTextEntry(entry, "heading");
            });
            this.addCardMenuItem(menu, menu, closeMenu, "list", t("scratch split by line"), () => {
                this.splitTextEntry(entry, "line");
            });
            menu.createDiv("zk-node-ctx-sep");
        }

        this.addCardMenuItem(menu, menu, closeMenu, "trash-2", t("scratch remove"), () => {
            void this.manager.remove(entry.tempId);
        });

        this.positionCardMenu(menu, e);
        window.setTimeout(() => activeDocument.addEventListener("click", closeMenu), 0);
    }

    private addCardMenuItem(
        parent: HTMLElement,
        menu: HTMLElement,
        closeMenu: (e: MouseEvent) => void,
        icon: string,
        label: string,
        action: () => void,
    ): void {
        const item = parent.createDiv("zk-node-ctx-item");
        const iconEl = item.createSpan();
        setIcon(iconEl, icon);
        item.createSpan({ text: label });
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            menu.remove();
            activeDocument.removeEventListener("click", closeMenu);
            action();
        });
    }

    private positionCardMenu(menu: HTMLElement, mouseEvent: MouseEvent): void {
        menu.setCssStyles({
            visibility: "hidden",
            left: "0",
            top: "0",
        });
        window.requestAnimationFrame(() => {
            const mw = menu.offsetWidth;
            const mh = menu.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            let x = mouseEvent.clientX;
            let y = mouseEvent.clientY;
            if (x + mw > vw) x = vw - mw - 4;
            if (y + mh > vh) y = vh - mh - 4;
            menu.setCssStyles({
                left: `${Math.max(4, x)}px`,
                top: `${Math.max(4, y)}px`,
                visibility: "visible",
            });
        });
    }

    private splitTextEntry(entry: ScratchpadEntry, rule: ScratchpadSplitRule): void {
        const count = this.manager.splitTextEntry(entry.tempId, rule);
        if (count > 0) {
            new Notice(t("scratch split success").replace("{n}", String(count)));
        } else {
            new Notice(t("scratch split no parts"));
        }
    }

    private truncate(s: string, max: number): string {
        if (!s) return "";
        return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }
}
