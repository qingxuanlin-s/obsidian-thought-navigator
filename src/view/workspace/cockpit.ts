import { WSSpaceNode, WSMocNode, WSProjectNode, WorkspaceNode, FRAMEWORKS } from "src/types/workspace";
import { projectProgress } from "src/workspace/WorkspaceStore";
import { t } from "src/lang/helper";
import { RenderCtx, relTime, glyph, statusLabel, fwChip, bucketLabel, STATUS_COLOR } from "./render";
import { promptTitle } from "./modals";

const FW_CLASS: Record<string, string> = { para: 'para', overview: 'overview', custom: 'custom' };
// 桶 → 卡片样式
const PROJECT_BUCKETS = new Set(['projects', 'archive', 'action']);
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

    // ---------- 新建入口(空 Space 也能从零搭起) ----------
    const createbar = ck.createDiv({ cls: 'createbar' });
    const mkCreate = (label: string, fn: () => void) => {
        const b = createbar.createSpan({ cls: 'createbtn', text: '+ ' + label });
        b.onclick = fn;
    };
    mkCreate(t('ws new project'), () => promptTitle(ctx.app, t('ws new project'), async (title) => {
        const n = await ctx.store.createProject(space.id, title);
        ctx.open({ kind: 'project', id: n.id });
    }));
    mkCreate(t('ws new moc'), () => promptTitle(ctx.app, t('ws new moc'), async (title) => {
        const n = await ctx.store.createMoc(space.id, title);
        ctx.open({ kind: 'moc', id: n.id });
    }));
    mkCreate(t('ws new note'), () => promptTitle(ctx.app, t('ws new note'), async (title) => {
        const n = await ctx.store.createNote(space.id, title);
        ctx.open({ kind: 'note', id: n.id });
    }));

    const body = ck.createDiv({ cls: 'ck-body' });
    const validLens = initialLens && (initialLens === 'all' || fw.buckets.some(b => b.id === initialLens));
    let activeLens = validLens ? initialLens! : 'all';

    const mkTab = (id: string, label: string, count: number) => {
        const tab = tabs.createDiv({ cls: 'lenstab' + (id === activeLens ? ' on' : ''), text: label });
        tab.createSpan({ cls: 'c', text: String(count) });
        tab.onclick = () => {
            if (activeLens === id) return;
            activeLens = id;
            Array.from(tabs.children).forEach(c => c.toggleClass('on', (c as HTMLElement) === tab));
            renderBody();
        };
    };
    mkTab('all', t('ws bucket all'), all.filter(n => !(n.type === 'project' && n.status === 'archived')).length);
    fw.buckets.forEach(b => mkTab(b.id, bucketLabel(b.id), all.filter(b.match).length));

    const renderBody = () => {
        body.empty();
        if (activeLens === 'all') { renderAllSections(body, ctx, projects, mocs, notes); return; }
        const bucket = fw.buckets.find(b => b.id === activeLens);
        if (!bucket) return;
        const items = all.filter(bucket.match);
        renderBucketSection(body, ctx, bucket.id, bucketLabel(bucket.id), items);
    };
    renderBody();
}

function renderAllSections(
    body: HTMLElement, ctx: RenderCtx,
    projects: WSProjectNode[], mocs: WSMocNode[], notes: WorkspaceNode[],
): void {
    const liveProjects = projects.filter(p => p.status !== 'archived');
    const archived = projects.filter(p => p.status === 'archived');

    if (liveProjects.length) {
        sectitle(body, t('ws sec projects'), liveProjects.length, t('ws sec projects desc'));
        const grid = body.createDiv({ cls: 'pgrid' });
        liveProjects.sort(byStatusThenTime).forEach(p => renderProjectCard(grid, ctx, p));
    }
    if (mocs.length) {
        sectitle(body, t('ws sec areas'), mocs.length, t('ws sec areas desc'));
        const grid = body.createDiv({ cls: 'pgrid' });
        mocs.forEach(m => renderMocCard(grid, ctx, m));
    }
    if (notes.length) {
        sectitle(body, t('ws sec resources'), notes.length);
        const grid = body.createDiv({ cls: 'notegrid' });
        notes.forEach(n => renderNoteCard(grid, ctx, n));
    }
    if (archived.length) {
        sectitle(body, t('ws sec archive'), archived.length);
        const grid = body.createDiv({ cls: 'pgrid' });
        archived.forEach(p => renderProjectCard(grid, ctx, p));
    }
}

