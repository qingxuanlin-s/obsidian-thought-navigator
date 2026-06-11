import { App, Component, MarkdownRenderer, TFile, setIcon } from "obsidian";
import { t } from "src/lang/helper";
import { EmbeddableMarkdownEditor } from "src/utils/EmbeddableMarkdownEditor";
import type { ZKNode } from "src/view/indexView";

export interface NodeDetailPanelDeps {
    /** 取节点备注文本 */
    getRemark: (node: ZKNode) => string;
    /** 把 IDStr 解析为显示标签(用于面包屑) */
    getLabel: (idStr: string) => string;
    /** 取节点所属分支主题色(用于头部圆点),无则 null */
    getBranchColor: (node: ZKNode) => string | null;
    /** 保存备注(无弹窗,写 MOC + 刷新) */
    onSaveRemark: (node: ZKNode, text: string) => Promise<void>;
    /** 当前是否可编辑(只读模式下隐藏编辑入口) */
    canEdit: () => boolean;
    /** 打开文件节点对应笔记 */
    onOpenFile: (file: TFile) => void;
    /** 点击面包屑某一级 → 选中并居中该节点 */
    onNavigate: (idStr: string) => void;
    /** 在编辑器宿主上挂载选区格式工具栏(复用画布同款),无渲染器则返回 null */
    attachSelectionToolbar: (
        rootEl: HTMLElement,
        applyTransform: (formatter: (selectedText: string) => string) => boolean,
        hostContainer: HTMLElement,
    ) => { destroy: () => void } | null;
    /** markdown 渲染生命周期挂载点 */
    component: Component;
}

/**
 * 节点详情侧栏:单击节点 → 跟随展示。
 * - 概念/纯文字节点 → 展示备注(markdown)
 * - 文件节点 → 嵌入笔记预览(+ 备注 callout)
 * 触发复用既有「选中」语义,不新增手势。
 */
export class NodeDetailPanel {
    private app: App;
    private deps: NodeDetailPanelDeps;
    private root: HTMLElement;
    private kickerEl: HTMLElement;
    private dotEl: HTMLElement;
    private kickerTextEl: HTMLElement;
    private titleEl: HTMLElement;
    private breadcrumbEl: HTMLElement;
    private bodyEl: HTMLElement;
    private remarkArea: HTMLElement | null = null;
    private activeEditor: EmbeddableMarkdownEditor | null = null;
    private activeSelectionToolbar: { destroy: () => void } | null = null;
    private currentNode: ZKNode | null = null;
    private side: 'left' | 'right' = 'right';
    private renderToken = 0;

    constructor(parent: HTMLElement, app: App, deps: NodeDetailPanelDeps) {
        this.app = app;
        this.deps = deps;

        this.root = parent.createDiv("zk-detail-panel zk-detail-panel-right");
        this.root.style.display = 'none';

        // 关闭把手(竖向贴边)
        const handle = this.root.createDiv("zk-detail-handle");
        setIcon(handle, "x");
        handle.setAttribute("title", t("Close") || "关闭");
        handle.addEventListener("click", () => this.hide());

        const header = this.root.createDiv("zk-detail-header");
        this.kickerEl = header.createDiv("zk-detail-kicker");
        this.dotEl = this.kickerEl.createDiv("zk-detail-dot");
        this.kickerTextEl = this.kickerEl.createSpan("zk-detail-kicker-text");
        this.titleEl = header.createDiv("zk-detail-title");
        this.breadcrumbEl = header.createDiv("zk-detail-breadcrumb");

        this.bodyEl = this.root.createDiv("zk-detail-body");

        const footer = this.root.createDiv("zk-detail-footer");
        const closeBtn = footer.createDiv("zk-detail-close-btn");
        closeBtn.setText((t("Close") || "关闭") + " · Esc");
        closeBtn.addEventListener("click", () => this.hide());
    }

    setSide(side: 'left' | 'right'): void {
        this.side = side;
        this.root.toggleClass("zk-detail-panel-left", side === 'left');
        this.root.toggleClass("zk-detail-panel-right", side === 'right');
    }

    get isOpen(): boolean {
        return this.root.style.display !== 'none' && this.root.hasClass("zk-detail-panel-open");
    }

