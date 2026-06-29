import { App, Component, MarkdownRenderer, Menu, Notice, TFile, setIcon } from "obsidian";
import { WSMocNode, WSProjectNode, WSNoteNode, WorkspaceNode } from "src/types/workspace";
import { nextStatus } from "src/workspace/WorkspaceStore";
import { MdTask, prependTask, toggleTask, removeTask, insertSubtask, setTaskNote, removeTaskNote, setTaskText, taskMetaSuffix, parseTaskText, buildTaskText, moveTask, processFile, addTaskRefs, removeTaskRef, decodeNoteNewlines } from "src/workspace/projectTasks";
import { FilePickerModal } from "src/modal/filePickerModal";
import { t } from "src/lang/helper";
import { TaskModal } from "./modals";
import { RenderCtx, relTime, glyph, statusLabel, STATUS_COLOR, renderCrumb, progressFor, nextActionText, renderTaskText } from "./render";

/** 居中空态卡:图标 + 标题 + 提示,返回按钮容器供调用方填动作按钮 */
function emptyState(parent: HTMLElement, icon: string, title: string, hint: string): HTMLElement {
    const box = parent.createDiv({ cls: 'ck-empty' });
    setIcon(box.createDiv({ cls: 'ic' }), icon);
    box.createDiv({ cls: 'et', text: title });
    if (hint) box.createDiv({ cls: 'eh', text: hint });
    return box.createDiv({ cls: 'ebtns' });
}

/** 页头右上角溢出菜单按钮:删除该条目(走 ctx.requestDelete 二次确认) */
function heroMenuBtn(titleRow: HTMLElement, ctx: RenderCtx, node: WorkspaceNode): void {
    const btn = titleRow.createDiv({ cls: 'ck-heromenu' });
    setIcon(btn, 'more-horizontal');
    btn.setAttribute('title', t('ws delete'));
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem(i => { (i as { setWarning?(warning: boolean): void }).setWarning?.(true); i.setTitle(t('ws delete')).setIcon('trash-2')
            .onClick(() => ctx.requestDelete(node)); });
        menu.showAtMouseEvent(e);
    };
}

/** 操作按钮(.createbtn),带 lucide 图标 + 文案 */
function actionBtn(parent: HTMLElement, icon: string, label: string, cta: boolean, onClick: () => void): void {
    const btn = parent.createDiv({ cls: 'createbtn' + (cta ? ' cta' : '') });
    setIcon(btn.createSpan(), icon);
    btn.createSpan({ text: label });
    btn.onclick = onClick;
}

/** 任务行右侧的 lucide 线性图标按钮(.aicon),替代旧的 emoji 文本 */
function aicon(parent: HTMLElement, icon: string, title: string, extraCls = ''): HTMLElement {
    const el = parent.createSpan({ cls: 'aicon' + (extraCls ? ' ' + extraCls : '') });
    setIcon(el, icon);
    el.setAttribute('title', title);
    return el;
}

/** 多选 vault 笔记批量关联到此 MOC(就地建节点 + partOf/childMoc 链)*/
function pickMocAssoc(ctx: RenderCtx, moc: WSMocNode): void {
    const mounted = ctx.store.containerChildren(moc.id)
        .map(c => (c as { filePath?: string }).filePath)
        .filter((p): p is string => !!p);
    new FilePickerModal(ctx.app, moc.title, mounted, (paths) => { void (async () => {
        await ctx.store.mountFilesToContainer(moc.id, paths);
        ctx.refresh();
    })(); }).open();
}

function pickProjectRefs(ctx: RenderCtx, p: WSProjectNode): void {
    const mounted = ctx.store.linksFrom(p.id)
        .filter(l => l.type === 'related')
        .map(l => ctx.store.getNode(l.to))
        .map(n => (n as { filePath?: string } | undefined)?.filePath)
        .filter((path): path is string => !!path);
    new FilePickerModal(ctx.app, p.title, mounted, (paths) => { void (async () => {
        await ctx.store.addProjectFileReferences(p.id, paths);
        ctx.refresh();
    })(); }).open();
}

