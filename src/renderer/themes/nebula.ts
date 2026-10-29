import type { GraphThemeTokens } from '../theme';
import type { StyleEntry, StylesheetDeps } from '../stylesheet';
import { lightGraphTheme, darkGraphTheme } from './base';
import { lightenColor } from '../colorMath';
import { dataStr } from '../cyData';
import type * as cytoscape from 'cytoscape';

// Nebula(暗色)—— 深空黑底 + 霓虹描边。在 darkGraphTheme 基础上压暗节点底色、
// 提亮边/语义线饱和度,配合 stylesheet 的发光 underlay 与左侧色条,营造"星云"质感。
export const nebulaGraphTheme: GraphThemeTokens = {
	...darkGraphTheme,
	node: {
		...darkGraphTheme.node,
		background: '#182235', backgroundHover: '#22324b', backgroundSelected: '#293e5d',
		border: '#526684', borderSelected: '#b5a4ff',
		text: '#edf2fb', textMuted: '#bdcbe0', textSelected: '#ffffff',
		firstLevelFallback: '#1c2b40', firstLevelText: '#f4f7ff',
		activeFirstLevelFallback: '#253956', activeFirstLevelText: '#ffffff',
		rootBackground: '#1b2e49', rootBorder: '#8eafd8',
		rootSelectedBackground: '#293e5d', rootSelectedBorder: '#b5a4ff',
		currentBackground: '#253956', currentBorder: '#8eafd8',
	},
	edge: {
		...darkGraphTheme.edge,
		normal: '#8193b0', reverse: '#b59aff', selected: '#c2b1ff', rootToFirstLevel: '#879ab9',
		crossDomain: '#b59aff', crossDomainLabelBg: '#222b43', crossDomainLabelText: '#dfd5ff',
	},
	effects: {
		...darkGraphTheme.effects,
		rootBackgroundOpacity: 1, firstLevelBackgroundOpacity: 1,
		activeFirstLevelBackgroundOpacity: 1, activeFirstLevelOutlineWidth: 0,
	},
};

// Nebula(浅色)—— 浅灰冷底 + 白卡片柔影。卡片纯白、边框极淡(层次靠 underlay 柔影
// 与左侧分支色条),根节点绿色强调,语义/跨域线走紫色虚线 + 淡紫药丸标签。
export const nebulaLightGraphTheme: GraphThemeTokens = {
	...lightGraphTheme,
	node: {
		...lightGraphTheme.node,
		background: '#ffffff',
		backgroundHover: '#f4f6fa',
		backgroundSelected: '#e9f1fd',
		border: '#dfe3ea',
		borderSelected: '#5a8fe6',
		text: '#1f2937',
		textMuted: '#8d95a3',
		firstLevelFallback: '#f3f5f9',
		firstLevelText: '#1f2937',
		activeFirstLevelFallback: '#e8f2ff',
		activeFirstLevelText: '#152238',
		rootBackground: '#e7f6ee',
		rootBorder: '#3fae72',
		rootSelectedBackground: '#daf0e5',
		rootSelectedBorder: '#2f9a62',
		currentBackground: '#e6f0fd',
		currentBorder: '#5a8fe6',
	},
	edge: {
		...lightGraphTheme.edge,
		normal: '#c3c9d4',
		forward: '#5a8fe6',
		reverse: '#7c6fe0',
		selected: '#7c5fd6',
		rootToFirstLevel: '#b7bfcd',
		activeRootGradient: '#4faf78 #8b6bd6',
		activeRootArrow: '#8b6bd6',
		crossDomain: '#8a76e0',
		crossDomainLabelBg: '#efecfb',
		crossDomainLabelText: '#5b4bbd',
	},
	badge: {
		background: '#3fae72',
		text: '#ffffff',
	},
};


const appearances = {
	light: {
		underlayColor: '#5b6678', underlayOpacity: 0.08, underlayPadding: 8,
		borderOpacity: 0.5, reverseOpacity: 0.82, labelOpacity: 0.96,
		labelBorder: 'rgba(124, 111, 224, 0.45)',
		firstLevelFill: (branch: string | null, theme: GraphThemeTokens, _active: boolean) => branch ? lightenColor(branch, 0.82) : theme.node.firstLevelFallback,
		states: (_theme: GraphThemeTokens): StyleEntry[] => [],
	},
	dark: {
		underlayColor: '#000000', underlayOpacity: 0, underlayPadding: 0,
		borderOpacity: 0.8, reverseOpacity: 0.9, labelOpacity: 1,
		labelBorder: '#76659f',
		firstLevelFill: (_branch: string | null, theme: GraphThemeTokens, active: boolean) => active ? theme.node.activeFirstLevelFallback : theme.node.firstLevelFallback,
		states: (theme: GraphThemeTokens): StyleEntry[] => [
			{
				selector: 'node[!isGroup][!isEmbed][!isImageNode][!isStandaloneText]',
				style: { 'transition-property': 'none', 'transition-duration': 0 },
			},
			{
				selector: 'node[?isRoot][!isFreeNode]:unselected',
				style: { 'border-width': 3, 'background-opacity': 1 },
			},
			{
				selector: 'node[!isGroup][!isEmbed][!isImageNode][!isPlaceholder][!isStandaloneText]:selected',
				style: {
					'background-fill': 'solid', 'background-color': theme.node.backgroundSelected,
					'background-opacity': 1, 'border-color': theme.node.borderSelected,
					'border-width': 3.5, 'border-opacity': 1, 'color': theme.node.textSelected,
					'overlay-opacity': 0, 'underlay-opacity': 0, 'text-outline-width': 0,
				},
			},
		],
	},
};

