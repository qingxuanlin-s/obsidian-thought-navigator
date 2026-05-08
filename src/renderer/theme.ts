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
		background: '#f7f8fb',
		backgroundHover: '#eef2f8',
		backgroundSelected: '#e4ecf8',
		border: '#c7cfdd',
		borderSelected: '#3d73c4',
		text: '#253044',
		textMuted: '#687083',
		textSelected: '#253044',
		firstLevelFallback: '#edf2f8',
		firstLevelText: '#253044',
		activeFirstLevelFallback: '#edf2f8',
		activeFirstLevelText: '#243044',
		activeFirstLevelOutline: 'transparent',
		rootBackground: '#e8f1ff',
		rootBorder: '#2f7bd8',
		rootSelectedBackground: '#dfe9f8',
		rootSelectedBorder: '#3d73c4',
		freeBackground: '#94a3b8',
		currentBackground: '#eef4ff',
		currentBorder: '#2f7bd8',
		inlinkBackground: '#fef3c7',
		inlinkBorder: '#f59e0b',
		inlinkText: '#78350f',
		outlinkBackground: '#ccfbf1',
		outlinkBorder: '#2dd4bf',
		outlinkText: '#134e4a',
	},
	edge: {
		normal: '#8b96aa',
		forward: '#3d73c4',
		reverse: '#64748b',
		selected: '#6f57c4',
		inlink: '#d97706',
		outlink: '#0f766e',
		rootToFirstLevel: '#94a4c8',
		activeRootGradient: '#7c6cdf #b696ff',
		activeRootArrow: '#b696ff',
		crossDomain: '#8a6fd4',
	},
	badge: {
		background: '#3d73c4',
		text: '#f8f9fc',
	},
	effects: {
		dimmedNodeOpacity: 0.86,
		dimmedTextOpacity: 0.96,
		dimmedEdgeOpacity: 0.20,
		lateDimmedEdgeOpacity: 0.22,
		currentBackgroundOpacity: 0.96,
		rootBackgroundOpacity: 0.96,
		firstLevelBackgroundOpacity: 0.92,
		activeFirstLevelBackgroundOpacity: 0.94,
		inoutBackgroundOpacity: 0.78,
		freeBackgroundOpacity: 0.05,
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
