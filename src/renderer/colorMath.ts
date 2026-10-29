export type RgbColor = { r: number; g: number; b: number };
export type HsvColor = { h: number; s: number; v: number };
export type BranchPaletteColor = { background: string; accent: string };

export const SELECTION_COLOR_CHOICES = ['#00a8ff', '#34d399', '#f59e0b', '#ef4444', '#a78bfa', '#e2e8f0'];
export const DEFAULT_SELECTION_TEXT_COLOR = '#00a8ff';
export const DEFAULT_SELECTION_BG_COLOR = '#f59e0b';

export function hexToRgb(hex: string): RgbColor {
	const normalized = hex.replace('#', '').trim();
	const full = normalized.length === 3
		? normalized.split('').map((c) => c + c).join('')
		: normalized.padStart(6, '0').slice(0, 6);
	const intVal = Number.parseInt(full, 16);
	return {
		r: (intVal >> 16) & 255,
		g: (intVal >> 8) & 255,
		b: intVal & 255
	};
}

export function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function rgbToHsv(r: number, g: number, b: number): HsvColor {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const delta = max - min;

	let h = 0;
	if (delta > 0) {
		if (max === rn) h = ((gn - bn) / delta) % 6;
		else if (max === gn) h = (bn - rn) / delta + 2;
		else h = (rn - gn) / delta + 4;
		h *= 60;
		if (h < 0) h += 360;
	}

	const s = max === 0 ? 0 : delta / max;
	return { h, s, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): RgbColor {
	const c = v * s;
	const hp = (h % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r1 = 0;
	let g1 = 0;
	let b1 = 0;
	if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
	else if (hp < 2) [r1, g1, b1] = [x, c, 0];
	else if (hp < 3) [r1, g1, b1] = [0, c, x];
	else if (hp < 4) [r1, g1, b1] = [0, x, c];
	else if (hp < 5) [r1, g1, b1] = [x, 0, c];
	else [r1, g1, b1] = [c, 0, x];
	const m = v - c;
	return {
		r: (r1 + m) * 255,
		g: (g1 + m) * 255,
		b: (b1 + m) * 255
	};
}

export function normalizeHexColor(color: string | null | undefined): string | null {
	if (!color || typeof color !== 'string') return null;
	const trimmed = color.trim();
	const isHex3 = /^#([0-9a-fA-F]{3})$/.test(trimmed);
	const isHex6 = /^#([0-9a-fA-F]{6})$/.test(trimmed);
	if (!isHex3 && !isHex6) return null;
	if (isHex6) return trimmed.toLowerCase();
	const [, shortHex] = trimmed.match(/^#([0-9a-fA-F]{3})$/)!;
	return `#${shortHex.split('').map((c) => c + c).join('').toLowerCase()}`;
}

export function hexToRgba(hex: string, alpha: number): string {
	const normalized = normalizeHexColor(hex) || '#5b8fd9';
	const r = parseInt(normalized.slice(1, 3), 16);
	const g = parseInt(normalized.slice(3, 5), 16);
	const b = parseInt(normalized.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function softenColor(hex: string, isLight: boolean): string {
	const normalized = normalizeHexColor(hex) || '#5b8fd9';
	const r = parseInt(normalized.slice(1, 3), 16);
	const g = parseInt(normalized.slice(3, 5), 16);
	const b = parseInt(normalized.slice(5, 7), 16);

	const target = isLight ? 98 : 132;
	const ratio = isLight ? 0.54 : 0.50;
	const sr = Math.round(r * (1 - ratio) + target * ratio);
	const sg = Math.round(g * (1 - ratio) + target * ratio);
	const sb = Math.round(b * (1 - ratio) + target * ratio);

	return `#${sr.toString(16).padStart(2, '0')}${sg.toString(16).padStart(2, '0')}${sb.toString(16).padStart(2, '0')}`;
}

export function lightenColor(hex: string, amount: number): string {
	const normalized = normalizeHexColor(hex) || '#5b8fd9';
	const r = parseInt(normalized.slice(1, 3), 16);
	const g = parseInt(normalized.slice(3, 5), 16);
	const b = parseInt(normalized.slice(5, 7), 16);
	const lr = Math.min(255, Math.round(r + (255 - r) * amount));
	const lg = Math.min(255, Math.round(g + (255 - g) * amount));
	const lb = Math.min(255, Math.round(b + (255 - b) * amount));
	return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

export function darkenColor(hex: string, amount: number): string {
	const normalized = normalizeHexColor(hex) || '#5b8fd9';
	const r = parseInt(normalized.slice(1, 3), 16);
	const g = parseInt(normalized.slice(3, 5), 16);
	const b = parseInt(normalized.slice(5, 7), 16);
	const dr = Math.max(0, Math.round(r * (1 - amount)));
	const dg = Math.max(0, Math.round(g * (1 - amount)));
	const db = Math.max(0, Math.round(b * (1 - amount)));
	return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
}

