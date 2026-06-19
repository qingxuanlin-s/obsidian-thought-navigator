import * as cytoscape from 'cytoscape';

type OverlayUpdater = () => void;

type ManagedDomListener = {
	target: HTMLElement | Window | Document;
	event: string;
	handler: EventListenerOrEventListenerObject;
	options?: boolean | AddEventListenerOptions;
};

export interface OverlaySchedulerDeps {
	getCy(): cytoscape.Core | null;
	getContainer(): HTMLElement | null;
}

/**
 * Coordinates all DOM/SVG overlays that need to follow Cytoscape viewport changes.
 */
export class OverlayScheduler {
	readonly updaters: Set<OverlayUpdater> = new Set();
	readonly immediateUpdaters: Set<OverlayUpdater> = new Set();
	readonly extraUpdaters: Set<OverlayUpdater> = new Set();
	readonly selectionUpdaters: Set<OverlayUpdater> = new Set();

	private managedDomListeners: ManagedDomListener[] = [];
	private updateScheduled = false;
	private listenerBound = false;
	private interacting = false;
	private interactTimer: number | null = null;
	private coreUpdateHandler: (() => void) | null = null;
	private dragfreeHandler: (() => void) | null = null;
	private extraUpdateHandler: (() => void) | null = null;
	private selectionHandler: (() => void) | null = null;

	constructor(private deps: OverlaySchedulerDeps) {}

	get isInteracting(): boolean {
		return this.interacting;
	}

	schedule(): void {
		if (this.updateScheduled) return;
		this.updateScheduled = true;
		window.requestAnimationFrame(() => {
			this.updateScheduled = false;
			const cy = this.deps.getCy();
			const container = this.deps.getContainer();
			if (!cy || !container?.isConnected) return;
			this.updaters.forEach(fn => fn());
		});
	}

	immediate(): void {
		this.updaters.forEach(fn => fn());
		// immediateUpdaters 中已在 updaters 里的成员上一行已执行,跳过避免每次 immediate()
		// 把 badge/边控制点等最贵的定位 updater 重复跑一遍(它们三者目前都同时注册在两个集合)。
		this.immediateUpdaters.forEach(fn => { if (!this.updaters.has(fn)) fn(); });
		this.updateScheduled = false;
	}

	scheduleExtra(): void {
		if (this.updateScheduled) return;
		this.updateScheduled = true;
		window.requestAnimationFrame(() => {
			this.updateScheduled = false;
			const cy = this.deps.getCy();
			const container = this.deps.getContainer();
			if (!cy || !container?.isConnected) return;
			this.updaters.forEach(fn => fn());
			this.extraUpdaters.forEach(fn => fn());
		});
	}

	markInteracting(): void {
		// 拖拽/布局期间 position 事件可能 N 个节点 × 每帧触发,
		// 仅在 idle → interacting 翻边时才安排尾随 timer,避免每事件 clearTimeout/setTimeout 风暴。
		// timer 自然到期后若仍有事件,markInteracting 会再次激活。
		if (this.interacting) return;
		this.interacting = true;
		if (this.interactTimer !== null) {
			window.clearTimeout(this.interactTimer);
		}
		this.interactTimer = window.setTimeout(() => {
			this.interacting = false;
			this.interactTimer = null;
			this.scheduleExtra();
		}, 100);
	}

	handleSelectionChange(): void {
		this.selectionUpdaters.forEach(fn => fn());
	}

	bindListeners(): void {
		const cy = this.deps.getCy();
		if (this.listenerBound || !cy) return;
		this.listenerBound = true;
		this.coreUpdateHandler = () => {
			this.markInteracting();
			this.schedule();
		};
		this.dragfreeHandler = () => {
			this.interacting = false;
			if (this.interactTimer !== null) {
				window.clearTimeout(this.interactTimer);
				this.interactTimer = null;
			}
			this.immediate();
		};
		this.extraUpdateHandler = () => this.scheduleExtra();
		this.selectionHandler = () => {
			this.handleSelectionChange();
			this.scheduleExtra();
		};

		// 注: zoom/pan ⊂ viewport,只订阅 viewport 避免同一变化三次触发。
		// drag/position 在拖拽和布局期间会按节点逐个触发;markInteracting 已加 idempotent guard。
		cy.on('viewport drag position', this.coreUpdateHandler);
		cy.on('dragfree', this.dragfreeHandler);
		cy.on('class data add remove layoutstop', this.extraUpdateHandler);
		cy.on('select unselect', this.selectionHandler);
	}

	cleanupEventBindings(): void {
		const cy = this.deps.getCy();
		if (!cy) {
			this.listenerBound = false;
			this.coreUpdateHandler = null;
			this.dragfreeHandler = null;
			this.extraUpdateHandler = null;
			this.selectionHandler = null;
			return;
		}
		if (this.coreUpdateHandler) {
			cy.off('viewport', this.coreUpdateHandler);
			cy.off('drag', this.coreUpdateHandler);
			cy.off('position', this.coreUpdateHandler);
			this.coreUpdateHandler = null;
		}
		if (this.dragfreeHandler) {
			cy.off('dragfree', this.dragfreeHandler);
			this.dragfreeHandler = null;
		}
		if (this.extraUpdateHandler) {
			cy.off('class', this.extraUpdateHandler);
			cy.off('data', this.extraUpdateHandler);
			cy.off('add', this.extraUpdateHandler);
			cy.off('remove', this.extraUpdateHandler);
			cy.off('layoutstop', this.extraUpdateHandler);
			this.extraUpdateHandler = null;
		}
		if (this.selectionHandler) {
			cy.off('select', this.selectionHandler);
			cy.off('unselect', this.selectionHandler);
			this.selectionHandler = null;
		}
		this.listenerBound = false;
	}

	addManagedDomListener<T extends HTMLElement | Window | Document>(
		target: T,
		event: string,
		handler: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	): void {
		target.addEventListener(event, handler, options);
		this.managedDomListeners.push({ target, event, handler, options });
	}

	cleanupManagedDomListeners(): void {
		this.managedDomListeners.forEach(({ target, event, handler, options }) => {
			target.removeEventListener(event, handler, options);
		});
		this.managedDomListeners = [];
	}

	cleanupScheduler(): void {
		this.updaters.clear();
		this.immediateUpdaters.clear();
		this.extraUpdaters.clear();
		this.selectionUpdaters.clear();
		this.updateScheduled = false;
		this.interacting = false;
		if (this.interactTimer !== null) {
			window.clearTimeout(this.interactTimer);
			this.interactTimer = null;
		}
	}
}
