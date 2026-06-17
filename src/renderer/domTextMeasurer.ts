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
		this.host.setCssStyles({
			position: 'absolute',
			left: '-99999px',
			top: '0',
			visibility: 'hidden',
			pointerEvents: 'none',
			whiteSpace: 'pre-wrap',
			wordBreak: 'break-word',
			overflowWrap: 'anywhere',
			boxSizing: 'border-box',
		});
		parent.appendChild(this.host);
	}

	measure(text: string, opts: DomTextMeasureOptions): DomTextMeasureResult {
		const lineHeight = opts.lineHeight ?? Math.ceil(opts.fontSize * 1.4);
		const fontWeight = opts.fontWeight ?? '500';
		const key = `${text}|${opts.fontSize}|${fontWeight}|${opts.maxWidth}|${lineHeight}`;
		const cached = this.cache.get(key);
		if (cached) return cached;

		this.host.setCssStyles({
			fontSize: `${opts.fontSize}px`,
			fontWeight: fontWeight,
			lineHeight: `${lineHeight}px`,
			fontFamily: 'var(--font-text)',
		});
		this.host.textContent = text || ' ';

		this.host.setCssStyles({
			whiteSpace: 'pre',
			wordBreak: 'normal',
			overflowWrap: 'normal',
			maxWidth: 'none',
			width: 'max-content',
		});
		const naturalWidth = Math.ceil(this.host.getBoundingClientRect().width);
		const measuredWidth = Math.min(opts.maxWidth, naturalWidth);

		this.host.setCssStyles({
			whiteSpace: 'pre-wrap',
			wordBreak: 'break-word',
			overflowWrap: 'anywhere',
			maxWidth: `${measuredWidth}px`,
			width: `${measuredWidth}px`,
		});
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
