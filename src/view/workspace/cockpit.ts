import { Menu, Notice } from "obsidian";
import { WSSpaceNode, WSMocNode, WSProjectNode, WorkspaceNode, FRAMEWORKS, isWorkspaceNodeArchived } from "src/types/workspace";
import { t } from "src/lang/helper";
import { RenderCtx, relTime, glyph, statusLabel, fwChip, bucketLabel, STATUS_COLOR, progressFor, nextActionText, renderTaskText } from "./render";
import { promptTitle } from "./modals";
import { FilePickerModal } from "src/modal/filePickerModal";

const FW_CLASS: Record<string, string> = { para: 'para', overview: 'overview', custom: 'custom' };
// 桶 → 卡片样式
const PROJECT_BUCKETS = new Set(['projects', 'action']);
const MOC_BUCKETS = new Set(['areas', 'overview', 'theme']);

/** Space cockpit 概览页(原型 .ck)。initialLens:从 rail 点桶进入时预选的 lens。 */
export function renderCockpit(container: HTMLElement, ctx: RenderCtx, space: WSSpaceNode, initialLens?: string): void {
    const ck = container.createDiv({ cls: 'ck' });
    const all = ctx.store.nodesInSpace(space.id);
    const projects = all.filter((n): n is WSProjectNode => n.type === 'project');
    const mocs = all.filter((n): n is WSMocNode => n.type === 'moc');
    const notes = all.filter(n => n.type === 'note' || n.type === 'map');
    const activeCount = projects.filter(p => p.status === 'active' || p.status === 'blocked').length;
    const fw = FRAMEWORKS[space.framework];

    // ---------- Hero(sticky) ----------
    const hero = ck.createDiv({ cls: 'ck-hero' });
    hero.createDiv({ cls: 'ck-crumb', text: t('ws Workspace') });

    const titleRow = hero.createDiv({ cls: 'ck-titlerow' });
    const bigic = titleRow.createDiv({ cls: 'ck-bigic space' });
    glyph(bigic, 'space', space.color || 'var(--violet)');
    const titleCol = titleRow.createDiv();
    titleCol.createEl('h1', { cls: 'ck-h1', text: space.title });
    const tagRow = titleCol.createDiv({ cls: 'ck-tagrow' });
    tagRow.createSpan({ cls: `fwchip ${FW_CLASS[space.framework]}`, text: fwChip(space.framework) });
    const stat = (label: string, val: number) => {
        tagRow.createSpan({ cls: 'dotsep', text: '·' });
        const s = tagRow.createSpan({ cls: 'stat' });
        s.createEl('b', { text: String(val) });
        s.appendText(' ' + label);
    };
    stat(t('ws stat active'), activeCount);
    stat(t('ws stat moc'), mocs.length);
    stat(t('ws stat notes'), notes.length);
    if (space.description) hero.createDiv({ cls: 'ck-desc', text: space.description });

    // ---------- Lens tabs(可过滤) ----------
    const tabs = ck.createDiv({ cls: 'lenstabs' });

    const validLens = initialLens && (initialLens === 'all' || fw.buckets.some(b => b.id === initialLens));
    let activeLens = validLens ? initialLens! : 'all';

    // ---------- 上下文入口:Project 绑定主文件;其它桶挂载 Note/MOC ----------
    const createbar = ck.createDiv({ cls: 'createbar' });
    const mkCreate = (label: string, fn: () => void) => {
        const b = createbar.createSpan({ cls: 'createbtn', text: '+ ' + label });
        b.onclick = fn;
    };

    const createProject = () => promptTitle(ctx.app, t('ws new project'), (title) => { void (async () => {
        try {
            const n = await ctx.store.createProjectWithFile(
                space.id, title, ctx.projectFolderPath, ctx.taskFileTag,
            );
            ctx.open({ kind: 'project', id: n.id });
        } catch (e) {
            console.error('[zk-navigation] 创建项目失败', e);
            new Notice(t('ws project create failed').replace('{message}', (e as Error)?.message ?? String(e)));
        }
    })(); });

    const importProjects = () => {
        const projectPaths = ctx.store.getAllNodes()
            .filter((n): n is WSProjectNode => n.type === 'project')
            .map(n => n.filePath)
            .filter((path): path is string => !!path);
        new FilePickerModal(ctx.app, space.title, projectPaths, (paths) => { void (async () => {
            try {
                const result = await ctx.store.importProjectFiles(space.id, paths);
                if (!result.projects.length) {
                    new Notice(t('ws project import empty'));
                    return;
                }
                new Notice(t('ws project import result')
                    .replace('{count}', String(result.projects.length))
                    .replace('{converted}', String(result.converted)));
                if (result.projects.length === 1) {
                    ctx.open({ kind: 'project', id: result.projects[0].id });
                } else {
                    ctx.refresh();
                }
            } catch (e) {
                console.error('[zk-navigation] 导入项目失败', e);
                new Notice(t('ws project import failed').replace('{message}', (e as Error)?.message ?? String(e)));
            }
        })(); }, {
            title: t('ws import project picker').replace('{name}', space.title),
            searchPlaceholder: t('ws import project search'),
            confirmLabel: t('ws import project confirm'),
            unavailableLabel: t('ws project already imported'),
            filter: file => file.extension.toLowerCase() === 'md',
        }).open();
    };

    // 笔记与 MOC 不再凭空建虚拟节点:挑库里已存在的文件挂进来(`.moc.md` → MOC,其余 → 笔记)
    const mountExisting = () => {
        const mounted = ctx.store.containerChildren(space.id)
            .map(c => (c as { filePath?: string }).filePath)
            .filter((p): p is string => !!p);
        new FilePickerModal(ctx.app, space.title, mounted, (paths) => { void (async () => {
            // 按当前镜头决定挂进来的 MOC 落「总览」还是「主题」(issue #71);非这两个镜头不指定
            const mocIsTop = activeLens === 'overview' ? true : activeLens === 'theme' ? false : undefined;
            await ctx.store.mountFilesToContainer(space.id, paths, { mocIsTop });
            ctx.refresh();
        })(); }).open();
    };

    const renderCreatebar = () => {
        createbar.empty();
        const isProjectLens = activeLens === 'projects' || activeLens === 'action';
        const isArchiveLens = activeLens === 'archive';
        createbar.setCssStyles({ display: isArchiveLens ? 'none' : 'flex' });
        if (isArchiveLens) return;
        if (activeLens === 'all') {
            mkCreate(t('ws new project'), createProject);
            mkCreate(t('ws mount existing'), mountExisting);
        } else if (isProjectLens) {
            mkCreate(t('ws new project'), createProject);
            mkCreate(t('ws import project'), importProjects);
        } else {
            mkCreate(t('ws mount existing'), mountExisting);
        }
    };

    const body = ck.createDiv({ cls: 'ck-body' });

    const mkTab = (id: string, label: string, count: number) => {
        const tab = tabs.createDiv({ cls: 'lenstab' + (id === activeLens ? ' on' : ''), text: label });
        tab.createSpan({ cls: 'c', text: String(count) });
        tab.onclick = () => {
            if (activeLens === id) return;
            activeLens = id;
            Array.from(tabs.children).forEach(c => c.toggleClass('on', (c as HTMLElement) === tab));
            renderCreatebar();
            renderBody();
        };
    };
    mkTab('all', t('ws bucket all'), all.filter(n => !isWorkspaceNodeArchived(n)).length);
    fw.buckets.forEach(b => mkTab(b.id, bucketLabel(b.id), all.filter(b.match).length));

    const renderBody = () => {
        body.empty();
        if (activeLens === 'all') { renderAllSections(body, ctx, space.id, projects, mocs, notes); return; }
        const bucket = fw.buckets.find(b => b.id === activeLens);
        if (!bucket) return;
        const items = all.filter(bucket.match);
        renderBucketSection(body, ctx, space.id, bucket.id, bucketLabel(bucket.id), items);
    };
    renderCreatebar();
    renderBody();
}