    /** 备注是否正处于内联编辑(此时 Esc 由编辑器自己消费,不应关闭面板) */
    get isEditing(): boolean {
        return this.activeEditor !== null;
    }

    /** 当前面板正在展示的节点(用于刷新后判断是否需要重新渲染) */
    get nodeIdStr(): string | null {
        return this.currentNode?.IDStr ?? null;
    }

    async show(node: ZKNode): Promise<void> {
        if (!node) return;
        this.currentNode = node;
        const token = ++this.renderToken;

        // 头部:类型圆点 + 类型标签
        const color = this.deps.getBranchColor(node) || 'var(--interactive-accent)';
        this.dotEl.style.backgroundColor = color;
        this.kickerTextEl.setText(this.typeLabel(node));

        const titleText = (node.title || node.displayText || node.IDStr || '').trim() || node.IDStr;
        this.titleEl.setText(titleText);
        this.titleEl.setAttribute("title", titleText); // 缩略后 hover 看全文

        this.renderBreadcrumb(node);

        this.root.style.display = 'flex';
        // 强制 reflow 后加 open 类触发滑入动画
        void this.root.offsetWidth;
        this.root.addClass("zk-detail-panel-open");

        await this.renderBody(node, token);
    }

    hide(): void {
        this.teardownEditor();
        this.root.removeClass("zk-detail-panel-open");
        this.currentNode = null;
        this.renderToken++;
        // 等滑出动画结束再 display:none
        const r = this.root;
        window.setTimeout(() => {
            if (!r.hasClass("zk-detail-panel-open")) r.style.display = 'none';
        }, 200);
    }

    destroy(): void {
        this.teardownEditor();
        this.root.remove();
    }

    private teardownEditor(): void {
        if (this.activeSelectionToolbar) {
            try { this.activeSelectionToolbar.destroy(); } catch { /* ignore */ }
            this.activeSelectionToolbar = null;
        }
        if (this.activeEditor) {
            try { this.activeEditor.unload(); } catch { /* ignore */ }
            this.activeEditor = null;
        }
    }

    private typeLabel(node: ZKNode): string {
        if (node.isCrossDomain) return t("detail type crossdomain") || '跨领域';
        if (node.isEmbed) return t("detail type embed") || '嵌入';
        if (node.isTextOnly || !node.file) return t("detail type concept") || '知识点';
        return t("detail type note") || '笔记';
    }

    private truncate(text: string, max: number): string {
        const s = (text || '').trim();
        return s.length > max ? s.slice(0, max) + '…' : s;
    }

    private renderBreadcrumb(node: ZKNode): void {
        this.breadcrumbEl.empty();
        const arr = node.IDArr || [];
        if (arr.length === 0) {
            this.breadcrumbEl.style.display = 'none';
            return;
        }
        this.breadcrumbEl.style.display = 'block';
        arr.forEach((idStr, i) => {
            // IDArr 元素本身即该层的完整 IDStr(累积前缀),直接使用
            const crumb = this.breadcrumbEl.createSpan("zk-detail-crumb");
            const full = this.deps.getLabel(idStr);
            crumb.setText(this.truncate(full, 10));
            crumb.setAttribute("title", full); // 截断后 hover 看全
            if (i < arr.length - 1) {
                crumb.addEventListener("click", () => this.deps.onNavigate(idStr));
            } else {
                crumb.addClass("zk-detail-crumb-current");
            }
            if (i < arr.length - 1) {
                this.breadcrumbEl.createSpan("zk-detail-crumb-sep").setText(" › ");
            }
        });
    }

    private async renderBody(node: ZKNode, token: number): Promise<void> {
        this.teardownEditor();
        this.bodyEl.empty();
        const isFileNode = !!node.file && !node.isTextOnly;

        // 备注区(可内联编辑,独立容器以便编辑/读模式互切)
        this.remarkArea = this.bodyEl.createDiv("zk-detail-remark-area");
        this.renderRemarkRead(node, (this.deps.getRemark(node) || '').trim(), isFileNode);

        // 文件节点:笔记正文预览(只读)
        if (isFileNode && node.file) {
            await this.renderNotePreview(node.file, token);
        }
    }

