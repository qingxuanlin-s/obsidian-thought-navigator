import { App, Component, DataAdapter, TFile } from "obsidian";
import {
    WorkspaceNode, WSLink, WSSpaceNode, WSMocNode, WSProjectNode, WSNoteNode,
    WorkspaceStoreFile, FrameworkId, OpenTarget, targetFor, ChecklistItem,
    ProjectAction, LinkType,
} from "src/types/workspace";

/** id 生成:`wsn_` + 8 位 base36 + 时间戳尾 */
export function genNodeId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    const t = Date.now().toString(36).slice(-4);
    return `wsn_${rand}${t}`;
}

type ChangeListener = () => void;

async function readStore(adapter: DataAdapter, storePath: string): Promise<WorkspaceStoreFile> {
    const empty: WorkspaceStoreFile = { version: 1, nodes: [], links: [] };
    try {
        if (!(await adapter.exists(storePath))) return empty;
        const parsed = JSON.parse(await adapter.read(storePath)) as WorkspaceStoreFile;
        if (!parsed || !Array.isArray(parsed.nodes)) return empty;
        return {
            version: 1,
            nodes: parsed.nodes,
            links: Array.isArray(parsed.links) ? parsed.links : [],
        };
    } catch (e) {
        console.warn('[zk-navigation] workspace.json 读取失败:', storePath, e);
        return empty;
    }
}

/**
 * 工作区 typed-node + link 的内存存储。
 *
 * 持久化:整份数据存在 storePath(插件数据目录下的 workspace.json)。
 * 写路径:caller → store.commit(mutator) → 落盘 → emit。镜像 VaultIndex 约定。
 */
export class WorkspaceStore extends Component {
    private app: App;
    private storePath: string;
    private nodes: Map<string, WorkspaceNode> = new Map();
    private links: WSLink[] = [];
    private migrationVersion = 0;
    private listeners: Set<ChangeListener> = new Set();
    private bootstrapped = false;
    private flushChain: Promise<void> = Promise.resolve();

    constructor(app: App, storePath: string) {
        super();
        this.app = app;
        this.storePath = storePath;
    }

    async bootstrap(): Promise<void> {
        if (this.bootstrapped) return;
        await this.reload();
        this.bootstrapped = true;
    }

    async reload(): Promise<void> {
        const data = await readStore(this.app.vault.adapter, this.storePath);
        this.nodes.clear();
        for (const n of data.nodes) this.nodes.set(n.id, n);
        this.links = data.links.filter(l => this.nodes.has(l.from) && this.nodes.has(l.to));
        this.migrationVersion = (data as any).migrationVersion ?? 0;
        this.emitChange();
    }

    /**
     * 统一变更入口:在 mutator 里改 nodes/links;自动落盘 + 通知。
     * mutator 收到 helpers 以便创建/触碰节点。
     */
    async commit(mutator: (ctx: WorkspaceMutation) => void | Promise<void>): Promise<void> {
        const ctx = new WorkspaceMutation(this.nodes, this.links);
        await mutator(ctx);
        this.links = ctx.links;
        // 清理悬挂边
        this.links = this.links.filter(l => this.nodes.has(l.from) && this.nodes.has(l.to));
        this.emitChange();
        this.flushChain = this.flushChain.then(() => this.flush()).catch((e) => {
            console.error('[zk-navigation] workspace.json 写入失败', e);
        });
        await this.flushChain;
    }

    private async flush(): Promise<void> {
        const data: WorkspaceStoreFile = {
            version: 1,
            nodes: Array.from(this.nodes.values()),
            links: this.links,
        };
        (data as any).migrationVersion = this.migrationVersion;
        await this.app.vault.adapter.write(this.storePath, JSON.stringify(data, null, 2));
    }

    getMigrationVersion(): number { return this.migrationVersion; }

    /** 整体替换数据并记录迁移版本号(用于自动重迁移) */
    async resetTo(nodes: WorkspaceNode[], links: WSLink[], migrationVersion: number): Promise<void> {
        this.migrationVersion = migrationVersion;
        await this.commit(ctx => {
            for (const n of Array.from(this.nodes.values())) ctx.remove(n.id);
            for (const n of nodes) ctx.put(n);
            for (const l of links) ctx.addLink(l);
        });
    }

    // ---------- 查询 ----------

    getNode(id: string): WorkspaceNode | undefined { return this.nodes.get(id); }
    /** 按 vault 文件路径反查已有节点(笔记/图谱/MOC 可能都关联了文件) */
    getNodeByPath(path: string): WorkspaceNode | undefined {
        return this.getAllNodes().find(n => (n as any).filePath === path);
    }
    getAllNodes(): WorkspaceNode[] { return Array.from(this.nodes.values()); }
    isEmpty(): boolean { return this.nodes.size === 0; }
    getAllLinks(): WSLink[] { return this.links.slice(); }