function renderAllSections(
    body: HTMLElement, ctx: RenderCtx, spaceId: string,
    projects: WSProjectNode[], mocs: WSMocNode[], notes: WorkspaceNode[],
): void {
    const liveProjects = projects.filter(p => !isWorkspaceNodeArchived(p));
    const liveMocs = mocs.filter(m => !isWorkspaceNodeArchived(m));
    const liveNotes = notes.filter(n => !isWorkspaceNodeArchived(n));
    const archived = [...projects, ...mocs, ...notes].filter(isWorkspaceNodeArchived);

    if (liveProjects.length) {
        sectitle(body, t('ws sec projects'), liveProjects.length, t('ws sec projects desc'));
        const grid = body.createDiv({ cls: 'pgrid' });
        liveProjects.sort(byStatusThenTime).forEach(p => renderProjectCard(grid, ctx, p, spaceId));
    }
    if (liveMocs.length) {
        sectitle(body, t('ws sec areas'), liveMocs.length, t('ws sec areas desc'));
        const grid = body.createDiv({ cls: 'pgrid' });
        liveMocs.forEach(m => renderMocCard(grid, ctx, m, spaceId));
    }
    if (liveNotes.length) {
        sectitle(body, t('ws sec resources'), liveNotes.length);
        const grid = body.createDiv({ cls: 'notegrid' });
        liveNotes.forEach(n => renderNoteCard(grid, ctx, n, spaceId));
    }
    if (archived.length) {
        sectitle(body, t('ws sec archive'), archived.length);
        renderArchiveCards(body, ctx, archived, spaceId);
    }
}

