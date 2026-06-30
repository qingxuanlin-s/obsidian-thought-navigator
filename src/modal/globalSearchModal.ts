import { App, MarkdownView, Notice, SearchMatches, SearchResult, SuggestModal, TFile, prepareFuzzySearch, renderMatches, setIcon } from "obsidian";
import { SearchEntry, SearchKind, MOCReverseIndex } from "src/utils/mocReverseIndex";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { MdTask, ProjectTaskStore } from "src/workspace/projectTasks";
import { OpenTarget, WorkspaceNode, WSNodeType, WSProjectNode, targetFor } from "src/types/workspace";
import { TKey, t } from "src/lang/helper";

type GlobalSearchKind = SearchKind | 'workspaceNode' | 'task';

export interface GlobalSearchEntry {
    kind: GlobalSearchKind;
    text: string;
    subtitle: string;
    mocFilePath?: string;
    mocFileName?: string;
    nodeId?: string;
    workspaceNodeId?: string;
    workspaceTarget?: OpenTarget;
    taskFilePath?: string;
    taskRaw?: string;
}

interface ScoredEntry {
    entry: GlobalSearchEntry;
    score: number;
    textMatches: SearchMatches | null;
    subtitleMatches: SearchMatches | null;
}

interface GlobalSearchModalDeps {
    reverseIndex: MOCReverseIndex | null;
    workspaceStore: WorkspaceStore | null;
    navigateToMOCNode: (mocFilePath: string, nodeId: string) => Promise<void>;
    openWorkspaceTarget: (target: OpenTarget) => Promise<void> | void;
    openTask: (filePath: string, taskRaw: string) => Promise<void>;
    /** 当前正在查看的 MOC，用于"当前 MOC 置顶"和作用域限定 */
    currentMoc?: { mocFilePath: string; mocFileName: string } | null;
    /** 打开时是否默认限定到当前 MOC */
    initialScoped?: boolean;
    /** 在当前已渲染的图里原地居中选中节点，返回是否成功；成功则不触发整图重渲 */
    locateNode?: (nodeId: string) => boolean;
}

/** 空查询时各类型的展示优先级：先给"容器/结构"再给散点，避免单个 MOC 的节点刷屏 */
const EMPTY_ORDER: Record<GlobalSearchKind, number> = {
    mocFile: 0,
    workspaceNode: 1,
    task: 2,
    fileNode: 3,
    conceptNode: 3,
    embedNode: 3,
    remark: 4,
};

const KIND_ICON: Record<GlobalSearchKind, string> = {
    fileNode: 'file-text',
    conceptNode: 'lightbulb',
    embedNode: 'box',
    mocFile: 'book-open',
    remark: 'message-square',
    workspaceNode: 'layout-grid',
    task: 'square-check-big',
};

const WORKSPACE_TYPE_KEY: Record<WSNodeType, TKey> = {
    space: 'gs type space',
    moc: 'gs type moc',
    project: 'gs type project',
    note: 'gs type note',
    map: 'gs type map',
};

function scoreValue(result: SearchResult | null, text: string, weight: number): number {
    if (!result || result.matches.length === 0) return 0;
    const first = result.matches[0];
    const start = first?.[0] ?? 0;
    const span = result.matches.reduce((sum, m) => sum + Math.max(0, m[1] - m[0]), 0);
    return weight + result.score + span * 10 + Math.max(0, 40 - start) + Math.max(0, 20 - Math.min(text.length, 20));
}

function taskLineIndex(content: string, raw: string): number {
    return content.split(/\r?\n/).findIndex(line => line === raw);
}

export class GlobalSearchModal extends SuggestModal<ScoredEntry> {
    private readonly taskStore: ProjectTaskStore;
    private readonly deps: GlobalSearchModalDeps;
    private scoped: boolean;
    private cachedEntries: GlobalSearchEntry[] | null = null;
    private scopeBarEl: HTMLElement | null = null;

    constructor(app: App, deps: GlobalSearchModalDeps) {
        super(app);
        this.deps = deps;
        this.scoped = Boolean(deps.initialScoped && deps.currentMoc);
        this.taskStore = new ProjectTaskStore(app);
        this.taskStore.onChange = () => {
            this.cachedEntries = null; // 任务异步加载完成后失效缓存
            this.inputEl.trigger("input");
        };
        this.applyPlaceholder();
        this.limit = 50;
    }

