import {
    WorkspaceNode, WSLink, WSSpaceNode, WSMocNode, WSProjectNode, WSNoteNode,
    ChecklistItem, ProjectStatus, FrameworkId,
} from "src/types/workspace";
import { genNodeId, WorkspaceStore } from "./WorkspaceStore";
import { VaultIndex } from "src/index/VaultIndex";

interface SeedResult {
    nodes: WorkspaceNode[];
    links: WSLink[];
}

/** 内部构造小工具:统一 createdAt/updatedAt */
function mkBuilder() {
    const nodes: WorkspaceNode[] = [];
    const links: WSLink[] = [];
    const now = Date.now();
    const ago = (days: number) => now - days * 86400000;

    function space(title: string, framework: FrameworkId, opts?: { icon?: string; color?: string; description?: string }): WSSpaceNode {
        const id = genNodeId();
        const n: WSSpaceNode = {
            id, type: 'space', spaceId: id, title, framework,
            icon: opts?.icon, color: opts?.color, description: opts?.description,
            createdAt: now, updatedAt: now,
        };
        nodes.push(n);
        return n;
    }
    function moc(spaceId: string, title: string, opts?: { isTop?: boolean; description?: string; updatedAt?: number }): WSMocNode {
        const n: WSMocNode = {
            id: genNodeId(), type: 'moc', spaceId, title,
            isTop: opts?.isTop, description: opts?.description,
            createdAt: now, updatedAt: opts?.updatedAt ?? now,
        };
        nodes.push(n);
        return n;
    }
    function project(spaceId: string, title: string, status: ProjectStatus, opts?: { nextAction?: string; checklist?: [string, boolean][]; updatedAt?: number }): WSProjectNode {
        const checklist: ChecklistItem[] | undefined = opts?.checklist?.map(([text, done]) => ({ id: genNodeId(), text, done }));
        const n: WSProjectNode = {
            id: genNodeId(), type: 'project', spaceId, title, status,
            nextAction: opts?.nextAction, checklist,
            createdAt: now, updatedAt: opts?.updatedAt ?? now,
        };
        nodes.push(n);
        return n;
    }
    function note(spaceId: string, title: string, opts?: { lid?: string; updatedAt?: number }): WSNoteNode {
        const n: WSNoteNode = {
            id: genNodeId(), type: 'note', spaceId, title,
            lid: opts?.lid, createdAt: now, updatedAt: opts?.updatedAt ?? now,
        };
        nodes.push(n);
        return n;
    }
    function serves(from: WorkspaceNode, to: WorkspaceNode) { links.push({ from: from.id, to: to.id, type: 'serves' }); }
    function partOf(from: WorkspaceNode, to: WorkspaceNode) { links.push({ from: from.id, to: to.id, type: 'partOf' }); }

    return { nodes, links, ago, space, moc, project, note, serves, partOf };
}

/**
 * 演示数据:虚构的示例工作区(PARA + 总览体系),仅用于首次启动演示。
 * 仅在工作区为空、且现有 spaces.json 也迁不出东西时使用。
 */
export function buildSeed(): SeedResult {
    const b = mkBuilder();

    // ===== 示例空间一(PARA)=====
    const arch = b.space('示例空间一', 'para', { color: '#b79dff', description: '用于首次启动的演示工作区' });

    const sysMoc = b.moc(arch.id, '主题 A · MOC', { updatedAt: b.ago(0) });
    const dbMoc = b.moc(arch.id, '主题 B · MOC', { updatedAt: b.ago(0) });

    const seckill = b.project(arch.id, '示例项目一', 'active', {
        nextAction: '下一步:推进示例项目一的关键任务',
        checklist: [['步骤一', true], ['步骤二', true], ['步骤三', false], ['步骤四', false]],
        updatedAt: b.ago(1),
    });
    const raft = b.project(arch.id, '示例项目二', 'active', {
        nextAction: '下一步:推进示例项目二的关键任务',
        checklist: [['调研', true], ['设计', false], ['实现', false], ['验收', false]],
        updatedAt: b.ago(0),
    });
    const mysqlIdx = b.project(arch.id, '示例项目三', 'blocked', {
        nextAction: '下一步:等待外部依赖就绪',
        checklist: [['前置调研', true], ['方案验证', false]],
        updatedAt: b.ago(3),
    });
    const redis = b.project(arch.id, '示例项目四', 'done', {
        checklist: [['阶段一', true], ['阶段二', true], ['阶段三', true]],
        updatedAt: b.ago(14),
    });
    const oldCrawler = b.project(arch.id, '旧 · 归档示例项目', 'archived', { updatedAt: b.ago(120) });

    const jvm = b.note(arch.id, '示例笔记一');
    const mysqlNote = b.note(arch.id, '示例笔记二');

    // 关系:serves / partOf —— 决定 MOC 聚合数
    b.serves(seckill, sysMoc);
    b.serves(raft, sysMoc);
    b.serves(raft, dbMoc);
    b.serves(mysqlIdx, dbMoc);
    b.serves(redis, dbMoc);
    b.partOf(jvm, sysMoc);
    b.partOf(mysqlNote, dbMoc);

    // ===== 示例空间二(总览体系)=====
    const ky = b.space('示例空间二', 'overview', { color: '#cf94e5' });
    const kyTop = b.moc(ky.id, '总览', { isTop: true });
    const eng = b.moc(ky.id, '分类一');
    const math = b.moc(ky.id, '分类二');
    b.note(ky.id, '示例条目一', { lid: 'a.1' });
    b.note(ky.id, '示例条目二', { lid: 'a.2' });
    const story = b.note(ky.id, '示例条目三', { lid: 'a.3' });
    b.partOf(story, eng);
    b.partOf(eng, kyTop);
    b.partOf(math, kyTop);

    return { nodes: b.nodes, links: b.links };
}
/**
 * 从现有 spaces.json(FolderNode 树)best-effort 迁移到 typed 节点。
 * - 顶层文件夹 → Space(按子结构猜 framework)
 * - 子文件夹 → MOC
 * - file 节点 → moc/note(.moc.md → moc,其余 → note),partOf 父 MOC
 * - isProject 文件夹 → project
 * 迁不出有意义内容(无顶层节点)时返回 null,交给 seed。
 */
