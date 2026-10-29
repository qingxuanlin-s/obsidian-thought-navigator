import type { RenderOptions } from './types';
import { getGraphStyle, getGraphTheme } from './theme';
import { BranchPaletteColor, SELECTION_COLOR_CHOICES, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, normalizeHexColor } from './colorMath';
export * from './colorMath';

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

export function getPreviewCardTheme(data: Record<string, unknown>, options: RenderOptions | null | undefined) {
	const branch = typeof data.branchNodeBorder === 'string' ? normalizeHexColor(data.branchNodeBorder) : null;
	return getGraphStyle(options).preview(getGraphTheme(options), branch);
}

export function applyPreviewHeaderLinkStyle(linkEl: HTMLElement, options?: RenderOptions | null): void {
	const colors = getGraphStyle(options).preview(getGraphTheme(options), null);
	linkEl.setCssStyles({ overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer', color: colors.headerText, transition: 'color 0.15s ease' });
	linkEl.addEventListener('mouseenter', () => linkEl.setCssStyles({ color: colors.headerHoverText }));
	linkEl.addEventListener('mouseleave', () => linkEl.setCssStyles({ color: colors.headerText }));
}

export function createInlineColorPicker(
	initialColor: string,
	onConfirm: (hexColor: string) => void,
	onCancel?: () => void
): HTMLElement {
	const picker = activeWindow.createDiv();
	picker.className = 'zk-inline-color-picker';
	picker.addEventListener('pointerdown', (e) => e.stopPropagation());
	picker.addEventListener('mousedown', (e) => e.stopPropagation());

	const svArea = activeWindow.createDiv();
	svArea.className = 'zk-inline-color-picker-sv';
	const svWhite = activeWindow.createDiv();
	svWhite.className = 'zk-inline-color-picker-sv-white';
	const svBlack = activeWindow.createDiv();
	svBlack.className = 'zk-inline-color-picker-sv-black';
	const svHandle = activeWindow.createDiv();
	svHandle.className = 'zk-inline-color-picker-handle';
	svArea.appendChild(svWhite);
	svArea.appendChild(svBlack);
	svArea.appendChild(svHandle);

	const hueSlider = activeWindow.createDiv();
	hueSlider.className = 'zk-inline-color-picker-hue';
	const hueHandle = activeWindow.createDiv();
	hueHandle.className = 'zk-inline-color-picker-hue-handle';
	hueSlider.appendChild(hueHandle);

	const footer = activeWindow.createDiv();
	footer.className = 'zk-inline-color-picker-footer';
	const preview = activeWindow.createSpan();
	preview.className = 'zk-inline-color-picker-preview';
	const confirmBtn = activeWindow.createEl('button');
	confirmBtn.type = 'button';
	confirmBtn.className = 'zk-inline-color-picker-btn';
	confirmBtn.textContent = '确认';
	const cancelBtn = activeWindow.createEl('button');
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
			activeDocument.removeEventListener('mousemove', onMove);
			activeDocument.removeEventListener('mouseup', onUp);
		};
		activeDocument.addEventListener('mousemove', onMove);
		activeDocument.addEventListener('mouseup', onUp);
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
			activeDocument.removeEventListener('mousemove', onMove);
			activeDocument.removeEventListener('mouseup', onUp);
		};
		activeDocument.addEventListener('mousemove', onMove);
		activeDocument.addEventListener('mouseup', onUp);
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
	const panel = activeWindow.createDiv();
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
		const swatch = activeWindow.createEl('button');
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
	const customSwatch = activeWindow.createEl('button');
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