    onOpen(): void {
        super.onOpen();
        this.renderScopeBar();
    }

    onClose(): void {
        super.onClose();
        this.taskStore.dispose();
    }

    /** 当前生效的作用域 MOC（null = 全局） */
    private get activeScope(): { mocFilePath: string; mocFileName: string } | null {
        return this.scoped && this.deps.currentMoc ? this.deps.currentMoc : null;
    }

    private applyPlaceholder(): void {
        const scope = this.activeScope;
        this.setPlaceholder(scope
            ? t('gs search in').replace('{moc}', scope.mocFileName)
            : t('gs search everything'));
    }

    getSuggestions(query: string): ScoredEntry[] {
        const trimmed = query.trim();
        const scope = this.activeScope;
        let entries = this.collectEntries();
        if (scope) {
            entries = entries.filter(e => e.mocFilePath === scope.mocFilePath);
        }

        if (!trimmed) {
            // 作用域内：按自然顺序展示该 MOC 的节点；全局：按类型优先级展示"结构优先"，避免单个 MOC 刷屏
            const ordered = scope
                ? entries
                : entries.slice().sort((a, b) =>
                    (EMPTY_ORDER[a.kind] - EMPTY_ORDER[b.kind]) || a.text.localeCompare(b.text));
            return ordered.slice(0, 50).map(entry => ({
                entry,
                score: 0,
                textMatches: null,
                subtitleMatches: null,
            }));
        }

        const fuzzy = prepareFuzzySearch(trimmed);
        const currentPath = this.deps.currentMoc?.mocFilePath;
        return entries
            .map(entry => {
                const textMatches = fuzzy(entry.text);
                const subtitleMatches = entry.subtitle ? fuzzy(entry.subtitle) : null;
                if (!textMatches && !subtitleMatches) return null;
                let score = scoreValue(textMatches, entry.text, 1000) + scoreValue(subtitleMatches, entry.subtitle, 300);
                // 全局搜索时把当前 MOC 的命中置顶（作用域内全是当前 MOC，无需加权）
                if (!scope && currentPath && entry.mocFilePath === currentPath) score += 500;
                return {
                    entry,
                    score,
                    textMatches: textMatches?.matches ?? null,
                    subtitleMatches: subtitleMatches?.matches ?? null,
                };
            })
            .filter((item): item is ScoredEntry => item !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, 50);
    }

    /** 作用域 chip：限定态显示「📖 MOC ✕」可清除；全局态在已知当前 MOC 时显示「只搜当前 MOC」开关 */
    private renderScopeBar(): void {
        if (this.scopeBarEl) { this.scopeBarEl.remove(); this.scopeBarEl = null; }
        const current = this.deps.currentMoc;
        if (!current) return;

        const prompt = this.inputEl.closest<HTMLElement>(".prompt");
        if (!prompt) return;
        const bar = createDiv("zk-global-search-scopebar");

        if (this.scoped) {
            const chip = bar.createDiv("zk-gs-scope-chip zk-gs-scope-active");
            setIcon(chip.createSpan("zk-gs-scope-icon"), "book-open");
            chip.createSpan("zk-gs-scope-label").setText(current.mocFileName);
            const close = chip.createSpan("zk-gs-scope-close");
            setIcon(close, "x");
            chip.addEventListener("click", () => this.toggleScope(false));
        } else {
            const chip = bar.createDiv("zk-gs-scope-chip");
            setIcon(chip.createSpan("zk-gs-scope-icon"), "filter");
            chip.createSpan("zk-gs-scope-label").setText(t('gs scope only').replace('{moc}', current.mocFileName));
            chip.addEventListener("click", () => this.toggleScope(true));
        }

        prompt.insertBefore(bar, this.resultContainerEl);
        this.scopeBarEl = bar;
    }

    private toggleScope(scoped: boolean): void {
        this.scoped = scoped;
        this.applyPlaceholder();
        this.renderScopeBar();
        this.inputEl.trigger("input");
        this.inputEl.focus();
    }

