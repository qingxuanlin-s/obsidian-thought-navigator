import * as cytoscape from 'cytoscape';

/**
 * 轻量 Minimap —— 浮在画布右下角的缩略导航
 *
 * 设计:
 * - Canvas 画节点(性能 + 简单),DOM 画视口框(可拖拽 / 可点击)
 * - 锚点节点金色高亮,根节点蓝色,其他普通灰
 * - 监听 cy 的 zoom/pan/add/remove/position,自动同步
 * - 视口框可拖拽,点击空白区域跳转
 */
export class Minimap {
    private host: HTMLElement;
    private cy: cytoscape.Core;
    private root: HTMLElement;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D | null;
    private viewport: HTMLElement;

    // 模型 → minimap 像素的仿射变换
    private scale = 1;
    private offsetX = 0;
    private offsetY = 0;
    // 内容 bounding box 缓存(模型坐标)
    private bb = { x1: 0, y1: 0, x2: 1, y2: 1, w: 1, h: 1 };

    // 节点更新节流
    private nodeUpdateScheduled = false;
    private viewportUpdateScheduled = false;

    // 事件清理
    private cyHandlers: Array<{ ev: string; fn: (...args: any[]) => void }> = [];
    private domAbort = new AbortController();

    // 拖拽视口
    private dragging = false;
    private dragStartClient = { x: 0, y: 0 };
    private dragStartPan = { x: 0, y: 0 };
    private didDrag = false;

    private static readonly W = 148;
    private static readonly H = 96;
    private static readonly PADDING = 6;

    constructor(host: HTMLElement, cy: cytoscape.Core) {
        this.host = host;
        this.cy = cy;

        this.root = document.createElement('div');
        this.root.className = 'zk-minimap';
        this.root.title = '缩略导航 · 拖拽视口框 / 点击跳转';

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'zk-minimap-canvas';
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = Minimap.W * dpr;
        this.canvas.height = Minimap.H * dpr;
        this.canvas.style.width = `${Minimap.W}px`;
        this.canvas.style.height = `${Minimap.H}px`;
        this.ctx = this.canvas.getContext('2d');
        if (this.ctx) this.ctx.scale(dpr, dpr);

        this.viewport = document.createElement('div');
        this.viewport.className = 'zk-minimap-viewport';

        this.root.appendChild(this.canvas);
        this.root.appendChild(this.viewport);
        this.host.appendChild(this.root);

        this.bindCy();
        this.bindPointer();
        this.scheduleNodeUpdate();
        this.scheduleViewportUpdate();
    }

    private bindCy(): void {
        const onGraphChange = () => this.scheduleNodeUpdate();
        const onViewport = () => this.scheduleViewportUpdate();

        // add/remove/position(拖动节点完成后) 触发节点重绘
        this.cy.on('add remove position', onGraphChange);
        this.cyHandlers.push({ ev: 'add remove position', fn: onGraphChange });

        // viewport 是 cy 提供的 zoom+pan 聚合事件
        this.cy.on('viewport', onViewport);
        this.cyHandlers.push({ ev: 'viewport', fn: onViewport });
    }

