import { RenderOptions } from './types';
import { getGraphTheme } from './theme';

export interface StylesheetDeps {
    FIRST_LEVEL_NODE_FONT_SIZE: number;
    ROOT_NODE_FONT_SIZE: number;
    ROOT_TO_FIRST_LEVEL_EDGE_WIDTH: number;
    ROOT_TO_FIRST_LEVEL_EDGE_OPACITY: number;
    ACTIVE_ROOT_TO_FIRST_LEVEL_EDGE_OPACITY: number;
    SECONDARY_PARENT_EDGE_OPACITY: number;
    measureNodeLabel: (label: string, options?: {
        baseWidth?: number;
        minHeight?: number;
        maxWidth?: number;
        fontSize?: number;
        charWidth?: number;
        lineHeight?: number;
        paddingX?: number;
        paddingY?: number;
    }) => { width: number; height: number };
    compensateFreeLikeNodeFrameSize: (
        label: string,
        measured: { width: number; height: number },
        options?: {
            isFreeNode?: boolean;
            isStandaloneText?: boolean;
            maxWidth?: number;
            charWidth?: number;
        }
    ) => { width: number; height: number };
    normalizeHexColor: (color: string | null | undefined) => string | null;
    hexToRgba: (hex: string, alpha: number) => string;
    lightenColor: (hex: string, amount: number) => string;
    darkenColor: (hex: string, amount: number) => string;
    measureTextWidthCanvas: (text: string, fontSize: number, fontWeight?: string) => number;
    domMeasure: (text: string, opts: {
        fontSize: number;
        fontWeight?: string;
        maxWidth: number;
        lineHeight?: number;
    }) => { width: number; height: number; lineCount: number };
}

