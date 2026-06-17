import { App, Component, Modal, setIcon, setTooltip } from "obsidian";
import { t } from "src/lang/helper";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { OpenTarget, WorkspaceNode, WSMocNode, FrameworkId } from "src/types/workspace";
import { fwLabel } from "./render";
import { ZKW_CSS, ZKW_STYLE_ID } from "./styles";
import { RenderCtx } from "./render";
import { renderCockpit } from "./cockpit";
import { renderProjectPage, renderMocPage, renderNotePage, renderHome } from "./pages";
import { SpacesTree } from "./spacesTree";
import { Deck } from "./deck";

const LS_OPEN = "zkw.open";
const LS_LAST = "zkw.last";

export interface WorkspacePanelDeps {
    app: App;
    store: WorkspaceStore;
    /** 宿主组件,用于 MarkdownRenderer 生命周期 */
    owner: Component;
    /** 打开一个带图谱的 MOC/map 节点时,交给宿主(indexView)切到图谱模式并加载文件。
     *  返回 true 表示宿主已接管(面板不再自渲 MOC 页);false / 不提供则面板内渲 MOC 概览页。 */
    onOpenMoc?: (node: WSMocNode) => boolean;
    /** 顶栏「图谱」按钮:切回图谱模式。提供则显示该按钮。 */
    onExitToGraph?: () => void;
}

/**
 * 工作区壳(toolbar + 左 rail + 中 center + 详情 deck),可挂载进任意父元素。
 * 既被独立的 ZKWorkspaceView 使用,也被 ZKIndexView 当作「工作区模式」层挂载。
 */
export class WorkspacePanel {
    private deps: WorkspacePanelDeps;
    private root: HTMLElement;
    private ctx: RenderCtx;
    private centerEl!: HTMLElement;
    private railScrollEl!: HTMLElement;
    private tree!: SpacesTree;
    private deck!: Deck;
    private current: OpenTarget = { kind: 'home' };
    private unsub: (() => void) | null = null;

    constructor(parent: HTMLElement, deps: WorkspacePanelDeps) {
        this.deps = deps;
        injectStyles();
        this.root = parent.createDiv({ cls: 'zkw' });

        this.ctx = {
            app: deps.app,
            store: deps.store,
            open: (t) => this.navigate(t),
            openInline: (t) => this.navigateInline(t),
            openDeck: (n) => this.deck?.open(n),
        };

        this.buildToolbar(this.root);
        const body = this.root.createDiv({ cls: 'body' });
        this.buildRail(body);
        this.centerEl = body.createDiv({ cls: 'center' });
        this.deck = new Deck(body, this.ctx, deps.owner);

        this.root.tabIndex = 0;
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.deck.handleEsc()) e.stopPropagation();
        });

        this.unsub = deps.store.onChange(() => { if (this.tree) { this.renderCenter(); this.tree.render(); } });
        this.restoreSession();
    }

    destroy() {
        this.unsub?.();
        this.unsub = null;
        this.root.remove();
    }

    setVisible(v: boolean) { this.root.setCssStyles({ display: v ? 'flex' : 'none' }); }

    /** 供宿主在切到工作区模式时刷新一次 */
    refresh() { if (this.tree) { this.renderCenter(); this.tree.render(); } }

    // ---------- Toolbar ----------
    private buildToolbar(shell: HTMLElement) {
        const tbar = shell.createDiv({ cls: 'tbar' });
        const brand = tbar.createDiv({ cls: 'brand' });
        brand.createSpan({ cls: 'mk', text: 'ZK' });
        brand.appendText(t('ws Workspace'));
        brand.createSpan({ cls: 'sub', text: 'workspace' });

        const home = tbar.createDiv({ cls: 'home' });
        home.appendText('⌂ ' + t('ws Today'));
        home.onclick = () => this.navigate({ kind: 'home' });

        tbar.createDiv({ cls: 'spacer' });
        if (this.deps.onExitToGraph) {
            const g = tbar.createDiv({ cls: 'ticon' });
            setIcon(g, 'git-fork');
            setTooltip(g, t('ws Graph'));
            g.onclick = () => this.deps.onExitToGraph!();
        }
    }

    // ---------- 左 rail ----------
    private buildRail(body: HTMLElement) {
        const rail = body.createDiv({ cls: 'rail' });
        const head = rail.createDiv({ cls: 'rail-head' });
        head.createSpan({ cls: 't', text: 'Spaces' });
        const meta = head.createSpan({ cls: 'meta' });
        const add = head.createDiv({ cls: 'add', text: '+' });
        add.setAttribute('title', t('ws New space'));
        add.onclick = () => this.openNewSpaceModal();
        this.railScrollEl = rail.createDiv({ cls: 'rail-scroll' });
        this.tree = new SpacesTree(this.railScrollEl, this.ctx);
        meta.setText(t('ws spaces count').replace('{n}', String(this.deps.store.getSpaces().length)));
    }

    private openNewSpaceModal() {
        new NewSpaceModal(this.deps.app, async (title, framework) => {
            const space = await this.deps.store.createSpace(title, { framework });
            this.navigate({ kind: 'space', id: space.id });
        }).open();
    }

    // ---------- 路由 ----------
    private navigate(target: OpenTarget) {
        if (!this.tree) return;
        // MOC/map 带图谱 → 交给宿主切图谱模式
        if (target.kind === 'moc') {
            const node = this.deps.store.getNode(target.id);
            if (node && node.type === 'moc' && (node as WSMocNode).filePath && this.deps.onOpenMoc) {
                if (this.deps.onOpenMoc(node as WSMocNode)) return;
            }
        }
        this.navigateInline(target);
    }

    /** 面板内导航:更新中间视口 + 侧栏选中,绝不甩去图谱 */
    private navigateInline(target: OpenTarget) {
        if (!this.tree) return;
        this.current = target;
        if (target.kind !== 'home') { try { localStorage.setItem(LS_LAST, JSON.stringify(target)); } catch {} }
        try { localStorage.setItem(LS_OPEN, JSON.stringify(target)); } catch {}
        this.tree.setCurrent(target);
        this.renderCenter();
        this.tree.render();
    }

    private restoreSession() {
        let target: OpenTarget | null = null;
        try { const raw = localStorage.getItem(LS_OPEN); if (raw) target = JSON.parse(raw); } catch {}
        if (target && target.kind !== 'home' && 'id' in target && !this.deps.store.getNode(target.id)) target = null;
        if (!target) {
            const first = this.deps.store.getSpaces()[0];
            target = first ? { kind: 'space', id: first.id } : { kind: 'home' };
        }
        // 恢复时不要把图谱 MOC 甩给宿主(避免一进面板就跳走),仅在面板内渲染
        if (target.kind === 'moc') this.navigateInline(target);
        else this.navigate(target);
    }

    private lastTargetNode(): WorkspaceNode | null {
        try {
            const raw = localStorage.getItem(LS_LAST);
            if (!raw) return null;
            const t = JSON.parse(raw) as OpenTarget;
            if (t.kind === 'home' || !('id' in t)) return null;
            return this.deps.store.getNode(t.id) || null;
        } catch { return null; }
    }

    private renderCenter() {
        this.centerEl.empty();
        const t = this.current;
        if (t.kind === 'home') { renderHome(this.centerEl, this.ctx, this.lastTargetNode()); return; }
        const node = this.deps.store.getNode(t.id);
        if (!node) { this.centerEl.createDiv({ cls: 'ck' }).createDiv({ cls: 'ck-body' }).createDiv({ cls: 'empty', text: '节点已不存在' }); return; }
        switch (t.kind) {
            case 'space': if (node.type === 'space') renderCockpit(this.centerEl, this.ctx, node, t.lens); break;
            case 'moc': if (node.type === 'moc') renderMocPage(this.centerEl, this.ctx, node); break;
            case 'project': if (node.type === 'project') renderProjectPage(this.centerEl, this.ctx, node); break;
            case 'note': if (node.type === 'note') renderNotePage(this.centerEl, this.ctx, node, this.deps.owner); break;
        }
    }
}

