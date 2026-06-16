import { MarkdownRenderer, Component, TFile } from "obsidian";
import { WSMocNode, WSProjectNode, WSNoteNode, WorkspaceNode, ProjectAction } from "src/types/workspace";
import { projectProgress, nextStatus, actionPct, nextActionStatus, actionLocked } from "src/workspace/WorkspaceStore";
import { t } from "src/lang/helper";
import { RenderCtx, relTime, glyph, statusLabel, STATUS_COLOR } from "./render";
import { pickVaultFile } from "./notePicker";

/** vault 路径 → 显示名(去目录、去 .md) */
function pathTitle(path: string): string {
    const base = path.split('/').pop() || path;
    return base.replace(/\.md$/i, '');
}

const ACTION_COLOR: Record<ProjectAction['status'], string> = {
    todo: 'var(--ink-faint)', doing: 'var(--amber)', done: 'var(--green)',
};
function actionStatusLabel(s: ProjectAction['status']): string { return t(`ws action status ${s}` as any); }

/** 项目页:可点状态机 + checklist 自动进度 + nextAction 就地编辑 */
export function renderProjectPage(container: HTMLElement, ctx: RenderCtx, p: WSProjectNode): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    const space = ctx.store.getNode(p.spaceId);
    h.createDiv({ cls: 'ck-crumb', text: `${space?.title || ''} › ${p.title}` });
    const titleRow = h.createDiv({ cls: 'ck-titlerow' });
    const bigic = titleRow.createDiv({ cls: 'ck-bigic space' });
    glyph(bigic, 'project', STATUS_COLOR[p.status]);
    const col = titleRow.createDiv();
    col.createEl('h1', { cls: 'ck-h1', text: p.title });
    const tagRow = col.createDiv({ cls: 'ck-tagrow' });
    const stat = tagRow.createSpan({ cls: `pstat ${p.status} click` });
    stat.createSpan({ cls: `sd ${p.status}` });
    stat.appendText(statusLabel(p.status));
    stat.setAttribute('title', t('ws switch status title'));
    stat.onclick = async () => { await ctx.store.setProjectStatus(p.id, nextStatus(p.status)); };
    const pct = projectProgress(p);
    if (pct !== null) { tagRow.createSpan({ cls: 'dotsep', text: '·' }); tagRow.createSpan({ cls: 'stat', text: `${t('ws progress')} ${pct}%` }); }
    tagRow.createSpan({ cls: 'dotsep', text: '·' });
    tagRow.createSpan({ cls: 'stat', text: t('ws update prefix').replace('{t}', relTime(p.updatedAt)) });

    const body = ck.createDiv({ cls: 'ck-body' });

    // 下一步:可关联笔记 / 记完成比例与状态 / 排序 / 依赖前序 的动作列表
    renderActions(body, ctx, p);

    // 进度(手动可拖动调节;有 checklist 时手动值覆盖自动推导)
    body.createDiv({ cls: 'dsec', text: t('ws progress manual') });
    const pc = body.createDiv({ cls: 'progctl' });
    const cur = projectProgress(p) ?? 0;
    const bar = pc.createDiv({ cls: 'pbar big' });
    const fill = bar.createEl('i');
    const setFill = (v: number) => { fill.style.cssText = `width:${v}%;background:${STATUS_COLOR[p.status]};`; };
    setFill(cur);
    const row = pc.createDiv({ cls: 'progrow' });
    const range = row.createEl('input', { type: 'range', cls: 'progslider' });
    range.min = '0'; range.max = '100'; range.step = '5'; range.value = String(cur);
    const val = row.createSpan({ cls: 'progval', text: `${cur}%` });
    range.oninput = () => { const v = Number(range.value); setFill(v); val.setText(`${v}%`); };
    range.onchange = () => { ctx.store.setProgress(p.id, Number(range.value)); };
    if (p.checklist?.length) {
        const hint = row.createSpan({ cls: 'proghint' });
        if (typeof p.progress === 'number') {
            const reset = hint.createSpan({ cls: 'reset', text: t('ws progress reset') });
            reset.onclick = () => { ctx.store.setProgress(p.id, null); };
        } else hint.setText(t('ws progress auto hint'));
    }

    if (p.checklist?.length) {
        body.createDiv({ cls: 'dsec', text: t('ws checklist') });
        p.checklist.forEach(item => {
            const row = body.createDiv();
            row.style.cssText = 'display:flex;align-items:center;gap:9px;padding:6px 2px;cursor:pointer;';
            const box = row.createEl('input', { type: 'checkbox' });
            box.checked = item.done;
            box.onclick = async (e) => { e.stopPropagation(); await ctx.store.toggleChecklistItem(p.id, item.id); };
            const lbl = row.createSpan({ text: item.text });
            lbl.style.cssText = `font-size:13.5px;color:${item.done ? 'var(--ink-faint)' : 'var(--ink)'};${item.done ? 'text-decoration:line-through;' : ''}`;
            row.onclick = async () => { await ctx.store.toggleChecklistItem(p.id, item.id); };
        });
    }

    const serveLinks = ctx.store.linksFrom(p.id).filter(l => l.type === 'serves');
    if (serveLinks.length) {
        body.createDiv({ cls: 'dsec', text: t('ws serves areas') });
        const chips = body.createDiv({ cls: 'dchips' });
        serveLinks.forEach(l => {
            const m = ctx.store.getNode(l.to);
            if (!m) return;
            const chip = chips.createSpan({ cls: 'dchip' });
            chip.createSpan({ cls: 'a', text: '◎' });
            chip.appendText(m.title);
            chip.onclick = () => ctx.open({ kind: 'moc', id: m.id });
        });
    }
}

