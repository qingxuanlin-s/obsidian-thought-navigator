import type { RenderOptions } from './types';
import type { StyleEntry, StylesheetDeps } from './stylesheet';
import { lightGraphTheme, darkGraphTheme } from './themes/base';
import { nebulaGraphTheme, nebulaLightGraphTheme, buildNebulaStyles } from './themes/nebula';
import { basePreview, modernPreview, nebulaPreview, modernBranch, nebulaBranch } from './themes/appearance';

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


export type ThemeMode = 'light' | 'dark';
export type ThemeStyle = NonNullable<RenderOptions['themeStyle']>;
export type ThemeOptions = Pick<RenderOptions, 'themeMode' | 'themeStyle'>;
export interface PreviewCardTheme {
	cardBackground: string;
	cardBorder: string;
	cardShadow: string;
	headerBackground: string;
	headerDivider: string;
	textColor: string;
	headerText: string;
	headerHoverText: string;
	selectedBorder: string;
	selectedShadow: string;
	opacity: string;
	filter: string;
}
export type BranchAppearance = { background: string; border: string; shadow: string };
export interface GraphStyleDefinition {
	themes: Record<ThemeMode, GraphThemeTokens>;
	branchBorders: boolean;
	branchBadges: boolean;
	freeBorderWidth: string;
	earlyRules: (theme: GraphThemeTokens, deps: StylesheetDeps) => StyleEntry[];
	lateRules: (theme: GraphThemeTokens, deps: StylesheetDeps) => StyleEntry[];
	branch: ((theme: GraphThemeTokens, background: string, accent: string) => BranchAppearance) | null;
	preview: (theme: GraphThemeTokens, branch: string | null) => PreviewCardTheme;
}
const noRules = (): StyleEntry[] => [];
const baseThemes = { light: lightGraphTheme, dark: darkGraphTheme };
/** 风格扩展只在此登记；明暗配色和 Canvas/DOM 表现由各自模块提供。 */
export const GRAPH_STYLES: Record<ThemeStyle, GraphStyleDefinition> = {
	default: {
		themes: baseThemes, branchBorders: false, branchBadges: false, freeBorderWidth: '2px',
		earlyRules: noRules, lateRules: noRules, branch: null, preview: basePreview,
	},
	modern: {
		themes: baseThemes, branchBorders: true, branchBadges: true, freeBorderWidth: '2.5px',
		earlyRules: () => [{ selector: 'node[!isRoot][!isEmbed][!isStandaloneText]', style: { 'border-width': '2.5px' } }],
		lateRules: noRules, branch: modernBranch, preview: modernPreview,
	},
	nebula: {
		themes: { light: nebulaLightGraphTheme, dark: nebulaGraphTheme },
		branchBorders: false, branchBadges: false, freeBorderWidth: '2px',
		earlyRules: noRules, lateRules: buildNebulaStyles, branch: nebulaBranch, preview: nebulaPreview,
	},
};
export function getGraphStyle(options?: ThemeOptions | null): GraphStyleDefinition {
	const name = options?.themeStyle || 'modern';
	return Object.prototype.hasOwnProperty.call(GRAPH_STYLES, name) ? GRAPH_STYLES[name] : GRAPH_STYLES.modern;
}
export function getGraphTheme(options?: ThemeOptions | null): GraphThemeTokens {
	return getGraphStyle(options).themes[options?.themeMode === 'light' ? 'light' : 'dark'];
}
/** 每次切换先清除旧的风格/明暗类，视图无需知道任何具体风格。 */
export function applyViewTheme(element: HTMLElement, options: ThemeOptions): void {
	element.classList.remove('zk-theme-light', 'zk-theme-dark', ...Object.keys(GRAPH_STYLES).map(name => `zk-style-${name}`));
	const style = Object.prototype.hasOwnProperty.call(GRAPH_STYLES, options.themeStyle || 'modern') ? options.themeStyle || 'modern' : 'modern';
	element.classList.add(`zk-theme-${options.themeMode || 'dark'}`, `zk-style-${style}`);
}
