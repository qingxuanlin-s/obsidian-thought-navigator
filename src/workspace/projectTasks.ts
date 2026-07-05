import { App, TFile } from "obsidian";

/**
 * 项目 next action 以 markdown `- [ ]` 任务行为唯一事实源(写在项目背书笔记里)。
 * 追踪交给 Tasks/Dataview 等插件——本模块只认勾选态,行内日期/优先级/标签/链接原样透传。
 *
 * 父子任务用缩进层级表达(`1111` 的子任务 `1111-1` 缩进一级);
 * 任务备注用缩进一级的一条或多条 `--- 内容` 行挂在任务下方。
 * 任务引用资料用缩进一级的 `refs:: [[...]] [[...]]` 行挂在任务下方。
 */

export interface MdTaskNote {
    text: string;
    raw: string;
    createdAt?: string;
}

export interface MdTask {
    checked: boolean;
    text: string;       // checkbox 之后的剩余原文(可能含 📅/⏫/#tag/[[link]] 及前缀字符)
    raw: string;        // 整行原文(用于精确回写)
    indent: string;     // 行首缩进空白(用于派生子任务/备注缩进)
    depth: number;      // 嵌套层级(0 为顶层),按缩进栈推导
    notes?: MdTaskNote[]; // 任务备注列表
    note?: string;      // 首条任务备注正文(兼容旧调用),无则缺省
    noteRaw?: string;   // 首条备注整行原文(兼容旧调用)
    noteCreatedAt?: string; // 首条备注新增时间(兼容旧调用)
    refs?: string[];    // 任务引用资料的 wikilink linktext
    refsRaw?: string;   // refs:: 整行原文(用于改写/删除)
}

/** 派生子任务/备注时使用的一级缩进 */
const INDENT_UNIT = '    ';
/** 任务行:`- [ ] ...` / `* [x] ...`,允许前导缩进 */
const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\]\s?(.*)$/;
/** 缩进的备注行:`    --- 内容`(要求有前导空白,避开 frontmatter/正文分隔线) */
const NOTE_RE = /^(\s+)---\s?(.*)$/;
const NOTE_CREATED_RE = /\s*<!--\s*zkw-note-created:\s*([^>]+?)\s*-->\s*$/;
/** 缩进的引用资料行:`    refs:: [[A]] [[B]]` */
const REFS_RE = /^(\s+)refs::\s?(.*)$/i;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
/** 行内首个 checkbox 方括号(bullet 一定在更前,故首个匹配即任务框) */

/** 行首缩进的视觉宽度(tab 记 4,空格记 1) */
function indentWidth(line: string): number {
    let w = 0;
    for (const ch of line) {
        if (ch === '\t') w += 4;
        else if (ch === ' ') w += 1;
        else break;
    }
    return w;
}

/** 行首缩进空白串 */
function leadingWs(line: string): string {
    const m = /^\s*/.exec(line);
    return m ? m[0] : '';
}

/** 文件换行符(回写时保持) */
function eolOf(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function parseRefs(text: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(text)) !== null) {
        const ref = m[1].split('|')[0].trim();
        if (ref && !out.includes(ref)) out.push(ref);
    }
    return out;
}

function refsLine(indent: string, refs: string[]): string {
    return `${indent}${INDENT_UNIT}refs:: ${refs.map(r => `[[${r}]]`).join(' ')}`;
}

function splitNoteCreated(text: string): { note: string; createdAt?: string } {
    const m = NOTE_CREATED_RE.exec(text);
    if (!m) return { note: text };
    return { note: text.slice(0, m.index).trimEnd(), createdAt: m[1].trim() };
}

