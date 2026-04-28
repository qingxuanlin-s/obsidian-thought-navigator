import { App, Component } from "obsidian";
import { FolderNode } from "src/types/folder";
import { readSpaceStore, writeSpaceStore } from "src/services/folderJson";

type ChangeListener = () => void;

/**
 * 内存中的 Space 树索引。
 *
 * 持久化:整棵树存在 storePath(插件数据目录下的 spaces.json),
 * 不再为每个文件夹在 vault 创建真实目录。
 *
 * 写路径:SpaceService → index.commit(mutator) → 重建派生字段 → 写 spaces.json → emit。
 */
export class VaultIndex extends Component {
    private app: App;
    private storePath: string;
    private nodes: Map<string, FolderNode> = new Map(); // id → node
    private rootIds: string[] = [];
    /** mocPath → folderIds 反向索引,O(1) 查询某 MOC 挂在哪些文件夹下 */
    private mocToFolders: Map<string, Set<string>> = new Map();
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

    /** 从磁盘重新加载(仅在初始化或外部数据被替换时使用) */
    async reload(): Promise<void> {
        const list = await readSpaceStore(this.app.vault.adapter, this.storePath);
        this.nodes.clear();
        for (const n of list) this.nodes.set(n.id, n);
        this.rebuildTree();
        this.rebuildMocReverseMap();
        this.emitChange();
    }

    /**
     * SpaceService 用的统一变更入口:
     * 1. 在 mutator 里随便改 nodes;2. 自动重建 childIds/depth/反向索引;3. 串行落盘;4. 通知监听者。
     */
    async commit(mutator: (nodes: Map<string, FolderNode>) => void | Promise<void>): Promise<void> {
        await mutator(this.nodes);
        this.rebuildTree();
        this.rebuildMocReverseMap();
        this.emitChange();
        // 串行写磁盘,避免并发覆盖
        this.flushChain = this.flushChain.then(() => this.flush()).catch((e) => {
            console.error('[zk-navigation] spaces.json 写入失败', e);
        });
        await this.flushChain;
    }

    private async flush(): Promise<void> {
        await writeSpaceStore(this.app.vault.adapter, this.storePath, Array.from(this.nodes.values()));
    }

    private rebuildMocReverseMap(): void {
        this.mocToFolders.clear();
        for (const node of this.nodes.values()) {
            if (!node.mocRefs) continue;
            for (const p of node.mocRefs) {
                let set = this.mocToFolders.get(p);
                if (!set) { set = new Set(); this.mocToFolders.set(p, set); }
                set.add(node.id);
            }
        }
    }

    /** 根据 nodes 中的 parentId 重建 childIds / depth / rootIds */
    private rebuildTree(): void {
        this.rootIds = [];
        for (const node of this.nodes.values()) {
            node.childIds = [];
        }
        for (const node of this.nodes.values()) {
            if (node.parentId && this.nodes.has(node.parentId)) {
                this.nodes.get(node.parentId)!.childIds.push(node.id);
            } else {
                node.parentId = null;
                this.rootIds.push(node.id);
            }
        }
        const orderSort = (a: string, b: string) => {
            const na = this.nodes.get(a)!;
            const nb = this.nodes.get(b)!;
            if (na.order !== nb.order) return na.order - nb.order;
            return na.name.localeCompare(nb.name, 'zh');
        };
        this.rootIds.sort(orderSort);
        for (const node of this.nodes.values()) {
            node.childIds.sort(orderSort);
        }
        const setDepth = (id: string, d: number) => {
            const n = this.nodes.get(id);
            if (!n) return;
            n.depth = d;
            for (const c of n.childIds) setDepth(c, d + 1);
        };
        for (const id of this.rootIds) setDepth(id, 0);
    }

    // ---------- 查询 API ----------

    getNode(id: string): FolderNode | undefined { return this.nodes.get(id); }
    getRoots(): FolderNode[] {
        return this.rootIds.map(id => this.nodes.get(id)!).filter(Boolean);
    }
    getChildren(id: string): FolderNode[] {
        const n = this.nodes.get(id);
        if (!n) return [];
        return n.childIds.map(cid => this.nodes.get(cid)!).filter(Boolean);
    }
    isEmpty(): boolean { return this.nodes.size === 0; }
    size(): number { return this.nodes.size; }

    /** 返回所有 FolderNode(任意顺序) */
    getAllNodes(): FolderNode[] { return Array.from(this.nodes.values()); }

    /** 该 MOC 被挂在哪些文件夹下 */
    getFoldersHostingMoc(mocPath: string): FolderNode[] {
        const ids = this.mocToFolders.get(mocPath);
        if (!ids) return [];
        return Array.from(ids).map(id => this.nodes.get(id)!).filter(Boolean);
    }

    /** 该 MOC 是否至少挂在一个文件夹下(决定 📐 徽章) */
    isMocMounted(mocPath: string): boolean {
        const set = this.mocToFolders.get(mocPath);
        return !!set && set.size > 0;
    }

    /** 给定文件夹 id,返回该文件夹完整路径(如 "工作 / 2026 Q2 / JVM") */
    getDisplayPath(id: string, separator = ' / '): string {
        const parts: string[] = [];
        let cur: FolderNode | undefined = this.nodes.get(id);
        while (cur) {
            parts.unshift(cur.name);
            cur = cur.parentId ? this.nodes.get(cur.parentId) : undefined;
        }
        return parts.join(separator);
    }

    /** 收集某个节点的所有后代 id(含自身) */
    collectSubtreeIds(rootId: string): string[] {
        const out: string[] = [];
        const dfs = (id: string) => {
            const n = this.nodes.get(id);
            if (!n) return;
            out.push(id);
            for (const c of n.childIds) dfs(c);
        };
        dfs(rootId);
        return out;
    }

    // ---------- 订阅 ----------

    onChange(listener: ChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emitChange(): void {
        for (const l of this.listeners) {
            try { l(); } catch (e) { console.error('[zk-navigation] VaultIndex listener error', e); }
        }
    }
}