    private bindPointer(): void {
        const signal = this.domAbort.signal;

        // 阻止 cytoscape 把 minimap 上的滚轮当成画布缩放
        this.root.addEventListener('wheel', (e) => e.stopPropagation(), { signal });

        this.root.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            this.dragging = true;
            this.didDrag = false;
            this.dragStartClient = { x: e.clientX, y: e.clientY };
            const pan = this.cy.pan();
            this.dragStartPan = { x: pan.x, y: pan.y };

            // 如果点击在视口框外,先把视口中心跳到点击位置
            const rect = this.canvas.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;
            if (!this.isInsideViewport(localX, localY)) {
                this.panToMinimapPoint(localX, localY);
                // 重置 dragStartPan 为新的 pan
                const newPan = this.cy.pan();
                this.dragStartPan = { x: newPan.x, y: newPan.y };
                this.didDrag = true;
            }
        }, { signal });

        window.addEventListener('mousemove', (e) => {
            if (!this.dragging) return;
            const dx = e.clientX - this.dragStartClient.x;
            const dy = e.clientY - this.dragStartClient.y;
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1) this.didDrag = true;
            // minimap 像素位移 → 模型位移 → cy.pan 反向
            // pan_new = pan_start - dModel * zoom
            const z = this.cy.zoom();
            const dModelX = dx / this.scale;
            const dModelY = dy / this.scale;
            this.cy.pan({
                x: this.dragStartPan.x - dModelX * z,
                y: this.dragStartPan.y - dModelY * z,
            });
        }, { signal });

        window.addEventListener('mouseup', () => {
            this.dragging = false;
        }, { signal });
    }

    private isInsideViewport(localX: number, localY: number): boolean {
        const left = parseFloat(this.viewport.style.left || '0');
        const top = parseFloat(this.viewport.style.top || '0');
        const width = parseFloat(this.viewport.style.width || '0');
        const height = parseFloat(this.viewport.style.height || '0');
        return localX >= left && localX <= left + width
            && localY >= top && localY <= top + height;
    }

    private panToMinimapPoint(localX: number, localY: number): void {
        // 反推模型坐标
        const modelX = (localX - this.offsetX) / this.scale + this.bb.x1;
        const modelY = (localY - this.offsetY) / this.scale + this.bb.y1;
        // 把模型坐标对准 cy 视口中心
        const z = this.cy.zoom();
        const halfW = this.cy.width() / 2;
        const halfH = this.cy.height() / 2;
        this.cy.pan({
            x: halfW - modelX * z,
            y: halfH - modelY * z,
        });
    }

    private scheduleNodeUpdate(): void {
        if (this.nodeUpdateScheduled) return;
        this.nodeUpdateScheduled = true;
        requestAnimationFrame(() => {
            this.nodeUpdateScheduled = false;
            this.drawNodes();
            this.updateViewport();
        });
    }

    private scheduleViewportUpdate(): void {
        if (this.viewportUpdateScheduled) return;
        this.viewportUpdateScheduled = true;
        requestAnimationFrame(() => {
            this.viewportUpdateScheduled = false;
            this.updateViewport();
        });
    }

    private recomputeTransform(): void {
        const nodes = this.cy.nodes(':visible');
        if (nodes.length === 0) {
            this.bb = { x1: 0, y1: 0, x2: 1, y2: 1, w: 1, h: 1 };
            this.scale = 1;
            this.offsetX = 0;
            this.offsetY = 0;
            return;
        }
        const bb = nodes.boundingBox({ includeLabels: false } as any);
        const w = Math.max(1, bb.x2 - bb.x1);
        const h = Math.max(1, bb.y2 - bb.y1);
        this.bb = { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, w, h };

        const availW = Minimap.W - Minimap.PADDING * 2;
        const availH = Minimap.H - Minimap.PADDING * 2;
        const scale = Math.min(availW / w, availH / h);
        this.scale = scale;
        // 居中
        this.offsetX = Minimap.PADDING + (availW - w * scale) / 2;
        this.offsetY = Minimap.PADDING + (availH - h * scale) / 2;
    }

    private drawNodes(): void {
        if (!this.ctx) return;
        const ctx = this.ctx;
        this.recomputeTransform();
        ctx.clearRect(0, 0, Minimap.W, Minimap.H);

        const nodes = this.cy.nodes(':visible');
        nodes.forEach((node: any) => {
            if (node.data('isPlaceholder')) return;
            if (node.data('isGroup')) return;
            const pos = node.position();
            const px = (pos.x - this.bb.x1) * this.scale + this.offsetX;
            const py = (pos.y - this.bb.y1) * this.scale + this.offsetY;
            const w = node.outerWidth() * this.scale;
            const h = node.outerHeight() * this.scale;

            const isAnchor = !!node.data('isAnchor');
            const isRoot = !!node.data('isRoot');
            const isLight = document.body.classList.contains('zk-theme-light');

            if (isAnchor) {
                ctx.fillStyle = isLight ? '#d4a017' : '#f5dc68';
                ctx.shadowColor = isLight ? 'rgba(212, 160, 23, 0.45)' : 'rgba(245, 220, 104, 0.55)';
                ctx.shadowBlur = 4;
            } else if (isRoot) {
                ctx.fillStyle = isLight ? '#3b6db5' : '#8cc2ff';
                ctx.shadowBlur = 0;
            } else {
                ctx.fillStyle = isLight ? 'rgba(90, 100, 130, 0.55)' : 'rgba(170, 180, 210, 0.55)';
                ctx.shadowBlur = 0;
            }
            const dotW = Math.max(1.5, Math.min(w, 18));
            const dotH = Math.max(1.5, Math.min(h, 12));
            ctx.fillRect(px - dotW / 2, py - dotH / 2, dotW, dotH);
        });
        ctx.shadowBlur = 0;
    }

    private updateViewport(): void {
        // cy.extent() 返回当前视口在模型坐标系的范围
        const ext = this.cy.extent();
        const x = (ext.x1 - this.bb.x1) * this.scale + this.offsetX;
        const y = (ext.y1 - this.bb.y1) * this.scale + this.offsetY;
        const w = (ext.x2 - ext.x1) * this.scale;
        const h = (ext.y2 - ext.y1) * this.scale;

        // 裁剪到 minimap 边界,避免视口框跑出框外
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(Minimap.W, x + w);
        const bottom = Math.min(Minimap.H, y + h);
        const clipW = Math.max(0, right - left);
        const clipH = Math.max(0, bottom - top);

        this.viewport.style.left = `${left}px`;
        this.viewport.style.top = `${top}px`;
        this.viewport.style.width = `${clipW}px`;
        this.viewport.style.height = `${clipH}px`;
    }

    /** 外部触发刷新(渲染器复用 cy 实例后) */
    refresh(): void {
        this.scheduleNodeUpdate();
    }

    destroy(): void {
        for (const { ev, fn } of this.cyHandlers) {
            try { this.cy.off(ev, fn); } catch { /* ignore */ }
        }
        this.cyHandlers = [];
        try { this.domAbort.abort(); } catch { /* ignore */ }
        if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    }
}