/** 新建 Space 弹窗:名称 + 框架镜头 */
class NewSpaceModal extends Modal {
    private framework: FrameworkId = 'para';
    constructor(app: App, private onSubmit: (title: string, framework: FrameworkId) => void) { super(app); }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(t('ws new space title'));

        const nameField = contentEl.createDiv();
        nameField.setCssStyles({ marginBottom: '14px' });
        nameField.createEl('label', { text: t('ws new space name') }).setCssStyles({
            display: 'block',
            fontSize: '12px',
            color: 'var(--text-muted)',
            marginBottom: '6px',
        });
        const input = nameField.createEl('input', { type: 'text' });
        input.setCssStyles({ width: '100%' });
        input.placeholder = t('ws new space name');

        const fwField = contentEl.createDiv();
        fwField.setCssStyles({ marginBottom: '18px' });
        fwField.createEl('label', { text: t('ws new space framework') }).setCssStyles({
            display: 'block',
            fontSize: '12px',
            color: 'var(--text-muted)',
            marginBottom: '6px',
        });
        const sel = fwField.createEl('select');
        sel.setCssStyles({ width: '100%' });
        (['para', 'overview', 'custom'] as FrameworkId[]).forEach(id => {
            sel.createEl('option', { value: id, text: fwLabel(id) });
        });
        sel.value = this.framework;
        sel.onchange = () => { this.framework = sel.value as FrameworkId; };

        const foot = contentEl.createDiv();
        foot.setCssStyles({
            display: 'flex',
            gap: '8px',
            justifyContent: 'flex-end',
        });
        const cancel = foot.createEl('button', { text: t('ws cancel') });
        cancel.onclick = () => this.close();
        const create = foot.createEl('button', { cls: 'mod-cta', text: t('ws create') });
        const submit = () => {
            const title = input.value.trim();
            if (!title) { input.focus(); return; }
            this.onSubmit(title, this.framework);
            this.close();
        };
        create.onclick = submit;
        input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
        setTimeout(() => input.focus(), 0);
    }

    onClose() { this.contentEl.empty(); }
}

function injectStyles() {
    // 总是覆盖 textContent:热重载时旧 <style> 仍留在 head,守卫式跳过会导致新 CSS 永不生效
    let style = document.getElementById(ZKW_STYLE_ID) as HTMLStyleElement | null;
    if (!style) style = document.head.createEl('style', { attr: { id: ZKW_STYLE_ID } });
    style.textContent = ZKW_CSS;
}
