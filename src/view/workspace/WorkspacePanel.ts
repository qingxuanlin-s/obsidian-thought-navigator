import { App, Component, EventRef, Modal, TFile, setIcon, setTooltip } from "obsidian";
import { t } from "src/lang/helper";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { ProjectTaskStore } from "src/workspace/projectTasks";
import { OpenTarget, WorkspaceNode, WSMocNode, FrameworkId } from "src/types/workspace";
import { fwLabel } from "./render";
import { RenderCtx } from "./render";
import { renderCockpit } from "./cockpit";
import { renderProjectPage, renderMocPage, renderNotePage, renderHome } from "./pages";
import { SpacesTree } from "./spacesTree";
import { Deck } from "./deck";
import { confirmModal } from "./modals";

const LS_OPEN = "zkw.open";
const LS_LAST = "zkw.last";
const LS_RAIL = "zkw.rail.collapsed";

export interface WorkspacePanelDeps {
    app: App;
    store: WorkspaceStore;
    /** 宿主组件,用于 MarkdownRenderer 生命周期 */
    owner: Component;
    /** 项目背书笔记(next action 任务)所在文件夹 */
    projectFolderPath: string;
    /** 新建任务/子任务自动前缀字符(如 "🎯 ") */
    taskPrefix: string;
    /** 是否在新建/编辑任务时自动补任务前缀 */
    taskPrefixAuto: boolean;
    /** 新建项目背书笔记时自动写入的 tag */
    taskFileTag: string;
    /** 打开一个带图谱的 MOC/map 节点时,交给宿主(indexView)切到图谱模式并加载文件。
     *  返回 true 表示宿主已接管(面板不再自渲 MOC 页);false / 不提供则面板内渲 MOC 概览页。 */
    onOpenMoc?: (node: WSMocNode) => boolean;
    /** 顶栏「图谱」按钮:切回图谱模式。提供则显示该按钮。 */
    onExitToGraph?: () => void;
    /** 打开文件笔记,交给宿主按「文件默认打开方式」打开(绝不覆盖思维树图谱)。
     *  不提供则面板退化为在当前 leaf 打开。 */
    onOpenFile?: (file: TFile, forceTab: boolean) => void;
    /** 打开 wiki 链接,同样交给宿主按默认方式打开。不提供则退化为 openLinkText。 */
    onOpenLink?: (linkText: string, sourcePath: string, forceTab: boolean) => void;
    /** 内嵌到图谱视图时,工作区内部导航交给宿主记录到同一条浏览历史。 */
    onNavigateTarget?: (target: OpenTarget) => void;
    onNavBack?: () => void;
    onNavForward?: () => void;
    getNavState?: () => { canBack: boolean; canForward: boolean };
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
    private railEl!: HTMLElement;
    private railScrollEl!: HTMLElement;
    private railToggleEl: HTMLElement | null = null;
    private railCollapsed = false;
    private tree!: SpacesTree;
    private deck!: Deck;
    private current: OpenTarget = { kind: 'home' };
    private navHistory: OpenTarget[] = [];
    private navIndex = -1;
    private navApplying = false;
    private navBackEl: HTMLElement | null = null;
    private navForwardEl: HTMLElement | null = null;
    private unsub: (() => void) | null = null;
    private taskStore: ProjectTaskStore;
    private modifyRef: EventRef | null = null;
    private taskSettingsListener: EventListener | null = null;
    private readonly MAX_NAV_HISTORY = 50;

