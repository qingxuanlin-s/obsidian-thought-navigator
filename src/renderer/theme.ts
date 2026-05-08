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

export function getGraphTheme(options: RenderOptions): GraphThemeTokens {
	return options.themeMode === 'light' ? lightGraphTheme : darkGraphTheme;
}