/** NEXT ACTION 动作列表:关联笔记 / 完成比例+状态 / 排序 / 依赖前序 */
function renderActions(body: HTMLElement, ctx: RenderCtx, p: WSProjectNode): void {
    body.createDiv({ cls: 'dsec', text: t('ws next action') });

    const actions = p.actions || [];
    const wrap = body.createDiv({ cls: 'actions' });
    if (!actions.length) wrap.createDiv({ cls: 'empty', text: t('ws action empty') });
    actions.forEach((a, i) => renderActionRow(wrap, ctx, p, a, i, actions));

    const add = body.createDiv({ cls: 'action-add' });
    const ai = add.createEl('input', { type: 'text', cls: 'atext' });
    ai.placeholder = t('ws action text placeholder');
    // 旧单行 nextAction 作为预填,用户一键即可加成首个动作(不自动落库,避免影响进度推导)
    if (!actions.length && p.nextAction) ai.value = p.nextAction;
    const addText = () => {
        const v = ai.value.trim();
        if (!v) return;
        ctx.store.addAction(p.id, { text: v });
        ai.value = '';
        if (p.nextAction) ctx.store.setNextAction(p.id, '');
    };
    ai.onkeydown = (e) => { if (e.key === 'Enter') addText(); };
    const addBtn = add.createSpan({ cls: 'achip cta', text: '+ ' + t('ws action add') });
    addBtn.onclick = addText;
    const linkBtn = add.createSpan({ cls: 'achip', text: '🔗 ' + t('ws action link note') });
    linkBtn.onclick = () => pickVaultFile(ctx.app, (f) => ctx.store.addAction(p.id, { notePath: f.path }));
}

