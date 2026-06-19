import { App, TFile } from "obsidian";

/**
 * 项目 next action 以 markdown `- [ ]` 任务行为唯一事实源(写在项目背书笔记里)。
 * 追踪交给 Tasks/Dataview 等插件——本模块只认勾选态,行内日期/优先级/标签/链接原样透传。
 *
 * 父子任务用缩进层级表达(`1111` 的子任务 `1111-1` 缩进一级);
 * 任务备注用缩进一级的 `--- 内容` 行挂在任务下方。
 */

export interface MdTask {
    checked: boolean;
    text: string;       // checkbox 之后的剩余原文(可能含 📅/⏫/#tag/[[link]] 及前缀字符)
    raw: string;        // 整行原文(用于精确回写)
    indent: string;     // 行首缩进空白(用于派生子任务/备注缩进)
    depth: number;      // 嵌套层级(0 为顶层),按缩进栈推导
    note?: string;      // 任务备注正文(--- 之后的内容),无则缺省
    noteRaw?: string;   // 备注整行原文(用于改写/删除)
}

/** 派生子任务/备注时使用的一级缩进 */
const INDENT_UNIT = '    ';
/** 任务行:`- [ ] ...` / `* [x] ...`,允许前导缩进 */
const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\]\s?(.*)$/;
/** 缩进的备注行:`    --- 内容`(要求有前导空白,避开 frontmatter/正文分隔线) */
const NOTE_RE = /^(\s+)---\s?(.*)$/;
/** 行内首个 checkbox 方括号(bullet 一定在更前,故首个匹配即任务框) */
const BOX_RE = /\[([ xX])\]/;

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
        // 备注行归属最近一个任务(且尚未有备注时取首条)
        const nm = NOTE_RE.exec(line);
        if (nm && lastTask && lastTask.note === undefined) {
            lastTask.note = nm[2];
            lastTask.noteRaw = line;
        }
    }
    return out;
}

/** 翻转整行的勾选态(不动其余内容) */
function flipLine(line: string): string {
    return line.replace(BOX_RE, (s) => (s === '[ ]' ? '[x]' : '[ ]'));
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
 * - 日期为 `YYYY-MM-DD`(可带 ` HH:mm`),空值跳过
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

const DATE = '(\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2})?)';
const FIELD_RE = {
    created: new RegExp(`➕\\s*${DATE}`),
    start: new RegExp(`🛫\\s*${DATE}`),
    scheduled: new RegExp(`(?:⏳|⌛)\\s*${DATE}`),
    due: new RegExp(`(?:📅|📆|🗓)\\s*${DATE}`),
    cancelled: new RegExp(`❌\\s*${DATE}`),
    done: new RegExp(`✅\\s*${DATE}`),
    recurrence: /🔁\s*([^🔺⏫🔼🔽⏬➕🛫⏳📅❌✅]+)/,
};

export function parseTaskText(text: string): ParsedTask {
    const get = (re: RegExp) => { const m = re.exec(text); return m ? m[1].trim() : undefined; };
    const prio = /[🔺⏫🔼🔽⏬]/.exec(text);
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
    d = d.replace(/🔁\s*[^🔺⏫🔼🔽⏬➕🛫⏳📅❌✅]+/g, '')
         .replace(/[🔺⏫🔼🔽⏬]/g, '')
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

/** 设置/更新任务备注:已有则改写备注行,否则在任务行下方插入 `--- 内容`(缩进一级) */
export function setTaskNote(content: string, task: MdTask, note: string): string {
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const noteLine = `${task.indent}${INDENT_UNIT}--- ${note}`;
    if (task.noteRaw) {
        const ni = lineIndexOf(lines, task.noteRaw);
        if (ni >= 0) { lines[ni] = noteLine; return lines.join(eol); }
    }
    const idx = lineIndexOf(lines, task.raw);
    if (idx < 0) return content;
    lines.splice(idx + 1, 0, noteLine);
    return lines.join(eol);
}

/** 删除任务备注行 */
export function removeTaskNote(content: string, task: MdTask): string {
    if (!task.noteRaw) return content;
    const eol = eolOf(content);
    const lines = content.split(/\r?\n/);
    const ni = lineIndexOf(lines, task.noteRaw);
    if (ni < 0) return content;
    lines.splice(ni, 1);
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
