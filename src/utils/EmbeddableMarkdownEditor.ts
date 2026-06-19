import { App, Component, MarkdownView, TFile } from 'obsidian';

let embeddableEditorCtor: any | null = null;
let ctorResolveError = '';

function resolveEmbeddableEditorCtor(app: App): any | null {
	if (embeddableEditorCtor) return embeddableEditorCtor;

	const errors: string[] = [];
	const embedRegistry = (app as any).embedRegistry;
	const mdCreator = embedRegistry?.embedByExtension?.md;
	if (typeof mdCreator === 'function') {
		const dummy = activeDocument.createElement('div');
		let widgetView: any = null;
		try {
			widgetView = mdCreator({ app, containerEl: dummy }, null, '');
			if (widgetView) {
				widgetView.editable = true;
				widgetView.showEditor?.();
				const editMode = widgetView.editMode ?? widgetView;
				const editorProto = Object.getPrototypeOf(Object.getPrototypeOf(editMode));
				const ctor = editorProto?.constructor;
				if (ctor) {
					embeddableEditorCtor = ctor;
					return embeddableEditorCtor;
				}
				errors.push('embedRegistry: editor proto ctor missing');
			} else {
				errors.push('embedRegistry: md creator returned null');
			}
		} catch (err) {
			errors.push(`embedRegistry: ${String(err)}`);
		} finally {
			try { widgetView?.destroy?.(); } catch { /* ignore */ }
			try { widgetView?.unload?.(); } catch { /* ignore */ }
		}
	} else {
		errors.push('embedRegistry md creator unavailable');
	}

	try {
		const mdLeaf = app.workspace.getLeavesOfType('markdown')[0];
		const mdView = mdLeaf?.view as MarkdownView | undefined;
		const editMode = mdView ? ((mdView as any).editMode ?? (mdView as any).modes?.source) : null;
		if (editMode) {
			const editorProto = Object.getPrototypeOf(Object.getPrototypeOf(editMode));
			const ctor = editorProto?.constructor;
			if (ctor) {
				embeddableEditorCtor = ctor;
				return embeddableEditorCtor;
			}
			errors.push('markdown view: editor proto ctor missing');
		} else {
			errors.push('markdown view: editMode unavailable');
		}
	} catch (err) {
		errors.push(`markdown view: ${String(err)}`);
	}

	ctorResolveError = errors.join(' | ');
	return null;
}

export interface EmbeddableMarkdownEditorOptions {
	app: App;
	containerEl: HTMLElement;
	initialValue: string;
	sourcePath?: string;
	placeholder?: string;
	readOnly?: boolean;
	onChange?: (value: string) => void;
	onEnter?: (value: string, evt: KeyboardEvent) => boolean;
	onEscape?: (evt: KeyboardEvent) => void;
	onBlur?: (value: string) => void;
}

export class EmbeddableMarkdownEditor extends Component {
	private editView: any = null;
	private cm: any = null;
	private destroyed = false;
	private lastSelection: { from: number; to: number } | null = null;
	private readonly opts: EmbeddableMarkdownEditorOptions;
	// 统一管理 cm.dom 上挂的 listener:onunload 一键 abort,
	// 避免闭包链(this.opts.onChange → node → cy)被 cm.dom 引用挂住导致 GC 不掉。
	private listenerAbort: AbortController | null = null;

	constructor(opts: EmbeddableMarkdownEditorOptions) {
		super();
		this.opts = opts;
		this.mount();
	}

	// Obsidian 全局开启 vim 且当前处于 INSERT 模式时返回 true。
	// 判定依据:vim NORMAL 模式下 CM 会给编辑器元素挂 .cm-fat-cursor(块状光标);
	// 非 NORMAL 就视为 INSERT(含 visual 等子模态,行为上与 INSERT 一致 — 用户按 Esc 期待留在编辑器里)。
	private isVimInsertMode(): boolean {
		const vimEnabled = (this.opts.app.vault as any).getConfig?.('vimMode') === true;
		if (!vimEnabled) return false;
		const cm = this.cm;
		if (!cm?.dom) return false;
		return !cm.dom.querySelector('.cm-fat-cursor');
	}

	private insertText(text: string): void {
		const cm = this.cm;
		if (!cm) return;
		const editor = this.editView?.editor;
		if (editor?.replaceSelection) {
			try {
				editor.replaceSelection(text);
				this.opts.onChange?.(this.getValue());
				return;
			} catch {
				/* fallback below */
			}
		}
		const sel = cm.state?.selection?.main;
		if (sel !== undefined && cm.dispatch) {
			cm.dispatch({
				changes: { from: sel.from, to: sel.to, insert: text },
				selection: { anchor: sel.from + text.length }
			});
			this.opts.onChange?.(this.getValue());
		}
	}