    /** 所有 Space 节点,按 createdAt 排序 */
    getSpaces(): WSSpaceNode[] {
        return this.getAllNodes()
            .filter((n): n is WSSpaceNode => n.type === 'space')
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /** 某 Space 下的全部非 Space 节点 */
    nodesInSpace(spaceId: string): WorkspaceNode[] {
        return this.getAllNodes().filter(n => n.type !== 'space' && n.spaceId === spaceId);
    }

    linksFrom(id: string): WSLink[] { return this.links.filter(l => l.from === id); }
    linksTo(id: string): WSLink[] { return this.links.filter(l => l.to === id); }

    /** 本节点的出链目标 id(DESIGN 里的 refs 反范式) */
    refsOf(id: string): string[] { return this.linksFrom(id).map(l => l.to); }

    /**
     * MOC 的核心能力:实时聚合所有指向它的节点(serves / partOf)。
     * 不靠文件夹嵌套,反查 link。
     */
    servedBy(mocId: string): WorkspaceNode[] {
        const fromIds = this.links
            .filter(l => l.to === mocId && (l.type === 'serves' || l.type === 'partOf'))
            .map(l => l.from);
        return Array.from(new Set(fromIds))
            .map(id => this.nodes.get(id))
            .filter((n): n is WorkspaceNode => !!n);
    }

    /** 节点 → 默认打开目标 */
    targetFor(node: WorkspaceNode): OpenTarget { return targetFor(node); }

    // ---------- 写操作(在 commit 外的便捷封装) ----------

    async createSpace(title: string, opts?: { framework?: FrameworkId; icon?: string; color?: string }): Promise<WSSpaceNode> {
        const id = genNodeId();
        const now = Date.now();
        const node: WSSpaceNode = {
            id, type: 'space', spaceId: id, title: title.trim() || '未命名 Space',
            framework: opts?.framework ?? 'custom',
            icon: opts?.icon, color: opts?.color,
            createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => ctx.put(node));
        return node;
    }

    /** 建立一条 typed link(关联)。重复的(同 from/to/type)自动去重。 */
    async addRelation(from: string, to: string, type: LinkType): Promise<void> {
        if (from === to) return;
        await this.commit(ctx => ctx.addLink({ from, to, type }));
    }

    /** 删除关联 */
    async removeRelation(from: string, to: string, type?: LinkType): Promise<void> {
        await this.commit(ctx => ctx.removeLink(from, to, type));
    }

    /**
     * 把 vault 里任意 markdown 笔记关联到某 MOC:
     * 若该文件还没有对应工作区节点,就地建一个 note 节点(归到 MOC 所在 Space),再建 partOf 链。
     */
    async associateFileToMoc(mocId: string, file: TFile): Promise<void> {
        const moc = this.nodes.get(mocId);
        if (!moc) return;
        await this.commit(ctx => {
            let note = this.getNodeByPath(file.path);
            if (!note) {
                const now = Date.now();
                const node: WSNoteNode = {
                    id: genNodeId(), type: 'note', spaceId: moc.spaceId,
                    title: file.basename, filePath: file.path, createdAt: now, updatedAt: now,
                };
                ctx.put(node);
                note = node;
            }
            ctx.addLink({ from: note.id, to: mocId, type: 'partOf' });
        });
    }

    async createProject(spaceId: string, title: string): Promise<WSProjectNode> {
        const id = genNodeId(); const now = Date.now();
        const node: WSProjectNode = {
            id, type: 'project', spaceId, title: title.trim() || '未命名项目',
            status: 'todo', createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => ctx.put(node));
        return node;
    }

    async createMoc(spaceId: string, title: string): Promise<WSMocNode> {
        const id = genNodeId(); const now = Date.now();
        const node: WSMocNode = {
            id, type: 'moc', spaceId, title: title.trim() || '未命名 MOC',
            createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => ctx.put(node));
        return node;
    }

    async createNote(spaceId: string, title: string): Promise<WSNoteNode> {
        const id = genNodeId(); const now = Date.now();
        const node: WSNoteNode = {
            id, type: 'note', spaceId, title: title.trim() || '未命名笔记',
            createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => ctx.put(node));
        return node;
    }

    async setFramework(spaceId: string, framework: FrameworkId): Promise<void> {
        await this.commit(ctx => ctx.update(spaceId, n => {
            if (n.type === 'space') n.framework = framework;
        }));
    }

    async setProjectStatus(id: string, status: WSProjectNode['status']): Promise<void> {
        await this.commit(ctx => ctx.update(id, n => {
            if (n.type === 'project') n.status = status;
        }));
    }

    async setNextAction(id: string, nextAction: string): Promise<void> {
        await this.commit(ctx => ctx.update(id, n => {
            if (n.type === 'project') n.nextAction = nextAction;
        }));
    }

    /** 手动设进度百分比;传 null 清除手动值,回退到 checklist 推导 */
    async setProgress(id: string, pct: number | null): Promise<void> {
        await this.commit(ctx => ctx.update(id, n => {
            if (n.type !== 'project') return;
            if (pct === null) delete n.progress;
            else n.progress = Math.max(0, Math.min(100, Math.round(pct)));
        }));
    }

    // ---------- NEXT ACTION 动作列表 ----------

    async addAction(projectId: string, init?: { text?: string; noteId?: string; notePath?: string }): Promise<void> {
        await this.commit(ctx => ctx.update(projectId, n => {
            if (n.type !== 'project') return;
            if (!n.actions) n.actions = [];
            n.actions.push({ id: genNodeId(), text: (init?.text || '').trim(), noteId: init?.noteId, notePath: init?.notePath, status: 'todo' });
        }));
    }

    async updateAction(projectId: string, actionId: string, patch: Partial<ProjectAction>): Promise<void> {
        await this.commit(ctx => ctx.update(projectId, n => {
            if (n.type !== 'project' || !n.actions) return;
            const a = n.actions.find(x => x.id === actionId);
            if (!a) return;
            Object.assign(a, patch);
            if (typeof a.progress === 'number') a.progress = Math.max(0, Math.min(100, Math.round(a.progress)));
        }));
    }

    async removeAction(projectId: string, actionId: string): Promise<void> {
        await this.commit(ctx => ctx.update(projectId, n => {
            if (n.type !== 'project' || !n.actions) return;
            n.actions = n.actions.filter(a => a.id !== actionId);
        }));
    }

    /** 上移/下移动作:dir = -1 上、+1 下 */
    async moveAction(projectId: string, actionId: string, dir: -1 | 1): Promise<void> {
        await this.commit(ctx => ctx.update(projectId, n => {
            if (n.type !== 'project' || !n.actions) return;
            const i = n.actions.findIndex(a => a.id === actionId);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= n.actions.length) return;
            [n.actions[i], n.actions[j]] = [n.actions[j], n.actions[i]];
        }));
    }

