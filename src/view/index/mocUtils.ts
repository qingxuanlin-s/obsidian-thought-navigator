import { Notice } from "obsidian";

/**
 * MOC 文件范围信息
 */
export interface MOCSectionRange {
    headingIndex: number;
    sectionEndIndex: number;
    headingTitle: string;
}

/**
 * MOC ext 数据结构
 */
export interface MOCExtData {
    node_positions?: Record<string, { x: number; y: number }>;
    node_colors?: Record<string, string>;
    node_style_colors?: Record<string, string>;
    embed_node_sizes?: Record<string, { width: number; height: number }>;
    nodeRemarks?: Record<string, string>;
    collapsed_node_ids?: string[];
    groups?: Array<{ id: string; label: string; nodeIds: string[]; color?: string }>;
    edge_curvatures?: Record<string, { distance: number; weight: number }>;
    node_layout_style?: 'free' | 'auto';
    node_layout_overrides?: Record<string, 'auto' | 'free'>;
    layout_preset?: 'bidirectional' | 'top-down' | 'radial';
    node_layout_presets?: Record<string, 'bidirectional' | 'top-down' | 'radial'>;
}

/**
 * MOC 文件处理工具类
 * 提供处理 MOC 文件的公共方法
 */
export class MOCFileUtils {
    /**
     * 查找 MOC 文件中思维树标题的范围
     * @param lines - 文件行数组
     * @param headingTitle - 要查找的标题名称
     * @returns 标题范围信息，如果未找到返回 null
     */
    static findMOCSectionRange(
        lines: string[],
        headingTitle: string
    ): MOCSectionRange | null {
        let headingIndex = -1;
        let sectionEndIndex = lines.length;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === `# ${headingTitle}`) {
                headingIndex = i;
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].trim().startsWith('# ')) {
                        sectionEndIndex = j;
                        break;
                    }
                }
                break;
            }
        }

        if (headingIndex === -1) {
            return null;
        }

        return { headingIndex, sectionEndIndex, headingTitle };
    }

    /**
     * 解析 MOC 文件中的 ext 数据
     * @param lines - 文件行数组
     * @param sectionRange - MOC 区域范围
     * @returns 解析结果，包含 ext 数据和行索引
     */
    static parseExtData(
        lines: string[],
        sectionRange: MOCSectionRange
    ): { extData: MOCExtData; extLineIndex: number } {
        let extLineIndex = -1;
        const extData: MOCExtData = {
            node_positions: {},
            groups: [],
            edge_curvatures: {}
        };

        for (let i = sectionRange.sectionEndIndex - 1; i > sectionRange.headingIndex; i--) {
            const line = lines[i].trim();
            const match = line.match(/^%%\s*ext:\s*(\{.*\})\s*%%$/);
            if (match) {
                try {
                    const parsed = JSON.parse(match[1]);
                    extData.node_positions = parsed.node_positions || {};
                    extData.node_colors = parsed.node_colors || {};
                    extData.node_style_colors = parsed.node_style_colors || {};
                    extData.embed_node_sizes = parsed.embed_node_sizes || {};
                    extData.nodeRemarks = parsed.nodeRemarks || {};
                    extData.collapsed_node_ids = Array.isArray(parsed.collapsed_node_ids) ? parsed.collapsed_node_ids : [];
                    extData.groups = parsed.groups || [];
                    extData.edge_curvatures = parsed.edge_curvatures || {};
                    extData.node_layout_style = parsed.node_layout_style || undefined;
                    extData.node_layout_overrides = parsed.node_layout_overrides || undefined;
                    extData.layout_preset = parsed.layout_preset || undefined;
                    extData.node_layout_presets = parsed.node_layout_presets || undefined;
                    extLineIndex = i;
                    break;
                } catch (e) {
                    console.error('Failed to parse ext data:', e);
                }
            }
        }

        return { extData, extLineIndex };
    }

    /**
     * 保存 ext 数据到 MOC 文件
     * @param lines - 文件行数组
     * @param extData - 要保存的 ext 数据
     * @param extLineIndex - ext 行的索引（如果已存在）
     * @param insertIndex - 如果 ext 行不存在，插入的位置
     * @returns 更新后的行数组
     */
    static saveExtData(
        lines: string[],
        extData: MOCExtData,
        extLineIndex: number,
        insertIndex: number
    ): string[] {
        // 构建 ext 行（只包含非空字段）
        const cleanData: MOCExtData = {};
        if (Object.keys(extData.node_positions || {}).length > 0) {
            cleanData.node_positions = extData.node_positions;
        }
        if (Object.keys(extData.node_colors || {}).length > 0) {
            cleanData.node_colors = extData.node_colors;
        }
        if (Object.keys(extData.node_style_colors || {}).length > 0) {
            cleanData.node_style_colors = extData.node_style_colors;
        }
        if (Object.keys(extData.embed_node_sizes || {}).length > 0) {
            cleanData.embed_node_sizes = extData.embed_node_sizes;
        }
        if (Object.keys(extData.nodeRemarks || {}).length > 0) {
            cleanData.nodeRemarks = extData.nodeRemarks;
        }
        if ((extData.collapsed_node_ids || []).length > 0) {
            cleanData.collapsed_node_ids = extData.collapsed_node_ids;
        }
        if (extData.groups && extData.groups.length > 0) {
            cleanData.groups = extData.groups;
        }
        if (Object.keys(extData.edge_curvatures || {}).length > 0) {
            cleanData.edge_curvatures = extData.edge_curvatures;
        }
        if (extData.node_layout_style) {
            cleanData.node_layout_style = extData.node_layout_style;
        }
        if (extData.node_layout_overrides && Object.keys(extData.node_layout_overrides).length > 0) {
            cleanData.node_layout_overrides = extData.node_layout_overrides;
        }
        if (extData.layout_preset) {
            cleanData.layout_preset = extData.layout_preset;
        }
        if (extData.node_layout_presets && Object.keys(extData.node_layout_presets).length > 0) {
            cleanData.node_layout_presets = extData.node_layout_presets;
        }

        const extLine = Object.keys(cleanData).length > 0
            ? `%% ext:${JSON.stringify(cleanData)} %%`
            : '';

        // 如果存在 ext 行，更新它；否则插入新行
        if (extLineIndex !== -1) {
            lines[extLineIndex] = extLine;
        } else if (extLine) {
            lines.splice(insertIndex, 0, extLine);
        }

        return lines;
    }

    /**
     * 转义正则表达式特殊字符
     * @param str - 要转义的字符串
     * @returns 转义后的字符串
     */
    static escapeRegExp(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 显示 MOC 文件错误通知
     * @param message - 错误消息
     * @param headingTitle - 标题名称
     */
    static showMOCError(message: string, headingTitle?: string): void {
        const fullMessage = headingTitle
            ? `${message}: # ${headingTitle}`
            : message;
        new Notice(fullMessage);
        console.warn(fullMessage);
    }
}