function renderProjectRefs(body: HTMLElement, ctx: RenderCtx, p: WSProjectNode): void {
    const links = ctx.store.linksFrom(p.id).filter(l => l.type === 'related');
    const sec = body.createDiv({ cls: 'dsec row project-refs-head' });
    sec.appendText(t('ws project refs'));
    const add = sec.createSpan({ cls: 'dsec-add', text: '+ ' + t('ws project refs add') });
    add.onclick = () => pickProjectRefs(ctx, p);

    if (!links.length) {
        body.createDiv({ cls: 'empty project-refs-empty', text: t('ws project refs empty') });
        return;
    }

    const refs = body.createDiv({ cls: 'project-refs' });
    links.forEach(l => {
        const node = ctx.store.getNode(l.to);
        if (!node || (node.type !== 'note' && node.type !== 'moc' && node.type !== 'map')) return;
        const chip = refs.createSpan({ cls: 'project-ref' });
        setIcon(chip.createSpan({ cls: 'project-ref-ic' }), node.type === 'moc' ? 'git-branch' : node.type === 'map' ? 'git-fork' : 'file-text');
        chip.createSpan({ cls: 'project-ref-title', text: node.title });
        chip.setAttribute('title', (node as { filePath?: string }).filePath || node.title);
        chip.onclick = () => ctx.open(ctx.store.targetFor(node));
        const rm = chip.createSpan({ cls: 'project-ref-remove' });
        setIcon(rm, 'x');
        rm.setAttribute('title', t('ws assoc remove'));
        rm.onclick = async (e) => {
            e.stopPropagation();
            await ctx.store.removeRelation(p.id, node.id, 'related');
            ctx.refresh();
        };
    });
}

