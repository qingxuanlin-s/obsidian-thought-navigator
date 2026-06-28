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
    /** 宽度变化(拖拽结束)→ 持久化 */
    onWidthChange: (px: number) => void;
    /** 钉住状态变化 → 持久化 */
    onPinChange: (pinned: boolean) => void;
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
    private pinned = false;
    private widthPx = 0; // 0 = 用 CSS 默认宽度
    private pinBtn: HTMLElement;

    constructor(parent: HTMLElement, app: App, deps: NodeDetailPanelDeps) {
        this.app = app;
        this.deps = deps;

        this.root = parent.createDiv("zk-detail-panel zk-detail-panel-right");
        this.root.setCssStyles({ display: 'none' });

        // 拖拽调宽把手(贴内边,竖向全高)
        const resizeHandle = this.root.createDiv("zk-detail-resize");
        this.bindResize(resizeHandle);

        // 关闭把手(竖向贴边)— 显式关闭并解除常驻
        const handle = this.root.createDiv("zk-detail-handle");
        setIcon(handle, "x");
        handle.setAttribute("title", t("Close") || "关闭");
        handle.addEventListener("click", () => this.close());

        // 钉住/常驻 按钮(右上角)
        this.pinBtn = this.root.createDiv("zk-detail-pin");
        setIcon(this.pinBtn, "pin");
        this.pinBtn.setAttribute("title", t("detail pin"));
        this.pinBtn.addEventListener("click", () => this.setPinned(!this.pinned, true));

        const header = this.root.createDiv("zk-detail-header");
        this.kickerEl = header.createDiv("zk-detail-kicker");
        this.dotEl = this.kickerEl.createDiv("zk-detail-dot");
        this.kickerTextEl = this.kickerEl.createSpan("zk-detail-kicker-text");
        // markdown-rendered:让标题内的 strong/em/高亮等吃到主题/用户片段对 .markdown-rendered
        // 的样式(如本仓库用户片段把 **加粗** 染成 accent 色),与画布文本节点 overlay 观感一致。
        this.titleEl = header.createDiv("zk-detail-title markdown-rendered");
        this.breadcrumbEl = header.createDiv("zk-detail-breadcrumb");

        this.bodyEl = this.root.createDiv("zk-detail-body");

        const footer = this.root.createDiv("zk-detail-footer");
        const closeBtn = footer.createDiv("zk-detail-close-btn");
        closeBtn.setText((t("Close") || "关闭") + " · Esc");
        closeBtn.addEventListener("click", () => this.close());
    }

    /** 拖拽内边调整面板宽度,松手持久化 */
    private bindResize(handle: HTMLElement): void {
        handle.addEventListener("pointerdown", (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startW = this.root.offsetWidth;
            handle.setPointerCapture(e.pointerId);
            this.root.addClass("zk-detail-resizing");

            const onMove = (ev: PointerEvent) => {
                const delta = this.side === 'right' ? (startX - ev.clientX) : (ev.clientX - startX);
                this.setWidth(startW + delta);
            };
            const onUp = (ev: PointerEvent) => {
                handle.releasePointerCapture(ev.pointerId);
                handle.removeEventListener("pointermove", onMove);
                handle.removeEventListener("pointerup", onUp);
                this.root.removeClass("zk-detail-resizing");
                this.deps.onWidthChange(this.widthPx);
            };
            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onUp);
        });
    }

    setSide(side: 'left' | 'right'): void {
        this.side = side;
        this.root.toggleClass("zk-detail-panel-left", side === 'left');
        this.root.toggleClass("zk-detail-panel-right", side === 'right');
    }

    /** 设置宽度(px),夹在 [320, 容器 85%];<=0 回落 CSS 默认 */
    setWidth(px: number): void {
        if (!px || px <= 0) {
            this.widthPx = 0;
            this.root.setCssStyles({ width: '' });
            return;
        }
        const parentW = this.root.parentElement?.clientWidth || window.innerWidth;
        const max = Math.max(360, Math.round(parentW * 0.85));
        this.widthPx = Math.round(Math.max(320, Math.min(max, px)));
        this.root.setCssStyles({ width: `${this.widthPx}px` });
    }

    /** 钉住=常驻:背景点击 / Esc 不再关闭;persist=true 时回写设置 */
    setPinned(pinned: boolean, persist = false): void {
        this.pinned = pinned;
        this.root.toggleClass("zk-detail-pinned", pinned);
        this.pinBtn.toggleClass("is-pinned", pinned);
        this.pinBtn.setAttribute("title", pinned ? t("detail unpin") : t("detail pin"));
        if (persist) this.deps.onPinChange(pinned);
        // 钉住时若当前没在展示,弹出占位常驻
        if (pinned && !this.isOpen) this.showPlaceholder();
    }

    get isPinned(): boolean {
        return this.pinned;
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

    /** 快捷键入口:复用读模式的备注编辑逻辑 */
    editCurrentRemark(): boolean {
        if (!this.currentNode || this.isEditing || !this.deps.canEdit()) return false;
        const node = this.currentNode;
        this.enterRemarkEdit(node, (this.deps.getRemark(node) || '').trim(), !!node.file && !node.isTextOnly, 'end');
        return this.isEditing;
    }

    async show(node: ZKNode): Promise<void> {
        if (!node) return;
        this.currentNode = node;
        const token = ++this.renderToken;

        // 头部:类型圆点 + 类型标签
        const color = this.deps.getBranchColor(node) || 'var(--interactive-accent)';
        this.dotEl.setCssStyles({ backgroundColor: color });
        this.kickerTextEl.setText(this.typeLabel(node));

        const titleText = (node.title || node.displayText || node.IDStr || '').trim() || node.IDStr;
        // 标题富文本:用 Obsidian 的 MarkdownRenderer 渲染(与备注一致,能正确处理 **加粗** 内
        // 嵌套 <span style> 颜色等组合),再平铺段落保持内联 + line-clamp 截断。
        void this.renderTitleRich(this.titleEl, titleText, token);

        this.renderBreadcrumb(node);

        this.root.setCssStyles({ display: 'flex' });
        // 强制 reflow 后加 open 类触发滑入动画
        void this.root.offsetWidth;
        this.root.addClass("zk-detail-panel-open");

        await this.renderBody(node, token);
    }

    /** 常态收起:钉住时忽略(常驻);force=true 强制收起 */
    hide(force = false): void {
        if (this.pinned && !force) return;
        this.teardownEditor();
        this.root.removeClass("zk-detail-panel-open");
        this.currentNode = null;
        this.renderToken++;
        // 等滑出动画结束再 display:none
        const r = this.root;
        window.setTimeout(() => {
            if (!r.hasClass("zk-detail-panel-open")) r.setCssStyles({ display: 'none' });
        }, 200);
    }

    /** 显式关闭按钮:解除常驻并强制收起 */
    close(): void {
        if (this.pinned) this.setPinned(false, true);
        this.hide(true);
    }

    /** 常驻但无选中时的占位:打开面板,展示提示 */
    showPlaceholder(): void {
        this.teardownEditor();
        this.currentNode = null;
        this.renderToken++;
        this.dotEl.setCssStyles({ backgroundColor: 'var(--zk-text-faint, #6f727c)' });
        this.kickerTextEl.setText('');
        this.titleEl.setText('');
        this.titleEl.removeAttribute("title");
        this.breadcrumbEl.setCssStyles({ display: 'none' });
        this.bodyEl.empty();
        const ph = this.bodyEl.createDiv("zk-detail-empty");
        ph.createDiv("zk-detail-empty-text").setText(t("detail placeholder"));
        this.root.setCssStyles({ display: 'flex' });
        void this.root.offsetWidth;
        this.root.addClass("zk-detail-panel-open");
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

    /** 去除内联富文本标记,得到纯文本(面包屑等不渲染富文本处用) */
    private stripMarkup(text: string): string {
        return (text || '')
            .replace(/<span\s+style=["'][^"']*["']>([\s\S]*?)<\/span>/gi, '$1')
            .replace(/<\/?[a-z][^>]*>/gi, '')
            .replace(/\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|==(.+?)==|`([^`]+?)`/g,
                (_m: string, a?: string, b?: string, c?: string, d?: string, e?: string) => a ?? b ?? c ?? d ?? e ?? '')
            .replace(/\\([-*+#])/g, '$1')
            .trim();
    }

    /**
     * 标题富文本渲染:复用 Obsidian MarkdownRenderer(与备注一致,能正确处理
     * **加粗** 内嵌套 <span style> 颜色、高亮等组合),再把渲染出的段落内联内容平铺到
     * 标题元素,保持 -webkit-line-clamp 截断生效。
     * - 多行折成单行;转义行首块级标记(- * + 数字. #),避免被当成列表/标题块。
     * - token 守卫:渲染期间若切换了节点则丢弃结果。
     */
    private async renderTitleRich(el: HTMLElement, input: string, token: number): Promise<void> {
        el.empty();
        // 先解码文本节点的字面量 \n(JSON 存储路径保留编码态,未走 Mermaid 解析器的解码),
        // 否则 \n 会原样显示、且后面的 \n+→空格 折叠失效。
        let text = (input || '').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').trim();
        if (!text) { el.setAttribute("title", input || ''); return; }
        // 快路径:无 markdown/HTML 语法 → 纯文本
        if (!/[*~_`=<[#]/.test(text)) {
            el.textContent = text;
            el.setAttribute("title", text);
            return;
        }
        // 转义行首块级标记,避免 "- xxx" / "# xxx" 被解析成列表/标题。
        // 仅当标记后紧跟空白才转义(真正的列表/标题语法必有空格:"- " / "# " / "1. "),
        // 否则会误伤行首的 **加粗**(`**` 后无空格)。
        text = text.replace(/^(\s*)([-*+#]|\d+\.)(?=\s)/, (_m, sp, mk) => `${sp}\\${mk}`);
        const tmp = createDiv();
        await MarkdownRenderer.render(this.app, text, tmp, this.currentNode?.file?.path || '', this.deps.component);
        if (token !== this.renderToken) { tmp.remove(); return; } // 期间切换了节点,丢弃
        // 取首个块级元素(通常 <p>)的内联内容平铺进标题
        const block = tmp.querySelector("p") || tmp.firstElementChild || tmp;
        while (block.firstChild) el.appendChild(block.firstChild);
        tmp.remove();
        el.setAttribute("title", el.textContent || input || ''); // 缩略后 hover 看全文
    }

    private renderBreadcrumb(node: ZKNode): void {
        this.breadcrumbEl.empty();
        const arr = node.IDArr || [];
        if (arr.length === 0) {
            this.breadcrumbEl.setCssStyles({ display: 'none' });
            return;
        }
        this.breadcrumbEl.setCssStyles({ display: 'block' });
        arr.forEach((idStr, i) => {
            // IDArr 元素本身即该层的完整 IDStr(累积前缀),直接使用
            const crumb = this.breadcrumbEl.createSpan("zk-detail-crumb");
            const full = this.stripMarkup(this.deps.getLabel(idStr));
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
        // 暂时注释:文件节点改成与文本节点一致,只渲染备注,不再嵌入笔记正文预览。
        // if (isFileNode && node.file) {
        //     await this.renderNotePreview(node.file, token);
        // }
    }

    /** 备注读模式:渲染 markdown;双击进编辑;空备注给「添加」入口 */
    private renderRemarkRead(node: ZKNode, remark: string, isFileNode: boolean): void {
        if (!this.remarkArea) return;
        this.remarkArea.empty();
        const canEdit = this.deps.canEdit();

        if (remark) {
            // markdown-rendered:与 hover tooltip 一致,让主题/Obsidian 的阅读视图排版(含
            // strong 加粗)在侧栏也生效。缺这个类时,strong 只吃全局 `--bold-weight`(部分主题
            // 设为 400 → 侧栏看不出加粗,而 tooltip 因带此类正常)。
            const remarkEl = this.remarkArea.createDiv(
                isFileNode ? "zk-detail-remark markdown-rendered zk-detail-remark-callout" : "zk-detail-remark markdown-rendered"
            );
            void MarkdownRenderer.render(this.app, remark, remarkEl, node.file?.path || '', this.deps.component);
            // 右上角复制按钮:复制备注的可见纯文本(便于粘贴到他处)
            this.attachCopyButton(remarkEl, () => remarkEl.innerText || remark);
            if (canEdit) {
                remarkEl.addClass("zk-detail-editable");
                remarkEl.setAttribute("title", t("detail dblclick edit"));
                remarkEl.addEventListener("dblclick", () => this.enterRemarkEdit(node, remark, isFileNode, 'end'));
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

    /** 在备注块右上角挂一个复制按钮:点击复制 getText() 返回的内容到剪贴板,带短暂成功反馈 */
    private attachCopyButton(host: HTMLElement, getText: () => string): void {
        host.addClass("zk-detail-has-copy");
        const btn = host.createDiv("zk-detail-copy-btn");
        setIcon(btn, "copy");
        btn.setAttribute("title", t("detail copy") || "复制");
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const text = (getText() || '').trim();
            if (!text) return;
            void navigator.clipboard.writeText(text).then(() => {
                btn.addClass("is-copied");
                setIcon(btn, "check");
                window.setTimeout(() => {
                    if (!btn.isConnected) return;
                    btn.removeClass("is-copied");
                    setIcon(btn, "copy");
                }, 1200);
            });
        });
        // 双击复制按钮不应进入备注编辑
        btn.addEventListener("dblclick", (e) => e.stopPropagation());
    }

    /** 备注编辑模式:挂载与画布同款 CM6 编辑器(Enter 保存 / Shift+Enter 换行 / Esc 取消 / 失焦保存) */
    private enterRemarkEdit(node: ZKNode, initialValue: string, isFileNode: boolean, cursor: 'default' | 'end' = 'default'): void {
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
        if (cursor === 'end') {
            this.activeEditor.focusEnd();
        } else {
            this.activeEditor.focus();
        }
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
