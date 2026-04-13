import { App, Component, MarkdownView, TFile } from 'obsidian';

let embeddableEditorCtor: any | null = null;
let ctorResolveError = '';

function resolveEmbeddableEditorCtor(app: App): any | null {
	if (embeddableEditorCtor) return embeddableEditorCtor;

	const errors: string[] = [];
	const embedRegistry = (app as any).embedRegistry;
	const mdCreator = embedRegistry?.embedByExtension?.md;
	if (typeof mdCreator === 'function') {
		const dummy = document.createElement('div');
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

	constructor(opts: EmbeddableMarkdownEditorOptions) {
		super();
		this.opts = opts;
		this.mount();
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

		const captureSelection = () => {
			const sel = cm?.state?.selection?.main;
			if (!sel || sel.empty) return;
			this.lastSelection = { from: sel.from, to: sel.to };
		};

		cm.dom.addEventListener('input', () => {
			captureSelection();
			this.opts.onChange?.(this.getValue());
		});
		cm.dom.addEventListener('mouseup', captureSelection, true);
		cm.dom.addEventListener('keyup', captureSelection, true);

		cm.dom.addEventListener('keydown', (e: KeyboardEvent) => {
			// 阻止冒泡到图级快捷键（方向键/Tab/Enter 等）
			e.stopPropagation();

			if (e.key === 'Enter' && this.opts.onEnter) {
				if (this.opts.onEnter(this.getValue(), e)) {
					e.preventDefault();
				}
				return;
			}
			if (e.key === 'Escape') {
				this.opts.onEscape?.(e);
			}
		}, true);

		cm.dom.addEventListener('focusout', () => {
			setTimeout(() => {
				if (this.destroyed) return;
				if (this.opts.containerEl.contains(document.activeElement)) return;
				this.opts.onBlur?.(this.getValue());
			}, 50);
		});
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
		try { this.editView?.destroy?.(); } catch { /* ignore */ }
		try { this.editView?.unload?.(); } catch { /* ignore */ }
		this.editView = null;
		this.cm = null;
	}
}
