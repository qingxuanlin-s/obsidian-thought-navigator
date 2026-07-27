import { App, Component, DataAdapter, Notice, TFile } from "obsidian";
import {
    WorkspaceNode, WSLink, WSSpaceNode, WSMocNode, WSProjectNode, WSNoteNode,
    WorkspaceStoreFile, WorkspaceStoreFileV1, WorkspaceStoreFileV2, WorkspacePlacement,
    MocWorkspaceBridge, MocWorkspaceBridgeRole, FrameworkId, OpenTarget, targetFor, ChecklistItem,
    LinkType,
} from "src/types/workspace";
import { isMocPath, stripMocSuffix } from "src/utils/utils";
import {
    migrateWorkspaceV1,
    migrationIssueCount,
    normalizeWorkspaceV2,
    placementIdFor,
    WorkspaceMigrationDiagnostics,
} from "./workspaceMigration";

/** id 生成:`wsn_` + 8 位 base36 + 时间戳尾 */
export function genNodeId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    const t = Date.now().toString(36).slice(-4);
    return `wsn_${rand}${t}`;
}

/** 取路径 basename 并去掉最后一级扩展名(对齐 Obsidian TFile.basename:`x.moc.md` → `x.moc`) */
function baseNameNoExt(path: string): string {
    const base = path.split('/').pop() || path;
    return base.replace(/\.[^.]+$/, '');
}

/** MOC 去掉完整后缀；普通文件保持 Obsidian 的 basename 语义。 */
function fileNodeTitle(path: string): string {
    const base = path.split('/').pop() || path;
    return isMocPath(path) ? stripMocSuffix(base) : baseNameNoExt(path);
}

