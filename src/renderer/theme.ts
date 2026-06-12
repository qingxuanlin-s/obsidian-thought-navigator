import type { RenderOptions } from './types';

export interface GraphThemeTokens {
	isLight: boolean;
	node: {
		background: string;
		backgroundHover: string;
		backgroundSelected: string;
		border: string;
		borderSelected: string;
		text: string;
		textMuted: string;
		textSelected: string;
		firstLevelFallback: string;
		firstLevelText: string;
		activeFirstLevelFallback: string;
		activeFirstLevelText: string;
		activeFirstLevelOutline: string;
		rootBackground: string;
		rootBorder: string;
		rootSelectedBackground: string;
		rootSelectedBorder: string;
		freeBackground: string;
		currentBackground: string;
		currentBorder: string;
		inlinkBackground: string;
		inlinkBorder: string;
		inlinkText: string;
		outlinkBackground: string;
		outlinkBorder: string;
		outlinkText: string;
	};
	edge: {
		normal: string;
		forward: string;
		reverse: string;
		selected: string;
		inlink: string;
		outlink: string;
		rootToFirstLevel: string;
		activeRootGradient: string;
		activeRootArrow: string;
		crossDomain: string;
		crossDomainLabelBg: string;
		crossDomainLabelText: string;
	};
	badge: {
		background: string;
		text: string;
	};
	effects: {
		dimmedNodeOpacity: number;
		dimmedTextOpacity: number;
		dimmedEdgeOpacity: number;
		lateDimmedEdgeOpacity: number;
		currentBackgroundOpacity: number;
		rootBackgroundOpacity: number;
		firstLevelBackgroundOpacity: number;
		activeFirstLevelBackgroundOpacity: number;
		inoutBackgroundOpacity: number;
		freeBackgroundOpacity: number;
		activeFirstLevelOutlineWidth: number;
	};
}

const lightGraphTheme: GraphThemeTokens = {
	isLight: true,
	node: {
		background: '#fbfcff',
		backgroundHover: '#eef4ff',
		backgroundSelected: '#dceaff',
		border: '#b8c4d6',
		borderSelected: '#256fd1',
		text: '#172033',
		textMuted: '#475569',
		textSelected: '#142033',
		firstLevelFallback: '#e7effb',
		firstLevelText: '#16243a',
		activeFirstLevelFallback: '#ddeaff',
		activeFirstLevelText: '#13203a',
		activeFirstLevelOutline: 'transparent',
		rootBackground: '#dbeafe',
		rootBorder: '#1f6fd1',
		rootSelectedBackground: '#cfe1fb',
		rootSelectedBorder: '#1d5fb8',
		freeBackground: '#64748b',
		currentBackground: '#dceaff',
		currentBorder: '#1f6fd1',
		inlinkBackground: '#fef3c7',
		inlinkBorder: '#d97706',
		inlinkText: '#78350f',
		outlinkBackground: '#ccfbf1',
		outlinkBorder: '#0f766e',
		outlinkText: '#134e4a',
	},
	edge: {
		normal: '#6f7f96',
		forward: '#256fd1',
		reverse: '#526174',
		selected: '#6d4fc2',
		inlink: '#b86b02',
		outlink: '#0c6f66',
		rootToFirstLevel: '#7890bd',
		activeRootGradient: '#4f7fd5 #8b6bd6',
		activeRootArrow: '#8b6bd6',
		crossDomain: '#7357c6',
		crossDomainLabelBg: '#f4f1fc',
		crossDomainLabelText: '#5b41a8',
	},
	badge: {
		background: '#256fd1',
		text: '#f8f9fc',
	},
	effects: {
		dimmedNodeOpacity: 0.78,
		dimmedTextOpacity: 0.84,
		dimmedEdgeOpacity: 0.26,
		lateDimmedEdgeOpacity: 0.24,
		currentBackgroundOpacity: 1,
		rootBackgroundOpacity: 1,
		firstLevelBackgroundOpacity: 0.96,
		activeFirstLevelBackgroundOpacity: 0.98,
		inoutBackgroundOpacity: 0.84,
		freeBackgroundOpacity: 0.075,
		activeFirstLevelOutlineWidth: 0,
	},
};