    renderSuggestion(item: ScoredEntry, el: HTMLElement): void {
        const entry = item.entry;
        el.addClass("zk-global-search-item");

        const iconEl = el.createSpan("zk-global-search-icon");
        setIcon(iconEl, KIND_ICON[entry.kind]);

        const content = el.createDiv("zk-global-search-content");
        const titleEl = content.createDiv("zk-global-search-title");
        renderMatches(titleEl, entry.text, item.textMatches);

        const subEl = content.createDiv("zk-global-search-subtitle");
        renderMatches(subEl, entry.subtitle, item.subtitleMatches);
    }

    onChooseSuggestion(item: ScoredEntry): void {
        const entry = item.entry;
        void (async () => {
            if ((entry.kind === 'fileNode' || entry.kind === 'conceptNode' || entry.kind === 'embedNode' || entry.kind === 'remark') && entry.mocFilePath && entry.nodeId) {
                // 命中正在查看的 MOC：原地居中选中，不触发整图重渲（大图更顺）
                const current = this.deps.currentMoc?.mocFilePath;
                if (current && entry.mocFilePath === current && this.deps.locateNode?.(entry.nodeId)) {
                    return;
                }
                await this.deps.navigateToMOCNode(entry.mocFilePath, entry.nodeId);
                return;
            }
            if (entry.kind === 'mocFile' && entry.mocFilePath) {
                await this.deps.navigateToMOCNode(entry.mocFilePath, '');
                return;
            }
            if (entry.kind === 'workspaceNode' && entry.workspaceTarget) {
                await this.deps.openWorkspaceTarget(entry.workspaceTarget);
                return;
            }
            if (entry.kind === 'task' && entry.taskFilePath && entry.taskRaw) {
                await this.deps.openTask(entry.taskFilePath, entry.taskRaw);
            }
        })();
    }

    private collectEntries(): GlobalSearchEntry[] {
        if (this.cachedEntries) return this.cachedEntries;
        const entries: GlobalSearchEntry[] = [];

        if (this.deps.reverseIndex?.isInitialized) {
            for (const entry of this.deps.reverseIndex.getSearchEntries()) {
                entries.push(this.fromMOCEntry(entry));
            }
        }

        const store = this.deps.workspaceStore;
        if (store) {
            for (const node of store.getAllNodes()) {
                entries.push(this.fromWorkspaceNode(node, store));
                if (node.type === 'project') {
                    entries.push(...this.fromProjectTasks(node));
                }
            }
        }

        this.cachedEntries = entries;
        return entries;
    }

    private fromMOCEntry(entry: SearchEntry): GlobalSearchEntry {
        return {
            kind: entry.kind,
            text: entry.text,
            subtitle: entry.kind === 'mocFile' ? entry.mocFilePath : t('gs in moc').replace('{moc}', entry.mocFileName),
            mocFilePath: entry.mocFilePath,
            mocFileName: entry.mocFileName,
            nodeId: entry.nodeId,
        };
    }

    private fromWorkspaceNode(node: WorkspaceNode, store: WorkspaceStore): GlobalSearchEntry {
        const space = node.type === 'space' ? node : store.getNode(node.spaceId);
        const typeLabel = t(WORKSPACE_TYPE_KEY[node.type]);
        const subtitle = space && space.id !== node.id
            ? t('gs in space').replace('{type}', typeLabel).replace('{space}', space.title)
            : t('gs in workspace').replace('{type}', typeLabel);
        return {
            kind: 'workspaceNode',
            text: node.title,
            subtitle,
            workspaceNodeId: node.id,
            workspaceTarget: targetFor(node),
        };
    }

    private fromProjectTasks(project: WSProjectNode): GlobalSearchEntry[] {
        const tasks = this.taskStore.get(project.filePath);
        if (!tasks) return [];
        return tasks.map((task: MdTask) => ({
            kind: 'task',
            text: task.text,
            subtitle: t('gs task in').replace('{project}', project.title),
            workspaceNodeId: project.id,
            taskFilePath: project.filePath,
            taskRaw: task.raw,
        }));
    }
}

export async function openTaskAtLine(app: App, filePath: string, taskRaw: string): Promise<void> {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
        new Notice(t('gs file not found'));
        return;
    }

    const content = await app.vault.cachedRead(file);
    const line = taskLineIndex(content, taskRaw);
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });
    if (line < 0 || !(leaf.view instanceof MarkdownView)) return;
    leaf.view.editor.setCursor({ line, ch: 0 });
    leaf.view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
}