function renderBucketSection(body: HTMLElement, ctx: RenderCtx, spaceId: string, bucketId: string, label: string, items: WorkspaceNode[]): void {
    sectitle(body, label, items.length);
    if (!items.length) { body.createDiv({ cls: 'empty', text: t('ws no members') }); return; }
    if (bucketId === 'archive') {
        renderArchiveCards(body, ctx, items, spaceId);
    } else if (PROJECT_BUCKETS.has(bucketId)) {
        const grid = body.createDiv({ cls: 'pgrid' });
        (items as WSProjectNode[]).slice().sort(byStatusThenTime).forEach(p => renderProjectCard(grid, ctx, p, spaceId));
    } else if (MOC_BUCKETS.has(bucketId)) {
        const grid = body.createDiv({ cls: 'pgrid' });
        (items as WSMocNode[]).forEach(m => renderMocCard(grid, ctx, m, spaceId));
    } else {
        const grid = body.createDiv({ cls: 'notegrid' });
        items.forEach(n => renderNoteCard(grid, ctx, n, spaceId));
    }
}

function renderArchiveCards(body: HTMLElement, ctx: RenderCtx, items: WorkspaceNode[], spaceId: string): void {
    const projects = items.filter((n): n is WSProjectNode => n.type === 'project');
    const mocs = items.filter((n): n is WSMocNode => n.type === 'moc');
    const notes = items.filter(n => n.type === 'note' || n.type === 'map');
    if (projects.length) {
        const grid = body.createDiv({ cls: 'pgrid' });
        projects.slice().sort(byStatusThenTime).forEach(p => renderProjectCard(grid, ctx, p, spaceId));
    }
    if (mocs.length) {
        const grid = body.createDiv({ cls: 'pgrid' });
        mocs.forEach(m => renderMocCard(grid, ctx, m, spaceId));
    }
    if (notes.length) {
        const grid = body.createDiv({ cls: 'notegrid' });
        notes.forEach(n => renderNoteCard(grid, ctx, n, spaceId));
    }
}

/** 卡片右键菜单:删除该条目(二次确认走 ctx.requestDelete) */
function cardMenu(e: MouseEvent, ctx: RenderCtx, node: WorkspaceNode, spaceId?: string, placementId?: string): void {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    const archived = isWorkspaceNodeArchived(node);
    menu.addItem(i => i.setTitle(t(archived ? 'ws restore archive' : 'ws archive'))
        .setIcon(archived ? 'archive-restore' : 'archive')
        .onClick(() => { void ctx.store.setArchived(node.id, !archived); }));
    menu.addSeparator();
    menu.addItem(i => { (i as { setWarning?(warning: boolean): void }).setWarning?.(true); i.setTitle(t('ws delete')).setIcon('trash-2')
        .onClick(() => ctx.requestDelete(node, spaceId, placementId)); });
    menu.showAtMouseEvent(e);
}

function byStatusThenTime(a: WSProjectNode, b: WSProjectNode): number {
    const rank = (s: WSProjectNode['status']) => ({ blocked: 0, active: 1, todo: 2, done: 3, archived: 4 }[s]);
    return rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt;
}

function sectitle(body: HTMLElement, title: string, count: number, desc?: string): void {
    const st = body.createDiv({ cls: 'sectitle' });
    st.createSpan({ cls: 'st', text: title });
    st.createSpan({ cls: 'sc', text: String(count) });
    // 开发备注式说明收进 (?) tooltip,不再占满标题行
    if (desc) st.createSpan({ cls: 'sq', text: '?' }).setAttribute('title', desc);
}

