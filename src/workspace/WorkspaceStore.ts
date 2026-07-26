import { App, Component, DataAdapter, TFile } from "obsidian";
import {
    WorkspaceNode, WSLink, WSSpaceNode, WSMocNode, WSProjectNode, WSNoteNode,
    WorkspaceStoreFile, FrameworkId, OpenTarget, targetFor, ChecklistItem,
    LinkType,
} from "src/types/workspace";
import { isMocPath, stripMocSuffix } from "src/utils/utils";

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
    data: WorkspaceStoreFile;
    raw: string | null;
}

async function readStore(adapter: DataAdapter, storePath: string): Promise<WorkspaceStoreSnapshot> {
    const empty: WorkspaceStoreFile = { version: 1, nodes: [], links: [] };
    try {
        if (!(await adapter.exists(storePath))) return { data: empty, raw: null };
        const raw = await adapter.read(storePath);
        const parsed = JSON.parse(raw) as WorkspaceStoreFile;
        if (!parsed || !Array.isArray(parsed.nodes)) return { data: empty, raw };
        return {
            data: {
                version: 1,
                nodes: parsed.nodes,
                links: Array.isArray(parsed.links) ? parsed.links : [],
                // 关键:透传已落盘的迁移版本号,否则每次 reload 都被视作 0、
                // 触发 ensureWorkspaceSeed 重迁并覆盖用户新建数据
                migrationVersion: typeof parsed.migrationVersion === 'number' ? parsed.migrationVersion : 0,
            },
            raw,
        };
    } catch (e) {
        console.warn('[zk-navigation] workspace.json 读取失败:', storePath, e);
        return { data: empty, raw: null };
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
    private links: WSLink[] = [];
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

    /** 写入前检测磁盘是否已被外部同步替换,防止旧内存快照覆盖远端数据。 */
    private async refreshIfDiskChanged(): Promise<void> {
        const snapshot = await readStore(this.app.vault.adapter, this.storePath);
        if (snapshot.raw === this.lastDiskContent) return;
        await this.applySnapshot(snapshot);
    }

    private async applySnapshot(snapshot: WorkspaceStoreSnapshot): Promise<void> {
        const { data } = snapshot;
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
                this.nodes.set(n.id, {
                    ...moc,
                });
                reclassifiedMocIds.add(n.id);
            } else {
                this.nodes.set(n.id, n);
            }
        }
        this.links = data.links
            .filter(l => this.nodes.has(l.from) && this.nodes.has(l.to))
            .map(l => reclassifiedMocIds.has(l.from) && l.type === 'partOf'
                ? { ...l, type: 'childMoc' as const }
                : l);
        this.migrationVersion = data.migrationVersion ?? 0;
        if (reclassifiedMocIds.size > 0) await this.flush();
        this.emitChange();
    }

    /**
     * 统一变更入口:在 mutator 里改 nodes/links;自动落盘 + 通知。
     * mutator 收到 helpers 以便创建/触碰节点。
     */
    async commit(mutator: (ctx: WorkspaceMutation) => void | Promise<void>): Promise<void> {
        await this.refreshIfDiskChanged();
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
        return this.getAllNodes().find(n => (n as { filePath?: string }).filePath === path);
    }
    getAllNodes(): WorkspaceNode[] { return Array.from(this.nodes.values()); }
    isEmpty(): boolean { return this.nodes.size === 0; }
    getAllLinks(): WSLink[] { return this.links.slice(); }

    getNodeSpaceIds(nodeId: string): string[] {
        const node = this.nodes.get(nodeId);
        return node ? this.nodeSpaceIds(node) : [];
    }

    /** 节点所有所属 Space，spaceId 保持为兼容旧数据的主归属。 */
    private nodeSpaceIds(node: WorkspaceNode): string[] {
        return Array.from(new Set([node.spaceId, ...(node.spaceIds ?? [])]));
    }

    private addNodeToSpace(node: WorkspaceNode, spaceId: string): void {
        if (node.spaceId === spaceId || node.spaceIds?.includes(spaceId)) return;
        node.spaceIds = [...(node.spaceIds ?? []), spaceId];
    }

    /** 移除一个 Space 归属；返回 true 表示已无任何 Space，应删除该节点。 */
    private removeNodeFromSpace(node: WorkspaceNode, spaceId: string): boolean {
        if (node.spaceId !== spaceId) {
            const remaining = (node.spaceIds ?? []).filter(id => id !== spaceId);
            if (remaining.length) node.spaceIds = remaining;
            else delete node.spaceIds;
            return false;
        }
        const [nextPrimary, ...remaining] = node.spaceIds ?? [];
        if (!nextPrimary) return true;
        node.spaceId = nextPrimary;
        if (remaining.length) node.spaceIds = remaining;
        else delete node.spaceIds;
        return false;
    }

    /** 所有 Space 节点,按 createdAt 排序 */
    getSpaces(): WSSpaceNode[] {
        return this.getAllNodes()
            .filter((n): n is WSSpaceNode => n.type === 'space')
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /** 某 Space 下的全部非 Space 节点 */
    nodesInSpace(spaceId: string): WorkspaceNode[] {
        return this.getAllNodes().filter(n => n.type !== 'space' && this.nodeSpaceIds(n).includes(spaceId));
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

    /** 节点的父容器 id(指向的容器);无容器边时返回其 Space id;Space 自身返回 null */
    parentContainerOf(nodeId: string): string | null {
        const n = this.nodes.get(nodeId);
        if (!n || n.type === 'space') return null;
        const up = this.linksFrom(nodeId).find(l => this.isContainmentLink(l) && this.nodes.has(l.to));
        return up ? up.to : n.spaceId;
    }

    /** 容器(Space 或 MOC)的直接子节点,已排序 */
    containerChildren(containerId: string): WorkspaceNode[] {
        const container = this.nodes.get(containerId);
        if (!container) return [];
        if (container.type === 'space') {
            // Space 顶层 = 属于本 space、且不指向本 space 内任何容器的节点
            const inSpace = this.nodesInSpace(containerId);
            const idSet = new Set(inSpace.map(n => n.id));
            return inSpace
                .filter(n => !this.linksFrom(n.id).some(l => this.isContainmentLink(l) && idSet.has(l.to)))
                .sort(this.cmpOrder);
        }
        const childIds = this.links
            .filter(l => l.to === containerId && this.isContainmentLink(l))
            .map(l => l.from);
        return Array.from(new Set(childIds))
            .map(id => this.nodes.get(id))
            .filter((n): n is WorkspaceNode => !!n)
            .sort(this.cmpOrder);
    }

    /** 该容器(含其后代容器)下所有节点 id,用于子树删除/防环 */
    collectSubtreeIds(containerId: string): string[] {
        const out: string[] = [];
        const visit = (id: string) => {
            out.push(id);
            for (const c of this.containerChildren(id)) visit(c.id);
        };
        visit(containerId);
        return out;
    }

    /** vault 文件是否已在工作区有节点(= 已"挂载") */
    isFileMounted(path: string): boolean {
        return this.getAllNodes().some(n => (n as { filePath?: string }).filePath === path);
    }

    /** 文件是否已挂在指定容器下 */
    isFileMountedIn(path: string, containerId: string): boolean {
        return this.containersHostingFile(path).some(c => c.id === containerId);
    }

    /** 全部容器(Space + MOC),供挂载选择器列出 */
    getContainers(): WorkspaceNode[] {
        return this.getAllNodes().filter(n => n.type === 'space' || n.type === 'moc');
    }

    /** 节点展示路径:从根容器到自身的标题链,用 / 连接 */
    displayPath(nodeId: string): string {
        const parts: string[] = [];
        const seen = new Set<string>();
        let cur: string | null = nodeId;
        while (cur && !seen.has(cur)) {
            seen.add(cur);
            const n = this.nodes.get(cur);
            if (!n) break;
            parts.unshift(n.title);
            cur = this.parentContainerOf(cur);
        }
        return parts.join(' / ');
    }

    /** 承载某文件的父容器节点(去重) */
    containersHostingFile(path: string): WorkspaceNode[] {
        const hosts = new Set<string>();
        for (const n of this.getAllNodes()) {
            if ((n as { filePath?: string }).filePath !== path) continue;
            const parentIds = this.linksFrom(n.id)
                .filter(l => this.isContainmentLink(l))
                .map(l => l.to);
            if (parentIds.length > 0) {
                parentIds.forEach(id => hosts.add(id));
            }
            this.nodeSpaceIds(n).forEach(id => hosts.add(id));
        }
        return Array.from(hosts)
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
     * 把 vault 文件关联到某 MOC:
     * 若该文件还没有对应工作区节点,按路径建 note 或 MOC 节点,再建立正确的容器链。
     */
    async associateFileToMoc(mocId: string, file: TFile): Promise<void> {
        const moc = this.nodes.get(mocId);
        if (!moc) return;
        await this.commit(ctx => {
            let node = this.getNodeByPath(file.path);
            if (!node) {
                const now = Date.now();
                const nodeForFile: WorkspaceNode = isMocPath(file.path)
                    ? { id: genNodeId(), type: 'moc', spaceId: moc.spaceId, title: fileNodeTitle(file.path), filePath: file.path, createdAt: now, updatedAt: now }
                    : { id: genNodeId(), type: 'note', spaceId: moc.spaceId, title: file.basename, filePath: file.path, createdAt: now, updatedAt: now };
                ctx.put(nodeForFile);
                node = nodeForFile;
            }
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
    async mountFilesToContainer(containerId: string, paths: string[], opts?: { mocIsTop?: boolean }): Promise<number> {
        const container = this.nodes.get(containerId);
        if (!container) return 0;
        const spaceId = container.type === 'space' ? container.id : container.spaceId;
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
                ctx.updateQuiet(node.id, x => {
                    if (x.type === 'space') return;
                    this.addNodeToSpace(x, spaceId);
                    // 挂到 Space 顶层的 MOC:按镜头落总览/主题
                    if (container.type === 'space' && x.type === 'moc' && opts?.mocIsTop !== undefined) x.isTop = opts.mocIsTop;
                });
                if (container.type === 'moc') {
                    ctx.addLink({ from: node.id, to: containerId, type: node.type === 'moc' ? 'childMoc' : 'partOf' });
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
        if (!project || project.type !== 'project') return 0;
        let added = 0;
        await this.commit(ctx => {
            for (const path of paths) {
                if (!path) continue;
                let node = this.getNodeByPath(path);
                if (!node) {
                    const now = Date.now();
                    const n: WorkspaceNode = isMocPath(path)
                        ? { id: genNodeId(), type: 'moc', spaceId: project.spaceId, title: fileNodeTitle(path), filePath: path, createdAt: now, updatedAt: now }
                        : { id: genNodeId(), type: 'note', spaceId: project.spaceId, title: baseNameNoExt(path), filePath: path, createdAt: now, updatedAt: now };
                    ctx.put(n);
                    node = n;
                }
                const before = ctx.links.length;
                ctx.addLink({ from: projectId, to: node.id, type: 'related' });
                if (ctx.links.length > before) added++;
            }
        });
        return added;
    }

    /** 在容器(MOC/Space)下新建子 MOC(= 文件夹)。容器是 MOC 时加 childMoc 链。 */
    async createChildMoc(containerId: string, title: string): Promise<WSMocNode | null> {
        const container = this.nodes.get(containerId);
        if (!container) return null;
        const spaceId = container.type === 'space' ? container.id : container.spaceId;
        const id = genNodeId(); const now = Date.now();
        const node: WSMocNode = {
            id, type: 'moc', spaceId, title: title.trim() || '未命名 MOC', createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => {
            ctx.put(node);
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

    /**
     * 把节点重新挂到新容器下(拖拽重挂)。
     * - 目标是 Space:解掉容器边,改主 Space 成为顶层。
     * - 目标是 MOC:解掉旧容器边,按节点类型加 childMoc/serves/partOf,并同步整棵子树 spaceId。
     * 防环:不能挂到自身或后代下。返回是否发生移动。
     */
    async reparent(nodeId: string, toContainerId: string): Promise<boolean> {
        const node = this.nodes.get(nodeId);
        const target = this.nodes.get(toContainerId);
        if (!node || !target || node.id === target.id || node.type === 'space') return false;
        if (this.parentContainerOf(nodeId) === toContainerId) return false;
        const subtree = this.collectSubtreeIds(nodeId);
        if (subtree.includes(toContainerId)) return false;
        const outLinks = this.linksFrom(nodeId).filter(l => this.isContainmentLink(l));
        const newSpaceId = target.type === 'space' ? target.id : target.spaceId;
        await this.commit(ctx => {
            for (const l of outLinks) ctx.removeLink(l.from, l.to, l.type);
            for (const id of subtree) ctx.updateQuiet(id, x => {
                if (x.type === 'space') return;
                x.spaceId = newSpaceId;
                delete x.spaceIds;
            });
            if (target.type === 'moc') {
                const linkType: LinkType = node.type === 'moc' ? 'childMoc'
                    : node.type === 'project' ? 'serves' : 'partOf';
                ctx.addLink({ from: nodeId, to: toContainerId, type: linkType });
            }
        });
        return true;
    }

    /** 从指定容器解挂某文件:MOC → 删容器链;Space 顶层 → 删裸指针节点。 */
    async unmountFileFromContainer(path: string, containerId: string): Promise<boolean> {
        const container = this.nodes.get(containerId);
        if (!container) return false;
        const targets = this.getAllNodes()
            .filter(n => {
                if ((n as { filePath?: string }).filePath !== path) return false;
                const containerLinks = this.linksFrom(n.id).filter(l => this.isContainmentLink(l));
                return container.type === 'moc'
                    ? containerLinks.some(l => l.to === containerId)
                    : this.nodeSpaceIds(n).includes(containerId) && containerLinks.length === 0;
            });
        if (targets.length === 0) return false;
        await this.commit(ctx => {
            for (const node of targets) {
                if (container.type === 'moc') {
                    for (const l of this.linksFrom(node.id)) {
                        if (this.isContainmentLink(l) && l.to === containerId) ctx.removeLink(l.from, l.to, l.type);
                    }
                } else {
                    let removeNode = false;
                    ctx.updateQuiet(node.id, x => {
                        if (x.type !== 'space') removeNode = this.removeNodeFromSpace(x, containerId);
                    });
                    if (removeNode) ctx.remove(node.id);
                }
            }
        });
        return true;
    }

    /** 共享节点从一个 Space 移出，保留其余 Space 中的同一节点和全部子树。 */
    async unmountNodeFromSpace(nodeId: string, spaceId: string): Promise<boolean> {
        const node = this.nodes.get(nodeId);
        if (!node || node.type === 'space' || !this.nodeSpaceIds(node).includes(spaceId)) return false;
        if (this.nodeSpaceIds(node).length < 2) return false;
        await this.commit(ctx => ctx.updateQuiet(nodeId, n => {
            if (n.type !== 'space') this.removeNodeFromSpace(n, spaceId);
        }));
        return true;
    }

    /** 从指定容器解挂；未指定容器时保留旧行为，移除全部容器关系。 */
    async unmountFromContainer(nodeId: string, containerId?: string): Promise<boolean> {
        const outLinks = this.linksFrom(nodeId)
            .filter(l => this.isContainmentLink(l) && (!containerId || l.to === containerId));
        if (outLinks.length === 0) return false;
        await this.commit(ctx => { for (const l of outLinks) ctx.removeLink(l.from, l.to, l.type); });
        return true;
    }

    /** 删除节点及其容器子树(连带解链) */
    async deleteSubtree(nodeId: string): Promise<void> {
        const ids = this.collectSubtreeIds(nodeId);
        if (ids.length === 0) return;
        await this.commit(ctx => { for (const id of ids) ctx.remove(id); });
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

    /** 新建项目并立即创建背书文件。Project 是工作区实体，文件承载正文与 markdown 任务。 */
    async createProjectWithFile(spaceId: string, title: string, folderPath: string, tag = ''): Promise<WSProjectNode> {
        const cleanTitle = title.trim() || '未命名项目';
        const file = await this.createProjectBackingFile(cleanTitle, folderPath, tag);
        const id = genNodeId(); const now = Date.now();
        const node: WSProjectNode = {
            id, type: 'project', spaceId, title: cleanTitle,
            status: 'todo', filePath: file.path, createdAt: now, updatedAt: now,
        };
        await this.commit(ctx => ctx.put(node));
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
                    ctx.remove(existing.id);
                    ctx.put(project);
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

    /** 改字段但不刷新 updatedAt(折叠/排序/结构搬动等 UI 状态,不算"内容更新") */
    updateQuiet(id: string, fn: (n: WorkspaceNode) => void): void {
        const n = this.nodes.get(id);
        if (!n) return;
        fn(n);
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