function renderBucketSection(body: HTMLElement, ctx: RenderCtx, bucketId: string, label: string, items: WorkspaceNode[]): void {
    sectitle(body, label, items.length);
    if (!items.length) { body.createDiv({ cls: 'empty', text: t('ws no members') }); return; }
    if (PROJECT_BUCKETS.has(bucketId)) {
        const grid = body.createDiv({ cls: 'pgrid' });
        (items as WSProjectNode[]).slice().sort(byStatusThenTime).forEach(p => renderProjectCard(grid, ctx, p));
    } else if (MOC_BUCKETS.has(bucketId)) {
        const grid = body.createDiv({ cls: 'pgrid' });
        (items as WSMocNode[]).forEach(m => renderMocCard(grid, ctx, m));
    } else {
        const grid = body.createDiv({ cls: 'notegrid' });
        items.forEach(n => renderNoteCard(grid, ctx, n));
    }
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

function renderProjectCard(grid: HTMLElement, ctx: RenderCtx, p: WSProjectNode): void {
    const card = grid.createDiv({ cls: 'pcard reveal' + (p.status === 'archived' ? ' arch' : '') });
    // 卡片空白区 → 详情面板;名字 → 项目页(含 NEXT ACTION / 关联笔记)
    card.onclick = () => ctx.openDeck(p);

    const top = card.createDiv({ cls: 'ptop' });
    const stat = top.createSpan({ cls: `pstat ${p.status}` });
    stat.createSpan({ cls: `sd ${p.status}` });
    stat.appendText(statusLabel(p.status));
    top.createSpan({ cls: 'plast', text: t('ws update prefix').replace('{t}', relTime(p.updatedAt)) });

    const pname = card.createDiv({ cls: 'pname link', text: p.title });
    pname.onclick = (e) => { e.stopPropagation(); ctx.open({ kind: 'project', id: p.id }); };

    if (p.nextAction) {
        const next = card.createDiv({ cls: 'pnext' });
        next.createSpan({ cls: 'na', text: 'NEXT' });
        next.createSpan({ text: p.nextAction });
    }

    const pct = projectProgress(p);
    if (pct !== null) {
        const bar = card.createDiv({ cls: 'pbar' });
        bar.createEl('i').style.cssText = `width:${pct}%;background:${STATUS_COLOR[p.status]};`;
    }

    const serveLinks = ctx.store.linksFrom(p.id).filter(l => l.type === 'serves');
    if (serveLinks.length) {
        const refs = card.createDiv({ cls: 'prefs' });
        refs.createSpan({ cls: 'rl', text: t('ws serves') });
        serveLinks.forEach(l => {
            const m = ctx.store.getNode(l.to);
            if (!m) return;
            const chip = refs.createSpan({ cls: 'refchip', text: m.title });
            chip.onclick = (e) => { e.stopPropagation(); ctx.open({ kind: 'moc', id: m.id }); };
        });
    }
}

function renderMocCard(grid: HTMLElement, ctx: RenderCtx, m: WSMocNode): void {
    const card = grid.createDiv({ cls: 'moccard reveal' });
    // 卡片空白区 → 详情/关联面板;名字 → 跳思维树图谱
    card.onclick = () => ctx.openDeck(m);

    const members = ctx.store.servedBy(m.id);
    card.toggleClass('empty-moc', members.length === 0);

    const top = card.createDiv({ cls: 'mtop' });
    glyph(top, 'moc');
    const name = top.createSpan({ cls: 'mname link', text: m.title });
    name.setAttribute('title', t('ws open graph'));
    name.onclick = (e) => { e.stopPropagation(); ctx.open({ kind: 'moc', id: m.id }); };
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

function renderNoteCard(grid: HTMLElement, ctx: RenderCtx, n: WorkspaceNode): void {
    const card = grid.createDiv({ cls: 'notecard reveal' });
    // 卡片空白区 → 详情面板;名字 → 打开节点
    card.onclick = () => ctx.openDeck(n);
    glyph(card, n.type);
    const nn = card.createSpan({ cls: 'nn link', text: n.title });
    nn.onclick = (e) => { e.stopPropagation(); ctx.open(ctx.store.targetFor(n)); };
}
