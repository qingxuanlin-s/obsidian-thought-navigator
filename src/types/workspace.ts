/**
 * 工作区 typed-node + link 数据模型(DESIGN §2)
 *
 * 设计哲学:框架是镜头,节点有类型,项目能追踪。
 * - 节点之间用稳定 id 引用,不依赖 vault 路径(移动/改名不断链)
 * - 框架(PARA / 总览·主题·局部 / 自定义)只是套在同一份数据上的渲染镜头,不搬动节点
 * - 关系用 typed link 表达,MOC 的聚合 = 反查"谁指向我",实时算出
 *
 * 整份数据持久化在插件数据目录下的单个 workspace.json。
 */

export type WSNodeType = 'space' | 'moc' | 'project' | 'note' | 'map';

export type ProjectStatus = 'todo' | 'active' | 'blocked' | 'done' | 'archived';

export type FrameworkId = 'para' | 'overview' | 'custom';

/** typed link 关系类型 */
export type LinkType =
    | 'serves'   // Project --serves--> MOC    "服务于责任域"
    | 'partOf'   // Note/Map --partOf--> MOC   "归属于"
    | 'childMoc' // MOC --childMoc--> MOC       "主题挂总览下"
    | 'related'; // 通用关联(带 label)

/** 有向、带类型的边 */
export interface WSLink {
    from: string;     // 源节点 id
    to: string;       // 目标节点 id
    type: LinkType;
    label?: string;   // 仅 related 用
}

export interface WSBaseNode {
    id: string;            // 稳定唯一 id,生成后永不变
    type: WSNodeType;
    spaceId: string;       // 主属 Space(Space 节点自身 spaceId === id)
    spaceIds?: string[];   // 额外绑定的 Space；与 spaceId 合起来构成完整归属
    title: string;
    createdAt: number;
    updatedAt: number;     // 任何编辑都刷新 —— "最近更新/停滞"全靠它
    icon?: string;         // 可选图标(Lucide 名)
    color?: string;        // 可选主题色
    collapsed?: boolean;   // 树视图(文件夹抽屉)折叠态,持久化
    order?: number;        // 同一容器下的手动排序;缺省按 updatedAt 兜底
    archived?: boolean;    // 非 Project 节点的归档状态；Project 继续使用 status='archived'
}

/** 领域 —— 顶层组织单元,可被打开(打开后显示 cockpit 概览页) */
export interface WSSpaceNode extends WSBaseNode {
    type: 'space';
    framework: FrameworkId; // 当前镜头,默认 'custom'
    description?: string;
}

/** MOC —— 聚合入口(= PARA 的 Area = 总览体系的 总览/主题) */
export interface WSMocNode extends WSBaseNode {
    type: 'moc';
    isTop?: boolean;        // 是否"总览"级
    description?: string;
    filePath?: string;      // 关联的 .moc.md 文件(有则可打开图谱)
}

export interface ChecklistItem {
    id: string;
    text: string;
    done: boolean;
}

/** 项目 —— 唯一带"追踪"语义的类型 */
export interface WSProjectNode extends WSBaseNode {
    type: 'project';
    status: ProjectStatus;  // 手动,见 DESIGN §6.1
    // NEXT ACTION 现以背书笔记(filePath)里的 markdown `- [ ]` 任务为唯一事实源,交给 Tasks/Dataview 追踪。
    nextAction?: string;    // 旧:单行 NEXT ACTION,仅作无任务时的兜底展示(已不再写入)
    checklist?: ChecklistItem[]; // 轻量子项;progress 从这里算,不存死值
    progress?: number;      // 手动百分比 0-100;有值时覆盖任务/checklist 推导
    deadline?: number;
    filePath?: string;      // 背书 markdown 笔记(next action `- [ ]` 写在这里)
}

/** 笔记 —— 原子知识单元(= PARA 的 Resource = 局部知识) */
export interface WSNoteNode extends WSBaseNode {
    type: 'note';
    body?: string;          // markdown 正文(可空,正文住在关联文件里)
    filePath?: string;      // 关联的 vault 文件
    lid?: string;           // Luhmann ID(总览体系下的局部知识用)
}

