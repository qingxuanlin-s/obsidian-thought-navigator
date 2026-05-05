export interface DomTextMeasureOptions {
	fontSize: number;
	fontWeight?: string;
	maxWidth: number;
	lineHeight?: number;
}

export interface DomTextMeasureResult {
	width: number;
	height: number;
	lineCount: number;
}

export class DomTextMeasurer {
	private host: HTMLDivElement;
	private cache = new Map<string, DomTextMeasureResult>();
	private cacheKeys: string[] = [];
	private readonly maxCacheSize = 200;

	constructor(parent: HTMLElement) {
		this.host = document.createElement('div');
		this.host.className = 'zk-measure-host';
		this.host.style.cssText = `
			position: absolute;
			left: -99999px;
			top: 0;
			visibility: hidden;
			pointer-events: none;
			white-space: pre-wrap;
			word-break: break-word;
			overflow-wrap: anywhere;
			box-sizing: border-box;
		`;
		parent.appendChild(this.host);
	}

	measure(text: string, opts: DomTextMeasureOptions): DomTextMeasureResult {
		const lineHeight = opts.lineHeight ?? Math.ceil(opts.fontSize * 1.4);
		const fontWeight = opts.fontWeight ?? '500';
		const key = `${text}|${opts.fontSize}|${fontWeight}|${opts.maxWidth}|${lineHeight}`;
		const cached = this.cache.get(key);
		if (cached) return cached;

		this.host.style.fontSize = `${opts.fontSize}px`;
		this.host.style.fontWeight = fontWeight;
		this.host.style.lineHeight = `${lineHeight}px`;
		this.host.style.fontFamily = 'var(--font-text)';
		this.host.textContent = text || ' ';

		this.host.style.whiteSpace = 'pre';
		this.host.style.wordBreak = 'normal';
		this.host.style.overflowWrap = 'normal';
		this.host.style.maxWidth = 'none';
		this.host.style.width = 'max-content';
		const naturalWidth = Math.ceil(this.host.getBoundingClientRect().width);
		const measuredWidth = Math.min(opts.maxWidth, naturalWidth);

		this.host.style.whiteSpace = 'pre-wrap';
		this.host.style.wordBreak = 'break-word';
		this.host.style.overflowWrap = 'anywhere';
		this.host.style.maxWidth = `${measuredWidth}px`;
		this.host.style.width = `${measuredWidth}px`;
		const rect = this.host.getBoundingClientRect();
		const result = {
			width: measuredWidth,
			height: rect.height,
			lineCount: Math.max(1, Math.round(rect.height / lineHeight))
		};

		if (this.cacheKeys.length >= this.maxCacheSize) {
			const old = this.cacheKeys.shift();
			if (old) this.cache.delete(old);
		}
		this.cache.set(key, result);
		this.cacheKeys.push(key);
		return result;
	}

	invalidate(): void {
		this.cache.clear();
		this.cacheKeys = [];
	}

	destroy(): void {
		this.host.remove();
		this.invalidate();
	}
}