export function parseTaskLines(content: string): MdTask[] {
    const out: MdTask[] = [];
    const stack: { w: number; task: MdTask }[] = [];
    let lastTask: MdTask | null = null;
    for (const line of content.split(/\r?\n/)) {
        const tm = TASK_RE.exec(line);
        if (tm) {
            const indent = leadingWs(line);
            const w = indentWidth(line);
            while (stack.length && stack[stack.length - 1].w >= w) stack.pop();
            const task: MdTask = {
                checked: tm[2] !== ' ',
                text: tm[3],
                raw: line,
                indent,
                depth: stack.length,
            };
            stack.push({ w, task });
            out.push(task);
            lastTask = task;
            continue;
        }
        // 备注行归属最近一个任务,允许同一任务下多条备注
        const nm = NOTE_RE.exec(line);
        if (nm && lastTask) {
            const parsedNote = splitNoteCreated(nm[2]);
            const note: MdTaskNote = { text: parsedNote.note, raw: line, createdAt: parsedNote.createdAt };
            (lastTask.notes ??= []).push(note);
            if (lastTask.note === undefined) {
                lastTask.note = note.text;
                lastTask.noteRaw = note.raw;
                lastTask.noteCreatedAt = note.createdAt;
            }
            continue;
        }
        const rm = REFS_RE.exec(line);
        if (rm && lastTask && lastTask.refs === undefined) {
            lastTask.refs = parseRefs(rm[2]);
            lastTask.refsRaw = line;
        }
    }
    return out;
}


/** 把一行任务的正文换成 newText(保留 bullet 前缀与勾选态) */
function retextLine(line: string, newText: string): string {
    const m = TASK_RE.exec(line);
    if (!m) return line;
    return `${m[1]}[${m[2]}] ${newText}`;
}

/** 找到 task.raw 所在行号(整行精确匹配),失败返回 -1 */
function lineIndexOf(lines: string[], raw: string): number {
    return lines.indexOf(raw);
}

/** 自 task 行后扫描其整棵子树的结束行号(遇空行或缩进回退即止) */
function subtreeEnd(lines: string[], idx: number, parentWidth: number): number {
    let j = idx + 1;
    while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') break;
        if (indentWidth(l) <= parentWidth) break;
        j++;
    }
    return j;
}

// 下列纯函数按「整行匹配」做行级改写,保留文件其余换行/内容不变。

const DONE_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g;

/**
 * 翻转勾选态,并联动完成日期(Tasks `✅ YYYY-MM-DD`):
 * 勾选 → 追加 `✅ doneDate`;取消 → 移除既有 ✅ 日期。doneDate 缺省则只翻框。
 */
export function toggleTask(content: string, raw: string, doneDate?: string): string {
    return content.replace(raw, () => {
        const m = TASK_RE.exec(raw);
        if (!m) return raw;
        const willCheck = m[2] === ' ';
        let text = m[3].replace(DONE_RE, '').trimEnd();
        if (willCheck && doneDate) text += ` ✅ ${doneDate}`;
        return `${m[1]}[${willCheck ? 'x' : ' '}] ${text}`;
    });
}

export function setTaskText(content: string, raw: string, newText: string): string {
    return content.replace(raw, () => retextLine(raw, newText));
}

export function taskHasPrefix(text: string, prefix: string): boolean {
    const p = prefix.trim();
    return !p || text.trimStart().startsWith(p);
}

/** 切换任务正文开头的当前前缀:已有则移除,没有则添加 */
export function toggleTaskPrefix(content: string, raw: string, prefix: string): string {
    const p = prefix.trim();
    if (!p) return content;
    return content.replace(raw, () => {
        const m = TASK_RE.exec(raw);
        if (!m) return raw;
        const text = m[3];
        const leading = /^\s*/.exec(text)?.[0] ?? '';
        const rest = text.slice(leading.length);
        const nextText = rest.startsWith(p)
            ? rest.slice(p.length).trimStart()
            : `${prefix}${rest}`;
        return `${m[1]}[${m[2]}] ${nextText}`;
    });
}

/** 删除任务及其整棵子树(含备注行) */
export function removeTask(content: string, task: MdTask): string {
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const idx = lineIndexOf(lines, task.raw);
    if (idx < 0) return content;
    const end = subtreeEnd(lines, idx, indentWidth(task.raw));
    lines.splice(idx, end - idx);
    return lines.join(eol);
}

