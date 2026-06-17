import type { RenderOptions } from './types';

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

export function isModernThemeStyle(options: RenderOptions | null | undefined): boolean {
	return (options?.themeStyle || 'modern') === 'modern';
}

export function getBranchStylePalette(): BranchPaletteColor[] {
	return [
		{ background: '#173f36', accent: '#5bbf9a' },
		{ background: '#4a3820', accent: '#d6a85d' },
		{ background: '#4a2630', accent: '#d07a8a' },
		{ background: '#213a55', accent: '#6ba7dc' },
		{ background: '#372b58', accent: '#a08be8' },
		{ background: '#203f46', accent: '#62bcc8' },
		{ background: '#46344c', accent: '#c58ad5' },
		{ background: '#31385d', accent: '#8c9de8' },
	];
}

export function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) - hash) + value.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash);
}

export function getPreviewCardTheme(data: any, options: RenderOptions | null | undefined): {
	cardBackground: string;
	cardBorder: string;
	cardShadow: string;
	headerBackground: string;
	headerDivider: string;
} {
	const isModern = isModernThemeStyle(options);
	const isColored = isModern;
	const branchBorderColor = typeof data?.branchNodeBorder === 'string' ? data.branchNodeBorder : '';
	const vividHeaderBackground = isColored && branchBorderColor
		? hexToRgba(branchBorderColor, options?.themeMode === 'light' ? 0.18 : 0.28)
		: 'rgba(11, 16, 25, 0.72)';
	const vividHeaderDivider = isColored && branchBorderColor
		? hexToRgba(branchBorderColor, options?.themeMode === 'light' ? 0.55 : 0.7)
		: 'rgba(90, 111, 127, 0.45)';

	const cardBorder = isModern && branchBorderColor
		? `1px solid ${hexToRgba(branchBorderColor, options?.themeMode === 'light' ? 0.45 : 0.38)}`
		: `1px solid rgba(90, 111, 127, 0.28)`;
	const cardShadow = isModern && branchBorderColor
		? `0 0 10px ${hexToRgba(branchBorderColor, 0.35)}`
		: 'none';
	const headerBackground = isModern ? 'transparent' : vividHeaderBackground;
	const headerDivider = isModern && branchBorderColor
		? hexToRgba(branchBorderColor, 0.25)
		: vividHeaderDivider;

	return {
		cardBackground: 'transparent',
		cardBorder,
		cardShadow,
		headerBackground,
		headerDivider
	};
}

export function applyPreviewHeaderLinkStyle(linkEl: HTMLElement): void {
	linkEl.setCssStyles({
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		cursor: 'pointer',
		color: 'var(--text-muted)',
		transition: 'color 0.15s ease',
	});
	linkEl.addEventListener('mouseenter', () => {
		linkEl.setCssStyles({ color: 'var(--text-normal)' });
	});
	linkEl.addEventListener('mouseleave', () => {
		linkEl.setCssStyles({ color: 'var(--text-muted)' });
	});
}