/** 项目页:可点状态机 + 进度 + next action(markdown `- [ ]`) */
export function renderProjectPage(container: HTMLElement, ctx: RenderCtx, p: WSProjectNode): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    renderCrumb(h, ctx, p);
    const titleRow = h.createDiv({ cls: 'ck-titlerow' });
    const bigic = titleRow.createDiv({ cls: 'ck-bigic space' });
    glyph(bigic, 'project', STATUS_COLOR[p.status]);
    const col = titleRow.createDiv();
    col.createEl('h1', { cls: 'ck-h1', text: p.title });
    heroMenuBtn(titleRow, ctx, p);
    const tagRow = col.createDiv({ cls: 'ck-tagrow' });
    const stat = tagRow.createSpan({ cls: `pstat ${p.status} click` });
    stat.createSpan({ cls: `sd ${p.status}` });
    stat.appendText(statusLabel(p.status));
    stat.setAttribute('title', t('ws switch status title'));
    stat.onclick = async () => { await ctx.store.setProjectStatus(p.id, nextStatus(p.status)); };
    const pct = progressFor(ctx, p);
    if (pct !== null) { tagRow.createSpan({ cls: 'dotsep', text: '·' }); tagRow.createSpan({ cls: 'stat', text: `${t('ws progress')} ${pct}%` }); }
    tagRow.createSpan({ cls: 'dotsep', text: '·' });
    tagRow.createSpan({ cls: 'stat', text: t('ws update prefix').replace('{t}', relTime(p.updatedAt)) });

    const body = ck.createDiv({ cls: 'ck-body' });

    // 下一步:进度条 + 新增 + 任务列表(进度/新增在最上面)
    renderActions(body, ctx, p);
    renderProjectRefs(body, ctx, p);

    if (p.checklist?.length) {
        body.createDiv({ cls: 'dsec', text: t('ws checklist') });
        p.checklist.forEach(item => {
            const row = body.createDiv();
            row.setCssStyles({
                display: 'flex',
                alignItems: 'center',
                gap: '9px',
                padding: '6px 2px',
                cursor: 'pointer',
            });
            const box = row.createEl('input', { type: 'checkbox' });
            box.checked = item.done;
            box.onclick = async (e) => { e.stopPropagation(); await ctx.store.toggleChecklistItem(p.id, item.id); };
            const lbl = row.createSpan({ text: item.text });
            lbl.setCssStyles({
                fontSize: '13.5px',
                color: item.done ? 'var(--ink-faint)' : 'var(--ink)',
                textDecoration: item.done ? 'line-through' : '',
            });
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

/**
 * NEXT ACTION:渲染项目背书笔记里的 `- [ ]` 任务(唯一事实源)。
 * 勾选/删除/新增都直接读改写 markdown,追踪交给 Tasks/Dataview 等插件。
 */
function renderActions(body: HTMLElement, ctx: RenderCtx, p: WSProjectNode): void {
    const abs = p.filePath ? ctx.app.vault.getAbstractFileByPath(p.filePath) : null;
    const file: TFile | null = abs instanceof TFile ? abs : null;
    const tasks = file ? ctx.tasks.get(p.filePath) : null;
    const hideDone = readLS(ctx.app, LS_HIDE_DONE) === '1';
    const sortMode = (readLS(ctx.app, LS_SORT) as SortMode) || 'doc';

    // ── 标题行:排序下拉 + 隐藏已完成开关 ──
    const sec = body.createDiv({ cls: 'dsec row' });
    sec.appendText(t('ws next action'));
    if (tasks && tasks.length) {
        const ctls = sec.createDiv({ cls: 'dsec-ctls' });
        const sortSel = ctls.createEl('select', { cls: 'asort' });
        sortSel.setAttribute('title', t('ws sort by'));
        ([['doc', t('ws sort doc')], ['due', t('ws sort due')], ['start', t('ws sort start')]] as [SortMode, string][])
            .forEach(([v, l]) => { const o = sortSel.createEl('option', { value: v, text: l }); if (v === sortMode) o.selected = true; });
        sortSel.onchange = () => { try { ctx.app.saveLocalStorage(LS_SORT, sortSel.value); } catch {} ctx.refresh(); };
        const toggle = ctls.createSpan({ cls: 'dsec-add' + (hideDone ? ' on' : ''), text: t(hideDone ? 'ws action show done' : 'ws action hide done') });
        toggle.onclick = () => { try { ctx.app.saveLocalStorage(LS_HIDE_DONE, hideDone ? '0' : '1'); } catch {} ctx.refresh(); };
    }

    // ── 新增任务(弹框)+ 打开笔记(置顶)──
    const add = body.createDiv({ cls: 'action-add' });
    const addBtn = add.createSpan({ cls: 'achip cta', text: '+ ' + t('ws action add') });
    addBtn.onclick = () => openTaskModal(ctx, p, file, { mode: 'new' });
    if (file instanceof TFile) {
        const open = add.createSpan({ cls: 'achip' });
        setIcon(open.createSpan({ cls: 'achip-ic' }), 'file-text');
        open.createSpan({ text: t('ws action open note') });
        open.onclick = (e) => ctx.openFile(file, e.ctrlKey || e.metaKey);
    }

    // ── 任务列表(排序 → 隐藏已完成过滤)──
    const wrap = body.createDiv({ cls: 'actions project-actions' });
    if (file instanceof TFile) {
        if (tasks && tasks.length) {
            const sorted = sortMode === 'doc' ? tasks : sortTasks(tasks, sortMode);
            const keep = hideDone ? keepWithUndoneSubtree(sorted) : null;
            const show = keep ? sorted.filter(tk => keep.has(tk)) : sorted;
            if (show.length) show.forEach(tk => renderTaskRow(wrap, ctx, p, file, tk, sortMode === 'doc'));
            else wrap.createDiv({ cls: 'empty', text: t('ws action all done') });
        } else wrap.createDiv({ cls: 'empty', text: t('ws action empty') });
    } else {
        wrap.createDiv({ cls: 'empty', text: t('ws action no file') });
    }
}

type SortMode = 'doc' | 'due' | 'start';
/** NEXT ACTION 的 UI 偏好(全局,跨项目/重载留存) */
const LS_HIDE_DONE = 'zkw.task.hideDone';
const LS_SORT = 'zkw.task.sort';
function readLS(app: App, k: string): string | null { try { return app.loadLocalStorage(k) as string | null; } catch { return null; } }
/** 当前正在拖动的任务(仅默认顺序下启用,跨行共享) */
let draggedTask: MdTask | null = null;

/**
 * 弹框驱动的新建/子任务/编辑。落盘:
 * - new:appendTask(prefix + suffix)  - subtask:insertSubtask  - edit:setTaskText(buildTaskText,保留 ➕/⏳/🔁 等未编辑字段)
 */
function openTaskModal(ctx: RenderCtx, p: WSProjectNode, file: TFile | null,
    opts: { mode: 'new' | 'subtask' | 'edit'; parent?: MdTask; task?: MdTask }): void {
    let initial = { description: '', priority: '', start: '', due: '' };
    if (opts.mode === 'edit' && opts.task) {
        const parsed = parseTaskText(opts.task.text);
        initial = {
            description: stripPrefix(parsed.description, ctx.taskPrefix),
            priority: parsed.priority,
            start: parsed.start ?? '',
            due: parsed.due ?? '',
        };
    }
    const header = t(opts.mode === 'edit' ? 'ws task modal edit' : opts.mode === 'subtask' ? 'ws task modal subtask' : 'ws task modal new');
    new TaskModal(ctx.app, {
        header,
        submitLabel: t(opts.mode === 'edit' ? 'ws save' : 'ws create'),
        initial,
        onSubmit: (r) => { void (async () => {
            try {
                const f = file instanceof TFile ? file : await ctx.store.ensureProjectFile(p.id, ctx.projectFolderPath);
                if (!(f instanceof TFile)) { new Notice(t('ws action add failed')); return; }
                if (opts.mode === 'edit' && opts.task) {
                    const parsed = parseTaskText(opts.task.text);
                    parsed.description = `${ctx.taskPrefix}${r.description}`;
                    parsed.priority = r.priority;
                    parsed.start = r.start || undefined;
                    parsed.due = r.due || undefined;
                    const newText = buildTaskText(parsed);
                    await writeTasks(ctx, f, c => setTaskText(c, opts.task!.raw, newText));
                } else {
                    const suffix = taskMetaSuffix({ priority: r.priority, created: todayLocal(), start: r.start, due: r.due });
                    if (opts.mode === 'subtask' && opts.parent) {
                        await writeTasks(ctx, f, c => insertSubtask(c, opts.parent!, r.description, ctx.taskPrefix, suffix));
                    } else {
                        // 新任务置顶
                        await writeTasks(ctx, f, c => prependTask(c, r.description, ctx.taskPrefix, suffix));
                    }
                }
            } catch (e) {
                console.error('[zk-navigation] 保存任务失败', e);
                new Notice(t('ws action add failed') + ': ' + ((e as Error)?.message ?? e));
            }
        })(); },
    }).open();
}

/** 描述开头若是当前前缀(忽略两端空白),剥掉它——编辑框只展示纯描述,落盘时再补回前缀 */
function stripPrefix(desc: string, prefix: string): string {
    const p = prefix.trim();
    if (p && desc.startsWith(p)) return desc.slice(p.length).trimStart();
    return desc;
}

/** 按 截止/开始 日期排序,保持父子层级(只在同级内排,子树整体跟随父节点) */
function sortTasks(tasks: MdTask[], mode: SortMode): MdTask[] {
    interface N { task: MdTask; children: N[]; }
    const roots: N[] = []; const stack: N[] = [];
    for (const task of tasks) {
        const node: N = { task, children: [] };
        while (stack.length && stack[stack.length - 1].task.depth >= task.depth) stack.pop();
        (stack.length ? stack[stack.length - 1].children : roots).push(node);
        stack.push(node);
    }
    const key = (tk: MdTask): string => {
        const parsed = parseTaskText(tk.text);
        return (mode === 'due' ? parsed.due : parsed.start) || '';
    };
    const sortRec = (ns: N[]) => {
        ns.sort((a, b) => {
            const ka = key(a.task), kb = key(b.task);
            if (ka && kb) return ka < kb ? -1 : ka > kb ? 1 : 0;
            return ka ? -1 : kb ? 1 : 0; // 有日期的在前,无日期的排末尾(同值/同空保持文档序)
        });
        ns.forEach(n => sortRec(n.children));
    };
    sortRec(roots);
    const out: MdTask[] = [];
    const flat = (ns: N[]) => ns.forEach(n => { out.push(n.task); flat(n.children); });
    flat(roots);
    return out;
}

/** 返回应保留的任务集合:自身或其子树内存在未完成任务即保留(隐藏纯已完成分支,不留孤儿) */
function keepWithUndoneSubtree(tasks: MdTask[]): Set<MdTask> {
    const keep = new Set<MdTask>();
    for (let i = 0; i < tasks.length; i++) {
        let j = i + 1;
        while (j < tasks.length && tasks[j].depth > tasks[i].depth) j++;
        for (let k = i; k < j; k++) {
            if (!tasks[k].checked) { keep.add(tasks[i]); break; }
        }
    }
    return keep;
}

/** 写盘 → 用新内容同步刷新缓存 → 重渲染。零空窗(不经 invalidate 的异步重读),消除删除/勾选时的闪烁 */
async function writeTasks(ctx: RenderCtx, file: TFile, fn: (c: string) => string): Promise<void> {
    const next = await processFile(ctx.app, file, fn);
    ctx.tasks.setFromContent(file.path, next);
    ctx.refresh();
}

/** 本地时区今天 `YYYY-MM-DD`(避开 toISOString 的 UTC 偏移) */
function todayLocal(): string {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

/** base(YYYY-MM-DD)往后推 days 天,返回同格式字符串 */
function addDaysLocal(base: string, days: number): string {
    const [y, m, d] = base.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${dt.getFullYear()}-${mm}-${dd}`;
}

// 首页任务时间窗:今日 / 近7天 / 近30天 / 所有,持久化于 localStorage
type HomeRange = 'today' | '7d' | '30d' | 'all';
const HOME_RANGE_DAYS: Record<Exclude<HomeRange, 'all'>, number> = { today: 0, '7d': 7, '30d': 30 };
const LS_HOME_RANGE = 'zkw.home.range';

function loadHomeRange(ctx: RenderCtx): HomeRange {
    try {
        const v = ctx.app.loadLocalStorage(LS_HOME_RANGE) as string | null;
        if (v === 'today' || v === '7d' || v === '30d' || v === 'all') return v;
    } catch {}
    return 'today';
}
function saveHomeRange(ctx: RenderCtx, r: HomeRange): void {
    try { ctx.app.saveLocalStorage(LS_HOME_RANGE, r); } catch {}
}

/**
 * 在 afterEl 之后挂一个临时行内输入框,Enter 提交 / Esc / 失焦取消。
 * multiline=true 时改用自适应高度的 textarea:Enter 提交、Shift+Enter 换行(用于多行备注)。
 */
function mountInlineInput(
    afterEl: HTMLElement, indentPx: number, placeholder: string,
    initial: string, onCommit: (v: string) => void | Promise<void>,
    multiline = false,
): void {
    const box = createDiv({ cls: 'action-inline' });
    if (indentPx) box.setCssStyles({ marginLeft: `${indentPx}px` });
    const input = multiline
        ? box.createEl('textarea', { cls: 'atext atext-multi' })
        : box.createEl('input', { type: 'text', cls: 'atext' });
    input.placeholder = placeholder;
    input.value = initial;
    afterEl.insertAdjacentElement('afterend', box);
    const autosize = () => {
        if (multiline) {
            input.setCssStyles({ height: 'auto' });
            input.setCssStyles({ height: `${input.scrollHeight}px` });
        }
    };
    input.focus();
    autosize();
    let committed = false;
    const commit = () => {
        if (committed) return;
        committed = true;
        const v = input.value.trim();
        box.remove();
        if (v) void onCommit(v);
    };
    const cancel = () => { committed = true; box.remove(); };
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    if (multiline) input.oninput = autosize;
    input.onblur = () => commit();
}

function linkTextForFile(file: TFile): string {
    return file.extension === 'md' ? file.path.replace(/\.md$/i, '') : file.path;
}

function resolveTaskRef(ctx: RenderCtx, source: TFile, ref: string): TFile | null {
    const direct = ctx.app.vault.getAbstractFileByPath(ref);
    if (direct instanceof TFile) return direct;
    const withMd = ctx.app.vault.getAbstractFileByPath(ref.endsWith('.md') ? ref : `${ref}.md`);
    if (withMd instanceof TFile) return withMd;
    return ctx.app.metadataCache.getFirstLinkpathDest(ref, source.path);
}

function taskRefMountedPaths(ctx: RenderCtx, source: TFile, tk: MdTask): string[] {
    return (tk.refs ?? [])
        .map(ref => resolveTaskRef(ctx, source, ref)?.path)
        .filter((p): p is string => !!p);
}

function pickActionRefs(ctx: RenderCtx, p: WSProjectNode, file: TFile, tk: MdTask): void {
    new FilePickerModal(ctx.app, p.title, taskRefMountedPaths(ctx, file, tk), (paths) => { void (async () => {
        const refs = paths.map(path => {
            const picked = ctx.app.vault.getAbstractFileByPath(path);
            return picked instanceof TFile ? linkTextForFile(picked) : path;
        });
        await writeTasks(ctx, file, c => addTaskRefs(c, tk, refs));
    })(); }).open();
}

function renderTaskRefs(main: HTMLElement, ctx: RenderCtx, file: TFile, tk: MdTask): void {
    if (!tk.refs?.length) return;
    const refs = main.createDiv({ cls: 'arefs' });
    tk.refs.forEach(ref => {
        const chip = refs.createSpan({ cls: 'aref' });
        const target = resolveTaskRef(ctx, file, ref);
        setIcon(chip.createSpan({ cls: 'aref-ic' }), target ? 'file-text' : 'link');
        chip.createSpan({ cls: 'aref-label', text: target?.basename ?? ref.split('/').pop() ?? ref });
        chip.setAttribute('title', target?.path ?? ref);
        chip.onclick = (e) => {
            e.stopPropagation();
            ctx.openLink(ref, file.path, e.ctrlKey || e.metaKey);
        };
        const rm = chip.createSpan({ cls: 'aref-remove' });
        setIcon(rm, 'x');
        rm.setAttribute('title', t('ws action refs remove'));
        rm.onclick = async (e) => {
            e.stopPropagation();
            await writeTasks(ctx, file, c => removeTaskRef(c, tk, ref));
        };
    });
}

function renderTaskRow(wrap: HTMLElement, ctx: RenderCtx, p: WSProjectNode, file: TFile, tk: MdTask, draggable: boolean): void {
    const row = wrap.createDiv({ cls: 'action' + (tk.checked ? ' done' : '') });
    const indentPx = tk.depth * 22;
    if (indentPx) row.setCssStyles({ marginLeft: `${indentPx}px` });

    // 拖动手柄(仅默认顺序):按下手柄才激活 draggable,避免误触选区/勾选
    if (draggable) {
        const handle = row.createSpan({ cls: 'adrag', text: '⠿' });
        handle.setAttribute('title', t('ws action drag'));
        handle.onmousedown = () => row.setAttribute('draggable', 'true');
        handle.onmouseup = () => row.removeAttribute('draggable');
        row.addEventListener('dragstart', (e) => {
            draggedTask = tk;
            row.addClass('dragging');
            e.dataTransfer?.setData('text/plain', tk.raw);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
            draggedTask = null;
            row.removeClass('dragging');
            row.removeAttribute('draggable');
            wrap.findAll('.action').forEach(el => el.removeClasses(['drop-before', 'drop-after']));
        });
        row.addEventListener('dragover', (e) => {
            if (!draggedTask || draggedTask === tk) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            const r = row.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            row.toggleClass('drop-after', after);
            row.toggleClass('drop-before', !after);
        });
        row.addEventListener('dragleave', () => row.removeClasses(['drop-before', 'drop-after']));
        row.addEventListener('drop', (e) => { void (async () => {
            e.preventDefault();
            const moving = draggedTask;
            const after = row.hasClass('drop-after');
            row.removeClasses(['drop-before', 'drop-after']);
            if (!moving || moving === tk) return;
            await writeTasks(ctx, file, c => moveTask(c, moving, tk, after ? 'after' : 'before'));
        })(); });
    }

    const box = row.createEl('input', { type: 'checkbox' });
    box.checked = tk.checked;
    box.onclick = async (e) => {
        e.stopPropagation();
        await writeTasks(ctx, file, c => toggleTask(c, tk.raw, todayLocal()));
    };

    const main = row.createDiv({ cls: 'amain' });
    const txt = main.createDiv({ cls: 'atext-view' });
    renderTaskText(txt, ctx, tk.text);
    renderTaskRefs(main, ctx, file, tk);
    if (tk.note !== undefined) {
        const noteEl = main.createDiv({ cls: 'anote' });
        noteEl.createSpan({ cls: 'anote-mark', text: '—' });
        renderTaskText(noteEl.createSpan({ cls: 'anote-text' }), ctx, decodeNoteNewlines(tk.note));
        noteEl.setAttribute('title', t('ws action note'));
        noteEl.onclick = () => mountInlineInput(row, indentPx, t('ws action note placeholder'), decodeNoteNewlines(tk.note ?? ''), (v) =>
            writeTasks(ctx, file, c => setTaskNote(c, tk, v)), true);
    }

    const ctl = row.createDiv({ cls: 'actl' });

    // 未完成任务:编辑(复用 addtask 弹框)
    if (!tk.checked) {
        aicon(ctl, 'pencil', t('ws action edit')).onclick = () => openTaskModal(ctx, p, file, { mode: 'edit', task: tk });
    }

    // 新建子任务(复用 addtask 弹框)
    aicon(ctl, 'corner-down-right', t('ws action subtask')).onclick = () => openTaskModal(ctx, p, file, { mode: 'subtask', parent: tk });

    const hasRef = !!tk.refs?.length;
    const refs = aicon(ctl, 'link', t('ws action refs add'), hasRef ? 'hasref' : '');
    if (hasRef) { refs.empty(); refs.setText(String(tk.refs!.length)); }
    refs.onclick = () => pickActionRefs(ctx, p, file, tk);

    if (tk.note === undefined) {
        aicon(ctl, 'sticky-note', t('ws action note')).onclick = () => mountInlineInput(row, indentPx, t('ws action note placeholder'), '', (v) =>
            writeTasks(ctx, file, c => setTaskNote(c, tk, v)), true);
    } else {
        aicon(ctl, 'trash-2', t('ws action note delete'), 'del').onclick = async () => {
            await writeTasks(ctx, file, c => removeTaskNote(c, tk));
        };
    }

    aicon(ctl, 'x', t('ws action delete'), 'del').onclick = async () => {
        await writeTasks(ctx, file, c => removeTask(c, tk));
    };
}

/** MOC 概览页:Hero + 操作条 + 子主题 + 聚合成员;全空时给居中空态 */
export function renderMocPage(container: HTMLElement, ctx: RenderCtx, m: WSMocNode): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    renderCrumb(h, ctx, m);
    const titleRow = h.createDiv({ cls: 'ck-titlerow' });
    const bigic = titleRow.createDiv({ cls: 'ck-bigic space' });
    glyph(bigic, 'moc');
    const col = titleRow.createDiv();
    col.createEl('h1', { cls: 'ck-h1', text: m.title });
    heroMenuBtn(titleRow, ctx, m);

    const members = ctx.store.servedBy(m.id);
    const subMocs = ctx.store.containerChildren(m.id).filter(n => n.type === 'moc');
    const abs = m.filePath ? ctx.app.vault.getAbstractFileByPath(m.filePath) : null;
    const file: TFile | null = abs instanceof TFile ? abs : null;

    const tagRow = col.createDiv({ cls: 'ck-tagrow' });
    tagRow.createSpan({ cls: 'stat', text: t('ws agg nodes').replace('{n}', String(members.length)) });
    if (subMocs.length) {
        tagRow.createSpan({ cls: 'dotsep', text: '·' });
        tagRow.createSpan({ cls: 'stat', text: `${subMocs.length} ${t('ws subtopics')}` });
    }
    if (m.description) h.createDiv({ cls: 'ck-desc', text: m.description });

    const body = ck.createDiv({ cls: 'ck-body' });

    // 完全空(无子主题 + 无聚合成员)→ 居中空态,自带主行动
    if (!subMocs.length && !members.length) {
        const btns = emptyState(body, 'git-branch', t('ws moc empty title'), t('ws moc empty hint'));
        if (file) actionBtn(btns, 'git-fork', t('ws open graph'), true, () => ctx.open({ kind: 'moc', id: m.id }));
        actionBtn(btns, 'link', t('ws assoc node'), !file, () => pickMocAssoc(ctx, m));
        return;
    }

    // 操作条:打开图谱 + 关联节点
    const bar = ck.createDiv({ cls: 'createbar' });
    if (file) actionBtn(bar, 'git-fork', t('ws open graph'), true, () => ctx.open({ kind: 'moc', id: m.id }));
    actionBtn(bar, 'link', t('ws assoc node'), false, () => pickMocAssoc(ctx, m));

    // 子主题
    if (subMocs.length) {
        body.createDiv({ cls: 'dsec', text: t('ws subtopics') });
        const grid = body.createDiv({ cls: 'notegrid' });
        subMocs.forEach(n => {
            const card = grid.createDiv({ cls: 'notecard' });
            card.onclick = () => ctx.open(ctx.store.targetFor(n));
            glyph(card, n.type);
            card.createSpan({ cls: 'nn', text: n.title });
        });
    }

    // 聚合成员
    body.createDiv({ cls: 'dsec', text: t('ws moc members') });
    if (!members.length) {
        body.createDiv({ cls: 'empty', text: t('ws no members') });
    } else {
        const grid = body.createDiv({ cls: 'notegrid' });
        members.forEach(n => {
            const card = grid.createDiv({ cls: 'notecard' });
            card.onclick = () => ctx.open(ctx.store.targetFor(n));
            glyph(card, n.type);
            card.createSpan({ cls: 'nn', text: n.title });
            if (n.type === 'project') card.createSpan({ cls: 'nmeta', text: statusLabel((n as WSProjectNode).status) });
        });
    }
}

/** 笔记页 */
export function renderNotePage(container: HTMLElement, ctx: RenderCtx, n: WSNoteNode, owner: Component): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    renderCrumb(h, ctx, n);
    const titleRow = h.createDiv({ cls: 'ck-titlerow' });
    const bigic = titleRow.createDiv({ cls: 'ck-bigic space' });
    glyph(bigic, n.type);
    titleRow.createDiv().createEl('h1', { cls: 'ck-h1', text: n.title });
    heroMenuBtn(titleRow, ctx, n);

    const partLinks = ctx.store.linksFrom(n.id).filter(l => l.type === 'partOf');
    if (partLinks.length) {
        const chips = h.createDiv({ cls: 'dchips' });
        chips.setCssStyles({ marginTop: '12px' });
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
    const file = n.filePath ? ctx.app.vault.getAbstractFileByPath(n.filePath) : null;
    if (file instanceof TFile) {
        // 操作条:在 Obsidian 打开真身
        const bar = ck.createDiv({ cls: 'createbar' });
        actionBtn(bar, 'external-link', t('ws open file'), false, () => ctx.openFile(file));
        // 正文预览(内嵌渲染真实 markdown,与右侧 deck 一致)
        body.createDiv({ cls: 'dsec', text: t('ws body') });
        const prose = body.createDiv({ cls: 'prose ws-noteprose' });
        void ctx.app.vault.cachedRead(file).then(md => {
            if (!md.trim()) { prose.empty(); prose.createDiv({ cls: 'empty', text: t('ws empty note') }); return; }
            void MarkdownRenderer.render(ctx.app, md, prose, file.path, owner);
        });
    } else if (n.body) {
        body.createDiv({ cls: 'dsec', text: t('ws body') });
        void MarkdownRenderer.render(ctx.app, n.body, body.createDiv({ cls: 'prose ws-noteprose' }), '', owner);
    } else {
        emptyState(body, 'file-text', t('ws empty note'), '');
    }
}

/** Home / 今日:跨 Space nextAction 待办,阻塞置顶 */
export function renderHome(container: HTMLElement, ctx: RenderCtx, lastTarget: WorkspaceNode | null): void {
    const ck = container.createDiv({ cls: 'ck' });
    const h = ck.createDiv({ cls: 'ck-hero' });
    h.createDiv({ cls: 'ck-crumb', text: t('ws Workspace') });
    h.createDiv({ cls: 'ck-titlerow' }).createDiv().createEl('h1', { cls: 'ck-h1', text: t('ws Task') });

    const body = ck.createDiv({ cls: 'ck-body' });

    // 今天 / 逾期:跨项目背书笔记里 未完成 且 截止 ≤ 今天 的任务
    renderTodayDue(body, ctx);

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
    if (!projects.length) { emptyState(body, 'target', t('ws no active'), t('ws no active hint')); return; }
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
        const na = nextActionText(ctx, p);
        if (na) {
            const next = card.createDiv({ cls: 'pnext' });
            next.createSpan({ cls: 'na', text: 'NEXT' });
            renderTaskText(next.createSpan(), ctx, na);
        }
    });
}

/** 今天 / 逾期:跨项目 未完成 且(截止 ≤ 今天 或 今天落在 [开始, 截止] 区间内)的任务,逾期标红;勾选直接回写背书笔记 */
function renderTodayDue(body: HTMLElement, ctx: RenderCtx): void {
    const today = todayLocal();
    const range = loadHomeRange(ctx);
    // 'all' 无上界;其余以 今天+N天 为截止上界
    const horizon = range === 'all' ? null : addDaysLocal(today, HOME_RANGE_DAYS[range]);
    interface DueItem { project: WSProjectNode; task: MdTask; label: string; overdue: boolean; sortKey: string; }
    const items: DueItem[] = [];
    ctx.store.getAllNodes()
        .filter((n): n is WSProjectNode => n.type === 'project' && n.status !== 'archived')
        .forEach(pr => {
            if (!pr.filePath) return;
            const tks = ctx.tasks.get(pr.filePath);
            if (!tks) return;
            for (const tk of tks) {
                if (tk.checked) continue;
                const parsed = parseTaskText(tk.text);
                const start = (parsed.start ?? '').slice(0, 10);
                const due = (parsed.due ?? '').slice(0, 10);
                if (range !== 'all') {
                    const dueWithin = !!due && due <= horizon!;                         // 截止落在时间窗内(含逾期)
                    const inInterval = !!start && start <= today && (!due || today <= due); // 已开始且未过截止
                    if (!dueWithin && !inInterval) continue;
                }
                const overdue = !!due && due < today;
                const label = overdue ? '⚠ ' + due : due ? '📅 ' + due : start ? '🛫 ' + start : '';
                items.push({ project: pr, task: tk, label, overdue, sortKey: due || start || '￿' });
            }
        });
    items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

    const head = body.createDiv({ cls: 'dsec row' });
    head.createSpan({ text: t('ws today due') });
    const seg = head.createDiv({ cls: 'rangeseg' });
    ([['today', 'ws range today'], ['7d', 'ws range 7d'], ['30d', 'ws range 30d'], ['all', 'ws range all']] as const)
        .forEach(([val, key]) => {
            const b = seg.createSpan({ cls: 'rseg' + (val === range ? ' on' : ''), text: t(key) });
            b.onclick = () => { if (val !== range) { saveHomeRange(ctx, val); ctx.refresh(); } };
        });
    if (!items.length) { body.createDiv({ cls: 'empty', text: t('ws today due empty') }); return; }
    const list = body.createDiv({ cls: 'actions' });
    items.forEach(it => {
        const tk = it.task;
        const projFile = () => { const f = ctx.app.vault.getAbstractFileByPath(it.project.filePath!); return f instanceof TFile ? f : null; };
        const row = list.createDiv({ cls: 'action' });
        const box = row.createEl('input', { type: 'checkbox' });
        box.onclick = async (e) => {
            e.stopPropagation();
            const f = projFile(); if (!f) return;
            await writeTasks(ctx, f, c => toggleTask(c, tk.raw, today));
        };
        const main = row.createDiv({ cls: 'amain' });
        renderTaskText(main.createDiv({ cls: 'atext-view' }), ctx, tk.text);
        const meta = main.createDiv({ cls: 'anote' });
        if (it.label) {
            meta.createSpan({ cls: 'adue' + (it.overdue ? ' overdue' : '') }).setText(it.label);
            meta.createSpan({ cls: 'anote-mark', text: '·' });
        }
        meta.createSpan({ text: it.project.title });
        if (tk.note !== undefined) {
            const noteEl = main.createDiv({ cls: 'anote' });
            noteEl.createSpan({ cls: 'anote-mark', text: '—' });
            renderTaskText(noteEl.createSpan({ cls: 'anote-text' }), ctx, decodeNoteNewlines(tk.note));
            noteEl.setAttribute('title', t('ws action note'));
            noteEl.onclick = (e) => {
                e.stopPropagation();
                const f = projFile(); if (!f) return;
                mountInlineInput(row, 0, t('ws action note placeholder'), decodeNoteNewlines(tk.note ?? ''), (v) =>
                    writeTasks(ctx, f, c => setTaskNote(c, tk, v)), true);
            };
        }

        const ctl = row.createDiv({ cls: 'actl' });
        // 编辑(复用项目页 addtask 弹框);首页任务均未完成,始终可编辑
        aicon(ctl, 'pencil', t('ws action edit')).onclick = (e) => {
            e.stopPropagation();
            const f = projFile(); if (!f) return;
            openTaskModal(ctx, it.project, f, { mode: 'edit', task: tk });
        };
        if (tk.note === undefined) {
            aicon(ctl, 'sticky-note', t('ws action note')).onclick = (e) => {
                e.stopPropagation();
                const f = projFile(); if (!f) return;
                mountInlineInput(row, 0, t('ws action note placeholder'), '', (v) =>
                    writeTasks(ctx, f, c => setTaskNote(c, tk, v)), true);
            };
        } else {
            aicon(ctl, 'trash-2', t('ws action note delete'), 'del').onclick = async (e) => {
                e.stopPropagation();
                const f = projFile(); if (!f) return;
                await writeTasks(ctx, f, c => removeTaskNote(c, tk));
            };
        }

        row.onclick = () => ctx.open({ kind: 'project', id: it.project.id });
    });
}
