import { Menu, Notice, setIcon, setTooltip } from "obsidian";
import { Scratchpad, ScratchpadEntry, ScratchpadManager } from "src/scratch/scratchpadManager";
import { t } from "src/lang/helper";

const IDLE_FADE_MS = 3000;
const NEAR_HANDLE_PX = 60; // 鼠标距离句柄多近算"靠近"

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
    private root: HTMLElement;
    private panel: HTMLElement;
    private handle: HTMLElement;
    private handleArrow: HTMLElement;
    private handleBadge: HTMLElement;
    private tabsEl: HTMLElement;
    private bodyEl: HTMLElement;
    private countBadge: HTMLElement;
    private isOpen: boolean = false;
    private unsubscribe: (() => void) | null = null;
    private idleTimer: number | null = null;
    private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;

    constructor(parent: HTMLElement, manager: ScratchpadManager) {
        this.manager = manager;

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
        document.addEventListener("mousemove", this.mouseMoveHandler);

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

    destroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.mouseMoveHandler) {
            document.removeEventListener("mousemove", this.mouseMoveHandler);
            this.mouseMoveHandler = null;
        }
        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.root.remove();
    }

    // ---------- handle / idle ----------

    private refreshHandleBadge(): void {
        const n = this.manager.totalSize();
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
        const pads = this.manager.listPads();
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
        if (items.length === 0) {
            this.renderEmpty();
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
        idChip.setText(entry.origin.nodeId);
        setTooltip(idChip, t("scratch original id tooltip") + entry.origin.nodeId);
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
            card.addClass("is-dragging");
        });
        card.addEventListener("dragend", () => {
            card.removeClass("is-dragging");
        });

        card.addEventListener("dblclick", () => {
            const evt = new CustomEvent("scratchpad-paste-center", {
                detail: { tempId: entry.tempId },
            });
            document.dispatchEvent(evt);
        });
    }

    private truncate(s: string, max: number): string {
        if (!s) return "";
        return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }
}