/**
 * 模态框工具类
 * 提供创建模态框的公共方法
 */
export class ModalUtils {
    /**
     * 创建标准按钮样式
     * @param button - 按钮元素
     * @param isPrimary - 是否为主要按钮
     */
    static applyButtonStyles(button: HTMLElement, isPrimary = false): void {
        button.setCssStyles({
            padding: '6px 16px',
            border: isPrimary ? 'none' : '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            backgroundColor: isPrimary ? '#5b8fd9' : 'var(--background-primary)',
            color: isPrimary ? '#ffffff' : 'var(--text-normal)',
            cursor: 'pointer',
        });
    }

    /**
     * 创建警告信息框
     * @param container - 容器元素
     * @param title - 标题
     * @param message - 消息内容（支持 HTML）
     * @param icon - 图标（可选）
     * @returns 警告框元素
     */
    static createWarningBox(
        container: HTMLElement,
        title: string,
        message: string,
        icon?: string
    ): HTMLElement {
        const warningDiv = container.createDiv();
        warningDiv.setCssStyles({
            marginBottom: '15px',
            padding: '15px',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '4px',
        });

        if (icon) {
            const iconDiv = warningDiv.createEl('div', { text: icon });
            iconDiv.setCssStyles({
                fontSize: '24px',
                marginBottom: '10px',
            });
        }

        const titleDiv = warningDiv.createEl('div');
        titleDiv.createEl('strong', { text: title });
        titleDiv.setCssStyles({
            fontWeight: '600',
            marginBottom: '8px',
        });

        const messageDiv = warningDiv.createEl('div');
        messageDiv.setText(message);
        messageDiv.setCssStyles({ color: 'var(--text-muted)' });

        return warningDiv;
    }

    /**
     * 创建信息框
     * @param container - 容器元素
     * @param content - 内容数组
     * @returns 信息框元素
     */
    static createInfoBox(container: HTMLElement, content: string[]): HTMLElement {
        const infoDiv = container.createDiv();
        infoDiv.setCssStyles({
            marginBottom: '15px',
            padding: '10px',
            backgroundColor: 'var(--background-secondary)',
            borderRadius: '4px',
            color: 'var(--text-muted)',
        });

        content.forEach(line => {
            const lineDiv = infoDiv.createEl('div');
            lineDiv.setText(line);
            lineDiv.setCssStyles({ marginBottom: line === content[content.length - 1] ? '0' : '5px' });
        });

        return infoDiv;
    }
}

/**
 * 节点 ID 生成工具类
 */
export class NodeIDGenerator {
    /**
     * 生成子节点 ID
     * @param parentID - 父节点 ID
     * @returns 子节点 ID
     */
    static generateChildNodeID(parentID: string): string {
        // 移除已有编号，添加新编号
        const baseID = parentID.replace(/\/\d+$/, '');
        return `${baseID}/1`;
    }

    /**
     * 生成自由节点 ID
     * @param existingNodes - 现有节点列表
     * @returns 自由节点 ID
     */
    static generateFreeNodeID(existingNodes: Array<{ IDStr?: string }>): string {
        const maxNum = existingNodes
            .filter(n => n.IDStr?.startsWith('free.'))
            .map(n => parseInt((n.IDStr || '').replace('free.', '') || '0'))
            .reduce((max, num) => Math.max(max, num), 0);

        return `free.${maxNum + 1}`;
    }
}