export function buildNebulaStyles(theme: GraphThemeTokens, deps: StylesheetDeps): StyleEntry[] {
	const appearance = appearances[theme.isLight ? 'light' : 'dark'];
	return [

			// 节点外发光:暗色沿分支色散出霓虹光晕,营造"星云"漂浮感;
			// 浅色改为中性灰柔影(模拟卡片投影,Cytoscape 无真阴影)。
			// 排除分组/嵌入/图片/占位/锚点(锚点有自己的金光 underlay)。
			{
				selector: 'node[!isGroup][!isEmbed][!isImageNode][!isPlaceholder][!isAnchor][!isStandaloneText]',
				style: {
					'underlay-color': appearance.underlayColor,
					'underlay-opacity': appearance.underlayOpacity,
					'underlay-padding': appearance.underlayPadding,
					'underlay-shape': 'round-rectangle',
				}
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
					'background-gradient-stop-colors': (ele: cytoscape.NodeSingular) => {
						const accent = deps.normalizeHexColor(dataStr(ele, 'branchNodeBorder'))
							|| theme.node.borderSelected;
						const fill = deps.normalizeHexColor(dataStr(ele, 'customFillColor')) || theme.node.background;
						return `${accent} ${accent} ${fill} ${fill}`;
					},
					// 色条按固定模型像素宽(~6px)而非节点宽度的百分比:
					// 大尺寸节点等比放大后,百分比色条会变得很宽并盖住文字,故按宽度反算 stop 百分比。
					'background-gradient-stop-positions': (ele: cytoscape.NodeSingular) => {
						const w = Number(ele.width()) || 0;
						const pct = w > 0 ? Math.min(18, (6 / w) * 100) : 4;
						return `0 ${pct} ${pct} 100`;
					},
					'border-opacity': appearance.borderOpacity,
					// 不写 'color':让前面 2 级及以下的 muted 文字规则透出,
					// 与 text-only 节点 DOM overlay 的 [data-level-muted] 色保持一致。
				}
			},
			// 1 级节点:卡片左缘同样加一道更亮的分支色条(未选中态)。
			{
				selector: 'node[?isFirstLevelNode][!isRoot][!isFreeNode][!isEmbed][!isStandaloneText]:unselected',
				style: {
					'background-fill': 'linear-gradient',
					'background-gradient-direction': 'to-right',
					// 同上:stop-colors 仅用 hex,避免 rgba() 内的空格/逗号破坏解析。
					// 暗色压暗分支色作卡底;浅色提亮分支色作淡彩卡底。
					'background-gradient-stop-colors': (ele: cytoscape.NodeSingular) => {
						const branch = deps.normalizeHexColor(dataStr(ele, 'branchNodeBorder'));
						const accent = branch || theme.node.borderSelected;
						const fill = appearance.firstLevelFill(branch, theme, ele.hasClass('zk-active-first-level-branch'));
						return `${accent} ${accent} ${fill} ${fill}`;
					},
					// 同上:1 级卡片色条也按固定模型像素宽(~8px,略粗以突出主干)反算百分比。
					'background-gradient-stop-positions': (ele: cytoscape.NodeSingular) => {
						const w = Number(ele.width()) || 0;
						const pct = w > 0 ? Math.min(18, (8 / w) * 100) : 5;
						return `0 ${pct} ${pct} 100`;
					},
				}
			},
			// 语义/反向边:紫色虚线,提高可见度(默认反向边偏灰且很淡)。
			{
				selector: 'edge[type="reverse"]',
				style: {
					'line-color': theme.edge.reverse,
					'target-arrow-color': theme.edge.reverse,
					'line-dash-pattern': [10, 7],
					'width': 2.2,
					'opacity': appearance.reverseOpacity,
				}
			},
			// 带标签的边:药丸式标签底(圆角 + 紫色细描边),漂在连线之上清晰可读。
			// 暗色深底浅字;浅色淡紫底紫字。
			{
				selector: 'edge[label]',
				style: {
					'color': theme.edge.crossDomainLabelText,
					'font-size': '14px',
					'font-weight': 600,
					'text-background-color': theme.edge.crossDomainLabelBg,
					'text-background-opacity': appearance.labelOpacity,
					'text-background-shape': 'roundrectangle',
					'text-background-padding': '5px',
					'text-border-color': appearance.labelBorder,
					'text-border-width': 1,
					'text-border-opacity': 0.85,
				}
			},
				...appearance.states(theme),
	];
}