function renderProjectCard(grid: HTMLElement, ctx: RenderCtx, p: WSProjectNode, spaceId: string): void {
    const placement = ctx.store.placementForNodeInSpace(p.id, spaceId);
    const card = grid.createDiv({ cls: 'pcard reveal' + (p.status === 'archived' ? ' arch' : '') });
    card.onclick = () => ctx.openDeck(p, placement?.id);
    card.oncontextmenu = (e) => cardMenu(e, ctx, p, spaceId, placement?.id);

    const top = card.createDiv({ cls: 'ptop' });
    const stat = top.createSpan({ cls: `pstat ${p.status}` });
    stat.createSpan({ cls: `sd ${p.status}` });
    stat.appendText(statusLabel(p.status));
    top.createSpan({ cls: 'plast', text: t('ws update prefix').replace('{t}', relTime(p.updatedAt)) });

    const pname = card.createDiv({ cls: 'pname link', text: p.title });
    pname.onclick = (e) => { e.stopPropagation(); ctx.open(ctx.store.targetFor(p, placement)); };

    const na = nextActionText(ctx, p);
    if (na) {
        const next = card.createDiv({ cls: 'pnext' });
        next.createSpan({ cls: 'na', text: 'NEXT' });
        renderTaskText(next.createSpan(), ctx, na);
    }

    const pct = progressFor(ctx, p);
    if (pct !== null) {
        const bar = card.createDiv({ cls: 'pbar' });
        bar.createEl('i').setCssStyles({
            width: `${pct}%`,
            background: `${STATUS_COLOR[p.status]}`,
        });
    }

    const serveLinks = ctx.store.linksFrom(p.id).filter(l => l.type === 'serves');
    if (serveLinks.length) {
        const refs = card.createDiv({ cls: 'prefs' });
        refs.createSpan({ cls: 'rl', text: t('ws serves') });
        serveLinks.forEach(l => {
            const m = ctx.store.getNode(l.to);
            if (!m) return;
            const chip = refs.createSpan({ cls: 'refchip', text: m.title });
            chip.onclick = (e) => {
                e.stopPropagation();
                ctx.open(ctx.store.targetFor(m, ctx.store.placementForNodeInSpace(m.id, spaceId)));
            };
        });
    }
}

function renderMocCard(grid: HTMLElement, ctx: RenderCtx, m: WSMocNode, spaceId: string): void {
    const placement = ctx.store.placementForNodeInSpace(m.id, spaceId);
    const card = grid.createDiv({ cls: 'moccard reveal' });
    card.onclick = () => ctx.openDeck(m, placement?.id);
    card.oncontextmenu = (e) => cardMenu(e, ctx, m, spaceId, placement?.id);

    const members = ctx.store.servedBy(m.id);
    card.toggleClass('empty-moc', members.length === 0);

    const top = card.createDiv({ cls: 'mtop' });
    glyph(top, 'moc');
    const name = top.createSpan({ cls: 'mname link', text: m.title });
    name.setAttribute('title', t('ws open graph'));
    name.onclick = (e) => { e.stopPropagation(); ctx.open(ctx.store.targetFor(m, placement)); };
    // 聚合 0 不出标签(噪音);仅 1+ 时高亮显示
    if (members.length) top.createSpan({ cls: 'magg', text: t('ws agg').replace('{n}', String(members.length)) });

    if (members.length) {
        const list = card.createDiv({ cls: 'mlist' });
        members.slice(0, 5).forEach(n => {
            const item = list.createSpan({ cls: 'mitem' });
            glyph(item, n.type);
            item.appendText(n.title);
            item.onclick = (e) => { e.stopPropagation(); ctx.open(ctx.store.targetFor(n)); };
        });
    }
}

function renderNoteCard(grid: HTMLElement, ctx: RenderCtx, n: WorkspaceNode, spaceId: string): void {
    const placement = ctx.store.placementForNodeInSpace(n.id, spaceId);
    const card = grid.createDiv({ cls: 'notecard reveal' });
    card.onclick = () => ctx.openDeck(n, placement?.id);
    card.oncontextmenu = (e) => cardMenu(e, ctx, n, spaceId, placement?.id);
    glyph(card, n.type);
    const nn = card.createSpan({ cls: 'nn link', text: n.title });
    nn.onclick = (e) => { e.stopPropagation(); ctx.open(ctx.store.targetFor(n, placement)); };
}