function renderActionRow(wrap: HTMLElement, ctx: RenderCtx, p: WSProjectNode, a: ProjectAction, i: number, actions: ProjectAction[]): void {
    const locked = actionLocked(actions, i);
    const row = wrap.createDiv({ cls: 'action' + (a.status === 'done' ? ' done' : '') + (locked ? ' locked' : '') });

    row.createSpan({ cls: 'aord', text: String(i + 1) });

    const dot = row.createSpan({ cls: `astat ${a.status}` });
    dot.setAttribute('title', actionStatusLabel(a.status));
    dot.onclick = () => { if (!locked) ctx.store.updateAction(p.id, a.id, { status: nextActionStatus(a.status) }); };

    const main = row.createDiv({ cls: 'amain' });
    const head = main.createDiv({ cls: 'ahead' });
    if (a.notePath || a.noteId) {
        const link = head.createSpan({ cls: 'alink' });
        if (a.notePath) {
            // 关联整库任意 markdown 笔记:点击在 Obsidian 打开
            glyph(link, 'note');
            link.appendText(pathTitle(a.notePath));
            link.onclick = () => ctx.app.workspace.openLinkText(a.notePath!, '');
        } else {
            const note = ctx.store.getNode(a.noteId!);
            glyph(link, (note?.type as any) || 'note');
            link.appendText(note ? note.title : (a.text || t('ws node gone')));
            if (note) link.onclick = () => ctx.open(ctx.store.targetFor(note));
        }
        const unlink = head.createSpan({ cls: 'aunlink', text: '✕' });
        unlink.setAttribute('title', t('ws action unlink'));
        unlink.onclick = () => ctx.store.updateAction(p.id, a.id, { notePath: undefined, noteId: undefined });
    } else {
        const input = head.createEl('input', { type: 'text', cls: 'atext' });
        input.value = a.text;
        input.placeholder = t('ws action text placeholder');
        input.onblur = () => { if (input.value.trim() !== a.text) ctx.store.updateAction(p.id, a.id, { text: input.value.trim() }); };
        input.onkeydown = (e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); };
        const lk = head.createSpan({ cls: 'alinkbtn', text: '🔗' });
        lk.setAttribute('title', t('ws action link note'));
        lk.onclick = () => pickVaultFile(ctx.app, (f) => ctx.store.updateAction(p.id, a.id, { notePath: f.path }));
    }

    if (locked) main.createDiv({ cls: 'alocked', text: '🔒 ' + t('ws action locked') });

    // 完成比例滑块(已完成或锁定时只读)
    const prog = main.createDiv({ cls: 'aprog' });
    const pct = actionPct(a);
    const bar = prog.createDiv({ cls: 'pbar' });
    const fill = bar.createEl('i');
    const paint = (v: number) => { fill.style.cssText = `width:${v}%;background:${ACTION_COLOR[a.status]};`; };
    paint(pct);
    const range = prog.createEl('input', { type: 'range', cls: 'progslider sm' });
    range.min = '0'; range.max = '100'; range.step = '5'; range.value = String(pct);
    range.disabled = a.status === 'done' || locked;
    const val = prog.createSpan({ cls: 'progval sm', text: `${pct}%` });
    range.oninput = () => { const v = Number(range.value); paint(v); val.setText(`${v}%`); };
    range.onchange = () => {
        const v = Number(range.value);
        const status: ProjectAction['status'] = v >= 100 ? 'done' : v > 0 ? 'doing' : 'todo';
        ctx.store.updateAction(p.id, a.id, { progress: v, status });
    };

    const ctl = row.createDiv({ cls: 'actl' });
    if (i > 0) {
        const dep = ctl.createSpan({ cls: 'adep' + (a.dependsOnPrev ? ' on' : ''), text: t('ws action dep') });
        dep.setAttribute('title', t('ws action dep title'));
        dep.onclick = () => ctx.store.updateAction(p.id, a.id, { dependsOnPrev: !a.dependsOnPrev });
    }
    const up = ctl.createSpan({ cls: 'aicon' + (i === 0 ? ' off' : ''), text: '↑' });
    up.setAttribute('title', t('ws action up'));
    up.onclick = () => { if (i > 0) ctx.store.moveAction(p.id, a.id, -1); };
    const down = ctl.createSpan({ cls: 'aicon' + (i === actions.length - 1 ? ' off' : ''), text: '↓' });
    down.setAttribute('title', t('ws action down'));
    down.onclick = () => { if (i < actions.length - 1) ctx.store.moveAction(p.id, a.id, 1); };
    const del = ctl.createSpan({ cls: 'aicon del', text: '✕' });
    del.setAttribute('title', t('ws action delete'));
    del.onclick = () => ctx.store.removeAction(p.id, a.id);
}

/** MOC 概览页:Hero + servedBy 卡片 */
export function renderMocPage(container: HTMLElement, ctx: RenderCtx, m: WSMocNode): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    const space = ctx.store.getNode(m.spaceId);
    h.createDiv({ cls: 'ck-crumb', text: `${space?.title || ''} › ${m.title}` });
    const titleRow = h.createDiv({ cls: 'ck-titlerow' });
    const bigic = titleRow.createDiv({ cls: 'ck-bigic space' });
    glyph(bigic, 'moc');
    const col = titleRow.createDiv();
    col.createEl('h1', { cls: 'ck-h1', text: m.title });
    const members = ctx.store.servedBy(m.id);
    const tagRow = col.createDiv({ cls: 'ck-tagrow' });
    tagRow.createSpan({ cls: 'stat', text: t('ws agg nodes').replace('{n}', String(members.length)) });
    if (m.description) h.createDiv({ cls: 'ck-desc', text: m.description });

    const body = ck.createDiv({ cls: 'ck-body' });
    body.createDiv({ cls: 'dsec', text: t('ws moc members') });
    if (!members.length) { body.createDiv({ cls: 'empty', text: t('ws no members') }); return; }
    const grid = body.createDiv({ cls: 'notegrid' });
    members.forEach(n => {
        const card = grid.createDiv({ cls: 'notecard' });
        card.onclick = () => ctx.open(ctx.store.targetFor(n));
        glyph(card, n.type);
        card.createSpan({ cls: 'nn', text: n.title });
        if (n.type === 'project') card.createSpan({ cls: 'nmeta', text: statusLabel((n as WSProjectNode).status) });
    });
}