/** 图谱 —— 思维导图/知识网络(内容是 graph 的特殊 note) */
export interface WSMapNode extends WSBaseNode {
    type: 'map';
    filePath?: string;      // 关联的 .moc.md(图谱数据住在文件里)
}

export type WorkspaceNode =
    | WSSpaceNode
    | WSMocNode
    | WSProjectNode
    | WSNoteNode
    | WSMapNode;

/** 写盘 schema(workspace.json 顶层结构) */
export interface WorkspaceStoreFile {
    version: 1;
    nodes: WorkspaceNode[];
    links: WSLink[];
    /** 已应用的迁移逻辑版本(seed.ts MIGRATION_VERSION);缺省视为 0 */
    migrationVersion?: number;
}

// ---------- 框架(镜头)定义 ----------

export interface FrameworkBucket {
    id: string;
    label: string;
    match: (n: WorkspaceNode) => boolean; // 纯函数,决定节点落入哪个桶
}

export interface Framework {
    id: FrameworkId;
    label: string;   // 完整名,如 "总览·主题·局部"
    chip: string;    // 短标签,如 "总览体系"
    buckets: FrameworkBucket[];
}

export const isWorkspaceNodeArchived = (n: WorkspaceNode): boolean =>
    n.type === 'project' ? n.status === 'archived' : n.archived === true;

/** 三套内置框架(DESIGN §2.3)。切换 = 换一组 buckets 重新分组同一批节点,零数据迁移。 */
export const FRAMEWORKS: Record<FrameworkId, Framework> = {
    para: {
        id: 'para', label: 'PARA', chip: 'PARA',
        buckets: [
            { id: 'projects', label: 'Projects', match: n => n.type === 'project' && !isWorkspaceNodeArchived(n) },
            { id: 'areas', label: 'Areas', match: n => n.type === 'moc' && !isWorkspaceNodeArchived(n) },
            { id: 'resources', label: 'Resources', match: n => (n.type === 'note' || n.type === 'map') && !isWorkspaceNodeArchived(n) },
            { id: 'archive', label: 'Archive', match: n => isWorkspaceNodeArchived(n) },
        ],
    },
    overview: {
        id: 'overview', label: '总览·主题·局部', chip: '总览体系',
        buckets: [
            { id: 'overview', label: '总览', match: n => n.type === 'moc' && !isWorkspaceNodeArchived(n) && !!(n as WSMocNode).isTop },
            { id: 'theme', label: '主题', match: n => n.type === 'moc' && !isWorkspaceNodeArchived(n) && !(n as WSMocNode).isTop },
            { id: 'local', label: '局部知识', match: n => (n.type === 'note' || n.type === 'map') && !isWorkspaceNodeArchived(n) },
            { id: 'action', label: '行动·项目', match: n => n.type === 'project' && !isWorkspaceNodeArchived(n) },
        ],
    },
    custom: {
        id: 'custom', label: '自定义', chip: '自定义',
        buckets: [
            { id: 'all', label: '全部', match: n => !isWorkspaceNodeArchived(n) },
        ],
    },
};

// ---------- 万能视口路由目标(DESIGN §3.2) ----------

export type OpenTarget =
    | { kind: 'home' }
    | { kind: 'space'; id: string; lens?: string }
    | { kind: 'moc'; id: string }
    | { kind: 'project'; id: string }
    | { kind: 'note'; id: string };

/** 节点 → 默认打开目标 */
export function targetFor(n: WorkspaceNode): OpenTarget {
    if (n.type === 'space') return { kind: 'space', id: n.id };
    if (n.type === 'moc') return { kind: 'moc', id: n.id };
    if (n.type === 'map') return { kind: 'moc', id: n.id }; // map 走图谱视口
    if (n.type === 'project') return { kind: 'project', id: n.id };
    return { kind: 'note', id: n.id };
}