/** 清掉文件名非法字符,作为新建笔记的 basename */
function sanitizeFileName(title: string): string {
    return title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTag(tag: string): string {
    return tag.trim().replace(/^#+/, '').trim();
}

function projectFileContent(title: string, tag: string): string {
    const cleanTag = normalizeTag(tag);
    const frontmatter = cleanTag ? `---\ntags:\n  - ${cleanTag}\n---\n\n` : '';
    return `${frontmatter}# ${title}\n\n`;
}

type ChangeListener = () => void;

interface WorkspaceStoreSnapshot {
    data: WorkspaceStoreFileV2;
    raw: string | null;
    migratedFromV1: boolean;
    diagnostics: WorkspaceMigrationDiagnostics;
}

const EMPTY_DIAGNOSTICS: WorkspaceMigrationDiagnostics = {
    ambiguousParents: 0,
    crossSpaceParents: 0,
    detachedCycles: 0,
    missingSpaces: 0,
    invalidPlacements: 0,
    invalidBridges: 0,
};

async function readStore(adapter: DataAdapter, storePath: string): Promise<WorkspaceStoreSnapshot> {
    const empty: WorkspaceStoreFileV2 = { version: 2, nodes: [], placements: [], links: [], bridges: [] };
    try {
        if (!(await adapter.exists(storePath))) {
            return { data: empty, raw: null, migratedFromV1: false, diagnostics: { ...EMPTY_DIAGNOSTICS } };
        }
        const raw = await adapter.read(storePath);
        const parsed = JSON.parse(raw) as WorkspaceStoreFile;
        if (!parsed || !Array.isArray(parsed.nodes)) {
            throw new Error('workspace.json schema 无效');
        }
        if (parsed.version === 2) {
            const normalized = normalizeWorkspaceV2(parsed);
            return { ...normalized, raw, migratedFromV1: false };
        }
        const legacy: WorkspaceStoreFileV1 = {
            version: 1,
            nodes: parsed.nodes,
            links: Array.isArray(parsed.links) ? parsed.links : [],
            // 关键:透传已落盘的迁移版本号,否则每次 reload 都被视作 0、
            // 触发 ensureWorkspaceSeed 重迁并覆盖用户新建数据
            migrationVersion: typeof parsed.migrationVersion === 'number' ? parsed.migrationVersion : 0,
        };
        const migrated = migrateWorkspaceV1(legacy);
        return { ...migrated, raw, migratedFromV1: true };
    } catch (e) {
        console.warn('[zk-navigation] workspace.json 读取失败:', storePath, e);
        return { data: empty, raw: null, migratedFromV1: false, diagnostics: { ...EMPTY_DIAGNOSTICS } };
    }
}

/**
 * 工作区 typed-node + link 的内存存储。
 *
 * 持久化:整份数据存在 storePath(插件数据目录下的 workspace.json)。
 * 写路径:caller → store.commit(mutator) → 落盘 → emit。镜像旧 VaultIndex 的提交约定。
 */
export class WorkspaceStore extends Component {
    private app: App;
    private storePath: string;
    private nodes: Map<string, WorkspaceNode> = new Map();
    private placements: Map<string, WorkspacePlacement> = new Map();
    private links: WSLink[] = [];
    private bridges: MocWorkspaceBridge[] = [];
    private migrationVersion = 0;
    private listeners: Set<ChangeListener> = new Set();
    private bootstrapped = false;
    private flushChain: Promise<void> = Promise.resolve();
    /** 最近一次成功读/写的原始内容,用于识别 Remote Save 等外部修改。 */
    private lastDiskContent: string | null = null;
    private hasStoreFile = false;

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
        await this.applySnapshot(await readStore(this.app.vault.adapter, this.storePath));
    }

    /** 工作台可见/窗口重新聚焦时调用：仅在磁盘内容变更后重载，不覆盖本地已写入快照。 */
    async reloadIfChanged(): Promise<boolean> {
        const snapshot = await readStore(this.app.vault.adapter, this.storePath);
        if (snapshot.raw === this.lastDiskContent) return false;
        await this.applySnapshot(snapshot);
        return true;
    }

    /** 写入前检测磁盘是否已被外部同步替换,防止旧内存快照覆盖远端数据。 */
    private async refreshIfDiskChanged(): Promise<void> {
        const snapshot = await readStore(this.app.vault.adapter, this.storePath);
        if (snapshot.raw === this.lastDiskContent) return;
        await this.applySnapshot(snapshot);
    }

    private async applySnapshot(snapshot: WorkspaceStoreSnapshot): Promise<void> {
        const { data } = snapshot;
        if (snapshot.migratedFromV1 && snapshot.raw !== null) {
            await this.backupV1(snapshot.raw);
        }
        this.lastDiskContent = snapshot.raw;
        this.hasStoreFile = snapshot.raw !== null;
        this.nodes.clear();
        const reclassifiedMocIds = new Set<string>();
        for (const n of data.nodes) {
            if (n.type === 'note' && n.filePath && isMocPath(n.filePath)) {
                const moc = {
                    ...n,
                    type: 'moc' as const,
                    title: n.title === baseNameNoExt(n.filePath) ? fileNodeTitle(n.filePath) : n.title,
                };
                delete moc.body;
                delete moc.lid;
                this.nodes.set(n.id, { ...moc });
                reclassifiedMocIds.add(n.id);
            } else {
                this.nodes.set(n.id, n);
            }
        }
        this.placements = new Map(data.placements
            .filter(placement => this.nodes.has(placement.nodeId))
            .map(placement => [placement.id, { ...placement }]));
        this.links = data.links
            .filter(l => this.nodes.has(l.from) && this.nodes.has(l.to))
            .map(l => reclassifiedMocIds.has(l.from) && l.type === 'partOf'
                ? { ...l, type: 'childMoc' as const }
                : l);
        this.bridges = data.bridges
            .filter(bridge => this.nodes.has(bridge.workspaceNodeId))
            .map(bridge => ({ ...bridge }));
        this.migrationVersion = data.migrationVersion ?? 0;
        if (snapshot.migratedFromV1 || reclassifiedMocIds.size > 0) await this.flush();
        const issueCount = migrationIssueCount(snapshot.diagnostics);
        if (snapshot.migratedFromV1 && issueCount > 0) {
            console.warn('[zk-navigation] 工作台 V2 迁移已安全降级歧义位置:', snapshot.diagnostics);
            new Notice(`知识工作台已升级；${issueCount} 个歧义位置已移到空间根级`);
        }
        this.emitChange();
    }

    private async backupV1(raw: string): Promise<void> {
        const backupPath = this.storePath.replace(/workspace\.json$/, 'workspace.v1-backup.json');
        if (backupPath === this.storePath || await this.app.vault.adapter.exists(backupPath)) return;
        await this.app.vault.adapter.write(backupPath, raw);
    }

    /**
     * 统一变更入口:在 mutator 里改 nodes/links;自动落盘 + 通知。
     * mutator 收到 helpers 以便创建/触碰节点。
     */
    async commit(mutator: (ctx: WorkspaceMutation) => void | Promise<void>): Promise<void> {
        await this.refreshIfDiskChanged();
        const ctx = new WorkspaceMutation(this.nodes, this.placements, this.links, this.bridges);
        await mutator(ctx);
        this.placements = ctx.placements;
        this.links = ctx.links;
        this.bridges = ctx.bridges;
        // 清理悬挂边、位置和桥接
        this.links = this.links.filter(l => this.nodes.has(l.from) && this.nodes.has(l.to));
        this.placements = new Map(Array.from(this.placements.entries())
            .filter(([, placement]) => this.nodes.has(placement.nodeId)));
        this.bridges = this.bridges.filter(bridge => this.nodes.has(bridge.workspaceNodeId));
        this.emitChange();
        this.flushChain = this.flushChain.then(() => this.flush()).catch((e) => {
            console.error('[zk-navigation] workspace.json 写入失败', e);
        });
        await this.flushChain;
    }

    private async flush(): Promise<void> {
        const data: WorkspaceStoreFileV2 = {
            version: 2,
            nodes: Array.from(this.nodes.values()),
            placements: Array.from(this.placements.values()),
            links: this.links,
            bridges: this.bridges,
            migrationVersion: this.migrationVersion,
        };
        const raw = JSON.stringify(data, null, 2);
        await this.app.vault.adapter.write(this.storePath, raw);
        this.lastDiskContent = raw;
        this.hasStoreFile = true;
    }

    getMigrationVersion(): number { return this.migrationVersion; }
    hasStoredFile(): boolean { return this.hasStoreFile; }

    /** 仅更新迁移版本号并落盘(不动节点/边),用于"无新数据可迁但要记录已处理过本版本" */
    async setMigrationVersion(v: number): Promise<void> {
        await this.refreshIfDiskChanged();
        if (this.migrationVersion === v) return;
        this.migrationVersion = v;
        await this.flush();
    }

    /** 整体替换数据并记录迁移版本号(用于自动重迁移) */
    async resetTo(nodes: WorkspaceNode[], links: WSLink[], migrationVersion: number): Promise<void> {
        await this.refreshIfDiskChanged();
        this.migrationVersion = migrationVersion;
        const migrated = migrateWorkspaceV1({ version: 1, nodes, links, migrationVersion }).data;
        await this.commit(ctx => {
            for (const n of Array.from(this.nodes.values())) ctx.remove(n.id);
            ctx.placements.clear();
            ctx.links = [];
            ctx.bridges = [];
            for (const n of migrated.nodes) ctx.put(n);
            for (const placement of migrated.placements) ctx.putPlacement(placement);
            for (const l of migrated.links) ctx.addLink(l);
        });
    }

    // ---------- 查询 ----------

    getNode(id: string): WorkspaceNode | undefined { return this.nodes.get(id); }
    /** 按 vault 文件路径反查已有节点(笔记/图谱/MOC 可能都关联了文件) */
    getNodeByPath(path: string): WorkspaceNode | undefined {
        return this.getAllNodes().find(n => (n as { filePath?: string }).filePath === path);
    }
    getAllNodes(): WorkspaceNode[] { return Array.from(this.nodes.values()); }
    isEmpty(): boolean { return this.nodes.size === 0; }
    getAllLinks(): WSLink[] { return this.links.slice(); }
    getAllPlacements(): WorkspacePlacement[] { return Array.from(this.placements.values()).map(p => ({ ...p })); }
    getPlacement(id: string): WorkspacePlacement | undefined {
        const placement = this.placements.get(id);
        return placement ? { ...placement } : undefined;
    }
    placementsOfNode(nodeId: string): WorkspacePlacement[] {
        return this.getAllPlacements().filter(placement => placement.nodeId === nodeId);
    }
    placementForNodeInSpace(nodeId: string, spaceId: string): WorkspacePlacement | undefined {
        return this.placementsOfNode(nodeId).find(placement => placement.spaceId === spaceId);
    }
    getPlacementNode(placementId: string): WorkspaceNode | undefined {
        const placement = this.placements.get(placementId);
        return placement ? this.nodes.get(placement.nodeId) : undefined;
    }

    getNodeSpaceIds(nodeId: string): string[] {
        return Array.from(new Set(this.placementsOfNode(nodeId).map(placement => placement.spaceId)));
    }

    /** 所有 Space 节点,按 createdAt 排序 */
    getSpaces(): WSSpaceNode[] {
        return this.getAllNodes()
            .filter((n): n is WSSpaceNode => n.type === 'space')
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /** 某 Space 下的全部非 Space 节点；V2 以 Placement 为唯一成员来源。 */
    nodesInSpace(spaceId: string): WorkspaceNode[] {
        return this.getAllPlacements()
            .filter(placement => placement.spaceId === spaceId)
            .map(placement => this.nodes.get(placement.nodeId))
            .filter((node): node is WorkspaceNode => !!node && node.type !== 'space');
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

    // ---------- 容器树(文件夹抽屉:Space/MOC 当容器,Option A)----------

    /** 容器边:childMoc(moc→moc)/ partOf(note,map→moc)/ serves(project→moc)都算"归属于父容器" */
    private isContainmentLink(l: WSLink): boolean {
        return l.type === 'childMoc' || l.type === 'partOf' || l.type === 'serves';
    }

    /** 同层排序:手动 order 升序(缺省排末尾),再按标题 */
    private cmpOrder = (a: WorkspaceNode, b: WorkspaceNode): number => {
        const oa = a.order ?? Number.MAX_SAFE_INTEGER;
        const ob = b.order ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
        return a.title.localeCompare(b.title, 'zh');
    };

    parentPlacementOf(placementId: string): WorkspacePlacement | null {
        const placement = this.placements.get(placementId);
        if (!placement?.parentPlacementId) return null;
        const parent = this.placements.get(placement.parentPlacementId);
        return parent ? { ...parent } : null;
    }

    placementChildren(parentPlacementId: string | null, spaceId: string): WorkspacePlacement[] {
        return this.getAllPlacements()
            .filter(placement => placement.spaceId === spaceId && placement.parentPlacementId === parentPlacementId)
            .sort((a, b) => {
                const na = this.nodes.get(a.nodeId), nb = this.nodes.get(b.nodeId);
                if (!na || !nb) return 0;
                const oa = a.order ?? Number.MAX_SAFE_INTEGER;
                const ob = b.order ?? Number.MAX_SAFE_INTEGER;
                return oa !== ob ? oa - ob : this.cmpOrder(na, nb);
            });
    }

    /** 精确 Placement 子树；永远不会跨 Space。 */
    collectPlacementSubtreeIds(placementId: string): string[] {
        const root = this.placements.get(placementId);
        if (!root) return [];
        const out: string[] = [];
        const visit = (id: string) => {
            out.push(id);
            for (const child of this.placementChildren(id, root.spaceId)) visit(child.id);
        };
        visit(root.id);
        return out;
    }

    /** 兼容查询：显式 spaceId 时精确；省略时使用该节点第一个 Placement。 */
    parentContainerOf(nodeId: string, spaceId?: string): string | null {
        const node = this.nodes.get(nodeId);
        if (!node || node.type === 'space') return null;
        const placement = spaceId
            ? this.placementForNodeInSpace(nodeId, spaceId)
            : this.placementsOfNode(nodeId)[0];
        if (!placement) return null;
        const parent = this.parentPlacementOf(placement.id);
        return parent ? parent.nodeId : placement.spaceId;
    }

    /** 容器的直接子节点；MOC 多空间时调用方应传 spaceId。 */
    containerChildren(containerId: string, spaceId?: string): WorkspaceNode[] {
        const container = this.nodes.get(containerId);
        if (!container) return [];
        const resolvedSpaceId = container.type === 'space'
            ? container.id
            : spaceId ?? this.placementsOfNode(containerId)[0]?.spaceId;
        if (!resolvedSpaceId) return [];
        const parentPlacementId = container.type === 'space'
            ? null
            : this.placementForNodeInSpace(containerId, resolvedSpaceId)?.id ?? null;
        if (container.type !== 'space' && !parentPlacementId) return [];
        return this.placementChildren(parentPlacementId, resolvedSpaceId)
            .map(placement => this.nodes.get(placement.nodeId))
            .filter((node): node is WorkspaceNode => !!node)
            .sort(this.cmpOrder);
    }

    /** 兼容子树查询，结果限制在一个 Placement/Space 内。 */
    collectSubtreeIds(containerId: string, spaceId?: string): string[] {
        const container = this.nodes.get(containerId);
        if (!container) return [];
        if (container.type === 'space') {
            return [container.id, ...this.getAllPlacements()
                .filter(placement => placement.spaceId === container.id)
                .map(placement => placement.nodeId)];
        }
        const placement = spaceId
            ? this.placementForNodeInSpace(containerId, spaceId)
            : this.placementsOfNode(containerId)[0];
        if (!placement) return [containerId];
        return this.collectPlacementSubtreeIds(placement.id)
            .map(id => this.placements.get(id)?.nodeId)
            .filter((id): id is string => !!id);
    }

    /** vault 文件是否在工作台存在至少一个有效 Placement(= 已“挂载”) */
    isFileMounted(path: string): boolean {
        return this.locationsHostingFile(path).length > 0;
    }

    /** 文件是否已挂在指定容器下 */
    isFileMountedIn(path: string, containerId: string): boolean {
        return this.containersHostingFile(path).some(c => c.id === containerId);
    }

    /** 全部容器(Space + MOC),供挂载选择器列出 */
    getContainers(): WorkspaceNode[] {
        return this.getAllNodes().filter(n => n.type === 'space' || n.type === 'moc');
    }

    /** 节点展示路径:从当前 Placement 根容器到自身；省略 spaceId 时使用第一个位置。 */
    displayPath(nodeId: string, spaceId?: string): string {
        const node = this.nodes.get(nodeId);
        if (!node) return '';
        if (node.type === 'space') return node.title;
        const placement = spaceId
            ? this.placementForNodeInSpace(nodeId, spaceId)
            : this.placementsOfNode(nodeId)[0];
        if (!placement) return node.title;
        const parts = [node.title];
        const seen = new Set<string>([placement.id]);
        let parentId = placement.parentPlacementId;
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = this.placements.get(parentId);
            const parentNode = parent ? this.nodes.get(parent.nodeId) : undefined;
            if (!parent || !parentNode) break;
            parts.unshift(parentNode.title);
            parentId = parent.parentPlacementId;
        }
        const space = this.nodes.get(placement.spaceId);
        if (space) parts.unshift(space.title);
        return parts.join(' / ');
    }

    locationsHostingFile(path: string): Array<{ placement: WorkspacePlacement; node: WorkspaceNode; container: WorkspaceNode }> {
        const out: Array<{ placement: WorkspacePlacement; node: WorkspaceNode; container: WorkspaceNode }> = [];
        for (const node of this.getAllNodes()) {
            if ((node as { filePath?: string }).filePath !== path) continue;
            for (const placement of this.placementsOfNode(node.id)) {
                const parent = placement.parentPlacementId ? this.placements.get(placement.parentPlacementId) : null;
                const container = parent ? this.nodes.get(parent.nodeId) : this.nodes.get(placement.spaceId);
                if (container) out.push({ placement, node, container });
            }
        }
        return out;
    }

    /** 承载某文件的父容器节点(兼容旧 UI，按位置去重) */
    containersHostingFile(path: string): WorkspaceNode[] {
        return Array.from(new Map(this.locationsHostingFile(path)
            .map(location => [location.container.id, location.container])).values());
    }

    /** 节点 → 默认打开目标 */
    targetFor(node: WorkspaceNode, placement?: WorkspacePlacement): OpenTarget { return targetFor(node, placement); }

    placementForContainer(containerId: string, spaceId?: string): { spaceId: string; parentPlacementId: string | null } | null {
        const container = this.nodes.get(containerId);
        if (!container) return null;
        if (container.type === 'space') return { spaceId: container.id, parentPlacementId: null };
        const placement = spaceId
            ? this.placementForNodeInSpace(containerId, spaceId)
            : this.placementsOfNode(containerId)[0];
        return placement ? { spaceId: placement.spaceId, parentPlacementId: placement.id } : null;
    }

    getAllBridges(): MocWorkspaceBridge[] { return this.bridges.map(bridge => ({ ...bridge })); }
    bridgesForGraphNode(mocPath: string, mocNodeId: string): MocWorkspaceBridge[] {
        return this.getAllBridges().filter(bridge => bridge.mocPath === mocPath && bridge.mocNodeId === mocNodeId);
    }
    bridgesForWorkspaceNode(workspaceNodeId: string): MocWorkspaceBridge[] {
        return this.getAllBridges().filter(bridge => bridge.workspaceNodeId === workspaceNodeId);
    }

    async addBridge(input: {
        mocPath: string;
        mocNodeId: string;
        workspaceNodeId: string;
        placementId?: string;
        role: MocWorkspaceBridgeRole;
    }): Promise<MocWorkspaceBridge | null> {
        if (!input.mocPath || !input.mocNodeId || !this.nodes.has(input.workspaceNodeId)) return null;
        const existing = this.bridges.find(bridge => bridge.mocPath === input.mocPath
            && bridge.mocNodeId === input.mocNodeId
            && bridge.workspaceNodeId === input.workspaceNodeId
            && bridge.role === input.role);
        if (existing) return { ...existing };
        const now = Date.now();
        const bridge: MocWorkspaceBridge = {
            id: `wsb_${genNodeId().slice(4)}`,
            ...input,
            placementId: input.placementId && this.placements.has(input.placementId) ? input.placementId : undefined,
            createdAt: now,
            updatedAt: now,
        };
        await this.commit(ctx => ctx.addBridge(bridge));
        return bridge;
    }

    async removeBridge(id: string): Promise<void> {
        if (!this.bridges.some(bridge => bridge.id === id)) return;
        await this.commit(ctx => ctx.removeBridge(id));
    }

    private putPlacement(ctx: WorkspaceMutation, nodeId: string, spaceId: string, parentPlacementId: string | null): WorkspacePlacement {
        const existing = Array.from(ctx.placements.values())
            .find(placement => placement.nodeId === nodeId && placement.spaceId === spaceId);
        if (existing) {
            ctx.updatePlacement(existing.id, placement => { placement.parentPlacementId = parentPlacementId; });
            return existing;
        }
        const placement: WorkspacePlacement = {
            id: placementIdFor(nodeId, spaceId),
            nodeId,
            spaceId,
            parentPlacementId,
        };
        ctx.putPlacement(placement);
        return placement;
    }

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
     * 把 vault 文件关联到某 MOC:
     * 若该文件还没有对应工作区节点,按路径建 note 或 MOC 节点,再建立正确的容器链。
     */
    async associateFileToMoc(mocId: string, file: TFile, spaceId?: string): Promise<void> {
        const moc = this.nodes.get(mocId);
        const mocPlacement = spaceId
            ? this.placementForNodeInSpace(mocId, spaceId)
            : this.placementsOfNode(mocId)[0];
        if (!moc || !mocPlacement) return;
        await this.commit(ctx => {
            let node = this.getNodeByPath(file.path);
            if (!node) {
                const now = Date.now();
                const nodeForFile: WorkspaceNode = isMocPath(file.path)
                    ? { id: genNodeId(), type: 'moc', spaceId: mocPlacement.spaceId, title: fileNodeTitle(file.path), filePath: file.path, createdAt: now, updatedAt: now }
                    : { id: genNodeId(), type: 'note', spaceId: mocPlacement.spaceId, title: file.basename, filePath: file.path, createdAt: now, updatedAt: now };
                ctx.put(nodeForFile);
                node = nodeForFile;
            }
            this.putPlacement(ctx, node.id, mocPlacement.spaceId, mocPlacement.id);
            ctx.addLink({ from: node.id, to: mocId, type: node.type === 'moc' ? 'childMoc' : 'partOf' });
        });
    }

    /**
     * vault 文件被重命名:把所有指向 oldPath 的节点 filePath 改到 newPath。
     * 标题仅在它仍等于旧 basename(即用户没改过名)时跟随更新,避免覆盖自定义标题。
     */
    async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        const affected = this.getAllNodes().filter(n => (n as { filePath?: string }).filePath === oldPath);
        if (affected.length === 0) return;
        const oldBase = fileNodeTitle(oldPath);
        const newBase = fileNodeTitle(newPath);
        await this.commit(ctx => {
            for (const n of affected) {
                ctx.update(n.id, x => {
                    (x as { filePath?: string }).filePath = newPath;
                    if (x.title === oldBase) x.title = newBase;
                });
            }
        });
    }

    /**
     * vault 文件被删除:指向它的节点不直接连带删除(可能挂着关联/项目数据)。
     * - 纯文件指针笔记(note 且无 body)→ 删节点(连带解链),等同 Space 行为。
     * - 其余节点(moc/map/project/有正文的 note)→ 仅清空 filePath,保留节点与关联。
     */
    async handleFileDelete(path: string): Promise<void> {
        const affected = this.getAllNodes().filter(n => (n as { filePath?: string }).filePath === path);
        if (affected.length === 0) return;
        await this.commit(ctx => {
            for (const n of affected) {
                if (n.type === 'note' && !(n as WSNoteNode).body) {
                    ctx.remove(n.id);
                } else {
                    ctx.update(n.id, x => { delete (x as { filePath?: string }).filePath; });
                }
            }
        });
    }

    // ---------- 容器写操作(文件夹抽屉用,Option A:MOC 当容器)----------

    /**
     * 把一批已存在的 vault 文件挂到容器(MOC 或 Space)下。
     * - 文件无对应节点 → 按扩展名就地建节点:`.moc.md`/`.moc` → moc 节点,其余 → note 节点(都指向真实文件)。
     * - 容器是 MOC → moc 子节点加 childMoc 链、其余加 partOf 链(去重,支持一个文件多父)。
     * - 容器是 Space → 追加 Space 归属，作为该 Space 顶层节点(无容器边)。
     * - opts.mocIsTop:挂到 Space 顶层时,按当前镜头决定 MOC 落「总览」(true)还是「主题」(false);
     *   undefined 表示不指定(沿用默认/既有值)。见 issue #71。
     * 返回新建的节点数。
     */
    async mountFilesToContainer(containerId: string, paths: string[], opts?: { mocIsTop?: boolean; spaceId?: string }): Promise<number> {
        const container = this.nodes.get(containerId);
        const location = this.placementForContainer(containerId, opts?.spaceId);
        if (!container || !location) return 0;
        const { spaceId, parentPlacementId } = location;
        let added = 0;
        await this.commit(ctx => {
            for (const path of paths) {
                if (!path) continue;
                let node = this.getNodeByPath(path);
                if (!node) {
                    const now = Date.now();
                    const n: WorkspaceNode = isMocPath(path)
                        ? { id: genNodeId(), type: 'moc', spaceId, title: fileNodeTitle(path), filePath: path, createdAt: now, updatedAt: now, ...(opts?.mocIsTop !== undefined ? { isTop: opts.mocIsTop } : {}) }
                        : { id: genNodeId(), type: 'note', spaceId, title: baseNameNoExt(path), filePath: path, createdAt: now, updatedAt: now };
                    ctx.put(n);
                    node = n;
                    added++;
                }
                this.putPlacement(ctx, node.id, spaceId, parentPlacementId);
                ctx.updateQuiet(node.id, x => {
                    // 挂到 Space 顶层的 MOC:按镜头落总览/主题
                    if (container.type === 'space' && x.type === 'moc' && opts?.mocIsTop !== undefined) x.isTop = opts.mocIsTop;
                });
                if (container.type === 'moc') {
                    ctx.addLink({ from: node.id, to: containerId, type: node.type === 'moc' ? 'childMoc' : node.type === 'project' ? 'serves' : 'partOf' });
                }
            }
        });
        return added;
    }

    /**
     * 项目引用资料:把 vault 文件确保为工作区 Note/MOC 节点,再用 related 链接到项目。
     * 与 MOC 容器挂载不同,这里不改变文件/节点的所属容器。
     */
    async addProjectFileReferences(projectId: string, paths: string[]): Promise<number> {
        const project = this.nodes.get(projectId);
        const projectPlacement = this.placementsOfNode(projectId)[0];
        if (!project || project.type !== 'project' || !projectPlacement) return 0;
        let added = 0;
        await this.commit(ctx => {
            for (const path of paths) {
                if (!path) continue;
                let node = this.getNodeByPath(path);
                if (!node) {
                    const now = Date.now();
                    const n: WorkspaceNode = isMocPath(path)
                        ? { id: genNodeId(), type: 'moc', spaceId: projectPlacement.spaceId, title: fileNodeTitle(path), filePath: path, createdAt: now, updatedAt: now }
                        : { id: genNodeId(), type: 'note', spaceId: projectPlacement.spaceId, title: baseNameNoExt(path), filePath: path, createdAt: now, updatedAt: now };
                    ctx.put(n);
                    node = n;
                }
                if (this.placementsOfNode(node.id).length === 0) {
                    this.putPlacement(ctx, node.id, projectPlacement.spaceId, null);
                }
                const before = ctx.links.length;
                ctx.addLink({ from: projectId, to: node.id, type: 'related' });
                if (ctx.links.length > before) added++;
            }
        });
        return added;
    }

    /** 在容器(MOC/Space)下新建子 MOC(= 文件夹)。容器是 MOC 时加 childMoc 链。 */
    async createChildMoc(containerId: string, title: string, requestedSpaceId?: string): Promise<WSMocNode | null> {
        const container = this.nodes.get(containerId);
        const location = this.placementForContainer(containerId, requestedSpaceId);
        if (!container || !location) return null;
        const { spaceId, parentPlacementId } = location;
        const id = genNodeId(); const now = Date.now();
        const node: WSMocNode = {
            id, type: 'moc', spaceId, title: title.trim() || '未命名 MOC', createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => {
            ctx.put(node);
            this.putPlacement(ctx, node.id, spaceId, parentPlacementId);
            if (container.type === 'moc') ctx.addLink({ from: id, to: containerId, type: 'childMoc' });
        });
        return node;
    }

    /** 折叠/展开(树视图状态,不刷新 updatedAt) */
    async setCollapsed(nodeId: string, collapsed: boolean): Promise<void> {
        const n = this.nodes.get(nodeId);
        if (!n || !!n.collapsed === collapsed) return;
        await this.commit(ctx => ctx.updateQuiet(nodeId, x => { x.collapsed = collapsed; }));
    }

    /** 批量展开(自动展开当前 MOC 祖先链时合并一次 commit) */
    async expandNodes(nodeIds: string[]): Promise<void> {
        const targets = nodeIds.filter(id => this.nodes.get(id)?.collapsed);
        if (targets.length === 0) return;
        await this.commit(ctx => { for (const id of targets) ctx.updateQuiet(id, x => { x.collapsed = false; }); });
    }

    /** 移动一个明确 Placement 子树；不会改写节点在其他 Space 的位置。 */
    async reparent(nodeId: string, toContainerId: string, sourceSpaceId?: string): Promise<boolean> {
        const node = this.nodes.get(nodeId);
        const target = this.nodes.get(toContainerId);
        const source = sourceSpaceId
            ? this.placementForNodeInSpace(nodeId, sourceSpaceId)
            : this.placementsOfNode(nodeId)[0];
        const targetLocation = target?.type === 'space'
            ? this.placementForContainer(toContainerId, target.id)
            : this.placementForContainer(toContainerId, source?.spaceId)
                ?? this.placementForContainer(toContainerId);
        if (!node || !target || !source || !targetLocation || node.id === target.id || node.type === 'space') return false;
        if (source.spaceId === targetLocation.spaceId && source.parentPlacementId === targetLocation.parentPlacementId) return false;
        const subtreeIds = this.collectPlacementSubtreeIds(source.id);
        if (targetLocation.parentPlacementId && subtreeIds.includes(targetLocation.parentPlacementId)) return false;
        const subtree = subtreeIds
            .map(id => this.placements.get(id))
            .filter((placement): placement is WorkspacePlacement => !!placement);
        const subtreeNodeIds = new Set(subtree.map(placement => placement.nodeId));
        const destinationConflict = this.getAllPlacements().some(placement => placement.spaceId === targetLocation.spaceId
            && subtreeNodeIds.has(placement.nodeId) && !subtreeIds.includes(placement.id));
        if (destinationConflict) return false;

        const oldParent = source.parentPlacementId ? this.placements.get(source.parentPlacementId) : null;
        const oldParentNodeId = oldParent?.nodeId;
        await this.commit(ctx => {
            if (source.spaceId === targetLocation.spaceId) {
                ctx.updatePlacement(source.id, placement => { placement.parentPlacementId = targetLocation.parentPlacementId; });
            } else {
                const replacementIds = new Map<string, string>();
                for (const placement of subtree) {
                    replacementIds.set(placement.id, placementIdFor(placement.nodeId, targetLocation.spaceId));
                }
                for (const placement of subtree) ctx.removePlacement(placement.id);
                for (const placement of subtree) {
                    const isRoot = placement.id === source.id;
                    const nextId = replacementIds.get(placement.id)!;
                    const nextParentId = isRoot
                        ? targetLocation.parentPlacementId
                        : placement.parentPlacementId ? replacementIds.get(placement.parentPlacementId) ?? null : null;
                    ctx.putPlacement({
                        ...placement,
                        id: nextId,
                        spaceId: targetLocation.spaceId,
                        parentPlacementId: nextParentId,
                    });
                }
                ctx.bridges = ctx.bridges.map(bridge => {
                    const nextPlacementId = bridge.placementId ? replacementIds.get(bridge.placementId) : undefined;
                    return nextPlacementId ? { ...bridge, placementId: nextPlacementId, updatedAt: Date.now() } : bridge;
                });
            }

            if (oldParentNodeId) {
                const oldRelationStillPlaced = Array.from(ctx.placements.values()).some(placement => {
                    if (placement.nodeId !== nodeId || !placement.parentPlacementId) return false;
                    return ctx.placements.get(placement.parentPlacementId)?.nodeId === oldParentNodeId;
                });
                if (!oldRelationStillPlaced) {
                    for (const link of ctx.links.filter(link => link.from === nodeId && link.to === oldParentNodeId && this.isContainmentLink(link))) {
                        ctx.removeLink(link.from, link.to, link.type);
                    }
                }
            }
            if (target.type === 'moc') {
                const linkType: LinkType = node.type === 'moc' ? 'childMoc'
                    : node.type === 'project' ? 'serves' : 'partOf';
                ctx.addLink({ from: nodeId, to: toContainerId, type: linkType });
            }
        });
        return true;
    }

    /** 从指定容器解挂文件：MOC 下浮到同 Space 根；Space 根则只移除该 Placement。 */
    async unmountFileFromContainer(path: string, containerId: string, spaceId?: string): Promise<boolean> {
        const container = this.nodes.get(containerId);
        if (!container) return false;
        const locations = this.locationsHostingFile(path).filter(location => {
            if (spaceId && location.placement.spaceId !== spaceId) return false;
            return container.type === 'space'
                ? location.placement.spaceId === container.id && location.placement.parentPlacementId === null
                : location.container.id === containerId;
        });
        if (locations.length === 0) return false;
        await this.commit(ctx => {
            for (const location of locations) {
                if (container.type === 'space') {
                    ctx.removePlacement(location.placement.id);
                } else {
                    ctx.updatePlacement(location.placement.id, placement => { placement.parentPlacementId = null; });
                }
            }
            if (container.type === 'moc') {
                for (const nodeId of new Set(locations.map(location => location.node.id))) {
                    const relationStillPlaced = Array.from(ctx.placements.values()).some(placement => {
                        if (placement.nodeId !== nodeId || !placement.parentPlacementId) return false;
                        return ctx.placements.get(placement.parentPlacementId)?.nodeId === containerId;
                    });
                    if (!relationStillPlaced) {
                        for (const link of ctx.links.filter(link => link.from === nodeId && link.to === containerId && this.isContainmentLink(link))) {
                            ctx.removeLink(link.from, link.to, link.type);
                        }
                    }
                }
            }
        });
        return true;
    }

    /** 从一个 Space 移除节点的 Placement 子树，其他 Space 与节点身份全部保留。 */
    async unmountNodeFromSpace(nodeId: string, spaceId: string): Promise<boolean> {
        const placement = this.placementForNodeInSpace(nodeId, spaceId);
        if (!placement) return false;
        await this.deletePlacementSubtree(placement.id);
        return true;
    }

    /** 从指定 MOC 容器移出到当前 Space 根；未指定容器时处理首个有父位置。 */
    async unmountFromContainer(nodeId: string, containerId?: string, spaceId?: string): Promise<boolean> {
        const placement = spaceId
            ? this.placementForNodeInSpace(nodeId, spaceId)
            : this.placementsOfNode(nodeId).find(item => item.parentPlacementId !== null);
        if (!placement?.parentPlacementId) return false;
        const parent = this.placements.get(placement.parentPlacementId);
        if (!parent || (containerId && parent.nodeId !== containerId)) return false;
        await this.commit(ctx => {
            ctx.updatePlacement(placement.id, item => { item.parentPlacementId = null; });
            const relationStillPlaced = Array.from(ctx.placements.values()).some(item => item.nodeId === nodeId
                && item.parentPlacementId !== null
                && ctx.placements.get(item.parentPlacementId)?.nodeId === parent.nodeId);
            if (!relationStillPlaced) {
                for (const link of ctx.links.filter(link => link.from === nodeId && link.to === parent.nodeId && this.isContainmentLink(link))) {
                    ctx.removeLink(link.from, link.to, link.type);
                }
            }
        });
        return true;
    }

    async deletePlacementSubtree(placementId: string): Promise<void> {
        const ids = this.collectPlacementSubtreeIds(placementId);
        if (ids.length === 0) return;
        await this.commit(ctx => { for (const id of ids.reverse()) ctx.removePlacement(id); });
    }

    /** 默认只删除当前位置子树；Space 删除也只清该 Space 的 Placement，不波及共享实体。 */
    async deleteSubtree(nodeId: string, spaceId?: string): Promise<void> {
        const node = this.nodes.get(nodeId);
        if (!node) return;
        if (node.type === 'space') {
            const placementIds = this.getAllPlacements()
                .filter(placement => placement.spaceId === node.id)
                .map(placement => placement.id);
            await this.commit(ctx => {
                for (const id of placementIds.reverse()) ctx.removePlacement(id);
                ctx.remove(node.id);
            });
            return;
        }
        const placement = spaceId
            ? this.placementForNodeInSpace(nodeId, spaceId)
            : this.placementsOfNode(nodeId)[0];
        if (placement) await this.deletePlacementSubtree(placement.id);
    }

    /** 二级危险操作：仅允许永久清理已无任何 Placement 的孤立实体。 */
    async deleteOrphanNode(nodeId: string): Promise<boolean> {
        const node = this.nodes.get(nodeId);
        if (!node || node.type === 'space' || this.placementsOfNode(nodeId).length > 0) return false;
        await this.commit(ctx => ctx.remove(nodeId));
        return true;
    }

    async createProject(spaceId: string, title: string): Promise<WSProjectNode> {
        const id = genNodeId(); const now = Date.now();
        const node: WSProjectNode = {
            id, type: 'project', spaceId, title: title.trim() || '未命名项目',
            status: 'todo', createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => {
            ctx.put(node);
            this.putPlacement(ctx, node.id, spaceId, null);
        });
        return node;
    }

    /** 新建项目并立即创建背书文件。Project 是工作区实体，文件承载正文与 markdown 任务。 */
    async createProjectWithFile(spaceId: string, title: string, folderPath: string, tag = ''): Promise<WSProjectNode> {
        const cleanTitle = title.trim() || '未命名项目';
        const file = await this.createProjectBackingFile(cleanTitle, folderPath, tag);
        const id = genNodeId(); const now = Date.now();
        const node: WSProjectNode = {
            id, type: 'project', spaceId, title: cleanTitle,
            status: 'todo', filePath: file.path, createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => {
            ctx.put(node);
            this.putPlacement(ctx, node.id, spaceId, null);
        });
        return node;
    }

    /**
     * 把已有 markdown 文件导入为项目主文件。
     * 同一路径若已是 Note/MOC，则显式重分类为 Project，避免一个文件在工作区有两个身份。
     * 原容器关系会转换为 Project→Area(serves)或项目引用(related)。
     */
    async importProjectFiles(spaceId: string, paths: string[]): Promise<{ projects: WSProjectNode[]; converted: number }> {
        const files: TFile[] = [];
        const seen = new Set<string>();
        for (const path of paths) {
            if (!path || seen.has(path)) continue;
            seen.add(path);
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile && file.extension.toLowerCase() === 'md') files.push(file);
        }

        const projects: WSProjectNode[] = [];
        let converted = 0;
        await this.commit(ctx => {
            for (const file of files) {
                const existing = this.getNodeByPath(file.path);
                if (existing?.type === 'project') continue;

                const now = Date.now();
                const project: WSProjectNode = {
                    id: existing?.id ?? genNodeId(),
                    type: 'project',
                    spaceId,
                    title: existing?.title ?? baseNameNoExt(file.path).replace(/\.moc$/, ''),
                    status: 'todo',
                    filePath: file.path,
                    createdAt: existing?.createdAt ?? now,
                    updatedAt: now,
                    ...(existing?.icon ? { icon: existing.icon } : {}),
                    ...(existing?.color ? { color: existing.color } : {}),
                    ...(existing?.order !== undefined ? { order: existing.order } : {}),
                };

                if (existing) {
                    const oldLinks = ctx.links.filter(l => l.from === existing.id || l.to === existing.id);
                    const oldPlacements = Array.from(ctx.placements.values())
                        .filter(placement => placement.nodeId === existing.id)
                        .map(placement => ({ ...placement }));
                    ctx.remove(existing.id);
                    ctx.put(project);
                    for (const placement of oldPlacements) ctx.putPlacement(placement);
                    for (const link of oldLinks) {
                        if (link.from === existing.id && (link.type === 'childMoc' || link.type === 'partOf')) {
                            ctx.addLink({ from: project.id, to: link.to, type: 'serves' });
                        } else if (link.to === existing.id && (link.type === 'childMoc' || link.type === 'partOf')) {
                            ctx.addLink({ from: project.id, to: link.from, type: 'related' });
                        } else if (link.to === existing.id && link.type === 'serves') {
                            ctx.addLink({ from: link.from, to: project.id, type: 'related' });
                        } else {
                            ctx.addLink(link);
                        }
                    }
                    converted++;
                } else {
                    ctx.put(project);
                }
                if (!Array.from(ctx.placements.values()).some(placement => placement.nodeId === project.id && placement.spaceId === spaceId)) {
                    this.putPlacement(ctx, project.id, spaceId, null);
                }
                projects.push(project);
            }
        });
        return { projects, converted };
    }

    /**
     * 确保项目有背书 markdown 笔记(next action 的 `- [ ]` 写在这里)。
     * 已绑定且文件存在 → 直接返回;否则在 folderPath 下按标题建文件,回写 filePath(不刷 updatedAt)。
     */
    async ensureProjectFile(projectId: string, folderPath: string, tag = ''): Promise<TFile | null> {
        const p = this.nodes.get(projectId);
        if (!p || p.type !== 'project') return null;
        const existing = p.filePath ? this.app.vault.getAbstractFileByPath(p.filePath) : null;
        if (existing instanceof TFile) return existing;

        const file = await this.createProjectBackingFile(p.title, folderPath, tag);
        await this.commit(ctx => ctx.updateQuiet(projectId, n => { (n as WSProjectNode).filePath = file.path; }));
        return file;
    }

    private async createProjectBackingFile(title: string, folderPath: string, tag: string): Promise<TFile> {

        const folder = (folderPath || '').replace(/^\/+|\/+$/g, '');
        // 逐级建文件夹:config/workspace 这类父级不存在时,一次性 createFolder 在部分版本会失败
        if (folder) {
            let cur = '';
            for (const part of folder.split('/').filter(Boolean)) {
                cur = cur ? `${cur}/${part}` : part;
                if (!this.app.vault.getAbstractFileByPath(cur)) {
                    try { await this.app.vault.createFolder(cur); } catch { /* 并发/已存在,忽略 */ }
                }
            }
        }
        const base = sanitizeFileName(title) || 'project';
        const dir = folder ? folder + '/' : '';
        let path = `${dir}${base}.md`;
        for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = `${dir}${base} ${i}.md`;
        return await this.app.vault.create(path, projectFileContent(title, tag));
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

    /** 归档/恢复任意工作区条目；Project 沿用 status，其余节点使用 archived 标记。 */
    async setArchived(id: string, archived: boolean): Promise<void> {
        const node = this.nodes.get(id);
        if (!node || node.type === 'space') return;
        const current = node.type === 'project'
            ? node.status === 'archived'
            : node.archived === true;
        if (current === archived) return;
        await this.commit(ctx => ctx.update(id, n => {
            if (n.type === 'space') return;
            if (n.type === 'project') {
                n.status = archived ? 'archived' : 'todo';
            } else if (archived) {
                n.archived = true;
            } else {
                delete n.archived;
            }
        }));
    }

    /** 手动设进度百分比;传 null 清除手动值,回退到任务/ checklist 推导 */
    async setProgress(id: string, pct: number | null): Promise<void> {
        await this.commit(ctx => ctx.update(id, n => {
            if (n.type !== 'project') return;
            if (pct === null) delete n.progress;
            else n.progress = Math.max(0, Math.min(100, Math.round(pct)));
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
        public placements: Map<string, WorkspacePlacement>,
        public links: WSLink[],
        public bridges: MocWorkspaceBridge[],
    ) {}

    put(node: WorkspaceNode): void {
        this.nodes.set(node.id, node);
    }

    putPlacement(placement: WorkspacePlacement): void {
        const duplicate = Array.from(this.placements.values())
            .find(p => p.nodeId === placement.nodeId && p.spaceId === placement.spaceId && p.id !== placement.id);
        if (duplicate) return;
        this.placements.set(placement.id, placement);
    }

    updatePlacement(id: string, fn: (placement: WorkspacePlacement) => void): void {
        const placement = this.placements.get(id);
        if (placement) fn(placement);
    }

    removePlacement(id: string): void {
        this.placements.delete(id);
        for (const placement of this.placements.values()) {
            if (placement.parentPlacementId === id) placement.parentPlacementId = null;
        }
        this.bridges = this.bridges.map(bridge => bridge.placementId === id
            ? { ...bridge, placementId: undefined }
            : bridge);
    }

    update(id: string, fn: (n: WorkspaceNode) => void): void {
        const n = this.nodes.get(id);
        if (!n) return;
        fn(n);
        n.updatedAt = Date.now();
    }

    /** 改字段但不刷新 updatedAt(折叠/排序/结构搬动等 UI 状态,不算"内容更新") */
    updateQuiet(id: string, fn: (n: WorkspaceNode) => void): void {
        const n = this.nodes.get(id);
        if (!n) return;
        fn(n);
    }

    remove(id: string): void {
        this.nodes.delete(id);
        for (const placement of Array.from(this.placements.values())) {
            if (placement.nodeId === id) this.removePlacement(placement.id);
        }
        this.links = this.links.filter(l => l.from !== id && l.to !== id);
        this.bridges = this.bridges.filter(bridge => bridge.workspaceNodeId !== id);
    }

    addLink(link: WSLink): void {
        const dup = this.links.some(l => l.from === link.from && l.to === link.to && l.type === link.type);
        if (!dup) this.links.push(link);
    }

    removeLink(from: string, to: string, type?: string): void {
        this.links = this.links.filter(l => !(l.from === from && l.to === to && (!type || l.type === type)));
    }

    addBridge(bridge: MocWorkspaceBridge): void {
        const duplicate = this.bridges.some(existing => existing.mocPath === bridge.mocPath
            && existing.mocNodeId === bridge.mocNodeId
            && existing.workspaceNodeId === bridge.workspaceNodeId
            && existing.role === bridge.role);
        if (!duplicate) this.bridges.push(bridge);
    }

    removeBridge(id: string): void {
        this.bridges = this.bridges.filter(bridge => bridge.id !== id);
    }
}

/** progress 半自动:有 checklist 才算,否则 null(不显示进度条)。任务态进度在 render 层结合背书笔记 `- [ ]` 计算。 */
export function progressOf(checklist?: ChecklistItem[]): number | null {
    if (!checklist || !checklist.length) return null;
    return Math.round(checklist.filter(i => i.done).length / checklist.length * 100);
}

/** 项目状态机循环切换:未开始→进行中→阻塞→已完成→已归档→循环 */
export function nextStatus(s: WSProjectNode['status']): WSProjectNode['status'] {
    const order: WSProjectNode['status'][] = ['todo', 'active', 'blocked', 'done', 'archived'];
    const i = order.indexOf(s);
    return order[(i + 1) % order.length];
}
