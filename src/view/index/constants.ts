/**
 * ZK Index View 常量定义
 */

/**
 * 防抖延迟时间（毫秒）
 */
export const DEBOUNCE_DELAY = {
    RESIZE: 100,              // 窗口调整大小防抖
    POSITION_SAVE: 200,       // 位置保存防抖
    EDGE_CURVATURE_SAVE: 200, // 边弧度保存防抖
} as const;

/**
 * MOC 相关常量
 */
export const MOC = {
    MAX_NAME_LENGTH: 9,        // MOC 名称最大显示长度
    DEFAULT_HEADING: '思维树',  // 默认 MOC 标题
    FREE_NODE_PREFIX: 'free.', // 自由节点 ID 前缀
} as const;

/**
 * UI 样式常量
 */
export const UI_STYLES = {
    BUTTON: {
        PADDING: '6px 16px',
        BORDER_RADIUS: '4px',
        PRIMARY_BG: '#5b8fd9',
        PRIMARY_COLOR: '#ffffff',
        SECONDARY_BG: 'var(--background-primary)',
        SECONDARY_COLOR: 'var(--text-normal)',
    },
    MODAL: {
        PADDING: '20px',
        WARNING_BG: 'rgba(239, 68, 68, 0.1)',
        WARNING_BORDER: '1px solid rgba(239, 68, 68, 0.3)',
        INFO_BG: 'var(--background-secondary)',
    },
    INPUT: {
        PADDING: '8px',
        BORDER: '1px solid var(--background-modifier-border)',
    },
} as const;

/**
 * 模态框按钮文本
 */
export const MODAL_BUTTONS = {
    CONFIRM: '确认',
    CANCEL: '取消',
    DELETE: '删除',
    SAVE: '保存',
} as const;

/**
 * 正则表达式模式
 */
export const REGEX_PATTERNS = {
    NODE_LINE: /\\[\\[.*?\\]\\]\\s*`([^`]+)`/,
    ARROW_RELATION: /-->.*?-->/,
    MOC_EXT_LINE: /^%%\\s*ext:\\s*(\\{.*\\})\\s*%%$/,
} as const;

/**
 * 错误消息模板
 */
export const ERROR_MESSAGES = {
    MOC_HEADING_NOT_FOUND: (title: string) => `未找到标题: # ${title}`,
    NODE_NOT_FOUND: (nodeId: string) => `未找到节点: ${nodeId}`,
    NODE_ALREADY_EXISTS: (nodeId: string) => `节点 ID "${nodeId}" 已存在，请使用其他 ID`,
} as const;

/**
 * 成功消息模板
 */
export const SUCCESS_MESSAGES = {
    NODE_DELETED: (nodeId: string) => `已删除节点: ${nodeId}`,
    NODE_ID_CHANGED: (oldId: string, newId: string) => `已将节点 ID 从 "${oldId}" 修改为 "${newId}"`,
    FREE_NODE_CONVERTED: (oldId: string, newId: string) => `自由节点 ${oldId} 已转换为 ${newId}`,
    CHILD_NODE_CREATED: (nodeId: string) => `已创建子节点: ${nodeId}`,
    GROUP_CREATED: (label: string) => `已创建分组: ${label}`,
    GROUP_DELETED: (label: string) => `已删除分组: ${label}`,
} as const;

/**
 * 警告消息
 */
export const WARNING_MESSAGES = {
    OPERATION_IRREVERSIBLE: '此操作不可撤销！',
} as const;

/**
 * 键盘快捷键
 */
export const KEYBOARD = {
    ENTER: 'Enter',
    ESCAPE: 'Escape',
    DELETE: 'Delete',
    BACKSPACE: 'Backspace',
} as const;

/**
 * 颜色常量
 */
export const COLORS = {
    DEFAULT_NODE: '#5b8fd9',
    WARNING: '#ef4444',
    SUCCESS: '#10b981',
    MUTED: 'var(--text-muted)',
} as const;
