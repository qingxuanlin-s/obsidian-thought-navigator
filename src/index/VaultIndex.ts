import { App, Component, EventRef, TAbstractFile, TFile, TFolder } from "obsidian";
import { FolderNode, FOLDER_META_FILENAME, SPACES_ROOT } from "src/types/folder";
import { metaToNode, readFolderMeta } from "src/services/folderJson";

type ChangeListener = () => void;

/**
 * 内存中的 Space 树索引。
 *
 * - bootstrap 时全量扫描 `zk-spaces/` 下所有 `_folder.json`,构建双向树
 * - 订阅 vault 事件保持同步:create / delete / rename(只关心 _folder.json)
 * - 通过 onChange 让 UI 订阅刷新
 */
export class VaultIndex extends Component {
    private app: App;
    private nodes: Map<string, FolderNode> = new Map(); // id → node
    private pathToId: Map<string, string> = new Map();  // 文件夹 path → id
    private rootIds: string[] = [];
    /** mocPath → folderIds 反向索引,O(1) 查询某 MOC 挂在哪些文件夹下 */
    private mocToFolders: Map<string, Set<string>> = new Map();
    private listeners: Set<ChangeListener> = new Set();
    private bootstrapped = false;

    constructor(app: App) {
        super();
        this.app = app;
    }

    async bootstrap(): Promise<void> {
        if (this.bootstrapped) return;
        await this.scanAll();
        this.subscribeVaultEvents();
        this.bootstrapped = true;
    }

    /** 扫描全部 _folder.json,重建内存树 */
    async scanAll(): Promise<void> {
        this.nodes.clear();
        this.pathToId.clear();
        this.rootIds = [];
        this.mocToFolders.clear();

        const rootFolder = this.app.vault.getAbstractFileByPath(SPACES_ROOT);
        if (!(rootFolder instanceof TFolder)) {
            this.emitChange();
            return;
        }

        const metaFiles: TFile[] = [];
        this.collectFolderMetaFiles(rootFolder, metaFiles);

        for (const f of metaFiles) {
            const meta = await readFolderMeta(this.app.vault, f);
            if (!meta) continue;
            const folderPath = parentDir(f.path);
            const node = metaToNode(meta, folderPath);
            this.nodes.set(node.id, node);
            this.pathToId.set(folderPath, node.id);
        }

        this.rebuildTree();
        this.rebuildMocReverseMap();
        this.emitChange();
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

    private collectFolderMetaFiles(folder: TFolder, out: TFile[]): void {
        for (const child of folder.children) {
            if (child instanceof TFile && child.name === FOLDER_META_FILENAME) {
                out.push(child);
            } else if (child instanceof TFolder) {
                this.collectFolderMetaFiles(child, out);
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
        // 排序
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
        // depth
        const setDepth = (id: string, d: number) => {
            const n = this.nodes.get(id);
            if (!n) return;
            n.depth = d;
            for (const c of n.childIds) setDepth(c, d + 1);
        };
        for (const id of this.rootIds) setDepth(id, 0);
    }

    private subscribeVaultEvents(): void {
        const vault = this.app.vault;
        const onCreate = vault.on('create', (file) => {
            if (this.isFolderMeta(file)) this.scheduleRescan();
        });
        const onDelete = vault.on('delete', (file) => {
            if (this.isFolderMeta(file)) this.scheduleRescan();
        });
        const onRename = vault.on('rename', (file, oldPath) => {
            if (this.isFolderMeta(file) || oldPath.endsWith('/' + FOLDER_META_FILENAME) || oldPath === FOLDER_META_FILENAME) {
                this.scheduleRescan();
                return;
            }
            // 文件夹改名会改变 _folder.json 的 path
            if (file instanceof TFolder) this.scheduleRescan();
        });
        const onModify = vault.on('modify', (file) => {
            if (this.isFolderMeta(file)) this.scheduleRescan();
        });
        this.registerEvent(onCreate);
        this.registerEvent(onDelete);
        this.registerEvent(onRename);
        this.registerEvent(onModify);
    }

    private isFolderMeta(file: TAbstractFile): boolean {
        return file instanceof TFile && file.name === FOLDER_META_FILENAME;
    }

    // 防抖避免重复扫描(用户连续创建多个文件时)
    private rescanTimer: number | null = null;
    private scheduleRescan(): void {
        if (this.rescanTimer != null) {
            window.clearTimeout(this.rescanTimer);
        }
        this.rescanTimer = window.setTimeout(() => {
            this.rescanTimer = null;
            this.scanAll();
        }, 80);
    }

    // ---------- 查询 API ----------

    getNode(id: string): FolderNode | undefined { return this.nodes.get(id); }
    getNodeByPath(path: string): FolderNode | undefined {
        const id = this.pathToId.get(path);
        return id ? this.nodes.get(id) : undefined;
    }
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

    /** 显式触发刷新(SpaceService 写完文件后调用,无需等 vault 事件) */
    async refreshNow(): Promise<void> {
        await this.scanAll();
    }
}

function parentDir(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
}
