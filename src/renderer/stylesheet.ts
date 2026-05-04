import { RenderOptions } from './types';

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
}

export function buildStylesheet(options: RenderOptions, deps: StylesheetDeps): any[] {
    const isLight = options.themeMode === 'light';
    const isModern = (options.themeStyle || 'modern') === 'modern';
    const edgeStyle = options.edgeStyle || 'bezier';

    const colors = isLight ? {
        // 浅色主题颜色
        nodeBackground: '#f0f0f0',
        nodeBackgroundHover: '#e0e0e0',
        nodeBackgroundSelected: '#d0d0d0',
        nodeBorder: '#b0b0b0',
        nodeBorderSelected: '#0066cc',
        nodeText: '#333333',
        nodeTextMuted: '#666666',
        edgeNormal: '#7d8597',
        edgeForward: '#60a5fa',
        edgeReverse: '#dc2626',
        edgeSelected: '#7c3aed',
        textBackground: '#ffffff',
        overlayColor: '#60a5fa',
        badgeBackground: '#60a5fa',
        badgeText: '#ffffff'
    } : {
        // 深色主题颜色
        nodeBackground: '#1a2332',
        nodeBackgroundHover: '#243447',
        nodeBackgroundSelected: '#2d4a6b',
        nodeBorder: '#3d5a80',
        nodeBorderSelected: '#5b8fd9',
        nodeText: '#ffffff',
        nodeTextMuted: '#94a3b8',
        edgeNormal: '#7c8aa3',
        edgeForward: '#5b8fd9',
        edgeReverse: '#ef4444',
        edgeSelected: '#7c3aed',
        textBackground: '#0f172a',
        overlayColor: '#5b8fd9',
        badgeBackground: '#5b8fd9',
        badgeText: '#ffffff'
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
                    const label = ele.data('label') || '';
                    const measured = deps.measureNodeLabel(label, {
                        baseWidth: 90,
                        minHeight: 42,
                        maxWidth: 280,
                        charWidth: 11,
                        lineHeight: 18,
                        paddingX: 40,
                        paddingY: 20
                    });
                    const compensated = deps.compensateFreeLikeNodeFrameSize(label, measured, {
                        isFreeNode: true,
                        isStandaloneText: !!ele.data('isStandaloneText'),
                        maxWidth: 280,
                        charWidth: 11
                    });
                    return compensated.width;
                },
                'height': (ele: any) => {
                    const manualHeightModel = Number(ele.data('manualHeightModel') || 0);
                    if (manualHeightModel > 0 && ele.data('isTextOnly')) {
                        return manualHeightModel;
                    }
                    const label = ele.data('label') || '';
                    const measured = deps.measureNodeLabel(label, {
                        baseWidth: 90,
                        minHeight: 42,
                        maxWidth: 280,
                        charWidth: 11,
                        lineHeight: 18,
                        paddingX: 40,
                        paddingY: 20
                    });
                    const compensated = deps.compensateFreeLikeNodeFrameSize(label, measured, {
                        isFreeNode: true,
                        isStandaloneText: !!ele.data('isStandaloneText'),
                        maxWidth: 280,
                        charWidth: 11
                    });
                    return compensated.height;
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
                    const widthModel = manualWidthModel > 0 ? manualWidthModel : (w > 0 ? w : 200);
                    return Math.max(120, widthModel - 48);
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
                    return branchColor
                        ? deps.hexToRgba(deps.darkenColor(branchColor, 0.62), 0.72)
                        : '#132033';
                },
                'background-opacity': 0.78,
                'border-color': (ele: any) => ele.data('branchNodeBorder') || '#5da6ff',
                'border-width': '2.6px',
                'border-opacity': 0.92,
                'z-index': 1000,
                'font-size': `${deps.FIRST_LEVEL_NODE_FONT_SIZE}px`,
                'font-weight': 'bold',
                'text-max-width': (ele: any) => {
                    if (ele.data('isTextOnly')) {
                        const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                        const widthModel = manualWidthModel > 0 ? manualWidthModel : Number(ele.width() || 340);
                        return Math.max(160, widthModel - 52);
                    }
                    return 340;
                },
                'width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    if (manualWidthModel > 0 && ele.data('isTextOnly')) {
                        return manualWidthModel;
                    }
                    return deps.measureNodeLabel(ele.data('label') || '', {
                        baseWidth: 118,
                        minHeight: 54,
                        maxWidth: 340,
                        charWidth: 12,
                        lineHeight: 28,
                        paddingX: 44,
                        paddingY: 22
                    }).width;
                },
                'height': (ele: any) => {
                    const manualHeightModel = Number(ele.data('manualHeightModel') || 0);
                    if (manualHeightModel > 0 && ele.data('isTextOnly')) {
                        return manualHeightModel;
                    }
                    const measured = deps.measureNodeLabel(ele.data('label') || '', {
                        baseWidth: 118,
                        minHeight: 54,
                        maxWidth: 340,
                        charWidth: 12,
                        lineHeight: 28,
                        paddingX: 44,
                        paddingY: 22
                    }).height;
                    // 1 级文本节点字体大（24px），保证最低 90 给字符留呼吸空间
                    if (ele.data('isTextOnly')) {
                        return Math.max(measured, 90);
                    }
                    return measured;
                }
            } as any
        },
        // 当前激活的 1 级分支：只有这一支使用实心填充
        {
            selector: 'node.zk-active-first-level-branch[?isFirstLevelNode][!isRoot][!isFreeNode][!isEmbed][!isStandaloneText]',
            style: {
                'background-color': (ele: any) => ele.data('branchNodeBackground') || '#173b5f',
                'background-opacity': 0.98,
                'border-color': (ele: any) => {
                    const branchColor = deps.normalizeHexColor(ele.data('branchNodeBorder') || '');
                    return branchColor ? deps.lightenColor(branchColor, 0.30) : '#9ed0ff';
                },
                'border-width': '3.7px',
                'border-opacity': 0.98,
                'color': '#ffffff',
                'text-outline-color': 'rgba(8, 16, 28, 0.42)',
                'text-outline-width': 1.1,
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
                'color': isLight ? '#475569' : '#c5ceda'
            } as any
        },
        // 根节点样式：当前图谱焦点
        {
            selector: 'node[?isRoot][!isFreeNode]',
            style: {
                'background-color': '#082746',
                'border-color': '#9ed0ff',
                'background-opacity': 0.98,
                'border-opacity': 0.98,
                'z-index': 1002,
                'font-size': `${deps.ROOT_NODE_FONT_SIZE}px`,
                'font-weight': 'bold',
                'text-max-width': (ele: any) => {
                    if (ele.data('isTextOnly')) {
                        const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                        const widthModel = manualWidthModel > 0 ? manualWidthModel : Number(ele.width() || 560);
                        return Math.max(220, widthModel - 76);
                    }
                    return 560;
                },
                'width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    if (manualWidthModel > 0 && ele.data('isTextOnly')) {
                        return manualWidthModel;
                    }
                    const label = ele.data('label') || '';
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
                    const label = ele.data('label') || '';
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
                'background-color': '#0b3158',
                'border-color': '#8cc2ff',
                'border-width': '5px',
                'color': '#ffffff'
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
                'opacity': 0.18,
                'text-opacity': 0.24,
                'z-index': 1
            } as any
        },
        {
            selector: 'edge.zk-level-dimmed',
            style: {
                'opacity': 0.08,
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
                'line-color': isLight ? '#d97706' : '#e8b86d',
                'target-arrow-color': isLight ? '#d97706' : '#e8b86d',
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
                'line-color': isLight ? '#0f766e' : '#5cced6',
                'target-arrow-color': isLight ? '#0f766e' : '#5cced6',
                'width': 1.6,
                'arrow-scale': 0.95,
                'opacity': 0.42,
                'z-index': 998
            } as any
        },
        // 跨领域边（虚线连接 + 特殊样式）
        {
            selector: 'edge[type="cross-domain"]',
            style: {
                'line-style': 'dashed',
                'line-dash-pattern': [14, 8],
                'line-color': '#a08be8',
                'target-arrow-color': '#a08be8',
                'width': 1.8,
                'arrow-scale': 1.2,
                'opacity': 0.58,
                'label': 'data(label)',
                'font-size': '18px',
                'color': '#a08be8',
                'text-background-opacity': 0,
                'text-border-opacity': 0,
                'z-index': 998
            } as any
        },
        // 根节点 -> 1级节点：主干连线突出，但不过度抢占画布
        {
            selector: 'edge[?isRootToFirstLevel]',
            style: {
                'width': deps.ROOT_TO_FIRST_LEVEL_EDGE_WIDTH,
                'opacity': deps.ROOT_TO_FIRST_LEVEL_EDGE_OPACITY,
                'line-color': isLight ? '#94a4c8' : '#9aa5c8',
                'target-arrow-color': isLight ? '#94a4c8' : '#9aa5c8',
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
                'line-gradient-stop-colors': isLight
                    ? '#7c6cdf #b696ff'
                    : '#8a78e8 #c8a8ff',
                'line-gradient-stop-positions': '0 100',
                'target-arrow-color': isLight ? '#b696ff' : '#c8a8ff',
                'arrow-scale': 1.55,
                'overlay-color': isLight ? '#b696ff' : '#c8a8ff',
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
                'color': '#ffffff'
            } as any
        },
        // 根节点选中态需要压过通用 node:selected
        {
            selector: 'node[?isRoot][!isFreeNode]:selected',
            style: {
                'background-color': '#0b3158',
                'border-color': '#8cc2ff',
                'border-width': '5px',
                'border-opacity': 1,
                'z-index': 1003,
                'color': '#ffffff'
            } as any
        },
        // 自由节点：微底色晕染
        {
            selector: 'node[?isFreeNode]:unselected',
            style: {
                'background-color': isLight ? '#94a3b8' : '#7b9cc4',
                'background-opacity': isLight ? 0.05 : 0.04,
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
                'color': '#ffffff'
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
                'background-color': '#253b58',
                'border-color': '#5da6ff',
                'border-width': '2.5px',
                'font-weight': '600'
            } as any
        },
        // 出链节点样式（蓝色）
        {
            selector: 'node[?isOutlink]',
            style: {
                'background-color': isLight ? '#ccfbf1' : '#173b42',
                'background-opacity': isLight ? 0.78 : 0.68,
                'border-color': isLight ? '#2dd4bf' : '#5cced6',
                'border-width': '1.5px',
                'color': isLight ? '#134e4a' : '#d9fbff',
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
                'background-color': isLight ? '#fef3c7' : '#4a3425',
                'background-opacity': isLight ? 0.78 : 0.68,
                'border-color': isLight ? '#f59e0b' : '#e8b86d',
                'border-width': '1.5px',
                'color': isLight ? '#78350f' : '#fff3dc',
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
