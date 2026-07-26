import { DataAdapter } from "obsidian";
import {
    WorkspaceNode, WSLink, WSSpaceNode, WSMocNode, WSProjectNode, FrameworkId,
} from "src/types/workspace";
import { isMocPath, stripMocSuffix } from "src/utils/utils";
import { genNodeId, WorkspaceStore } from "./WorkspaceStore";

interface SeedResult {
    nodes: WorkspaceNode[];
    links: WSLink[];
}

/**
 * 旧 Space 模型(已删)在 spaces.json 里的最小节点形状。
 * 仅用于一次性迁移读取,新数据不再写入此结构。
 */
interface LegacySpaceNode {
    id: string;
    name: string;
    parentId: string | null;
    kind?: 'folder' | 'file';
    filePath?: string;
    isProject?: boolean;
    icon?: string;
    color?: string;
    order?: number;
    /** 更旧版本:挂载文件存成路径数组,迁移时展开成 kind:'file' 子节点 */
    mocRefs?: string[];
    createdAt?: number;
    updatedAt?: number;
}

/** 取 vault 路径 basename(含扩展名)作为 file 节点显示名 */
function basenameOf(path: string): string {
    return path.split('/').pop() || path;
}

/** 直接读取 spaces.json 的原始节点数组(Space 模型已删,迁移时一次性读) */
async function readLegacySpaces(adapter: DataAdapter, storePath: string): Promise<LegacySpaceNode[]> {
    try {
        if (!(await adapter.exists(storePath))) return [];
        const parsed = JSON.parse(await adapter.read(storePath));
        const nodes = parsed?.nodes;
        return Array.isArray(nodes) ? (nodes as LegacySpaceNode[]) : [];
    } catch (e) {
        console.warn('[zk-navigation] spaces.json 读取失败:', storePath, e);
        return [];
    }
}

/** 框架骨架文件夹名(迁移时拆掉,语义改由框架桶承担,DESIGN §9.1) */
function isSkeletonFolder(name: string): boolean {
    const n = name.trim().toLowerCase();
    return [
        'projects', 'project', 'areas', 'area', 'resources', 'resource', 'archive', 'archives',
        '项目', '责任域', '资源', '素材', '归档',
        '总览', '主题', '局部', '局部知识',
    ].includes(n);
}

/**
 * 从 spaces.json 原始节点 best-effort 迁移到 typed 节点。
 * - 顶层文件夹 → Space(按子结构猜 framework)
 * - 子文件夹 → MOC
 * - file 节点 → moc/note(.moc.md → moc,其余 → note),partOf 父 MOC
 * - isProject 文件夹 → project
 * - 旧版 mocRefs(路径数组)→ 先展开成 kind:'file' 子节点再走上面规则
 * 迁不出有意义内容(无顶层节点)时返回 null,交给 seed。
 */