/**
 * 任务行尾的元数据段(Tasks 插件 emoji 格式,Gantt Calendar 据此解析)。
 * 顺序对齐 Tasks 规范:优先级 → ➕创建 → 🛫开始 → 📅截止。
 * - priority 传 emoji 本身(🔺最高/⏫高/🔼中/🔽低/⏬最低),空=普通无 emoji
 * - 日期为 `YYYY-MM-DD`(可带 ` HH:mm` 或 ` HH:mm:ss`),空值跳过
 */
export function taskMetaSuffix(opts: { priority?: string; created?: string; start?: string; due?: string }): string {
    let s = '';
    if (opts.priority) s += ` ${opts.priority}`;
    if (opts.created) s += ` ➕ ${opts.created}`;
    if (opts.start) s += ` 🛫 ${opts.start}`;
    if (opts.due) s += ` 📅 ${opts.due}`;
    return s;
}

/**
 * 解析任务正文(`[ ]` 之后的整段)为「描述 + 各元数据字段」。
 * 描述保留前缀字符(如 🎯)与所有非元数据文本;识别 Tasks emoji 字段供编辑回填。
 */
export interface ParsedTask {
    description: string;
    priority: string;        // 🔺/⏫/🔼/🔽/⏬ 之一,无则 ''
    created?: string; start?: string; scheduled?: string; due?: string;
    cancelled?: string; done?: string; recurrence?: string;
}

const DATE = '(\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2}(?::\\d{2})?)?|\\d{2}:\\d{2}(?::\\d{2})?)';
const FIELD_RE = {
    created: new RegExp(`➕\\s*${DATE}`),
    start: new RegExp(`🛫\\s*${DATE}`),
    scheduled: new RegExp(`(?:⏳|⌛)\\s*${DATE}`),
    due: new RegExp(`(?:📅|📆|🗓)\\s*${DATE}`),
    cancelled: new RegExp(`❌\\s*${DATE}`),
    done: new RegExp(`✅\\s*${DATE}`),
    recurrence: /🔁\s*([^🔺⏫🔼🔽⏬➕🛫⏳📅❌✅]+)/u,
};

export function parseTaskText(text: string): ParsedTask {
    const get = (re: RegExp) => { const m = re.exec(text); return m ? m[1].trim() : undefined; };
    const prio = /[🔺⏫🔼🔽⏬]/u.exec(text);
    const parsed: ParsedTask = {
        description: '',
        priority: prio ? prio[0] : '',
        created: get(FIELD_RE.created), start: get(FIELD_RE.start), scheduled: get(FIELD_RE.scheduled),
        due: get(FIELD_RE.due), cancelled: get(FIELD_RE.cancelled), done: get(FIELD_RE.done),
        recurrence: get(FIELD_RE.recurrence),
    };
    let d = text;
    for (const k of ['created', 'start', 'scheduled', 'due', 'cancelled', 'done'] as const)
        d = d.replace(new RegExp(FIELD_RE[k].source, 'g'), '');
    d = d.replace(/🔁\s*[^🔺⏫🔼🔽⏬➕🛫⏳📅❌✅]+/gu, '')
         .replace(/[🔺⏫🔼🔽⏬]/gu, '')
         .replace(/\s+/g, ' ').trim();
    parsed.description = d;
    return parsed;
}

/** 由 ParsedTask 重建任务正文,字段顺序对齐 Tasks 规范(描述→优先级→🔁→➕→🛫→⏳→📅→❌→✅) */
export function buildTaskText(p: ParsedTask): string {
    let s = p.description.trim();
    const add = (x?: string) => { if (x) s += ' ' + x; };
    add(p.priority || undefined);
    if (p.recurrence) add('🔁 ' + p.recurrence);
    if (p.created) add('➕ ' + p.created);
    if (p.start) add('🛫 ' + p.start);
    if (p.scheduled) add('⏳ ' + p.scheduled);
    if (p.due) add('📅 ' + p.due);
    if (p.cancelled) add('❌ ' + p.cancelled);
    if (p.done) add('✅ ' + p.done);
    return s;
}