    /** 备注读模式:渲染 markdown;双击进编辑;空备注给「添加」入口 */
    private renderRemarkRead(node: ZKNode, remark: string, isFileNode: boolean): void {
        if (!this.remarkArea) return;
        this.remarkArea.empty();
        const canEdit = this.deps.canEdit();

        if (remark) {
            const remarkEl = this.remarkArea.createDiv(
                isFileNode ? "zk-detail-remark zk-detail-remark-callout" : "zk-detail-remark"
            );
            void MarkdownRenderer.render(this.app, remark, remarkEl, node.file?.path || '', this.deps.component);
            if (canEdit) {
                remarkEl.addClass("zk-detail-editable");
                remarkEl.setAttribute("title", t("detail dblclick edit"));
                remarkEl.addEventListener("dblclick", () => this.enterRemarkEdit(node, remark, isFileNode));
            }
            return;
        }

        if (isFileNode) {
            // 文件节点空备注 → 顶部细条「+ 添加备注」,不抢笔记预览版面
            if (canEdit) {
                const add = this.remarkArea.createDiv("zk-detail-add-inline");
                setIcon(add.createSpan("zk-detail-add-icon"), "plus");
                add.createSpan().setText(t("detail add remark"));
                add.addEventListener("click", () => this.enterRemarkEdit(node, '', isFileNode));
            }
            return;
        }

        // 概念节点空备注 → 居中空态
        const empty = this.remarkArea.createDiv("zk-detail-empty");
        empty.createDiv("zk-detail-empty-text").setText(t("detail no remark"));
        if (canEdit) {
            const addBtn = empty.createDiv("zk-detail-add-btn");
            addBtn.setText(t("detail add remark"));
            addBtn.addEventListener("click", () => this.enterRemarkEdit(node, '', isFileNode));
        }
    }

    /** 备注编辑模式:挂载与画布同款 CM6 编辑器(Enter 保存 / Shift+Enter 换行 / Esc 取消 / 失焦保存) */
    private enterRemarkEdit(node: ZKNode, initialValue: string, isFileNode: boolean): void {
        if (!this.remarkArea || !this.deps.canEdit()) return;
        this.teardownEditor();
        this.remarkArea.empty();
        const host = this.remarkArea.createDiv("zk-detail-remark-editor");

        let done = false;
        const finish = async (commit: boolean): Promise<void> => {
            if (done) return;
            done = true;
            const value = this.activeEditor?.getValue() ?? initialValue;
            this.teardownEditor();
            const trimmed = value.trim();
            if (commit && trimmed !== initialValue.trim()) {
                await this.deps.onSaveRemark(node, trimmed);
                this.renderRemarkRead(node, trimmed, isFileNode);
            } else {
                this.renderRemarkRead(node, initialValue.trim(), isFileNode);
            }
        };

        this.activeEditor = new EmbeddableMarkdownEditor({
            app: this.app,
            containerEl: host,
            initialValue,
            sourcePath: node.file?.path || '',
            placeholder: t("detail add remark"),
            onEnter: (_v, evt) => {
                if (evt.shiftKey || evt.metaKey || evt.ctrlKey) return false; // 换行
                void finish(true);
                return true;
            },
            onEscape: () => { void finish(false); },
            onBlur: () => { void finish(true); },
        });
        // 选区格式工具栏(B/U/S/颜色/高亮/字号/清除)— 与画布同款
        this.activeSelectionToolbar = this.deps.attachSelectionToolbar(
            host,
            (formatter) => this.activeEditor?.transformSelection(formatter) ?? false,
            this.root,
        );
        this.activeEditor.focus();
    }

    private async renderNotePreview(file: TFile, token: number): Promise<void> {
        const previewWrap = this.bodyEl.createDiv("zk-detail-note-preview");
        const openBar = previewWrap.createDiv("zk-detail-open-bar");
        const openBtn = openBar.createDiv("zk-detail-open-link");
        setIcon(openBtn.createSpan("zk-detail-open-icon"), "file-text");
        openBtn.createSpan().setText(file.basename);
        openBtn.addEventListener("click", () => this.deps.onOpenFile(file));

        const contentEl = previewWrap.createDiv("zk-detail-note-content markdown-rendered");
        try {
            const md = await this.app.vault.cachedRead(file);
            if (token !== this.renderToken) return; // 期间切换了节点,丢弃
            await MarkdownRenderer.render(this.app, md, contentEl, file.path, this.deps.component);
        } catch (e) {
            contentEl.setText(String(e));
        }
    }
}
