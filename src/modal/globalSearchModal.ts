import { App, MarkdownView, Notice, SearchMatches, SearchResult, SuggestModal, TFile, prepareFuzzySearch, renderMatches, setIcon } from "obsidian";
import { SearchEntry, SearchKind, MOCReverseIndex } from "src/utils/mocReverseIndex";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { MdTask, ProjectTaskStore } from "src/workspace/projectTasks";
import { OpenTarget, WorkspaceNode, WSNodeType, WSProjectNode, targetFor } from "src/types/workspace";

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
}

const KIND_ICON: Record<GlobalSearchKind, string> = {
    fileNode: 'file-text',
    conceptNode: 'lightbulb',
    embedNode: 'box',
    mocFile: 'book-open',
    remark: 'message-square',
    workspaceNode: 'layout-grid',
    task: 'square-check-big',
};

const WORKSPACE_TYPE_LABEL: Record<WSNodeType, string> = {
    space: 'Space',
    moc: 'Workspace MOC',
    project: 'Project',
    note: 'Workspace note',
    map: 'Workspace map',
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

    constructor(app: App, deps: GlobalSearchModalDeps) {
        super(app);
        this.deps = deps;
        this.taskStore = new ProjectTaskStore(app);
        this.taskStore.onChange = () => this.inputEl.trigger("input");
        this.setPlaceholder("Search everything");
        this.limit = 50;
    }

    onClose(): void {
        super.onClose();
        this.taskStore.dispose();
    }

    getSuggestions(query: string): ScoredEntry[] {
        const trimmed = query.trim();
        const entries = this.collectEntries();
        if (!trimmed) {
            return entries.slice(0, 50).map(entry => ({
                entry,
                score: 0,
                textMatches: null,
                subtitleMatches: null,
            }));
        }

        const fuzzy = prepareFuzzySearch(trimmed);
        return entries
            .map(entry => {
                const textMatches = fuzzy(entry.text);
                const subtitleMatches = entry.subtitle ? fuzzy(entry.subtitle) : null;
                if (!textMatches && !subtitleMatches) return null;
                return {
                    entry,
                    score: scoreValue(textMatches, entry.text, 1000) + scoreValue(subtitleMatches, entry.subtitle, 300),
                    textMatches: textMatches?.matches ?? null,
                    subtitleMatches: subtitleMatches?.matches ?? null,
                };
            })
            .filter((item): item is ScoredEntry => item !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, 50);
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

        return entries;
    }

    private fromMOCEntry(entry: SearchEntry): GlobalSearchEntry {
        return {
            kind: entry.kind,
            text: entry.text,
            subtitle: entry.kind === 'mocFile' ? entry.mocFilePath : `In ${entry.mocFileName}`,
            mocFilePath: entry.mocFilePath,
            mocFileName: entry.mocFileName,
            nodeId: entry.nodeId,
        };
    }

    private fromWorkspaceNode(node: WorkspaceNode, store: WorkspaceStore): GlobalSearchEntry {
        const space = node.type === 'space' ? node : store.getNode(node.spaceId);
        const suffix = space && space.id !== node.id ? ` in ${space.title}` : ' in Workspace';
        return {
            kind: 'workspaceNode',
            text: node.title,
            subtitle: `${WORKSPACE_TYPE_LABEL[node.type]}${suffix}`,
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
            subtitle: `Task in ${project.title}`,
            workspaceNodeId: project.id,
            taskFilePath: project.filePath,
            taskRaw: task.raw,
        }));
    }
}

export async function openTaskAtLine(app: App, filePath: string, taskRaw: string): Promise<void> {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
        new Notice("File not found");
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