/** 顶层追加一条任务(prefix 前缀如 "🎯 ";suffix 由 taskMetaSuffix() 生成,接在正文后) */
export function appendTask(content: string, text: string, prefix = '', suffix = ''): string {
    const line = `- [ ] ${prefix}${text}${suffix}`;
    if (content === '') return line + '\n';
    return content.replace(/\n*$/, '') + '\n' + line + '\n';
}

/** 顶层新增,但插在「第一条任务之前」(新任务置顶);无既有任务则等同 appendTask */
export function prependTask(content: string, text: string, prefix = '', suffix = ''): string {
    const line = `- [ ] ${prefix}${text}${suffix}`;
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const idx = lines.findIndex(l => TASK_RE.test(l));
    if (idx < 0) return appendTask(content, text, prefix, suffix);
    lines.splice(idx, 0, line);
    return lines.join(eol);
}

/** 在 parent 子树末尾插入一条子任务(缩进一级) */
export function insertSubtask(content: string, parent: MdTask, text: string, prefix = '', suffix = ''): string {
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const idx = lineIndexOf(lines, parent.raw);
    if (idx < 0) return content;
    const end = subtreeEnd(lines, idx, indentWidth(parent.raw));
    const childLine = `${parent.indent}${INDENT_UNIT}- [ ] ${prefix}${text}${suffix}`;
    lines.splice(end, 0, childLine);
    return lines.join(eol);
}

/** 把一段子树各行整体缩进 delta(空格宽度);空行原样保留。统一输出空格缩进(与 INDENT_UNIT 一致) */
function reindentBlock(block: string[], delta: number): string[] {
    if (delta === 0) return block.slice();
    return block.map(l => {
        if (l.trim() === '') return l;
        const w = Math.max(0, indentWidth(l) + delta);
        return ' '.repeat(w) + l.slice(leadingWs(l).length);
    });
}

/**
 * 把 task 的整棵子树(含子任务/备注)移动到 target 的前面或后面,并把子树根缩进对齐到 target
 * (即移动后成为 target 的同级)。拖入自身子树时安全放弃(target 落在被移动块内 → 找不到锚点)。
 */
export function moveTask(content: string, task: MdTask, target: MdTask, pos: 'before' | 'after'): string {
    if (task.raw === target.raw) return content;
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const from = lineIndexOf(lines, task.raw);
    if (from < 0) return content;
    const fromEnd = subtreeEnd(lines, from, indentWidth(task.raw));
    const block = reindentBlock(lines.slice(from, fromEnd), indentWidth(target.raw) - indentWidth(task.raw));
    lines.splice(from, fromEnd - from);
    let ti = lineIndexOf(lines, target.raw);
    if (ti < 0) return content; // target 在被移动子树内,放弃
    if (pos === 'after') ti = subtreeEnd(lines, ti, indentWidth(target.raw));
    lines.splice(ti, 0, ...block);
    return lines.join(eol);
}

/**
 * 把 task 的整棵子树移动到 target 子树末尾,并把 task 根缩进为 target 的直接子任务。
 * 若 target 位于 task 自身子树内,删除移动块后将找不到锚点,安全放弃。
 */
export function moveTaskInto(content: string, task: MdTask, target: MdTask): string {
    if (task.raw === target.raw) return content;
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const from = lineIndexOf(lines, task.raw);
    if (from < 0) return content;
    const fromEnd = subtreeEnd(lines, from, indentWidth(task.raw));
    const targetChildIndent = indentWidth(target.raw) + indentWidth(INDENT_UNIT);
    const block = reindentBlock(lines.slice(from, fromEnd), targetChildIndent - indentWidth(task.raw));
    lines.splice(from, fromEnd - from);
    const ti = lineIndexOf(lines, target.raw);
    if (ti < 0) return content;
    const insertAt = subtreeEnd(lines, ti, indentWidth(target.raw));
    lines.splice(insertAt, 0, ...block);
    return lines.join(eol);
}