const darkGraphTheme: GraphThemeTokens = {
	isLight: false,
	node: {
		background: '#1a2332',
		backgroundHover: '#243447',
		backgroundSelected: '#2d4a6b',
		border: '#3d5a80',
		borderSelected: '#5b8fd9',
		text: '#ffffff',
		textMuted: '#94a3b8',
		textSelected: '#ffffff',
		firstLevelFallback: '#132033',
		firstLevelText: '#ffffff',
		activeFirstLevelFallback: '#173b5f',
		activeFirstLevelText: '#ffffff',
		activeFirstLevelOutline: 'rgba(8, 16, 28, 0.42)',
		rootBackground: '#082746',
		rootBorder: '#9ed0ff',
		rootSelectedBackground: '#0b3158',
		rootSelectedBorder: '#8cc2ff',
		freeBackground: '#7b9cc4',
		currentBackground: '#253b58',
		currentBorder: '#5da6ff',
		inlinkBackground: '#4a3425',
		inlinkBorder: '#e8b86d',
		inlinkText: '#fff3dc',
		outlinkBackground: '#173b42',
		outlinkBorder: '#5cced6',
		outlinkText: '#d9fbff',
	},
	edge: {
		normal: '#7c8aa3',
		forward: '#5b8fd9',
		reverse: '#64748b',
		selected: '#7c3aed',
		inlink: '#e8b86d',
		outlink: '#5cced6',
		rootToFirstLevel: '#9aa5c8',
		activeRootGradient: '#8a78e8 #c8a8ff',
		activeRootArrow: '#c8a8ff',
		crossDomain: '#a08be8',
		crossDomainLabelBg: '#241f33',
		crossDomainLabelText: '#cdbcff',
	},
	badge: {
		background: '#5b8fd9',
		text: '#ffffff',
	},
	effects: {
		dimmedNodeOpacity: 0.18,
		dimmedTextOpacity: 0.24,
		dimmedEdgeOpacity: 0.08,
		lateDimmedEdgeOpacity: 0.08,
		currentBackgroundOpacity: 1,
		rootBackgroundOpacity: 0.98,
		firstLevelBackgroundOpacity: 0.78,
		activeFirstLevelBackgroundOpacity: 0.98,
		inoutBackgroundOpacity: 0.68,
		freeBackgroundOpacity: 0.04,
		activeFirstLevelOutlineWidth: 1.1,
	},
};

// Nebula(暗色)—— 深空黑底 + 霓虹描边。在 darkGraphTheme 基础上压暗节点底色、
// 提亮边/语义线饱和度,配合 stylesheet 的发光 underlay 与左侧色条,营造"星云"质感。
const nebulaGraphTheme: GraphThemeTokens = {
	...darkGraphTheme,
	node: {
		...darkGraphTheme.node,
		background: '#161a24',
		backgroundHover: '#1f2533',
		backgroundSelected: '#27314c',
		border: '#3a4a66',
		borderSelected: '#7cb2ff',
		text: '#eef2f8',
		textMuted: '#8b93a7',
		firstLevelFallback: '#141a26',
		activeFirstLevelFallback: '#1a3656',
		rootBackground: '#0a1d38',
		rootBorder: '#9fd4ff',
		rootSelectedBackground: '#0d2748',
		rootSelectedBorder: '#bfe2ff',
		currentBackground: '#1f3556',
		currentBorder: '#6ec0ff',
	},
	edge: {
		...darkGraphTheme.edge,
		normal: '#5e6e8c',
		reverse: '#9b6bff',
		selected: '#a06bff',
		rootToFirstLevel: '#7e8bb5',
		crossDomain: '#b48bff',
		crossDomainLabelBg: '#191430',
		crossDomainLabelText: '#dccbff',
	},
};

// Nebula(浅色)—— 浅灰冷底 + 白卡片柔影。卡片纯白、边框极淡(层次靠 underlay 柔影
// 与左侧分支色条),根节点绿色强调,语义/跨域线走紫色虚线 + 淡紫药丸标签。
const nebulaLightGraphTheme: GraphThemeTokens = {
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

export function getGraphTheme(options: RenderOptions): GraphThemeTokens {
	if (options.themeStyle === 'nebula') {
		return options.themeMode === 'light' ? nebulaLightGraphTheme : nebulaGraphTheme;
	}
	return options.themeMode === 'light' ? lightGraphTheme : darkGraphTheme;
}