/** 框架骨架文件夹名(迁移时拆掉,语义改由框架桶承担,DESIGN §9.1) */
function isSkeletonFolder(name: string): boolean {
    const n = name.trim().toLowerCase();
    return [
        'projects', 'project', 'areas', 'area', 'resources', 'resource', 'archive', 'archives',
        '项目', '责任域', '资源', '素材', '归档',
        '总览', '主题', '局部', '局部知识',
    ].includes(n);
}

export function migrateFromVaultIndex(index: VaultIndex): SeedResult | null {
    const roots = index.getRoots();
    if (!roots.length) return null;

    const nodes: WorkspaceNode[] = [];
    const links: WSLink[] = [];
    const now = Date.now();

    const guessFramework = (rootId: string): FrameworkId => {
        const names = index.getChildren(rootId).map(c => c.name);
        if (names.some(n => /project|area|resource|archive/i.test(n))) return 'para';
        if (names.some(n => /总览|主题|局部/.test(n))) return 'overview';
        return 'custom';
    };
    const isMocPath = (p?: string) => !!p && (p.endsWith('.moc.md') || p.endsWith('.moc'));

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
            for (const child of index.getChildren(folderId)) {
                if (child.kind === 'file') {
                    const asMoc = isMocPath(child.filePath);
                    const node: WorkspaceNode = asMoc
                        ? { id: genNodeId(), type: 'moc', spaceId, title: child.name.replace(/\.moc(\.md)?$/, ''), filePath: child.filePath, createdAt: child.createdAt || now, updatedAt: child.updatedAt || now }
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
 * 当前迁移逻辑版本。仅作记录(写入 workspace.json),便于诊断与「重新导入」命令使用。
 * 注意:bump 此值【不再】触发自动覆盖——workspace.json 一旦有数据即为唯一权威。
 */
export const MIGRATION_VERSION = 3;

/**
 * 工作区首启填充(一次性):
 * - 仅当 workspace.json 为空时执行:优先从 spaces.json 迁移,迁不出用 seed demo。
 * - workspace.json 一旦有数据,它就是权威,本函数永不自动覆盖(避免冲掉用户编辑)。
 *   需要重新从 spaces.json 导入时走 {@link reimportFromSpaces}(显式覆盖)。
 * 返回是否写入了新数据。
 */
export async function ensureWorkspaceSeed(store: WorkspaceStore, vaultIndex: VaultIndex | null): Promise<boolean> {
    if (!store.isEmpty()) return false;
    const data = (vaultIndex && migrateFromVaultIndex(vaultIndex)) || buildSeed();
    await store.resetTo(data.nodes, data.links, MIGRATION_VERSION);
    return true;
}

/**
 * 逃生口:用户显式触发,从 spaces.json 重新迁移并【覆盖】当前工作区数据。
 * spaces.json 迁不出内容时回退到 seed demo。返回写入的节点数。
 */
export async function reimportFromSpaces(store: WorkspaceStore, vaultIndex: VaultIndex | null): Promise<number> {
    const data = (vaultIndex && migrateFromVaultIndex(vaultIndex)) || buildSeed();
    await store.resetTo(data.nodes, data.links, MIGRATION_VERSION);
    return data.nodes.length;
}