/** 笔记页 */
export function renderNotePage(container: HTMLElement, ctx: RenderCtx, n: WSNoteNode, owner: Component): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    const space = ctx.store.getNode(n.spaceId);
    h.createDiv({ cls: 'ck-crumb', text: `${space?.title || ''} › ${n.title}` });
    const titleRow = h.createDiv({ cls: 'ck-titlerow' });
    const bigic = titleRow.createDiv({ cls: 'ck-bigic space' });
    glyph(bigic, n.type);
    titleRow.createDiv().createEl('h1', { cls: 'ck-h1', text: n.title });

    const partLinks = ctx.store.linksFrom(n.id).filter(l => l.type === 'partOf');
    if (partLinks.length) {
        const chips = h.createDiv({ cls: 'dchips' });
        chips.style.marginTop = '12px';
        partLinks.forEach(l => {
            const m = ctx.store.getNode(l.to);
            if (!m) return;
            const chip = chips.createSpan({ cls: 'dchip' });
            chip.createSpan({ cls: 'a', text: '◎' });
            chip.appendText(m.title);
            chip.onclick = () => ctx.open({ kind: 'moc', id: m.id });
        });
    }

    const body = ck.createDiv({ cls: 'ck-body' });
    const prose = body.createDiv({ cls: 'prose' });
    const file = n.filePath ? ctx.app.vault.getAbstractFileByPath(n.filePath) : null;
    if (file instanceof TFile) {
        ctx.app.vault.cachedRead(file).then(md => MarkdownRenderer.render(ctx.app, md, prose, n.filePath || '', owner));
    } else if (n.body) {
        MarkdownRenderer.render(ctx.app, n.body, prose, '', owner);
    } else {
        prose.createEl('p', { cls: 'muted', text: t('ws empty note') });
    }
}

/** Home / 今日:跨 Space nextAction 待办,阻塞置顶 */
export function renderHome(container: HTMLElement, ctx: RenderCtx, lastTarget: WorkspaceNode | null): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    h.createDiv({ cls: 'ck-crumb', text: t('ws Today') });
    h.createDiv({ cls: 'ck-titlerow' }).createDiv().createEl('h1', { cls: 'ck-h1', text: t('ws Today') });

    const body = ck.createDiv({ cls: 'ck-body' });

    if (lastTarget) {
        body.createDiv({ cls: 'dsec', text: t('ws continue last') });
        const card = body.createDiv({ cls: 'notecard' });
        card.onclick = () => ctx.open(ctx.store.targetFor(lastTarget));
        glyph(card, lastTarget.type);
        card.createSpan({ cls: 'nn', text: lastTarget.title });
    }

    const projects = ctx.store.getAllNodes()
        .filter((n): n is WSProjectNode => n.type === 'project' && (n.status === 'active' || n.status === 'blocked'))
        .sort((a, b) => (a.status === 'blocked' ? 0 : 1) - (b.status === 'blocked' ? 0 : 1) || b.updatedAt - a.updatedAt);

    body.createDiv({ cls: 'dsec', text: t('ws cross todo') });
    if (!projects.length) { body.createDiv({ cls: 'empty', text: t('ws no active') }); return; }
    const grid = body.createDiv({ cls: 'pgrid' });
    projects.forEach(p => {
        const space = ctx.store.getNode(p.spaceId);
        const card = grid.createDiv({ cls: 'pcard' });
        card.onclick = () => ctx.open({ kind: 'project', id: p.id });
        const top = card.createDiv({ cls: 'ptop' });
        const stat = top.createSpan({ cls: `pstat ${p.status}` });
        stat.createSpan({ cls: `sd ${p.status}` });
        stat.appendText(statusLabel(p.status));
        top.createSpan({ cls: 'plast', text: `${space?.title || ''} · ${relTime(p.updatedAt)}` });
        card.createDiv({ cls: 'pname', text: p.title });
        if (p.nextAction) {
            const next = card.createDiv({ cls: 'pnext' });
            next.createSpan({ cls: 'na', text: 'NEXT' });
            next.createSpan({ text: p.nextAction });
        }
    });
}