    constructor(parent: HTMLElement, deps: WorkspacePanelDeps) {
        this.deps = deps;
        this.root = parent.createDiv({ cls: 'zkw' });
        try { this.railCollapsed = deps.app.loadLocalStorage(LS_RAIL) === '1'; } catch {}

        this.taskStore = new ProjectTaskStore(deps.app);
        this.taskStore.onChange = () => this.refresh();

        this.ctx = {
            app: deps.app,
            store: deps.store,
            tasks: this.taskStore,
            projectFolderPath: deps.projectFolderPath,
            taskPrefix: deps.taskPrefix,
            taskPrefixAuto: deps.taskPrefixAuto,
            taskFileTag: deps.taskFileTag,
            open: (t) => this.navigate(t),
            openInline: (t) => this.navigateInline(t),
            openFile: (file, forceTab = false) => {
                if (deps.onOpenFile) deps.onOpenFile(file, forceTab);
                else void deps.app.workspace.getLeaf(forceTab).openFile(file);
            },
            openLink: (linkText, sourcePath = '', forceTab = false) => {
                if (deps.onOpenLink) deps.onOpenLink(linkText, sourcePath, forceTab);
                else void deps.app.workspace.openLinkText(linkText, sourcePath, forceTab);
            },
            openDeck: (n) => this.deck?.open(n),
            requestDelete: (n) => this.requestDelete(n),
            refresh: () => this.refresh(),
        };
        const taskSettingsListener: EventListener = (event: Event) => {
            const detail = (event as CustomEvent<Pick<WorkspacePanelDeps, 'projectFolderPath' | 'taskPrefix' | 'taskPrefixAuto' | 'taskFileTag'>>).detail;
            if (!detail) return;
            this.updateTaskSettings(detail);
        };
        this.taskSettingsListener = taskSettingsListener;
        window.addEventListener('zkw-workspace-task-settings-change', taskSettingsListener);

        // 项目背书笔记被外部(用户编辑 / Tasks 插件勾选)改动 → 失效缓存并重渲染。
        // 自写已经 setFromContent 同步过缓存(isCurrent),跳过以免重复刷新导致闪烁。
        this.modifyRef = deps.app.vault.on('modify', (file) => {
            if (!(file instanceof TFile)) return;
            if (this.taskStore.isCurrent(file.path)) return;
            this.taskStore.invalidate(file.path);
            if (deps.store.getAllNodes().some(n => n.type === 'project' && n.filePath === file.path)) {
                this.refresh();
                this.deck?.refreshIfShowing(file.path);
            }
        });

        this.buildToolbar(this.root);
        const body = this.root.createDiv({ cls: 'body' });
        this.buildRail(body);
        this.centerEl = body.createDiv({ cls: 'center' });
        this.deck = new Deck(body, this.ctx, deps.owner);

        this.root.tabIndex = 0;
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.deck.handleEsc()) e.stopPropagation();
            const activeEl = activeDocument.activeElement as HTMLElement | null;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) return;
            if ((e.metaKey || e.ctrlKey) && e.key === '[') {
                e.preventDefault();
                e.stopPropagation();
                this.back();
            }
            if ((e.metaKey || e.ctrlKey) && e.key === ']') {
                e.preventDefault();
                e.stopPropagation();
                this.forward();
            }
        });

        this.unsub = deps.store.onChange(() => { if (this.tree) { this.renderCenter(); this.tree.render(); } });
        this.applyRailCollapsed();
        this.restoreSession();
    }

    /** 收起/展开整个左侧 rail 面板 */
    private toggleRail() {
        this.railCollapsed = !this.railCollapsed;
        try { this.deps.app.saveLocalStorage(LS_RAIL, this.railCollapsed ? '1' : '0'); } catch {}
        this.applyRailCollapsed();
    }

    private applyRailCollapsed() {
        // 用根 class 切换:rail display:none + body 退成单列,避免 center 被塞进空出的 296px 轨道
        this.root.toggleClass('rail-collapsed', this.railCollapsed);
        if (this.railToggleEl) {
            setIcon(this.railToggleEl, this.railCollapsed ? 'panel-left-open' : 'panel-left-close');
            setTooltip(this.railToggleEl, t(this.railCollapsed ? 'ws show sidebar' : 'ws hide sidebar'));
        }
    }

    destroy() {
        this.unsub?.();
        this.unsub = null;
        if (this.modifyRef) { this.deps.app.vault.offref(this.modifyRef); this.modifyRef = null; }
        if (this.taskSettingsListener) {
            window.removeEventListener('zkw-workspace-task-settings-change', this.taskSettingsListener);
            this.taskSettingsListener = null;
        }
        this.taskStore.dispose();
        this.root.remove();
    }

    setVisible(v: boolean) { this.root.setCssStyles({ display: v ? 'flex' : 'none' }); }

    /** 供宿主在切到工作区模式时刷新一次 */
    refresh() { if (this.tree) { this.renderCenter(); this.tree.render(); } }

    updateTaskSettings(settings: Pick<WorkspacePanelDeps, 'projectFolderPath' | 'taskPrefix' | 'taskPrefixAuto' | 'taskFileTag'>): void {
        this.deps = { ...this.deps, ...settings };
        this.ctx.projectFolderPath = settings.projectFolderPath;
        this.ctx.taskPrefix = settings.taskPrefix;
        this.ctx.taskPrefixAuto = settings.taskPrefixAuto;
        this.ctx.taskFileTag = settings.taskFileTag;
        this.refresh();
    }

    // ---------- Toolbar ----------
    private buildToolbar(shell: HTMLElement) {
        const tbar = shell.createDiv({ cls: 'tbar' });

        // 收起/展开整个左侧 rail
        const railToggle = tbar.createDiv({ cls: 'ticon' });
        railToggle.onclick = () => this.toggleRail();
        this.railToggleEl = railToggle;

        const brand = tbar.createDiv({ cls: 'brand' });
        brand.createSpan({ cls: 'mk', text: 'ZK' });
        brand.createSpan({ cls: 'bt', text: t('ws Workspace') });

        const home = tbar.createDiv({ cls: 'home' });
        setIcon(home.createSpan({ cls: 'hic' }), 'home');
        home.createSpan({ text: t('ws Task') });
        home.onclick = () => this.navigate({ kind: 'home' });

        tbar.createDiv({ cls: 'spacer' });

        const nav = tbar.createDiv({ cls: 'navctl' });
        const back = nav.createDiv({ cls: 'ticon navbtn' });
        setIcon(back, 'arrow-left');
        setTooltip(back, t('nav back'));
        back.onclick = () => this.back();
        this.navBackEl = back;
        const forward = nav.createDiv({ cls: 'ticon navbtn' });
        setIcon(forward, 'arrow-right');
        setTooltip(forward, t('nav forward'));
        forward.onclick = () => this.forward();
        this.navForwardEl = forward;
        this.updateNavButtons();

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
        this.railEl = rail;
        const head = rail.createDiv({ cls: 'rail-head' });
        head.createSpan({ cls: 't', text: 'Spaces' });
        const meta = head.createSpan({ cls: 'meta' });
        // 一键折叠/展开树里所有节点
        const collapseAll = head.createDiv({ cls: 'add' });
        setIcon(collapseAll, 'list-collapse');
        collapseAll.setAttribute('title', t('ws collapse all'));
        collapseAll.onclick = () => { this.tree.toggleCollapseAll(); };
        const add = head.createDiv({ cls: 'add', text: '+' });
        add.setAttribute('title', t('ws New space'));
        add.onclick = () => this.openNewSpaceModal();
        this.railScrollEl = rail.createDiv({ cls: 'rail-scroll' });
        this.tree = new SpacesTree(this.railScrollEl, this.ctx);
        meta.setText(t('ws spaces count').replace('{n}', String(this.deps.store.getSpaces().length)));
    }

    /** 删除条目:统计子树规模 → 二次确认 → deleteSubtree;若当前视口/deck 展示的是被删节点则退回首页/关 deck。 */
    private requestDelete(node: WorkspaceNode) {
        const ids = this.deps.store.collectSubtreeIds(node.id);
        const deleted = new Set(ids);
        const descendants = ids.length - 1;
        const msg = node.type === 'space'
            ? t('ws delete space confirm').replace('{title}', node.title).replace('{n}', String(descendants))
            : descendants > 0
                ? t('ws delete node confirm children').replace('{title}', node.title).replace('{n}', String(descendants))
                : t('ws delete node confirm').replace('{title}', node.title);
        confirmModal(this.deps.app, t('ws delete'), msg, () => { void (async () => {
            await this.deps.store.deleteSubtree(node.id);
            this.deck?.closeIfShowing(deleted);
            const cur = this.current;
            // store.onChange 已触发重渲;当前页指向被删节点时改导航到首页
            if (cur.kind !== 'home' && 'id' in cur && deleted.has(cur.id)) this.navigateInline({ kind: 'home' });
        })(); });
    }

    private openNewSpaceModal() {
        new NewSpaceModal(this.deps.app, (title, framework) => { void (async () => {
            const space = await this.deps.store.createSpace(title, { framework });
            this.navigate({ kind: 'space', id: space.id });
        })(); }).open();
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
        if (target.kind !== 'home') { try { this.deps.app.saveLocalStorage(LS_LAST, JSON.stringify(target)); } catch {} }
        try { this.deps.app.saveLocalStorage(LS_OPEN, JSON.stringify(target)); } catch {}
        this.tree.setCurrent(target);
        this.tree.revealTarget(target);
        this.renderCenter();
        this.tree.render();
        if (this.deps.onNavigateTarget) this.deps.onNavigateTarget({ ...target });
        else this.recordNavState(target);
        this.updateNavButtons();
    }

    getCurrentTarget(): OpenTarget { return { ...this.current }; }

    /** 由宿主浏览历史还原 workspace 目标;始终在面板内渲染,不甩回图谱。 */
    showTarget(target: OpenTarget): void { this.navigateInline(target); }

    /** 外部入口(全局搜索等)打开 workspace 目标,保留 MOC/map 交给宿主切图谱的语义。 */
    openTarget(target: OpenTarget): void { this.navigate(target); }

    private sameTarget(a: OpenTarget | null | undefined, b: OpenTarget): boolean {
        if (!a || a.kind !== b.kind) return false;
        if (a.kind === 'home' || b.kind === 'home') return true;
        if (a.id !== b.id) return false;
        return (a.kind !== 'space' || b.kind !== 'space' || a.lens === b.lens);
    }

    private recordNavState(target: OpenTarget) {
        if (this.navApplying) return;
        if (this.sameTarget(this.navHistory[this.navIndex], target)) {
            this.updateNavButtons();
            return;
        }
        if (this.navIndex < this.navHistory.length - 1) {
            this.navHistory = this.navHistory.slice(0, this.navIndex + 1);
        }
        this.navHistory.push({ ...target });
        if (this.navHistory.length > this.MAX_NAV_HISTORY) this.navHistory.shift();
        this.navIndex = this.navHistory.length - 1;
        this.updateNavButtons();
    }

    private back() {
        if (this.deps.onNavBack) { this.deps.onNavBack(); return; }
        this.navBack();
    }

    private forward() {
        if (this.deps.onNavForward) { this.deps.onNavForward(); return; }
        this.navForward();
    }

    private navBack() {
        if (this.navIndex <= 0) return;
        this.applyNavState(this.navIndex - 1);
    }

    private navForward() {
        if (this.navIndex >= this.navHistory.length - 1) return;
        this.applyNavState(this.navIndex + 1);
    }

    private applyNavState(index: number) {
        const target = this.navHistory[index];
        if (!target) return;
        this.navApplying = true;
        try {
            this.navIndex = index;
            this.navigateInline(target);
        } finally {
            this.navApplying = false;
        }
        this.updateNavButtons();
    }

    syncNavButtons(): void { this.updateNavButtons(); }

    private updateNavButtons() {
        const external = this.deps.getNavState?.();
        const backEnabled = external ? external.canBack : this.navIndex > 0;
        const forwardEnabled = external ? external.canForward : this.navIndex >= 0 && this.navIndex < this.navHistory.length - 1;
        this.navBackEl?.toggleClass('disabled', !backEnabled);
        this.navForwardEl?.toggleClass('disabled', !forwardEnabled);
        this.navBackEl?.setAttribute('aria-disabled', String(!backEnabled));
        this.navForwardEl?.setAttribute('aria-disabled', String(!forwardEnabled));
    }

    private restoreSession() {
        let target: OpenTarget | null = null;
        try { const raw = this.deps.app.loadLocalStorage(LS_OPEN) as string | null; if (raw) target = JSON.parse(raw) as OpenTarget; } catch {}
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
            const raw = this.deps.app.loadLocalStorage(LS_LAST) as string | null;
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
        window.setTimeout(() => input.focus(), 0);
    }

    onClose() { this.contentEl.empty(); }
}
