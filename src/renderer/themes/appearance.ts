import type { GraphThemeTokens, PreviewCardTheme, BranchAppearance } from '../theme';
import { hexToRgba, lightenColor, softenColor } from '../colorMath';

const previewPalettes = {
	light: { border: 'rgba(90, 111, 127, 0.22)', header: 'rgba(248, 250, 253, 0.92)', divider: 'rgba(90, 111, 127, 0.28)', text: '#253044', muted: '#5d6678', opacity: '0.92', filter: 'none', branchBorder: 0.45, branchDivider: 0.25 },
	dark: { border: 'rgba(90, 111, 127, 0.28)', header: 'rgba(11, 16, 25, 0.72)', divider: 'rgba(90, 111, 127, 0.45)', text: '#edf2fb', muted: '#b6c3d7', opacity: '0.82', filter: 'brightness(0.86) saturate(0.92)', branchBorder: 0.38, branchDivider: 0.25 },
};
export function basePreview(theme: GraphThemeTokens): PreviewCardTheme {
	const palette = previewPalettes[theme.isLight ? 'light' : 'dark'];
	const border = `1px solid ${palette.border}`;
	return {
		cardBackground: 'transparent', cardBorder: border, cardShadow: 'none',
		headerBackground: palette.header, headerDivider: palette.divider,
		textColor: palette.text, headerText: palette.muted, headerHoverText: palette.text,
		selectedBorder: border, selectedShadow: 'none', opacity: palette.opacity, filter: palette.filter,
	};
}
export function modernPreview(theme: GraphThemeTokens, branch: string | null): PreviewCardTheme {
	const base = basePreview(theme);
	const palette = previewPalettes[theme.isLight ? 'light' : 'dark'];
	const border = branch ? `1px solid ${hexToRgba(branch, palette.branchBorder)}` : base.cardBorder;
	const shadow = branch ? `0 0 10px ${hexToRgba(branch, 0.35)}` : 'none';
	return {
		...base, cardBorder: border, cardShadow: shadow, headerBackground: 'transparent',
		headerDivider: branch ? hexToRgba(branch, palette.branchDivider) : base.headerDivider,
		selectedBorder: border, selectedShadow: shadow,
	};
}
export function nebulaPreview(theme: GraphThemeTokens): PreviewCardTheme {
	const base = basePreview(theme);
	const modes = {
		light: base,
		dark: {
			...base, cardBackground: '#172235', cardBorder: '1px solid #42536e',
			headerBackground: '#1e2c43', headerDivider: '#42536e',
			selectedBorder: '2px solid #b5a4ff', selectedShadow: 'none', opacity: '1', filter: 'none',
		},
	};
	return modes[theme.isLight ? 'light' : 'dark'];
}
const modernBranches = {
	light: (_background: string, accent: string): BranchAppearance => {
		const border = softenColor(accent, true);
		return { border, background: hexToRgba(border, 0.12), shadow: 'transparent' };
	},
	dark: (background: string): BranchAppearance => ({ background, border: lightenColor(background, 0.12), shadow: hexToRgba(background, 0.22) }),
};
export function modernBranch(theme: GraphThemeTokens, background: string, accent: string): BranchAppearance {
	return modernBranches[theme.isLight ? 'light' : 'dark'](background, accent);
}
export function nebulaBranch(_theme: GraphThemeTokens, background: string, accent: string): BranchAppearance {
	return { background, border: accent, shadow: 'transparent' };
}