/** 备注换行编解码:单行存储用字面量 `\n`,展示/编辑还原成真实换行 */
export function encodeNoteNewlines(s: string): string { return s.replace(/\r?\n/g, '\\n'); }
export function decodeNoteNewlines(s: string): string { return s.replace(/\\n/g, '\n'); }

function nowLocalDateTime(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function taskNoteLine(task: MdTask, note: string, createdAt: string): string {
    return `${task.indent}${INDENT_UNIT}--- ${encodeNoteNewlines(note)} <!-- zkw-note-created: ${createdAt} -->`;
}

/** 追加任务备注:插到现有备注最上方。换行以字面量 `\n` 存储 */
export function addTaskNote(content: string, task: MdTask, note: string): string {
    if (!note.trim()) return content;
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const noteLine = taskNoteLine(task, note, nowLocalDateTime());
    const idx = lineIndexOf(lines, task.raw);
    if (idx < 0) return content;
    const firstNoteIdx = firstTaskNoteIndex(lines, task);
    lines.splice(firstNoteIdx >= 0 ? firstNoteIdx : idx + 1, 0, noteLine);
    return lines.join(eol);
}

/** 设置/更新任务备注:保留旧 API。已有首条则改写首条,否则追加一条。 */
export function setTaskNote(content: string, task: MdTask, note: string): string {
    const firstNote = task.notes?.[0];
    if (firstNote) return updateTaskNote(content, task, firstNote, note);
    return addTaskNote(content, task, note);
}

/** 更新单条任务备注;清空则删除该条。 */
export function updateTaskNote(content: string, task: MdTask, target: MdTaskNote, note: string): string {
    if (!note.trim()) return removeTaskNote(content, task, target);
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const ni = lineIndexOf(lines, target.raw);
    if (ni < 0) return content;
    lines[ni] = taskNoteLine(task, note, target.createdAt ?? nowLocalDateTime());
    return lines.join(eol);
}

/** 删除任务备注行。传 target 删除单条;不传则删除该任务下全部备注。 */
export function removeTaskNote(content: string, task: MdTask, target?: MdTaskNote): string {
    const notes = target ? [target] : (task.notes ?? []);
    if (!notes.length) return content;
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    for (let i = notes.length - 1; i >= 0; i--) {
        const ni = lineIndexOf(lines, notes[i].raw);
        if (ni >= 0) lines.splice(ni, 1);
    }
    return lines.join(eol);
}

function lastTaskNoteIndex(lines: string[], task: MdTask): number {
    const notes = task.notes ?? [];
    for (let i = notes.length - 1; i >= 0; i--) {
        const ni = lineIndexOf(lines, notes[i].raw);
        if (ni >= 0) return ni;
    }
    return -1;
}

function firstTaskNoteIndex(lines: string[], task: MdTask): number {
    for (const note of task.notes ?? []) {
        const ni = lineIndexOf(lines, note.raw);
        if (ni >= 0) return ni;
    }
    return -1;
}

/** 设置/更新任务引用资料行;空数组会删除 refs 行 */
export function setTaskRefs(content: string, task: MdTask, refs: string[]): string {
    const clean = refs.map(r => r.trim()).filter(Boolean);
    const deduped = Array.from(new Set(clean));
    if (deduped.length === 0) return removeTaskRefs(content, task);
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const line = refsLine(task.indent, deduped);
    if (task.refsRaw) {
        const ri = lineIndexOf(lines, task.refsRaw);
        if (ri >= 0) { lines[ri] = line; return lines.join(eol); }
    }
    const idx = lineIndexOf(lines, task.raw);
    if (idx < 0) return content;
    const lastNoteIdx = lastTaskNoteIndex(lines, task);
    lines.splice(Math.max(idx + 1, lastNoteIdx + 1), 0, line);
    return lines.join(eol);
}

export function addTaskRefs(content: string, task: MdTask, refs: string[]): string {
    return setTaskRefs(content, task, [...(task.refs ?? []), ...refs]);
}

export function removeTaskRef(content: string, task: MdTask, ref: string): string {
    return setTaskRefs(content, task, (task.refs ?? []).filter(r => r !== ref));
}

export function removeTaskRefs(content: string, task: MdTask): string {
    if (!task.refsRaw) return content;
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const ri = lineIndexOf(lines, task.refsRaw);
    if (ri < 0) return content;
    lines.splice(ri, 1);
    return lines.join(eol);
}

/** 原子读改写一个文件,返回写入后的新内容(供调用方同步刷新缓存) */
export async function processFile(app: App, file: TFile, fn: (c: string) => string): Promise<string> {
    return await app.vault.process(file, fn);
}

/**
 * 项目任务缓存:按 filePath:mtime 缓存解析结果,渲染同步取用。
 * 缓存缺失/过期时后台读盘,完成后经 onChange(防抖)通知宿主重渲染。
 */
export class ProjectTaskStore {
    private cache = new Map<string, { mtime: number; tasks: MdTask[] }>();
    private stale = new Set<string>();
    private loading = new Set<string>();
    private notifyTimer: number | null = null;
    /** 后台加载完成后触发(宿主接成防抖重渲染) */
    onChange: (() => void) | null = null;

    constructor(private app: App) {}

    /** 同步取任务:新鲜命中直接返回;过期/脏标记则后台重读,期间仍返回旧值(stale-while-revalidate,避免空窗闪烁) */
    get(filePath: string | undefined): MdTask[] | null {
        if (!filePath) return null;
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return null;
        const c = this.cache.get(filePath);
        if (c && c.mtime === file.stat.mtime && !this.stale.has(filePath)) return c.tasks;
        void this.load(filePath, file);
        return c ? c.tasks : null;
    }

    counts(filePath: string | undefined): { done: number; total: number } | null {
        const tasks = this.get(filePath);
        if (!tasks) return null;
        return { done: tasks.filter(t => t.checked).length, total: tasks.length };
    }

    firstUnchecked(filePath: string | undefined): MdTask | null {
        const tasks = this.get(filePath);
        return tasks?.find(t => !t.checked) ?? null;
    }

    /** 标记缓存为脏:不删旧值,下次 get 后台重读但先返回旧值(避免空窗闪烁) */
    invalidate(filePath: string): void { this.stale.add(filePath); }

    /** 用刚写盘的新内容同步刷新缓存(自写路径零空窗:无需异步重读) */
    setFromContent(filePath: string, content: string): void {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        const mtime = file instanceof TFile ? file.stat.mtime : Date.now();
        this.cache.set(filePath, { mtime, tasks: parseTaskLines(content) });
        this.stale.delete(filePath);
    }

    /** 缓存是否已与磁盘一致(区分「自写已同步」与「外部编辑」,供宿主跳过自写的 modify 事件) */
    isCurrent(filePath: string): boolean {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return false;
        const c = this.cache.get(filePath);
        return !!c && c.mtime === file.stat.mtime && !this.stale.has(filePath);
    }

    private async load(filePath: string, file: TFile): Promise<void> {
        if (this.loading.has(filePath)) return;
        this.loading.add(filePath);
        try {
            const content = await this.app.vault.cachedRead(file);
            this.cache.set(filePath, { mtime: file.stat.mtime, tasks: parseTaskLines(content) });
            this.stale.delete(filePath);
            this.scheduleNotify();
        } catch (e) {
            console.warn('[zk-navigation] 读取项目任务失败:', filePath, e);
        } finally {
            this.loading.delete(filePath);
        }
    }

    private scheduleNotify(): void {
        if (this.notifyTimer != null) return;
        this.notifyTimer = window.setTimeout(() => {
            this.notifyTimer = null;
            this.onChange?.();
        }, 60);
    }

    dispose(): void {
        if (this.notifyTimer != null) { window.clearTimeout(this.notifyTimer); this.notifyTimer = null; }
        this.onChange = null;
        this.cache.clear();
    }
}