	private getMarkdownContinuation(text: string, cursor: number): string {
		const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
		const line = text.slice(lineStart, cursor);
		const unordered = line.match(/^(\s*)([-*+])\s+(?:\[[ xX]\]\s+)?/);
		if (unordered) return `${unordered[1]}${unordered[2]} `;
		const ordered = line.match(/^(\s*)(\d+)([.)])\s+/);
		if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]} `;
		return '';
	}

	private insertSmartLineBreak(): void {
		const cm = this.cm;
		const cursor = cm?.state?.selection?.main?.from;
		const continuation = Number.isFinite(cursor)
			? this.getMarkdownContinuation(this.getValue(), cursor as number)
			: '';
		this.insertText(`\n${continuation}`);
	}

	private insertIndent(): void {
		this.insertText('\t');
	}

	private mount(): void {
		const Ctor = resolveEmbeddableEditorCtor(this.opts.app);
		if (!Ctor) {
			throw new Error(`Embeddable editor constructor not found (${ctorResolveError || 'unknown reason'})`);
		}

		const sourceFile = this.resolveSourceFile(this.opts.sourcePath);
		const owner = this.createOwner(sourceFile);
		this.editView = this.instantiateEditor(Ctor, owner);
		if (!this.editView) {
			throw new Error('Failed to instantiate embeddable markdown editor');
		}

		owner.editMode = this.editView;
		owner.editor = this.editView?.editor ?? owner.editor;
		this.editView.showEditor?.();
		this.setValue(this.opts.initialValue ?? '');

		this.cm = this.editView?.editor?.cm ?? this.editView?.cm ?? null;

		if (this.opts.readOnly) {
			// 只读模式：禁用编辑，隐藏光标
			if (this.cm?.contentDOM) {
				(this.cm.contentDOM as HTMLElement).contentEditable = 'false';
			}
		} else {
			this.bindCallbacks();
		}

		// CM 初始化时量到的字符度量是默认样式下的结果;我们叠加了字号覆盖 + 隐藏
		// heading widget/fold indicator,两轮 reflow 后行高才稳定,需要多次重量才能
		// 让 vim fat cursor 的 top/height 贴合实际。
		if (this.cm?.requestMeasure) {
			const measure = () => { if (!this.destroyed) this.cm?.requestMeasure?.(); };
			window.requestAnimationFrame(() => {
				measure();
				window.requestAnimationFrame(measure);
			});
		}
	}

	private resolveSourceFile(sourcePath?: string): TFile | null {
		if (!sourcePath) return null;
		const file = this.opts.app.vault.getAbstractFileByPath(sourcePath);
		return file instanceof TFile ? file : null;
	}

	private createOwner(sourceFile: TFile | null): any {
		const owner: any = {
			app: this.opts.app,
			file: sourceFile,
			containerEl: this.opts.containerEl,
			contentEl: this.opts.containerEl,
			editorEl: this.opts.containerEl,
			getMode: () => 'source',
			getViewType: () => 'markdown',
			getDisplayText: () => sourceFile?.basename ?? '',
			onMarkdownScroll: () => {},
			getFoldInfo: () => null,
			applyFoldInfo: () => {},
			onFileMetadataChange: () => {},
			onPaneMenu: () => {},
			save: async () => {},
			queueSave: () => {},
			load: async () => {},
			onLoadFile: async () => {},
			getScroll: () => 0,
			setScroll: () => {},
			syncScroll: () => {},
			onMarkdownFold: () => {},
			onResize: () => {},
			registerEditorExtension: () => {},
			registerExtensions: () => {},
		};

		owner.editor = {
			cm: null,
			refresh: () => {},
		};

		return owner;
	}

	private instantiateEditor(Ctor: any, owner: any): any {
		const attempts = [
			() => new Ctor(this.opts.app, this.opts.containerEl, owner),
			() => new Ctor(this.opts.app, this.opts.containerEl, owner, this),
			() => new Ctor(owner, this.opts.containerEl, this),
			() => new Ctor(owner, this.opts.containerEl),
		];
		let lastError: unknown = null;
		for (const attempt of attempts) {
			try {
				const instance = attempt();
				if (instance) return instance;
			} catch (err) {
				lastError = err;
			}
		}
		if (lastError) {
			throw lastError;
		}
		return null;
	}

	private bindCallbacks(): void {
		const cm = this.cm;
		if (!cm?.dom) return;

		this.listenerAbort = new AbortController();
		const signal = this.listenerAbort.signal;

		const captureSelection = () => {
			const sel = cm?.state?.selection?.main;
			if (!sel || sel.empty) return;
			this.lastSelection = { from: sel.from, to: sel.to };
		};

		cm.dom.addEventListener('input', () => {
			captureSelection();
			this.opts.onChange?.(this.getValue());
		}, { signal });
		cm.dom.addEventListener('mouseup', captureSelection, { capture: true, signal });
		cm.dom.addEventListener('keyup', captureSelection, { capture: true, signal });

		cm.dom.addEventListener('keydown', (e: KeyboardEvent) => {
			// vim INSERT 模式下 Esc 应交给 vim 切换到 NORMAL,不拦截、不取消;
			// 本监听器在 cm.dom 捕获阶段,早于 CM contentDOM 上的 vim 处理,
			// 此时读 .cm-fat-cursor 反映的是按键前的模式。
			if (e.key === 'Escape' && this.isVimInsertMode()) {
				return;
			}

			if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				e.stopPropagation();
				this.insertSmartLineBreak();
				return;
			}

			// 阻止冒泡到图级快捷键（方向键/Tab/Enter 等）
			e.stopPropagation();

			if (e.key === 'Tab') {
				e.preventDefault();
				this.insertIndent();
				return;
			}

			if (e.key === 'Enter' && this.opts.onEnter) {
				e.preventDefault();
				if (!this.opts.onEnter(this.getValue(), e)) {
					// onEnter 返回 false 表示"允许换行"；这里统一显式插入，
					// 避免 Shift/Meta/Ctrl + Enter 依赖浏览器/编辑器默认行为而失效
					this.insertSmartLineBreak();
				}
				return;
			}
			if (e.key === 'Escape') {
				this.opts.onEscape?.(e);
			}
		}, { capture: true, signal });

		cm.dom.addEventListener('focusout', () => {
			window.setTimeout(() => {
				if (this.destroyed) return;
				if (this.opts.containerEl.contains(activeDocument.activeElement)) return;
				this.opts.onBlur?.(this.getValue());
			}, 50);
		}, { signal });
	}

	getValue(): string {
		if (this.editView?.get) {
			return this.editView.get();
		}
		const stateDoc = this.editView?.editor?.cm?.state?.doc;
		if (stateDoc && typeof stateDoc.toString === 'function') {
			return stateDoc.toString();
		}
		return '';
	}

	setValue(value: string): void {
		if (this.editView?.set) {
			try {
				this.editView.set(value, true);
				return;
			} catch {
				/* fallback below */
			}
			try {
				this.editView.set(value);
				return;
			} catch {
				/* fallback below */
			}
		}
		const cm = this.editView?.editor?.cm;
		if (cm?.dispatch) {
			cm.dispatch({
				changes: {
					from: 0,
					to: cm.state.doc.length,
					insert: value,
				},
			});
		}
	}

	focus(): void {
		try {
			this.cm?.focus?.();
		} catch {
			/* ignore */
		}
	}

	focusEnd(): void {
		const move = () => {
			if (this.destroyed) return;
			const cm = this.cm;
			const editor = this.editView?.editor;
			try {
				const value = this.getValue();
				const end = cm?.state?.doc?.length ?? value.length;
				if (editor?.offsetToPos && editor?.setCursor) {
					editor.setCursor(editor.offsetToPos(end));
				}
				if (cm?.dispatch && Number.isFinite(end)) {
					cm.dispatch({ selection: { anchor: end } });
				}
				editor?.focus?.();
				cm?.focus?.();
			} catch {
				/* ignore */
			}
		};

		move();
		window.requestAnimationFrame(move);
		window.setTimeout(move, 30);
	}

	getContentHeight(): number {
		const contentDom = this.cm?.contentDOM as HTMLElement | undefined;
		if (contentDom && contentDom.scrollHeight > 0) {
			return contentDom.scrollHeight;
		}
		const scrollDom = this.cm?.scrollDOM as HTMLElement | undefined;
		if (scrollDom && scrollDom.scrollHeight > 0) {
			return scrollDom.scrollHeight;
		}
		return 0;
	}

	getVerticalOverflow(): number {
		const scrollDom = this.cm?.scrollDOM as HTMLElement | undefined;
		if (!scrollDom) return 0;
		return Math.max(0, scrollDom.scrollHeight - scrollDom.clientHeight);
	}

	getDom(): HTMLElement | null {
		return (this.cm?.dom as HTMLElement | undefined) ?? null;
	}

	getCM(): any {
		return this.cm;
	}

	insertLineBreak(): void {
		this.insertSmartLineBreak();
	}

	/** 在光标处插入文本(走 insertText,会触发 onChange 让节点实时刷新) */
	insertAtCursor(text: string): void {
		this.insertText(text);
	}

	transformSelection(formatter: (selectedText: string) => string): boolean {
		const cm = this.cm;
		if (!cm?.dispatch) return false;
		const selection = cm?.state?.selection?.main;
		const from = (selection && !selection.empty) ? selection.from : this.lastSelection?.from;
		const to = (selection && !selection.empty) ? selection.to : this.lastSelection?.to;
		if (!Number.isFinite(from) || !Number.isFinite(to) || (to as number) <= (from as number)) return false;
		const fromNum = from as number;
		const toNum = to as number;
		const selectedText = cm.state.doc.sliceString(fromNum, toNum);
		const replacedText = formatter(selectedText);
		const head = fromNum + replacedText.length;

		cm.dispatch({
			changes: { from: fromNum, to: toNum, insert: replacedText },
			selection: { anchor: fromNum, head },
		});
		this.lastSelection = { from: fromNum, to: head };
		this.opts.onChange?.(this.getValue());
		return true;
	}

	onunload(): void {
		this.destroyed = true;
		try { this.listenerAbort?.abort(); } catch { /* ignore */ }
		this.listenerAbort = null;
		try { this.editView?.destroy?.(); } catch { /* ignore */ }
		try { this.editView?.unload?.(); } catch { /* ignore */ }
		this.editView = null;
		this.cm = null;
	}
}