export function buildStylesheet(options: RenderOptions, deps: StylesheetDeps): any[] {
    const theme = getGraphTheme(options);
    const isLight = theme.isLight;
    const isModern = (options.themeStyle || 'modern') === 'modern';
    const isNebula = options.themeStyle === 'nebula';
    const edgeStyle = options.edgeStyle || 'bezier';
    const colors = {
        nodeBackground: theme.node.background,
        nodeBackgroundHover: theme.node.backgroundHover,
        nodeBackgroundSelected: theme.node.backgroundSelected,
        nodeBorder: theme.node.border,
        nodeBorderSelected: theme.node.borderSelected,
        nodeText: theme.node.text,
        nodeTextMuted: theme.node.textMuted,
        edgeNormal: theme.edge.normal,
        edgeForward: theme.edge.forward,
        edgeReverse: theme.edge.reverse,
        edgeSelected: theme.edge.selected,
        badgeBackground: theme.badge.background,
        badgeText: theme.badge.text
    };

    const autoMeasureCache = new Map<string, { width: number; height: number; wrapWidth: number }>();
    const fileNodeMeasureCache = new Map<string, { width: number; height: number; wrapWidth: number }>();
    const firstLevelMeasureCache = new Map<string, { nodeWidth: number; wrapWidth: number; nodeHeight: number }>();
    const FILE_NODE_PADDING_Y = 57;
    const FIRST_LEVEL_FILE_NODE_PADDING_Y = 61;
    const getVisibleTextForMeasure = (label: string): string => {
        return String(label || '')
            .replace(/<span\s+style=["'][^"']*["']>(.*?)<\/span>/gis, '$1')
            .replace(/!\[\[([^\]\n]+)\]\]/g, (_m, target) => String(target || '').split('|').pop()?.trim() || '')
            .replace(/\[\[([^\]\n]+)\]\]/g, (_m, target) => String(target || '').split('|').pop()?.trim() || '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/~~(.+?)~~/g, '$1')
            .replace(/^\s*#{1,6}\s+/gm, '')
            .replace(/<[^>]+>/g, '');
    };
    const getTextMeasureLabel = (ele: any): string => getVisibleTextForMeasure(ele.data('label') || '');

    const measureSingleLineFileNode = (label: string, opts: {
        fontSize: number;
        fontWeight: string;
        baseWidth: number;
        minHeight: number;
        paddingX: number;
        paddingY: number;
        lineHeight?: number;
    }): { width: number; height: number; wrapWidth: number } => {
        const lineHeight = opts.lineHeight ?? Math.ceil(opts.fontSize * 1.4);
        const key = `${label}|${opts.fontSize}|${opts.fontWeight}|${opts.baseWidth}|${opts.minHeight}|${opts.paddingX}|${opts.paddingY}|${lineHeight}`;
        const cached = fileNodeMeasureCache.get(key);
        if (cached) return cached;

        const lines = String(label || '').split('\n');
        const lineWidths = lines.map((line: string) => deps.measureTextWidthCanvas(line || ' ', opts.fontSize, opts.fontWeight));
        const longestW = Math.max(...lineWidths, opts.fontSize);
        const safetyPx = 8;
        const width = Math.max(opts.baseWidth, Math.ceil(longestW) + safetyPx + opts.paddingX);
        const height = Math.max(opts.minHeight, Math.max(1, lines.length) * lineHeight + opts.paddingY);
        const result = { width, height, wrapWidth: Math.max(1, width - opts.paddingX) };
        if (fileNodeMeasureCache.size > 200) fileNodeMeasureCache.clear();
        fileNodeMeasureCache.set(key, result);
        return result;
    };

    const computeAutoTextMetrics = (label: string, opts?: {
        fontSize?: number;
        fontWeight?: string;
        maxContentWidth?: number;
        baseWidth?: number;
        minHeight?: number;
        paddingX?: number;
        paddingY?: number;
    }): { width: number; height: number; wrapWidth: number } => {
        const fontSize = opts?.fontSize ?? 20;
        const fontWeight = opts?.fontWeight ?? '500';
        const maxContentWidth = opts?.maxContentWidth ?? 280;
        const baseWidth = opts?.baseWidth ?? 90;
        const minHeight = opts?.minHeight ?? 42;
        const paddingX = opts?.paddingX ?? 72;
        const paddingY = opts?.paddingY ?? 44;
        const lineHeight = Math.ceil(fontSize * 1.4);
        const key = `${label}|${fontSize}|${fontWeight}|${maxContentWidth}|${baseWidth}|${minHeight}|${paddingX}|${paddingY}`;
        const cached = autoMeasureCache.get(key);
        if (cached) return cached;

        const m = deps.domMeasure(label || ' ', { fontSize, fontWeight, maxWidth: maxContentWidth, lineHeight });
        const width = Math.max(baseWidth, Math.min(maxContentWidth + paddingX, Math.ceil(m.width) + paddingX));
        const height = Math.max(minHeight, Math.ceil(m.height) + paddingY);
        const result = { width, height, wrapWidth: Math.max(120, width - paddingX) };
        if (autoMeasureCache.size > 200) autoMeasureCache.clear();
        autoMeasureCache.set(key, result);
        return result;
    };

    const computeFirstLevelMetrics = (label: string): { nodeWidth: number; wrapWidth: number; nodeHeight: number } => {
        const fontSize = deps.FIRST_LEVEL_NODE_FONT_SIZE;
        const paddingX = 44;
        const paddingY = FIRST_LEVEL_FILE_NODE_PADDING_Y;
        const lineHeight = Math.ceil(fontSize * 1.4);
        const baseWidth = 118;
        const key = `${label}|${fontSize}`;
        const cached = firstLevelMeasureCache.get(key);
        if (cached) return cached;

        const measured = measureSingleLineFileNode(label, {
            fontSize,
            fontWeight: 'bold',
            baseWidth,
            minHeight: 54,
            paddingX,
            paddingY,
            lineHeight
        });
        const result = {
            nodeWidth: measured.width,
            wrapWidth: measured.wrapWidth,
            nodeHeight: measured.height
        };
        if (firstLevelMeasureCache.size > 200) firstLevelMeasureCache.clear();
        firstLevelMeasureCache.set(key, result);
        return result;
    };

    return [
        // 节点样式 - 使用函数动态计算大小
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'text-valign': 'center',
                'text-halign': 'center',
                'text-wrap': 'wrap',
                'text-max-width': '280px',
                'text-overflow-wrap': 'anywhere',
                'background-color': (ele: any) => {
                    const fillColor = ele.data('customFillColor');
                    if (fillColor && !ele.data('isEmbed') && !ele.data('isGroup')) {
                        return fillColor;
                    }
                    return colors.nodeBackground;
                },
                'color': (ele: any) => {
                    const fillTextColor = ele.data('customFillTextColor');
                    if (fillTextColor && !ele.data('isEmbed') && !ele.data('isGroup')) {
                        return fillTextColor;
                    }
                    return colors.nodeText;
                },
                'font-size': `${deps.FIRST_LEVEL_NODE_FONT_SIZE - 4}px`,
                'font-weight': '500',
                'width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    if (manualWidthModel > 0 && ele.data('isTextOnly')) {
                        return manualWidthModel;
                    }
                    if (ele.data('isTextOnly')) {
                        return computeAutoTextMetrics(getTextMeasureLabel(ele)).width;
                    }
                    const label = ele.data('label') || '';
                    return measureSingleLineFileNode(label, {
                        fontSize: deps.FIRST_LEVEL_NODE_FONT_SIZE - 4,
                        fontWeight: '500',
                        baseWidth: 90,
                        minHeight: 42,
                        paddingX: 40,
                        paddingY: FILE_NODE_PADDING_Y
                    }).width;
                },
                'height': (ele: any) => {
                    const manualHeightModel = Number(ele.data('manualHeightModel') || 0);
                    if (ele.data('isTextOnly')) {
                        const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                        // 锁过宽度时,按锁定宽度推算换行,避免按默认 wrap 宽度算出比实际显示偏高的值
                        // (否则编辑保存后会出现"先变高,applySizes 之后再回落"的闪烁)
                        const opts = manualWidthModel > 0
                            ? { maxContentWidth: Math.max(80, manualWidthModel - 72) }
                            : undefined;
                        const auto = computeAutoTextMetrics(getTextMeasureLabel(ele), opts).height;
                        return manualHeightModel > 0 ? Math.max(manualHeightModel, auto) : auto;
                    }
                    const label = ele.data('label') || '';
                    return measureSingleLineFileNode(label, {
                        fontSize: deps.FIRST_LEVEL_NODE_FONT_SIZE - 4,
                        fontWeight: '500',
                        baseWidth: 90,
                        minHeight: 42,
                        paddingX: 40,
                        paddingY: FILE_NODE_PADDING_Y
                    }).height;
                },
                'padding': '20px',
                'shape': 'round-rectangle',
                'corner-radius': '10px',
                'border-width': '2px',
                'border-opacity': 0.72,
                'border-color': (ele: any) => {
                    if (isModern && ele.data('branchNodeBorder') && !ele.data('isRoot') && !ele.data('isFreeNode')) {
                        return ele.data('branchNodeBorder');
                    }
                    return colors.nodeBorder;
                },
                'transition-property': 'background-color, border-color',
                'transition-duration': '0.2s'
            } as any
        },
        // 现代风格：边框增强（无 shadow-*，避免 Cytoscape 样式告警）
        ...(isModern ? [{
            selector: 'node[!isRoot][!isEmbed][!isStandaloneText]',
            style: {
                'border-width': '2.5px',
            } as any
        }] : []),
        // 带 ID 徽标的文件节点：主标题略上移，为右下角徽标预留空间
        {
            selector: 'node[badge][!isTextOnly][!isEmbed][!isGroup]',
            style: {
                'text-margin-y': -8
            } as any
        },
        // 嵌入节点：由 HTML 预览卡片承载内容，隐藏 Cytoscape 默认卡片外观
        {
            selector: 'node[?isEmbed]',
			style: {
				'label': '',
				'background-opacity': 0,
				'border-opacity': 0,
				'border-width': 0,
				'overlay-opacity': 0,
				'padding': '0px'
			} as any
		},
        // 纯文本节点：文字换行宽度跟随节点宽度（支持手动拉伸后自适应）
        {
            selector: 'node[?isTextOnly]',
            style: {
                'text-max-width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    const w = Number(ele.width() || 0);
                    if (manualWidthModel > 0) return Math.max(120, manualWidthModel - 48);
                    if (w > 0) return Math.max(120, w - 48);
                    return computeAutoTextMetrics(getTextMeasureLabel(ele)).wrapWidth;
                }
            } as any
        },
        // 具有 Markdown 渲染 overlay 的文本节点：隐藏 Canvas 文字（由 HTML 层渲染）
        {
            selector: 'node[?isTextOnly][?hasMarkdownOverlay]',
            style: {
                'text-opacity': 0
            } as any
        },
        // 自由文本节点（无父子关系）：纯文本样式（透明边框与背景）
        {
            selector: 'node[?isStandaloneText]',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'shape': 'round-rectangle',
                'padding': '0px'
            } as any
        },
        // 普通节点（文本/文件）：与自由文本节点尺寸对齐（免去外扩 padding），保留卡片背景与边框
        {
            selector: 'node[!isStandaloneText][!isEmbed][!isRoot]',
            style: {
                'padding': '0px'
            } as any
        },
        // 1 级节点：只突出根节点的直接子节点，建立主干层级
        {
            selector: 'node[?isFirstLevelNode][!isRoot][!isFreeNode][!isEmbed][!isStandaloneText]',
            style: {
                'background-color': (ele: any) => {
                    const branchColor = deps.normalizeHexColor(ele.data('branchNodeBorder') || '');
                    if (theme.isLight) {
                        return branchColor
                            ? deps.hexToRgba(deps.lightenColor(branchColor, 0.72), 0.86)
                            : theme.node.firstLevelFallback;
                    }
                    return branchColor
                        ? deps.hexToRgba(deps.darkenColor(branchColor, 0.62), 0.72)
                        : theme.node.firstLevelFallback;
                },
                'background-opacity': theme.effects.firstLevelBackgroundOpacity,
                'border-color': (ele: any) => ele.data('branchNodeBorder') || '#5da6ff',
                'border-width': '2.6px',
                'border-opacity': 0.92,
                'z-index': 1000,
                'color': theme.node.firstLevelText,
                'text-outline-width': 0,
                'font-size': `${deps.FIRST_LEVEL_NODE_FONT_SIZE}px`,
                'font-weight': 'bold',
                'text-max-width': (ele: any) => {
                    if (ele.data('isTextOnly')) {
                        const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                        const widthModel = manualWidthModel > 0 ? manualWidthModel : Number(ele.width() || 340);
                        return Math.max(160, widthModel - 52);
                    }
                    return computeFirstLevelMetrics(ele.data('label') || '').wrapWidth;
                },
                'width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    if (manualWidthModel > 0 && ele.data('isTextOnly')) {
                        return manualWidthModel;
                    }
                    if (ele.data('isTextOnly')) {
                        return computeAutoTextMetrics(getTextMeasureLabel(ele), {
                            fontSize: deps.FIRST_LEVEL_NODE_FONT_SIZE,
                            fontWeight: 'bold',
                            maxContentWidth: 296,
                            baseWidth: 118,
                            minHeight: 90,
                            paddingX: 72,
                            paddingY: 34
                        }).width;
                    }
                    const label = ele.data('label') || '';
                    return computeFirstLevelMetrics(label).nodeWidth;
                },
                'height': (ele: any) => {
                    const manualHeightModel = Number(ele.data('manualHeightModel') || 0);
                    if (ele.data('isTextOnly')) {
                        const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                        const auto = computeAutoTextMetrics(getTextMeasureLabel(ele), {
                            fontSize: deps.FIRST_LEVEL_NODE_FONT_SIZE,
                            fontWeight: 'bold',
                            maxContentWidth: manualWidthModel > 0 ? Math.max(80, manualWidthModel - 72) : 296,
                            baseWidth: 118,
                            minHeight: 90,
                            paddingX: 72,
                            paddingY: 34
                        }).height;
                        return manualHeightModel > 0 ? Math.max(manualHeightModel, auto) : auto;
                    }
                    const label = ele.data('label') || '';
                    const auto = Math.max(computeFirstLevelMetrics(label).nodeHeight, 80);
                    return manualHeightModel > 0 ? Math.max(manualHeightModel, auto) : auto;
                }
            } as any
        },
        // 当前激活的 1 级分支：只有这一支使用实心填充
        {
            selector: 'node.zk-active-first-level-branch[?isFirstLevelNode][!isRoot][!isFreeNode][!isEmbed][!isStandaloneText]',
            style: {
                'background-color': (ele: any) => {
                    const branchColor = deps.normalizeHexColor(ele.data('branchNodeBorder') || '');
                    if (theme.isLight) {
                        return branchColor
                            ? deps.hexToRgba(deps.lightenColor(branchColor, 0.74), 0.92)
                            : theme.node.activeFirstLevelFallback;
                    }
                    return ele.data('branchNodeBackground') || theme.node.activeFirstLevelFallback;
                },
                'background-opacity': theme.effects.activeFirstLevelBackgroundOpacity,
                'border-color': (ele: any) => {
                    const branchColor = deps.normalizeHexColor(ele.data('branchNodeBorder') || '');
                    if (theme.isLight) return branchColor || theme.node.borderSelected;
                    return branchColor ? deps.lightenColor(branchColor, 0.30) : '#9ed0ff';
                },
                'border-width': '3.7px',
                'border-opacity': 0.98,
                'color': theme.node.activeFirstLevelText,
                'text-outline-color': theme.node.activeFirstLevelOutline,
                'text-outline-width': theme.effects.activeFirstLevelOutlineWidth,
                'z-index': 1001
            } as any
        },
        // 2级及以下节点降饱和：保留关系线索，不和根/1级争抢
        {
            selector: 'node[!isRoot][!isFirstLevelNode][!isFreeNode][!isEmbed][!isStandaloneText][!isCurrentFile]',
            style: {
                'background-opacity': 0.56,
                'border-width': '1.4px',
                'border-opacity': 0.58,
                'color': theme.node.textMuted
            } as any
        },
        // 根节点样式：当前图谱焦点
        {
            selector: 'node[?isRoot][!isFreeNode]',
            style: {
                'background-color': theme.node.rootBackground,
                'border-color': theme.node.rootBorder,
                'background-opacity': theme.effects.rootBackgroundOpacity,
                'border-opacity': 0.98,
                'z-index': 1002,
                'color': theme.node.textSelected,
                'font-size': `${deps.ROOT_NODE_FONT_SIZE}px`,
                'font-weight': 'bold',
                'text-max-width': (ele: any) => {
                    if (ele.data('isTextOnly')) {
                        const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                        const widthModel = manualWidthModel > 0 ? manualWidthModel : Number(ele.width() || 560);
                        return Math.max(220, widthModel - 76);
                    }
                    return measureSingleLineFileNode(ele.data('label') || '', {
                        fontSize: deps.ROOT_NODE_FONT_SIZE,
                        fontWeight: 'bold',
                        baseWidth: 210,
                        minHeight: 78,
                        paddingX: 88,
                        paddingY: 38,
                        lineHeight: 42
                    }).wrapWidth;
                },
                'width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    if (manualWidthModel > 0 && ele.data('isTextOnly')) {
                        return manualWidthModel;
                    }
                    const label = ele.data('isTextOnly') ? getTextMeasureLabel(ele) : (ele.data('label') || '');
                    if (!ele.data('isTextOnly')) {
                        return measureSingleLineFileNode(label, {
                            fontSize: deps.ROOT_NODE_FONT_SIZE,
                            fontWeight: 'bold',
                            baseWidth: 210,
                            minHeight: 78,
                            paddingX: 88,
                            paddingY: 38,
                            lineHeight: 42
                        }).width;
                    }
                    return deps.measureNodeLabel(label, {
                        baseWidth: 210,
                        minHeight: 78,
                        maxWidth: 560,
                        charWidth: 18,
                        lineHeight: 42,
                        paddingX: 88,
                        paddingY: 38
                    }).width;
                },
                'height': (ele: any) => {
                    const manualHeightModel = Number(ele.data('manualHeightModel') || 0);
                    if (manualHeightModel > 0 && ele.data('isTextOnly')) {
                        return manualHeightModel;
                    }
                    const label = ele.data('isTextOnly') ? getTextMeasureLabel(ele) : (ele.data('label') || '');
                    if (!ele.data('isTextOnly')) {
                        return measureSingleLineFileNode(label, {
                            fontSize: deps.ROOT_NODE_FONT_SIZE,
                            fontWeight: 'bold',
                            baseWidth: 210,
                            minHeight: 78,
                            paddingX: 88,
                            paddingY: 38,
                            lineHeight: 42
                        }).height;
                    }
                    return deps.measureNodeLabel(label, {
                        baseWidth: 210,
                        minHeight: 78,
                        maxWidth: 560,
                        charWidth: 18,
                        lineHeight: 42,
                        paddingX: 88,
                        paddingY: 38
                    }).height;
                },
                'border-width': '4.5px'
            } as any
        },
        {
            selector: 'node[?isRoot][!isFreeNode]:selected',
            style: {
                'background-color': theme.node.rootSelectedBackground,
                'border-color': theme.node.rootSelectedBorder,
                'border-width': '5px',
                'color': theme.node.textSelected
            } as any
        },
        // 分组节点样式 - 完全透明（由 CSS glass overlay 层实现视觉效果）
        {
            selector: '.group-node',
            style: {
                'background-color': 'transparent',
                'background-opacity': 0,
                'border-width': '0px',
                'shape': 'round-rectangle',
                'label': '',
                'padding': '20px'
            } as any
        },
        // 占位符节点样式 - 虚线边框，半透明
        {
            selector: 'node[?isPlaceholder]',
            style: {
                'width': (ele: any) => Math.max(240, computeAutoTextMetrics(ele.data('label') || '').width),
                'height': (ele: any) => Math.max(80, computeAutoTextMetrics(ele.data('label') || '').height),
                'opacity': 0.7,
                'border-style': 'dashed',
                'border-width': '2px',
                'border-color': colors.nodeBorderSelected,
                'background-color': colors.nodeBackground
            } as any
        },
        // 占位符节点选中状态 - 更明显的视觉反馈
        {
            selector: 'node[?isPlaceholder]:selected',
            style: {
                'opacity': 1,
                'border-style': 'dashed',
                'border-width': '3px',
                'border-color': colors.nodeBorderSelected,
                'background-color': colors.nodeBackgroundSelected,
                'overlay-color': colors.nodeBorderSelected,
                'overlay-padding': '4px',
                'overlay-opacity': 0.3
            } as any
        },
        // 草稿节点(#20):与普通节点同款渲染(尺寸/背景/文字都走通用规则),仅边框不同——
        // 虚线 + origin 配色(ai=紫,manual=灰),标识"待审批"。不覆盖 width/height/background。
        {
            selector: 'node[?isDraft]',
            style: {
                'border-style': 'dashed',
                'border-width': '2px',
                'border-color': (ele: any) => ele.data('draftOrigin') === 'ai' ? '#a855f7' : '#94a3b8',
                // 草稿走 Cytoscape 原生 label(无 Markdown overlay 兜底文字),text-max-width 必须从
                // label 直接量取,与 width mapper 同源——否则 isTextOnly 规则里基于 ele.width() 的换行宽度
                // 会在样式解析时读到瞬时/过期宽度,造成"未选中换行、选中(强制重算)又变一行"的抖动。
                'text-max-width': (ele: any) => computeAutoTextMetrics(getTextMeasureLabel(ele)).wrapWidth
            } as any
        },
        {
            selector: 'node[?isDraft]:selected',
            style: {
                'border-style': 'dashed',
                'border-width': '3px',
                'border-color': (ele: any) => ele.data('draftOrigin') === 'ai' ? '#a855f7' : '#64748b',
                'overlay-color': (ele: any) => ele.data('draftOrigin') === 'ai' ? '#a855f7' : '#64748b',
                'overlay-padding': '4px',
                'overlay-opacity': 0.2
            } as any
        },
        // 跨领域虚拟节点(cd- 前缀):从别的 MOC 拉进来的"客人"。
        // 紫色虚线描边把它和本图原生节点区分开,配合左上角 ↗ 角标(见 nodeBadges)。
        {
            selector: 'node[?isCrossDomain]',
            style: {
                'border-style': 'dashed',
                'border-width': '2px',
                'border-color': theme.edge.crossDomain,
                'border-opacity': 0.85
            } as any
        },
        {
            selector: 'node[?isCrossDomain]:selected',
            style: {
                'border-style': 'dashed',
                'border-width': '3px',
                'border-color': theme.edge.crossDomain,
                'border-opacity': 1,
                'overlay-color': theme.edge.crossDomain,
                'overlay-padding': '4px',
                'overlay-opacity': 0.2
            } as any
        },
        // 折叠隐藏的子节点/连线
        {
            selector: 'node.zk-collapsed-hidden',
            style: {
                'display': 'none'
            } as any
        },
        {
            selector: 'edge.zk-collapsed-hidden',
            style: {
                'display': 'none'
            } as any
        },
        {
            selector: 'node.zk-level-dimmed',
            style: {
                'opacity': theme.effects.dimmedNodeOpacity,
                'text-opacity': theme.effects.dimmedTextOpacity,
                'z-index': 1
            } as any
        },
        {
            selector: 'edge.zk-level-dimmed',
            style: {
                'opacity': theme.effects.dimmedEdgeOpacity,
                'z-index': 1
            } as any
        },
        // 默认边样式 - 使用 unbundled-bezier 支持自定义控制点
        {
            selector: 'edge',
            style: {
                'width': (ele: any) => {
                    const hierarchyEdgeWidth = ele.data('hierarchyEdgeWidth');
                    if (typeof hierarchyEdgeWidth === 'number') {
                        return hierarchyEdgeWidth;
                    }
                    return 2;
                },
                'line-color': colors.edgeNormal,
                'target-arrow-color': colors.edgeNormal,
                'target-arrow-shape': 'triangle',
                'curve-style': edgeStyle === 'straight'
                    ? 'straight'
                    : (edgeStyle === 'polyline' ? 'taxi' : 'unbundled-bezier'),
                'taxi-direction': 'auto',
                'taxi-turn': 40,
                'control-point-distances': (ele: any) => {
                    if (edgeStyle !== 'bezier') return 0;
                    const distance = ele.data('controlPointDistance');
                    return distance !== undefined ? distance : 60;
                },
                'control-point-weights': (ele: any) => {
                    if (edgeStyle !== 'bezier') return 0.5;
                    const weight = ele.data('controlPointWeight');
                    return weight !== undefined ? weight : 0.5;
                },
                'arrow-scale': 1.5,
                'label': 'data(label)',
                'font-size': '18px',
                'color': colors.nodeText,
                'text-background-opacity': 0,
                'text-border-opacity': 0,
                'z-index-compare': 'manual',
                'z-index': 999
            } as any
        },
        // 普通父子边降噪，让根 -> 1级主干成为第一眼路径
        {
            selector: 'edge[type="parent"][!isRootToFirstLevel]',
            style: {
                'opacity': deps.SECONDARY_PARENT_EDGE_OPACITY,
                'arrow-scale': 1.18,
                'z-index': 997
            } as any
        },
        // 正向边
        {
            selector: 'edge[type="forward"]',
            style: {
                'line-color': colors.edgeForward,
                'target-arrow-color': colors.edgeForward,
                'width': 2.5,
                'z-index': 999
            } as any
        },
        // 反向边（虚线）- 降噪设计
        {
            selector: 'edge[type="reverse"]',
            style: {
                'line-style': 'dashed',
                'line-dash-pattern': [12, 8],
                'line-color': '#64748b',
                'target-arrow-color': '#64748b',
                'width': 2.2,
                'arrow-scale': 1.35,
                'opacity': 0.38,
                'z-index': 999
            } as any
        },
        // 局部概览中的入链/出链边：弱化为虚线，和节点导航实线区分
        {
            selector: 'edge[type="inlink"]',
            style: {
                'curve-style': 'bezier',
                'control-point-distances': -80,
                'control-point-weights': 0.5,
                'line-style': 'dashed',
                'line-dash-pattern': [7, 8],
                'line-color': theme.edge.inlink,
                'target-arrow-color': theme.edge.inlink,
                'width': 1.6,
                'arrow-scale': 0.95,
                'opacity': 0.42,
                'z-index': 998
            } as any
        },
        {
            selector: 'edge[type="outlink"]',
            style: {
                'curve-style': 'bezier',
                'control-point-distances': 80,
                'control-point-weights': 0.5,
                'line-style': 'dashed',
                'line-dash-pattern': [7, 8],
                'line-color': theme.edge.outlink,
                'target-arrow-color': theme.edge.outlink,
                'width': 1.6,
                'arrow-scale': 0.95,
                'opacity': 0.42,
                'z-index': 998
            } as any
        },
        // 跨领域边（虚线连接 + 特殊样式）
        // 线本身降噪(line-opacity)，但标签用 text-opacity:1 + 药丸底保持清晰可读，
        // 不被整体 opacity 拖暗。药丸浮在虚线之上而非与之交叠。
        {
            selector: 'edge[type="cross-domain"]',
            style: {
                'line-style': 'dashed',
                'line-dash-pattern': [14, 8],
                'line-color': theme.edge.crossDomain,
                'target-arrow-color': theme.edge.crossDomain,
                'width': 1.8,
                'arrow-scale': 1.2,
                'line-opacity': 0.5,
                'label': 'data(label)',
                'font-size': '14px',
                'font-weight': 600,
                'color': theme.edge.crossDomainLabelText,
                'text-opacity': 1,
                'text-background-color': theme.edge.crossDomainLabelBg,
                'text-background-opacity': 1,
                'text-background-shape': 'roundrectangle',
                'text-background-padding': '5px',
                'text-border-color': theme.edge.crossDomain,
                'text-border-width': 1,
                'text-border-opacity': 0.9,
                'text-margin-y': -1,
                'z-index': 998
            } as any
        },
        // 根节点 -> 1级节点：主干连线突出，但不过度抢占画布
        {
            selector: 'edge[?isRootToFirstLevel]',
            style: {
                'width': deps.ROOT_TO_FIRST_LEVEL_EDGE_WIDTH,
                'opacity': deps.ROOT_TO_FIRST_LEVEL_EDGE_OPACITY,
                'line-color': theme.edge.rootToFirstLevel,
                'target-arrow-color': theme.edge.rootToFirstLevel,
                'arrow-scale': 1.45,
                'z-index': 1001
            } as any
        },
        // 当前选中分支的主干边:渐变高光 + 微发光,作为视觉锚点
        {
            selector: 'edge.zk-active-root-branch-edge[?isRootToFirstLevel]',
            style: {
                'opacity': deps.ACTIVE_ROOT_TO_FIRST_LEVEL_EDGE_OPACITY,
                'line-fill': 'linear-gradient',
                'line-gradient-stop-colors': theme.edge.activeRootGradient,
                'line-gradient-stop-positions': '0 100',
                'target-arrow-color': theme.edge.activeRootArrow,
                'arrow-scale': 1.55,
                'overlay-color': theme.edge.activeRootArrow,
                'overlay-opacity': 0.10,
                'overlay-padding': 4,
                'z-index': 1002
            } as any
        },
        // 边选中状态
        {
            selector: 'edge:selected',
            style: {
                'line-color': colors.edgeSelected,
                'target-arrow-color': colors.edgeSelected,
                'width': 3,
                'opacity': 1,
                'z-index': 1002
            } as any
        },
        // 锚点节点 —— 金光从节点本体散发出来,不再仅靠角标贴纸
        {
            selector: 'node[?isAnchor][!isGroup][!isPlaceholder]',
            style: {
                'underlay-color': '#f5dc68',
                'underlay-opacity': 0.18,
                'underlay-padding': 8,
                'underlay-shape': 'round-rectangle',
                'border-color': 'rgba(216, 197, 119, 0.78)',
                'border-opacity': 0.95
            } as any
        },
        // 节点悬停状态
        {
            selector: 'node:active',
            style: {
                'background-color': colors.nodeBackgroundHover,
                'border-color': colors.nodeBorderSelected,
                'overlay-opacity': 0.15
            } as any
        },
        // 节点选中状态
        {
            selector: 'node:selected',
            style: {
                'background-color': colors.nodeBackgroundSelected,
                'border-color': colors.nodeBorderSelected,
                'border-width': '2.5px',
                'border-opacity': 0.90,
                'color': theme.node.textSelected
            } as any
        },
        // 根节点选中态需要压过通用 node:selected
        {
            selector: 'node[?isRoot][!isFreeNode]:selected',
            style: {
                'background-color': theme.node.rootSelectedBackground,
                'border-color': theme.node.rootSelectedBorder,
                'border-width': '5px',
                'border-opacity': 1,
                'z-index': 1003,
                'color': theme.node.textSelected
            } as any
        },
        // 自由节点：微底色晕染
        {
            selector: 'node[?isFreeNode]:unselected',
            style: {
                'background-color': theme.node.freeBackground,
                'background-opacity': theme.effects.freeBackgroundOpacity,
                'font-size': '20px',
                'border-width': isModern ? '2.5px' : '2px',
                'border-opacity': 0,
                'border-color': 'transparent',
                'corner-radius': '10px',
            } as any
        },
        // 自由节点选中态：与普通节点保持一致
        {
            selector: 'node[?isFreeNode]:selected',
            style: {
                'background-opacity': 1,
                'background-color': colors.nodeBackgroundSelected,
                'border-color': colors.nodeBorderSelected,
                'border-width': '3px',
                'color': theme.node.textSelected
            } as any
        },
        // 兼容旧语义：仅有 legacy customColor 的节点保留文字左侧色点留白
        {
            selector: 'node[?hasCustomColor][!isEmbed][!isGroup]',
            style: {
                'text-margin-x': 8,
            } as any
        },
        // 嵌入节点选中态：保持隐藏（由 HTML 预览卡片处理选中视觉）
        {
            selector: 'node[?isEmbed]:selected',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'overlay-opacity': 0
            } as any
        },
        // 嵌入节点激活态：保持隐藏
        {
            selector: 'node[?isEmbed]:active',
            style: {
                'overlay-opacity': 0
            } as any
        },
        // 图片节点：始终隐藏（由 HTML 图片卡片处理视觉）
        {
            selector: 'node[?isImageNode]:selected',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'overlay-opacity': 0
            } as any
        },
        {
            selector: 'node[?isImageNode]:active',
            style: {
                'overlay-opacity': 0
            } as any
        },
        // 当前文件节点（与分支视图根节点颜色一致）
        {
            selector: 'node[?isCurrentFile]',
            style: {
                'background-color': theme.node.currentBackground,
                'border-color': theme.node.currentBorder,
                'border-width': '2.5px',
                'background-opacity': theme.effects.currentBackgroundOpacity,
                'color': theme.node.textSelected,
                'font-weight': '600'
            } as any
        },
        // 出链节点样式（蓝色）
        {
            selector: 'node[?isOutlink]',
            style: {
                'background-color': theme.node.outlinkBackground,
                'background-opacity': theme.effects.inoutBackgroundOpacity,
                'border-color': theme.node.outlinkBorder,
                'border-width': '1.5px',
                'color': theme.node.outlinkText,
                'font-size': '15px',
                'font-weight': '500',
                'text-max-width': '190px',
                'width': (ele: any) => deps.measureNodeLabel(ele.data('label') || '', {
                    baseWidth: 88,
                    minHeight: 34,
                    maxWidth: 220,
                    charWidth: 8,
                    lineHeight: 16,
                    paddingX: 30,
                    paddingY: 12
                }).width,
                'height': (ele: any) => deps.measureNodeLabel(ele.data('label') || '', {
                    baseWidth: 88,
                    minHeight: 34,
                    maxWidth: 220,
                    charWidth: 8,
                    lineHeight: 16,
                    paddingX: 30,
                    paddingY: 12
                }).height,
            } as any
        },
        // 入链节点样式（黄色）
        {
            selector: 'node[?isInlink]',
            style: {
                'background-color': theme.node.inlinkBackground,
                'background-opacity': theme.effects.inoutBackgroundOpacity,
                'border-color': theme.node.inlinkBorder,
                'border-width': '1.5px',
                'color': theme.node.inlinkText,
                'font-size': '15px',
                'font-weight': '500',
                'text-max-width': '190px',
                'width': (ele: any) => deps.measureNodeLabel(ele.data('label') || '', {
                    baseWidth: 88,
                    minHeight: 34,
                    maxWidth: 220,
                    charWidth: 8,
                    lineHeight: 16,
                    paddingX: 30,
                    paddingY: 12
                }).width,
                'height': (ele: any) => deps.measureNodeLabel(ele.data('label') || '', {
                    baseWidth: 88,
                    minHeight: 34,
                    maxWidth: 220,
                    charWidth: 8,
                    lineHeight: 16,
                    paddingX: 30,
                    paddingY: 12
                }).height,
            } as any
        },
        // 连接目标悬停状态
        {
            selector: 'node.connection-target-hover',
            style: {
                'border-color': '#10b981',
                'border-width': '3px',
                'background-color': 'rgba(16, 185, 129, 0.1)'
            } as any
        },
        // 自动布局父节点拖动时，跟随移动的后代节点
        {
            selector: 'node.auto-hierarchy-descendant',
            style: {
                'border-color': '#4dabf7',
                'border-width': '2.5px',
                'border-style': 'dashed',
                'border-opacity': 0.9
            } as any
        },
        {
            selector: 'edge.auto-hierarchy-descendant-edge',
            style: {
                'line-color': '#4dabf7',
                'target-arrow-color': '#4dabf7',
                'source-arrow-color': '#4dabf7',
                'width': 2,
                'opacity': 0.85,
                'line-style': 'dashed'
            } as any
        },
        // 高亮子节点箭头
        {
            selector: 'edge.child-edge-highlight',
            style: {
                'line-color': '#a78b71',
                'target-arrow-color': '#a78b71',
                'width': 2.5,
                'opacity': 0.8,
                'z-index': 1000
            } as any
        },
        // 祖先链高亮:点击/选中节点时,其到 root 的路径恢复亮色;沿途的边稍微加粗加亮。
        // 放在 level-2+ muted 规则之后,在 level-dimmed 之前 —— 这样 muted 被覆盖,但若有
        // 显式 levelDim 屏蔽,后续的 dimmed 规则仍能胜出。
        {
            selector: 'node.zk-ancestor-active',
            style: {
                'color': theme.node.text,
                'background-opacity': 1,
                'border-opacity': 0.92,
                'z-index': 1005
            } as any
        },
        {
            selector: 'edge.zk-ancestor-active',
            style: {
                'width': 3.2,
                'opacity': 0.95,
                'z-index': 1004
            } as any
        },
        // ===== Nebula 风格专属层 =====
        // 放在所有常规节点/边状态之后、dimmed 之前:既能压过 muted/firstLevel/selected 的底色,
        // 又不会把被 dimmed 的无关分支重新点亮(dimmed 规则在后,underlay/opacity 仍胜出)。
        ...(isNebula ? [
            // 节点外发光:沿分支色(或选中/根色)散出霓虹光晕,营造"星云"漂浮感。
            // 排除分组/嵌入/图片/占位/锚点(锚点有自己的金光 underlay)。
            {
                selector: 'node[!isGroup][!isEmbed][!isImageNode][!isPlaceholder][!isAnchor][!isStandaloneText]',
                style: {
                    'underlay-color': (ele: any) =>
                        ele.data('branchNodeBorder')
                        || (ele.data('isRoot') ? theme.node.rootBorder : theme.node.borderSelected),
                    'underlay-opacity': 0.12,
                    'underlay-padding': 7,
                    'underlay-shape': 'round-rectangle',
                } as any
            },
            // 左侧色条:概念节点(2 级及以下,非根/非 1 级/非特殊节点)左缘一道分支色亮条,
            // 用 to-right 线性渐变实现(前 ~4% 为色条,其余为卡片底色)。仅未选中态启用,
            // 选中时回退实心底,选中高亮正常显示。
            {
                selector: 'node[!isRoot][!isFirstLevelNode][!isFreeNode][!isEmbed][!isStandaloneText][!isGroup][!isPlaceholder][!isImageNode][!isCrossDomain][!isDraft]:unselected',
                style: {
                    'background-opacity': 0.96,
                    'background-fill': 'linear-gradient',
                    'background-gradient-direction': 'to-right',
                    // stop-colors 必须是空格分隔的纯色 token,内部不能含空格/逗号
                    // (rgba(r, g, b, a) 会被 Cytoscape 解析器拆错),故一律用 hex。
                    'background-gradient-stop-colors': (ele: any) => {
                        const accent = deps.normalizeHexColor(ele.data('branchNodeBorder')) || '#5fd3c6';
                        const fill = deps.normalizeHexColor(ele.data('customFillColor')) || theme.node.background;
                        return `${accent} ${accent} ${fill} ${fill}`;
                    },
                    'background-gradient-stop-positions': '0 4 4 100',
                    'border-opacity': 0.5,
                    'color': theme.node.text,
                } as any
            },
            // 1 级节点:卡片左缘同样加一道更亮的分支色条(未选中态)。
            {
                selector: 'node[?isFirstLevelNode][!isRoot][!isFreeNode][!isEmbed][!isStandaloneText]:unselected',
                style: {
                    'background-fill': 'linear-gradient',
                    'background-gradient-direction': 'to-right',
                    // 同上:stop-colors 仅用 hex,避免 rgba() 内的空格/逗号破坏解析。
                    'background-gradient-stop-colors': (ele: any) => {
                        const branch = deps.normalizeHexColor(ele.data('branchNodeBorder') || '');
                        const accent = branch || theme.node.borderSelected;
                        const fill = branch
                            ? deps.darkenColor(branch, 0.62)
                            : theme.node.firstLevelFallback;
                        return `${accent} ${accent} ${fill} ${fill}`;
                    },
                    'background-gradient-stop-positions': '0 5 5 100',
                } as any
            },
            // 语义/反向边:霓虹紫虚线,提高可见度(默认反向边偏灰且很淡)。
            {
                selector: 'edge[type="reverse"]',
                style: {
                    'line-color': '#9b6bff',
                    'target-arrow-color': '#9b6bff',
                    'line-dash-pattern': [10, 7],
                    'width': 2.2,
                    'opacity': 0.72,
                } as any
            },
            // 带标签的边:药丸式标签底(圆角 + 紫色细描边 + 深底),漂在连线之上清晰可读。
            {
                selector: 'edge[label]',
                style: {
                    'color': '#dccbff',
                    'font-size': '14px',
                    'font-weight': 600,
                    'text-background-color': '#191430',
                    'text-background-opacity': 0.92,
                    'text-background-shape': 'roundrectangle',
                    'text-background-padding': '5px',
                    'text-border-color': 'rgba(155, 107, 255, 0.55)',
                    'text-border-width': 1,
                    'text-border-opacity': 0.85,
                } as any
            },
        ] : []),
        // 弱化无关分支的节点需要放在所有节点状态之后，避免被选中/当前文件/自定义状态覆盖。
        {
            selector: 'node.zk-level-dimmed',
            style: {
                'opacity': theme.effects.dimmedNodeOpacity,
                'text-opacity': theme.effects.dimmedTextOpacity,
                'background-opacity': theme.isLight ? 0.38 : 0.12,
                'border-opacity': theme.isLight ? 0.34 : 0.18,
                'overlay-opacity': 0,
                'underlay-opacity': 0,
                'z-index': 1
            } as any
        },
        {
            selector: 'node.zk-level-dimmed[!isRoot][!isFirstLevelNode][!isFreeNode][!isEmbed][!isStandaloneText][!isCurrentFile]',
            style: {
                'background-opacity': theme.isLight ? 0.38 : 0.12,
                'border-opacity': theme.isLight ? 0.34 : 0.18,
                'color': theme.node.textMuted
            } as any
        },
        // 弱化无关分支的边需要放在所有边样式之后，避免被 root->1级主干/高亮边 opacity 覆盖。
        {
            selector: 'edge.zk-level-dimmed',
            style: {
                'opacity': theme.effects.lateDimmedEdgeOpacity,
                'overlay-opacity': 0,
                'z-index': 1
            } as any
        },
        ...(isLight ? [
            // 浅色主题最终文字兜底：放在所有节点状态之后，避免 root/current/selected/dimmed 叠加后标题发白。
            {
                selector: 'node[!isEmbed][!isImageNode][!hasMarkdownOverlay]',
                style: {
                    'color': (ele: any) => {
                        const fillColor = ele.data('customFillColor');
                        const fillTextColor = ele.data('customFillTextColor');
                        return fillColor && fillTextColor ? fillTextColor : theme.node.text;
                    },
                    'text-opacity': 1,
                    'text-outline-width': 0,
                    'text-background-opacity': 0,
                    'text-border-opacity': 0
                } as any
            },
            {
                selector: 'node.zk-level-dimmed[!isEmbed][!isImageNode][!hasMarkdownOverlay]',
                style: {
                    'color': theme.node.text,
                    'opacity': 0.9,
                    'text-opacity': 1
                } as any
            }
        ] : []),
        // 搜索高亮
        {
            selector: 'node.zk-search-highlight',
            style: {
                'border-width': '4px',
                'border-color': '#00a8ff',
                'border-opacity': 1,
                'z-index': 9999
            } as any
        }
    ];
}