function migrateFromSpaces(raw: LegacySpaceNode[]): SeedResult | null {
    if (!raw.length) return null;
    const now = Date.now();

    // 0. 旧版 mocRefs(路径数组)→ 合成 kind:'file' 子节点,统一为"文件即节点"
    const all: LegacySpaceNode[] = raw.slice();
    for (const n of raw) {
        if (!n.mocRefs?.length) continue;
        for (const path of n.mocRefs) {
            const ts = n.updatedAt ?? now;
            all.push({
                id: genNodeId(), name: basenameOf(path), parentId: n.id,
                kind: 'file', filePath: path, createdAt: ts, updatedAt: ts,
            });
        }
    }

    // 1. 建父子索引 + 顶层(parentId 缺失或指向不存在节点 = 顶层)
    const byId = new Map(all.map(n => [n.id, n]));
    const childrenOf = new Map<string, LegacySpaceNode[]>();
    const roots: LegacySpaceNode[] = [];
    for (const n of all) {
        if (n.parentId && byId.has(n.parentId)) {
            const arr = childrenOf.get(n.parentId) ?? [];
            arr.push(n);
            childrenOf.set(n.parentId, arr);
        } else {
            roots.push(n);
        }
    }
    if (!roots.length) return null;
    const byOrder = (a: LegacySpaceNode, b: LegacySpaceNode) => {
        const oa = a.order ?? 0, ob = b.order ?? 0;
        if (oa !== ob) return oa - ob;
        return a.name.localeCompare(b.name, 'zh');
    };
    roots.sort(byOrder);
    for (const arr of childrenOf.values()) arr.sort(byOrder);
    const getChildren = (id: string): LegacySpaceNode[] => childrenOf.get(id) ?? [];

    const nodes: WorkspaceNode[] = [];
    const links: WSLink[] = [];

    const guessFramework = (rootId: string): FrameworkId => {
        const names = getChildren(rootId).map(c => c.name);
        if (names.some(n => /project|area|resource|archive/i.test(n))) return 'para';
        if (names.some(n => /总览|主题|局部/.test(n))) return 'overview';
        return 'custom';
    };
    for (const root of roots) {
        const spaceId = genNodeId();
        const space: WSSpaceNode = {
            id: spaceId, type: 'space', spaceId, title: root.name,
            framework: guessFramework(root.id), icon: root.icon, color: root.color,
            createdAt: root.createdAt || now, updatedAt: root.updatedAt || now,
        };
        nodes.push(space);

        // 递归:文件夹 → MOC(或 project),file → note/moc;parentMocId 用 partOf/childMoc 表达。
        // 框架「骨架文件夹」(Projects/Areas/Resources/Archive、总览/主题/局部)不建节点,
        // 直接把其内容上提(DESIGN §9.1:删除骨架空文件夹,语义改由框架桶承担)。
        const walk = (folderId: string, parentMocId: string | null) => {
            for (const child of getChildren(folderId)) {
                if (child.kind === 'file') {
                    const asMoc = isMocPath(child.filePath);
                    const node: WorkspaceNode = asMoc
                        ? { id: genNodeId(), type: 'moc', spaceId, title: stripMocSuffix(child.name), filePath: child.filePath, createdAt: child.createdAt || now, updatedAt: child.updatedAt || now }
                        : { id: genNodeId(), type: 'note', spaceId, title: child.name.replace(/\.md$/, ''), filePath: child.filePath, createdAt: child.createdAt || now, updatedAt: child.updatedAt || now };
                    nodes.push(node);
                    if (parentMocId) links.push({ from: node.id, to: parentMocId, type: asMoc ? 'childMoc' : 'partOf' });
                    // file 节点本身也能挂子节点(spaces.json 允许 file 下挂 file),需递归
                    walk(child.id, node.id);
                } else if (isSkeletonFolder(child.name)) {
                    // 骨架文件夹:拆掉,内容上提到同一父
                    walk(child.id, parentMocId);
                } else if (child.isProject) {
                    const node: WSProjectNode = {
                        id: genNodeId(), type: 'project', spaceId, title: child.name, status: 'active',
                        icon: child.icon, color: child.color, createdAt: child.createdAt || now, updatedAt: child.updatedAt || now,
                    };
                    nodes.push(node);
                    if (parentMocId) links.push({ from: node.id, to: parentMocId, type: 'serves' });
                    walk(child.id, parentMocId);
                } else {
                    const node: WSMocNode = {
                        id: genNodeId(), type: 'moc', spaceId, title: child.name,
                        icon: child.icon, color: child.color, createdAt: child.createdAt || now, updatedAt: child.updatedAt || now,
                    };
                    nodes.push(node);
                    if (parentMocId) links.push({ from: node.id, to: parentMocId, type: 'childMoc' });
                    walk(child.id, node.id);
                }
            }
        };
        walk(root.id, null);
    }

    return nodes.some(n => n.type !== 'space') ? { nodes, links } : null;
}

/**
 * 当前迁移逻辑版本(写入 workspace.json)。
 * 升级语义:bump 此值会触发「下次打开时从 spaces.json 重新迁移并覆盖」(见 {@link ensureWorkspaceSeed})。
 * 即:每次改进迁移逻辑就 bump,旧库升级后自动无感重迁。
 */
export const MIGRATION_VERSION = 4;

/**
 * 工作区首启 / 升级迁移(版本号 gate):
 * - 已是最新迁移版本(migrationVersion ≥ 当前)→ 不动,workspace.json 即唯一权威。
 * - 版本落后时:
 *   - spaces.json 迁得出内容 → 覆盖重迁(升级后无感),记录新版本号。
 *   - 迁不出(空库或已有内容)→ 保留现状,仅记录版本号(不再填充演示数据,不覆盖用户编辑)。
 * 返回是否写入/覆盖了节点数据。
 */
export async function ensureWorkspaceSeed(store: WorkspaceStore, adapter: DataAdapter, spacesPath: string): Promise<boolean> {
    if (store.getMigrationVersion() >= MIGRATION_VERSION) return false;
    // 首次启动时若 Remote Save 尚未下载 workspace.json,不要提前写出空文件并抢占较新的远端版本。
    if (!store.hasStoredFile() && !(await adapter.exists(spacesPath))) return false;

    const migrated = migrateFromSpaces(await readLegacySpaces(adapter, spacesPath));
    if (migrated) {
        await store.resetTo(migrated.nodes, migrated.links, MIGRATION_VERSION);
        return true;
    }
    // 无旧数据:保留现状(空库维持空),仅记录版本号避免下次重复检查
    await store.setMigrationVersion(MIGRATION_VERSION);
    return false;
}