    async toggleChecklistItem(id: string, itemId: string): Promise<void> {
        await this.commit(ctx => ctx.update(id, n => {
            if (n.type !== 'project' || !n.checklist) return;
            const it = n.checklist.find(x => x.id === itemId);
            if (it) it.done = !it.done;
        }));
    }

    // ---------- 订阅 ----------

    onChange(listener: ChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emitChange(): void {
        for (const l of this.listeners) {
            try { l(); } catch (e) { console.error('[zk-navigation] WorkspaceStore listener error', e); }
        }
    }
}

/** commit mutator 上下文:提供 put/update/remove/link 等原子操作,自动维护 updatedAt */
export class WorkspaceMutation {
    constructor(
        private nodes: Map<string, WorkspaceNode>,
        public links: WSLink[],
    ) {}

    put(node: WorkspaceNode): void {
        this.nodes.set(node.id, node);
    }

    update(id: string, fn: (n: WorkspaceNode) => void): void {
        const n = this.nodes.get(id);
        if (!n) return;
        fn(n);
        n.updatedAt = Date.now();
    }

    remove(id: string): void {
        this.nodes.delete(id);
        this.links = this.links.filter(l => l.from !== id && l.to !== id);
    }

    addLink(link: WSLink): void {
        const dup = this.links.some(l => l.from === link.from && l.to === link.to && l.type === link.type);
        if (!dup) this.links.push(link);
    }

    removeLink(from: string, to: string, type?: string): void {
        this.links = this.links.filter(l => !(l.from === from && l.to === to && (!type || l.type === type)));
    }
}

/** progress 半自动:有 checklist 才算,否则 null(不显示进度条) */
export function progressOf(checklist?: ChecklistItem[]): number | null {
    if (!checklist || !checklist.length) return null;
    return Math.round(checklist.filter(i => i.done).length / checklist.length * 100);
}

/** 单个动作的完成比例:已完成记 100,否则取手动 progress,再否则进行中记 50 */
export function actionPct(a: ProjectAction): number {
    if (a.status === 'done') return 100;
    if (typeof a.progress === 'number') return Math.max(0, Math.min(100, a.progress));
    return a.status === 'doing' ? 50 : 0;
}

/** 项目进度:手动 progress 优先 → 动作列表均值 → checklist 推导 */
export function projectProgress(p: WSProjectNode): number | null {
    if (typeof p.progress === 'number') return Math.max(0, Math.min(100, p.progress));
    if (p.actions && p.actions.length) {
        return Math.round(p.actions.reduce((s, a) => s + actionPct(a), 0) / p.actions.length);
    }
    return progressOf(p.checklist);
}

/** 动作状态机循环:未开始 → 进行中 → 已完成 → 循环 */
export function nextActionStatus(s: ProjectAction['status']): ProjectAction['status'] {
    const order: ProjectAction['status'][] = ['todo', 'doing', 'done'];
    return order[(order.indexOf(s) + 1) % order.length];
}

/** 动作是否被前序依赖锁定:dependsOnPrev 且前一个动作未完成 */
export function actionLocked(actions: ProjectAction[], index: number): boolean {
    if (index <= 0) return false;
    const a = actions[index];
    return !!a.dependsOnPrev && actions[index - 1].status !== 'done';
}

/** 项目状态机循环切换:未开始→进行中→阻塞→已完成→已归档→循环 */
export function nextStatus(s: WSProjectNode['status']): WSProjectNode['status'] {
    const order: WSProjectNode['status'][] = ['todo', 'active', 'blocked', 'done', 'archived'];
    const i = order.indexOf(s);
    return order[(i + 1) % order.length];
}