export function createInlineColorPicker(
	initialColor: string,
	onConfirm: (hexColor: string) => void,
	onCancel?: () => void
): HTMLElement {
	const picker = document.createElement('div');
	picker.className = 'zk-inline-color-picker';
	picker.addEventListener('pointerdown', (e) => e.stopPropagation());
	picker.addEventListener('mousedown', (e) => e.stopPropagation());

	const svArea = document.createElement('div');
	svArea.className = 'zk-inline-color-picker-sv';
	const svWhite = document.createElement('div');
	svWhite.className = 'zk-inline-color-picker-sv-white';
	const svBlack = document.createElement('div');
	svBlack.className = 'zk-inline-color-picker-sv-black';
	const svHandle = document.createElement('div');
	svHandle.className = 'zk-inline-color-picker-handle';
	svArea.appendChild(svWhite);
	svArea.appendChild(svBlack);
	svArea.appendChild(svHandle);

	const hueSlider = document.createElement('div');
	hueSlider.className = 'zk-inline-color-picker-hue';
	const hueHandle = document.createElement('div');
	hueHandle.className = 'zk-inline-color-picker-hue-handle';
	hueSlider.appendChild(hueHandle);

	const footer = document.createElement('div');
	footer.className = 'zk-inline-color-picker-footer';
	const preview = document.createElement('span');
	preview.className = 'zk-inline-color-picker-preview';
	const confirmBtn = document.createElement('button');
	confirmBtn.type = 'button';
	confirmBtn.className = 'zk-inline-color-picker-btn';
	confirmBtn.textContent = '确认';
	const cancelBtn = document.createElement('button');
	cancelBtn.type = 'button';
	cancelBtn.className = 'zk-inline-color-picker-btn';
	cancelBtn.textContent = '取消';
	footer.appendChild(preview);
	footer.appendChild(confirmBtn);
	footer.appendChild(cancelBtn);

	picker.appendChild(svArea);
	picker.appendChild(hueSlider);
	picker.appendChild(footer);

	const rgb = hexToRgb(initialColor);
	const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
	let h = hsv.h;
	let s = hsv.s;
	let v = hsv.v;

	const updateUi = () => {
		const hueRgb = hsvToRgb(h, 1, 1);
		const hueHex = rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b);
		svArea.setCssStyles({ backgroundColor: hueHex });
		hueHandle.setCssStyles({ left: `${(h / 360) * 100}%` });
		svHandle.setCssStyles({
			left: `${s * 100}%`,
			top: `${(1 - v) * 100}%`,
		});
		const out = hsvToRgb(h, s, v);
		preview.setCssStyles({ backgroundColor: rgbToHex(out.r, out.g, out.b) });
	};

	const currentHex = () => {
		const out = hsvToRgb(h, s, v);
		return rgbToHex(out.r, out.g, out.b);
	};

	const updateSvFromEvent = (evt: MouseEvent | PointerEvent) => {
		const rect = svArea.getBoundingClientRect();
		const x = Math.max(0, Math.min(rect.width, evt.clientX - rect.left));
		const y = Math.max(0, Math.min(rect.height, evt.clientY - rect.top));
		s = rect.width <= 0 ? 0 : x / rect.width;
		v = rect.height <= 0 ? 0 : 1 - (y / rect.height);
		updateUi();
	};

	const startSvDrag = (evt: MouseEvent) => {
		evt.preventDefault();
		updateSvFromEvent(evt);
		const onMove = (moveEvt: MouseEvent) => {
			moveEvt.preventDefault();
			updateSvFromEvent(moveEvt);
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	};

	const updateHueFromEvent = (evt: MouseEvent | PointerEvent) => {
		const rect = hueSlider.getBoundingClientRect();
		const x = Math.max(0, Math.min(rect.width, evt.clientX - rect.left));
		h = rect.width <= 0 ? 0 : (x / rect.width) * 360;
		updateUi();
	};

	const startHueDrag = (evt: MouseEvent) => {
		evt.preventDefault();
		updateHueFromEvent(evt);
		const onMove = (moveEvt: MouseEvent) => {
			moveEvt.preventDefault();
			updateHueFromEvent(moveEvt);
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	};

	svArea.addEventListener('mousedown', startSvDrag);
	hueSlider.addEventListener('mousedown', startHueDrag);

	confirmBtn.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	confirmBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onConfirm(currentHex());
	});
	cancelBtn.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	cancelBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onCancel?.();
	});

	updateUi();
	return picker;
}

export function createSelectionColorPanel(
	initialColor: string,
	recentColor: string | null,
	customTitle: string,
	onPick: (hexColor: string) => void
): HTMLElement {
	const panel = document.createElement('div');
	panel.className = 'zk-text-selection-color-panel';
	panel.addEventListener('pointerdown', (e) => e.stopPropagation());
	panel.addEventListener('mousedown', (e) => e.stopPropagation());

	const syncActiveSwatch = (targetColor: string) => {
		panel.querySelectorAll('.zk-text-selection-color-swatch').forEach((el) => {
			const swatch = el as HTMLElement;
			const swatchColor = swatch.dataset.color || '';
			swatch.classList.toggle(
				'is-active',
				swatchColor.toLowerCase() === targetColor.toLowerCase()
			);
		});
	};

	const appendSwatch = (color: string, extraClass: string, title: string) => {
		const swatch = document.createElement('button');
		swatch.type = 'button';
		swatch.className = `zk-text-selection-color-swatch${extraClass ? ' ' + extraClass : ''}`;
		swatch.dataset.color = color;
		swatch.setCssStyles({ backgroundColor: color });
		swatch.title = title;
		swatch.addEventListener('mousedown', (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		swatch.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			syncActiveSwatch(color);
			onPick(color);
		});
		panel.appendChild(swatch);
	};

	if (recentColor) {
		appendSwatch(recentColor, 'zk-text-selection-color-recent', `最近使用: ${recentColor}`);
	}

	SELECTION_COLOR_CHOICES.forEach((color) => {
		appendSwatch(color, '', color);
	});

	let inlinePicker: HTMLElement | null = null;
	const customSwatch = document.createElement('button');
	customSwatch.type = 'button';
	customSwatch.className = 'zk-text-selection-color-swatch zk-text-selection-color-custom';
	customSwatch.title = customTitle;
	customSwatch.textContent = '+';
	customSwatch.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	customSwatch.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (inlinePicker?.parentNode) {
			inlinePicker.remove();
			inlinePicker = null;
			return;
		}
		inlinePicker = createInlineColorPicker(
			initialColor,
			(hexColor) => {
				syncActiveSwatch(hexColor);
				onPick(hexColor);
			},
			() => {
				if (inlinePicker?.parentNode) inlinePicker.remove();
				inlinePicker = null;
			}
		);
		panel.appendChild(inlinePicker);
	});
	panel.appendChild(customSwatch);

	syncActiveSwatch(initialColor);
	return panel;
}
