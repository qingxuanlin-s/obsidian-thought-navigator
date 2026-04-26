import * as cytoscapeNamespace from 'cytoscape';
import * as dagreNamespace from 'cytoscape-dagre';
import * as coseBilkentNamespace from 'cytoscape-cose-bilkent';
import { IGraphRenderer, GraphData, RenderOptions, GraphChanges, ViewState, Edge } from './types';
import { ZKNode } from 'src/view/indexView';
import { Component, MarkdownRenderer, Notice, Platform, setIcon } from 'obsidian';
import { t } from 'src/lang/helper';
import { EmbeddableMarkdownEditor } from 'src/utils/EmbeddableMarkdownEditor';
import { isMocPath, stripMocSuffix } from 'src/utils/utils';

// 处理 CommonJS 和 ESM 模块的兼容性
const getCytoscape = (): any => {
    const cy = (cytoscapeNamespace as any).default || cytoscapeNamespace;
    return cy;
};

const getDagre = (): any => {
    const d = (dagreNamespace as any).default || dagreNamespace;
    return d;
};

const getCoseBilkent = (): any => {
    const cb = (coseBilkentNamespace as any).default || coseBilkentNamespace;
    return cb;
};

// 延迟注册扩展的标志
let extensionsRegistered = false;

/**
 * 自然比较 Luhmann ID
 * 例如: "a.11" > "a.9", "a.2.1" > "a.1.9"
 */
function compareIds(id1: string, id2: string): number {
    const parts1 = id1.split('.');
    const parts2 = id2.split('.');

    // 取两个数组长度的最大值，确保每一层都能比到
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
        const p1 = parts1[i];
        const p2 = parts2[i];

        // 情况 1：id2 已经没有这一层级了（如 1.a.1 vs 1.a）
        // 默认短的更小
        if (p1 !== undefined && p2 === undefined) return 1;
        if (p1 === undefined && p2 !== undefined) return -1;

        // 情况 2：两个部分都有值，进行对比
        // 使用 localeCompare 开启 numeric 模式，可以自动处理 '10' > '2' 的逻辑
        const cmp = p1.localeCompare(p2, undefined, { numeric: true, sensitivity: 'base' });

        if (cmp !== 0) {
            return cmp > 0 ? 1 : -1;
        }
    }

    return 0;
}

type NodeBranchStyle = { background: string; border: string; shadow: string };

type ElementConversionContext = {
    nodeStyleMap: Map<string, NodeBranchStyle>;
    nodeById: Map<string, ZKNode>;
    parentLinkedNodeIds: Set<string>;
};

// 注册布局扩展
const registerExtensions = () => {
    if (extensionsRegistered) return;
    
    try {
        const cytoscape = getCytoscape();
        const dagre = getDagre();
        const coseBilkent = getCoseBilkent();
        
        if (typeof cytoscape === 'function' && cytoscape.use) {
            cytoscape.use(dagre);
            cytoscape.use(coseBilkent);
            extensionsRegistered = true;
        }
    } catch (error) {
        console.error('Failed to register Cytoscape extensions:', error);
    }
};

// 让 Image Toolkit 插件能识别我们渲染的预览图：
// 它的事件委托只挂在 `.modal-content img` / `.workspace-leaf-content[data-type='markdown'] img` 等选择器上，
// 自定义 ItemView 默认不在白名单里。包一层带 `modal-content` 类的容器即可命中,
// `display: contents` 让 wrapper 在布局上完全消失，不影响 img 的尺寸/定位。
const wrapForImageToolkit = (img: HTMLElement): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-content';
    wrap.style.display = 'contents';
    wrap.appendChild(img);
    return wrap;
};

/**
 * Cytoscape.js 渲染器
 * 提供高性能的图形可视化和增量更新支持
 */
export class CytoscapeRenderer implements IGraphRenderer {
    private cy: cytoscape.Core | null = null;
    private container: HTMLElement | null = null;
    private currentData: GraphData | null = null;
    private currentOptions: RenderOptions | null = null;
    private edgeControlPoints: Map<string, { distance: number; weight: number }> = new Map();
    private batchSelectedNodeIds: string[] = []; // 保存批量选中的节点ID
    private batchSelectedNodes: any[] = []; // 保存批量选中的完整节点数据（包含 isCrossDomain 等信息）
    private isMetaPressed = false; // 标记 Command 键是否被按下（框选模式）
    private isEdgeSelected = false; // 标记当前是否有选中的边（边编辑模式）
    private embedPreviewCleanup: (() => void) | null = null;
    private imagePreviewCleanup: (() => void) | null = null;
    // 追踪正在进行中的 overlay 拖拽/缩放操作，确保 destroy() 时能中止挂在 document 上的监听器
    private activeOverlayDragAborters: Set<AbortController> = new Set();
    // 缓存已渲染的预览卡片 DOM，避免重建时 excalidraw/markdown 内容闪烁
    private embedCardCache: Map<string, HTMLElement> = new Map();
    private managedDomListeners: Array<{
        target: HTMLElement | Window | Document;
        event: string;
        handler: EventListenerOrEventListenerObject;
        options?: boolean | AddEventListenerOptions;
    }> = [];
    private embedRendererComponents: Set<Component> = new Set();
    private activeAlignmentOverlay: SVGSVGElement | null = null;
    private boxSelectionElement: HTMLElement | null = null;
    private liveEditCleanupHandlers: Set<() => void> = new Set();
    private collapseHandleCleanup: (() => void) | null = null;
    private collapsedNodeIds: Set<string> = new Set();
    private activeTextSelectionToolbarCleanup: (() => void) | null = null;
    // 记住用户上一次在文本选区工具条里选择的颜色，跨选区保持
    private lastPickedTextColor: string | null = null;
    private lastPickedBgColor: string | null = null;
    private static readonly SELECTION_COLOR_CHOICES = ['#00a8ff', '#34d399', '#f59e0b', '#ef4444', '#a78bfa', '#e2e8f0'];
    private static readonly DEFAULT_SELECTION_TEXT_COLOR = '#00a8ff';
    private static readonly DEFAULT_SELECTION_BG_COLOR = '#f59e0b';

    // 文本节点 Markdown 渲染缓存：跨 addNodeBadges 重建复用已渲染的 overlay DOM + Component
    // key = `${sourcePath}||${rawSource}`
    private textMdOverlayCache: Map<string, {
        el: HTMLElement;
        component: Component;
        mdEditor: EmbeddableMarkdownEditor | null;
        width: number;
        height: number;
        isPlainText: boolean;
        usedInCycle: boolean;
    }> = new Map();

    // 统一 overlay rAF 调度器
    private overlayUpdaters: Set<() => void> = new Set();
    private overlayImmediateUpdaters: Set<() => void> = new Set();
    private overlayExtraUpdaters: Set<() => void> = new Set(); // class/data/select 等额外事件触发的 updaters
    private overlaySelectionUpdaters: Set<() => void> = new Set(); // select/unselect 独占 updaters
    private overlayUpdateScheduled = false;
    private overlayListenerBound = false;
    private overlayInteracting = false;
    private overlayInteractTimer: number | null = null;
    private overlayCoreUpdateHandler: (() => void) | null = null;
    private overlayDragfreeHandler: (() => void) | null = null;
    private overlayExtraUpdateHandler: (() => void) | null = null;
    private overlaySelectionHandler: (() => void) | null = null;
    private edgeControlSelectHandler: ((evt: any) => void) | null = null;
    private edgeControlUnselectHandler: (() => void) | null = null;
    private edgeControlRemoveHandler: (() => void) | null = null;
    private edgeEndpointSelectHandler: ((evt: any) => void) | null = null;
    private edgeEndpointUnselectHandler: (() => void) | null = null;
    private edgeEndpointRemoveHandler: (() => void) | null = null;
    // 边控制点/端点手柄的 updaters（生命周期跟随选中边，需单独追踪清理）
    private edgeControlPointUpdaters: Set<() => void> = new Set();
    private edgeEndpointUpdaters: Set<() => void> = new Set();

    // 节点剪贴板（Cmd+C/V 复制粘贴）
    private clipboardNodes: Array<{ originalNode: any; position: { x: number; y: number } }> = [];

    // SimpleMind 风格布局常量
    private readonly VERTICAL_GAP = 80;       // 垂直间距
    private readonly HORIZONTAL_GAP = 200;    // 水平间距
    private readonly SIBLING_GAP = 100;       // 兄弟节点间距

    private isReadOnlyMode(): boolean {
        return this.currentOptions?.readOnly === true || Platform.isMobile;
    }

    private clearActiveTextSelectionToolbar(): void {
        if (!this.activeTextSelectionToolbarCleanup) return;
        this.activeTextSelectionToolbarCleanup();
        this.activeTextSelectionToolbarCleanup = null;
    }

    private stripInlineTextFormatting(text: string): string {
        let result = text;
        const unwrapPatterns: Array<[RegExp, string]> = [
            [/\*\*([\s\S]*?)\*\*/g, '$1'],
            [/~~([\s\S]*?)~~/g, '$1'],
            [/<u>([\s\S]*?)<\/u>/gi, '$1'],
            [/<span\b[^>]*>([\s\S]*?)<\/span>/gi, '$1'],
        ];

        let changed = true;
        while (changed) {
            changed = false;
            for (const [pattern, replacement] of unwrapPatterns) {
                const next = result.replace(pattern, replacement);
                if (next !== result) {
                    result = next;
                    changed = true;
                }
            }
        }

        return result.replace(/<\/?[^>]+>/g, '');
    }

    private hexToRgb(hex: string): { r: number; g: number; b: number } {
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

    private rgbToHex(r: number, g: number, b: number): string {
        const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    private rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
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

    private hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
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

    private createInlineColorPicker(
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

        // 自定义 hue 滑条（不用 <input type=range>，避免点击时抢占焦点
        // 导致外层编辑器触发 focusout → onBlur → saveEdit，从而关闭工具条）
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

        const rgb = this.hexToRgb(initialColor);
        const hsv = this.rgbToHsv(rgb.r, rgb.g, rgb.b);
        let h = hsv.h;
        let s = hsv.s;
        let v = hsv.v;

        const updateUi = () => {
            const hueRgb = this.hsvToRgb(h, 1, 1);
            const hueHex = this.rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b);
            svArea.style.backgroundColor = hueHex;
            hueHandle.style.left = `${(h / 360) * 100}%`;
            svHandle.style.left = `${s * 100}%`;
            svHandle.style.top = `${(1 - v) * 100}%`;
            const out = this.hsvToRgb(h, s, v);
            preview.style.backgroundColor = this.rgbToHex(out.r, out.g, out.b);
        };

        const currentHex = () => {
            const out = this.hsvToRgb(h, s, v);
            return this.rgbToHex(out.r, out.g, out.b);
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

        // 按钮的 mousedown 必须 preventDefault,否则点按钮会把焦点从外层编辑器
        // 抢过来,触发外层编辑器的 onBlur → saveEdit,导致工具条和 picker 被销毁,
        // 用户会看到"点确认没反应"。
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

    /**
     * 构建文本选区工具条里的颜色面板（最近色 + 预设色板 + 自定义 HSV 取色器）。
     * 文字颜色与背景色面板结构一致，用此方法统一生成，避免重复代码。
     *
     * @param initialColor 初始高亮的颜色（用来标记"当前激活"的色板并作为 HSV 起始值）
     * @param recentColor  最近一次选中的颜色（null 表示本次会话还没选过）；非 null 时
     *                     会作为"最近色"置于第一位，文本/背景色各自独立
     * @param customTitle  "+" 按钮的 title（"自定义颜色" / "自定义背景色"）
     * @param onPick       用户选定颜色后的回调（选预设或确认 HSV 都走这里）
     */
    createSelectionColorPanel(
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
            swatch.style.backgroundColor = color;
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

        CytoscapeRenderer.SELECTION_COLOR_CHOICES.forEach((color) => {
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
            inlinePicker = this.createInlineColorPicker(
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

    /**
     * 统一 overlay 更新调度：将所有 overlay 系统的 rAF 合并为单一调度
     * 减少每帧 8 个独立 rAF → 1 个 rAF，事件监听数量减少 80%
     */
    private scheduleOverlayUpdate(): void {
        if (this.overlayUpdateScheduled) return;
        this.overlayUpdateScheduled = true;
        requestAnimationFrame(() => {
            this.overlayUpdateScheduled = false;
            if (!this.cy || !this.container?.isConnected) return;
            this.overlayUpdaters.forEach(fn => fn());
        });
    }

    /** dragfree 等需要立即同步的场景，跳过 rAF */
    private immediateOverlayUpdate(): void {
        this.overlayUpdaters.forEach(fn => fn());
        this.overlayImmediateUpdaters.forEach(fn => fn());
        this.overlayUpdateScheduled = false;
    }

    /** class/data/add/remove/layoutstop 等额外事件触发调度 */
    private scheduleOverlayExtraUpdate(): void {
        if (this.overlayUpdateScheduled) return;
        this.overlayUpdateScheduled = true;
        requestAnimationFrame(() => {
            this.overlayUpdateScheduled = false;
            if (!this.cy || !this.container?.isConnected) return;
            this.overlayUpdaters.forEach(fn => fn());
            this.overlayExtraUpdaters.forEach(fn => fn());
        });
    }

    private markOverlayInteracting(): void {
        this.overlayInteracting = true;
        if (this.overlayInteractTimer !== null) {
            window.clearTimeout(this.overlayInteractTimer);
        }
        this.overlayInteractTimer = window.setTimeout(() => {
            this.overlayInteracting = false;
            this.overlayInteractTimer = null;
            this.scheduleOverlayExtraUpdate();
        }, 100);
    }

    /** select/unselect 专用更新（同步，不经过 rAF） */
    private handleOverlaySelectionChange(): void {
        this.overlaySelectionUpdaters.forEach(fn => fn());
    }

    /**
     * 绑定统一的 overlay 事件监听（只绑定一次）
     * 覆盖所有 overlay 系统需要的事件
     */
    private bindOverlayListeners(): void {
        if (this.overlayListenerBound || !this.cy) return;
        this.overlayListenerBound = true;
        this.overlayCoreUpdateHandler = () => {
            this.markOverlayInteracting();
            this.scheduleOverlayUpdate();
        };
        this.overlayDragfreeHandler = () => {
            this.overlayInteracting = false;
            if (this.overlayInteractTimer !== null) {
                window.clearTimeout(this.overlayInteractTimer);
                this.overlayInteractTimer = null;
            }
            this.immediateOverlayUpdate();
        };
        this.overlayExtraUpdateHandler = () => this.scheduleOverlayExtraUpdate();
        this.overlaySelectionHandler = () => {
            this.handleOverlaySelectionChange();
            this.scheduleOverlayExtraUpdate();
        };

        // 核心视口/拖动事件 → 单一 rAF 调度
        this.cy.on('zoom pan viewport drag position', this.overlayCoreUpdateHandler);
        // 拖动结束 → 立即同步
        this.cy.on('dragfree', this.overlayDragfreeHandler);
        // 结构/状态变化事件 → 额外 updaters
        this.cy.on('class data add remove layoutstop', this.overlayExtraUpdateHandler);
        // 选择变化 → 同步 selection updaters + 调度位置更新
        this.cy.on('select unselect', this.overlaySelectionHandler);
    }

    private cleanupOverlayEventBindings(): void {
        if (!this.cy) return;
        if (this.overlayCoreUpdateHandler) {
            this.cy.off('zoom', this.overlayCoreUpdateHandler);
            this.cy.off('pan', this.overlayCoreUpdateHandler);
            this.cy.off('viewport', this.overlayCoreUpdateHandler);
            this.cy.off('drag', this.overlayCoreUpdateHandler);
            this.cy.off('position', this.overlayCoreUpdateHandler);
            this.overlayCoreUpdateHandler = null;
        }
        if (this.overlayDragfreeHandler) {
            this.cy.off('dragfree', this.overlayDragfreeHandler);
            this.overlayDragfreeHandler = null;
        }
        if (this.overlayExtraUpdateHandler) {
            this.cy.off('class', this.overlayExtraUpdateHandler);
            this.cy.off('data', this.overlayExtraUpdateHandler);
            this.cy.off('add', this.overlayExtraUpdateHandler);
            this.cy.off('remove', this.overlayExtraUpdateHandler);
            this.cy.off('layoutstop', this.overlayExtraUpdateHandler);
            this.overlayExtraUpdateHandler = null;
        }
        if (this.overlaySelectionHandler) {
            this.cy.off('select', this.overlaySelectionHandler);
            this.cy.off('unselect', this.overlaySelectionHandler);
            this.overlaySelectionHandler = null;
        }
    }

    private addManagedDomListener<T extends HTMLElement | Window | Document>(
        target: T,
        event: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ): void {
        target.addEventListener(event, handler, options);
        this.managedDomListeners.push({ target, event, handler, options });
    }

    private cleanupManagedDomListeners(): void {
        this.managedDomListeners.forEach(({ target, event, handler, options }) => {
            target.removeEventListener(event, handler, options);
        });
        this.managedDomListeners = [];
    }

    private unloadEmbedRendererComponents(): void {
        this.embedRendererComponents.forEach((component) => {
            try { component.unload(); } catch { /* ignore */ }
        });
        this.embedRendererComponents.clear();
    }

    private cleanupLiveEditHandlers(): void {
        this.liveEditCleanupHandlers.forEach((cleanup) => {
            try { cleanup(); } catch { /* ignore */ }
        });
        this.liveEditCleanupHandlers.clear();
    }

    private cleanupBadgeInteractionBindings(): void {
        if (!this.cy) return;
        if (this.edgeControlSelectHandler) {
            this.cy.off('select', 'edge', this.edgeControlSelectHandler);
            this.edgeControlSelectHandler = null;
        }
        if (this.edgeControlUnselectHandler) {
            this.cy.off('unselect', 'edge', this.edgeControlUnselectHandler);
            this.edgeControlUnselectHandler = null;
        }
        if (this.edgeControlRemoveHandler) {
            this.cy.off('remove', 'edge', this.edgeControlRemoveHandler);
            this.edgeControlRemoveHandler = null;
        }
        if (this.edgeEndpointSelectHandler) {
            this.cy.off('select', 'edge', this.edgeEndpointSelectHandler);
            this.edgeEndpointSelectHandler = null;
        }
        if (this.edgeEndpointUnselectHandler) {
            this.cy.off('unselect', 'edge', this.edgeEndpointUnselectHandler);
            this.edgeEndpointUnselectHandler = null;
        }
        if (this.edgeEndpointRemoveHandler) {
            this.cy.off('remove', 'edge', this.edgeEndpointRemoveHandler);
            this.edgeEndpointRemoveHandler = null;
        }
        this.cy.nodes().forEach((node: any) => {
            const listeners = node.scratch('_zkConnectionHandleListeners');
            if (!listeners) return;
            if (listeners.mouseover) {
                node.off('mouseover', listeners.mouseover);
            }
            if (listeners.mouseout) {
                node.off('mouseout', listeners.mouseout);
            }
            node.removeScratch('_zkConnectionHandleListeners');
        });
    }

    /** 清理统一 overlay 调度器（只清空 updater 集合，不重置事件监听标记） */
    private cleanupOverlayScheduler(): void {
        this.overlayUpdaters.clear();
        this.overlayImmediateUpdaters.clear();
        this.overlayExtraUpdaters.clear();
        this.overlaySelectionUpdaters.clear();
        this.edgeControlPointUpdaters.clear();
        this.edgeEndpointUpdaters.clear();
        this.overlayUpdateScheduled = false;
        this.overlayInteracting = false;
        if (this.overlayInteractTimer !== null) {
            window.clearTimeout(this.overlayInteractTimer);
            this.overlayInteractTimer = null;
        }
    }

    /**
     * 渲染图形
     * @性能优化：支持增量更新，避免每次都销毁重建
     */
    async render(container: HTMLElement, data: GraphData, options: RenderOptions): Promise<void> {
        // 确保扩展已注册
        registerExtensions();

        const containerChanged = this.container !== container;
        const previousOptions = this.currentOptions;

        this.container = container;
        this.currentData = data;
        this.currentOptions = options;

        // 出入链预设网格位置（必须在转换元素之前，确保 savedPosition 生效）
        this.presetInOutLinksPositions(data);
        // 检查是否有保存的位置
        const hasSavedPositions = data.nodes.some(node => node.savedPosition);

        // 转换元素（包含分组）
        const elements = this.convertToElementsWithGroups(data);

        // 如果没有 Cytoscape 实例或容器变化，需要完全重建
        if (!this.cy || containerChanged) {
            // 销毁旧实例（如果存在）
            if (this.cy) {
                this.cleanupManagedDomListeners();
                this.cleanupOverlayEventBindings();
                this.cleanupBadgeInteractionBindings();
                this.cleanupOverlayScheduler();
                this.overlayListenerBound = false;
                this.activeAlignmentOverlay?.remove();
                this.activeAlignmentOverlay = null;
                this.boxSelectionElement?.remove();
                this.boxSelectionElement = null;
                this.cy.destroy();
                this.cy = null;
            }

            // 获取 cytoscape 函数
            const cytoscape = getCytoscape();

            // 初始化 Cytoscape
            this.cy = cytoscape({
                container: container,
                elements: elements,
                style: [
                    ...this.getStylesheet(options),
                    {
                        selector: 'core',
                        style: {
                            'background-color': 'transparent',
                            'background-opacity': 0
                        } as any
                    }
                ],
                // 没有保存位置时，先用轻量网格打散，避免首帧节点重叠导致边端点无效
                layout: hasSavedPositions
                    ? { name: 'preset' }
                    : { name: 'grid', fit: false, avoidOverlap: true, padding: 30 },
                // 性能优化选项
                hideEdgesOnViewport: true,
                hideLabelsOnViewport: true,  // pan/zoom 时隐藏标签，减少 canvas 渲染量
                // 关闭拖拽纹理缓存，避免画布拖动时出现半透明色块伪影
                textureOnViewport: false,
                motionBlur: false,
                pixelRatio: Math.min(window.devicePixelRatio, 2),  // 限制最高 2x，3x 屏省 ~25% canvas 填充
                // 启用节点拖动
                autoungrabify: options.readOnly === true,
                // 启用原生缩放和平移
                userZoomingEnabled: true,   // 启用滚轮/双指缩放
                userPanningEnabled: true,   // 启用原生拖动画布
                // 默认禁用框选，需要按 Command 键才启用
                boxSelectionEnabled: false,
                // 设置缩放范围
                minZoom: 0.1,
                maxZoom: 1.0
            });

            // 绑定事件（exportMode 下跳过所有 DOM 交互绑定，避免 MutationObserver/focus 副作用）
            if (!options.exportMode) {
                this.bindEvents();
                this.bindKeyboardEvents();
                this.initBoxSelection();
                this.addNodeBadges();
                if (this.isReadOnlyMode()) {
                    this.hideBatchToolbar();
                }
            }

        } else {
            if (typeof (this.cy as any).autoungrabify === 'function') {
                (this.cy as any).autoungrabify(options.readOnly === true);
            }
            if (this.isReadOnlyMode()) {
                this.hideBatchToolbar();
            }

            // 复用实例时也要刷新样式，确保主题/风格切换即时生效
            const shouldRefreshStyle =
                !previousOptions ||
                previousOptions.themeMode !== options.themeMode ||
                previousOptions.themeStyle !== options.themeStyle ||
                previousOptions.edgeStyle !== options.edgeStyle;
            if (shouldRefreshStyle) {
                this.cy.style([
                    ...this.getStylesheet(options),
                    {
                        selector: 'core',
                        style: {
                            'background-color': 'transparent',
                            'background-opacity': 0
                        } as any
                    }
                ]);
            }

            // 增量更新：复用现有 Cytoscape 实例
            this.cy.batch(() => {
                // 先删除所有占位符节点（因为它们不在传入的数据中）
                const placeholderNodes = this.cy!.nodes().filter((node: any) => node.data('isPlaceholder'));
                if (placeholderNodes.length > 0) {
                    this.cy!.remove(placeholderNodes);
                }

                // 清理所有占位符连接线
                const connectionLines = this.container?.querySelectorAll('.placeholder-connection-line');
                if (connectionLines && connectionLines.length > 0) {
                    connectionLines.forEach(line => {
                        if (line.parentNode) {
                            line.parentNode.removeChild(line);
                        }
                    });
                }

                // 清理占位符节点的编辑框和链接建议器
                const editor = this.container?.querySelector('.node-label-editor');
                if (editor) {
                    editor.remove();
                }
                const edgeEditor = this.container?.querySelector('.edge-label-editor');
                if (edgeEditor) {
                    edgeEditor.remove();
                }
                this.clearActiveTextSelectionToolbar();

                const suggester = this.container?.querySelector('.node-link-suggester');
                if (suggester) {
                    suggester.remove();
                }

                // 获取当前所有节点和边的 ID
                const currentIds = new Set(this.cy!.elements().map(ele => ele.id()));
                const newIds = new Set(elements.map(ele => ele.data.id || ''));

                // 找出需要删除的元素
                const toRemove: string[] = [];
                currentIds.forEach(id => {
                    if (!newIds.has(id)) {
                        toRemove.push(id);
                    }
                });

                // 找出需要添加的元素
                const toAdd = elements.filter(ele => {
                    const id = ele.data.id;
                    return id && !currentIds.has(id);
                });

                // 删除旧元素
                // 性能优化：原实现 cy.elements().filter(ele => toRemove.includes(...))
                // 对全图元素做 O(E × |toRemove|) 扫描。改为直接用 $id 做 O(1) 哈希查找，
                // 把移除复杂度降到 O(|toRemove|)。
                if (toRemove.length > 0) {
                    // 检查是否删除了分组节点，如果是，先释放子节点
                    toRemove.forEach(id => {
                        const ele = this.cy!.$id(id);
                        if (ele.length > 0 && ele.data('isGroup')) {
                            // 这是一个分组节点，需要先释放其子节点
                            const childNodes = this.cy!.nodes(`[parent="${id}"]`);
                            // 将子节点的 parent 设为 null，使其成为独立节点
                            childNodes.forEach((child: any) => {
                                child.move({ parent: null });
                            });
                        }
                    });

                    toRemove.forEach(id => {
                        const ele = this.cy!.$id(id);
                        if (ele.length > 0) {
                            this.cy!.remove(ele);
                        }
                    });
                }

                // 添加新元素
                if (toAdd.length > 0) {
                    this.cy!.add(toAdd);
                }

                // 更新现有元素的数据（包括 parent 属性）
                elements.forEach(ele => {
                    const id = ele.data.id;
                    if (id) {
                        const existing = this.cy!.$id(id);
                        if (existing.length > 0) {
                            const wasEmbed = !!existing.data('isEmbed');
                            const nextIsEmbed = !!ele.data.isEmbed;
                            // 更新节点数据
                            existing.data(ele.data);

                            // 同步更新位置（savedPosition 对应的坐标在 ele.position 上，data 里不含位置）
                            if (ele.group === 'nodes' && (ele as any).position) {
                                existing.position((ele as any).position);
                            }

                            // embed -> 普通文件节点：移除预览卡片写入的 width/height bypass，恢复样式表计算尺寸
                            if (ele.group === 'nodes' && wasEmbed && !nextIsEmbed) {
                                existing.removeStyle('width');
                                existing.removeStyle('height');
                            }

                            // 特殊处理 parent 属性，确保分组关系正确更新
                            if (ele.group === 'nodes' && 'parent' in ele.data) {
                                const newParent = ele.data.parent;
                                const currentParent = existing.data('parent');

                                // 如果 parent 发生变化，需要使用 move() 方法更新
                                if (newParent !== currentParent) {
                                    existing.move({
                                        parent: newParent || null
                                    });
                                }
                            }
                        }
                    }
                });
            });
        }

        // 更新节点徽章（exportMode 下跳过，避免 MarkdownRenderer 触发 MutationObserver 导致跳转）
        if (!options.exportMode) {
            this.addNodeBadges();
            this.addEmbedNodePreviews();
            this.addImageNodePreviews();
        }

        // 运行布局
        if (this.cy) {
            // 容器尺寸变化后显式通知 Cytoscape 重算 viewport/canvas 尺寸
            this.cy.resize();
            // exportMode 下禁用 fit：cy.fit() 会通过 setTimeout 延迟触发 viewport 回调，
            // 而 renderer.destroy() 在 finally 里立即销毁 cy，导致回调执行时 cy 已 null。
            // cy.png({ full:true }) 自己会处理 fit，layout 不需要再 fit。
            const noFit = options.exportMode ? { fit: false } : {};
            if (hasSavedPositions) {
                // 如果有保存的位置，使用 preset 布局（保持原位置）
                this.runLayoutSafely({ name: 'preset', ...noFit });
                this.resolveExactNodeOverlaps();
            } else {
                // 如果没有保存位置，根据 layoutType 选择布局算法
                // 默认使用 preset（索引视图等已有位置信息的情况）
                // 局部关系视图的出入链图会传入 'cose' 等布局类型来自动分散节点
                const layoutConfig = { ...this.getLayoutConfig(options), ...noFit };
                this.runLayoutSafely(layoutConfig);
            }
        }
        this.applyCollapsedState();
    }

    /**
     * 轻微打散完全重叠的节点，避免边端点重合导致 "invalid endpoints" 警告。
     * 仅处理非分组节点，且只在坐标几乎完全一致时生效。
     */
    private resolveExactNodeOverlaps(): void {
        if (!this.cy) return;

        const buckets = new Map<string, any[]>();
        this.cy.nodes().forEach((node: any) => {
            if (node.data('isGroup')) return;
            const pos = node.position();
            const key = `${Math.round(pos.x * 10) / 10}:${Math.round(pos.y * 10) / 10}`;
            const bucket = buckets.get(key);
            if (bucket) {
                bucket.push(node);
            } else {
                buckets.set(key, [node]);
            }
        });

        this.cy.batch(() => {
            buckets.forEach((nodes) => {
                if (nodes.length <= 1) return;
                const basePos = nodes[0].position();
                for (let i = 1; i < nodes.length; i++) {
                    const angle = (2 * Math.PI * i) / (nodes.length - 1);
                    const radius = 14 + i * 6;
                    nodes[i].position({
                        x: basePos.x + Math.cos(angle) * radius,
                        y: basePos.y + Math.sin(angle) * radius
                    });
                }
            });
        });
    }

    /**
     * 安全运行布局：
     * - 主要用于规避少数数据情况下 cose/cose-bilkent 内部报错导致整图不可用
     * - 首次布局失败时自动回退到 breadthfirst
     */
    private runLayoutSafely(layoutConfig: any): void {
        if (!this.cy) return;

        // 空图/单节点图不跑复杂布局，避免布局器内部边界计算异常
        const nodeCount = this.cy.nodes().length;
        if (nodeCount <= 1) {
            this.cy.layout({ name: 'preset' }).run();
            return;
        }

        try {
            const layout = this.cy.layout(layoutConfig);
            layout.run();
        } catch (error) {
            console.error('[CytoscapeRenderer] layout run failed, fallback to breadthfirst', {
                layout: layoutConfig?.name,
                error
            });
            try {
                const fallbackGrid = this.cy.layout({
                    name: 'grid',
                    fit: true,
                    padding: 40
                });
                fallbackGrid.run();
            } catch (fallbackError) {
                console.error('[CytoscapeRenderer] grid fallback failed, fallback to preset', fallbackError);
                try {
                    this.cy.layout({ name: 'preset' }).run();
                } catch (presetError) {
                    console.error('[CytoscapeRenderer] preset fallback failed', presetError);
                }
            }
        }
    }

    /**
     * 增量更新图形
     */
    async update(changes: GraphChanges): Promise<void> {
        if (!this.cy) return;

        // 批量更新以提高性能
        this.cy.batch(() => {
            // 删除节点（会自动删除相关的边）
            if (changes.removedNodes.length > 0) {
                // 检查是否删除了分组节点，如果是，先释放子节点
                changes.removedNodes.forEach(node => {
                    const nodeId = this.escapeId(node.ID);
                    const ele = this.cy!.$id(nodeId);

                    if (ele.length > 0 && ele.data('isGroup')) {
                        // 这是一个分组节点，需要先释放其子节点
                        const childNodes = this.cy!.nodes(`[parent="${nodeId}"]`);

                        // 将子节点的 parent 设为 null，使其成为独立节点
                        childNodes.forEach((child: any) => {
                            child.move({ parent: null });
                        });
                    }
                });

                // 现在可以安全地删除节点
                const ids = changes.removedNodes.map(n => `#${this.escapeId(n.ID)}`).join(',');
                this.cy!.remove(ids);
            }

            // 删除边
            if (changes.removedEdges.length > 0) {
                const ids = changes.removedEdges.map(e => `#${this.escapeId(e.id)}`).join(',');
                this.cy!.remove(ids);
            }

            // 添加新节点
            if (changes.addedNodes.length > 0) {
                this.cy!.add(this.convertNodesToElements(changes.addedNodes));
            }

            // 添加新边
            if (changes.addedEdges.length > 0) {
                this.cy!.add(this.convertEdgesToElements(changes.addedEdges));
            }

            // 更新节点
            changes.updatedNodes.forEach(node => {
                const ele = this.cy!.$id(this.escapeId(node.ID));
                if (ele.length > 0) {
                    ele.data('label', this.getNodeLabel(node, this.currentOptions));
                    ele.data('title', node.title);
                }
            });

            // 更新边
            changes.updatedEdges.forEach(edge => {
                const ele = this.cy!.$id(this.escapeId(edge.id));
                if (ele.length > 0) {
                    ele.data('label', edge.label || '');
                }
            });
        });

        // 根据变化程度决定是否重新布局
        if (this.shouldRelayout(changes)) {
            const layout = this.cy.layout({ name: 'preset' });
            layout.run();
        }
    }

    /**
     * 销毁渲染器
     */
    destroy(): void {
        this.clearActiveTextSelectionToolbar();
        this.cleanupLiveEditHandlers();
        this.cleanupManagedDomListeners();
        this.cleanupOverlayEventBindings();
        this.cleanupBadgeInteractionBindings();
        this.cleanupOverlayScheduler();
        this.overlayListenerBound = false;

        // 中止所有挂在 document 上、尚未释放的 overlay 拖拽/缩放监听器
        for (const ctrl of this.activeOverlayDragAborters) {
            try { ctrl.abort(); } catch { /* ignore */ }
        }
        this.activeOverlayDragAborters.clear();

        if (this.embedPreviewCleanup) {
            this.embedPreviewCleanup();
            this.embedPreviewCleanup = null;
        }
        if (this.imagePreviewCleanup) {
            this.imagePreviewCleanup();
            this.imagePreviewCleanup = null;
        }
        if (this.collapseHandleCleanup) {
            this.collapseHandleCleanup();
            this.collapseHandleCleanup = null;
        }
        this.activeAlignmentOverlay?.remove();
        this.activeAlignmentOverlay = null;
        this.boxSelectionElement?.remove();
        this.boxSelectionElement = null;
        this.embedCardCache.forEach((card) => {
            if (card.parentNode) card.remove();
        });
        this.embedCardCache.clear();
        this.unloadEmbedRendererComponents();
        // 清理文本节点 MD overlay 缓存（unload 每个 Component）
        this.textMdOverlayCache.forEach(entry => {
            if (entry.mdEditor) {
                try { entry.mdEditor.unload(); } catch { /* ignore */ }
            }
            const liveHost = entry.el.querySelector('.zk-text-md-live-edit-host') as any;
            if (liveHost?._mdEditor) {
                try { liveHost._mdEditor.unload(); } catch { /* ignore */ }
            }
            try { entry.component.unload(); } catch { /* ignore */ }
            if (entry.el.parentNode) entry.el.remove();
        });
        this.textMdOverlayCache.clear();
        if (this.cy) {
            this.cy.destroy();
            this.cy = null;
        }
        this.container = null;
        this.currentData = null;
    }

    /**
     * 获取 Cytoscape 实例（用于外部操作）
     */
    getCytoscapeInstance(): cytoscape.Core | null {
        return this.cy;
    }

    /**
     * 居中并适配视图
     */
    fitAndCenter(): void {
        if (this.cy) {
            this.cy.fit();
            
            // 限制最大缩放级别，避免单个节点时过度放大
            const currentZoom = this.cy.zoom();
            const maxZoom = 2.0;  // 最大缩放级别，降低此值可让节点显示更小
            
            if (currentZoom > maxZoom) {
                this.cy.zoom(maxZoom);
            }
            
            this.cy.center();
        }
    }

    /**
     * 获取当前状态
     */
    getState(): ViewState {
        if (!this.cy) {
            return {
                zoom: 1,
                pan: { x: 0, y: 0 },
                selectedNodes: [],
                expandedNodes: [],
                timestamp: Date.now()
            };
        }

        return {
            zoom: this.cy.zoom(),
            pan: this.cy.pan(),
            selectedNodes: this.cy.$(':selected').map((ele: any) => ele.id()),
            expandedNodes: [],
            timestamp: Date.now()
        };
    }

    /**
     * 设置状态
     */
    setState(state: ViewState): void {
        if (!this.cy) return;

        this.cy.zoom(state.zoom);
        this.cy.pan(state.pan);

        // 恢复选中状态
        this.cy.$(':selected').unselect();
        state.selectedNodes.forEach(id => {
            this.cy!.$id(this.escapeId(id)).select();
        });
    }

    /**
     * 转换数据为 Cytoscape 元素（包含分组）
     */
    private convertToElementsWithGroups(data: GraphData): cytoscape.ElementDefinition[] {
        const parentLinkedNodeIds = this.loadEdgeControlPointsAndParentLinks(data);
        const context = this.buildElementConversionContext(data, parentLinkedNodeIds);
        
        // 然后转换节点和边
        const nodes = this.convertNodesToElements(data.nodes, context);
        const edges = this.convertEdgesToElements(data.edges, context);
        
        // 获取分组信息
        const groups = (data.metadata as any)?.groups || [];
        
        // 创建分组节点（compound nodes）
        const groupNodes = groups.map((group: any) => {
            return {
                group: 'nodes' as const,
                data: {
                    id: group.id,
                    originalNodeId: group.id,
                    label: group.label,
                    isGroup: true,
                    nodeIds: group.nodeIds || []  // 添加节点 ID 列表
                },
                classes: 'group-node'
            };
        });
        
        // 为分组内的节点设置 parent
        nodes.forEach((node: any) => {
            const nodeId = node.data.originalNode?.ID;
            if (nodeId) {
                const parentGroup = groups.find((g: any) => g.nodeIds.includes(nodeId));
                if (parentGroup) {
                    node.data.parent = parentGroup.id;
                }
            }
        });
        
        return [...groupNodes, ...nodes, ...edges];
    }

    /**
     * 转换数据为 Cytoscape 元素
     */
    private convertToElements(data: GraphData): cytoscape.ElementDefinition[] {
        const parentLinkedNodeIds = this.loadEdgeControlPointsAndParentLinks(data);
        const context = this.buildElementConversionContext(data, parentLinkedNodeIds);
        const nodes = this.convertNodesToElements(data.nodes, context);
        const edges = this.convertEdgesToElements(data.edges, context);
        return [...nodes, ...edges];
    }

    /**
     * 转换节点为 Cytoscape 元素
     */
    private convertNodesToElements(nodes: ZKNode[], context?: ElementConversionContext): any[] {
        // 获取当前文件路径（如果有）
        const currentFilePath = this.currentData?.metadata.currentFile || '';

        // 获取节点颜色映射
        const nodeColors = this.currentData?.metadata.nodeColors || {};
        const nodeRemarks = this.currentData?.metadata.nodeRemarks || {};
        const nodeAnchors = this.currentData?.metadata.nodeAnchors || {};
        const embedNodeSizes = ((this.currentData?.metadata as any)?.embedNodeSizes || {}) as Record<string, { width: number; height: number }>;
        const resolvedContext = context || this.buildElementConversionContext(this.currentData);
        const vividStyleMap = resolvedContext.nodeStyleMap;
        const parentLinkedNodeIds = resolvedContext.parentLinkedNodeIds;

        const elements = nodes.map(node => {
            const vividStyle = vividStyleMap.get(node.IDStr);
            const hasParentChildLink = parentLinkedNodeIds.has(node.ID) || parentLinkedNodeIds.has(node.IDStr);
            const persistedSize = embedNodeSizes[node.ID] || embedNodeSizes[node.IDStr];
            const isTextNode = !!node.isTextOnly;
            const manualSize = (isTextNode && persistedSize && persistedSize.width > 0 && persistedSize.height > 0)
                ? persistedSize
                : null;
            const rawCustomColor = nodeColors[node.IDStr] || nodeColors[node.ID] || null;
            const customFillColor = (typeof rawCustomColor === 'string' && rawCustomColor.startsWith('fill2:'))
                ? rawCustomColor.slice(6)
                : null;
            const hasLegacyCustomColor = !!rawCustomColor && !customFillColor;
            // 预计算底色对应的文字颜色，避免样式函数中重复计算
            let customFillTextColor: string | null = null;
            if (customFillColor) {
                const nc = this.normalizeHexColor(customFillColor);
                if (nc) {
                    const r = parseInt(nc.slice(1, 3), 16);
                    const g = parseInt(nc.slice(3, 5), 16);
                    const b = parseInt(nc.slice(5, 7), 16);
                    customFillTextColor = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#1f2937' : '#f8fafc';
                }
            }
            const element: any = {
                group: 'nodes' as const,
                data: {
                    id: this.escapeId(node.ID),
                    originalNodeId: node.IDStr || node.ID,
                    label: this.getNodeLabel(node, this.currentOptions),
                    badge: this.getNodeBadge(node, this.currentOptions),
                    title: node.title,
                    filePath: node.file?.path || '',  // 纯文字节点 file 为 null
                    displayText: node.displayText,
                    position: node.position,
                    isCurrentFile: node.file?.path === currentFilePath,  // 纯文字节点不匹配
                    originalNode: node,
                    isRoot: node.isRoot || false,  // 根节点标记
                    customColor: rawCustomColor,  // 兼容旧自定义颜色（色点/旧语义）
                    customFillColor: customFillColor,  // 新语义：节点底色
                    customFillTextColor: customFillTextColor,  // 预计算的底色文字颜色
                    hasCustomColor: hasLegacyCustomColor,
                    isCrossDomain: node.isCrossDomain || false,  // 传递跨领域节点标记
                    isTextOnly: node.isTextOnly || false,  // 传递纯文字节点标记
                    isStandaloneText: (node.isTextOnly || false) && !hasParentChildLink && !node.isRoot, // 无父子关系的文本节点（根节点除外，需保留 navy 填充）
                    isEmbed: node.isEmbed || false,  // 嵌入节点标记（![[...]]）
                    isInlink: (node.ID || '').startsWith('inlink-'),
                    isOutlink: (node.ID || '').startsWith('outlink-'),
                    isFreeNode: (node.ID || '').startsWith('free.'),
                    remark: nodeRemarks[node.IDStr] || nodeRemarks[node.ID] || '',
                    hasRemark: !!(nodeRemarks[node.IDStr] || nodeRemarks[node.ID]),
                    isAnchor: !!(nodeAnchors[node.IDStr] || nodeAnchors[node.ID]),
                    hasFileIcon: (!node.isTextOnly && node.file) ? true : false, // 文件节点显示图标
                    manualWidthModel: manualSize?.width || null,
                    manualHeightModel: manualSize?.height || null,
                    branchNodeBackground: vividStyle?.background || null,
                    branchNodeBorder: vividStyle?.border || null,
                    branchNodeShadow: vividStyle?.shadow || null
                }
            };

            // 如果节点有保存的位置信息，使用它
            if (node.savedPosition) {
                element.position = {
                    x: node.savedPosition.x,
                    y: node.savedPosition.y
                };
            }

            return element;
        });
        
        
        return elements;
    }

    /**
     * 转换边为 Cytoscape 元素
     */
    private convertEdgesToElements(edges: Edge[], context?: ElementConversionContext): any[] {
        const resolvedContext = context || this.buildElementConversionContext(this.currentData);
        const nodeById = resolvedContext.nodeById;
        const nodeStyleMap = resolvedContext.nodeStyleMap;

        const elements = edges.map(edge => {
            const sourceNode = nodeById.get(edge.source);
            const targetNode = nodeById.get(edge.target);
            // 判断是否为根节点→直接子节点的边：
            // 使用 isRoot 标记（支持 sa.1 等非顶层根节点），
            // 并检查 target 是 source 的直接子节点（IDStr 去掉最后一段等于 source 的 IDStr）
            const isRootToFirstLevel =
                !!sourceNode &&
                !!targetNode &&
                !!sourceNode.isRoot &&
                targetNode.IDStr.includes('.') &&
                targetNode.IDStr.substring(0, targetNode.IDStr.lastIndexOf('.')) === sourceNode.IDStr;

            let branchEdgeColor = nodeStyleMap.get(edge.source)?.border || null;
            if (isRootToFirstLevel && targetNode) {
                branchEdgeColor = nodeStyleMap.get(targetNode.IDStr)?.border || branchEdgeColor;
            }
            const hierarchyDepth = targetNode
                ? this.getDepthFromNearestRoot(targetNode.IDStr, nodeById)
                : null;
            const hierarchyEdgeWidth = edge.type === 'parent'
                ? this.getHierarchyEdgeWidth(hierarchyDepth)
                : null;
            const element: any = {
                group: 'edges' as const,
                data: {
                    id: this.escapeId(edge.id),
                    source: this.escapeId(edge.source),
                    target: this.escapeId(edge.target),
                    label: edge.label || '',
                    type: edge.type,
                    // 保存原始的 source 和 target ID（未转义）
                    originalSource: edge.source,
                    originalTarget: edge.target,
                    branchEdgeColor,
                    isRootToFirstLevel,
                    hierarchyEdgeWidth
                }
            };
            
            // 使用标准格式: source-target (如 "a-a.1.a")
            const key = `${edge.source}-${edge.target}`;
            const curvature = this.edgeControlPoints.get(key);
            
            if (curvature) {
                element.data.controlPointDistance = curvature.distance;
                element.data.controlPointWeight = curvature.weight;
            }
            
            return element;
        });
        
        return elements;
    }

    private isModernThemeStyle(): boolean {
        return (this.currentOptions?.themeStyle || 'modern') === 'modern';
    }

    private getTopBranchId(nodeId: string): string {
        const parts = (nodeId || '').split('.').filter(Boolean);
        if (parts.length <= 1) return nodeId;
        return `${parts[0]}.${parts[1]}`;
    }

    private getDepthFromNearestRoot(nodeId: string, nodeMap: Map<string, ZKNode>): number {
        const normalizedId = (nodeId || '').trim();
        if (!normalizedId) return 1;
        let current = normalizedId;
        let depth = 0;
        while (current.includes('.')) {
            const parentId = current.substring(0, current.lastIndexOf('.'));
            depth += 1;
            const parentNode = nodeMap.get(parentId);
            // 校验 IDStr 精确匹配，避免 nodeMap 中同时以 n.ID 建索引时的潜在冲突
            if (parentNode?.isRoot && parentNode.IDStr === parentId) return depth;
            current = parentId;
        }
        // 找不到显式 root 时，使用绝对层级近似
        return Math.max(1, normalizedId.split('.').filter(Boolean).length - 1);
    }

    private getHierarchyEdgeWidth(depthFromRoot: number | null): number {
        // 1级最粗，随后逐级变细，最低保留 2px
        const depth = Math.max(1, depthFromRoot || 1);
        const width = 7.2 - (depth - 1) * 1.1;
        return Math.max(2, Math.round(width * 10) / 10);
    }

    private loadEdgeControlPointsAndParentLinks(data: GraphData): Set<string> {
        this.edgeControlPoints.clear();

        const parentLinkedNodeIds = new Set<string>();
        const edgeCurvatures = data.metadata.edgeCurvatures || {};
        data.edges.forEach((edge) => {
            if (edge.type === 'parent') {
                parentLinkedNodeIds.add(edge.source);
                parentLinkedNodeIds.add(edge.target);
            }

            const key = `${edge.source}-${edge.target}`;
            const curvature = edgeCurvatures[key];
            if (curvature) {
                this.edgeControlPoints.set(key, curvature);
            }
        });

        return parentLinkedNodeIds;
    }

    private buildElementConversionContext(data: GraphData | null, parentLinkedNodeIds?: Set<string>): ElementConversionContext {
        const allNodes = data?.nodes || [];
        const resolvedParentLinkedNodeIds = parentLinkedNodeIds || new Set<string>();
        const nodeById = new Map<string, ZKNode>();

        if (!parentLinkedNodeIds) {
            (data?.edges || []).forEach((edge) => {
                if (edge.type !== 'parent') return;
                resolvedParentLinkedNodeIds.add(edge.source);
                resolvedParentLinkedNodeIds.add(edge.target);
            });
        }

        allNodes.forEach((node) => {
            nodeById.set(node.ID, node);
            nodeById.set(node.IDStr, node);
        });

        return {
            nodeStyleMap: this.buildVividNodeStyleMap(allNodes),
            nodeById,
            parentLinkedNodeIds: resolvedParentLinkedNodeIds
        };
    }

    private buildVividNodeStyleMap(nodes: ZKNode[]): Map<string, NodeBranchStyle> {
        const styleMap = new Map<string, NodeBranchStyle>();
        if (!this.isModernThemeStyle()) return styleMap;

        const branchIds = Array.from(
            new Set(
                nodes
                    .filter((node) => !node.isRoot)
                    .map((node) => this.getTopBranchId(node.IDStr))
                    .filter(Boolean)
            )
        ).sort(compareIds);

        const isLight = this.currentOptions?.themeMode === 'light';
        const branchColorById = new Map<string, NodeBranchStyle>();
        const styleColorMap = (this.currentData?.metadata as any)?.nodeStyleColors || {};
        const palette = this.getBranchStylePalette();
        branchIds.forEach((branchId) => {
            const storedColor = this.normalizeHexColor(styleColorMap[branchId]);
            const paletteColor = palette[this.hashString(branchId) % palette.length];
            const baseBackground = storedColor || paletteColor.background;
            const accentColor = storedColor
                ? this.lightenColor(baseBackground, isLight ? 0.10 : 0.22)
                : paletteColor.accent;
            let background: string;
            let border: string;
            let shadow: string;
            if (isLight) {
                // 浅色主题：淡色填充 + 软化边框
                border = this.softenColor(accentColor, true);
                background = this.hexToRgba(border, 0.12);
                shadow = 'transparent';
            } else {
                // 现代风格：全填充深色 + 略亮边框
                background = baseBackground;
                border = this.lightenColor(baseBackground, 0.12);
                shadow = this.hexToRgba(baseBackground, 0.22);
            }
            branchColorById.set(branchId, { background, border, shadow });
        });

        nodes.forEach((node) => {
            if (node.isRoot) return;
            const branchId = this.getTopBranchId(node.IDStr);
            const style = branchColorById.get(branchId);
            if (style) styleMap.set(node.IDStr, style);
        });

        return styleMap;
    }
    private getBranchStylePalette(): Array<{ background: string; accent: string }> {
        // 深色珠宝调：background = 深底色，accent = 点缀色
        return [
            { background: '#064e3b', accent: '#10b981' },  // 翡翠绿
            { background: '#78350f', accent: '#f59e0b' },  // 琥珀黄
            { background: '#7f1d1d', accent: '#ef4444' },  // 宝石红
            { background: '#1e3a5f', accent: '#3b82f6' },  // 蓝宝石
            { background: '#4c1d95', accent: '#8b5cf6' },  // 紫水晶
            { background: '#134e4a', accent: '#14b8a6' },  // 碧玺青
            { background: '#831843', accent: '#ec4899' },  // 玫瑰石
            { background: '#312e81', accent: '#6366f1' },  // 靛蓝石
            { background: '#365314', accent: '#84cc16' },  // 橄榄石
            { background: '#0c4a6e', accent: '#0ea5e9' },  // 天河石
            { background: '#3b0764', accent: '#a855f7' },  // 幽紫晶
            { background: '#713f12', accent: '#eab308' },  // 黄玉
            { background: '#14532d', accent: '#22c55e' },  // 翠绿石
            { background: '#164e63', accent: '#06b6d4' },  // 水鸭石
        ];
    }

    private hashString(value: string): number {
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
            hash = ((hash << 5) - hash) + value.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    private measureNodeLabel(label: string, options?: {
        baseWidth?: number;
        minHeight?: number;
        maxWidth?: number;
        charWidth?: number;
        lineHeight?: number;
        paddingX?: number;
        paddingY?: number;
    }): { width: number; height: number } {
        const {
            baseWidth = 80,
            minHeight = 34,
            maxWidth = 220,
            charWidth = 8,
            lineHeight = 12,
            paddingX = 32,
            paddingY = 16
        } = options || {};

        // 计算字符串的实际估算宽度（CJK 字符按 2 倍宽度计算）
        const estimateTextWidth = (text: string): number => {
            let w = 0;
            for (const ch of text) {
                const code = ch.codePointAt(0) || 0;
                // CJK 统一表意文字 + 全角标点
                const isCJK = (code >= 0x4E00 && code <= 0x9FFF) ||
                    (code >= 0x3000 && code <= 0x303F) ||
                    (code >= 0xFF00 && code <= 0xFFEF) ||
                    (code >= 0x3400 && code <= 0x4DBF) ||
                    (code >= 0x20000 && code <= 0x2A6DF);
                w += isCJK ? charWidth * 2 : charWidth;
            }
            return w;
        };

        const lines = String(label || '').split('\n');
        const estimatedWrappedLines = lines.flatMap((line) => {
            const raw = line || ' ';
            const estimatedWidth = estimateTextWidth(raw);
            const wrappedCount = Math.max(1, Math.ceil(estimatedWidth / maxWidth));
            return new Array(wrappedCount).fill(raw);
        });

        const longestLineWidth = Math.min(
            maxWidth,
            Math.max(...lines.map((line) => estimateTextWidth(line || ' ')), charWidth)
        );
        const width = Math.max(baseWidth, longestLineWidth + paddingX);
        const height = Math.max(minHeight, estimatedWrappedLines.length * lineHeight + paddingY);

        return { width, height };
    }

    private compensateFreeLikeNodeFrameSize(
        label: string,
        measured: { width: number; height: number },
        options?: {
            isFreeNode?: boolean;
            isStandaloneText?: boolean;
            maxWidth?: number;
            charWidth?: number;
        }
    ): { width: number; height: number } {
        const isFreeLikeNode = !!(options?.isFreeNode || options?.isStandaloneText);
        if (!isFreeLikeNode) return measured;

        const maxWidth = options?.maxWidth ?? 280;
        const charWidth = options?.charWidth ?? 11;
        const lineCount = this.estimateWrappedLines(label, { maxWidth, charWidth }).length;
        const cornerRadius = 24;

        // 先补齐最小宽度，避免短文本节点初始过窄导致整体显得过小
        const minVisualWidth = lineCount <= 1 ? 136 : 152;
        const width = Math.max(measured.width, minVisualWidth);

        // 锁定最小可视高度到 80（对应渲染后 ~84），避免短文本被压扁
        const minVisualHeight = 80;
        const height = Math.max(measured.height, minVisualHeight);

        return {
            width: Math.round(width),
            height: Math.round(height)
        };
    }

    private estimateWrappedLines(label: string, options?: {
        maxWidth?: number;
        charWidth?: number;
    }): string[] {
        const {
            maxWidth = 220,
            charWidth = 8
        } = options || {};

        const isCJKChar = (ch: string): boolean => {
            const code = ch.codePointAt(0) || 0;
            return (code >= 0x4E00 && code <= 0x9FFF) ||
                (code >= 0x3000 && code <= 0x303F) ||
                (code >= 0xFF00 && code <= 0xFFEF) ||
                (code >= 0x3400 && code <= 0x4DBF) ||
                (code >= 0x20000 && code <= 0x2A6DF);
        };

        const lines = String(label || '').split('\n');
        const wrappedLines: string[] = [];

        lines.forEach((line) => {
            const raw = line || ' ';
            let currentLine = '';
            let currentWidth = 0;

            for (const ch of raw) {
                const w = isCJKChar(ch) ? charWidth * 2 : charWidth;
                if (currentWidth + w > maxWidth && currentLine.length > 0) {
                    wrappedLines.push(currentLine);
                    currentLine = ch;
                    currentWidth = w;
                } else {
                    currentLine += ch;
                    currentWidth += w;
                }
            }
            if (currentLine) wrappedLines.push(currentLine);
        });

        return wrappedLines.length > 0 ? wrappedLines : [' '];
    }

    private normalizeHexColor(color: string | null | undefined): string | null {
        if (!color || typeof color !== 'string') return null;
        const trimmed = color.trim();
        const isHex3 = /^#([0-9a-fA-F]{3})$/.test(trimmed);
        const isHex6 = /^#([0-9a-fA-F]{6})$/.test(trimmed);
        if (!isHex3 && !isHex6) return null;
        if (isHex6) return trimmed.toLowerCase();
        const [, shortHex] = trimmed.match(/^#([0-9a-fA-F]{3})$/)!;
        return `#${shortHex.split('').map((c) => c + c).join('').toLowerCase()}`;
    }

    private hexToRgba(hex: string, alpha: number): string {
        const normalized = this.normalizeHexColor(hex) || '#5b8fd9';
        const r = parseInt(normalized.slice(1, 3), 16);
        const g = parseInt(normalized.slice(3, 5), 16);
        const b = parseInt(normalized.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    private softenColor(hex: string, isLight: boolean): string {
        const normalized = this.normalizeHexColor(hex) || '#5b8fd9';
        const r = parseInt(normalized.slice(1, 3), 16);
        const g = parseInt(normalized.slice(3, 5), 16);
        const b = parseInt(normalized.slice(5, 7), 16);

        // 保持色相，降低亮度与对比度
        const target = isLight ? 98 : 132;
        const ratio = isLight ? 0.54 : 0.50;
        const sr = Math.round(r * (1 - ratio) + target * ratio);
        const sg = Math.round(g * (1 - ratio) + target * ratio);
        const sb = Math.round(b * (1 - ratio) + target * ratio);

        return `#${sr.toString(16).padStart(2, '0')}${sg.toString(16).padStart(2, '0')}${sb.toString(16).padStart(2, '0')}`;
    }

    private getPreviewCardTheme(data: any): {
        cardBackground: string;
        cardBorder: string;
        cardShadow: string;
        headerBackground: string;
        headerDivider: string;
    } {
        const isModern = this.isModernThemeStyle();
        const isColored = isModern;
        const branchBorderColor = typeof data?.branchNodeBorder === 'string' ? data.branchNodeBorder : '';
        const vividHeaderBackground = isColored && branchBorderColor
            ? this.hexToRgba(branchBorderColor, this.currentOptions?.themeMode === 'light' ? 0.18 : 0.28)
            : 'rgba(11, 16, 25, 0.72)';
        const vividHeaderDivider = isColored && branchBorderColor
            ? this.hexToRgba(branchBorderColor, this.currentOptions?.themeMode === 'light' ? 0.55 : 0.7)
            : 'rgba(90, 111, 127, 0.45)';

        const cardBorder = isModern && branchBorderColor
            ? `2.5px solid ${branchBorderColor}`
            : `2px solid rgba(90, 111, 127, 0.4)`;
        const cardShadow = isModern && branchBorderColor
            ? `0 0 10px ${this.hexToRgba(branchBorderColor, 0.35)}, 0 4px 12px rgba(0, 0, 0, 0.25)`
            : '0 4px 12px rgba(0, 0, 0, 0.25)';
        const headerBackground = isModern ? 'transparent' : vividHeaderBackground;
        const headerDivider = isModern && branchBorderColor
            ? this.hexToRgba(branchBorderColor, 0.25)
            : vividHeaderDivider;

        return {
            cardBackground: 'transparent',
            cardBorder,
            cardShadow,
            headerBackground,
            headerDivider
        };
    }

    private applyPreviewHeaderLinkStyle(linkEl: HTMLElement): void {
        linkEl.style.cssText = `
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: pointer;
            color: var(--text-muted);
            transition: color 0.15s ease;
        `;
        linkEl.addEventListener('mouseenter', () => {
            linkEl.style.color = 'var(--text-normal)';
        });
        linkEl.addEventListener('mouseleave', () => {
            linkEl.style.color = 'var(--text-muted)';
        });
    }

    // 将颜色向白色方向提亮，amount=0~1
    private lightenColor(hex: string, amount: number): string {
        const normalized = this.normalizeHexColor(hex) || '#5b8fd9';
        const r = parseInt(normalized.slice(1, 3), 16);
        const g = parseInt(normalized.slice(3, 5), 16);
        const b = parseInt(normalized.slice(5, 7), 16);
        const lr = Math.min(255, Math.round(r + (255 - r) * amount));
        const lg = Math.min(255, Math.round(g + (255 - g) * amount));
        const lb = Math.min(255, Math.round(b + (255 - b) * amount));
        return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
    }

    // 将颜色向黑色方向压暗，amount=0~1
    private darkenColor(hex: string, amount: number): string {
        const normalized = this.normalizeHexColor(hex) || '#5b8fd9';
        const r = parseInt(normalized.slice(1, 3), 16);
        const g = parseInt(normalized.slice(3, 5), 16);
        const b = parseInt(normalized.slice(5, 7), 16);
        const dr = Math.max(0, Math.round(r * (1 - amount)));
        const dg = Math.max(0, Math.round(g * (1 - amount)));
        const db = Math.max(0, Math.round(b * (1 - amount)));
        return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
    }

    /**
     * 获取节点标签
     */
    private getNodeLabel(node: ZKNode, options: RenderOptions | null): string {
        const nodeText = options?.nodeText || 'both';
        const isFreeNode = (node.ID || node.IDStr || '').startsWith('free.');
        const showNoteId = (options?.showNoteId ?? true) && !isFreeNode;

        let label = '';
        switch (nodeText) {
            case 'id':
                label = showNoteId ? node.ID : (node.title || node.displayText);
                break;
            case 'title':
                label = node.title || node.displayText;
                break;
            case 'id-title':
                // id-title 模式：只返回标题，ID 会在 badge 中显示
                label = node.title || node.displayText;
                break;
            case 'both':
            default:
                label = showNoteId ? node.displayText : (node.title || node.displayText);
                break;
        }

        // 处理显示文本：去掉时间戳前缀
        label = this.processDisplayText(label, nodeText, showNoteId);
        label = label.replace(/\\n/g, '\n');

        // 文件图标通过 HTML 叠加层显示，不在这里添加

        return label;
    }

    /**
     * 获取节点徽章（左上角显示的 ID）
     */
    private getNodeBadge(node: ZKNode, options: RenderOptions | null): string {
        const nodeText = options?.nodeText || 'both';
        const isFreeNode = (node.ID || node.IDStr || '').startsWith('free.');
        const showNoteId = (options?.showNoteId ?? true) && !isFreeNode;

        if (!showNoteId) {
            return '';
        }
        
        // 在 id-title 和 both 模式下显示 ID 徽章
        if (nodeText === 'id-title' || nodeText === 'both') {
            return node.ID;
        }
        
        return '';
    }

    /**
     * 处理显示文本：去掉时间戳前缀
     * 支持的时间戳格式：
     * - YYYYMMDD (8位数字)
     * - YYYYMMDDHHMMSS (14位数字)
     * - YYYY-MM-DD
     * - YYYYMMDD-HHMMSS
     */
    private processDisplayText(text: string, nodeText: string, showNoteId: boolean): string {
        if (!showNoteId) {
            return text
                .replace(/^[a-zA-Z0-9._]+(?::\s*|\s+)/, '')
                .replace(/^\d+\s+/, '');
        }

        if (nodeText === 'id-title') {
            // id-title 模式：去掉 ID 前缀和时间戳
            // 支持冒号分隔：a.1: 20251215 薛定谔方程 -> 薛定谔方程
            // 支持空格分隔：ai.b 什么是智能体 -> 什么是智能体（displayText 回退场景）
            return text
                .replace(/^[a-zA-Z0-9._]+(?::\s*|\s+)/, '')  // 去掉 "ID: " 或 "ID " 前缀
                .replace(/^\d+\s+/, '');  // 去掉开头的纯数字时间戳
        } else if (nodeText === 'title' || nodeText === 'both') {
            // title 或 both 模式：去掉开头的时间戳
            // 例如：20251215 薛定谔方程 -> 薛定谔方程
            return text.replace(/^\d+\s+/, "");
        }
        
        return text;
    }

    /**
     * 转义 ID 中的特殊字符
     */
    private escapeId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    /**
     * 生成用于保存的 wikilink：
     * - .md 继续使用 basename（保持现有习惯）
     * - .moc / .moc.md 使用文件名（带扩展名），避免与同名 .md 冲突
     */
    private buildWikiLinkForFile(file: any): string {
        const path = String(file?.path || '').trim();
        const name = String(file?.name || '').trim();
        const basename = String(file?.basename || '').trim();

        if (isMocPath(path) || isMocPath(name)) {
            return name || basename;
        }

        return basename || name || path;
    }

    /**
     * .moc 预览 PNG 路径（与 mocEmbedExporter 保持一致）
     * 默认：{moc目录}/attachments/{moc文件名}.png => 例如 a/demo.moc.png
     */
    private getMocPreviewPngCandidates(mocFilePath: string): string[] {
        const normalized = String(mocFilePath || '').trim();
        if (!isMocPath(normalized)) return [];

        const dir = normalized.includes('/') ? normalized.substring(0, normalized.lastIndexOf('/')) : '';
        const mocFileName = normalized.includes('/') ? normalized.substring(normalized.lastIndexOf('/') + 1) : normalized;
        const mocBasename = stripMocSuffix(mocFileName);

        const candidates = [
            dir ? `${dir}/attachments/${mocFileName}.png` : `attachments/${mocFileName}.png`,
            dir ? `${dir}/attachments/${mocBasename}.png` : `attachments/${mocBasename}.png`
        ];

        // 去重
        return Array.from(new Set(candidates));
    }

    /**
     * 设置入链出链图的初始位置
     * 入链节点在中心节点上方，出链节点在下方
     */
    /**
     * 为出入链节点预设网格位置（在 Cytoscape 初始化前调用）
     * 直接设置 savedPosition，避免节点堆叠在原点导致 edge 无法绘制
     */
    private presetInOutLinksPositions(data: GraphData): void {
        const hasInOutLinks = data.nodes.some(node =>
            node.ID.startsWith('inlink-') || node.ID.startsWith('outlink-') || node.ID === 'current'
        );
        if (!hasInOutLinks) return;

        const inlinks: ZKNode[] = [];
        const outlinks: ZKNode[] = [];

        data.nodes.forEach(node => {
            if (node.ID.startsWith('inlink-')) inlinks.push(node);
            else if (node.ID.startsWith('outlink-')) outlinks.push(node);
            else if (node.ID === 'current') node.savedPosition = { x: 0, y: 0 };
        });

        // 网格布局参数
        const COLS = 3;
        const COL_GAP = 180;
        const ROW_GAP = 100;
        const CENTER_GAP = 120;

        const assignGrid = (nodes: ZKNode[], startY: number, direction: 1 | -1) => {
            for (let i = 0; i < nodes.length; i++) {
                const row = Math.floor(i / COLS);
                const col = i % COLS;
                const colsInRow = Math.min(COLS, nodes.length - row * COLS);
                const x = (col - (colsInRow - 1) / 2) * COL_GAP;
                const y = startY + direction * row * ROW_GAP;
                nodes[i].savedPosition = { x, y };
            }
        };

        // 出链在上方
        const outlinkRows = Math.ceil(outlinks.length / COLS);
        const outlinkStartY = -CENTER_GAP - (outlinkRows - 1) * ROW_GAP;
        assignGrid(outlinks, outlinkStartY, 1);

        // 入链在下方
        assignGrid(inlinks, CENTER_GAP, 1);
    }

    /**
     * 根据 layoutType 获取布局配置
     * 用于局部关系视图的出入链图等需要自动布局的场景
     */
    private getLayoutConfig(options: RenderOptions): any {
        const layoutType = options.layoutType || 'preset';

        // 默认使用 preset 布局（索引视图等已有位置信息的情况）
        if (layoutType === 'preset') {
            return { name: 'preset' };
        }

        // 根据方向设置布局方向
        const rankDir = this.directionToRankDir(options.direction || 'TB');

        switch (layoutType) {
            case 'dagre':
                // dagre 层级布局，适合家族树结构
                return {
                    name: 'dagre',
                    rankDir: rankDir,
                    nodeSep: 50,
                    rankSep: 100,
                    edgeSep: 10
                };

            case 'cose':
                // cose 力导向布局，适合入链出链图
                return {
                    name: 'cose',
                    // 节点间距
                    nodeRepulsion: 100000,
                    // 理想边长
                    idealEdgeLength: 100,
                    // 边弹性
                    edgeElasticity: 100,
                    // 布局迭代次数
                    nestingFactor: 5,
                    // 初始布局时的温度
                    initialTemp: 200,
                    // 冷却因子
                    coolingFactor: 0.95,
                    // 最小温度
                    minTemp: 1.0
                };

            case 'cose-bilkent':
                // cose-bilkent 力导向布局，适合复杂的网络结构
                return {
                    name: 'cose-bilkent',
                    // 布局质量
                    quality: 'proof',
                    // 是否为有向图
                    directed: false,
                    // 节点间距
                    nodeRepulsion: 4500,
                    // 理想边长
                    idealEdgeLength: 50,
                    // 边弹性
                    edgeElasticity: 0.45
                };

            case 'breadthfirst':
                return {
                    name: 'breadthfirst',
                    directed: false,
                    spacingFactor: 1.5
                };

            case 'grid':
                return {
                    name: 'grid'
                };

            default:
                return { name: 'preset' };
        }
    }

    /**
     * 将方向字符串转换为 dagre 的 rankDir 格式
     */
    private directionToRankDir(direction: string): string {
        switch (direction) {
            case 'TB': return 'TB'; // Top to Bottom
            case 'BT': return 'BT'; // Bottom to Top
            case 'LR': return 'LR'; // Left to Right
            case 'RL': return 'RL'; // Right to Left
            default: return 'TB';
        }
    }

    private getStylesheet(options: RenderOptions): any[] {
    const isLight = options.themeMode === 'light';
    const isModern = (options.themeStyle || 'modern') === 'modern';
    const edgeStyle = options.edgeStyle || 'bezier';

    const colors = isLight ? {
        // 浅色主题颜色
        nodeBackground: '#f0f0f0',
        nodeBackgroundHover: '#e0e0e0',
        nodeBackgroundSelected: '#d0d0d0',
        nodeBorder: '#b0b0b0',
        nodeBorderSelected: '#0066cc',
        nodeText: '#333333',
        nodeTextMuted: '#666666',
        edgeNormal: '#999999',
        edgeForward: '#60a5fa',  // 淡蓝色
        edgeReverse: '#dc2626',
        edgeSelected: '#7c3aed',
        textBackground: '#ffffff',
        overlayColor: '#60a5fa',
        badgeBackground: '#60a5fa',
        badgeText: '#ffffff'
    } : {
        // 深色主题颜色（保持原有颜色）
        nodeBackground: '#1a2332',
        nodeBackgroundHover: '#243447',
        nodeBackgroundSelected: '#2d4a6b',
        nodeBorder: '#3d5a80',
        nodeBorderSelected: '#5b8fd9',
        nodeText: '#ffffff',
        nodeTextMuted: '#94a3b8',
        edgeNormal: '#4a5568',
        edgeForward: '#5b8fd9',
        edgeReverse: '#ef4444',
        edgeSelected: '#7c3aed',
        textBackground: '#0f172a',
        overlayColor: '#5b8fd9',
        badgeBackground: '#5b8fd9',
        badgeText: '#ffffff'
    };
        return [
        // 节点样式 - 使用函数动态计算大小
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'text-valign': 'center',
                'text-halign': 'center',
                'text-wrap': 'wrap',
                'text-max-width': '280px',
                'text-overflow-wrap': 'anywhere',
                'background-color': (ele: any) => {
                    const fillColor = ele.data('customFillColor');
                    if (fillColor && !ele.data('isEmbed') && !ele.data('isGroup')) {
                        return fillColor;
                    }
                    return colors.nodeBackground;
                },
                'color': (ele: any) => {
                    const fillTextColor = ele.data('customFillTextColor');
                    if (fillTextColor && !ele.data('isEmbed') && !ele.data('isGroup')) {
                        return fillTextColor;
                    }
                    return colors.nodeText;
                },
                'font-size': '20px',
                'font-weight': '500',
                // 使用函数动态计算宽度和高度
                'width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    if (manualWidthModel > 0 && ele.data('isTextOnly')) {
                        return manualWidthModel;
                    }
                    const label = ele.data('label') || '';
                    const measured = this.measureNodeLabel(label, {
                        baseWidth: 90,
                        minHeight: 42,
                        maxWidth: 280,
                        charWidth: 11,
                        lineHeight: 18,
                        paddingX: 40,
                        paddingY: 20
                    });
                    const compensated = this.compensateFreeLikeNodeFrameSize(label, measured, {
                        isFreeNode: true,
                        isStandaloneText: !!ele.data('isStandaloneText'),
                        maxWidth: 280,
                        charWidth: 11
                    });
                    return compensated.width;
                },
                'height': (ele: any) => {
                    const manualHeightModel = Number(ele.data('manualHeightModel') || 0);
                    if (manualHeightModel > 0 && ele.data('isTextOnly')) {
                        return manualHeightModel;
                    }
                    const label = ele.data('label') || '';
                    const measured = this.measureNodeLabel(label, {
                        baseWidth: 90,
                        minHeight: 42,
                        maxWidth: 280,
                        charWidth: 11,
                        lineHeight: 18,
                        paddingX: 40,
                        paddingY: 20
                    });
                    const compensated = this.compensateFreeLikeNodeFrameSize(label, measured, {
                        isFreeNode: true,
                        isStandaloneText: !!ele.data('isStandaloneText'),
                        maxWidth: 280,
                        charWidth: 11
                    });
                    return compensated.height;
                },
                'padding': '20px',
                'shape': 'round-rectangle',
                'corner-radius': '24px',
                'border-width': '2px',
                'border-opacity': 0.72,
                'border-color': (ele: any) => {
                    if (isModern && ele.data('branchNodeBorder') && !ele.data('isRoot') && !ele.data('isFreeNode')) {
                        return ele.data('branchNodeBorder');
                    }
                    return colors.nodeBorder;
                },
                'transition-property': 'background-color, border-color',
                'transition-duration': '0.2s'
            } as any
        },
        // 现代风格：边框增强（无 shadow-*，避免 Cytoscape 样式告警）
        ...(isModern ? [{
            selector: 'node[!isRoot][!isEmbed][!isStandaloneText]',
            style: {
                'border-width': '2.5px',
            } as any
        }] : []),
        // 嵌入节点：由 HTML 预览卡片承载内容，隐藏 Cytoscape 默认卡片外观
        {
            selector: 'node[?isEmbed]',
            style: {
                'label': '',
                'background-opacity': 0,
                'border-width': 0
            } as any
        },
        // 纯文本节点：文字换行宽度跟随节点宽度（支持手动拉伸后自适应）
        {
            selector: 'node[?isTextOnly]',
            style: {
                'text-max-width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    const w = Number(ele.width() || 0);
                    // 使用节点实际宽度；若未就绪则用保守值避免不可见标签撑大 boundingBox
                    const widthModel = manualWidthModel > 0 ? manualWidthModel : (w > 0 ? w : 200);
                    return Math.max(120, widthModel - 48);
                }
            } as any
        },
        // 具有 Markdown 渲染 overlay 的文本节点：隐藏 Canvas 文字（由 HTML 层渲染）
        {
            selector: 'node[?isTextOnly][?hasMarkdownOverlay]',
            style: {
                'text-opacity': 0
            } as any
        },
        // 自由文本节点（无父子关系）：纯文本样式（透明边框与背景）
        {
            selector: 'node[?isStandaloneText]',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'shape': 'round-rectangle',
                'padding': '0px'
            } as any
        },
        // 普通节点（文本/文件）：与自由文本节点尺寸对齐（免去外扩 padding），保留卡片背景与边框
        {
            selector: 'node[!isStandaloneText][!isEmbed][!isRoot]',
            style: {
                'padding': '0px'
            } as any
        },
        // 根节点样式：尺寸放大 2 倍，边框加粗
        {
            selector: 'node[?isRoot][!isFreeNode]',
            style: {
                'background-color': '#0f2440',
                'border-color': '#1a3558',
                'font-size': '26px',
                'font-weight': 'bold',
                'text-max-width': (ele: any) => {
                    if (ele.data('isTextOnly')) {
                        const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                        const widthModel = manualWidthModel > 0 ? manualWidthModel : Number(ele.width() || 400);
                        return Math.max(120, widthModel - 48);
                    }
                    return 400;
                },
                'width': (ele: any) => {
                    const manualWidthModel = Number(ele.data('manualWidthModel') || 0);
                    if (manualWidthModel > 0 && ele.data('isTextOnly')) {
                        return manualWidthModel;
                    }
                    const label = ele.data('label') || '';
                    const normalSize = this.measureNodeLabel(label, {
                        baseWidth: 80,
                        minHeight: 34,
                        maxWidth: 220,
                        charWidth: 8,
                        lineHeight: 12,
                        paddingX: 32,
                        paddingY: 16
                    });
                    return normalSize.width * 2;
                },
                'height': (ele: any) => {
                    const manualHeightModel = Number(ele.data('manualHeightModel') || 0);
                    if (manualHeightModel > 0 && ele.data('isTextOnly')) {
                        return manualHeightModel;
                    }
                    const label = ele.data('label') || '';
                    const normalSize = this.measureNodeLabel(label, {
                        baseWidth: 80,
                        minHeight: 34,
                        maxWidth: 220,
                        charWidth: 8,
                        lineHeight: 12,
                        paddingX: 32,
                        paddingY: 16
                    });
                    return normalSize.height * 2;
                },
                'border-width': '4px'
            } as any
        },
        {
            selector: 'node[?isRoot][!isFreeNode]:selected',
            style: {
                'background-color': '#162f52',
                'border-color': '#2a4f7a',
                'border-width': '4px',
                'color': '#ffffff'
            } as any
        },
        // 节点徽章样式已通过 HTML 叠加层实现，这里不需要额外样式
        // 分组节点样式 - 完全透明（由 CSS glass overlay 层实现视觉效果）
        {
            selector: '.group-node',
            style: {
                'background-color': 'transparent',
                'background-opacity': 0,
                'border-width': '0px',
                'shape': 'round-rectangle',
                'label': '',
                'padding': '20px'
            } as any
        },
        // 占位符节点样式 - 虚线边框，半透明
        {
            selector: 'node[?isPlaceholder]',
            style: {
                'opacity': 0.7,
                'border-style': 'dashed',
                'border-width': '2px',
                'border-color': colors.nodeBorderSelected,
                'background-color': colors.nodeBackground
            } as any
        },
        // 占位符节点选中状态 - 更明显的视觉反馈
        {
            selector: 'node[?isPlaceholder]:selected',
            style: {
                'opacity': 1,
                'border-style': 'dashed',
                'border-width': '3px',
                'border-color': colors.nodeBorderSelected,
                'background-color': colors.nodeBackgroundSelected,
                'overlay-color': colors.nodeBorderSelected,
                'overlay-padding': '4px',
                'overlay-opacity': 0.3
            } as any
        },
        // 折叠隐藏的子节点/连线
        {
            selector: 'node.zk-collapsed-hidden',
            style: {
                'display': 'none'
            } as any
        },
        {
            selector: 'edge.zk-collapsed-hidden',
            style: {
                'display': 'none'
            } as any
        },
        // 默认边样式 - 使用 unbundled-bezier 支持自定义控制点
        {
            selector: 'edge',
            style: {
                'width': (ele: any) => {
                    const hierarchyEdgeWidth = ele.data('hierarchyEdgeWidth');
                    if (typeof hierarchyEdgeWidth === 'number') {
                        return hierarchyEdgeWidth;
                    }
                    return 2;
                },
                'line-color': colors.edgeNormal,
                'target-arrow-color': colors.edgeNormal,
                'target-arrow-shape': 'triangle',
                'curve-style': edgeStyle === 'straight'
                    ? 'straight'
                    : (edgeStyle === 'polyline' ? 'taxi' : 'unbundled-bezier'),
                'taxi-direction': 'auto',
                'taxi-turn': 40,
                'control-point-distances': (ele: any) => {
                    if (edgeStyle !== 'bezier') return 0;
                    const distance = ele.data('controlPointDistance');
                    // 贝塞尔模式下给一个非零默认弯曲量，避免视觉上仍是直线
                    return distance !== undefined ? distance : 60;
                },
                'control-point-weights': (ele: any) => {
                    if (edgeStyle !== 'bezier') return 0.5;
                    const weight = ele.data('controlPointWeight');
                    return weight !== undefined ? weight : 0.5;
                },
                'arrow-scale': 1.5,
                'label': 'data(label)',
                'font-size': '18px',
                'color': colors.nodeText,
                'text-background-opacity': 0,
                'text-border-opacity': 0,
                'z-index-compare': 'manual',
                'z-index': 999
            } as any
        },
        // 正向边
        {
            selector: 'edge[type="forward"]',
            style: {
                'line-color': colors.edgeForward,
                'target-arrow-color': colors.edgeForward,
                'width': 2.5,
                'z-index': 999
            } as any
        },
        // 反向边（虚线）- 降噪设计
        {
            selector: 'edge[type="reverse"]',
            style: {
                'line-style': 'dashed',
                'line-dash-pattern': [12, 8],
                'line-color': '#64748b',  // 暗灰色（降噪）
                'target-arrow-color': '#64748b',
                'width': 3,    // 加粗一倍
                'arrow-scale': 1.35,
                'opacity': 0.5,  // 更淡
                'z-index': 999
            } as any
        },
        // 跨领域边（虚线连接 + 特殊样式）
        {
            selector: 'edge[type="cross-domain"]',
            style: {
                'line-style': 'dashed',
                'line-dash-pattern': [14, 8],  // 虚线模式
                'line-color': '#8b5cf6',  // 紫色（跨领域标识）
                'target-arrow-color': '#8b5cf6',
                'width': 2,
                'arrow-scale': 1.2,
                'opacity': 0.7,
                'label': 'data(label)',
                'font-size': '18px',
                'color': '#8b5cf6',
                'text-background-opacity': 0,
                'text-border-opacity': 0,
                'z-index': 998
            } as any
        },
        // 边选中状态
        {
            selector: 'edge:selected',
            style: {
                'line-color': colors.edgeSelected,
                'target-arrow-color': colors.edgeSelected,
                'width': 3,
                'opacity': 1,
                'z-index': 1000
            } as any
        },
        // 节点悬停状态
        {
            selector: 'node:active',
            style: {
                'background-color': colors.nodeBackgroundHover,
                'border-color': colors.nodeBorderSelected,
                'overlay-opacity': 0.15
            } as any
        },
        // 节点选中状态
        {
            selector: 'node:selected',
            style: {
                'background-color': colors.nodeBackgroundSelected,
                'border-color': colors.nodeBorderSelected,
                'border-width': '3px',
                'border-opacity': 0.90,
                'color': '#ffffff'
            } as any
        },
        // 自由节点：微底色晕染（无 shadow-*，避免 Cytoscape 样式告警）
        {
            selector: 'node[?isFreeNode]:unselected',
            style: {
                'background-color': isLight ? '#94a3b8' : '#7b9cc4',
                'background-opacity': isLight ? 0.05 : 0.04,
                // 与普通节点保持一致，仅保留自由节点半透明底色
                'font-size': '20px',
                'border-width': isModern ? '2.5px' : '2px',
                // 保持自由节点原有半透明视觉：边框不显色
                'border-opacity': 0,
                'border-color': 'transparent',
                'corner-radius': '24px',
            } as any
        },
        // 自由节点选中态：与普通节点保持一致（覆盖 isStandaloneText 选中样式）
        {
            selector: 'node[?isFreeNode]:selected',
            style: {
                'background-opacity': 1,
                'background-color': colors.nodeBackgroundSelected,
                'border-color': colors.nodeBorderSelected,
                'border-width': '3px',
                'color': '#ffffff'
            } as any
        },
        // 兼容旧语义：仅有 legacy customColor 的节点保留文字左侧色点留白
        {
            selector: 'node[?hasCustomColor][!isEmbed][!isGroup]',
            style: {
                'text-margin-x': 8,
            } as any
        },
        // 嵌入节点选中态：保持隐藏（由 HTML 预览卡片处理选中视觉）
        {
            selector: 'node[?isEmbed]:selected',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'overlay-opacity': 0
            } as any
        },
        // 嵌入节点激活态：保持隐藏
        {
            selector: 'node[?isEmbed]:active',
            style: {
                'overlay-opacity': 0
            } as any
        },
        // 图片节点：始终隐藏（由 HTML 图片卡片处理视觉）
        {
            selector: 'node[?isImageNode]:selected',
            style: {
                'background-opacity': 0,
                'border-width': 0,
                'overlay-opacity': 0
            } as any
        },
        {
            selector: 'node[?isImageNode]:active',
            style: {
                'overlay-opacity': 0
            } as any
        },
        // 当前文件节点（与分支视图根节点颜色一致）
        {
            selector: 'node[?isCurrentFile]',
            style: {
                'background-color': '#1e3a5f',
                'border-color': '#2a4f7a',
                'border-width': '3px',
                'font-weight': '600'
            } as any
        },
        // 出链节点样式（蓝色）
        {
            selector: 'node[?isOutlink]',
            style: {
                'background-color': isLight ? '#bfdbfe' : '#3b82c8',
                'border-color': isLight ? '#93c5fd' : '#5ba0e0',
                'border-width': '2px',
                'color': isLight ? '#1e3a5f' : '#e0ecf8'
            } as any
        },
        // 入链节点样式（黄色）
        {
            selector: 'node[?isInlink]',
            style: {
                'background-color': isLight ? '#fef3c7' : '#c8a832',
                'border-color': isLight ? '#fcd34d' : '#dab840',
                'border-width': '2px',
                'color': isLight ? '#78350f' : '#fef3c7'
            } as any
        },
        // 连接目标悬停状态
        {
            selector: 'node.connection-target-hover',
            style: {
                'border-color': '#10b981',  // 绿色
                'border-width': '3px',
                'background-color': 'rgba(16, 185, 129, 0.1)'
            } as any
        },
        // 自动布局父节点拖动时，跟随移动的后代节点
        {
            selector: 'node.auto-hierarchy-descendant',
            style: {
                'border-color': '#4dabf7',
                'border-width': '2.5px',
                'border-style': 'dashed',
                'border-opacity': 0.9
            } as any
        },
        {
            selector: 'edge.auto-hierarchy-descendant-edge',
            style: {
                'line-color': '#4dabf7',
                'target-arrow-color': '#4dabf7',
                'source-arrow-color': '#4dabf7',
                'width': 2,
                'opacity': 0.85,
                'line-style': 'dashed'
            } as any
        },
        // 高亮子节点箭头
        {
            selector: 'edge.child-edge-highlight',
            style: {
                'line-color': '#a78b71',
                'target-arrow-color': '#a78b71',
                'width': 2.5,
                'opacity': 0.8,
                'z-index': 1000
            } as any
        },
        // 搜索高亮
        {
            selector: 'node.zk-search-highlight',
            style: {
                'border-width': '4px',
                'border-color': '#00a8ff',
                'border-opacity': 1,
                'z-index': 9999
            } as any
        }
    ];
}

    /**
     * 为 ![[...]] 节点添加常驻预览卡片（类似 Canvas 笔记卡）
     */
    private addEmbedNodePreviews(): void {
        if (!this.cy || !this.container) return;

        // 清理前先缓存已渲染的卡片内容（避免 excalidraw/markdown 异步内容闪烁）
        if (this.embedPreviewCleanup) {
            const oldContainer = this.container.querySelector('.zk-embed-previews');
            if (oldContainer) {
                oldContainer.querySelectorAll('.zk-embed-preview-card').forEach((card: Element) => {
                    const nid = (card as HTMLElement).dataset.nodeId;
                    if (nid) this.embedCardCache.set(nid, card as HTMLElement);
                });
            }
            this.embedPreviewCleanup();
            this.embedPreviewCleanup = null;
        }

        const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
        // 排除图片文件的嵌入节点（图片由 addImageNodePreviews 处理）
        const embedNodes = this.cy.nodes('[?isEmbed]').filter((node: any) => {
            const filePath = node.data('filePath');
            if (!filePath) return true; // 无路径的保留
            const ext = filePath.split('.').pop()?.toLowerCase() || '';
            return !IMAGE_EXTENSIONS.has(ext);
        });
        if (embedNodes.length === 0) { this.embedCardCache.clear(); return; }

        const app = (window as any).app;
        if (!app) return;

        const previewContainer = document.createElement('div');
        previewContainer.className = 'zk-embed-previews';
        previewContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 2;
        `;
        this.container.appendChild(previewContainer);

        const rendererComponent = new Component();
        this.embedRendererComponents.add(rendererComponent);
        const updaters: Array<() => void> = [];
        // 记录用户手动调整后的尺寸（以画布坐标系存储，缩放时按 zoom 换算为像素）
        const cardSizeMap = new Map<string, { widthModel: number; heightModel: number }>();
        const embedNodeSizes = ((this.currentData?.metadata as any)?.embedNodeSizes || {}) as Record<string, { width: number; height: number }>;
        const interactionUpdaters: Array<() => void> = [];
        let suppressedCanvasInteractionCount = 0;
        const setCanvasInteractionSuppressed = (suppressed: boolean) => {
            if (!this.cy) return;
            if (suppressed) {
                suppressedCanvasInteractionCount += 1;
                if (suppressedCanvasInteractionCount === 1) {
                    this.cy.userZoomingEnabled(false);
                    this.cy.userPanningEnabled(false);
                }
                return;
            }
            suppressedCanvasInteractionCount = Math.max(0, suppressedCanvasInteractionCount - 1);
            if (suppressedCanvasInteractionCount === 0) {
                this.cy.userZoomingEnabled(true);
                this.cy.userPanningEnabled(true);
            }
        };

        embedNodes.forEach((node: any) => {
            const data = node.data();
            const originalNode = data.originalNode as ZKNode | undefined;
            if (!originalNode?.file) return;
            const sourceFile = originalNode.file;
            const isExcalidrawFile = sourceFile.path.includes('.excalidraw');
            const nodeId = node.id();
            const persistedSize = embedNodeSizes[originalNode.ID] || embedNodeSizes[originalNode.IDStr];
            if (persistedSize && persistedSize.width > 0 && persistedSize.height > 0) {
                cardSizeMap.set(nodeId, {
                    widthModel: persistedSize.width,
                    heightModel: persistedSize.height
                });
            }
            const theme = this.getPreviewCardTheme(data);
            const resolvedCardBorder = 'none';
            const resolvedCardBackground = isExcalidrawFile ? 'transparent' : theme.cardBackground;
            const resolvedCardShadow = isExcalidrawFile && !!data.isFreeNode ? 'none' : theme.cardShadow;

            const card = document.createElement('div');
            card.className = 'zk-embed-preview-card';
            card.dataset.nodeId = nodeId;
            card.style.cssText = `
                position: absolute;
                left: 0;
                top: 0;
                background: ${resolvedCardBackground};
                border: ${resolvedCardBorder};
                border-radius: 8px;
                box-shadow: ${resolvedCardShadow};
                color: var(--text-normal);
                overflow: hidden;
                pointer-events: auto;
                will-change: transform;
            `;

            const headerEl = document.createElement('div');
            headerEl.dataset.role = 'embed-header';
            headerEl.style.cssText = `
                height: 32px;
                padding: 0 12px;
                display: flex;
                align-items: center;
                gap: 6px;
                background: ${theme.headerBackground};
                color: var(--text-muted);
                font-size: 12px;
                font-weight: 500;
                letter-spacing: 0.2px;
                white-space: nowrap;
                overflow: hidden;
                user-select: none;
            `;
            // 文件名链接；若节点有 alias（ZKNode.title 与 wikiLink 不同），拼成 "basename|alias"
            const headerLink = document.createElement('span');
            const aliasCandidate = String(originalNode?.title || '').trim();
            const rawWikiLink = String(originalNode?.wikiLink || '').trim();
            const hasAlias = aliasCandidate && aliasCandidate !== rawWikiLink
                && aliasCandidate !== sourceFile.basename
                && !aliasCandidate.includes('/');  // 路径字符串不算 alias
            headerLink.textContent = hasAlias
                ? `${sourceFile.basename}|${aliasCandidate}`
                : sourceFile.basename;
            this.applyPreviewHeaderLinkStyle(headerLink);
            headerLink.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (isMocPath(sourceFile.path)) {
                    // .moc / .moc.md 文件：触发分支视图打开
                    this.container?.dispatchEvent(new CustomEvent('open-moc-in-index-view', {
                        detail: { filePath: sourceFile.path }
                    }));
                    return;
                }

                // 带 subpath（如 Excalidraw 的 #^group=xxx）：透传给 ExcalidrawView 做元素级定位
                const rawLink = String(originalNode?.wikiLink || '').trim();
                const hashIdx = rawLink.indexOf('#');
                const subpath = hashIdx >= 0 ? rawLink.substring(hashIdx) : '';
                const newLeaf = e.ctrlKey || e.metaKey;

                if (subpath) {
                    const existingLeaf = !newLeaf ? app.workspace.getLeavesOfType('markdown')
                        .concat(app.workspace.getLeavesOfType('excalidraw' as any))
                        .find((leaf: any) => leaf.view?.file?.path === sourceFile.path) : null;

                    if (existingLeaf) {
                        app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                        (existingLeaf.view as any).setEphemeralState?.({ subpath });
                    } else {
                        app.workspace.getLeaf(newLeaf).openFile(sourceFile, {
                            eState: { subpath },
                            active: true,
                        } as any);
                    }
                    return;
                }

                // 查找已打开的 tab，有则激活，无则新开
                const existingLeaf = app.workspace.getLeavesOfType('markdown')
                    .find((leaf: any) => leaf.view?.file?.path === sourceFile.path);
                if (existingLeaf) {
                    app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                } else {
                    app.workspace.openLinkText(sourceFile.path, '', newLeaf);
                }
            });
            headerEl.appendChild(headerLink);

            const contentEl = document.createElement('div');
            contentEl.dataset.role = 'embed-content';
            contentEl.style.cssText = `
                height: calc(100% - 36px);
                overflow: auto;
                overscroll-behavior: contain;
                padding: 12px 14px;
                font-size: 14px;
                line-height: 1.6;
                color: var(--text-normal);
                scrollbar-width: thin;
            `;

            // 右下角 resize 焦点（仅在选中时可用）
            const resizeHandle = document.createElement('div');
            resizeHandle.style.cssText = `
                position: absolute;
                right: 0;
                bottom: 0;
                width: 18px;
                height: 18px;
                background: rgba(91, 143, 217, 0.9);
                border-top-left-radius: 6px;
                cursor: nwse-resize;
                pointer-events: none;
                opacity: 0;
                color: rgba(255, 255, 255, 0.95);
                font-size: 11px;
                font-weight: 700;
                display: flex;
                align-items: flex-end;
                justify-content: flex-end;
                line-height: 1;
                padding-right: 2px;
                transition: opacity 0.15s ease;
            `;
            resizeHandle.textContent = '◢';

            card.appendChild(headerEl);
            // 仅对 excalidraw 复用缓存内容（避免异步渲染闪烁）
            if (isExcalidrawFile) {
                const cachedCard = this.embedCardCache.get(nodeId);
                const cachedContent = cachedCard?.querySelector('[data-role="embed-content"]') as HTMLElement | null;
                if (cachedContent && cachedContent.children.length > 0) {
                    while (cachedContent.firstChild) {
                        contentEl.appendChild(cachedContent.firstChild);
                    }
                    if (cachedContent.style.position === 'relative') {
                        contentEl.style.position = 'relative';
                    }
                }
            }
            card.appendChild(contentEl);
            card.appendChild(resizeHandle);
            previewContainer.appendChild(card);

            const embedToggleEl = document.createElement('div');
            embedToggleEl.className = 'zk-embed-toggle';
            const embedToggleLabel = '切换为文件节点';
            embedToggleEl.setAttribute('aria-label', embedToggleLabel);
            setIcon(embedToggleEl, 'eye-off');
            embedToggleEl.style.cssText = `
                position: absolute;
                cursor: pointer;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.15s ease;
                user-select: none;
                z-index: 11;
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: var(--text-normal);
            `;
            const embedToggleSvg = embedToggleEl.querySelector('svg') as SVGElement | null;
            if (embedToggleSvg) {
                embedToggleSvg.style.width = '95%';
                embedToggleSvg.style.height = '95%';
                embedToggleSvg.style.strokeWidth = '2.2';
            }
            previewContainer.appendChild(embedToggleEl);
            const swallowTogglePointer = (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
            };
            embedToggleEl.addEventListener('pointerdown', swallowTogglePointer);
            embedToggleEl.addEventListener('mousedown', swallowTogglePointer);
            embedToggleEl.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.container?.dispatchEvent(new CustomEvent('toggle-embed-node', {
                    detail: {
                        node: data.originalNode,
                        nodeId: data.originalNodeId || data.originalNode?.IDStr || data.originalNode?.ID || '',
                        wikiLink: data.originalNode?.wikiLink || '',
                        filePath: data.filePath || '',
                        displayText: data.displayText || '',
                        title: data.title || '',
                        currentIsEmbed: true
                    }
                }));
            });

            // 仅选中时允许交互（滚轮滚动/拖拽缩放），避免影响画布操作
            let isHoveringCard = false;
            const releaseCanvasSuppression = () => {
                if (isHoveringCard) {
                    isHoveringCard = false;
                    setCanvasInteractionSuppressed(false);
                }
            };
            const updateInteraction = () => {
                const isSelected = node.selected();
                resizeHandle.style.pointerEvents = isSelected ? 'auto' : 'none';
                resizeHandle.style.opacity = isSelected ? '1' : '0';
                embedToggleEl.style.pointerEvents = isSelected ? 'auto' : 'none';
                embedToggleEl.style.opacity = isSelected ? '1' : '0';
                contentEl.style.cursor = isSelected ? 'move' : 'default';
                if (!isSelected) {
                    releaseCanvasSuppression();
                }
            };
            interactionUpdaters.push(updateInteraction);
            updateInteraction();

            // 缓存连线手柄 DOM 引用，避免每次 hover 都 querySelector
            let cachedConnectionHandle: HTMLElement | null = null;
            const resolveConnectionHandle = (): HTMLElement | null => {
                if (!cachedConnectionHandle) {
                    cachedConnectionHandle = this.container?.querySelector(`.zk-connection-handle[data-embed-node-id="${nodeId}"]`) as HTMLElement | null;
                }
                return cachedConnectionHandle;
            };

            card.addEventListener('mouseenter', () => {
                const handle = resolveConnectionHandle();
                if (handle && this.cy) {
                    const zoom = this.cy.zoom();
                    const rp = node.renderedPosition();
                    const outerW = node.outerWidth();
                    const outerH = node.outerHeight();
                    const bbX1 = rp.x - (outerW * zoom) / 2;
                    const bbY1 = rp.y - (outerH * zoom) / 2;
                    const bbY2 = bbY1 + outerH * zoom;
                    const cardW = card.offsetWidth;
                    handle.style.transform = `translate(${bbX1 + cardW}px, ${(bbY1 + bbY2) / 2}px) translate(-50%, -50%)`;
                    handle.style.opacity = '1';
                }
                if (!node.selected() || isHoveringCard) return;
                isHoveringCard = true;
                setCanvasInteractionSuppressed(true);
            });
            card.addEventListener('mouseleave', (e: MouseEvent) => {
                const handle = resolveConnectionHandle();
                if (handle) {
                    if (!(e.relatedTarget === handle || handle.contains(e.relatedTarget as Node))) {
                        handle.style.opacity = '0';
                    }
                }
                releaseCanvasSuppression();
            });

            let wheelSuppressTimeout: number | null = null;
            const handleWheel = (e: WheelEvent) => {
                if (!node.selected()) return;
                e.preventDefault();
                e.stopPropagation();
                if (!isHoveringCard) {
                    isHoveringCard = true;
                    setCanvasInteractionSuppressed(true);
                }
                if (wheelSuppressTimeout !== null) {
                    window.clearTimeout(wheelSuppressTimeout);
                }
                wheelSuppressTimeout = window.setTimeout(() => {
                    if (!isHoveringCard) {
                        setCanvasInteractionSuppressed(false);
                    }
                    wheelSuppressTimeout = null;
                }, 180);
                contentEl.scrollTop += e.deltaY;
            };
            card.addEventListener('wheel', handleWheel, { passive: false });
            contentEl.addEventListener('wheel', handleWheel, { passive: false });

            let draggingFromHeader = false;
            let dragStartMouseX = 0;
            let dragStartMouseY = 0;
            let dragStartRenderedX = 0;
            let dragStartRenderedY = 0;

            const onHeaderMouseMove = (e: MouseEvent) => {
                if (!draggingFromHeader || !this.cy) return;
                const dx = e.clientX - dragStartMouseX;
                const dy = e.clientY - dragStartMouseY;
                node.renderedPosition({
                    x: dragStartRenderedX + dx,
                    y: dragStartRenderedY + dy
                });
            };

            const onHeaderMouseUp = () => {
                if (!draggingFromHeader) return;
                draggingFromHeader = false;
                setCanvasInteractionSuppressed(false);
                document.removeEventListener('mousemove', onHeaderMouseMove);
                document.removeEventListener('mouseup', onHeaderMouseUp);
                // 保存拖动后的位置（取最新 data，增量更新可能已替换）
                const currentData = node.data();
                const pos = node.position();
                this.container?.dispatchEvent(new CustomEvent('node-position-changed', {
                    detail: {
                        node: currentData.originalNode,
                        nodeId: node.id(),
                        position: { x: pos.x, y: pos.y }
                    }
                }));
            };

            contentEl.addEventListener('mousedown', (e: MouseEvent) => {
                if (!this.cy) return;
                if (e.button !== 0) return;
                if (e.detail >= 2) return; // 双击交给编辑逻辑
                const target = e.target as HTMLElement | null;
                if (target?.closest('a, button, input, textarea, select, [contenteditable="true"], .cm-editor')) return;
                e.preventDefault();
                e.stopPropagation();
                if (!node.selected()) {
                    this.cy.$(':selected').unselect();
                    node.select();
                }
                draggingFromHeader = true;
                setCanvasInteractionSuppressed(true);
                dragStartMouseX = e.clientX;
                dragStartMouseY = e.clientY;
                const renderedPos = node.renderedPosition();
                dragStartRenderedX = renderedPos.x;
                dragStartRenderedY = renderedPos.y;
                const ctrl = new AbortController();
                this.activeOverlayDragAborters.add(ctrl);
                const finalize = () => {
                    this.activeOverlayDragAborters.delete(ctrl);
                    try { ctrl.abort(); } catch { /* ignore */ }
                };
                document.addEventListener('mousemove', onHeaderMouseMove, { signal: ctrl.signal });
                document.addEventListener('mouseup', () => { onHeaderMouseUp(); finalize(); }, { signal: ctrl.signal });
            });

            headerEl.addEventListener('dblclick', (e: MouseEvent) => {
                if (this.isReadOnlyMode()) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                this.showInlineNodeEditor(node);
            });

            card.addEventListener('mousedown', (e: MouseEvent) => {
                if (!this.cy) return;
                // 在预览卡片任意位置点击都可命中该节点
                const toggleSelection = e.metaKey || e.ctrlKey;
                if (toggleSelection) {
                    if (node.selected()) {
                        node.unselect();
                    } else {
                        node.select();
                    }
                } else if (!node.selected()) {
                    this.cy.$(':selected').unselect();
                    node.select();
                }
                e.stopPropagation();
            });

            // 右下角拖拽调整尺寸
            let resizing = false;
            let startX = 0;
            let startY = 0;
            let startW = 0;
            let startH = 0;

            const onMouseMove = (e: MouseEvent) => {
                if (!resizing) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                const newWidth = Math.max(220, startW + dx);
                const newHeight = Math.max(180, startH + dy);
                const zoom = this.cy?.zoom() ?? 1;
                cardSizeMap.set(nodeId, {
                    widthModel: newWidth / zoom,
                    heightModel: newHeight / zoom
                });
                card.style.width = `${newWidth}px`;
                card.style.height = `${newHeight}px`;
            };

            const onMouseUp = () => {
                if (!resizing) return;
                resizing = false;
                setCanvasInteractionSuppressed(false);
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                const modelSize = cardSizeMap.get(nodeId);
                if (modelSize) {
                    this.container?.dispatchEvent(new CustomEvent('embed-node-size-changed', {
                        detail: {
                            node: data.originalNode,
                            size: modelSize
                        }
                    }));
                }
            };

            resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
                if (!node.selected()) return;
                e.preventDefault();
                e.stopPropagation();
                resizing = true;
                setCanvasInteractionSuppressed(true);
                startX = e.clientX;
                startY = e.clientY;
                const size = cardSizeMap.get(nodeId);
                if (size) {
                    const zoom = this.cy?.zoom() ?? 1;
                    startW = size.widthModel * zoom;
                    startH = size.heightModel * zoom;
                } else {
                    const bb = node.renderedBoundingBox();
                    startW = Math.max(220, bb.w);
                    startH = Math.max(180, bb.h);
                }
                const ctrl = new AbortController();
                this.activeOverlayDragAborters.add(ctrl);
                const finalize = () => {
                    this.activeOverlayDragAborters.delete(ctrl);
                    try { ctrl.abort(); } catch { /* ignore */ }
                };
                document.addEventListener('mousemove', onMouseMove, { signal: ctrl.signal });
                document.addEventListener('mouseup', () => { onMouseUp(); finalize(); }, { signal: ctrl.signal });
            });

            const isMOCFile = isMocPath(sourceFile.path);
            const isExcalidraw = sourceFile.path.includes('.excalidraw');
            const hasExcalidrawCache = isExcalidrawFile && !!contentEl.querySelector('svg, img');

            if (isMOCFile) {
                contentEl.textContent = '';
                contentEl.style.position = 'relative';
                contentEl.style.overflow = 'hidden';
                contentEl.style.padding = '0';
                contentEl.style.background = 'transparent';
                contentEl.style.cursor = 'default';

                (async () => {
                    let previewFile: any = null;

                    // 优先：直接读取已存在的预览 PNG 文件（附件路径）
                    const candidates = this.getMocPreviewPngCandidates(sourceFile.path);
                    for (const candidate of candidates) {
                        const f = app.vault.getAbstractFileByPath(candidate);
                        if (f) {
                            previewFile = f;
                            break;
                        }
                    }

                    // 回退：附件不存在时，再调用注入的 .moc 预览 API（与 markdown embed 共用）
                    if (!previewFile) {
                        try {
                            const exporter = this.currentOptions?.mocPreviewExporter;
                            if (exporter) {
                                previewFile = await exporter(sourceFile as any);
                            }
                        } catch (error) {
                            console.error('[CytoscapeRenderer] mocPreviewExporter failed:', error);
                        }
                    }

                    if (previewFile) {
                        const img = document.createElement('img');
                        img.src = app.vault.getResourcePath(previewFile);
                        img.draggable = false;
                        img.style.cssText = `
                            position: absolute;
                            inset: 0;
                            width: 100%;
                            height: 100%;
                            object-fit: contain;
                            display: block;
                            background: transparent;
                        `;
                        if (!contentEl.isConnected) return;
                        contentEl.textContent = '';
                        contentEl.appendChild(wrapForImageToolkit(img));
                        return;
                    }

                    if (!contentEl.isConnected) return;
                    contentEl.style.cssText += 'display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px;';
                    contentEl.innerHTML = `
                        <div style="font-size: 12px; color: var(--text-muted); text-align: center;">
                            未找到 MOC 预览 PNG（attachments/${sourceFile.name}.png）
                        </div>
                    `;
                })();

            } else if (isExcalidraw && !hasExcalidrawCache) {
                contentEl.textContent = '';
                (async () => {
                    let rendered = false;

                    // 方式 1：Excalidraw 插件 API — 直接生成 SVG
                    if (!rendered) {
                        try {
                            const excalidrawPlugin = (app as any).plugins?.plugins?.['obsidian-excalidraw-plugin'];
                            if (excalidrawPlugin) {
                                let svg: any = null;
                                // 带 block ref 的链接（如 "file.excalidraw.md#^groupId"）优先传给 Excalidraw，
                                // 让插件自己按 block ref 过滤只渲染对应 group
                                const rawLink = (originalNode?.wikiLink || '').trim();
                                const hasBlockRef = /#\^[^|\]]+$/.test(rawLink) || /#[^|\]]+$/.test(rawLink);
                                const preferredPath = hasBlockRef ? rawLink : sourceFile.path;
                                // 尝试 ExcalidrawAutomate API
                                const ea = excalidrawPlugin.ea;
                                if (ea && typeof ea.createSVG === 'function') {
                                    try {
                                        svg = await ea.createSVG(preferredPath);
                                    } catch { /* 带 block ref 的路径可能不被支持，回退 */ }
                                    if (!svg && hasBlockRef) {
                                        svg = await ea.createSVG(sourceFile.path);
                                    }
                                }
                                // 回退：尝试 plugin 级别的 createSVG
                                if (!svg && typeof excalidrawPlugin.createSVG === 'function') {
                                    try {
                                        svg = await excalidrawPlugin.createSVG(preferredPath);
                                    } catch { /* 同上 */ }
                                    if (!svg && hasBlockRef) {
                                        svg = await excalidrawPlugin.createSVG(sourceFile.path);
                                    }
                                }
                                if (typeof svg === 'string') {
                                    const wrapped = document.createElement('div');
                                    wrapped.innerHTML = svg;
                                    svg = wrapped.querySelector('svg');
                                }
                                if (svg instanceof SVGElement || svg instanceof HTMLElement) {
                                    svg.removeAttribute('width');
                                    svg.removeAttribute('height');
                                    // 序列化成 data URI 通过 <img> 装载，让 Image Toolkit 能识别并支持放大
                                    const svgString = new XMLSerializer().serializeToString(svg);
                                    const encoded = encodeURIComponent(svgString)
                                        .replace(/'/g, '%27')
                                        .replace(/"/g, '%22');
                                    const img = document.createElement('img');
                                    img.src = `data:image/svg+xml;charset=utf-8,${encoded}`;
                                    img.draggable = false;
                                    img.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; background: transparent;';
                                    contentEl.style.position = 'relative';
                                    contentEl.style.overflow = 'hidden';
                                    contentEl.appendChild(wrapForImageToolkit(img));
                                    rendered = true;
                                }
                            }
                        } catch { /* Excalidraw API 不可用 */ }
                    }

                    // 方式 2：查找自动导出的 SVG/PNG
                    if (!rendered) {
                        const baseName = sourceFile.path.replace(/\.excalidraw(\.md)?$/i, '');
                        const dir = sourceFile.path.includes('/') ? sourceFile.path.substring(0, sourceFile.path.lastIndexOf('/')) + '/' : '';
                        const stemOnly = baseName.includes('/') ? baseName.substring(baseName.lastIndexOf('/') + 1) : baseName;
                        const candidates = [
                            `${baseName}.svg`, `${baseName}.png`,
                            `${dir}${stemOnly}.svg`, `${dir}${stemOnly}.png`,
                            sourceFile.path.replace(/\.md$/i, '.svg'),
                            sourceFile.path.replace(/\.md$/i, '.png'),
                        ];
                        const seen = new Set<string>();
                        let exportedFile: any = null;
                        for (const p of candidates) {
                            if (seen.has(p)) continue;
                            seen.add(p);
                            const f = app.vault.getAbstractFileByPath(p);
                            if (f) { exportedFile = f; break; }
                        }
                        if (exportedFile) {
                            const img = document.createElement('img');
                            img.src = app.vault.getResourcePath(exportedFile);
                            img.draggable = false;
                            img.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; background: transparent;';
                            contentEl.style.position = 'relative';
                            contentEl.style.overflow = 'hidden';
                            contentEl.textContent = '';
                            contentEl.appendChild(wrapForImageToolkit(img));
                            rendered = true;
                        }
                    }

                    // 方式 3 跳过：MarkdownRenderer 对 excalidraw 只会渲染原始警告文本，无意义

                    // 方式 4：兜底显示文件名
                    if (!rendered) {
                        contentEl.style.cssText += 'display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 13px;';
                        contentEl.textContent = `Excalidraw 预览不可用：${sourceFile.basename || sourceFile.path}`;
                    }
                })();
            } else if (!isExcalidraw) {
                // 普通 Markdown 文件
                app.vault.cachedRead(sourceFile).then(async (markdown: string) => {
                    if (!contentEl.isConnected) return;

                    // 控制渲染量，避免超长笔记影响图形交互
                    const snippet = markdown.length > 3000 ? `${markdown.slice(0, 3000)}\n\n...` : markdown;
                    contentEl.empty?.();
                    contentEl.textContent = '';
                    await MarkdownRenderer.render(app, snippet, contentEl, sourceFile.path, rendererComponent);
                    contentEl.querySelectorAll('h1,h2,h3,h4').forEach((el: any) => {
                        el.style.marginTop = '0.4em';
                        el.style.marginBottom = '0.35em';
                        el.style.lineHeight = '1.35';
                    });
                    contentEl.querySelectorAll('p,li').forEach((el: any) => {
                        el.style.marginTop = '0.28em';
                        el.style.marginBottom = '0.28em';
                    });
                }).catch(() => {
                    contentEl.textContent = sourceFile.basename || '';
                });
            }

            // 缓存上一次同步到 Cytoscape 的尺寸，避免每帧都触发样式重算
            let lastSyncedW = -1;
            let lastSyncedH = -1;
            let lastZoom = -1;
            // 缓存节点 outer 尺寸（模型坐标，仅在节点 style 尺寸变化时失效）
            let cachedOuterW = 0;
            let cachedOuterH = 0;
            let outerSizeStale = true;

            const updatePosition = () => {
                if (!this.cy) return;
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) {
                    card.style.display = 'none';
                    embedToggleEl.style.display = 'none';
                    return;
                }
                card.style.display = '';
                embedToggleEl.style.display = '';
                const zoom = this.cy.zoom();
                const size = cardSizeMap.get(nodeId);
                const widthModel = size ? size.widthModel : 280;
                const heightModel = size ? size.heightModel : 220;
                const width = widthModel * zoom;
                const height = heightModel * zoom;

                // 仅在尺寸变化时同步 Cytoscape 节点尺寸，避免每帧触发样式重算
                if (widthModel !== lastSyncedW || heightModel !== lastSyncedH) {
                    node.style({ 'width': widthModel, 'height': heightModel });
                    lastSyncedW = widthModel;
                    lastSyncedH = heightModel;
                    outerSizeStale = true;
                }

                // 用 renderedPosition + 缓存 outer 尺寸替代昂贵的 renderedBoundingBox（50+ 节点时每帧省数百次遍历）
                if (outerSizeStale) {
                    cachedOuterW = node.outerWidth();
                    cachedOuterH = node.outerHeight();
                    outerSizeStale = false;
                }
                const rp = node.renderedPosition();
                const bbX1 = rp.x - (cachedOuterW * zoom) / 2;
                const bbY1 = rp.y - (cachedOuterH * zoom) / 2;
                card.style.transform = `translate(${bbX1}px, ${bbY1}px)`;
                card.style.width = `${width}px`;
                card.style.height = `${height}px`;

                // zoom 未变化时跳过子元素样式更新（纯 pan 只需更新 transform）
                if (zoom !== lastZoom) {
                    lastZoom = zoom;
                    card.style.borderRadius = `${Math.max(6, 8 * zoom)}px`;
                    const toggleSize = Math.max(20, 24 * zoom);
                    embedToggleEl.style.width = `${toggleSize}px`;
                    embedToggleEl.style.height = `${toggleSize}px`;

                    const headerH = Math.max(24, 36 * zoom);
                    headerEl.style.height = `${headerH}px`;
                    headerEl.style.fontSize = `${Math.max(9, 12 * zoom)}px`;
                    headerEl.style.padding = `0 ${Math.max(8, 12 * zoom)}px`;

                    contentEl.style.height = `calc(100% - ${headerH}px)`;
                    contentEl.style.fontSize = `${Math.max(10, 14 * zoom)}px`;
                    const isExcalidrawContent = contentEl.style.position === 'relative' && contentEl.querySelector('svg, img');
                    if (isExcalidrawContent) {
                        contentEl.style.padding = '0';
                        contentEl.style.overflow = 'hidden';
                    } else {
                        contentEl.style.padding = `${Math.max(6, 12 * zoom)}px ${Math.max(8, 14 * zoom)}px`;
                    }

                    resizeHandle.style.width = `${Math.max(12, 18 * zoom)}px`;
                    resizeHandle.style.height = `${Math.max(12, 18 * zoom)}px`;
                    resizeHandle.style.fontSize = `${Math.max(8, 11 * zoom)}px`;
                }

                const toggleSize = Math.max(20, 24 * zoom);
                embedToggleEl.style.transform = `translate(${bbX1 + (width - toggleSize) / 2}px, ${bbY1 + height + 8 * zoom}px)`;
            };

            updaters.push(updatePosition);
            updatePosition();
        });

        // 缓存已使用，清空
        this.embedCardCache.clear();

        // 注册到统一 overlay 调度器
        const embedPositionUpdater = () => updaters.forEach(fn => fn());
        const embedSelectionUpdater = () => interactionUpdaters.forEach(fn => fn());
        this.overlayUpdaters.add(embedPositionUpdater);
        this.overlaySelectionUpdaters.add(embedSelectionUpdater);

        this.embedPreviewCleanup = () => {
            this.overlayUpdaters.delete(embedPositionUpdater);
            this.overlaySelectionUpdaters.delete(embedSelectionUpdater);
            if (this.cy) {
                this.cy.userZoomingEnabled(true);
                this.cy.userPanningEnabled(true);
            }
            this.embedRendererComponents.delete(rendererComponent);
            rendererComponent.unload();
            previewContainer.remove();
        };
    }
    /**
     * 为图片文件节点添加图片预览
     * 检测 [[]] 中引用的文件是否为图片格式，如果是则渲染图片
     */
    private addImageNodePreviews(): void {
        if (!this.cy || !this.container) return;

        const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
        const app = (window as any).app;
        if (!app) return;

        if (this.imagePreviewCleanup) {
            this.imagePreviewCleanup();
            this.imagePreviewCleanup = null;
        }

        // 查找所有 ![[]] 嵌入节点且文件路径为图片格式的节点
        // [[image.png]] 普通文件节点不渲染图片，保持为普通可点击节点
        const imageNodes = this.cy.nodes('[?isEmbed]').filter((node: any) => {
            const filePath = node.data('filePath');
            if (!filePath) return false;
            const ext = filePath.split('.').pop()?.toLowerCase() || '';
            return IMAGE_EXTENSIONS.has(ext);
        });

        if (imageNodes.length === 0) return;

        const previewContainer = document.createElement('div');
        previewContainer.className = 'zk-image-previews';
        previewContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 2;
        `;
        this.container.appendChild(previewContainer);

        const updaters: Array<() => void> = [];
        const interactionUpdaters: Array<() => void> = [];
        // 以模型坐标存储卡片尺寸，缩放时按 zoom 换算为像素
        const cardSizeMap = new Map<string, { widthModel: number; heightModel: number }>();
        const embedNodeSizes = ((this.currentData?.metadata as any)?.embedNodeSizes || {}) as Record<string, { width: number; height: number }>;
        let suppressedCanvasInteractionCount = 0;
        const setCanvasInteractionSuppressed = (suppressed: boolean) => {
            if (!this.cy) return;
            if (suppressed) {
                suppressedCanvasInteractionCount += 1;
                if (suppressedCanvasInteractionCount === 1) {
                    this.cy.userZoomingEnabled(false);
                    this.cy.userPanningEnabled(false);
                }
                return;
            }
            suppressedCanvasInteractionCount = Math.max(0, suppressedCanvasInteractionCount - 1);
            if (suppressedCanvasInteractionCount === 0) {
                this.cy.userZoomingEnabled(true);
                this.cy.userPanningEnabled(true);
            }
        };

        imageNodes.forEach((node: any) => {
            const data = node.data();
            const originalNode = data.originalNode as any;
            const filePath = data.filePath;
            const file = app.vault.getAbstractFileByPath(filePath);
            if (!file) return;

            const resourcePath = app.vault.getResourcePath(file);
            const nodeId = node.id();

            // 恢复持久化的尺寸
            const nodeIdKey = originalNode?.ID || originalNode?.IDStr || nodeId;
            const persistedSize = embedNodeSizes[nodeIdKey] || embedNodeSizes[originalNode?.IDStr];
            if (persistedSize && persistedSize.width > 0 && persistedSize.height > 0) {
                cardSizeMap.set(nodeId, {
                    widthModel: persistedSize.width,
                    heightModel: persistedSize.height
                });
            }

            const theme = this.getPreviewCardTheme(data);
            const resolvedCardBorder = 'none';

            // 完全隐藏 Cytoscape 节点（由 HTML 图片卡片处理视觉）
            node.data('isImageNode', true);
            node.style({
                'label': '',
                'background-opacity': 0,
                'border-width': 0,
                'width': 1,
                'height': 1,
                'overlay-opacity': 0,
                'padding': 0
            });

            // 创建卡片容器
            const card = document.createElement('div');
            card.className = 'zk-image-preview-card';
            card.style.cssText = `
                position: absolute;
                left: 0;
                top: 0;
                background: ${theme.cardBackground};
                border: ${resolvedCardBorder};
                border-radius: 8px;
                overflow: hidden;
                pointer-events: auto;
                box-shadow: ${theme.cardShadow};
                transition: border-color 0.15s ease;
                will-change: transform;
            `;
            card.dataset.nodeId = nodeId;

            // 标题栏（文件名 + 点击跳转）
            const headerEl = document.createElement('div');
            headerEl.dataset.role = 'image-header';
            headerEl.style.cssText = `
                height: 32px;
                padding: 0 12px;
                display: flex;
                align-items: center;
                gap: 6px;
                background: ${theme.headerBackground};
                color: var(--text-muted);
                font-size: 12px;
                font-weight: 500;
                letter-spacing: 0.2px;
                white-space: nowrap;
                overflow: hidden;
                user-select: none;
            `;


            const headerLink = document.createElement('span');
            headerLink.textContent = (file as any).basename || filePath.split('/').pop() || '';
            this.applyPreviewHeaderLinkStyle(headerLink);
            headerLink.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const existingLeaf = app.workspace.getLeavesOfType('markdown')
                    .find((leaf: any) => leaf.view?.file?.path === filePath);
                if (existingLeaf) {
                    app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                } else {
                    app.workspace.openLinkText(filePath, '', e.ctrlKey || e.metaKey);
                }
            });
            headerEl.appendChild(headerLink);
            card.appendChild(headerEl);

            // 鼠标悬浮图片卡片时显示连线手柄并更新位置（缓存 handle 引用，避免每次 querySelector）
            let cachedImageHandle: HTMLElement | null = null;
            const resolveImageHandle = (): HTMLElement | null => {
                if (!cachedImageHandle) {
                    cachedImageHandle = this.container?.querySelector(`.zk-connection-handle[data-image-node-id="${nodeId}"]`) as HTMLElement | null;
                }
                return cachedImageHandle;
            };
            card.addEventListener('mouseenter', () => {
                const handle = resolveImageHandle();
                if (!handle || !this.cy) return;
                const rp = node.renderedPosition();
                const w = parseFloat(card.dataset.renderedWidth || '0');
                handle.style.transform = `translate(${rp.x + w / 2}px, ${rp.y}px) translate(-50%, -50%)`;
                handle.style.opacity = '1';
            });
            card.addEventListener('mouseleave', (e: MouseEvent) => {
                const handle = resolveImageHandle();
                if (!handle) return;
                if (e.relatedTarget === handle || handle.contains(e.relatedTarget as Node)) return;
                handle.style.opacity = '0';
            });

            // 图片内容区
            const img = document.createElement('img');
            img.src = resourcePath;
            img.draggable = false;
            img.style.cssText = `
                width: 100%;
                height: calc(100% - 32px);
                object-fit: contain;
                display: block;
                background: var(--background-secondary);
            `;
            card.appendChild(wrapForImageToolkit(img));

            // 图片加载后根据自然尺寸设置默认大小
            img.addEventListener('load', () => {
                if (!cardSizeMap.has(nodeId) && img.naturalWidth > 0 && img.naturalHeight > 0) {
                    const maxW = 360;
                    const maxH = 400;
                    const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
                    const w = img.naturalWidth * ratio;
                    const h = img.naturalHeight * ratio;
                    cardSizeMap.set(nodeId, { widthModel: w, heightModel: h });
                    const zoom = this.cy?.zoom() ?? 1;
                    card.style.width = `${w * zoom}px`;
                    card.style.height = `${h * zoom}px`;
                }
            });

            // 右下角 resize 手柄（仅选中时可见）
            const resizeHandle = document.createElement('div');
            resizeHandle.style.cssText = `
                position: absolute;
                right: 0;
                bottom: 0;
                width: 18px;
                height: 18px;
                background: rgba(91, 143, 217, 0.9);
                border-top-left-radius: 6px;
                cursor: nwse-resize;
                pointer-events: none;
                opacity: 0;
                color: rgba(255, 255, 255, 0.95);
                font-size: 11px;
                font-weight: 700;
                display: flex;
                align-items: flex-end;
                justify-content: flex-end;
                line-height: 1;
                padding-right: 2px;
                transition: opacity 0.15s ease;
            `;
            resizeHandle.textContent = '\u25E2';

            card.appendChild(resizeHandle);
            previewContainer.appendChild(card);

            // 选中时显示高亮边框和 resize 手柄，允许拖拽
            const updateInteraction = () => {
                const isSelected = node.selected();
                resizeHandle.style.pointerEvents = isSelected ? 'auto' : 'none';
                resizeHandle.style.opacity = isSelected ? '1' : '0';
                card.style.borderColor = 'transparent';
                card.style.cursor = 'default';
                img.style.cursor = isSelected ? 'move' : 'default';
            };
            interactionUpdaters.push(updateInteraction);
            updateInteraction();

            // 选中状态下整个卡片可拖拽
            let draggingCard = false;
            let dragStartMouseX = 0;
            let dragStartMouseY = 0;
            let dragStartRenderedX = 0;
            let dragStartRenderedY = 0;

            const onCardMouseMove = (e: MouseEvent) => {
                if (!draggingCard || !this.cy) return;
                const dx = e.clientX - dragStartMouseX;
                const dy = e.clientY - dragStartMouseY;
                node.renderedPosition({
                    x: dragStartRenderedX + dx,
                    y: dragStartRenderedY + dy
                });
            };

            const onCardMouseUp = () => {
                if (!draggingCard) return;
                draggingCard = false;
                setCanvasInteractionSuppressed(false);
                document.removeEventListener('mousemove', onCardMouseMove);
                document.removeEventListener('mouseup', onCardMouseUp);
                // 取最新 data，增量更新可能已替换闭包中的旧引用
                const currentData = node.data();
                const pos = node.position();
                this.container?.dispatchEvent(new CustomEvent('node-position-changed', {
                    detail: {
                        node: currentData.originalNode,
                        nodeId: node.id(),
                        position: { x: pos.x, y: pos.y }
                    }
                }));
            };

            // 点击卡片：选中节点；图片内容区拖拽移动
            card.addEventListener('mousedown', (e: MouseEvent) => {
                if (!this.cy) return;
                if (e.button !== 0) return;

                const toggleSelection = e.metaKey || e.ctrlKey;
                if (toggleSelection) {
                    if (node.selected()) { node.unselect(); } else { node.select(); }
                    e.stopPropagation();
                    return;
                }

                if (!node.selected()) {
                    // 未选中 → 选中
                    this.cy.$(':selected').unselect();
                    node.select();
                }
                e.stopPropagation();
            });

            img.addEventListener('mousedown', (e: MouseEvent) => {
                if (!this.cy) return;
                if (e.button !== 0) return;
                if (e.detail >= 2) return;
                e.preventDefault();
                e.stopPropagation();
                if (!node.selected()) {
                    this.cy.$(':selected').unselect();
                    node.select();
                }
                draggingCard = true;
                setCanvasInteractionSuppressed(true);
                dragStartMouseX = e.clientX;
                dragStartMouseY = e.clientY;
                const renderedPos = node.renderedPosition();
                dragStartRenderedX = renderedPos.x;
                dragStartRenderedY = renderedPos.y;
                const ctrl = new AbortController();
                this.activeOverlayDragAborters.add(ctrl);
                const finalize = () => {
                    this.activeOverlayDragAborters.delete(ctrl);
                    try { ctrl.abort(); } catch { /* ignore */ }
                };
                document.addEventListener('mousemove', onCardMouseMove, { signal: ctrl.signal });
                document.addEventListener('mouseup', () => { onCardMouseUp(); finalize(); }, { signal: ctrl.signal });
            });

            // 右下角拖拽调整尺寸
            let resizing = false;
            let startX = 0;
            let startY = 0;
            let startW = 0;
            let startH = 0;

            const onMouseMove = (e: MouseEvent) => {
                if (!resizing) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                const newWidth = Math.max(120, startW + dx);
                const newHeight = Math.max(100, startH + dy);
                const zoom = this.cy?.zoom() ?? 1;
                cardSizeMap.set(nodeId, {
                    widthModel: newWidth / zoom,
                    heightModel: newHeight / zoom
                });
                card.style.width = `${newWidth}px`;
                card.style.height = `${newHeight}px`;
            };

            const onMouseUp = () => {
                if (!resizing) return;
                resizing = false;
                setCanvasInteractionSuppressed(false);
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                const modelSize = cardSizeMap.get(nodeId);
                if (modelSize) {
                    this.container?.dispatchEvent(new CustomEvent('embed-node-size-changed', {
                        detail: {
                            node: data.originalNode,
                            size: modelSize
                        }
                    }));
                }
            };

            resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
                if (!node.selected()) return;
                e.preventDefault();
                e.stopPropagation();
                resizing = true;
                setCanvasInteractionSuppressed(true);
                startX = e.clientX;
                startY = e.clientY;
                const size = cardSizeMap.get(nodeId);
                if (size) {
                    const zoom = this.cy?.zoom() ?? 1;
                    startW = size.widthModel * zoom;
                    startH = size.heightModel * zoom;
                } else {
                    startW = 240;
                    startH = 200;
                }
                const ctrl = new AbortController();
                this.activeOverlayDragAborters.add(ctrl);
                const finalize = () => {
                    this.activeOverlayDragAborters.delete(ctrl);
                    try { ctrl.abort(); } catch { /* ignore */ }
                };
                document.addEventListener('mousemove', onMouseMove, { signal: ctrl.signal });
                document.addEventListener('mouseup', () => { onMouseUp(); finalize(); }, { signal: ctrl.signal });
            });

            // 缓存上一次同步到 Cytoscape 的尺寸，避免每帧都触发样式重算
            let lastSyncedW = -1;
            let lastSyncedH = -1;
            let lastZoom = -1;

            const updatePosition = () => {
                if (!this.cy) return;
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) {
                    card.style.display = 'none';
                    return;
                }
                card.style.display = '';
                const zoom = this.cy.zoom();
                const rp = node.renderedPosition();
                const size = cardSizeMap.get(nodeId);
                const widthModel = size ? size.widthModel : 240;
                const heightModel = size ? size.heightModel : 200;
                const width = widthModel * zoom;
                const height = heightModel * zoom;

                // 仅在尺寸变化时同步 Cytoscape 节点尺寸，避免每帧触发样式重算
                if (widthModel !== lastSyncedW || heightModel !== lastSyncedH) {
                    node.style({ 'width': widthModel, 'height': heightModel });
                    lastSyncedW = widthModel;
                    lastSyncedH = heightModel;
                }

                card.style.transform = `translate(${rp.x - width / 2}px, ${rp.y - height / 2}px)`;
                card.style.width = `${width}px`;
                card.style.height = `${height}px`;
                card.dataset.renderedWidth = `${width}`;
                card.dataset.renderedHeight = `${height}`;

                // zoom 未变化时跳过子元素样式更新（纯 pan 只需更新 transform）
                if (zoom !== lastZoom) {
                    lastZoom = zoom;
                    card.style.borderRadius = `${Math.max(6, 8 * zoom)}px`;
                    const headerH = Math.max(24, 32 * zoom);
                    headerEl.style.height = `${headerH}px`;
                    headerEl.style.fontSize = `${Math.max(9, 12 * zoom)}px`;
                    headerEl.style.padding = `0 ${Math.max(8, 12 * zoom)}px`;
                    img.style.height = `calc(100% - ${headerH}px)`;
                }
            };

            updaters.push(updatePosition);
            updatePosition();
        });

        // 注册到统一 overlay 调度器
        const imagePositionUpdater = () => updaters.forEach(fn => fn());
        const imageSelectionUpdater = () => interactionUpdaters.forEach(fn => fn());
        this.overlayUpdaters.add(imagePositionUpdater);
        this.overlaySelectionUpdaters.add(imageSelectionUpdater);

        this.imagePreviewCleanup = () => {
            this.overlayUpdaters.delete(imagePositionUpdater);
            this.overlaySelectionUpdaters.delete(imageSelectionUpdater);
            if (this.cy) {
                this.cy.userZoomingEnabled(true);
                this.cy.userPanningEnabled(true);
            }
            previewContainer.remove();
        };
    }

        /**
     * 获取布局配置
     */
    private getLayout(options: RenderOptions): any {
     const layoutType = options.layoutType || 'dagre';  // 改为 dagre 默认
    const animate = options.animate !== false;
    const animationDuration = options.animationDuration || 500;

    const baseLayout = {
        animate: animate,
        animationDuration: animationDuration,
        fit: true,
        padding: 80
    };

        switch (layoutType) {
            case 'breadthfirst':
                return {
                    name: 'breadthfirst',
                    ...baseLayout,
                    directed: true,
                    spacingFactor: 1.5,
                    avoidOverlap: true,
                    nodeDimensionsIncludeLabels: true
                };
case 'dagre':
    return {
        name: 'dagre',
        ...baseLayout,
        rankDir: 'LR',
        nodeSep: 150,        // 同层节点间距（水平）
        edgeSep: 50,         // 边的间距
        rankSep: 200,        // 层级间距（垂直）
        ranker: 'network-simplex',
        nodeDimensionsIncludeLabels: true  // 考虑标签尺寸
    };
            case 'cose':
                return {
                    name: 'cose-bilkent',
                    ...baseLayout,
                    nodeRepulsion: 4500,
                    idealEdgeLength: 100,
                    edgeElasticity: 0.45,
                    nestingFactor: 0.1,
                    gravity: 0.25,
                    numIter: 2500,
                    tile: true,
                    tilingPaddingVertical: 10,
                    tilingPaddingHorizontal: 10,
                    gravityRangeCompound: 1.5,
                    gravityCompound: 1.0,
                    gravityRange: 3.8
                };

            case 'grid':
                return {
                    name: 'grid',
                    ...baseLayout,
                    rows: undefined,
                    cols: undefined,
                    avoidOverlap: true,
                    avoidOverlapPadding: 10,
                    nodeDimensionsIncludeLabels: true
                };

            default:
                return {
                    name: 'breadthfirst',
                    ...baseLayout
                };
        }
    }

    /**
     * 添加节点徽章（HTML 叠加层）
     */
    private addNodeBadges(): void {
        if (!this.cy || !this.container) return;

        // 清理旧的统一 overlay 调度器（badge 重建时所有子系统也会重建）
        this.cleanupOverlayScheduler();
        this.cleanupBadgeInteractionBindings();

        // 先从旧 badgeContainer 中摘下缓存的 MD overlay（保持 DOM 节点存活，便于下面复用）
        this.textMdOverlayCache.forEach(entry => {
            entry.usedInCycle = false;
            // 防御性清理：清除可能遗留的编辑标记和隐藏样式，避免下次复用时继续不显示
            delete entry.el.dataset.editing;
            entry.el.style.display = 'block';
            if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
        });

        // 移除旧的徽章容器
        const oldBadgeContainer = this.container.querySelector('.zk-node-badges');
        if (oldBadgeContainer) {
            oldBadgeContainer.remove();
        }

        // 移除旧的分组 glass 层
        const oldGlassLayer = this.container.querySelector('.zk-group-glass-layer');
        if (oldGlassLayer) {
            oldGlassLayer.remove();
        }

        // 创建分组 glass 层（插到最前，位于 canvas 下方）
        const isLightTheme = document.body.classList.contains('theme-light');
        const glassLayer = document.createElement('div');
        glassLayer.className = 'zk-group-glass-layer';
        glassLayer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
            overflow: hidden;
        `;
        this.container.insertBefore(glassLayer, this.container.firstChild);

        // 创建徽章容器
        const badgeContainer = document.createElement('div');
        badgeContainer.className = 'zk-node-badges';
        badgeContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 3;
        `;
        this.container.appendChild(badgeContainer);

        // 存储所有徽章的更新函数
        const badgeUpdaters: Array<() => void> = [];
        const readOnly = this.isReadOnlyMode();
        const underlineMeasure = document.createElement('canvas');
        const underlineMeasureCtx = underlineMeasure.getContext('2d');

        // 分组 glass overlay
        this.cy.nodes('.group-node').forEach((groupNode: any) => {
            const glassEl = document.createElement('div');
            glassEl.className = 'zk-group-glass';
            glassEl.style.position = 'absolute';
            glassEl.style.left = '0';
            glassEl.style.top = '0';
            glassEl.style.borderRadius = '12px';
            glassEl.style.border = isLightTheme
                ? '1.5px solid rgba(180, 195, 220, 0.7)'
                : '1.5px solid rgba(255, 255, 255, 0.13)';
            glassEl.style.background = isLightTheme
                ? 'rgba(255, 255, 255, 0.35)'
                : 'rgba(255, 255, 255, 0.05)';
            (glassEl.style as any).backdropFilter = 'blur(12px)';
            (glassEl.style as any).webkitBackdropFilter = 'blur(12px)';
            glassEl.style.boxShadow = isLightTheme
                ? '0 2px 16px rgba(0,0,0,0.06)'
                : '0 2px 16px rgba(0,0,0,0.25)';
            glassLayer.appendChild(glassEl);

            // 标签下方的遮罩层：用于“切断”被标签覆盖区域的上边框，降低视觉噪声
            const labelMaskEl = document.createElement('div');
            labelMaskEl.className = 'zk-group-glass-label-mask';
            labelMaskEl.style.position = 'absolute';
            labelMaskEl.style.top = '0';
            labelMaskEl.style.left = '0';
            labelMaskEl.style.transform = 'translate(0, -50%)';
            labelMaskEl.style.borderRadius = '999px';
            labelMaskEl.style.pointerEvents = 'none';
            labelMaskEl.style.zIndex = '1';
            const containerBg = this.container ? getComputedStyle(this.container).backgroundColor : '';
            labelMaskEl.style.background = containerBg || (isLightTheme ? '#f5f5f5' : '#2a2a2a');
            glassEl.appendChild(labelMaskEl);

            const labelEl = document.createElement('div');
            labelEl.className = 'zk-group-glass-label';
            labelEl.textContent = groupNode.data('label') || '';
            labelEl.style.position = 'absolute';
            labelEl.style.fontWeight = '600';
            labelEl.style.color = isLightTheme ? '#5b6578' : 'rgba(235, 241, 255, 0.78)';
            labelEl.style.pointerEvents = 'none';
            labelEl.style.userSelect = 'none';
            labelEl.style.whiteSpace = 'nowrap';
            labelEl.style.left = '0';
            labelEl.style.top = '0';
            labelEl.style.transform = 'translate(0, -50%)';
            labelEl.style.display = 'inline-flex';
            labelEl.style.alignItems = 'center';
            labelEl.style.justifyContent = 'center';
            labelEl.style.border = isLightTheme
                ? '1px solid rgba(168, 184, 214, 0.72)'
                : '1px solid rgba(206, 220, 245, 0.42)';
            // 通过弱化底边制造“标签压在边框上”的半镶嵌感
            labelEl.style.borderBottomColor = isLightTheme
                ? 'rgba(168, 184, 214, 0.15)'
                : 'rgba(206, 220, 245, 0.12)';
            labelEl.style.borderRadius = '999px';
            labelEl.style.background = isLightTheme
                ? 'rgba(255, 255, 255, 0.56)'
                : 'rgba(14, 24, 40, 0.58)';
            (labelEl.style as any).backdropFilter = 'blur(8px)';
            (labelEl.style as any).webkitBackdropFilter = 'blur(8px)';
            labelEl.style.boxShadow = isLightTheme
                ? '0 1px 6px rgba(50, 70, 100, 0.14)'
                : '0 1px 8px rgba(0, 0, 0, 0.35)';
            labelEl.style.zIndex = '2';
            glassEl.appendChild(labelEl);

            const updateGlassPos = () => {
                if (!this.cy || groupNode.removed()) {
                    glassEl.style.display = 'none';
                    return;
                }
                const bb = groupNode.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
                if (!bb || bb.w <= 0 || bb.h <= 0) {
                    glassEl.style.display = 'none';
                    return;
                }
                glassEl.style.display = 'block';
                glassEl.style.transform = `translate(${bb.x1}px, ${bb.y1}px)`;
                glassEl.style.width = `${bb.w}px`;
                glassEl.style.height = `${bb.h}px`;

                // 边界标签化：标签压在容器上边框，内部空间不占用
                const zoom = this.cy.zoom();
                labelEl.style.left = `${Math.max(10, 14 * zoom)}px`;
                labelEl.style.fontSize = `${Math.max(11, 13 * zoom)}px`;
                labelEl.style.padding = `${Math.max(2, 3 * zoom)}px ${Math.max(10, 14 * zoom)}px`;
                labelEl.textContent = groupNode.data('label') || '';

                // 遮罩尺寸略大于标签，确保边框不会穿透到文字和标签底色
                const labelW = labelEl.offsetWidth || 0;
                const labelH = labelEl.offsetHeight || 0;
                const maskPadX = Math.max(4, 6 * zoom);
                const maskPadY = Math.max(1, 2 * zoom);
                labelMaskEl.style.left = `${Math.max(10, 14 * zoom) - maskPadX / 2}px`;
                labelMaskEl.style.width = `${labelW + maskPadX}px`;
                labelMaskEl.style.height = `${Math.max(4, labelH + maskPadY)}px`;
            };

            badgeUpdaters.push(updateGlassPos);
            updateGlassPos();
        });

        const IMAGE_EXTS_BADGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
        this.cy.nodes('[?hasFileIcon]').forEach((node: any) => {
            // 跳过所有 embed 节点（由预览卡片渲染标题和内容）
            if (node.data('isEmbed')) return;
            const underlineGroupEl = document.createElement('div');
            underlineGroupEl.className = 'zk-node-file-underline-group';
            underlineGroupEl.style.cssText = `
                position: absolute;
                pointer-events: none;
            `;
            badgeContainer.appendChild(underlineGroupEl);

            // 缓存：label 不变时复用 wrappedLines 和 modelLineWidths，避免每帧 measureText
            let cachedLabel = '';
            let cachedWrappedLines: string[] = [];
            let cachedModelLineWidths: number[] = []; // 模型坐标系下的宽度（不含 zoom）
            let cachedIsRoot = false;
            // DOM 元素池：创建一次，后续只更新位置
            let lineElements: Array<{ hitEl: HTMLElement; underlineEl: HTMLElement }> = [];

            const rebuildWrappedLinesCache = (label: string, isRoot: boolean) => {
                cachedLabel = label;
                cachedIsRoot = isRoot;
                const fontPx = isRoot ? 26 : 20;
                const fontWeight = isRoot ? '700' : '500';
                const textMaxWidth = isRoot ? 400 : 280;

                if (underlineMeasureCtx) {
                    underlineMeasureCtx.font = `${fontWeight} ${fontPx}px sans-serif`;
                    cachedWrappedLines = [];
                    const explicitLines = label.split('\n');
                    for (const explicitLine of explicitLines) {
                        if (!explicitLine) {
                            cachedWrappedLines.push(' ');
                            continue;
                        }
                        let currentLine = '';
                        for (const char of explicitLine) {
                            const testLine = currentLine + char;
                            if (underlineMeasureCtx.measureText(testLine).width > textMaxWidth && currentLine.length > 0) {
                                cachedWrappedLines.push(currentLine);
                                currentLine = char;
                            } else {
                                currentLine = testLine;
                            }
                        }
                        if (currentLine) cachedWrappedLines.push(currentLine);
                    }
                    if (cachedWrappedLines.length === 0) cachedWrappedLines = [' '];
                    // 预计算模型坐标系下每行宽度
                    cachedModelLineWidths = cachedWrappedLines.map(line =>
                        underlineMeasureCtx!.measureText(line || ' ').width
                    );
                } else {
                    cachedWrappedLines = this.estimateWrappedLines(label, isRoot ? { maxWidth: 220, charWidth: 8 } : undefined);
                    cachedModelLineWidths = cachedWrappedLines.map(line => {
                        const cjkCount = [...line].filter(ch => {
                            const code = ch.codePointAt(0) || 0;
                            return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F);
                        }).length;
                        return cjkCount * 16 + (line.length - cjkCount) * 8;
                    });
                }
            };

            const ensureLineElements = (count: number) => {
                // 移除多余元素
                while (lineElements.length > count) {
                    const removed = lineElements.pop()!;
                    removed.hitEl.remove();
                    removed.underlineEl.remove();
                }
                // 补充不足的元素
                while (lineElements.length < count) {
                    const hitEl = document.createElement('div');
                    hitEl.className = 'zk-node-file-link-hit';
                    hitEl.style.position = 'absolute';
                    hitEl.style.background = 'transparent';
                    hitEl.style.pointerEvents = 'auto';
                    hitEl.style.cursor = 'pointer';
                    hitEl.addEventListener('mousedown', (e: MouseEvent) => {
                        if (!this.cy || e.button !== 0) return;
                        const toggleSelection = e.metaKey || e.ctrlKey;
                        if (toggleSelection) {
                            if (node.selected()) { node.unselect(); } else { node.select(); }
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    });
                    hitEl.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if ((e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey) return;
                        this.container?.dispatchEvent(new CustomEvent('node-click', {
                            detail: { node: node.data('originalNode'), event: e }
                        }));
                    });
                    const emitHover = (e: MouseEvent) => {
                        this.container?.dispatchEvent(new CustomEvent('node-hover', {
                            detail: { node: node.data('originalNode'), event: e }
                        }));
                    };
                    hitEl.addEventListener('mouseenter', emitHover);
                    hitEl.addEventListener('mousemove', emitHover);
                    hitEl.addEventListener('mouseleave', () => {
                        this.container?.dispatchEvent(new CustomEvent('node-leave', {
                            detail: { node: node.data('originalNode') }
                        }));
                    });
                    hitEl.addEventListener('touchend', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.container?.dispatchEvent(new CustomEvent('node-click', {
                            detail: { node: node.data('originalNode'), event: e }
                        }));
                    }, { passive: false });

                    const underlineEl = document.createElement('div');
                    underlineEl.className = 'zk-node-file-underline';
                    underlineEl.style.position = 'absolute';
                    underlineEl.style.background = 'rgba(255, 255, 255, 0.58)';
                    underlineEl.style.borderRadius = '999px';
                    underlineEl.style.pointerEvents = 'none';

                    underlineGroupEl.appendChild(hitEl);
                    underlineGroupEl.appendChild(underlineEl);
                    lineElements.push({ hitEl, underlineEl });
                }
            };

            const updateUnderlinePosition = () => {
                if (!this.cy) return;
                if (this.overlayInteracting) {
                    underlineGroupEl.style.display = 'none';
                    return;
                }

                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();

                if (isHidden) {
                    underlineGroupEl.style.display = 'none';
                    return;
                }

                const label = String(node.data('label') || '').trim();
                if (!label) {
                    underlineGroupEl.style.display = 'none';
                    return;
                }

                const isRoot = !!node.data('isRoot');

                // 仅在 label 或 isRoot 变化时重新计算换行（zoom/pan 期间跳过）
                if (label !== cachedLabel || isRoot !== cachedIsRoot) {
                    rebuildWrappedLinesCache(label, isRoot);
                }

                const zoom = this.cy.zoom();
                const box = node.renderedBoundingBox();
                const fontPx = isRoot ? 26 : 20;
                const lineHeightModel = isRoot ? 24 : 18;
                const lineHeight = lineHeightModel * zoom;
                const centerX = box.x1 + box.w / 2;
                const centerY = box.y1 + box.h / 2;
                const textBlockHeight = cachedWrappedLines.length * lineHeight;
                const firstLineCenterY = centerY - textBlockHeight / 2 + lineHeight / 2;

                underlineGroupEl.style.display = 'block';

                // 确保 DOM 元素数量匹配行数
                ensureLineElements(cachedWrappedLines.length);

                for (let i = 0; i < cachedWrappedLines.length; i++) {
                    const modelWidth = cachedModelLineWidths[i] || 24;
                    const lineWidth = modelWidth * zoom;
                    const underlineWidth = Math.min(box.w - 24 * zoom, Math.max(24 * zoom, lineWidth));
                    const lineCenterY = firstLineCenterY + i * lineHeight;
                    const hitHeight = Math.max(16 * zoom, lineHeight);
                    const { hitEl, underlineEl } = lineElements[i];

                    hitEl.style.width = `${underlineWidth}px`;
                    hitEl.style.height = `${hitHeight}px`;
                    hitEl.style.left = `${centerX - underlineWidth / 2}px`;
                    hitEl.style.top = `${lineCenterY - hitHeight / 2}px`;

                    const underlineY = lineCenterY + (fontPx * 0.58 * zoom);
                    underlineEl.style.width = `${underlineWidth}px`;
                    underlineEl.style.height = `${Math.max(1, 2 * zoom)}px`;
                    underlineEl.style.left = `${centerX - underlineWidth / 2}px`;
                    underlineEl.style.top = `${underlineY}px`;
                }
            };

            badgeUpdaters.push(updateUnderlinePosition);
            updateUnderlinePosition();
        });

        this.cy.nodes().forEach((node: any) => {
            if (node.data('isGroup') || node.data('isPlaceholder') || node.data('isEmbed')) {
                return;
            }

            const remarkEl = document.createElement('div');
            remarkEl.className = 'zk-node-remark-badge';
            remarkEl.textContent = 'R';
            let lastRemarkColor = '';
            const applyRemarkBadgeStyle = () => {
                const remarkColor = node.data('branchNodeBorder') || '#ef4444';
                if (remarkColor === lastRemarkColor) return;
                lastRemarkColor = remarkColor;
                remarkEl.style.cssText = `
                position: absolute;
                width: 28px;
                height: 28px;
                background-color: ${remarkColor};
                color: #ffffff;
                font-size: 16px;
                font-weight: 700;
                border-radius: 999px;
                border: 2px solid rgba(255, 255, 255, 0.95);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: auto;
                cursor: ${readOnly ? 'default' : 'pointer'};
                user-select: none;
            `;
            };
            applyRemarkBadgeStyle();
            badgeContainer.appendChild(remarkEl);

            const tooltipEl = document.createElement('div');
            tooltipEl.className = 'zk-node-remark-tooltip';
            tooltipEl.style.cssText = `
                position: absolute;
                max-width: 280px;
                padding: 8px 10px;
                background: rgba(15, 23, 42, 0.96);
                color: #ffffff;
                font-size: 12px;
                line-height: 1.45;
                border-radius: 8px;
                border: 1px solid rgba(148, 163, 184, 0.28);
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
                white-space: pre-wrap;
                word-break: break-word;
                pointer-events: none;
                opacity: 0;
                transform: translateY(4px);
                transition: opacity 0.12s ease, transform 0.12s ease;
                z-index: 20;
            `;
            badgeContainer.appendChild(tooltipEl);

            // 懒缓存：embed/image 卡片在 addNodeBadges 之后才创建，首次查到后复用
            let remarkImageCardCache: HTMLElement | null = null;
            let remarkEmbedCardCache: HTMLElement | null = null;

            const updateRemarkPosition = () => {
                if (!this.cy) return;
                const remarkText = node.data('remark') || '';
                const isSelected = node.selected();
                // 快速路径：无 remark 且未选中时直接隐藏，跳过 visibility 检查和 boundingBox 计算
                if (!remarkText && !isSelected) {
                    if (remarkEl.style.display !== 'none') {
                        remarkEl.style.display = 'none';
                        tooltipEl.style.display = 'none';
                        tooltipEl.style.opacity = '0';
                    }
                    return;
                }
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                const shouldShow = !isHidden;
                tooltipEl.textContent = remarkText;
                applyRemarkBadgeStyle();

                if (!shouldShow) {
                    remarkEl.style.display = 'none';
                    tooltipEl.style.display = 'none';
                    tooltipEl.style.opacity = '0';
                    tooltipEl.style.transform = 'translateY(4px)';
                    return;
                }

                remarkEl.style.display = 'flex';
                tooltipEl.style.display = 'block';
                const zoom = this.cy.zoom();
                const boundingBox = node.renderedBoundingBox();
                const size = 28 * zoom;

                let x: number, y: number;
                const curIsImageNode = node.data('isImageNode');
                const curIsEmbedNode = node.data('isEmbed');
                if (curIsImageNode) {
                    // 图片节点：用卡片宽度计算右上角（懒缓存 DOM 引用，避免每帧 querySelector）
                    if (!remarkImageCardCache) remarkImageCardCache = this.container?.querySelector(`.zk-image-preview-card[data-node-id="${node.id()}"]`) as HTMLElement ?? null;
                    const rp = node.renderedPosition();
                    if (remarkImageCardCache && remarkImageCardCache.dataset.renderedWidth && remarkImageCardCache.dataset.renderedHeight) {
                        const cardW = parseFloat(remarkImageCardCache.dataset.renderedWidth);
                        const cardH = parseFloat(remarkImageCardCache.dataset.renderedHeight);
                        x = rp.x + cardW / 2 - size * 0.35;
                        y = rp.y - cardH / 2 - size * 0.35;
                    } else {
                        x = boundingBox.x2 - size * 0.35;
                        y = boundingBox.y1 - size * 0.35;
                    }
                } else if (curIsEmbedNode) {
                    // 嵌入预览节点：用卡片实际宽度计算右上角（懒缓存）
                    if (!remarkEmbedCardCache) remarkEmbedCardCache = this.container?.querySelector(`.zk-embed-preview-card[data-node-id="${node.id()}"]`) as HTMLElement ?? null;
                    if (remarkEmbedCardCache) {
                        const cardW = remarkEmbedCardCache.offsetWidth;
                        x = boundingBox.x1 + cardW - size * 0.35;
                        y = boundingBox.y1 - size * 0.35;
                    } else {
                        x = boundingBox.x2 - size * 0.35;
                        y = boundingBox.y1 - size * 0.35;
                    }
                } else {
                    x = boundingBox.x2 - size * 0.35;
                    y = boundingBox.y1 - size * 0.35;
                }

                remarkEl.style.transform = `translate(${x}px, ${y}px)`;
                remarkEl.style.width = `${size}px`;
                remarkEl.style.height = `${size}px`;
                remarkEl.style.fontSize = `${16 * zoom}px`;
                remarkEl.style.borderWidth = `${Math.max(1, 2 * zoom)}px`;

                const tooltipX = x + size + (8 * zoom);
                const tooltipY = y - (6 * zoom);
                tooltipEl.style.left = `${tooltipX}px`;
                tooltipEl.style.top = `${tooltipY}px`;
            };

            badgeUpdaters.push(updateRemarkPosition);
            updateRemarkPosition();

            remarkEl.addEventListener('click', (e) => {
                if (this.isReadOnlyMode()) {
                    return;
                }
                e.stopPropagation();
                node.select();
                this.container?.dispatchEvent(new CustomEvent('node-remark-edit', {
                    detail: {
                        node: node.data('originalNode'),
                        event: e
                    }
                }));
            });

            remarkEl.addEventListener('mouseenter', () => {
                const remarkText = node.data('remark') || '';
                if (!remarkText) return;
                tooltipEl.style.opacity = '1';
                tooltipEl.style.transform = 'translateY(0)';
            });

            remarkEl.addEventListener('mouseleave', () => {
                tooltipEl.style.opacity = '0';
                tooltipEl.style.transform = 'translateY(4px)';
            });
        });

        // 锚点星星 badge — 金色圆环 + 深色底 + 发光星标
        const MIN_ANCHOR_PX = 20;
        this.cy.nodes('[?isAnchor]').forEach((node: any) => {
            if (node.data('isGroup') || node.data('isPlaceholder')) return;

            const starEl = document.createElement('div');
            starEl.className = 'zk-node-anchor-badge';
            starEl.textContent = '★';
            starEl.style.cssText = `
                position: absolute;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #f5dc68;
                font-size: 18px;
                line-height: 1;
                pointer-events: none;
                background: radial-gradient(circle at 30% 30%, #0f172a 0%, #0b1220 65%, #090f1a 100%);
                border: 2px solid rgba(216, 197, 119, 0.95);
                border-radius: 999px;
                box-shadow:
                    0 0 0 1px rgba(255, 234, 154, 0.18),
                    0 6px 14px rgba(0, 0, 0, 0.4),
                    inset 0 1px 0 rgba(255, 236, 168, 0.24);
                text-shadow:
                    0 0 6px rgba(245, 220, 104, 0.65),
                    0 0 14px rgba(245, 220, 104, 0.30);
                z-index: 8;
                transform: translate(-50%, -50%);
            `;
            badgeContainer.appendChild(starEl);

            const updateAnchorPos = () => {
                if (!this.cy) return;
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) { starEl.style.display = 'none'; return; }

                starEl.style.display = 'block';
                const zoom = this.cy.zoom();
                const bb = node.renderedBoundingBox();
                const badgeSize = Math.max(MIN_ANCHOR_PX, 26 * zoom);
                const fontSize = Math.max(13, badgeSize * 0.52 - 1);
                const borderWidth = Math.max(1.5, badgeSize * 0.08);
                starEl.style.width = `${badgeSize}px`;
                starEl.style.height = `${badgeSize}px`;
                starEl.style.fontSize = `${fontSize}px`;
                starEl.style.borderWidth = `${borderWidth}px`;
                starEl.style.transform = `translate(${bb.x1 + badgeSize * 0.48}px, ${bb.y1 + badgeSize * 0.48}px) translate(-50%, -50%)`;
            };

            badgeUpdaters.push(updateAnchorPos);
            updateAnchorPos();
        });

        // 兼容旧语义：文字前小色点（legacy customColor）
        this.cy.nodes('[customColor]').forEach((node: any) => {
            if (node.data('isGroup') || node.data('isEmbed')) return;
            const rawColor = String(node.data('customColor') || '');
            if (!rawColor || rawColor.startsWith('fill2:')) return;
            const color = this.normalizeHexColor(rawColor);
            if (!color) return;

            const dotEl = document.createElement('div');
            dotEl.className = 'zk-node-color-dot';
            dotEl.style.cssText = `
                position: absolute;
                pointer-events: none;
                border-radius: 999px;
                transform: translate(-50%, -50%);
            `;
            dotEl.style.backgroundColor = color;
            dotEl.style.boxShadow = `0 0 6px 1px ${color}66`;
            badgeContainer.appendChild(dotEl);

            const updateDotPos = () => {
                if (!this.cy || node.removed()) { dotEl.style.display = 'none'; return; }
                const isHidden =
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) { dotEl.style.display = 'none'; return; }

                const zoom = this.cy.zoom();
                const dotSize = Math.max(5, 7 * zoom);
                const renderedPos = node.renderedPosition();
                const renderedWidth = Number(node.renderedWidth?.() || 0);
                const renderedHeight = Number(node.renderedHeight?.() || 0);
                const hasValidRenderBox =
                    Number.isFinite(renderedPos?.x) &&
                    Number.isFinite(renderedPos?.y) &&
                    Number.isFinite(renderedWidth) &&
                    Number.isFinite(renderedHeight) &&
                    renderedWidth > 1 &&
                    renderedHeight > 1;
                if (!hasValidRenderBox) {
                    dotEl.style.display = 'none';
                    return;
                }

                const centerY = renderedPos.y;
                const textStartX = renderedPos.x - renderedWidth / 2 + 20 * zoom;

                dotEl.style.display = 'block';
                dotEl.style.width = `${dotSize}px`;
                dotEl.style.height = `${dotSize}px`;
                dotEl.style.transform = `translate(${textStartX}px, ${centerY}px) translate(-50%, -50%)`;
            };

            badgeUpdaters.push(updateDotPos);
            updateDotPos();
        });

        // 为每个有 badge 的节点创建徽章元素（跳过 embed 节点，由预览卡片展示）
        this.cy.nodes('[badge]').forEach((node: any) => {
            const badge = node.data('badge');
            if (!badge || node.data('isEmbed')) return;
            const isModern = this.isModernThemeStyle();
            const branchBorderColor = typeof node.data('branchNodeBorder') === 'string'
                ? this.normalizeHexColor(node.data('branchNodeBorder'))
                : null;
            const modernBase = branchBorderColor || '#64748b';
            const badgeBackgroundColor = isModern
                ? this.hexToRgba(this.darkenColor(modernBase, 0.62), 0.22)
                : 'rgba(0, 0, 0, 0.25)';
            const badgeTextColor = isModern
                ? this.hexToRgba(this.darkenColor(modernBase, 0.30), 0.86)
                : 'rgba(255, 255, 255, 0.9)';
            const badgeBorderColor = isModern
                ? this.hexToRgba(this.darkenColor(modernBase, 0.42), 0.38)
                : 'transparent';

            const badgeEl = document.createElement('div');
            badgeEl.className = 'zk-node-badge';
            badgeEl.textContent = badge;
            badgeEl.style.cssText = `
                position: absolute;
                background-color: ${badgeBackgroundColor};
                color: ${badgeTextColor};
                border: 1px solid ${badgeBorderColor};
                font-size: 9px;
                font-weight: 600;
                font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
                padding: 3px 8px;
                border-radius: 20px;
                white-space: nowrap;
                pointer-events: auto;
                cursor: pointer;
            `;
            badgeEl.style.transformOrigin = 'right bottom';
            (badgeEl.style as any).webkitTextSizeAdjust = 'none';
            (badgeEl.style as any).textSizeAdjust = 'none';
            badgeContainer.appendChild(badgeEl);

            // 更新徽章位置的函数
            const updateBadgePosition = () => {
                if (!this.cy) return;

                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) {
                    badgeEl.style.display = 'none';
                    return;
                }
                badgeEl.style.display = '';

                const zoom = this.cy.zoom();
                const boundingBox = node.renderedBoundingBox();

                // 徽章位置：节点右下角内侧
                const x = boundingBox.x2 - 8 * zoom;
                const y = boundingBox.y2 - 8 * zoom;
                if (Platform.isMobile) {
                    // 移动端使用 transform scale，规避 WebView 文本最小字号干预导致的“ID 不缩放”
                    const safeScale = Math.max(0.28, zoom);
                    badgeEl.style.transform = `translate(${x}px, ${y}px) translate(-100%, -100%) scale(${safeScale})`;
                    badgeEl.style.fontSize = '9px';
                    badgeEl.style.padding = '3px 8px';
                    badgeEl.style.borderRadius = '20px';
                } else {
                    badgeEl.style.transform = `translate(${x}px, ${y}px) translate(-100%, -100%)`;
                    badgeEl.style.fontSize = `${9 * zoom}px`;
                    badgeEl.style.padding = `${3 * zoom}px ${8 * zoom}px`;
                    badgeEl.style.borderRadius = `${20 * zoom}px`;
                }
            };

            badgeUpdaters.push(updateBadgePosition);

            // 初始位置
            updateBadgePosition();

            // 点击徽章时选中节点
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                node.select();
            });
        });

        // 文本节点右下角拉伸手柄（仅选中时可见）
        if (!readOnly) {
            this.cy.nodes('[?isTextOnly]').forEach((node: any) => {
                if (node.data('isGroup') || node.data('isPlaceholder') || node.data('isEmbed')) return;

                const resizeEl = document.createElement('div');
                resizeEl.className = 'zk-text-node-resize-handle';
                resizeEl.style.cssText = `
                    position: absolute;
                    width: 18px;
                    height: 18px;
                    border-top-left-radius: 6px;
                    background: rgba(91, 143, 217, 0.9);
                    color: rgba(255, 255, 255, 0.95);
                    font-size: 11px;
                    font-weight: 700;
                    display: flex;
                    align-items: flex-end;
                    justify-content: flex-end;
                    line-height: 1;
                    padding-right: 2px;
                    cursor: nwse-resize;
                    pointer-events: none;
                    opacity: 0;
                    transition: opacity 0.15s ease;
                    z-index: 10;
                    user-select: none;
                `;
                resizeEl.textContent = '\u25e2';
                badgeContainer.appendChild(resizeEl);

                let resizing = false;
                let startX = 0;
                let startY = 0;
                let startWModel = 0;
                let startHModel = 0;
                let startLeftModel = 0;
                let startTopModel = 0;

                const getTextNodeMinModelSize = (): { width: number; height: number } => {
                    // 手动缩放时使用固定下限，不再按整段文本内容估算最小高度，
                    // 否则长文本节点会被一个很大的“内容最小值”卡住，无法继续缩小。
                    if (node.data('isRoot')) {
                        return { width: 180, height: 90 };
                    }
                    return { width: 120, height: 60 };
                };

                const onMove = (e: MouseEvent) => {
                    if (!resizing || !this.cy) return;
                    const zoom = this.cy.zoom();
                    const minSize = getTextNodeMinModelSize();
                    const widthModel = Math.max(minSize.width, startWModel + (e.clientX - startX) / zoom);
                    const heightModel = Math.max(minSize.height, startHModel + (e.clientY - startY) / zoom);
                    const centerX = startLeftModel + widthModel / 2;
                    const centerY = startTopModel + heightModel / 2;
                    node.position({ x: centerX, y: centerY });
                    node.style({ width: widthModel, height: heightModel });
                    node.data('manualWidthModel', widthModel);
                    node.data('manualHeightModel', heightModel);
                    this.immediateOverlayUpdate();
                };

                const onUp = () => {
                    if (!resizing || !this.cy) return;
                    resizing = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    const widthModel = Number(node.width());
                    const heightModel = Number(node.height());
                    this.container?.dispatchEvent(new CustomEvent('embed-node-size-changed', {
                        detail: {
                            node: node.data('originalNode'),
                            nodeId: node.data('originalNodeId') || node.data('originalNode')?.IDStr || node.data('originalNode')?.ID || '',
                            size: { widthModel, heightModel }
                        }
                    }));
                };

                resizeEl.addEventListener('mousedown', (e: MouseEvent) => {
                    if (e.button !== 0 || !this.cy) return;
                    e.preventDefault();
                    e.stopPropagation();
                    resizing = true;
                    startX = e.clientX;
                    startY = e.clientY;
                    startWModel = Number(node.width() || 0);
                    startHModel = Number(node.height() || 0);
                    const startPos = node.position();
                    startLeftModel = startPos.x - startWModel / 2;
                    startTopModel = startPos.y - startHModel / 2;
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });

                const updateResizeHandle = () => {
                    if (!this.cy) return;
                    const isHidden =
                        node.removed() ||
                        node.hasClass('zk-collapsed-hidden') ||
                        node.style('display') === 'none' ||
                        !node.visible();
                    if (isHidden || !node.selected()) {
                        resizeEl.style.display = 'none';
                        resizeEl.style.pointerEvents = 'none';
                        return;
                    }
                    resizeEl.style.display = 'flex';
                    resizeEl.style.pointerEvents = 'auto';
                    resizeEl.style.opacity = '1';
                    const zoom = this.cy.zoom();
                    const bb = node.renderedBoundingBox();
                    const size = Math.max(14, 18 * zoom);
                    resizeEl.style.width = `${size}px`;
                    resizeEl.style.height = `${size}px`;
                    resizeEl.style.fontSize = `${Math.max(8, 11 * zoom)}px`;
                    resizeEl.style.transform = `translate(${bb.x2 - size}px, ${bb.y2 - size}px)`;
                };

                badgeUpdaters.push(updateResizeHandle);
                updateResizeHandle();
            });
        }

        // embed toggle 按钮（睁眼/闭眼，文件节点⟷预览节点互转）
        if (!readOnly) {
            this.cy.nodes().forEach((node: any) => {
                if (node.data('isRoot') || node.data('isPlaceholder') || node.data('isGroup') || node.data('isStandaloneText')) return;
                if (node.data('isTextOnly')) return;
                if (node.data('isCrossDomain')) return;
                const isEmbed = !!node.data('isEmbed');
                if (isEmbed) return;
                const toggleEl = document.createElement('div');
                toggleEl.className = 'zk-embed-toggle';
                const toggleLabel = isEmbed ? '切换为文件节点' : '切换为 Embed 节点';
                toggleEl.setAttribute('aria-label', toggleLabel);
                setIcon(toggleEl, isEmbed ? 'eye-off' : 'eye');
                toggleEl.style.cssText = `
                    position: absolute;
                    cursor: pointer;
                    pointer-events: auto;
                    opacity: 0.88;
                    transition: opacity 0.15s ease, transform 0.15s ease;
                    user-select: none;
                    z-index: 10;
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--text-normal);
                `;
                const toggleSvg = toggleEl.querySelector('svg') as SVGElement | null;
                if (toggleSvg) {
                    toggleSvg.style.width = '95%';
                    toggleSvg.style.height = '95%';
                    toggleSvg.style.strokeWidth = '2.2';
                }
                badgeContainer.appendChild(toggleEl);
                const swallowTogglePointer = (e: Event) => {
                    e.preventDefault();
                    e.stopPropagation();
                };
                toggleEl.addEventListener('pointerdown', swallowTogglePointer);
                toggleEl.addEventListener('mousedown', swallowTogglePointer);

                toggleEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.container?.dispatchEvent(new CustomEvent('toggle-embed-node', {
                        detail: {
                            node: node.data('originalNode'),
                            nodeId: node.data('originalNodeId') || node.data('originalNode')?.IDStr || node.data('originalNode')?.ID || '',
                            wikiLink: node.data('originalNode')?.wikiLink || '',
                            filePath: node.data('filePath') || '',
                            displayText: node.data('displayText') || '',
                            title: node.data('title') || '',
                            currentIsEmbed: isEmbed
                        }
                    }));
                });

                let toggleEmbedCardCache: HTMLElement | null = null;
                const updateTogglePos = () => {
                    if (!this.cy) return;
                    const isHidden = node.removed() || node.hasClass('zk-collapsed-hidden') || node.style('display') === 'none' || !node.visible();
                    if (isHidden) { toggleEl.style.display = 'none'; return; }
                    if (!node.selected()) {
                        toggleEl.style.display = 'none';
                        toggleEl.style.pointerEvents = 'none';
                        return;
                    }
                    toggleEl.style.display = '';
                    toggleEl.style.opacity = '1';
                    toggleEl.style.pointerEvents = 'auto';
                    const zoom = this.cy.zoom();
                    const bb = node.renderedBoundingBox();
                    const size = Math.max(20, 24 * zoom);
                    toggleEl.style.width = `${size}px`;
                    toggleEl.style.height = `${size}px`;
                    let x = bb.x1 + bb.w / 2 - size / 2;
                    let y = bb.y2 + 8 * zoom;

                    if (isEmbed) {
                        if (!toggleEmbedCardCache) toggleEmbedCardCache = this.container?.querySelector(`.zk-embed-preview-card[data-node-id="${node.id()}"]`) as HTMLElement ?? null;
                        if (toggleEmbedCardCache) {
                            x = toggleEmbedCardCache.offsetLeft + (toggleEmbedCardCache.offsetWidth - size) / 2;
                            y = toggleEmbedCardCache.offsetTop + toggleEmbedCardCache.offsetHeight + 8 * zoom;
                        }
                    }

                    toggleEl.style.transform = `translate(${x}px, ${y}px)`;
                };

                badgeUpdaters.push(updateTogglePos);
                updateTogglePos();
            });
        }

        // 文本节点 Markdown 渲染 overlay
        this.buildTextMarkdownOverlays(badgeContainer, badgeUpdaters);

        // 注册到统一 overlay 调度器
        const badgePositionUpdater = () => badgeUpdaters.forEach(updater => updater());
        this.overlayUpdaters.add(badgePositionUpdater);
        this.overlayImmediateUpdaters.add(badgePositionUpdater);
        this.overlayExtraUpdaters.add(badgePositionUpdater);
        this.overlaySelectionUpdaters.add(badgePositionUpdater);

        // 添加边控制点
        this.addEdgeControlPoints();

        // 添加边端点手柄
        this.addEdgeEndpointHandles();

        // 添加连线手柄
        this.addConnectionHandles();

        // 添加折叠/展开子节点手柄
        this.addCollapseToggleHandle();
        
        // 添加分组调整大小手柄
        this.addGroupResizeHandles();

        // 所有 overlay 子系统注册完毕后，绑定统一事件监听
        this.bindOverlayListeners();
        this.immediateOverlayUpdate();
    }

    /**
     * 为所有 isTextOnly 节点构建 Markdown 渲染 overlay
     * 性能优化：
     *   1) 内容 hash 缓存 —— 跨 addNodeBadges 重建复用 overlay DOM + Component
     *   2) 快路径检测 —— 无 MD 语法时跳过 MarkdownRenderer，直接 textContent
     *   3) 批量尺寸回写 —— Promise.all 完成后 cy.batch 一次性刷新节点宽高
     */
    private buildTextMarkdownOverlays(badgeContainer: HTMLElement, badgeUpdaters: Array<() => void>): void {
        if (!this.cy) return;
        const app = (window as any).app;
        const sourcePath = this.currentData?.metadata?.currentFile || '';

        const measureAndSizePending: Array<{ node: any; entry: { el: HTMLElement; width: number; height: number } }> = [];
        const renderPromises: Promise<void>[] = [];

        this.cy.nodes('[?isTextOnly]').forEach((node: any) => {
            const data = node.data();
            if (data.isPlaceholder) return;
            const originalNode: ZKNode | undefined = data.originalNode;
            if (!originalNode) return;

            const rawSource = String(
                originalNode.title
                || originalNode.displayText
                || data.label
                || ''
            ).replace(/\\n/g, '\n');
            const nodeCacheId = String(
                data.originalNodeId
                || originalNode.IDStr
                || originalNode.ID
                || node.id?.()
                || ''
            );
            const cacheKey = `${sourcePath}||${nodeCacheId}||${rawSource}`;
            const isRootTextNode = !!data.isRoot && !data.isFreeNode;
            const applyTextOverlayBaseStyle = (overlayEl: HTMLElement) => {
                const overlayDisplay = isRootTextNode ? 'flex' : 'block';
                // padding 用 em,跟随当前 font-size(== base * zoom)等比伸缩
                const overlayPadding = isRootTextNode ? '0 0.923em' : '1.2em 1.2em 0.6em 1.2em';
                const overlayFontSize = isRootTextNode ? 26 : 20;
                const overlayFontWeight = isRootTextNode ? '700' : '500';
                const overlayTextAlign = isRootTextNode ? 'center' : 'left';
                const overlayAlignItems = isRootTextNode ? 'center' : 'stretch';
                // 缩放策略:不用 transform: scale,改用 font-size * zoom 让文本与布局随白板缩放伸缩
                // (对齐 Obsidian Canvas 的做法)。这样 CM/vim 永远在"自然像素"里工作,fat cursor
                // 不会被 scaled parent 的亚像素误差弄歪。updateOverlayPos 会改写 font-size。
                overlayEl.dataset.baseFontSize = String(overlayFontSize);
                overlayEl.style.cssText = `
                    position: absolute;
                    left: 0;
                    top: 0;
                    display: ${overlayDisplay};
                    flex-direction: column;
                    justify-content: center;
                    align-items: ${overlayAlignItems};
                    pointer-events: none;
                    overflow: hidden;
                    box-sizing: border-box;
                    padding: ${overlayPadding};
                    max-width: none;
                    color: var(--text-normal);
                    font-family: var(--font-text);
                    font-size: ${overlayFontSize}px;
                    font-weight: ${overlayFontWeight};
                    line-height: 1.35;
                    word-wrap: break-word;
                    overflow-wrap: anywhere;
                    user-select: none;
                    text-align: ${overlayTextAlign};
                `;
            };

            let entry = this.textMdOverlayCache.get(cacheKey);

            if (entry) {
                // 缓存命中：直接复用
                entry.usedInCycle = true;
                applyTextOverlayBaseStyle(entry.el);
                badgeContainer.appendChild(entry.el);
            } else {
                // 缓存未命中：创建新 overlay
                const overlayEl = document.createElement('div');
                overlayEl.className = 'zk-text-md-overlay markdown-rendered';
                applyTextOverlayBaseStyle(overlayEl);
                badgeContainer.appendChild(overlayEl);

                const component = new Component();
                component.load();

                entry = {
                    el: overlayEl,
                    component,
                    mdEditor: null,
                    width: 0,
                    height: 0,
                    isPlainText: false,
                    usedInCycle: true,
                };
                this.textMdOverlayCache.set(cacheKey, entry);

                const normalizedSource = rawSource.replace(/\r\n?/g, '\n');
                // 粗糙渲染：用 DOM API 构建，避免 innerHTML 大量字符串拼接
                const applyRoughInlineMarkdown = (container: HTMLElement, input: string): void => {
                    const createExternalLink = (rawUrl: string, text?: string): HTMLAnchorElement => {
                        const a = document.createElement('a');
                        const href = rawUrl.startsWith('www.') ? `https://${rawUrl}` : rawUrl;
                        a.href = href;
                        a.textContent = text || rawUrl;
                        a.rel = 'noopener';
                        a.addEventListener('click', (e: MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            window.open(href, '_blank');
                        });
                        return a;
                    };
                    const createInternalLink = (rawTarget: string): HTMLAnchorElement => {
                        const [targetPart, aliasPart] = rawTarget.split('|');
                        const linkText = (targetPart || '').trim();
                        const displayText = (aliasPart || linkText).trim();
                        const a = document.createElement('a');
                        a.className = 'internal-link';
                        a.href = linkText;
                        a.dataset.href = linkText;
                        a.textContent = displayText || linkText;
                        a.addEventListener('click', (e: MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!linkText) return;
                            app?.workspace?.openLinkText?.(linkText, sourcePath, e.ctrlKey || e.metaKey);
                        });
                        a.addEventListener('mouseover', (e: MouseEvent) => {
                            if (!linkText) return;
                            app?.workspace?.trigger?.('hover-link', {
                                event: e,
                                source: 'zk-navigation',
                                hoverParent: this.container ?? badgeContainer,
                                targetEl: a,
                                linktext: linkText,
                                sourcePath,
                            });
                        });
                        return a;
                    };
                    const createEmbedNode = (rawTarget: string): HTMLElement => {
                        const [targetPart] = rawTarget.split('|');
                        const linkText = (targetPart || '').trim();
                        const pathWithoutSubpath = linkText.split('#')[0].trim();
                        const ext = pathWithoutSubpath.split('.').pop()?.toLowerCase() || '';
                        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
                        if (!isImage) return createInternalLink(rawTarget);

                        const file = app?.metadataCache?.getFirstLinkpathDest?.(linkText, sourcePath)
                            || app?.vault?.getAbstractFileByPath?.(pathWithoutSubpath);
                        if (!file) return createInternalLink(rawTarget);

                        const img = document.createElement('img');
                        img.className = 'zk-text-md-embed-image';
                        img.src = app.vault.getResourcePath(file);
                        img.alt = linkText;
                        img.draggable = false;
                        img.addEventListener('click', (e: MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            app?.workspace?.openLinkText?.(linkText, sourcePath, e.ctrlKey || e.metaKey);
                        });
                        return img;
                    };
                    // 按内联标记拆分并逐段追加 DOM 节点
                    const tokenRe = /!\[\[([^\]\n]+)\]\]|\[\[([^\]\n]+)\]\]|\*\*(.+?)\*\*|~~(.+?)~~|__(.+?)__|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|<span\s+style=["']([^"']+)["']>(.*?)<\/span>|((?:https?:\/\/|www\.)[^\s<>()\]]+)/g;
                    let lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = tokenRe.exec(input)) !== null) {
                        if (m.index > lastIndex) {
                            container.appendChild(document.createTextNode(input.slice(lastIndex, m.index)));
                        }
                        if (m[1] !== undefined) {
                            container.appendChild(createEmbedNode(m[1]));
                        } else if (m[2] !== undefined) {
                            container.appendChild(createInternalLink(m[2]));
                        } else if (m[3] !== undefined) {
                            const strong = document.createElement('strong');
                            strong.textContent = m[3];
                            container.appendChild(strong);
                        } else if (m[4] !== undefined) {
                            const del = document.createElement('del');
                            del.textContent = m[4];
                            container.appendChild(del);
                        } else if (m[5] !== undefined) {
                            const u = document.createElement('u');
                            u.textContent = m[5];
                            container.appendChild(u);
                        } else if (m[6] !== undefined) {
                            const a = createExternalLink(m[7] || '', m[6]);
                            if (m[8]) a.title = m[8];
                            container.appendChild(a);
                        } else if (m[9] !== undefined) {
                            const span = document.createElement('span');
                            span.style.cssText = m[9].trim();
                            span.textContent = m[10];
                            container.appendChild(span);
                        } else if (m[11] !== undefined) {
                            const rawUrl = m[11];
                            const trimmedUrl = rawUrl.replace(/[.,;:!?，。；：！？]+$/, '');
                            const trailing = rawUrl.slice(trimmedUrl.length);
                            container.appendChild(createExternalLink(trimmedUrl));
                            if (trailing) {
                                container.appendChild(document.createTextNode(trailing));
                            }
                        }
                        lastIndex = m.index + m[0].length;
                    }
                    if (lastIndex < input.length) {
                        container.appendChild(document.createTextNode(input.slice(lastIndex)));
                    }
                };
                const buildRoughLines = (parent: HTMLElement) => {
                    const lines = normalizedSource.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) {
                            const empty = document.createElement('div');
                            empty.className = 'zk-rough-empty-line';
                            parent.appendChild(empty);
                            continue;
                        }
                        const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
                        if (headingMatch) {
                            const level = Math.min(headingMatch[1].length, 6);
                            const div = document.createElement('div');
                            div.className = `zk-rough-heading-line zk-rough-h${level}-line`;
                            applyRoughInlineMarkdown(div, headingMatch[2]);
                            parent.appendChild(div);
                        } else {
                            const div = document.createElement('div');
                            div.className = 'zk-rough-text-line';
                            applyRoughInlineMarkdown(div, line);
                            parent.appendChild(div);
                        }
                    }
                };
                overlayEl.empty?.();
                if (isRootTextNode) {
                    const inner = document.createElement('div');
                    inner.className = 'zk-root-text-md-inner';
                    buildRoughLines(inner);
                    overlayEl.appendChild(inner);
                } else {
                    buildRoughLines(overlayEl);
                }
                const rect = overlayEl.getBoundingClientRect();
                entry.width = Math.max(80, Math.min(rect.width + 4, 640));
                entry.height = Math.max(32, Math.min(rect.height + 4, 640));
                measureAndSizePending.push({ node, entry });
            }

            // 标记节点已有 overlay（供样式层判断是否隐藏 Canvas 文字）
            node.data('hasMarkdownOverlay', true);
            // 挂载 overlay 引用到节点，便于编辑期查找
            (node.scratch as any) && node.scratch('_zkMdOverlay', entry.el);

            // 位置同步 updater
            const currentEntry = entry;
            const baseFontSize = isRootTextNode ? 26 : 20;
            const updateOverlayPos = () => {
                if (!this.cy || node.removed()) {
                    currentEntry.el.style.display = 'none';
                    return;
                }
                // 使用 includeLabels:false 获取纯形状边界，避免不可见标签
                // （text-opacity:0）撑大 boundingBox 导致 overlay 宽于节点形状
                const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
                if (!bb || bb.w <= 0) {
                    currentEntry.el.style.display = 'none';
                    return;
                }
                const zoom = this.cy.zoom();
                const isEditing = currentEntry.el.dataset.editing === '1';
                currentEntry.el.style.display = 'block';
                currentEntry.el.style.left = `${bb.x1}px`;
                currentEntry.el.style.top = `${bb.y1}px`;
                // 直接按屏幕像素赋尺寸 + 用 font-size * zoom 模拟缩放(替代 transform: scale)。
                // 内部 padding / heading / cm editor 都用 em,跟随 font-size 等比伸缩。
                currentEntry.el.style.width = `${bb.w}px`;
                currentEntry.el.style.height = `${bb.h}px`;
                currentEntry.el.style.fontSize = `${baseFontSize * zoom}px`;
                // 非编辑态缓存 model 尺寸(供手动拉伸等逻辑使用)
                if (!isEditing) {
                    currentEntry.width = bb.w / zoom;
                    currentEntry.height = bb.h / zoom;
                }
                const isSelected = node.selected();
                const overflowY = (currentEntry.el.scrollHeight - currentEntry.el.clientHeight) > 1;
                currentEntry.el.dataset.overflowing = overflowY ? '1' : '0';
                currentEntry.el.style.overflowX = 'hidden';
                currentEntry.el.style.overflowY = (isSelected && overflowY) ? 'auto' : 'hidden';
                currentEntry.el.style.pointerEvents = (isSelected && overflowY) ? 'auto' : 'none';
            };
            badgeUpdaters.push(updateOverlayPos);
            updateOverlayPos();
        });

        // 批量尺寸回写：先处理同步完成的（快路径），异步完成的在 Promise.all 后再批量
        const measureOverlayHeightForWidth = (el: HTMLElement, width: number, fallbackHeight: number): number => {
            if (!el || width <= 0) return fallbackHeight;
            const prevWidth = el.style.width;
            const prevHeight = el.style.height;
            const prevFontSize = el.style.fontSize;
            const base = Number(el.dataset.baseFontSize || '20');
            try {
                // 以模型坐标测量内容高度(font-size 复位到 base,对应 zoom=1 的自然尺寸)
                el.style.fontSize = `${base}px`;
                el.style.width = `${width}px`;
                el.style.height = 'auto';
                const measured = Math.ceil(Math.max(el.scrollHeight, el.getBoundingClientRect().height)) + 4;
                return Math.max(32, Math.min(640, measured));
            } catch {
                return fallbackHeight;
            } finally {
                el.style.width = prevWidth;
                el.style.height = prevHeight;
                el.style.fontSize = prevFontSize;
            }
        };

        const applySizes = (pending: typeof measureAndSizePending) => {
            if (!this.cy || pending.length === 0) return;
            this.cy.batch(() => {
                pending.forEach(({ node, entry: e }) => {
                    if (node.removed()) return;
                    const currentWidthModel = Number(node.data('manualWidthModel') || 0);
                    const currentHeightModel = Number(node.data('manualHeightModel') || 0);
                    // 回归原有尺寸计算：初始化阶段不由 Markdown overlay 改写节点尺寸；
                    // 仅在已存在手动尺寸时继续沿用。
                    if (currentWidthModel <= 0 && currentHeightModel <= 0) return;
                    const targetWidth = currentWidthModel > 0 ? currentWidthModel : e.width;
                    const targetHeight = currentHeightModel > 0
                        ? currentHeightModel
                        : measureOverlayHeightForWidth(e.el, targetWidth, e.height);
                    e.width = targetWidth;
                    e.height = targetHeight;
                    node.data('manualWidthModel', targetWidth);
                    node.data('manualHeightModel', targetHeight);
                    node.style({ width: targetWidth, height: targetHeight });
                });
            });
        };

        // 同步快路径批量写入
        const syncPending = measureAndSizePending.splice(0);
        applySizes(syncPending);

        // 异步 MD 渲染完成后批量写入（不阻塞后续 addNodeBadges 流程）
        if (renderPromises.length > 0) {
            Promise.all(renderPromises).then(() => {
                applySizes(measureAndSizePending.splice(0));
            });
        }

        // 清理本次未使用的缓存项（mark-sweep）
        const toEvict: string[] = [];
        this.textMdOverlayCache.forEach((e, key) => {
            if (!e.usedInCycle) {
                toEvict.push(key);
            }
        });
        toEvict.forEach(key => {
            const e = this.textMdOverlayCache.get(key);
            if (e) {
                if (e.mdEditor) {
                    try { e.mdEditor.unload(); } catch { /* ignore */ }
                }
                try { e.component.unload(); } catch { /* ignore */ }
                if (e.el.parentNode) e.el.remove();
                this.textMdOverlayCache.delete(key);
            }
        });
    }

    private addCollapseToggleHandle(): void {
        if (!this.cy || !this.container) return;

        if (this.collapseHandleCleanup) {
            this.collapseHandleCleanup();
            this.collapseHandleCleanup = null;
        }

        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-collapse-toggle-handle';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 4;
        `;
        this.container.appendChild(handleContainer);
        const handleUpdaters: Array<() => void> = [];

        const hasChildren = (originalId: string): boolean => {
            return this.cy!.nodes().some((n: any) => {
                const childId = n.data()?.originalNode?.IDStr;
                return typeof childId === 'string' && childId !== originalId && childId.startsWith(`${originalId}.`);
            });
        };

        this.cy.nodes().forEach((node: any) => {
            const data = node.data();
            const originalId = data?.originalNode?.IDStr;
            if (!originalId || data?.isGroup || data?.isPlaceholder) return;
            if (!hasChildren(originalId)) return;

            const handle = document.createElement('div');
            handle.style.cssText = `
                position: absolute;
                width: 33px;
                height: 33px;
                border-radius: 16.5px;
                background-color: rgba(17, 24, 39, 0.85);
                border: 1px solid rgba(148, 163, 184, 0.45);
                color: #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                font-weight: 700;
                line-height: 1;
                cursor: pointer;
                pointer-events: auto;
                user-select: none;
            `;
            handleContainer.appendChild(handle);

            const updateHandle = () => {
                if (!this.cy) return;

                const isHidden = node.hasClass('zk-collapsed-hidden') || !node.visible();
                if (isHidden) {
                    handle.style.display = 'none';
                    return;
                }

                const bb = node.renderedBoundingBox();
                const zoom = this.cy.zoom();
                const size = 33 * zoom;
                const left = bb.x1 - size - (8 * zoom);
                const top = bb.y1 + (bb.h - size) / 2;
                const isCollapsed = this.collapsedNodeIds.has(originalId);
                const shouldShow = isCollapsed || node.selected();

                if (!shouldShow) {
                    handle.style.display = 'none';
                    return;
                }

                handle.textContent = isCollapsed ? '▶' : '▼';
                handle.title = isCollapsed ? '展开子节点' : '收起子节点';
                handle.style.width = `${size}px`;
                handle.style.height = `${size}px`;
                handle.style.borderRadius = `${size / 2}px`;
                handle.style.transform = `translate(${left}px, ${top}px)`;
                handle.style.fontSize = `${18 * zoom}px`;
                handle.style.display = 'flex';
            };

            handleUpdaters.push(updateHandle);
            updateHandle();

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            const toggleCollapse = (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.collapsedNodeIds.has(originalId)) {
                    this.collapsedNodeIds.delete(originalId);
                } else {
                    this.collapsedNodeIds.add(originalId);
                }
                this.applyCollapsedState();
                handleUpdaters.forEach((fn) => fn());
            };
            handle.addEventListener('click', toggleCollapse);
            handle.addEventListener('touchend', toggleCollapse, { passive: false });
        });

        // 注册到统一 overlay 调度器
        const collapsePositionUpdater = () => handleUpdaters.forEach((fn) => fn());
        this.overlayUpdaters.add(collapsePositionUpdater);
        this.overlayExtraUpdaters.add(collapsePositionUpdater);

        this.collapseHandleCleanup = () => {
            this.overlayUpdaters.delete(collapsePositionUpdater);
            this.overlayExtraUpdaters.delete(collapsePositionUpdater);
            handleContainer.remove();
        };
    }

    private applyCollapsedState(): void {
        if (!this.cy) return;

        const existingIds = new Set<string>();
        this.cy.nodes().forEach((node: any) => {
            const id = node.data()?.originalNode?.IDStr;
            if (id) existingIds.add(id);
        });
        this.collapsedNodeIds = new Set(Array.from(this.collapsedNodeIds).filter((id) => existingIds.has(id)));

        this.cy.nodes().removeClass('zk-collapsed-hidden');
        this.cy.edges().removeClass('zk-collapsed-hidden');

        const hiddenIds = new Set<string>();
        this.collapsedNodeIds.forEach((collapsedId) => {
            this.cy!.nodes().forEach((node: any) => {
                const id = node.data()?.originalNode?.IDStr;
                if (!id) return;
                if (id !== collapsedId && id.startsWith(`${collapsedId}.`)) {
                    hiddenIds.add(id);
                    node.addClass('zk-collapsed-hidden');
                }
            });
        });

        this.cy.edges().forEach((edge: any) => {
            const sourceId = edge.data()?.originalSource;
            const targetId = edge.data()?.originalTarget;
            if ((sourceId && hiddenIds.has(sourceId)) || (targetId && hiddenIds.has(targetId))) {
                edge.addClass('zk-collapsed-hidden');
            }
        });

        // 如果分组内成员全部隐藏，则分组容器也一并隐藏
        this.cy.nodes('[?isGroup]').forEach((groupNode: any) => {
            const groupNodeIds: string[] = groupNode.data('nodeIds') || [];
            if (groupNodeIds.length === 0) return;

            const hasVisibleMember = groupNodeIds.some((nodeId) => !hiddenIds.has(nodeId));
            if (!hasVisibleMember) {
                groupNode.addClass('zk-collapsed-hidden');
            }
        });
    }
    
    /**
     * 添加连线手柄（用于拖动创建连接）
     */
    private addConnectionHandles(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的手柄容器
        const oldHandleContainer = this.container.querySelector('.zk-connection-handles');
        if (oldHandleContainer) {
            oldHandleContainer.remove();
        }

        // 创建手柄容器
        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-connection-handles';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 3;
        `;
        this.container.appendChild(handleContainer);

        // 存储所有手柄的更新函数
        const handleUpdaters: Array<() => void> = [];

        // 为每个节点创建连线手柄
        this.cy.nodes('[!isPlaceholder]').forEach((node: any) => {
            const handle = document.createElement('div');
            handle.className = 'zk-connection-handle';
            const baseHandleSize = 36;
            handle.style.cssText = `
                position: absolute;
                width: ${baseHandleSize}px;
                height: ${baseHandleSize}px;
                background-color: #5b8fd9;
                border: 2px solid #ffffff;
                border-radius: 50%;
                cursor: crosshair;
                pointer-events: auto;
                transform: translate(-50%, -50%);
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                opacity: 0;
                transition: opacity 0.2s;
            `;
            handle.style.display = 'none';
            handleContainer.appendChild(handle);

            // 动态检查节点类型（isImageNode 可能在 addImageNodePreviews 中延迟设置）
            const nodeId = node.id();

            // 更新手柄位置的函数（懒缓存 embed/image 卡片引用，避免每帧 querySelector）
            let handleImageCardCache: HTMLElement | null = null;
            let handleEmbedCardCache: HTMLElement | null = null;
            let handleLastZoom = -1;
            const updateHandlePosition = () => {
                if (!this.cy) return;
                // 手柄不可见时直接隐藏，避免默认 transform 露出在左上角
                if (handle.style.opacity === '0') {
                    handle.style.display = 'none';
                    return;
                }

                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) {
                    handle.style.display = 'none';
                    return;
                }

                const zoom = this.cy.zoom();
                const curIsImageNode = node.data('isImageNode');
                const curIsEmbedNode = node.data('isEmbed');

                let x: number, y: number;
                if (curIsImageNode) {
                    const rp = node.renderedPosition();
                    if (!Number.isFinite(rp?.x) || !Number.isFinite(rp?.y)) {
                        handle.style.display = 'none';
                        return;
                    }
                    if (!handleImageCardCache) handleImageCardCache = this.container?.querySelector(`.zk-image-preview-card[data-node-id="${nodeId}"]`) as HTMLElement ?? null;
                    if (handleImageCardCache && handleImageCardCache.dataset.renderedWidth) {
                        const cardW = parseFloat(handleImageCardCache.dataset.renderedWidth);
                        x = rp.x + cardW / 2;
                        y = rp.y;
                    } else {
                        x = rp.x; y = rp.y;
                    }
                } else if (curIsEmbedNode) {
                    const boundingBox = node.renderedBoundingBox();
                    if (!Number.isFinite(boundingBox?.x1) || !Number.isFinite(boundingBox?.x2) || !Number.isFinite(boundingBox?.y1) || !Number.isFinite(boundingBox?.y2)) {
                        handle.style.display = 'none';
                        return;
                    }
                    if (!handleEmbedCardCache) handleEmbedCardCache = this.container?.querySelector(`.zk-embed-preview-card[data-node-id="${nodeId}"]`) as HTMLElement ?? null;
                    if (handleEmbedCardCache) {
                        const cardW = handleEmbedCardCache.offsetWidth;
                        x = boundingBox.x1 + cardW;
                    } else {
                        x = boundingBox.x2;
                    }
                    y = (boundingBox.y1 + boundingBox.y2) / 2;
                } else {
                    const boundingBox = node.renderedBoundingBox();
                    if (!Number.isFinite(boundingBox?.x2) || !Number.isFinite(boundingBox?.y1) || !Number.isFinite(boundingBox?.y2)) {
                        handle.style.display = 'none';
                        return;
                    }
                    x = boundingBox.x2;
                    y = (boundingBox.y1 + boundingBox.y2) / 2;
                }

                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    handle.style.display = 'none';
                    return;
                }

                handle.style.display = 'block';
                handle.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
                // 仅 zoom 变化时更新尺寸
                if (zoom !== handleLastZoom) {
                    handleLastZoom = zoom;
                    handle.style.width = `${baseHandleSize * zoom}px`;
                    handle.style.height = `${baseHandleSize * zoom}px`;
                    handle.style.borderWidth = `${2 * zoom}px`;
                }
            };

            handleUpdaters.push(updateHandlePosition);

            // 初始位置
            updateHandlePosition();

            // 为所有节点类型统一设置 data 属性和 hover 逻辑
            // isImageNode 可能在 addConnectionHandles 之后才由 addImageNodePreviews 设置
            // 所以需要同时设置 imageNodeId 和 embedNodeId，运行时动态判断
            handle.dataset.imageNodeId = nodeId;
            handle.dataset.embedNodeId = nodeId;

            // Cytoscape mouseover/mouseout（对普通节点和嵌入预览节点有效）
            const handleMouseOver = () => {
                if (this.isEdgeSelected) return;
                handle.style.opacity = '1';
                updateHandlePosition();
            };
            const handleMouseOut = () => {
                handle.style.opacity = '0';
                handle.style.display = 'none';
            };
            node.on('mouseover', handleMouseOver);
            node.on('mouseout', handleMouseOut);
            node.scratch('_zkConnectionHandleListeners', {
                mouseover: handleMouseOver,
                mouseout: handleMouseOut
            });

            // 鼠标离开蓝点时：如果移向对应的卡片则不隐藏
            handle.addEventListener('mouseleave', (e: MouseEvent) => {
                const imageCard = this.container?.querySelector(`.zk-image-preview-card[data-node-id="${nodeId}"]`);
                if (imageCard && (e.relatedTarget === imageCard || imageCard.contains(e.relatedTarget as Node))) return;
                const embedCard = this.container?.querySelector(`.zk-embed-preview-card[data-node-id="${nodeId}"]`);
                if (embedCard && (e.relatedTarget === embedCard || embedCard.contains(e.relatedTarget as Node))) return;
                handle.style.opacity = '0';
                handle.style.display = 'none';
            });

            // 拖动创建连接
            this.bindConnectionDrag(handle, node, handleContainer);
        });

        // 注册到统一 overlay 调度器
        const connectionPositionUpdater = () => handleUpdaters.forEach(updater => updater());
        this.overlayUpdaters.add(connectionPositionUpdater);
        this.overlayImmediateUpdaters.add(connectionPositionUpdater);
    }

    /**
     * 绑定连线拖动事件
     */
    private bindConnectionDrag(handle: HTMLElement, sourceNode: any, container: HTMLElement): void {
        if (!this.cy || !this.container) return;

        let isDragging = false;
        let dragLine: SVGLineElement | null = null;
        let svgOverlay: SVGSVGElement | null = null;
        // 仅在 mousedown 时往 document 挂 mousemove/mouseup，mouseup 立即解绑——
        // 否则每节点一份 handler 永驻 document，鼠标每动一次都要扫一遍所有节点。
        const detachDocListeners = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            handle.style.opacity = '1';

            // 创建 SVG 叠加层用于绘制连线
            svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 2;
            `;
            this.container!.appendChild(svgOverlay);

            // 创建连线 - 使用淡绿色（与智能连线一致）
            dragLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            dragLine.setAttribute('stroke', '#10b981');  // 淡绿色，表示可以创建子节点
            dragLine.setAttribute('stroke-width', '2');
            dragLine.setAttribute('stroke-dasharray', '5,5');  // 虚线
            dragLine.setAttribute('opacity', '0.8');  // 略微透明
            svgOverlay.appendChild(dragLine);

            const sourcePos = sourceNode.renderedPosition();
            dragLine.setAttribute('x1', sourcePos.x.toString());
            dragLine.setAttribute('y1', sourcePos.y.toString());
            dragLine.setAttribute('x2', sourcePos.x.toString());
            dragLine.setAttribute('y2', sourcePos.y.toString());

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        let dragMoveRafId: number | null = null;
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !dragLine || !this.cy) return;

            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;

            // 线条位置立即更新（轻量操作）
            const sourcePos = sourceNode.renderedPosition();
            dragLine.setAttribute('x1', sourcePos.x.toString());
            dragLine.setAttribute('y1', sourcePos.y.toString());
            dragLine.setAttribute('x2', mouseX.toString());
            dragLine.setAttribute('y2', mouseY.toString());

            // 节点命中检测通过 RAF 节流（遍历所有节点较重）
            if (dragMoveRafId !== null) return;
            dragMoveRafId = requestAnimationFrame(() => {
                dragMoveRafId = null;
                if (!isDragging || !dragLine || !this.cy) return;

                const mousePos = { x: mouseX, y: mouseY };
                const targetNode = this.getNodeAtPosition(mousePos);

                if (targetNode && targetNode !== sourceNode) {
                    dragLine.setAttribute('stroke', '#10b981');
                    dragLine.setAttribute('stroke-width', '3');
                    dragLine.setAttribute('opacity', '1');
                    targetNode.addClass('connection-target-hover');
                } else {
                    dragLine.setAttribute('stroke', '#10b981');
                    dragLine.setAttribute('stroke-width', '2');
                    dragLine.setAttribute('opacity', '0.8');
                    this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');
                }
            });
        };

        const handleMouseUp = async (e: MouseEvent) => {
            // 第一行解绑：无论后续走哪条 return 都不残留 document 监听
            detachDocListeners();
            if (!isDragging || !this.cy) return;

            isDragging = false;

            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;
            const mousePos = { x: mouseX, y: mouseY };

            // 检测目标节点
            const targetNode = this.getNodeAtPosition(mousePos);

            // 清理
            if (svgOverlay) {
                svgOverlay.remove();
                svgOverlay = null;
            }
            dragLine = null;
            this.cy.nodes('.connection-target-hover').removeClass('connection-target-hover');

            const sourceData = sourceNode.data();
            const sourceOriginalNode = sourceData.originalNode;
            const sourceId = sourceData.originalNodeId || sourceData.id;

            if (targetNode && targetNode !== sourceNode) {
                // 连接到现有节点 - 创建反向关系
                const targetData = targetNode.data();
                const targetOriginalNode = targetData.originalNode;
                const targetId = targetData.originalNodeId || targetData.id;

                this.container?.dispatchEvent(new CustomEvent('create-arrow-relation', {
                    detail: {
                        sourceId,
                        targetId,
                        sourceIsGroup: !!sourceData.isGroup,
                        targetIsGroup: !!targetData.isGroup,
                        sourceNode: sourceOriginalNode,
                        targetNode: targetOriginalNode
                    }
                }));
            } else {
                // 分组节点是容器语义，不支持从空白处创建子节点
                if (!sourceOriginalNode) {
                    return;
                }
                // 连接到空白处 - 创建子节点
                const modelPos = this.cy.pan();
                const zoom = this.cy.zoom();
                const graphX = (mouseX - modelPos.x) / zoom;
                const graphY = (mouseY - modelPos.y) / zoom;

                this.container?.dispatchEvent(new CustomEvent('create-child-node', {
                    detail: {
                        parentNode: sourceOriginalNode,
                        position: { x: graphX, y: graphY }
                    }
                }));
            }
        };

    }

    /**
     * 获取指定位置的节点
     */
    private getNodeAtPosition(pos: { x: number; y: number }): any {
        if (!this.cy) return null;

        // 优先命中普通节点，避免 group 大框覆盖其子节点点击区域
        const normalNodes = this.cy.nodes('[!isGroup][!isPlaceholder]');
        for (let i = 0; i < normalNodes.length; i++) {
            const node = normalNodes[i];
            const bb = node.renderedBoundingBox();

            if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
                return node;
            }
        }

        const groupNodes = this.cy.nodes('[?isGroup]');
        for (let i = 0; i < groupNodes.length; i++) {
            const node = groupNodes[i];
            const bb = node.renderedBoundingBox();
            
            if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
                return node;
            }
        }

        return null;
    }

    /**
     * 添加边控制点（用于手动调整弧度）
     */
    private addEdgeControlPoints(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的控制点容器
        const oldControlPointContainer = this.container.querySelector('.zk-edge-control-points');
        if (oldControlPointContainer) {
            oldControlPointContainer.remove();
        }

        // 创建控制点容器
        const controlPointContainer = document.createElement('div');
        controlPointContainer.className = 'zk-edge-control-points';
        controlPointContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 2;
        `;
        this.container.appendChild(controlPointContainer);

        // 监听边选中事件
        this.edgeControlSelectHandler = (evt: any) => {
            const edge = evt.target;
            this.isEdgeSelected = true;
            // 隐藏所有连线手柄（小蓝点），避免误触
            this.container?.querySelectorAll('.zk-connection-handle').forEach((h: Element) => {
                (h as HTMLElement).style.opacity = '0';
                (h as HTMLElement).style.pointerEvents = 'none';
            });
            this.showEdgeControlPoint(edge, controlPointContainer);
        };
        this.cy.on('select', 'edge', this.edgeControlSelectHandler);

        // 监听边取消选中事件
        this.edgeControlUnselectHandler = () => {
            this.isEdgeSelected = false;
            // 恢复连线手柄的事件响应
            this.container?.querySelectorAll('.zk-connection-handle').forEach((h: Element) => {
                (h as HTMLElement).style.pointerEvents = 'auto';
            });
            this.hideEdgeControlPoints(controlPointContainer);
        };
        this.cy.on('unselect', 'edge', this.edgeControlUnselectHandler);

        // 监听边移除事件，确保控制点被清除
        this.edgeControlRemoveHandler = () => {
            this.isEdgeSelected = false;
            this.container?.querySelectorAll('.zk-connection-handle').forEach((h: Element) => {
                (h as HTMLElement).style.pointerEvents = 'auto';
            });
            this.hideEdgeControlPoints(controlPointContainer);
        };
        this.cy.on('remove', 'edge', this.edgeControlRemoveHandler);
    }

    /**
     * 显示边的控制点
     */
    private showEdgeControlPoint(edge: any, container: HTMLElement): void {
        if (!this.cy) return;

        // 清除旧的控制点
        this.hideEdgeControlPoints(container);

        const data = edge.data();
        const sourceNode = this.cy.$id(data.source);
        const targetNode = this.cy.$id(data.target);

        if (!sourceNode.length || !targetNode.length) return;

        // 获取当前弧度参数
        const distance = data.controlPointDistance !== undefined ? data.controlPointDistance : 0;  // 默认为 0
        const weight = data.controlPointWeight !== undefined ? data.controlPointWeight : 0.5;

        // 创建控制点
        const controlPoint = document.createElement('div');
        controlPoint.className = 'zk-edge-control-point';
        controlPoint.style.cssText = `
            position: absolute;
            width: 14px;
            height: 14px;
            background-color: rgba(148, 163, 184, 0.95);
            border: 2px solid rgba(255, 255, 255, 0.95);
            border-radius: 50%;
            cursor: grab;
            pointer-events: auto;
            transform: translate(-50%, -50%);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
            z-index: 1000;
        `;
        container.appendChild(controlPoint);

        // 计算控制点位置的函数 — 直接用 Cytoscape 的渲染中点，确保手柄在曲线上
        const updateControlPointPosition = () => {
            if (!this.cy || !edge.inside()) {
                controlPoint.style.display = 'none';
                return;
            }

            let mid: { x: number; y: number } | null = null;
            try {
                mid = edge.renderedMidpoint();
            } catch { /* edge may have been removed */ }

            if (mid && isFinite(mid.x) && isFinite(mid.y)) {
                controlPoint.style.display = 'block';
                controlPoint.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`;
            } else {
                controlPoint.style.display = 'none';
            }
        };

        // 初始位置
        updateControlPointPosition();

        // 注册到统一 overlay 调度器
        this.overlayUpdaters.add(updateControlPointPosition);
        this.overlayImmediateUpdaters.add(updateControlPointPosition);
        this.edgeControlPointUpdaters.add(updateControlPointPosition);

        // 拖动控制点
        let isDragging = false;
        let dragStartDistance = distance;
        let dragStartProjection = 0;
        const CURVATURE_DRAG_SENSITIVITY = 1.5;
        // 仅在 mousedown 时才挂 document 监听，避免每条选中边一份 handler 永驻
        const detachDocListeners = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        controlPoint.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const sourcePos = sourceNode.renderedPosition();
            const targetPos = targetNode.renderedPosition();
            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;
            const currentWeight = edge.data('controlPointWeight') !== undefined ? edge.data('controlPointWeight') : 0.5;
            const midX = sourcePos.x + (targetPos.x - sourcePos.x) * currentWeight;
            const midY = sourcePos.y + (targetPos.y - sourcePos.y) * currentWeight;
            const dx = targetPos.x - sourcePos.x;
            const dy = targetPos.y - sourcePos.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const perpX = -dy / len;
            const perpY = dx / len;

            isDragging = true;
            dragStartDistance = edge.data('controlPointDistance') !== undefined ? edge.data('controlPointDistance') : distance;
            dragStartProjection = (mouseX - midX) * perpX + (mouseY - midY) * perpY;
            controlPoint.style.cursor = 'grabbing';

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !this.cy) return;

            const sourcePos = sourceNode.renderedPosition();
            const targetPos = targetNode.renderedPosition();

            // 计算鼠标在画布上的位置
            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;

            // 计算边的中点和方向
            const currentWeight = edge.data('controlPointWeight') !== undefined ? edge.data('controlPointWeight') : 0.5;
            const midX = sourcePos.x + (targetPos.x - sourcePos.x) * currentWeight;
            const midY = sourcePos.y + (targetPos.y - sourcePos.y) * currentWeight;

            const dx = targetPos.x - sourcePos.x;
            const dy = targetPos.y - sourcePos.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const perpX = -dy / len;
            const perpY = dx / len;

            // 计算新的 distance（鼠标到边中点的垂直距离）
            const toMouseX = mouseX - midX;
            const toMouseY = mouseY - midY;
            const projectedDistance = toMouseX * perpX + toMouseY * perpY;
            const newDistance = dragStartDistance + (projectedDistance - dragStartProjection) * CURVATURE_DRAG_SENSITIVITY;

            // 更新边的弧度
            edge.data('controlPointDistance', newDistance);
            edge.data('controlPointWeight', currentWeight);

            // 立即更新控制点位置
            updateControlPointPosition();

            // 触发弧度变化事件
            this.container?.dispatchEvent(new CustomEvent('edge-curvature-changed', {
                detail: {
                    edgeId: `${data.originalSource}-${data.originalTarget}`,  // 使用原始 ID 格式
                    source: data.originalSource || data.source,
                    target: data.originalTarget || data.target,
                    distance: newDistance,
                    weight: currentWeight
                }
            }));
        };

        const handleMouseUp = () => {
            detachDocListeners();
            if (isDragging) {
                isDragging = false;
                controlPoint.style.cursor = 'grab';
            }
        };

        // 控制点 DOM 移除时（hideEdgeControlPoints 主动 remove）若拖拽中也兜底解绑
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node === controlPoint) {
                        detachDocListeners();
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(container, { childList: true });
    }

    /**
     * 隐藏边控制点
     */
    private hideEdgeControlPoints(container: HTMLElement): void {
        // 从统一调度器中移除边控制点的 updaters
        this.edgeControlPointUpdaters.forEach(fn => {
            this.overlayUpdaters.delete(fn);
            this.overlayImmediateUpdaters.delete(fn);
        });
        this.edgeControlPointUpdaters.clear();

        const controlPoints = container.querySelectorAll('.zk-edge-control-point');
        controlPoints.forEach(cp => cp.remove());
    }

    /**
     * 添加边端点手柄（用于拖动修改边的起点和终点）
     */
    private addEdgeEndpointHandles(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的端点手柄容器
        const oldContainer = this.container.querySelector('.zk-edge-endpoint-handles');
        if (oldContainer) {
            oldContainer.remove();
        }

        // 创建手柄容器
        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-edge-endpoint-handles';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 2;
        `;
        this.container.appendChild(handleContainer);

        // 监听边选中事件
        this.edgeEndpointSelectHandler = (evt: any) => {
            const edge = evt.target;
            this.showEdgeEndpointHandles(edge, handleContainer);
        };
        this.cy.on('select', 'edge', this.edgeEndpointSelectHandler);

        // 监听边取消选中事件
        this.edgeEndpointUnselectHandler = () => {
            this.hideEdgeEndpointHandles(handleContainer);
        };
        this.cy.on('unselect', 'edge', this.edgeEndpointUnselectHandler);

        // 监听边移除事件，确保手柄被清除
        this.edgeEndpointRemoveHandler = () => {
            this.hideEdgeEndpointHandles(handleContainer);
        };
        this.cy.on('remove', 'edge', this.edgeEndpointRemoveHandler);
    }

    /**
     * 显示边的端点手柄
     */
    private showEdgeEndpointHandles(edge: any, container: HTMLElement): void {
        // 清除旧的手柄
        this.hideEdgeEndpointHandles(container);

        const data = edge.data();
        const sourceNode = this.cy!.$id(data.source);
        const targetNode = this.cy!.$id(data.target);

        if (!sourceNode.length || !targetNode.length) return;

        // 检查约束：目标节点必须是叶子节点（nodeSons === 1）
        const targetData = targetNode.data();
        const originalTargetNode = targetData.originalNode;
        const canModifyTarget = originalTargetNode && originalTargetNode.nodeSons === 1;

        // 创建起点手柄（始终可用）
        const sourceHandle = this.createEndpointHandle('source', sourceNode, edge, container);

        // 创建终点手柄（仅当满足约束时）
        let targetHandle: HTMLElement | null = null;
        if (canModifyTarget) {
            targetHandle = this.createEndpointHandle('target', targetNode, edge, container);
        }

        // 注册到统一 overlay 调度器
        const endpointUpdater = () => {
            this.updateEndpointHandlePosition(sourceHandle, edge, 'source');
            if (targetHandle) {
                this.updateEndpointHandlePosition(targetHandle, edge, 'target');
            }
        };
        this.overlayUpdaters.add(endpointUpdater);
        this.edgeEndpointUpdaters.add(endpointUpdater);

        // 立即定位一次，避免手柄先在左上角闪现
        endpointUpdater();

        // 延迟两帧确保边渲染完成后再定位
        requestAnimationFrame(() => {
            requestAnimationFrame(endpointUpdater);
        });
    }

    /**
     * 创建端点手柄
     */
    private createEndpointHandle(
        type: 'source' | 'target',
        node: any,
        edge: any,
        container: HTMLElement
    ): HTMLElement {
        const handle = document.createElement('div');
        handle.className = `zk-edge-endpoint-handle zk-edge-endpoint-${type}`;
        // 避免初始布局前出现在(0,0)
        handle.style.display = 'none';
        container.appendChild(handle);

        // 绑定拖动事件
        this.bindEndpointHandleDrag(handle, type, node, edge, container);

        return handle;
    }

    /**
     * 更新端点手柄位置 — 直接使用 Cytoscape 的 renderedEndpoint API
     */
    private updateEndpointHandlePosition(handle: HTMLElement, edge: any, type: 'source' | 'target'): void {
        if (!this.cy || !edge.inside()) {
            handle.style.display = 'none';
            return;
        }

        let endpoint: { x: number; y: number } | null = null;
        try {
            endpoint = type === 'source'
                ? edge.renderedSourceEndpoint()
                : edge.renderedTargetEndpoint();
        } catch {
            // edge 可能已被移除
        }

        if (endpoint && isFinite(endpoint.x) && isFinite(endpoint.y)) {
            handle.style.display = 'block';
            handle.style.transform = `translate(${endpoint.x}px, ${endpoint.y}px) translate(-50%, -50%)`;
        } else {
            handle.style.display = 'none';
        }
    }

    /**
     * 隐藏边端点手柄
     */
    private hideEdgeEndpointHandles(container: HTMLElement): void {
        // 从统一调度器中移除边端点手柄的 updaters
        this.edgeEndpointUpdaters.forEach(fn => {
            this.overlayUpdaters.delete(fn);
        });
        this.edgeEndpointUpdaters.clear();

        const handles = container.querySelectorAll('.zk-edge-endpoint-handle');
        handles.forEach(h => h.remove());
    }

    /**
     * 绑定端点手柄拖动事件
     */
    private bindEndpointHandleDrag(
        handle: HTMLElement,
        type: 'source' | 'target',
        sourceOrTargetNode: any,
        edge: any,
        container: HTMLElement
    ): void {
        if (!this.cy || !this.container) return;

        let isDragging = false;
        let dragLine: SVGLineElement | null = null;
        let svgOverlay: SVGSVGElement | null = null;
        // 仅在 mousedown 时挂 document 监听，每条边端点不残留 handler
        const detachDocListeners = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            handle.style.cursor = 'grabbing';

            // 创建 SVG 覆盖层用于拖动线
            svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 2;
            `;
            this.container!.appendChild(svgOverlay);

            dragLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            dragLine.setAttribute('stroke', 'var(--interactive-accent, #3b82f6)');
            dragLine.setAttribute('stroke-width', '2');
            dragLine.setAttribute('stroke-dasharray', '6,4');
            svgOverlay.appendChild(dragLine);

            // 获取另一端节点位置作为拖动线的起始端
            const edgeData = edge.data();
            let startPos: { x: number; y: number };

            if (type === 'source') {
                const targetNode = this.cy!.$id(edgeData.target);
                startPos = targetNode.renderedPosition();
            } else {
                const sourceNode = this.cy!.$id(edgeData.source);
                startPos = sourceNode.renderedPosition();
            }

            dragLine.setAttribute('x1', startPos.x.toString());
            dragLine.setAttribute('y1', startPos.y.toString());
            dragLine.setAttribute('x2', startPos.x.toString());
            dragLine.setAttribute('y2', startPos.y.toString());

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        let endpointMoveRafId: number | null = null;
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !dragLine || !this.cy) return;

            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;

            // 线条位置立即更新
            const edgeData = edge.data();
            let startPos: { x: number; y: number };
            if (type === 'source') {
                const targetNode = this.cy!.$id(edgeData.target);
                startPos = targetNode.renderedPosition();
            } else {
                const sourceNode = this.cy!.$id(edgeData.source);
                startPos = sourceNode.renderedPosition();
            }
            dragLine.setAttribute('x1', startPos.x.toString());
            dragLine.setAttribute('y1', startPos.y.toString());
            dragLine.setAttribute('x2', mouseX.toString());
            dragLine.setAttribute('y2', mouseY.toString());

            // 节点命中检测通过 RAF 节流
            if (endpointMoveRafId !== null) return;
            endpointMoveRafId = requestAnimationFrame(() => {
                endpointMoveRafId = null;
                if (!isDragging || !dragLine || !this.cy) return;

                const mousePos = { x: mouseX, y: mouseY };
                const targetNode = this.getNodeAtPosition(mousePos);

                if (targetNode && targetNode !== sourceOrTargetNode) {
                    dragLine!.setAttribute('stroke', '#10b981');
                    targetNode.addClass('connection-target-hover');
                } else {
                    dragLine!.setAttribute('stroke', 'var(--interactive-accent, #3b82f6)');
                    this.cy!.nodes('.connection-target-hover').removeClass('connection-target-hover');
                }
            });
        };

        const handleMouseUp = async (e: MouseEvent) => {
            detachDocListeners();
            if (!isDragging || !this.cy) return;

            isDragging = false;

            const containerRect = this.container!.getBoundingClientRect();
            const mouseX = e.clientX - containerRect.left;
            const mouseY = e.clientY - containerRect.top;
            const mousePos = { x: mouseX, y: mouseY };

            // 检测目标节点
            const newTargetNode = this.getNodeAtPosition(mousePos);

            // 清理视觉元素
            if (svgOverlay) {
                svgOverlay.remove();
                svgOverlay = null;
            }
            dragLine = null;
            this.cy.nodes('.connection-target-hover').removeClass('connection-target-hover');
            handle.style.cursor = 'grab';

            // 如果连接到有效节点
            if (newTargetNode && newTargetNode !== sourceOrTargetNode) {
                const edgeData = edge.data();

                if (type === 'source') {
                    this.container?.dispatchEvent(new CustomEvent('edge-source-changed', {
                        detail: {
                            edgeId: edgeData.id,
                            edgeType: edgeData.type,
                            oldSource: edgeData.originalSource || edgeData.source,
                            newSource: newTargetNode.data().originalNode.IDStr,
                            target: edgeData.originalTarget || edgeData.target,
                            label: edgeData.label
                        }
                    }));
                } else if (type === 'target') {
                    // 检查新目标是否有子节点（约束）
                    const newTargetData = newTargetNode.data();
                    const newTargetNodeSons = newTargetData.originalNode.nodeSons;
                    if (newTargetNodeSons > 1) {
                        const { Notice } = require('obsidian');
                        new Notice('无法连接到有子节点的节点');
                        return;
                    }

                    const originalTargetNode = this.cy.$id(edgeData.target);
                    const oldTargetID = originalTargetNode.data().originalNode.IDStr;
                    const newTargetID = newTargetData.originalNode.IDStr;

                    this.container?.dispatchEvent(new CustomEvent('edge-target-changed', {
                        detail: {
                            edgeId: edgeData.id,
                            edgeType: edgeData.type,
                            source: edgeData.originalSource || edgeData.source,
                            oldTarget: oldTargetID,
                            newTarget: newTargetID,
                            label: edgeData.label
                        }
                    }));
                }
            }
        };

        // 端点手柄 DOM 移除时若拖拽中也兜底解绑（addEdgeEndpointHandles 会整体重建容器）
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node === handle) {
                        detachDocListeners();
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(container, { childList: true });
    }


    /**
     * 从选中的节点创建分组
     */
    private createGroupFromNodes(nodes: any[]): void {
        if (nodes.length === 0) return;

        // 过滤掉占位符节点和分组节点
        const validNodes = nodes.filter(node => {
            const data = node.data();
            return !data.isPlaceholder && !data.isGroup && data.originalNode;
        });

        if (validNodes.length === 0) return;

        // 获取节点 ID 列表
        const nodeIds = validNodes.map(node => node.data('originalNode').ID);

        // 检查是否有节点已经在某个分组中
        const existingGroups = this.findGroupsContainingNodes(nodeIds);

        if (existingGroups.length > 0) {
            // 有节点已经在分组中，询问用户是创建新分组还是添加到现有分组
            this.showGroupActionDialog(existingGroups, (action, targetGroupId) => {
                if (action === 'new') {
                    // 创建新分组
                    this.showGroupNameDialog((groupLabel) => {
                        if (!groupLabel) return;

                        const groupId = `group_${Date.now()}`;
                        this.container?.dispatchEvent(new CustomEvent('group-create', {
                            detail: { groupId, groupLabel, nodeIds }
                        }));
                    });
                } else if (action === 'add' && targetGroupId) {
                    // 添加到现有分组
                    this.container?.dispatchEvent(new CustomEvent('group-add-nodes', {
                        detail: { groupId: targetGroupId, nodeIds }
                    }));
                }
            });
        } else {
            // 没有节点在分组中，直接创建新分组
            this.showGroupNameDialog((groupLabel) => {
                if (!groupLabel) return;

                const groupId = `group_${Date.now()}`;
                this.container?.dispatchEvent(new CustomEvent('group-create', {
                    detail: { groupId, groupLabel, nodeIds }
                }));
            });
        }
    }

    /**
     * 查找包含指定节点的分组
     */
    private findGroupsContainingNodes(nodeIds: string[]): Array<{ id: string; label: string; nodeIds: string[] }> {
        const groups = this.currentData?.metadata?.groups || [];
        const result: Array<{ id: string; label: string; nodeIds: string[] }> = [];

        for (const group of groups) {
            // 检查是否有任何选中的节点在这个分组中
            const hasCommonNode = nodeIds.some(id => group.nodeIds.includes(id));
            if (hasCommonNode) {
                result.push(group);
            }
        }

        return result;
    }

    /**
     * 显示分组操作选择对话框
     */
    private showGroupActionDialog(
        existingGroups: Array<{ id: string; label: string; nodeIds: string[] }>,
        callback: (action: 'new' | 'add', groupId?: string) => void
    ): void {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 20px;
            min-width: 350px;
            max-width: 500px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;

        // 标题
        const title = document.createElement('h3');
        title.textContent = '选择操作';
        title.style.cssText = `
            margin: 0 0 15px 0;
            color: var(--text-normal);
            font-size: 16px;
        `;

        // 提示信息
        const info = document.createElement('p');
        info.textContent = '部分节点已在分组中，请选择操作：';
        info.style.cssText = `
            margin: 0 0 15px 0;
            color: var(--text-muted);
            font-size: 14px;
        `;

        // 选项容器
        const optionsContainer = document.createElement('div');
        optionsContainer.style.cssText = `
            margin-bottom: 20px;
        `;

        // 创建新分组选项
        const newGroupOption = document.createElement('div');
        newGroupOption.style.cssText = `
            padding: 10px;
            margin-bottom: 10px;
            border: 2px solid var(--background-modifier-border);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
        `;
        newGroupOption.innerHTML = `
            <div style="font-weight: 600; color: var(--text-normal); margin-bottom: 4px;">创建新分组</div>
            <div style="font-size: 12px; color: var(--text-muted);">将选中的节点创建为新的分组</div>
        `;
        newGroupOption.addEventListener('mouseenter', () => {
            newGroupOption.style.borderColor = '#5b8fd9';
            newGroupOption.style.backgroundColor = 'rgba(91, 143, 217, 0.1)';
        });
        newGroupOption.addEventListener('mouseleave', () => {
            newGroupOption.style.borderColor = 'var(--background-modifier-border)';
            newGroupOption.style.backgroundColor = 'transparent';
        });
        newGroupOption.addEventListener('click', () => {
            overlay.remove();
            callback('new');
        });

        optionsContainer.appendChild(newGroupOption);

        // 为每个现有分组创建选项
        existingGroups.forEach(group => {
            const groupOption = document.createElement('div');
            groupOption.style.cssText = `
                padding: 10px;
                margin-bottom: 10px;
                border: 2px solid var(--background-modifier-border);
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
            `;
            groupOption.innerHTML = `
                <div style="font-weight: 600; color: var(--text-normal); margin-bottom: 4px;">添加到「${group.label}」</div>
                <div style="font-size: 12px; color: var(--text-muted);">将新选中的节点添加到此分组（当前 ${group.nodeIds.length} 个节点）</div>
            `;
            groupOption.addEventListener('mouseenter', () => {
                groupOption.style.borderColor = '#5b8fd9';
                groupOption.style.backgroundColor = 'rgba(91, 143, 217, 0.1)';
            });
            groupOption.addEventListener('mouseleave', () => {
                groupOption.style.borderColor = 'var(--background-modifier-border)';
                groupOption.style.backgroundColor = 'transparent';
            });
            groupOption.addEventListener('click', () => {
                overlay.remove();
                callback('add', group.id);
            });

            optionsContainer.appendChild(groupOption);
        });

        // 取消按钮
        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.style.cssText = `
            width: 100%;
            padding: 8px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            cursor: pointer;
            font-size: 14px;
        `;
        cancelButton.addEventListener('click', () => {
            overlay.remove();
        });

        // 组装对话框
        dialog.appendChild(title);
        dialog.appendChild(info);
        dialog.appendChild(optionsContainer);
        dialog.appendChild(cancelButton);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    /**
     * 显示分组名称输入对话框
     */
    private showGroupNameDialog(callback: (name: string | null) => void, defaultValue: string = '分组1'): void {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 20px;
            min-width: 300px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;

        // 标题
        const title = document.createElement('h3');
        title.textContent = '创建分组';
        title.style.cssText = `
            margin: 0 0 15px 0;
            color: var(--text-normal);
            font-size: 16px;
        `;

        // 输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '请输入分组名称';
        input.value = defaultValue;
        input.style.cssText = `
            width: 100%;
            padding: 8px;
            margin-bottom: 15px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            font-size: 14px;
            box-sizing: border-box;
        `;

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        `;

        // 取消按钮
        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.style.cssText = `
            padding: 6px 16px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-primary);
            color: var(--text-normal);
            cursor: pointer;
            font-size: 14px;
        `;
        cancelButton.addEventListener('click', () => {
            overlay.remove();
            callback(null);
        });

        // 确认按钮
        const confirmButton = document.createElement('button');
        confirmButton.textContent = '确认';
        confirmButton.style.cssText = `
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            background-color: #5b8fd9;
            color: #ffffff;
            cursor: pointer;
            font-size: 14px;
        `;
        confirmButton.addEventListener('click', () => {
            const value = input.value.trim();
            overlay.remove();
            callback(value || null);
        });

        // 组装对话框
        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(confirmButton);
        dialog.appendChild(title);
        dialog.appendChild(input);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 自动聚焦输入框并选中文本
        setTimeout(() => {
            input.focus();
            input.select();
        }, 0);

        // 支持 Enter 键确认
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmButton.click();
            } else if (e.key === 'Escape') {
                cancelButton.click();
            }
        });

        // 点击遮罩层关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                cancelButton.click();
            }
        });
    }



    private attachInlineTextSelectionToolbar(inputEl: HTMLInputElement | HTMLTextAreaElement): {
        destroy: () => void;
        containsTarget: (target: Node | null) => boolean;
    } {
        if (!this.container) {
            return {
                destroy: () => undefined,
                containsTarget: () => false
            };
        }

        this.clearActiveTextSelectionToolbar();

        let toolbar: HTMLElement | null = null;
        let colorPanel: HTMLElement | null = null;
        let bgColorPanel: HTMLElement | null = null;
        let sizePanel: HTMLElement | null = null;
        const fontSizeChoices = [12, 14, 16, 18, 20, 24, 28];
        let lastSelection: { start: number; end: number } | null = null;

        const getSelectionRange = (): { start: number; end: number; length: number } => {
            const start = inputEl.selectionStart ?? 0;
            const end = inputEl.selectionEnd ?? 0;
            const length = Math.max(0, end - start);
            if (length > 0) {
                lastSelection = { start, end };
                return { start, end, length };
            }
            if (lastSelection && lastSelection.end > lastSelection.start) {
                return {
                    start: lastSelection.start,
                    end: lastSelection.end,
                    length: lastSelection.end - lastSelection.start
                };
            }
            return { start, end, length: 0 };
        };

        const applySelectionTransform = (formatter: (selectedText: string) => string) => {
            const { start, end, length } = getSelectionRange();
            if (length <= 0) return;
            const selectedText = inputEl.value.slice(start, end);
            const replacedText = formatter(selectedText);
            inputEl.focus();
            inputEl.setRangeText(replacedText, start, end, 'select');
            lastSelection = { start, end: start + replacedText.length };
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            updateToolbarVisibility();
        };

        const hideToolbar = () => {
            if (toolbar?.parentNode) {
                toolbar.remove();
            }
            toolbar = null;
            colorPanel = null;
            bgColorPanel = null;
            sizePanel = null;
        };

        const closeColorPanel = () => {
            if (colorPanel?.parentNode) {
                colorPanel.remove();
            }
            colorPanel = null;
        };

        const closeBgColorPanel = () => {
            if (bgColorPanel?.parentNode) {
                bgColorPanel.remove();
            }
            bgColorPanel = null;
        };

        const closeSizePanel = () => {
            if (sizePanel?.parentNode) {
                sizePanel.remove();
            }
            sizePanel = null;
        };

        const positionToolbar = () => {
            if (!toolbar || !this.container) return;
            const inputRect = inputEl.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            const toolbarWidth = toolbar.offsetWidth || 220;
            const x = inputRect.left - containerRect.left + inputRect.width / 2;
            const topSpace = inputRect.top - containerRect.top;
            const bottomSpace = containerRect.bottom - inputRect.bottom;
            let y = topSpace - 10;

            toolbar.classList.remove('zk-text-selection-toolbar-below');
            if (topSpace < 56 && bottomSpace > 56) {
                y = topSpace + inputRect.height + 10;
                toolbar.classList.add('zk-text-selection-toolbar-below');
            }

            const minX = toolbarWidth / 2 + 10;
            const maxX = (this.container.clientWidth || containerRect.width) - toolbarWidth / 2 - 10;
            const clampedX = Math.max(minX, Math.min(maxX, x));

            toolbar.style.left = `${clampedX}px`;
            toolbar.style.top = `${Math.max(8, y)}px`;
        };

        const createToolbarButton = (iconName: string, title: string, handler: () => void): HTMLButtonElement => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'zk-text-selection-btn';
            btn.title = title;
            setIcon(btn, iconName);
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                handler();
                inputEl.focus();
            });
            return btn;
        };

        const ensureToolbar = () => {
            if (toolbar || !this.container) return;
            toolbar = document.createElement('div');
            toolbar.className = 'zk-text-selection-toolbar';
            toolbar.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            toolbar.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            toolbar.appendChild(createToolbarButton('bold', '加粗', () => {
                applySelectionTransform((text) => `**${text}**`);
            }));
            toolbar.appendChild(createToolbarButton('underline', '下划线', () => {
                applySelectionTransform((text) => `<u>${text}</u>`);
            }));
            toolbar.appendChild(createToolbarButton('strikethrough', '删除线', () => {
                applySelectionTransform((text) => `~~${text}~~`);
            }));
            toolbar.appendChild(createToolbarButton('palette', '文字颜色', () => {
                if (!toolbar || !this.container) return;
                closeBgColorPanel();
                closeSizePanel();
                if (colorPanel) {
                    closeColorPanel();
                    return;
                }
                const initial = this.lastPickedTextColor ?? CytoscapeRenderer.DEFAULT_SELECTION_TEXT_COLOR;
                colorPanel = this.createSelectionColorPanel(initial, this.lastPickedTextColor, '自定义颜色', (color) => {
                    this.lastPickedTextColor = color;
                    applySelectionTransform((text) => `<span style='color: ${color};'>${text}</span>`);
                    closeColorPanel();
                });
                toolbar.appendChild(colorPanel);
            }));
            toolbar.appendChild(createToolbarButton('highlighter', '背景色', () => {
                if (!toolbar || !this.container) return;
                closeColorPanel();
                closeSizePanel();
                if (bgColorPanel) {
                    closeBgColorPanel();
                    return;
                }
                const initial = this.lastPickedBgColor ?? CytoscapeRenderer.DEFAULT_SELECTION_BG_COLOR;
                bgColorPanel = this.createSelectionColorPanel(initial, this.lastPickedBgColor, '自定义背景色', (color) => {
                    this.lastPickedBgColor = color;
                    applySelectionTransform((text) => `<span style='background-color: ${color};'>${text}</span>`);
                    closeBgColorPanel();
                });
                toolbar.appendChild(bgColorPanel);
            }));
            toolbar.appendChild(createToolbarButton('type', '字号', () => {
                if (!toolbar || !this.container) return;
                closeColorPanel();
                closeBgColorPanel();
                if (sizePanel) {
                    closeSizePanel();
                    return;
                }

                sizePanel = document.createElement('div');
                sizePanel.className = 'zk-text-selection-size-panel';
                sizePanel.addEventListener('pointerdown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                sizePanel.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });

                fontSizeChoices.forEach((size) => {
                    const sizeBtn = document.createElement('button');
                    sizeBtn.type = 'button';
                    sizeBtn.className = 'zk-text-selection-size-btn';
                    sizeBtn.textContent = `${size}px`;
                    sizeBtn.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    });
                    sizeBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        applySelectionTransform((text) => `<span style='font-size: ${size}px;'>${text}</span>`);
                        closeSizePanel();
                    });
                    sizePanel!.appendChild(sizeBtn);
                });

                const customWrap = document.createElement('div');
                customWrap.className = 'zk-text-selection-size-custom';
                const customInput = document.createElement('input');
                customInput.type = 'number';
                customInput.min = '8';
                customInput.max = '96';
                customInput.step = '1';
                customInput.value = '16';
                customInput.className = 'zk-text-selection-size-input';
                const customApply = document.createElement('button');
                customApply.type = 'button';
                customApply.className = 'zk-text-selection-size-apply';
                customApply.textContent = '应用';
                const applyCustomSize = () => {
                    const value = Number.parseInt(customInput.value, 10);
                    if (!Number.isFinite(value)) return;
                    const size = Math.min(96, Math.max(8, value));
                    applySelectionTransform((text) => `<span style='font-size: ${size}px;'>${text}</span>`);
                    closeSizePanel();
                };
                customApply.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                customApply.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    applyCustomSize();
                });
                customInput.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        applyCustomSize();
                    }
                });
                customWrap.appendChild(customInput);
                customWrap.appendChild(customApply);
                sizePanel.appendChild(customWrap);

                toolbar.appendChild(sizePanel);
            }));
            toolbar.appendChild(createToolbarButton('eraser', '清除格式', () => {
                applySelectionTransform((text) => this.stripInlineTextFormatting(text));
                closeColorPanel();
                closeBgColorPanel();
                closeSizePanel();
            }));

            this.container.appendChild(toolbar);
            positionToolbar();
        };

        const updateToolbarVisibility = () => {
            const activeEl = document.activeElement as Node | null;
            if (activeEl && toolbar?.contains(activeEl)) {
                ensureToolbar();
                positionToolbar();
                return;
            }
            const isFocused = document.activeElement === inputEl;
            const { length } = getSelectionRange();
            if (!isFocused || length <= 0) {
                hideToolbar();
                return;
            }
            ensureToolbar();
            positionToolbar();
        };

        const handleBlur = () => {
            setTimeout(() => {
                const activeEl = document.activeElement as Node | null;
                if (document.activeElement !== inputEl && !(activeEl && toolbar?.contains(activeEl))) {
                    hideToolbar();
                }
            }, 20);
        };

        inputEl.addEventListener('mouseup', updateToolbarVisibility);
        inputEl.addEventListener('keyup', updateToolbarVisibility);
        inputEl.addEventListener('select', updateToolbarVisibility);
        inputEl.addEventListener('input', updateToolbarVisibility);
        inputEl.addEventListener('scroll', positionToolbar);
        inputEl.addEventListener('blur', handleBlur);
        window.addEventListener('resize', positionToolbar);
        this.cy?.on('zoom pan', positionToolbar);

        const cleanup = () => {
            inputEl.removeEventListener('mouseup', updateToolbarVisibility);
            inputEl.removeEventListener('keyup', updateToolbarVisibility);
            inputEl.removeEventListener('select', updateToolbarVisibility);
            inputEl.removeEventListener('input', updateToolbarVisibility);
            inputEl.removeEventListener('scroll', positionToolbar);
            inputEl.removeEventListener('blur', handleBlur);
            window.removeEventListener('resize', positionToolbar);
            this.cy?.off('zoom pan', positionToolbar);
            hideToolbar();
            if (this.activeTextSelectionToolbarCleanup === cleanup) {
                this.activeTextSelectionToolbarCleanup = null;
            }
        };

        this.activeTextSelectionToolbarCleanup = cleanup;

        return {
            destroy: cleanup,
            containsTarget: (target: Node | null) => !!target && !!toolbar?.contains(target)
        };
    }

    private attachContentSelectionToolbar(
        rootEl: HTMLElement,
        applyTransform: (formatter: (selectedText: string) => string) => boolean
    ): {
        destroy: () => void;
        containsTarget: (target: Node | null) => boolean;
    } {
        if (!this.container) {
            return {
                destroy: () => undefined,
                containsTarget: () => false
            };
        }

        this.clearActiveTextSelectionToolbar();

        let toolbar: HTMLElement | null = null;
        let colorPanel: HTMLElement | null = null;
        let bgColorPanel: HTMLElement | null = null;
        let sizePanel: HTMLElement | null = null;
        const fontSizeChoices = [12, 14, 16, 18, 20, 24, 28];

        const getSelectionRect = (): DOMRect | null => {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
            const range = selection.getRangeAt(0);
            const anchorNode = range.commonAncestorContainer;
            if (!rootEl.contains(anchorNode)) return null;
            const rect = range.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) return rect;
            const clientRect = range.getClientRects()[0];
            return clientRect || null;
        };

        const hideToolbar = () => {
            if (toolbar?.parentNode) {
                toolbar.remove();
            }
            toolbar = null;
            colorPanel = null;
            bgColorPanel = null;
            sizePanel = null;
        };

        const closeColorPanel = () => {
            if (colorPanel?.parentNode) {
                colorPanel.remove();
            }
            colorPanel = null;
        };

        const closeBgColorPanel = () => {
            if (bgColorPanel?.parentNode) {
                bgColorPanel.remove();
            }
            bgColorPanel = null;
        };

        const closeSizePanel = () => {
            if (sizePanel?.parentNode) {
                sizePanel.remove();
            }
            sizePanel = null;
        };

        const positionToolbar = () => {
            if (!toolbar || !this.container) return;
            const rangeRect = getSelectionRect();
            if (!rangeRect) {
                return;
            }

            const containerRect = this.container.getBoundingClientRect();
            const toolbarWidth = toolbar.offsetWidth || 220;
            const x = rangeRect.left - containerRect.left + rangeRect.width / 2;
            const topSpace = rangeRect.top - containerRect.top;
            const bottomSpace = containerRect.bottom - rangeRect.bottom;
            let y = topSpace - 10;

            toolbar.classList.remove('zk-text-selection-toolbar-below');
            if (topSpace < 56 && bottomSpace > 56) {
                y = rangeRect.bottom - containerRect.top + 10;
                toolbar.classList.add('zk-text-selection-toolbar-below');
            }

            const minX = toolbarWidth / 2 + 10;
            const maxX = (this.container.clientWidth || containerRect.width) - toolbarWidth / 2 - 10;
            const clampedX = Math.max(minX, Math.min(maxX, x));

            toolbar.style.left = `${clampedX}px`;
            toolbar.style.top = `${Math.max(8, y)}px`;
        };

        const applyAndRefresh = (formatter: (selectedText: string) => string) => {
            if (!applyTransform(formatter)) return;
            updateToolbarVisibility();
        };

        const createToolbarButton = (iconName: string, title: string, handler: () => void): HTMLButtonElement => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'zk-text-selection-btn';
            btn.title = title;
            setIcon(btn, iconName);
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                handler();
            });
            return btn;
        };

        const ensureToolbar = () => {
            if (toolbar || !this.container) return;
            toolbar = document.createElement('div');
            toolbar.className = 'zk-text-selection-toolbar';
            toolbar.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            toolbar.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            toolbar.appendChild(createToolbarButton('bold', '加粗', () => {
                applyAndRefresh((text) => `**${text}**`);
            }));
            toolbar.appendChild(createToolbarButton('underline', '下划线', () => {
                applyAndRefresh((text) => `<u>${text}</u>`);
            }));
            toolbar.appendChild(createToolbarButton('strikethrough', '删除线', () => {
                applyAndRefresh((text) => `~~${text}~~`);
            }));
            toolbar.appendChild(createToolbarButton('palette', '文字颜色', () => {
                if (!toolbar || !this.container) return;
                closeBgColorPanel();
                closeSizePanel();
                if (colorPanel) {
                    closeColorPanel();
                    return;
                }
                const initial = this.lastPickedTextColor ?? CytoscapeRenderer.DEFAULT_SELECTION_TEXT_COLOR;
                colorPanel = this.createSelectionColorPanel(initial, this.lastPickedTextColor, '自定义颜色', (color) => {
                    this.lastPickedTextColor = color;
                    applyAndRefresh((text) => `<span style='color: ${color};'>${text}</span>`);
                    closeColorPanel();
                });
                toolbar.appendChild(colorPanel);
            }));
            toolbar.appendChild(createToolbarButton('highlighter', '背景色', () => {
                if (!toolbar || !this.container) return;
                closeColorPanel();
                closeSizePanel();
                if (bgColorPanel) {
                    closeBgColorPanel();
                    return;
                }
                const initial = this.lastPickedBgColor ?? CytoscapeRenderer.DEFAULT_SELECTION_BG_COLOR;
                bgColorPanel = this.createSelectionColorPanel(initial, this.lastPickedBgColor, '自定义背景色', (color) => {
                    this.lastPickedBgColor = color;
                    applyAndRefresh((text) => `<span style='background-color: ${color};'>${text}</span>`);
                    closeBgColorPanel();
                });
                toolbar.appendChild(bgColorPanel);
            }));
            toolbar.appendChild(createToolbarButton('type', '字号', () => {
                if (!toolbar || !this.container) return;
                closeColorPanel();
                closeBgColorPanel();
                if (sizePanel) {
                    closeSizePanel();
                    return;
                }

                sizePanel = document.createElement('div');
                sizePanel.className = 'zk-text-selection-size-panel';
                sizePanel.addEventListener('pointerdown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                sizePanel.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });

                fontSizeChoices.forEach((size) => {
                    const sizeBtn = document.createElement('button');
                    sizeBtn.type = 'button';
                    sizeBtn.className = 'zk-text-selection-size-btn';
                    sizeBtn.textContent = `${size}px`;
                    sizeBtn.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    });
                    sizeBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        applyAndRefresh((text) => `<span style='font-size: ${size}px;'>${text}</span>`);
                        closeSizePanel();
                    });
                    sizePanel!.appendChild(sizeBtn);
                });

                const customWrap = document.createElement('div');
                customWrap.className = 'zk-text-selection-size-custom';
                const customInput = document.createElement('input');
                customInput.type = 'number';
                customInput.min = '8';
                customInput.max = '96';
                customInput.step = '1';
                customInput.value = '16';
                customInput.className = 'zk-text-selection-size-input';
                const customApply = document.createElement('button');
                customApply.type = 'button';
                customApply.className = 'zk-text-selection-size-apply';
                customApply.textContent = '应用';
                const applyCustomSize = () => {
                    const value = Number.parseInt(customInput.value, 10);
                    if (!Number.isFinite(value)) return;
                    const size = Math.min(96, Math.max(8, value));
                    applyAndRefresh((text) => `<span style='font-size: ${size}px;'>${text}</span>`);
                    closeSizePanel();
                };
                customApply.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                customApply.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    applyCustomSize();
                });
                customInput.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        applyCustomSize();
                    }
                });
                customWrap.appendChild(customInput);
                customWrap.appendChild(customApply);
                sizePanel.appendChild(customWrap);

                toolbar.appendChild(sizePanel);
            }));
            toolbar.appendChild(createToolbarButton('eraser', '清除格式', () => {
                applyAndRefresh((text) => this.stripInlineTextFormatting(text));
                closeColorPanel();
                closeBgColorPanel();
                closeSizePanel();
            }));

            this.container.appendChild(toolbar);
            positionToolbar();
        };

        const updateToolbarVisibility = () => {
            const activeEl = document.activeElement as Node | null;
            if (activeEl && toolbar?.contains(activeEl)) {
                ensureToolbar();
                positionToolbar();
                return;
            }
            const isFocused = rootEl.contains(document.activeElement);
            const hasSelection = !!getSelectionRect();
            if (!isFocused || !hasSelection) {
                hideToolbar();
                return;
            }
            ensureToolbar();
            positionToolbar();
        };

        const handleSelectionChange = () => updateToolbarVisibility();
        const handleBlur = () => {
            setTimeout(() => {
                const activeEl = document.activeElement as Node | null;
                if (!rootEl.contains(document.activeElement) && !(activeEl && toolbar?.contains(activeEl))) {
                    hideToolbar();
                }
            }, 20);
        };

        document.addEventListener('selectionchange', handleSelectionChange);
        rootEl.addEventListener('mouseup', updateToolbarVisibility, true);
        rootEl.addEventListener('keyup', updateToolbarVisibility, true);
        rootEl.addEventListener('scroll', positionToolbar, true);
        rootEl.addEventListener('focusout', handleBlur, true);
        window.addEventListener('resize', positionToolbar);
        this.cy?.on('zoom pan', positionToolbar);

        const cleanup = () => {
            document.removeEventListener('selectionchange', handleSelectionChange);
            rootEl.removeEventListener('mouseup', updateToolbarVisibility, true);
            rootEl.removeEventListener('keyup', updateToolbarVisibility, true);
            rootEl.removeEventListener('scroll', positionToolbar, true);
            rootEl.removeEventListener('focusout', handleBlur, true);
            window.removeEventListener('resize', positionToolbar);
            this.cy?.off('zoom pan', positionToolbar);
            hideToolbar();
            if (this.activeTextSelectionToolbarCleanup === cleanup) {
                this.activeTextSelectionToolbarCleanup = null;
            }
        };

        this.activeTextSelectionToolbarCleanup = cleanup;

        return {
            destroy: cleanup,
            containsTarget: (target: Node | null) => !!target && !!toolbar?.contains(target)
        };
    }

    /**
     * 显示内联边标签编辑器
     */
    private showInlineEdgeLabelEditor(edge: any): void {
        if (!this.cy || !this.container || this.isReadOnlyMode()) return;

        const data = edge.data();
        const currentLabel = data.label || '';

        // 移除已存在的编辑器
        const existingEditor = this.container.querySelector('.edge-label-editor');
        if (existingEditor) {
            existingEditor.remove();
        }

        // 获取边的中点位置
        const sourceNode = this.cy.$id(data.source);
        const targetNode = this.cy.$id(data.target);
        
        if (!sourceNode.length || !targetNode.length) return;

        const sourcePos = sourceNode.renderedPosition();
        const targetPos = targetNode.renderedPosition();
        const midX = (sourcePos.x + targetPos.x) / 2;
        const midY = (sourcePos.y + targetPos.y) / 2;

        // 创建输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentLabel;
        input.className = 'edge-label-editor';
        input.style.cssText = `
            position: absolute;
            left: ${midX}px;
            top: ${midY}px;
            transform: translate(-50%, -50%);
            padding: 6px 14px;
            border: 2px solid rgba(91, 143, 217, 0.95);
            border-radius: 12px;
            background: rgba(15, 23, 42, 0.96);
            color: var(--text-normal);
            font-size: 13px;
            font-weight: 500;
            z-index: 1000;
            min-width: 100px;
            text-align: center;
            outline: none;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
            backdrop-filter: blur(8px);
        `;

        this.container.appendChild(input);
        const selectionToolbar = this.attachInlineTextSelectionToolbar(input);

        // 自动聚焦并选中文本
        setTimeout(() => {
            input.focus();
            input.select();
        }, 0);

        // 标记是否已保存，避免重复触发
        let isSaved = false;

        // 保存函数
        const saveLabel = () => {
            if (isSaved) return;  // 避免重复保存
            isSaved = true;
            selectionToolbar.destroy();
            
            const newLabel = input.value.trim();
            
            if (newLabel !== currentLabel) {
                // 触发边标签编辑事件
                this.container?.dispatchEvent(new CustomEvent('edge-label-edit', {
                    detail: {
                        edgeId: data.id,
                        source: data.originalSource || data.source,
                        target: data.originalTarget || data.target,
                        oldLabel: currentLabel,
                        newLabel: newLabel
                    }
                }));
            }
            
            // 安全地移除输入框
            if (input.parentNode) {
                input.remove();
            }
        };

        // Enter 键保存，Delete 键（全选时清空），Escape 键取消
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                saveLabel();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                isSaved = true;  // 标记为已处理
                selectionToolbar.destroy();
                if (input.parentNode) {
                    input.remove();
                }
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // 检查文本框是否全选
                if (input.selectionStart === 0 && input.selectionEnd === input.value.length) {
                    // 全选状态：清空输入框
                    e.preventDefault();
                    e.stopPropagation();
                    input.value = '';
                } else {
                    // 非全选状态：阻止事件冒泡，允许默认删除行为
                    e.stopPropagation();
                }
            }
        });

        // 失去焦点时保存
        input.addEventListener('blur', () => {
            // 使用 setTimeout 确保在其他事件处理后执行
            setTimeout(() => {
                saveLabel();
            }, 0);
        });

        // 监听图形缩放和平移，更新输入框位置
        const updatePosition = () => {
            if (!this.cy) return;
            
            const sourcePos = sourceNode.renderedPosition();
            const targetPos = targetNode.renderedPosition();
            const midX = (sourcePos.x + targetPos.x) / 2;
            const midY = (sourcePos.y + targetPos.y) / 2;
            
            input.style.left = `${midX}px`;
            input.style.top = `${midY}px`;
        };

        this.cy.on('zoom pan', updatePosition);

        // 输入框移除时清理事件监听
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node === input && this.cy) {
                        this.cy.off('zoom pan', updatePosition);
                        selectionToolbar.destroy();
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(this.container, { childList: true });
    }

    /**
     * 显示占位符节点的内联编辑器
     */
    private showInlineNodeEditor(node: any): void {
        if (!this.cy || !this.container || this.isReadOnlyMode()) return;

        const data = node.data();
        const originalNode = data.originalNode;
        const isPlaceholder = !!data.isPlaceholder;
        const isExistingNode = !!originalNode && !data.isGroup;
        console.log('[ZK][InlineEdit] showInlineNodeEditor', {
            isPlaceholder,
            isExistingNode,
            isTextOnly: !!originalNode?.isTextOnly,
            nodeId: node.id?.(),
            originalNodeId: data.originalNodeId || originalNode?.IDStr || originalNode?.ID || null,
        });
        if (!isPlaceholder && !isExistingNode) return;

        this.ensureNodeVisibleInViewport(node);

        // 移除已存在的编辑器
        const existingEditor = this.container.querySelector('.node-label-editor');
        if (existingEditor) {
            existingEditor.remove();
        }

        // 占位符节点：使用与文本节点一致的 CM6 编辑器
        if (isPlaceholder) {
            this.startPlaceholderInPlaceEdit(node);
            return;
        }

        // 文本节点：原地编辑（在已有 overlay 内部直接编辑，不创建悬浮 textarea）
        if (!isPlaceholder && originalNode?.isTextOnly) {
            const rawSource = String(
                originalNode.title
                || originalNode.displayText
                || data.label
                || ''
            ).replace(/\\n/g, '\n');
            const sourcePath = this.currentData?.metadata?.currentFile || '';
            const nodeCacheId = String(
                data.originalNodeId
                || originalNode.IDStr
                || originalNode.ID
                || node.id?.()
                || ''
            );
            const cacheKey = `${sourcePath}||${nodeCacheId}||${rawSource}`;
            const cachedEntry = this.textMdOverlayCache.get(cacheKey);
            if (cachedEntry) {
                console.log('[ZK][InlineEdit] route=startInPlaceTextEdit', {
                    cacheKey,
                    hasCachedEntry: true,
                });
                this.startInPlaceTextEdit(node, originalNode, cachedEntry);
                return;
            }
        }

        console.log('[ZK][InlineEdit] route=showInlineNodeEditor:textarea-fallback', {
            isPlaceholder,
            isTextOnly: !!originalNode?.isTextOnly,
        });

        const renderedPosition = node.renderedPosition();
        const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
        const initialBoxWidth = Math.max(bb.w, 80);
        const initialBoxHeight = Math.max(bb.h, 44);
        const lockedBoxLeft = bb.x1;
        const lockedBoxTop = bb.y1;

        // 创建 textarea，直接覆盖在节点上
        const textarea = document.createElement('textarea');
        const originalDisplayLabel = data.label || '';
        const initialValue = isPlaceholder
            ? (data.label || '')
            : (originalNode?.isTextOnly
                ? (String(originalNode.title || originalNode.displayText || data.label || '').replace(/\\n/g, '\n'))
                : `${originalNode?.isEmbed ? '!' : ''}[[${originalNode?.file?.basename || originalNode?.title || ''}${(originalNode?.title && originalNode?.file?.basename && originalNode.title !== originalNode.file.basename) ? `|${originalNode.title}` : ''}]]`);
        textarea.value = initialValue;
        textarea.className = 'node-label-editor';
        const parsePx = (value: string | null | undefined, fallback: number): number => {
            const n = Number.parseFloat(value || '');
            return Number.isFinite(n) && n > 0 ? n : fallback;
        };
        const getRenderedNodeFontSize = (): string => {
            const renderedFontSize = node.renderedStyle?.('font-size');
            return (typeof renderedFontSize === 'string' && renderedFontSize.trim())
                ? renderedFontSize
                : (node.style('font-size') || '20px');
        };
        const getRenderedNodeFontFamily = (): string => {
            const renderedFontFamily = node.renderedStyle?.('font-family');
            return (typeof renderedFontFamily === 'string' && renderedFontFamily.trim())
                ? renderedFontFamily
                : (node.style('font-family') || 'inherit');
        };
        const getRenderedNodeFontWeight = (): string => {
            const renderedFontWeight = node.renderedStyle?.('font-weight');
            return (typeof renderedFontWeight === 'string' && renderedFontWeight.trim())
                ? renderedFontWeight
                : (node.style('font-weight') || '500');
        };
        const getEditorLineHeight = (): string => {
            const fontPx = parsePx(getRenderedNodeFontSize(), 20);
            return `${Math.round(fontPx * 1.35)}px`;
        };
        // 文本节点使用与 MD overlay 一致的字体和左对齐
        const isTextOnlyEdit = !!originalNode?.isTextOnly;
        const isRootEdit = !!data.isRoot && !data.isFreeNode;
        const nodeFontSize = isTextOnlyEdit
            ? (isRootEdit ? '26px' : '20px')
            : getRenderedNodeFontSize();
        const nodeFontFamily = getRenderedNodeFontFamily();
        const nodeFontWeight = isTextOnlyEdit
            ? (isRootEdit ? '700' : '500')
            : getRenderedNodeFontWeight();
        const nodeLineHeight = isTextOnlyEdit ? '1.35' : getEditorLineHeight();
        const textAlign = isRootEdit ? 'center' : 'left';
        const editorPadding = '24px 24px 12px 24px';

        // 锁定节点尺寸，防止清空标签后节点缩小
        const lockedWidth = node.width();
        const lockedHeight = node.height();
        node.style({ 'width': lockedWidth, 'height': lockedHeight });

        // 重要：在编辑时隐藏节点标签，避免重复显示
        node.data('label', '');

        textarea.style.cssText = `
            position: absolute;
            left: ${lockedBoxLeft}px;
            top: ${lockedBoxTop}px;
            width: ${initialBoxWidth}px;
            height: ${initialBoxHeight}px;
            transform: translate(0, 0);
            padding: ${editorPadding};
            border: 2px solid rgba(91, 143, 217, 0.95);
            border-radius: 16px;
            background: rgba(15, 23, 42, 0.96);
            color: var(--text-normal);
            font-size: ${nodeFontSize};
            font-family: ${nodeFontFamily};
            font-weight: ${nodeFontWeight};
            z-index: 1000;
            resize: none;
            overflow: hidden;
            outline: none;
            box-sizing: border-box;
            text-align: ${textAlign};
            line-height: ${nodeLineHeight};
            cursor: text;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
        `;

        this.container.appendChild(textarea);

        const insertTextareaNewline = () => {
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? start;
            textarea.setRangeText('\n', start, end, 'end');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const selectionToolbar = this.attachInlineTextSelectionToolbar(textarea);

        const measureCanvas = document.createElement('canvas');
        const measureContext = measureCanvas.getContext('2d');
        const resizeEditorToContent = () => {
            const minWidth = initialBoxWidth;
            const minHeight = initialBoxHeight;
            const containerWidth = this.container?.clientWidth || window.innerWidth;
            const containerHeight = this.container?.clientHeight || window.innerHeight;
            const maxWidth = Math.max(minWidth, Math.min(720, containerWidth - 24));
            const maxHeight = Math.max(minHeight, Math.min(460, containerHeight - 24));

            const computedStyle = window.getComputedStyle(textarea);
            const font = computedStyle.font || `${computedStyle.fontSize} ${computedStyle.fontFamily}`;
            const lines = textarea.value.split('\n');
            let contentWidth = minWidth;

            if (measureContext) {
                measureContext.font = font;
                contentWidth = lines.reduce((maxLineWidth, line) => {
                    const metrics = measureContext.measureText(line || ' ');
                    return Math.max(maxLineWidth, metrics.width + 28);
                }, minWidth);
            }

            const targetWidth = isRootEdit
                ? minWidth
                : Math.min(maxWidth, Math.max(minWidth, Math.ceil(contentWidth)));
            textarea.style.width = `${targetWidth}px`;
            textarea.style.height = 'auto';
            const targetHeight = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight + 4));
            textarea.style.height = `${targetHeight}px`;
            textarea.style.left = `${renderedPosition.x - targetWidth / 2}px`;
            textarea.style.top = `${renderedPosition.y - targetHeight / 2}px`;
        };

        // 自动聚焦并全选文本（方便删除）
        setTimeout(() => {
            textarea.focus();
            textarea.select();
            resizeEditorToContent();
        }, 0);

        // 标记是否已保存，避免重复触发
        let isSaved = false;
        const suggesterPopoverRef = { value: null as HTMLElement | null };

        const insertWikiLinkAtCursor = (file: any, embed: boolean) => {
            const cursorPos = textarea.selectionStart ?? textarea.value.length;
            const value = textarea.value;
            const triggerPatterns = ['![[', '！【【', '[[', '【【'];
            let triggerStart = -1;

            for (const pattern of triggerPatterns) {
                const idx = value.lastIndexOf(pattern, cursorPos);
                if (idx > triggerStart) {
                    triggerStart = idx;
                }
            }

            const before = triggerStart >= 0 ? value.slice(0, triggerStart) : value.slice(0, cursorPos);
            const after = triggerStart >= 0 ? value.slice(cursorPos) : value.slice(cursorPos);
            const wikiLink = this.buildWikiLinkForFile(file);
            const wikiText = `${embed ? '!' : ''}[[${wikiLink}]]`;

            textarea.value = `${before}${wikiText}${after}`;
            const newCursor = before.length + wikiText.length;
            textarea.setSelectionRange(newCursor, newCursor);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };

        // 保存函数
        const saveNode = async () => {
            const newLabel = textarea.value.trim();
            console.log('[ZK][InlineEditTextarea] saveNode', {
                rawValue: textarea.value,
                rawLength: textarea.value.length,
                trimmedLength: newLabel.length,
                endsWithNewline: textarea.value.endsWith('\n'),
            });

            if (!newLabel) {
                if (isPlaceholder) {
                    cancelEdit();
                }
                return;
            }

            if (isSaved) return;
            isSaved = true;
            // 恢复节点自动尺寸
            node.removeCss('width');
            node.removeCss('height');
            node.data('label', originalDisplayLabel);

            // 获取节点的实际位置（使用 position() 而不是 boundingBox）
            const nodePosition = node.position();
            const actualPosition = {
                x: nodePosition.x,
                y: nodePosition.y
            };

            if (isPlaceholder) {
                this.container?.dispatchEvent(new CustomEvent('placeholder-node-edit', {
                    detail: {
                        nodeId: data.id,
                        label: newLabel,
                        position: actualPosition,
                        suggestedNodeId: data.suggestedNodeId
                    }
                }));
            } else {
                this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
                    detail: {
                        node: originalNode,
                        content: newLabel,
                        position: actualPosition
                    }
                }));
            }

            // 清理
            if (textarea.parentNode) {
                textarea.remove();
            }
            selectionToolbar.destroy();
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                suggesterPopoverRef.value.remove();
            }

            // 将焦点返回给 container，以便键盘事件能被捕获
            this.container?.focus();
        };

        // 取消编辑函数
        const cancelEdit = () => {
            if (isSaved) return;
            isSaved = true;
            // 恢复节点自动尺寸
            node.removeCss('width');
            node.removeCss('height');
            node.data('label', isPlaceholder ? '' : originalDisplayLabel);
            if (isPlaceholder) {
                this.container?.dispatchEvent(new CustomEvent('placeholder-node-cancel', {
                    detail: {
                        nodeId: data.id
                    }
                }));
            }
            if (textarea.parentNode) {
                textarea.remove();
            }
            selectionToolbar.destroy();
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                suggesterPopoverRef.value.remove();
            }

            // 将焦点返回给 container，以便键盘事件能被捕获
            this.container?.focus();
        };

        // 事件监听器
        textarea.addEventListener('input', (e) => {
            // 阻止事件冒泡
            e.stopPropagation();
            // 不再实时更新节点标签，避免重复显示
            this.checkForLinkPattern(textarea, node, {
                x1: lockedBoxLeft,
                y1: lockedBoxTop,
                x2: lockedBoxLeft + initialBoxWidth,
                y2: lockedBoxTop + initialBoxHeight,
                w: initialBoxWidth,
                h: initialBoxHeight
            }, suggesterPopoverRef, handleLinkSelect);
            resizeEditorToContent();
        });

        // 阻止其他事件冒泡到 Cytoscape
        textarea.addEventListener('keyup', (e) => e.stopPropagation());
        textarea.addEventListener('keypress', (e) => e.stopPropagation());
        textarea.addEventListener('click', (e) => e.stopPropagation());
        textarea.addEventListener('mousedown', (e) => e.stopPropagation());

        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
            // 阻止事件冒泡到 Cytoscape，避免被其他事件处理器拦截
            e.stopPropagation();
            if (e.key === 'Enter') {
                console.log('[ZK][InlineEditTextarea] Enter keydown', {
                    metaKey: e.metaKey,
                    ctrlKey: e.ctrlKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey,
                    valueLength: textarea.value.length,
                });
            }

            // 如果 suggester 正在显示，ESC 键关闭 suggester，其他键让 suggester 的键盘处理器处理
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                if (e.key === 'Escape') {
                    // ESC 键关闭 suggester
                    e.preventDefault();
                    (suggesterPopoverRef.value as HTMLElement).remove();
                    return;
                }
                // 其他按键（方向键、Enter、删除键）由 suggester 的 handleKeyDown 处理
                return;
            }

            if (e.key === 'Enter') {
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    insertTextareaNewline();
                    return;
                }
                e.preventDefault();
                saveNode(); // Enter = 保存
            } else if (e.key === 'Escape') {
                // 取消编辑
                e.preventDefault();
                cancelEdit();
            }
            // 其他键（包括删除键）允许默认行为，不做任何处理
        });

        // 失去焦点时自动保存节点
        textarea.addEventListener('blur', () => {
            setTimeout(() => {
                // 如果焦点移到了 suggester 上，不保存
                if (suggesterPopoverRef.value && (suggesterPopoverRef.value as Node).contains(document.activeElement as Node)) {
                    return;
                }

                // 关闭 suggester
                if (suggesterPopoverRef.value) {
                    suggesterPopoverRef.value.remove();
                    suggesterPopoverRef.value = null;
                }

                if (!isSaved) {
                    saveNode();
                }
            }, 20);
        });

        // 点击编辑器外区域：自动保存；空内容占位符会自动取消创建
        const handleOutsidePointerDown = (e: MouseEvent) => {
            if (isSaved) return;
            const target = e.target as Node | null;
            if (!target) return;
            if (textarea.contains(target)) return;
            if (selectionToolbar.containsTarget(target)) return;
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.contains(target)) return;
            saveNode();
        };
        document.addEventListener('mousedown', handleOutsidePointerDown, true);

        // 监听图形缩放和平移，更新编辑器位置
        const updatePosition = () => {
            if (!this.cy) return;

            const currentRenderedPosition = node.renderedPosition();
            const currentBoxWidth = Math.max(Number(node.renderedWidth?.() || 0), 80);
            const currentBoxHeight = Math.max(Number(node.renderedHeight?.() || 0), 44);
            textarea.style.left = `${currentRenderedPosition.x - currentBoxWidth / 2}px`;
            textarea.style.top = `${currentRenderedPosition.y - currentBoxHeight / 2}px`;
            textarea.style.fontSize = isTextOnlyEdit ? '20px' : getRenderedNodeFontSize();
            textarea.style.fontFamily = getRenderedNodeFontFamily();
            textarea.style.fontWeight = isTextOnlyEdit ? '500' : getRenderedNodeFontWeight();
            textarea.style.lineHeight = isTextOnlyEdit ? '1.35' : getEditorLineHeight();
            resizeEditorToContent();
        };

        this.cy.on('zoom pan', updatePosition);

        // 编辑器移除时清理事件监听
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((removedNode) => {
                    if (removedNode === textarea && this.cy) {
                        this.cy.off('zoom pan', updatePosition);
                        selectionToolbar.destroy();
                        document.removeEventListener('mousedown', handleOutsidePointerDown, true);
                    }
                });
            });
        });

        observer.observe(this.container, { childList: true });

        const handleLinkSelect = (file: any, embed: boolean) => {
            if (isPlaceholder) {
                isSaved = true;
                if (textarea.parentNode) {
                    textarea.remove();
                }
                if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                    suggesterPopoverRef.value.remove();
                }
                this.container?.dispatchEvent(new CustomEvent('placeholder-node-complete', {
                    detail: {
                        nodeId: data.id,
                        wikiLink: this.buildWikiLinkForFile(file),
                        file,
                        isEmbed: embed
                    }
                }));
                this.container?.focus();
                return;
            }

            insertWikiLinkAtCursor(file, embed);
            saveNode();
        };
    }

    /**
     * 文本节点原地编辑（Live Preview 版）。
     * 若内部 API 反射失败，自动降级到 legacy textarea 实现。
     */
    private startInPlaceTextEdit(
        node: any,
        originalNode: ZKNode,
        entry: {
            el: HTMLElement;
            component: Component;
            mdEditor?: EmbeddableMarkdownEditor | null;
            width: number;
            height: number;
            isPlainText: boolean;
            usedInCycle: boolean;
        }
    ): void {
        if (!this.cy || !this.container) return;
        console.log('[ZK][TextNodeLiveEdit] startInPlaceTextEdit', {
            nodeId: node.id?.(),
            originalNodeId: originalNode.IDStr || originalNode.ID || null,
        });

        // 先卸载只读展示用的 editor，避免与可编辑 editor 冲突
        if (entry.mdEditor) {
            try { entry.mdEditor.unload(); } catch { /* ignore */ }
            entry.mdEditor = null;
        }

        this.ensureNodeVisibleInViewport(node);

        const overlayEl = entry.el;
        const savedHtml = overlayEl.innerHTML;
        const savedWidth = entry.width;
        const savedHeight = entry.height;
        const rawSource = String(
            originalNode.title
            || originalNode.displayText
            || node.data('label')
            || ''
        ).replace(/\\n/g, '\n');
        const sourcePath = this.currentData?.metadata?.currentFile || '';

        overlayEl.textContent = '';
        overlayEl.dataset.editing = '1';
        const prevPointerEvents = overlayEl.style.pointerEvents;
        overlayEl.style.pointerEvents = 'auto';

        const editorHost = document.createElement('div');
        editorHost.className = 'zk-text-md-live-edit-host';
        editorHost.style.cssText = `
            position: absolute;
            inset: 0;
            box-shadow: inset 0 0 0 2px rgba(91, 143, 217, 0.95);
            border-radius: 12px;
            overflow: auto;
            background: var(--background-primary);
            pointer-events: auto;
            z-index: 2;
        `;
        overlayEl.appendChild(editorHost);
        editorHost.addEventListener('focusin', (e: FocusEvent) => {
            console.log('[ZK][TextNodeLiveEdit] editorHost focusin', {
                targetClass: (e.target as HTMLElement | null)?.className ?? null,
                activeElementClass: (document.activeElement as HTMLElement | null)?.className ?? null,
            });
        }, true);
        editorHost.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                console.log('[ZK][TextNodeLiveEdit] editorHost keydown Enter', {
                    metaKey: e.metaKey,
                    ctrlKey: e.ctrlKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey,
                    targetClass: (e.target as HTMLElement | null)?.className ?? null,
                });
            }
        }, true);
        const logGlobalEnter = (scope: 'window' | 'document') => (e: KeyboardEvent) => {
            if (e.key !== 'Enter') return;
            const activeEl = document.activeElement as HTMLElement | null;
            const isInThisEditor = !!activeEl && editorHost.contains(activeEl);
            console.log(`[ZK][TextNodeLiveEdit] ${scope} keydown Enter`, {
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                shiftKey: e.shiftKey,
                altKey: e.altKey,
                isInThisEditor,
                activeElementClass: activeEl?.className ?? null,
                targetClass: (e.target as HTMLElement | null)?.className ?? null,
            });
            if (scope === 'window' && isInThisEditor && (e.shiftKey || e.metaKey || e.ctrlKey) && mdEditor) {
                console.log('[ZK][TextNodeLiveEdit] intercept Shift/Cmd/Ctrl+Enter at window', {
                    shiftKey: e.shiftKey,
                    metaKey: e.metaKey,
                    ctrlKey: e.ctrlKey,
                });
                e.preventDefault();
                e.stopPropagation();
                mdEditor.insertLineBreak();
            }
        };
        const onWindowKeyDown = logGlobalEnter('window');
        const onDocumentKeyDown = logGlobalEnter('document');
        window.addEventListener('keydown', onWindowKeyDown, true);
        document.addEventListener('keydown', onDocumentKeyDown, true);

        let isSaved = false;
        let mdEditor: EmbeddableMarkdownEditor | null = null;
        let selectionToolbar: { destroy: () => void; containsTarget: (target: Node | null) => boolean } | null = null;
        const nodeWasGrabbable = typeof node.grabbable === 'function' ? !!node.grabbable() : true;
        const prevZoomingEnabled = this.cy?.userZoomingEnabled() ?? true;
        if (typeof node.grabbable === 'function') {
            node.grabbable(false);
        }
        this.cy?.userZoomingEnabled(false);

        const stopPointerPropagation = (evt: Event) => {
            evt.stopPropagation();
        };
        const stopWheelPropagation = (evt: WheelEvent) => {
            evt.stopPropagation();
            // 触控板捏合/浏览器缩放手势不应继续传给白板缩放
            if (evt.ctrlKey || evt.metaKey) {
                evt.preventDefault();
            }
        };
        const pointerEventsToStop = [
            'mousedown', 'mousemove', 'mouseup',
            'pointerdown', 'pointermove', 'pointerup',
            'touchstart', 'touchmove', 'touchend',
            'dragstart', 'click', 'dblclick'
        ];
        pointerEventsToStop.forEach((name) => {
            editorHost.addEventListener(name, stopPointerPropagation, true);
        });
        editorHost.addEventListener('wheel', stopWheelPropagation, { capture: true, passive: false });

        const restoreNodeInteractivity = () => {
            if (this.cy && !node.removed() && typeof node.grabbable === 'function') {
                node.grabbable(nodeWasGrabbable);
            }
            this.cy?.userZoomingEnabled(prevZoomingEnabled);
        };

        const clearLiveEdit = () => {
            this.liveEditCleanupHandlers.delete(clearLiveEdit);
            selectionToolbar?.destroy();
            selectionToolbar = null;
            if (mdEditor) {
                mdEditor.unload();
                mdEditor = null;
            }
            (editorHost as any)._mdEditor = null;
            window.removeEventListener('keydown', onWindowKeyDown, true);
            document.removeEventListener('keydown', onDocumentKeyDown, true);
            pointerEventsToStop.forEach((name) => {
                editorHost.removeEventListener(name, stopPointerPropagation, true);
            });
            editorHost.removeEventListener('wheel', stopWheelPropagation, true);
        };
        this.liveEditCleanupHandlers.add(clearLiveEdit);

        const restoreOverlay = () => {
            clearLiveEdit();
            restoreNodeInteractivity();
            overlayEl.innerHTML = savedHtml;
            delete overlayEl.dataset.editing;
            overlayEl.style.pointerEvents = prevPointerEvents || 'none';
        };

        const cancelEdit = () => {
            if (isSaved) return;
            isSaved = true;
            restoreOverlay();
            if (this.cy && !node.removed()) {
                entry.width = savedWidth;
                entry.height = savedHeight;
                this.cy.batch(() => {
                    node.data('manualWidthModel', savedWidth);
                    node.data('manualHeightModel', savedHeight);
                    node.style({ width: savedWidth, height: savedHeight });
                });
            }
            this.container?.focus();
        };

        const saveEdit = () => {
            if (isSaved) return;
            const rawValue = (mdEditor?.getValue() ?? '').replace(/\r\n/g, '\n');
            console.log('[ZK][TextNodeLiveEdit] saveEdit', {
                rawValue,
                rawLength: rawValue.length,
                trimmedLength: rawValue.trim().length,
                endsWithNewline: rawValue.endsWith('\n'),
            });
            if (!rawValue.trim()) {
                cancelEdit();
                return;
            }
            isSaved = true;
            clearLiveEdit();
            restoreNodeInteractivity();
            overlayEl.style.pointerEvents = prevPointerEvents || 'none';

            const nodePosition = node.position();
            this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
                detail: {
                    node: originalNode,
                    content: rawValue,
                    position: { x: nodePosition.x, y: nodePosition.y }
                }
            }));
            this.container?.dispatchEvent(new CustomEvent('embed-node-size-changed', {
                detail: {
                    node: originalNode,
                    nodeId: node.data('originalNodeId') || originalNode.IDStr || originalNode.ID || '',
                    size: {
                        widthModel: Number(node.width()),
                        heightModel: Number(node.height())
                    }
                }
            }));

            setTimeout(() => {
                if (overlayEl.isConnected && overlayEl.dataset.editing === '1') {
                    overlayEl.innerHTML = savedHtml;
                    delete overlayEl.dataset.editing;
                    overlayEl.style.pointerEvents = prevPointerEvents || 'none';
                    restoreNodeInteractivity();
                }
            }, 50);

            this.container?.focus();
        };

        try {
            mdEditor = new EmbeddableMarkdownEditor({
                app: (window as any).app,
                containerEl: editorHost,
                initialValue: rawSource,
                sourcePath,
                onEnter: (_value, evt) => {
                    console.log('[ZK][TextNodeLiveEdit] onEnter', {
                        metaKey: evt.metaKey,
                        ctrlKey: evt.ctrlKey,
                        shiftKey: evt.shiftKey,
                        valueLength: _value.length,
                        endsWithNewline: _value.endsWith('\n'),
                    });
                    if (evt.shiftKey || evt.metaKey || evt.ctrlKey) return false; // Shift/Cmd/Ctrl+Enter = 换行
                    saveEdit();
                    return true; // Enter = 保存
                },
                onEscape: () => cancelEdit(),
                onBlur: () => {
                    if (!isSaved) saveEdit();
                },
            });
            (editorHost as any)._mdEditor = mdEditor;
            mdEditor.focus();
            console.log('[ZK][TextNodeLiveEdit] after mdEditor.focus', {
                activeElementClass: (document.activeElement as HTMLElement | null)?.className ?? null,
            });
            const editorDom = mdEditor.getDom();
            if (editorDom) {
                selectionToolbar = this.attachContentSelectionToolbar(editorHost, (formatter) => {
                    if (!mdEditor) return false;
                    return mdEditor.transformSelection(formatter);
                });
            }
        } catch (err) {
            console.warn('[ZK] Live preview unavailable, fallback to textarea', err);
            clearLiveEdit();
            editorHost.remove();
            delete overlayEl.dataset.editing;
            overlayEl.style.pointerEvents = prevPointerEvents || 'none';
            restoreNodeInteractivity();
            this.startInPlaceTextEditLegacy(node, originalNode, entry);
        }
    }

    /**
     * 占位符节点原地编辑（CM6 版），与文本节点编辑体验统一。
     * 提交时根据内容路由：[[xxx]] → 文件节点，![[xxx]] → 嵌入节点，其他 → 文本节点。
     */
    private startPlaceholderInPlaceEdit(node: any): void {
        if (!this.cy || !this.container) return;

        const data = node.data();

        this.ensureNodeVisibleInViewport(node);

        // 给占位符节点一个合理的编辑尺寸
        const defaultW = 240;
        const defaultH = 80;
        node.style({ width: defaultW, height: defaultH });

        // 创建临时 overlay，定位到节点位置
        const overlayEl = document.createElement('div');
        overlayEl.className = 'zk-text-md-overlay zk-placeholder-edit-overlay';
        overlayEl.dataset.baseFontSize = '20';
        overlayEl.style.cssText = `
            position: absolute;
            pointer-events: auto;
            box-sizing: border-box;
            z-index: 10;
            font-family: var(--font-text);
            font-weight: 500;
            line-height: 1.35;
        `;
        this.container.appendChild(overlayEl);

        // 同步 overlay 位置到节点(font-size * zoom 缩放,与文本节点 overlay 策略一致)
        const syncOverlayPos = () => {
            if (!this.cy || node.removed()) {
                overlayEl.style.display = 'none';
                return;
            }
            const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
            if (!bb || bb.w <= 0) { overlayEl.style.display = 'none'; return; }
            const zoom = this.cy.zoom();
            overlayEl.style.display = 'block';
            overlayEl.style.left = `${bb.x1}px`;
            overlayEl.style.top = `${bb.y1}px`;
            overlayEl.style.width = `${bb.w}px`;
            overlayEl.style.height = `${bb.h}px`;
            overlayEl.style.fontSize = `${20 * zoom}px`;
        };
        syncOverlayPos();

        // 创建 CM6 编辑器宿主
        const editorHost = document.createElement('div');
        editorHost.className = 'zk-text-md-live-edit-host';
        editorHost.style.cssText = `
            position: absolute;
            inset: 0;
            box-shadow: inset 0 0 0 2px rgba(91, 143, 217, 0.95);
            border-radius: 12px;
            overflow: auto;
            background: var(--background-primary);
            pointer-events: auto;
            z-index: 2;
        `;
        overlayEl.appendChild(editorHost);

        let isSaved = false;
        let mdEditor: EmbeddableMarkdownEditor | null = null;
        let selectionToolbar: { destroy: () => void; containsTarget: (target: Node | null) => boolean } | null = null;
        const nodeWasGrabbable = typeof node.grabbable === 'function' ? !!node.grabbable() : true;
        const prevZoomingEnabled = this.cy?.userZoomingEnabled() ?? true;
        if (typeof node.grabbable === 'function') {
            node.grabbable(false);
        }
        this.cy?.userZoomingEnabled(false);

        const stopPointerPropagation = (evt: Event) => { evt.stopPropagation(); };
        const stopWheelPropagation = (evt: WheelEvent) => {
            evt.stopPropagation();
            if (evt.ctrlKey || evt.metaKey) evt.preventDefault();
        };
        const pointerEventsToStop = [
            'mousedown', 'mousemove', 'mouseup',
            'pointerdown', 'pointermove', 'pointerup',
            'touchstart', 'touchmove', 'touchend',
            'dragstart', 'click', 'dblclick'
        ];
        pointerEventsToStop.forEach((name) => {
            editorHost.addEventListener(name, stopPointerPropagation, true);
        });
        editorHost.addEventListener('wheel', stopWheelPropagation, { capture: true, passive: false });

        const restoreNodeInteractivity = () => {
            if (this.cy && !node.removed() && typeof node.grabbable === 'function') {
                node.grabbable(nodeWasGrabbable);
            }
            this.cy?.userZoomingEnabled(prevZoomingEnabled);
        };

        const autoGrow = () => {
            if (!this.cy || node.removed()) return;
            const overflow = Math.max(mdEditor?.getVerticalOverflow() ?? 0, 0);
            if (overflow < 1) return;
            const curH = Number(node.height() || defaultH);
            const newH = Math.min(curH + overflow + 2, 720);
            if (newH <= curH) return;
            this.cy.batch(() => {
                node.style({ height: newH });
            });
            syncOverlayPos();
        };

        const cleanup = () => {
            selectionToolbar?.destroy();
            selectionToolbar = null;
            if (mdEditor) {
                mdEditor.unload();
                mdEditor = null;
            }
            pointerEventsToStop.forEach((name) => {
                editorHost.removeEventListener(name, stopPointerPropagation, true);
            });
            editorHost.removeEventListener('wheel', stopWheelPropagation, true);
            restoreNodeInteractivity();
            if (overlayEl.parentNode) overlayEl.remove();
            this.cy?.off('zoom pan', syncOverlayPos);
        };

        const cancelEdit = () => {
            if (isSaved) return;
            isSaved = true;
            cleanup();
            this.container?.dispatchEvent(new CustomEvent('placeholder-node-cancel', {
                detail: { nodeId: data.id }
            }));
            this.container?.focus();
        };

        const saveEdit = () => {
            if (isSaved) return;
            const newValue = (mdEditor?.getValue() ?? '').trim();
            if (!newValue) {
                cancelEdit();
                return;
            }
            isSaved = true;
            cleanup();

            const nodePosition = node.position();
            const position = { x: nodePosition.x, y: nodePosition.y };

            // 路由：检测 wiki link 模式
            const wikiMatch = newValue.match(/^(!)?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
            const fullWidthMatch = newValue.match(/^(！)?【【([^|】]+)(?:\|([^】]+))?】】$/);
            const match = wikiMatch || fullWidthMatch;

            if (match) {
                const isEmbed = !!match[1];
                const wikiLink = (match[2] || '').trim();
                if (wikiLink) {
                    // 文件/嵌入节点
                    this.container?.dispatchEvent(new CustomEvent('placeholder-node-edit', {
                        detail: {
                            nodeId: data.id,
                            label: newValue,
                            position,
                            suggestedNodeId: data.suggestedNodeId
                        }
                    }));
                    this.container?.focus();
                    return;
                }
            }

            // 纯文本/Markdown → 文本节点
            this.container?.dispatchEvent(new CustomEvent('placeholder-node-edit', {
                detail: {
                    nodeId: data.id,
                    label: newValue,
                    position,
                    suggestedNodeId: data.suggestedNodeId
                }
            }));
            this.container?.focus();
        };

        // 监听缩放/平移同步 overlay 位置
        this.cy.on('zoom pan', syncOverlayPos);

        const sourcePath = this.currentData?.metadata?.currentFile || '';

        try {
            mdEditor = new EmbeddableMarkdownEditor({
                app: (window as any).app,
                containerEl: editorHost,
                initialValue: '',
                sourcePath,
                onChange: () => autoGrow(),
                onEnter: (_value, evt) => {
                    if (evt.shiftKey || evt.metaKey || evt.ctrlKey) return false; // Shift/Cmd/Ctrl+Enter = 换行
                    saveEdit();
                    return true; // Enter = 保存
                },
                onEscape: () => cancelEdit(),
                onBlur: () => {
                    if (!isSaved) saveEdit();
                },
            });
            mdEditor.focus();
            const editorDom = mdEditor.getDom();
            if (editorDom) {
                selectionToolbar = this.attachContentSelectionToolbar(editorHost, (formatter) => {
                    if (!mdEditor) return false;
                    return mdEditor.transformSelection(formatter);
                });
            }
        } catch (err) {
            console.warn('[ZK] Placeholder live preview unavailable, fallback to textarea', err);
            cleanup();
            // 降级：回退到原有 textarea 方式
            this.startPlaceholderTextareaFallback(node);
        }
    }

    /**
     * 占位符节点 textarea 降级编辑（CM6 不可用时的后备）。
     */
    private startPlaceholderTextareaFallback(node: any): void {
        if (!this.cy || !this.container) return;
        const data = node.data();

        const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
        const boxW = Math.max(bb?.w || 0, 240);
        const boxH = Math.max(bb?.h || 0, 80);
        const renderedPosition = node.renderedPosition();

        const textarea = document.createElement('textarea');
        textarea.className = 'node-label-editor';
        textarea.value = '';
        textarea.style.cssText = `
            position: absolute;
            left: ${renderedPosition.x - boxW / 2}px;
            top: ${renderedPosition.y - boxH / 2}px;
            width: ${boxW}px;
            height: ${boxH}px;
            border: 2px solid rgba(91, 143, 217, 0.95);
            border-radius: 12px;
            background: var(--background-primary);
            color: var(--text-normal);
            font-size: 20px;
            font-family: var(--font-text);
            font-weight: 500;
            line-height: 1.35;
            padding: 24px 24px 12px 24px;
            outline: none;
            resize: none;
            overflow: hidden;
            box-sizing: border-box;
            z-index: 1000;
            text-align: left;
        `;
        this.container.appendChild(textarea);
        const insertTextareaNewline = () => {
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? start;
            textarea.setRangeText('\n', start, end, 'end');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };

        let isSaved = false;

        // 动态扩展：根据内容自动撑高编辑框
        const autoGrow = () => {
            if (!this.cy || node.removed()) return;
            textarea.style.height = 'auto';
            const contentH = textarea.scrollHeight + 4;
            const newH = Math.max(boxH, Math.min(contentH, 640));
            textarea.style.height = `${newH}px`;
            // 同步 Cytoscape 节点尺寸
            const curNodeH = Number(node.height() || boxH);
            if (newH !== curNodeH) {
                this.cy.batch(() => {
                    node.style({ height: newH });
                });
            }
            // 重新定位居中
            const rp = node.renderedPosition();
            textarea.style.left = `${rp.x - boxW / 2}px`;
            textarea.style.top = `${rp.y - newH / 2}px`;
        };

        const save = () => {
            if (isSaved) return;
            const val = textarea.value.trim();
            if (!val) { cancel(); return; }
            isSaved = true;
            textarea.remove();
            const pos = node.position();
            this.container?.dispatchEvent(new CustomEvent('placeholder-node-edit', {
                detail: { nodeId: data.id, label: val, position: { x: pos.x, y: pos.y }, suggestedNodeId: data.suggestedNodeId }
            }));
            this.container?.focus();
        };

        const cancel = () => {
            if (isSaved) return;
            isSaved = true;
            textarea.remove();
            this.container?.dispatchEvent(new CustomEvent('placeholder-node-cancel', {
                detail: { nodeId: data.id }
            }));
            this.container?.focus();
        };

        textarea.addEventListener('input', () => autoGrow());
        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    insertTextareaNewline();
                    return;
                }
                e.preventDefault();
                save(); // Enter = 保存
            } else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        textarea.addEventListener('keyup', (e) => e.stopPropagation());
        textarea.addEventListener('keypress', (e) => e.stopPropagation());
        textarea.addEventListener('click', (e) => e.stopPropagation());
        textarea.addEventListener('mousedown', (e) => e.stopPropagation());
        textarea.addEventListener('blur', () => { setTimeout(() => { if (!isSaved) save(); }, 20); });

        setTimeout(() => { textarea.focus(); autoGrow(); }, 0);
    }

    /**
     * 文本节点原地编辑（legacy textarea fallback）。
     */
    private startInPlaceTextEditLegacy(
        node: any,
        originalNode: ZKNode,
        entry: {
            el: HTMLElement;
            component: Component;
            mdEditor?: EmbeddableMarkdownEditor | null;
            width: number;
            height: number;
            isPlainText: boolean;
            usedInCycle: boolean;
        }
    ): void {
        if (!this.cy || !this.container) return;

        this.ensureNodeVisibleInViewport(node);

        const overlayEl = entry.el;
        const savedHtml = overlayEl.innerHTML;
        const savedWidth = entry.width;
        const savedHeight = entry.height;

        // 清空 overlay 并插入一个填满它的 textarea
        overlayEl.textContent = '';
        overlayEl.dataset.editing = '1';
        // 编辑时允许捕获点击事件（默认 overlay 是 pointer-events: none）
        const prevPointerEvents = overlayEl.style.pointerEvents;
        overlayEl.style.pointerEvents = 'auto';

        const textarea = document.createElement('textarea');
        textarea.className = 'node-label-editor zk-text-md-inline-editor';
        textarea.value = String(
            originalNode.title
            || originalNode.displayText
            || node.data('label')
            || ''
        ).replace(/\\n/g, '\n');
        textarea.style.cssText = `
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            background: transparent;
            border: 2px solid rgba(91, 143, 217, 0.95);
            border-radius: 12px;
            outline: none;
            padding: 24px 24px 12px 24px;
            margin: 0;
            color: var(--text-normal);
            font-size: 20px;
            font-family: var(--font-text);
            font-weight: 500;
            line-height: 1.35;
            text-align: left;
            resize: none;
            overflow: auto;
            box-sizing: border-box;
            white-space: pre-wrap;
            white-space: break-spaces;
            word-wrap: break-word;
            pointer-events: auto;
            user-select: text;
            z-index: 2;
        `;
        overlayEl.appendChild(textarea);
        const selectionToolbar = this.attachInlineTextSelectionToolbar(textarea);
        const insertTextareaNewline = () => {
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? start;
            textarea.setRangeText('\n', start, end, 'end');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const prevZoomingEnabled = this.cy?.userZoomingEnabled() ?? true;
        this.cy?.userZoomingEnabled(false);
        const stopTextareaWheelPropagation = (evt: WheelEvent) => {
            evt.stopPropagation();
            if (evt.ctrlKey || evt.metaKey) {
                evt.preventDefault();
            }
        };
        textarea.addEventListener('wheel', stopTextareaWheelPropagation, { capture: true, passive: false });

        let isSaved = false;
        const suggesterPopoverRef = { value: null as HTMLElement | null };

        // 聚焦 + 全选
        setTimeout(() => {
            textarea.focus();
            textarea.select();
        }, 0);

        const restoreOverlay = () => {
            // 清除编辑态，并恢复原 HTML（取消路径用）
            if (textarea.parentNode) textarea.remove();
            selectionToolbar.destroy();
            overlayEl.innerHTML = savedHtml;
            delete overlayEl.dataset.editing;
            overlayEl.style.pointerEvents = prevPointerEvents || 'none';
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                suggesterPopoverRef.value.remove();
                suggesterPopoverRef.value = null;
            }
            // 恢复节点尺寸
            if (this.cy && !node.removed() && (savedWidth !== entry.width || savedHeight !== entry.height)) {
                entry.width = savedWidth;
                entry.height = savedHeight;
                this.cy.batch(() => {
                    node.data('manualWidthModel', savedWidth);
                    node.data('manualHeightModel', savedHeight);
                    node.style({ width: savedWidth, height: savedHeight });
                });
            }
            document.removeEventListener('mousedown', handleOutsidePointerDown, true);
            textarea.removeEventListener('wheel', stopTextareaWheelPropagation, true);
            this.cy?.userZoomingEnabled(prevZoomingEnabled);
        };

        const saveEdit = () => {
            if (isSaved) return;
            const newValue = textarea.value.trim();
            if (!newValue) {
                // 空内容视为取消
                isSaved = true;
                restoreOverlay();
                this.container?.focus();
                return;
            }
            isSaved = true;

            // 先清理 textarea（防止 blur 递归）
            selectionToolbar.destroy();
            if (textarea.parentNode) textarea.remove();
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                suggesterPopoverRef.value.remove();
                suggesterPopoverRef.value = null;
            }
            document.removeEventListener('mousedown', handleOutsidePointerDown, true);
            overlayEl.style.pointerEvents = prevPointerEvents || 'none';
            // 不清除 dataset.editing —— 留到图重建后的 mark-sweep/detach 来清理；
            // 若内容未变化 indexView 会 return，下面的 fallback 会兜底恢复
            const nodePosition = node.position();
            this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
                detail: {
                    node: originalNode,
                    content: newValue,
                    position: { x: nodePosition.x, y: nodePosition.y }
                }
            }));
            this.container?.dispatchEvent(new CustomEvent('embed-node-size-changed', {
                detail: {
                    node: originalNode,
                    nodeId: node.data('originalNodeId') || originalNode.IDStr || originalNode.ID || '',
                    size: {
                        widthModel: Number(node.width()),
                        heightModel: Number(node.height())
                    }
                }
            }));

            // 兜底：若事件处理不触发重建（内容未变化），需要恢复 overlay 的原 HTML
            // 延迟一帧检查：若 overlayEl 仍存在且仍在 DOM 中且没有被新渲染填充，则恢复
            setTimeout(() => {
                if (overlayEl.isConnected && overlayEl.dataset.editing === '1') {
                    overlayEl.innerHTML = savedHtml;
                    delete overlayEl.dataset.editing;
                }
            }, 50);

            this.container?.focus();
        };

        const cancelEdit = () => {
            if (isSaved) return;
            isSaved = true;
            restoreOverlay();
            this.container?.focus();
        };

        // 事件监听
        textarea.addEventListener('input', (e) => {
            e.stopPropagation();
            this.checkForLinkPattern(textarea, node, node.renderedBoundingBox(), suggesterPopoverRef, handleLinkSelect);
        });
        textarea.addEventListener('keyup', (e) => e.stopPropagation());
        textarea.addEventListener('keypress', (e) => e.stopPropagation());
        textarea.addEventListener('click', (e) => e.stopPropagation());
        textarea.addEventListener('mousedown', (e) => e.stopPropagation());

        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
            e.stopPropagation();

            if (suggesterPopoverRef.value && suggesterPopoverRef.value.parentNode) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    (suggesterPopoverRef.value as HTMLElement).remove();
                    suggesterPopoverRef.value = null;
                    return;
                }
                return;
            }

            if (e.key === 'Enter') {
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    insertTextareaNewline();
                    return;
                }
                e.preventDefault();
                saveEdit(); // Enter = 保存
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
            }
        });

        textarea.addEventListener('blur', () => {
            setTimeout(() => {
                if (suggesterPopoverRef.value && (suggesterPopoverRef.value as Node).contains(document.activeElement as Node)) {
                    return;
                }
                if (suggesterPopoverRef.value) {
                    suggesterPopoverRef.value.remove();
                    suggesterPopoverRef.value = null;
                }
                if (!isSaved) {
                    saveEdit();
                }
            }, 20);
        });

        const handleOutsidePointerDown = (e: MouseEvent) => {
            if (isSaved) return;
            const target = e.target as Node | null;
            if (!target) return;
            if (textarea.contains(target)) return;
            if (selectionToolbar.containsTarget(target)) return;
            if (suggesterPopoverRef.value && suggesterPopoverRef.value.contains(target)) return;
            saveEdit();
        };
        document.addEventListener('mousedown', handleOutsidePointerDown, true);

        // [[ 触发的 wiki link 选择回调
        const handleLinkSelect = (file: any, _embed: boolean) => {
            const cursorPos = textarea.selectionStart ?? textarea.value.length;
            const value = textarea.value;
            const triggerPatterns = ['![[', '！【【', '[[', '【【'];
            let triggerStart = -1;
            for (const pattern of triggerPatterns) {
                const idx = value.lastIndexOf(pattern, cursorPos);
                if (idx > triggerStart) triggerStart = idx;
            }
            const before = triggerStart >= 0 ? value.slice(0, triggerStart) : value.slice(0, cursorPos);
            const after = triggerStart >= 0 ? value.slice(cursorPos) : value.slice(cursorPos);
            const wikiLink = this.buildWikiLinkForFile(file);
            const wikiText = `${_embed ? '!' : ''}[[${wikiLink}]]`;
            textarea.value = `${before}${wikiText}${after}`;
            const newCursor = before.length + wikiText.length;
            textarea.setSelectionRange(newCursor, newCursor);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            if (suggesterPopoverRef.value) {
                suggesterPopoverRef.value.remove();
                suggesterPopoverRef.value = null;
            }
            textarea.focus();
        };
    }

    private ensureNodeVisibleInViewport(node: any, padding: number = 40): void {
        if (!this.cy || !this.container || !node || node.length === 0) return;

        const box = node.renderedBoundingBox();
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        let dx = 0;
        let dy = 0;

        if (box.x1 < padding) {
            dx = padding - box.x1;
        } else if (box.x2 > containerWidth - padding) {
            dx = (containerWidth - padding) - box.x2;
        }

        if (box.y1 < padding) {
            dy = padding - box.y1;
        } else if (box.y2 > containerHeight - padding) {
            dy = (containerHeight - padding) - box.y2;
        }

        if (dx === 0 && dy === 0) {
            return;
        }

        const pan = this.cy.pan();
        this.cy.pan({
            x: pan.x + dx,
            y: pan.y + dy
        });
    }

    /**
     * 检查 [[ 链接模式
     */
    private checkForLinkPattern(
        textarea: HTMLTextAreaElement,
        node: any,
        boundingBox: any,
        suggesterPopoverRef: { value: HTMLElement | null },
        onSelectFile?: (file: any, isEmbed: boolean) => void
    ): void {
        const value = textarea.value;
        const cursorPos = textarea.selectionStart;

        // 检查用户是否刚刚输入了 '[[' / '【【' / '![[ ' / '！【【'
        const lastTwoChars = value.substring(cursorPos - 2, cursorPos);
        const lastThreeChars = value.substring(cursorPos - 3, cursorPos);

        // 移除现有的 suggester
        const existingSuggester = this.container?.querySelector('.node-link-suggester');
        if (existingSuggester) {
            existingSuggester.remove();
            suggesterPopoverRef.value = null;
        }

        // 如果模式匹配，显示 suggester
        if (lastTwoChars === '[[' || lastTwoChars === '【【' || lastThreeChars === '![[' || lastThreeChars === '！【【') {
            const isEmbed = lastThreeChars === '![[' || lastThreeChars === '！【【';
            this.showLinkSuggester(textarea, node, boundingBox, suggesterPopoverRef, isEmbed, onSelectFile);
        }
    }

    /**
     * 显示链接建议器
     */
    private showLinkSuggester(
        textarea: HTMLTextAreaElement,
        node: any,
        boundingBox: any,
        suggesterPopoverRef: { value: HTMLElement | null },
        isEmbed: boolean = false,
        onSelectFile?: (file: any, isEmbed: boolean) => void
    ): void {
        // 获取所有 markdown + moc 文件
        const app = (window as any).app;
        const files = app.vault.getAllLoadedFiles().filter((f: any) =>
            f.path.endsWith('.md') || f.path.endsWith('.moc')
        );

        // 创建 suggester popover
        const popover = document.createElement('div');
        popover.className = 'node-link-suggester';
        // 使用 textarea 的实际位置定位，避免 boundingBox 缺少 y2 或尺寸过期
        const suggesterLeft = textarea.offsetLeft;
        const suggesterTop = textarea.offsetTop + textarea.offsetHeight + 5;
        popover.style.cssText = `
            position: absolute;
            left: ${suggesterLeft}px;
            top: ${suggesterTop}px;
            max-height: 240px;
            width: 320px;
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 6px;
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
            z-index: 1001;
            overflow-y: auto;
            padding: 4px 0;
        `;

        // 搜索输入框
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search notes...';
        searchInput.style.cssText = `
            width: calc(100% - 16px);
            margin: 4px 8px;
            padding: 6px 8px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 4px;
            background-color: var(--background-secondary);
            color: var(--text-normal);
            font-size: 12px;
            position: sticky;
            top: 0;
            z-index: 2;
        `;

        // 存储当前的选中索引和文件列表
        let selectedIndex = 0;
        let currentFiles: any[] = [];

        // 过滤文件（显示前 10 个）
        let searchTerm = '';
        const updateFileList = () => {
            // 清除现有项目
            const existingItems = popover.querySelectorAll('.suggester-item');
            existingItems.forEach(item => item.remove());

            // 过滤并显示文件
            currentFiles = files
                .filter((file: any) => {
                    const lowerPath = file.path.toLowerCase();
                    const lowerName = file.basename.toLowerCase();
                    return lowerName.includes(searchTerm.toLowerCase()) ||
                           lowerPath.includes(searchTerm.toLowerCase());
                })
                .slice(0, 10);

            // 重置选中索引
            selectedIndex = 0;

            currentFiles.forEach((file: any, index: number) => {
                const item = document.createElement('div');
                item.className = 'suggester-item';
                item.dataset.index = index.toString();
                item.style.cssText = `
                    padding: 6px 12px;
                    cursor: pointer;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                `;

                item.innerHTML = `
                    <span style="font-weight: 500; color: var(--text-normal);">${file.basename}</span>
                    <span style="font-size: 11px; color: var(--text-muted);">${file.path}</span>
                `;

                // 高亮选中的项目
                if (index === selectedIndex) {
                    item.style.backgroundColor = 'var(--background-modifier-hover)';
                }

                item.addEventListener('mouseenter', () => {
                    // 移除所有高亮
                    popover.querySelectorAll('.suggester-item').forEach(i => {
                        (i as HTMLElement).style.backgroundColor = '';
                    });
                    // 高亮当前项
                    item.style.backgroundColor = 'var(--background-modifier-hover)';
                    selectedIndex = index;
                });

                item.addEventListener('click', () => {
                    selectFile(file);
                });

                popover.appendChild(item);
            });
        };

        // 选择文件并创建节点
        const selectFile = (file: any) => {
            // 移除 suggester
            popover.remove();
            if (onSelectFile) {
                onSelectFile(file, isEmbed);
                return;
            }

            // 兼容旧逻辑
            this.container?.dispatchEvent(new CustomEvent('add-free-node-from-suggester', {
                detail: {
                    nodeId: node.data().id,
                    wikiLink: this.buildWikiLinkForFile(file),
                    file: file,
                    isEmbed
                }
            }));
        };

        // 初始文件列表
        updateFileList();

        // 滚轮事件：优先滚动候选框，阻止冒泡到 Cytoscape（避免触发全局缩放）
        const handlePopoverWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            popover.scrollTop += e.deltaY;
        };

        popover.addEventListener('wheel', handlePopoverWheel, { passive: false });
        searchInput.addEventListener('wheel', handlePopoverWheel, { passive: false });

        // 候选框打开期间：拦截容器层滚轮，避免触发 Cytoscape 全局缩放
        const handleContainerWheelCapture = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            popover.scrollTop += e.deltaY;
        };
        this.container?.addEventListener('wheel', handleContainerWheelCapture, { passive: false, capture: true });

        // 候选框打开期间：临时禁用 Cytoscape 缩放/平移，避免画布交互干扰
        const prevZoomingEnabled = this.cy?.userZoomingEnabled() ?? true;
        const prevPanningEnabled = this.cy?.userPanningEnabled() ?? true;
        this.cy?.userZoomingEnabled(false);
        this.cy?.userPanningEnabled(false);

        // 搜索输入事件
        searchInput.addEventListener('input', (e) => {
            e.stopPropagation();
            searchTerm = (e.target as HTMLInputElement).value;
            updateFileList();
        });

        // 阻止搜索框的其他键盘事件冒泡到 Cytoscape（非导航键）
        searchInput.addEventListener('keyup', (e) => e.stopPropagation());
        searchInput.addEventListener('keypress', (e) => e.stopPropagation());

        // 更新选中高亮
        const updateSelection = () => {
            const items = popover.querySelectorAll('.suggester-item');
            items.forEach((item: any, index: number) => {
                if (index === selectedIndex) {
                    item.style.backgroundColor = 'var(--background-modifier-hover)';
                    // 滚动到可见区域
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.style.backgroundColor = '';
                }
            });
        };

        // 键盘导航
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                selectedIndex = Math.min(selectedIndex + 1, currentFiles.length - 1);
                updateSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                updateSelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (currentFiles[selectedIndex]) {
                    selectFile(currentFiles[selectedIndex]);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                popover.remove();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // 阻止删除键冒泡到 Cytoscape，允许在输入框中正常删除
                e.stopPropagation();
            }
        };

        // 监听键盘事件（在 textarea 和 searchInput 上）
        textarea.addEventListener('keydown', handleKeyDown);
        searchInput.addEventListener('keydown', handleKeyDown);

        // 将 popover 引用保存到外部变量，以便其他代码可以访问
        suggesterPopoverRef.value = popover;

        // suggester 移除时清理事件监听
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((removedNode) => {
                    if (removedNode === popover) {
                        textarea.removeEventListener('keydown', handleKeyDown);
                        searchInput.removeEventListener('keydown', handleKeyDown);
                        popover.removeEventListener('wheel', handlePopoverWheel as EventListener);
                        searchInput.removeEventListener('wheel', handlePopoverWheel as EventListener);
                        this.container?.removeEventListener('wheel', handleContainerWheelCapture as EventListener, true);
                        this.cy?.userZoomingEnabled(prevZoomingEnabled);
                        this.cy?.userPanningEnabled(prevPanningEnabled);
                        if (suggesterPopoverRef.value === popover) {
                            suggesterPopoverRef.value = null;
                        }
                        observer.disconnect();
                    }
                });
            });
        });

        observer.observe(this.container!, { childList: true });

        if (popover.firstChild) {
            popover.insertBefore(searchInput, popover.firstChild);
        } else {
            popover.appendChild(searchInput);
        }

        if (this.container) {
            this.container.appendChild(popover);
        }

        // 自动聚焦搜索框
        const focusSearchInput = () => {
            searchInput.focus();
            searchInput.setSelectionRange(0, searchInput.value.length);
        };
        requestAnimationFrame(focusSearchInput);
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        if (!this.cy || !this.container) return;

        // 绑定分组创建事件（Command + 拖动）- 已禁用
        // this.bindGroupCreationEvents();

        // 节点点击事件（单击选中；Command/Ctrl + 单击打开文件节点）
        this.cy.on('tap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 如果是分组节点或占位符节点，不触发普通节点点击事件
            if (data.isGroup) {
                return;
            }
            if (data.isPlaceholder) {
                return;  // 占位符节点不触发点击事件
            }

            // 清除之前的高亮（使用filter避免selector转义问题）
            this.cy?.edges('.child-edge-highlight').removeClass('child-edge-highlight');

            // 递归高亮所有后代节点的边
            const nodeId = node.id();
            const visited = new Set<string>();  // 防止循环引用导致无限递归
            const highlightChildEdges = (sourceNodeId: string) => {
                // 检查是否已访问过，避免循环引用
                if (visited.has(sourceNodeId)) {
                    return;
                }
                visited.add(sourceNodeId);

                // 获取从当前节点出发的所有边（使用filter避免selector转义问题）
                const outgoingEdges = this.cy?.edges().filter((edge: any) => edge.data('source') === sourceNodeId);
                if (!outgoingEdges || outgoingEdges.length === 0) {
                    return;
                }

                // 高亮当前层的边
                outgoingEdges.addClass('child-edge-highlight');

                // 递归处理子节点
                outgoingEdges.forEach((edge: any) => {
                    const targetNodeId = edge.data('target');
                    highlightChildEdges(targetNodeId);
                });
            };

            // 从当前节点开始递归高亮
            highlightChildEdges(nodeId);

            // 跨领域节点：单击只选中，不跳转（跳转到双击处理）
            if (data.isCrossDomain) {
                // 只选中节点，不触发跳转
                // 触发选中事件以便其他功能使用
                this.container?.dispatchEvent(new CustomEvent('node-select', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent
                    }
                }));
                return;
            }

            // 普通节点：单击只选中，不打开文件
            // 触发自定义事件（用于其他功能，如高亮等）
            this.container?.dispatchEvent(new CustomEvent('node-select', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent
                }
            }));
        });

        // 节点双击事件（编辑内容）
        this.cy.on('dbltap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 如果是分组节点，不触发
            if (data.isGroup) {
                return;
            }

            // 占位符节点：双击显示内联编辑器
            if (data.isPlaceholder) {
                this.showInlineNodeEditor(node);
                return;
            }

            // 跨领域节点：双击触发跳转
            if (data.isCrossDomain) {
                // 触发跳转事件，传递 originalNode
                this.container?.dispatchEvent(new CustomEvent('cross-domain-node-click', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent
                    }
                }));
                return;
            }

            if (this.isReadOnlyMode()) {
                return;
            }

            // 普通节点：双击进入内联编辑
            this.showInlineNodeEditor(node);
        });

        // 分组节点双击事件（修改分组名）
        this.cy.on('dbltap', 'node[?isGroup]', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const node = evt.target;
            const data = node.data();
            
            this.showGroupNameDialog((newLabel) => {
                if (newLabel && newLabel !== data.label) {
                    // 触发分组重命名事件
                    this.container?.dispatchEvent(new CustomEvent('group-rename', {
                        detail: {
                            groupId: data.id,
                            oldLabel: data.label,
                            newLabel: newLabel
                        }
                    }));
                }
            }, data.label);
        });

        // 分组节点右键菜单事件（删除分组）
        this.cy.on('cxttap', 'node[?isGroup]', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 触发分组右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('group-contextmenu', {
                detail: {
                    groupId: data.id,
                    groupLabel: data.label,
                    event: originalEvent,
                    position: {
                        x: originalEvent.clientX,
                        y: originalEvent.clientY
                    }
                }
            }));
        });

        // 节点悬停事件
        this.cy.on('mouseover', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            this.container?.dispatchEvent(new CustomEvent('node-hover', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent
                }
            }));
        });

        // 节点离开事件
        this.cy.on('mouseout', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            this.container?.dispatchEvent(new CustomEvent('node-leave', {
                detail: {
                    node: data.originalNode
                }
            }));
        });

        // 节点右键菜单事件
        this.cy.on('cxttap', 'node[!isGroup]', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;
            const renderedPosition = node.renderedPosition();

            // 跨领域节点：发送专门的跨领域右键菜单事件
            if (data.isCrossDomain) {
                this.container?.dispatchEvent(new CustomEvent('cross-domain-contextmenu', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent,
                        position: {
                            x: renderedPosition.x,
                            y: renderedPosition.y
                        }
                    }
                }));
                return;
            }

            // 普通节点：发送普通的节点右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('node-contextmenu', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent,
                    position: {
                        x: renderedPosition.x,
                        y: renderedPosition.y
                    }
                }
            }));
        });

        // 背景点击事件（取消选择）
        this.cy.on('tap', (evt: any) => {
            if (evt.target === this.cy) {
                // 清除子节点箭头高亮
                this.cy?.$('edge.child-edge-highlight').removeClass('child-edge-highlight');

                // 取消批量选择并隐藏工具栏
                if (this.batchSelectedNodeIds.length > 0) {
                    this.batchSelectedNodeIds = [];
                    this.batchSelectedNodes = [];
                    this.hideBatchToolbar();
                }

                this.container?.dispatchEvent(new CustomEvent('background-click', {
                    detail: { event: evt.originalEvent }
                }));
            }
        });

        // 背景双击事件（创建自由节点）
        this.cy.on('dbltap', (evt: any) => {
            if (evt.target === this.cy) {
                if (this.isReadOnlyMode()) {
                    return;
                }
                const position = evt.position;
                this.container?.dispatchEvent(new CustomEvent('background-dblclick', {
                    detail: {
                        position: { x: position.x, y: position.y },
                        event: evt.originalEvent
                    }
                }));
            }
        });

        // 监听添加占位符节点事件
        this.addManagedDomListener(this.container, 'add-placeholder-node', (event: any) => {
            const { nodeId, position, suggestedNodeId, parentNodeId } = event.detail;

            try {
                // 直接在 Cytoscape 中添加占位符节点
                this.cy?.add({
                    group: 'nodes',
                    data: {
                        id: nodeId,
                        label: '',  // 不显示预生成的 ID，保持空白
                        isPlaceholder: true,
                        originalNode: null,
                        suggestedNodeId: suggestedNodeId,  // 存储预生成的节点 ID
                        parentNodeId: parentNodeId  // 存储父节点 ID
                    },
                    position: position
                });

                // 如果有父节点，创建连接线
                if (parentNodeId) {
                    setTimeout(() => {
                        const placeholderNode = this.cy?.$id(nodeId);
                        if (placeholderNode && placeholderNode.length > 0) {
                            this.createPlaceholderConnectionLine(nodeId, parentNodeId);
                        }
                    }, 50);
                }

                // 自动选中并打开编辑框
                setTimeout(() => {
                    const node = this.cy?.$id(nodeId);

                    if (node && node.length > 0) {
                        // 取消其他节点的选中
                        const previouslySelected = this.cy!.$(':selected');
                        previouslySelected.unselect();

                        // 选中这个节点
                        node.select();

                        // 延迟打开编辑器，确保选中完成
                        setTimeout(() => {
                            this.showInlineNodeEditor(node);
                        }, 10);
                    } else {
                        console.error('[CytoscapeRenderer] 未找到节点', nodeId);
                    }
                }, 10);
            } catch (error) {
                console.error('[CytoscapeRenderer] Error adding placeholder node:', error);
            }
        });

        // 监听移除占位符节点事件
        this.addManagedDomListener(this.container, 'remove-placeholder-node', (event: any) => {
            const { nodeId } = event.detail;

            // 先清理连接线（通过查询选择器，更可靠）
            const connectionLine = this.container?.querySelector(`.placeholder-connection-line[data-placeholder-id="${nodeId}"]`);
            if (connectionLine && connectionLine.parentNode) {
                connectionLine.parentNode.removeChild(connectionLine);
            }

            // 从 Cytoscape 中移除占位符节点
            const node = this.cy?.$id(nodeId);
            if (node && node.length > 0) {
                // 清理连接线（备用方法）
                const nodeData = node.data();
                const connectionLineFromData = (nodeData as any).connectionLine;

                if (connectionLineFromData && connectionLineFromData.parentNode) {
                    connectionLineFromData.parentNode.removeChild(connectionLineFromData);
                }

                // 从 overlay 调度器移除连接线更新器
                const lineUpdater = (nodeData as any).connectionLineUpdater;
                if (lineUpdater) {
                    this.overlayUpdaters.delete(lineUpdater);
                }

                this.cy?.remove(node);
            }
        });

        // 监听节点移除事件，清理占位符节点的连接线
        this.cy?.on('remove', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            // 如果是占位符节点，清理连接线
            if (data.isPlaceholder) {
                const connectionLine = this.container?.querySelector(`.placeholder-connection-line[data-placeholder-id="${data.id}"]`);
                if (connectionLine && connectionLine.parentNode) {
                    connectionLine.parentNode.removeChild(connectionLine);
                }
            }
        });

        // 监听清理所有占位符连接线事件（用于视图刷新时）
        this.addManagedDomListener(this.container, 'cleanup-all-placeholder-connections', () => {
            const connectionLines = this.container?.querySelectorAll('.placeholder-connection-line');
            if (connectionLines) {
                connectionLines.forEach(line => {
                    if (line.parentNode) {
                        line.parentNode.removeChild(line);
                    }
                });
            }
        });

        // 监听通过 ID 选中节点事件（用于新建节点后自动选中）
        this.addManagedDomListener(this.container, 'select-node-by-id', (event: any) => {
            const { nodeId } = event.detail;

            // 延迟执行，确保视图刷新完成
            setTimeout(() => {
                if (!this.cy) return;

                // 查找对应 ID 的节点
                const targetNode = this.cy.$('node').filter((node: any) => {
                    const data = node.data();
                    return data.originalNode && data.originalNode.IDStr === nodeId;
                });

                if (targetNode.length > 0) {
                    // 取消其他节点的选中
                    this.cy.$(':selected').unselect();

                    // 选中目标节点
                    targetNode.select();
                    this.ensureNodeVisibleInViewport(targetNode);


                    // 将焦点设置到 container，确保方向键能工作
                    this.container?.focus();
                } else {
                    console.warn('[CytoscapeRenderer] 未找到节点', nodeId);
                }
            }, 300); // 延迟 300ms 确保视图刷新完成
        });

        // 节点拖动自动连接相关变量
        let tempConnectionLine: SVGLineElement | null = null;
        let svgOverlay: SVGSVGElement | null = null;
        let nearbyNodeId: string | null = null;
        const PROXIMITY_THRESHOLD = 250;  // 250px 范围
        let alignmentOverlay: SVGSVGElement | null = null;
        let verticalAlignmentLine: SVGLineElement | null = null;
        let horizontalAlignmentLine: SVGLineElement | null = null;
        let spacingGuideLineA: SVGLineElement | null = null;
        let spacingGuideLineB: SVGLineElement | null = null;
        const ALIGNMENT_THRESHOLD = 5;
        const SPACING_THRESHOLD = 8;
        const AXIS_GROUP_THRESHOLD = 24;
        let isMultiNodeDrag = false; // grab 时缓存，避免 drag 高频查选择器
        // 自动布局节点的子树同步拖动状态
        let autoHierarchyDescendants: Array<{ node: any; startX: number; startY: number }> = [];
        let autoHierarchyGrabStartX = 0;
        let autoHierarchyGrabStartY = 0;
        let isAutoHierarchyDrag = false;
        let autoHierarchyGrabbedNode: any = null;
        let autoHierarchyStyled = false;

        // 拖拽期静态候选快照：grab 时构建一次，drag 期间复用，避免每帧 N 次 renderedPosition
        type DragCandidate = {
            node: any;
            id: string;
            isPlaceholder: boolean;
            isGroup: boolean;
            isFreeNode: boolean;
            isCrossDomain: boolean;
            metrics: { x: number; y: number; x1: number; x2: number; y1: number; y2: number; width: number; height: number };
        };
        let dragCandidateSnapshot: DragCandidate[] = [];
        let snapshotZoom = 0;
        let snapshotPanX = 0;
        let snapshotPanY = 0;

        const buildDragCandidateSnapshot = (draggedId: string) => {
            if (!this.cy) {
                dragCandidateSnapshot = [];
                return;
            }
            const arr: DragCandidate[] = [];
            this.cy.nodes().forEach((other: any) => {
                if (other.id() === draggedId) return;
                if (other.removed() || !other.visible()) return;
                if (other.hasClass('zk-collapsed-hidden')) return;
                const d = other.data();
                const originalId = d.originalNode?.ID || d.originalSource || other.id();
                const isFreeNode = !!d.isFreeNode || (typeof originalId === 'string' && originalId.startsWith('free.'));
                arr.push({
                    node: other,
                    id: other.id(),
                    isPlaceholder: !!d.isPlaceholder,
                    isGroup: !!d.isGroup,
                    isFreeNode,
                    isCrossDomain: !!d.isCrossDomain,
                    metrics: getRenderedMetrics(other),
                });
            });
            dragCandidateSnapshot = arr;
            snapshotZoom = this.cy.zoom();
            const pan = this.cy.pan();
            snapshotPanX = pan.x;
            snapshotPanY = pan.y;
        };

        // 拖拽中如发生 zoom/pan 变化（罕见但可能），重算快照 metrics（保留候选数组，不重建）
        const refreshSnapshotMetricsIfViewportChanged = () => {
            if (!this.cy || dragCandidateSnapshot.length === 0) return;
            const zoom = this.cy.zoom();
            const pan = this.cy.pan();
            if (zoom === snapshotZoom && pan.x === snapshotPanX && pan.y === snapshotPanY) return;
            for (const cand of dragCandidateSnapshot) {
                cand.metrics = getRenderedMetrics(cand.node);
            }
            snapshotZoom = zoom;
            snapshotPanX = pan.x;
            snapshotPanY = pan.y;
        };

        const clearDragCandidateSnapshot = () => {
            dragCandidateSnapshot = [];
        };

        const ensureAlignmentOverlay = () => {
            if (alignmentOverlay || !this.container) return;
            alignmentOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            alignmentOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 3;
            `;

            verticalAlignmentLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            horizontalAlignmentLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            spacingGuideLineA = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            spacingGuideLineB = document.createElementNS('http://www.w3.org/2000/svg', 'line');

            [verticalAlignmentLine, horizontalAlignmentLine].forEach((line) => {
                if (!line) return;
                line.setAttribute('stroke', '#f8fafc');
                line.setAttribute('stroke-width', '1.5');
                line.setAttribute('stroke-dasharray', '4,4');
                line.setAttribute('opacity', '0.85');
                line.style.display = 'none';
                alignmentOverlay!.appendChild(line);
            });

            [spacingGuideLineA, spacingGuideLineB].forEach((line) => {
                if (!line) return;
                line.setAttribute('stroke', '#38bdf8');
                line.setAttribute('stroke-width', '1.5');
                line.setAttribute('stroke-dasharray', '3,3');
                line.setAttribute('opacity', '0.9');
                line.style.display = 'none';
                alignmentOverlay!.appendChild(line);
            });

            this.container.appendChild(alignmentOverlay);
            this.activeAlignmentOverlay = alignmentOverlay;
        };

        const hideAlignmentGuides = () => {
            if (verticalAlignmentLine) verticalAlignmentLine.style.display = 'none';
            if (horizontalAlignmentLine) horizontalAlignmentLine.style.display = 'none';
            if (spacingGuideLineA) spacingGuideLineA.style.display = 'none';
            if (spacingGuideLineB) spacingGuideLineB.style.display = 'none';
        };

        const getRenderedMetrics = (node: any) => {
            const pos = node.renderedPosition();
            const width = typeof node.renderedWidth === 'function'
                ? node.renderedWidth()
                : node.width() * this.cy!.zoom();
            const height = typeof node.renderedHeight === 'function'
                ? node.renderedHeight()
                : node.height() * this.cy!.zoom();
            return {
                x: pos.x,
                y: pos.y,
                x1: pos.x - width / 2,
                x2: pos.x + width / 2,
                y1: pos.y - height / 2,
                y2: pos.y + height / 2,
                width,
                height
            };
        };

        const GUIDE_PROXIMITY = 400; // 只对 400px 内的节点触发辅助线

        const updateAlignmentGuides = (draggedNode: any) => {
            if (!this.cy || !this.container) return;

            // 多节点拖动时不触发辅助线（使用 grab 时缓存的标志，避免高频查选择器）
            if (isMultiNodeDrag) {
                return;
            }

            ensureAlignmentOverlay();
            if (!verticalAlignmentLine || !horizontalAlignmentLine || !spacingGuideLineA || !spacingGuideLineB) return;

            refreshSnapshotMetricsIfViewportChanged();

            const originalMetrics = getRenderedMetrics(draggedNode);
            let snappedX = originalMetrics.x;
            let snappedY = originalMetrics.y;

            let verticalGuide: { x: number; y1: number; y2: number } | null = null;
            let horizontalGuide: { y: number; x1: number; x2: number } | null = null;
            let verticalBest = Number.POSITIVE_INFINITY;
            let horizontalBest = Number.POSITIVE_INFINITY;
            let horizontalSpacing: { left: any; right: any; y: number } | null = null;
            let verticalSpacing: { top: any; bottom: any; x: number } | null = null;

            // 单次遍历：同时算对齐候选 + 收集 axis peers，metrics 来自 grab 时建立的快照
            const proximitySq = GUIDE_PROXIMITY * GUIDE_PROXIMITY;
            const horizontalPeerMetrics: typeof originalMetrics[] = [];
            const verticalPeerMetrics: typeof originalMetrics[] = [];
            const draggedId = draggedNode.id();

            for (let i = 0; i < dragCandidateSnapshot.length; i++) {
                const cand = dragCandidateSnapshot[i];
                if (cand.id === draggedId) continue;
                if (cand.isPlaceholder || cand.isGroup) continue;
                const other = cand.metrics;
                const dx = originalMetrics.x - other.x;
                const dy = originalMetrics.y - other.y;
                if (dx * dx + dy * dy > proximitySq) continue;

                // 对齐候选（X 轴：中心 / 左缘 / 右缘）
                const vc1 = Math.abs(originalMetrics.x - other.x);
                if (vc1 <= ALIGNMENT_THRESHOLD && vc1 < verticalBest) {
                    verticalBest = vc1;
                    snappedX = other.x;
                    verticalGuide = { x: other.x, y1: Math.min(originalMetrics.y1, other.y1) - 40, y2: Math.max(originalMetrics.y2, other.y2) + 40 };
                }
                const vc2 = Math.abs(originalMetrics.x1 - other.x1);
                if (vc2 <= ALIGNMENT_THRESHOLD && vc2 < verticalBest) {
                    verticalBest = vc2;
                    snappedX = other.x1 + originalMetrics.width / 2;
                    verticalGuide = { x: other.x1, y1: Math.min(originalMetrics.y1, other.y1) - 40, y2: Math.max(originalMetrics.y2, other.y2) + 40 };
                }
                const vc3 = Math.abs(originalMetrics.x2 - other.x2);
                if (vc3 <= ALIGNMENT_THRESHOLD && vc3 < verticalBest) {
                    verticalBest = vc3;
                    snappedX = other.x2 - originalMetrics.width / 2;
                    verticalGuide = { x: other.x2, y1: Math.min(originalMetrics.y1, other.y1) - 40, y2: Math.max(originalMetrics.y2, other.y2) + 40 };
                }

                // 对齐候选（Y 轴：中心 / 上缘 / 下缘）
                const hc1 = Math.abs(originalMetrics.y - other.y);
                if (hc1 <= ALIGNMENT_THRESHOLD && hc1 < horizontalBest) {
                    horizontalBest = hc1;
                    snappedY = other.y;
                    horizontalGuide = { y: other.y, x1: Math.min(originalMetrics.x1, other.x1) - 40, x2: Math.max(originalMetrics.x2, other.x2) + 40 };
                }
                const hc2 = Math.abs(originalMetrics.y1 - other.y1);
                if (hc2 <= ALIGNMENT_THRESHOLD && hc2 < horizontalBest) {
                    horizontalBest = hc2;
                    snappedY = other.y1 + originalMetrics.height / 2;
                    horizontalGuide = { y: other.y1, x1: Math.min(originalMetrics.x1, other.x1) - 40, x2: Math.max(originalMetrics.x2, other.x2) + 40 };
                }
                const hc3 = Math.abs(originalMetrics.y2 - other.y2);
                if (hc3 <= ALIGNMENT_THRESHOLD && hc3 < horizontalBest) {
                    horizontalBest = hc3;
                    snappedY = other.y2 - originalMetrics.height / 2;
                    horizontalGuide = { y: other.y2, x1: Math.min(originalMetrics.x1, other.x1) - 40, x2: Math.max(originalMetrics.x2, other.x2) + 40 };
                }

                // 等距辅助：按轴分组
                if (Math.abs(other.y - originalMetrics.y) <= AXIS_GROUP_THRESHOLD) {
                    horizontalPeerMetrics.push(other);
                }
                if (Math.abs(other.x - originalMetrics.x) <= AXIS_GROUP_THRESHOLD) {
                    verticalPeerMetrics.push(other);
                }
            }

            horizontalPeerMetrics.sort((a, b) => a.x - b.x);
            for (let i = 0; i < horizontalPeerMetrics.length - 1; i++) {
                const left = horizontalPeerMetrics[i];
                const right = horizontalPeerMetrics[i + 1];
                if (left.x >= originalMetrics.x || right.x <= originalMetrics.x) continue;
                const midpoint = (left.x + right.x) / 2;
                const delta = Math.abs(originalMetrics.x - midpoint);
                if (delta <= SPACING_THRESHOLD) {
                    snappedX = midpoint;
                    verticalGuide = null;
                    horizontalSpacing = {
                        left,
                        right,
                        y: (left.y + right.y + originalMetrics.y) / 3
                    };
                    break;
                }
            }

            verticalPeerMetrics.sort((a, b) => a.y - b.y);
            for (let i = 0; i < verticalPeerMetrics.length - 1; i++) {
                const top = verticalPeerMetrics[i];
                const bottom = verticalPeerMetrics[i + 1];
                if (top.y >= originalMetrics.y || bottom.y <= originalMetrics.y) continue;
                const midpoint = (top.y + bottom.y) / 2;
                const delta = Math.abs(originalMetrics.y - midpoint);
                if (delta <= SPACING_THRESHOLD) {
                    snappedY = midpoint;
                    horizontalGuide = null;
                    verticalSpacing = {
                        top,
                        bottom,
                        x: (top.x + bottom.x + originalMetrics.x) / 3
                    };
                    break;
                }
            }

            if (snappedX !== originalMetrics.x || snappedY !== originalMetrics.y) {
                const zoom = this.cy.zoom();
                const pan = this.cy.pan();
                draggedNode.position({
                    x: (snappedX - pan.x) / zoom,
                    y: (snappedY - pan.y) / zoom
                });
            }

            const draggedPos = draggedNode.renderedPosition();
            const draggedMetrics = getRenderedMetrics(draggedNode);
            const currentVerticalGuide: any = verticalGuide;
            const currentHorizontalGuide: any = horizontalGuide;

            if (currentVerticalGuide) {
                verticalAlignmentLine.setAttribute('x1', `${currentVerticalGuide.x}`);
                verticalAlignmentLine.setAttribute('y1', `${currentVerticalGuide.y1}`);
                verticalAlignmentLine.setAttribute('x2', `${currentVerticalGuide.x}`);
                verticalAlignmentLine.setAttribute('y2', `${currentVerticalGuide.y2}`);
                verticalAlignmentLine.style.display = 'block';
            } else {
                verticalAlignmentLine.style.display = 'none';
            }

            if (currentHorizontalGuide) {
                horizontalAlignmentLine.setAttribute('x1', `${currentHorizontalGuide.x1}`);
                horizontalAlignmentLine.setAttribute('y1', `${currentHorizontalGuide.y}`);
                horizontalAlignmentLine.setAttribute('x2', `${currentHorizontalGuide.x2}`);
                horizontalAlignmentLine.setAttribute('y2', `${currentHorizontalGuide.y}`);
                horizontalAlignmentLine.style.display = 'block';
            } else {
                horizontalAlignmentLine.style.display = 'none';
            }

            if (horizontalSpacing) {
                spacingGuideLineA.setAttribute('x1', `${horizontalSpacing.left.x2}`);
                spacingGuideLineA.setAttribute('y1', `${draggedPos.y}`);
                spacingGuideLineA.setAttribute('x2', `${draggedMetrics.x1}`);
                spacingGuideLineA.setAttribute('y2', `${draggedPos.y}`);
                spacingGuideLineA.style.display = 'block';

                spacingGuideLineB.setAttribute('x1', `${draggedMetrics.x2}`);
                spacingGuideLineB.setAttribute('y1', `${draggedPos.y}`);
                spacingGuideLineB.setAttribute('x2', `${horizontalSpacing.right.x1}`);
                spacingGuideLineB.setAttribute('y2', `${draggedPos.y}`);
                spacingGuideLineB.style.display = 'block';
            } else if (verticalSpacing) {
                spacingGuideLineA.setAttribute('x1', `${draggedPos.x}`);
                spacingGuideLineA.setAttribute('y1', `${verticalSpacing.top.y2}`);
                spacingGuideLineA.setAttribute('x2', `${draggedPos.x}`);
                spacingGuideLineA.setAttribute('y2', `${draggedMetrics.y1}`);
                spacingGuideLineA.style.display = 'block';

                spacingGuideLineB.setAttribute('x1', `${draggedPos.x}`);
                spacingGuideLineB.setAttribute('y1', `${draggedMetrics.y2}`);
                spacingGuideLineB.setAttribute('x2', `${draggedPos.x}`);
                spacingGuideLineB.setAttribute('y2', `${verticalSpacing.bottom.y1}`);
                spacingGuideLineB.style.display = 'block';
            } else {
                spacingGuideLineA.style.display = 'none';
                spacingGuideLineB.style.display = 'none';
            }
        };

        // 智能连线：从快照里找最近的合法目标节点
        const findNearestSmartTarget = (
            draggedNode: any,
            draggedRenderedPos: { x: number; y: number },
            allowFreeNodeAsTarget: boolean
        ): any => {
            const draggedId = draggedNode.id();
            const proximitySq = PROXIMITY_THRESHOLD * PROXIMITY_THRESHOLD;
            let nearest: any = null;
            let bestDistSq = proximitySq;
            for (let i = 0; i < dragCandidateSnapshot.length; i++) {
                const cand = dragCandidateSnapshot[i];
                if (cand.id === draggedId) continue;
                if (cand.isPlaceholder) continue;
                if (cand.isGroup) continue;
                if (!allowFreeNodeAsTarget && cand.isFreeNode) continue;
                const dx = draggedRenderedPos.x - cand.metrics.x;
                const dy = draggedRenderedPos.y - cand.metrics.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    nearest = cand.node;
                }
            }
            return nearest;
        };

        // 智能连线虚线：复用单个 SVG line，避免每帧 remove/create
        const ensureTempConnectionLine = (): SVGLineElement | null => {
            if (!svgOverlay) return null;
            if (tempConnectionLine && tempConnectionLine.parentNode === svgOverlay) {
                return tempConnectionLine;
            }
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('stroke', '#10b981');
            line.setAttribute('stroke-width', '2');
            line.setAttribute('stroke-dasharray', '5,5');
            line.style.display = 'none';
            svgOverlay.appendChild(line);
            tempConnectionLine = line;
            return line;
        };

        const hideTempConnectionLine = () => {
            if (tempConnectionLine) tempConnectionLine.style.display = 'none';
        };

        // 切换智能连线高亮目标（仅当目标变化时操作 class）
        let smartHoverTargetId: string | null = null;
        const setSmartHoverTarget = (targetId: string | null) => {
            if (smartHoverTargetId === targetId) return;
            if (smartHoverTargetId) {
                const prev = this.cy!.$id(smartHoverTargetId);
                if (prev && prev.length) prev.removeClass('connection-target-hover');
            }
            if (targetId) {
                const cur = this.cy!.$id(targetId);
                if (cur && cur.length) cur.addClass('connection-target-hover');
            }
            smartHoverTargetId = targetId;
            nearbyNodeId = targetId;
        };

        // 节点开始拖动事件
        this.cy.on('grab', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const smartEnabled = this.isSmartConnectionEnabled();
            isMultiNodeDrag = this.cy!.nodes(':selected').length > 1;
            ensureAlignmentOverlay();
            hideAlignmentGuides();

            // 单节点拖拽：建静态候选快照（drag 期间复用），多节点拖拽不需要辅助/智能连线
            if (!isMultiNodeDrag) {
                buildDragCandidateSnapshot(node.id());
            } else {
                clearDragCandidateSnapshot();
            }

            // 自动布局节点：收集后代 & 起始位置；样式延迟到真正开始移动时再加
            autoHierarchyDescendants = [];
            isAutoHierarchyDrag = false;
            autoHierarchyGrabbedNode = null;
            autoHierarchyStyled = false;
            if (!isMultiNodeDrag && !data.isPlaceholder && !data.isGroup && !data.isCrossDomain) {
                const grabbedId = data.originalNode?.ID || data.originalSource || data.id;
                if (typeof grabbedId === 'string' && grabbedId.length > 0 && this.isNodeAutoLayoutForId(grabbedId)) {
                    const prefix = `${grabbedId}.`;
                    const grabPos = node.position();
                    autoHierarchyGrabStartX = grabPos.x;
                    autoHierarchyGrabStartY = grabPos.y;
                    this.cy!.nodes().forEach((n: any) => {
                        if (n.id() === node.id()) return;
                        const d = n.data();
                        if (d.isPlaceholder || d.isGroup || d.isCrossDomain) return;
                        const nid = d.originalNode?.ID || d.originalSource || n.id();
                        if (typeof nid === 'string' && nid.startsWith(prefix)) {
                            const p = n.position();
                            autoHierarchyDescendants.push({ node: n, startX: p.x, startY: p.y });
                        }
                    });
                    if (autoHierarchyDescendants.length > 0) {
                        isAutoHierarchyDrag = true;
                        autoHierarchyGrabbedNode = node;
                    }
                }
            }

            if (!smartEnabled) {
                hideTempConnectionLine();
                setSmartHoverTarget(null);
                return;
            }

            // 只对自由节点启用自动连接
            if (data.isPlaceholder || data.isGroup || data.isCrossDomain) return;

            // 检查是否是自由节点（ID 以 'free.' 开头）
            const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;

            if (!originalNodeId.startsWith('free.')) {
                return;  // 只允许自由节点拖动自动连接
            }

            // 限制：自由节点一旦已有任意连线（父子/反向），不再允许智能连线到其他节点
            if (node.connectedEdges().length > 0) {
                return;
            }

            // 创建 SVG 叠加层用于绘制连线
            if (!svgOverlay && this.container) {
                svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svgOverlay.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                    z-index: 2;
                `;
                this.container.appendChild(svgOverlay);
            }
            ensureTempConnectionLine();
        });

        // 节点拖动事件
        this.cy.on('drag', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            // 自动布局：把后代同步平移
            if (isAutoHierarchyDrag && !isMultiNodeDrag) {
                const curPos = node.position();
                const dx = curPos.x - autoHierarchyGrabStartX;
                const dy = curPos.y - autoHierarchyGrabStartY;
                if (!autoHierarchyStyled && (dx !== 0 || dy !== 0)) {
                    autoHierarchyStyled = true;
                    const descendantIds = new Set<string>(
                        autoHierarchyDescendants.map(({ node: n }) => n.id())
                    );
                    if (autoHierarchyGrabbedNode) descendantIds.add(autoHierarchyGrabbedNode.id());
                    autoHierarchyDescendants.forEach(({ node: n }) => {
                        n.addClass('auto-hierarchy-descendant');
                    });
                    this.cy!.edges().forEach((e: any) => {
                        if (descendantIds.has(e.source().id()) && descendantIds.has(e.target().id())) {
                            e.addClass('auto-hierarchy-descendant-edge');
                        }
                    });
                }
                this.cy!.batch(() => {
                    autoHierarchyDescendants.forEach(({ node: n, startX, startY }) => {
                        n.position({ x: startX + dx, y: startY + dy });
                    });
                });
            }

            // 多节点拖动时跳过辅助线和智能连线，避免 N 个节点 × 每帧的重复计算
            if (isMultiNodeDrag) return;

            const smartEnabled = this.isSmartConnectionEnabled();

             if (!data.isGroup) {
                updateAlignmentGuides(node);
            }

            if (!smartEnabled) {
                hideTempConnectionLine();
                setSmartHoverTarget(null);
                return;
            }

            // 智能连线扫描：占位符 vs 自由节点共用快照 + helper
            const isPlaceholderDrag = !!data.isPlaceholder;
            if (!isPlaceholderDrag) {
                if (data.isGroup || data.isCrossDomain) return;
                const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;
                if (!originalNodeId.startsWith('free.')) return;
                if (node.connectedEdges().length > 0) {
                    hideTempConnectionLine();
                    setSmartHoverTarget(null);
                    return;
                }
            }

            // svgOverlay 仅在自由节点 grab 时创建；占位符路径如果还没建过 overlay 也不应绘制连线
            if (!svgOverlay) {
                setSmartHoverTarget(null);
                return;
            }

            const pos = node.renderedPosition();
            const nearestNode = findNearestSmartTarget(node, pos, /* allowFreeNodeAsTarget */ isPlaceholderDrag);

            if (nearestNode) {
                const line = ensureTempConnectionLine();
                if (line) {
                    const targetPos = nearestNode.renderedPosition();
                    line.setAttribute('x1', targetPos.x.toString());
                    line.setAttribute('y1', targetPos.y.toString());
                    line.setAttribute('x2', pos.x.toString());
                    line.setAttribute('y2', pos.y.toString());
                    line.style.display = 'block';
                }
                setSmartHoverTarget(nearestNode.id());
            } else {
                hideTempConnectionLine();
                setSmartHoverTarget(null);
            }
        });

        // 节点拖动结束事件
        this.cy.on('dragfree', 'node', (evt: any) => {
            if (!evt || !evt.target) return;
            const node = evt.target;
            const data = node.data();
            const smartEnabled = this.isSmartConnectionEnabled();
            hideAlignmentGuides();

            // 自动布局：为同步平移的后代派发位置变化事件（以便批量持久化）
            if (isAutoHierarchyDrag) {
                autoHierarchyDescendants.forEach(({ node: n }) => {
                    const d = n.data();
                    n.removeClass('auto-hierarchy-descendant');
                    if (!d || !d.originalNode) return;
                    const pos = n.position();
                    this.container?.dispatchEvent(new CustomEvent('node-position-changed', {
                        detail: {
                            node: d.originalNode,
                            nodeId: d.id,
                            position: { x: pos.x, y: pos.y }
                        }
                    }));
                });
                this.cy!.edges('.auto-hierarchy-descendant-edge').removeClass('auto-hierarchy-descendant-edge');
                isAutoHierarchyDrag = false;
                autoHierarchyDescendants = [];
                autoHierarchyGrabbedNode = null;
                autoHierarchyStyled = false;
            }

            // 隐藏临时连接线（不移除 DOM，free 事件会整体清理 svgOverlay）
            hideTempConnectionLine();
            setSmartHoverTarget(null);

            // 如果是分组节点，不触发位置保存
            if (data.isGroup) return;

            const position = node.position();

            // 处理占位符节点的智能连线
            if (data.isPlaceholder) {
                // 检查是否启用了智能连线并且有附近的节点
                if (smartEnabled && nearbyNodeId) {
                    const parentData = this.cy!.$id(nearbyNodeId).data();
                    const parentId = parentData.originalNode?.ID || parentData.originalSource || nearbyNodeId;
                    const placeholderId = data.id;

                    // 触发占位符节点自动连接事件
                    this.container?.dispatchEvent(new CustomEvent('placeholder-smart-connect', {
                        detail: {
                            placeholderId: placeholderId,
                            parentNodeId: parentId,
                            position: {
                                x: position.x,
                                y: position.y
                            }
                        }
                    }));

                    nearbyNodeId = null;
                }
                return;  // 占位符节点不保存位置
            }

            // 检查是否有自动连接（自由节点）
            if (smartEnabled && nearbyNodeId) {
                const parentData = this.cy!.$id(nearbyNodeId).data();

                // 使用 originalNode.ID（带点的格式）而不是转义后的 ID
                const childId = data.originalNode?.ID || data.originalSource || data.id;
                const parentId = parentData.originalNode?.ID || parentData.originalSource || nearbyNodeId;

                // 触发自动连接事件
                this.container?.dispatchEvent(new CustomEvent('auto-connect-node', {
                    detail: {
                        childNodeId: childId,
                        parentNodeId: parentId,
                        position: {
                            x: position.x,
                            y: position.y
                        }
                    }
                }));

                nearbyNodeId = null;
                return;
            }

            nearbyNodeId = null;

            // 跨领域节点：触发特殊的位置变化事件
            if (data.isCrossDomain) {
                const crossDomainLink = data.originalNode?.file;

                // 找到连接这个跨领域节点的边，获取源节点 ID
                const connectedEdges = this.cy!.$(`edge[type="cross-domain"][target="${data.id}"]`);
                let sourceNodeId = null;
                if (connectedEdges.length > 0) {
                    sourceNodeId = connectedEdges.first().data().originalSource;
                }

                this.container?.dispatchEvent(new CustomEvent('cross-domain-node-position-changed', {
                    detail: {
                        node: data.originalNode,
                        nodeId: data.id,
                        position: {
                            x: position.x,
                            y: position.y
                        },
                        // 获取跨领域链接信息和源节点 ID
                        crossDomainLink: crossDomainLink,
                        sourceNodeId: sourceNodeId
                    }
                }));
                return;
            }

            // 普通节点：触发位置变化事件
            this.container?.dispatchEvent(new CustomEvent('node-position-changed', {
                detail: {
                    node: data.originalNode,
                    nodeId: data.id,
                    position: {
                        x: position.x,
                        y: position.y
                    }
                }
            }));
        });

        // 节点释放事件（清理 SVG 叠加层）
        this.cy.on('free', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            hideAlignmentGuides();
            clearDragCandidateSnapshot();

            // 只对自由节点进行清理
            const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;
            if (!originalNodeId.startsWith('free.')) {
                return;
            }

            // 延迟清理，确保 dragfree 事件已经处理完成
            setTimeout(() => {
                // 移除 SVG 叠加层（连同复用的 tempConnectionLine 一起清理）
                if (svgOverlay && this.container) {
                    this.container.removeChild(svgOverlay);
                    svgOverlay = null;
                }
                tempConnectionLine = null;
                setSmartHoverTarget(null);
            }, 0);
        });

        // 边点击事件（选中边）
        this.cy.on('tap', 'edge', (evt: any) => {
            const edge = evt.target;
            const data = edge.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 触发边点击事件
            this.container?.dispatchEvent(new CustomEvent('edge-click', {
                detail: {
                    edgeId: data.id,
                    source: data.originalSource || data.source,  // 使用原始 ID
                    target: data.originalTarget || data.target,  // 使用原始 ID
                    type: data.type,
                    label: data.label,
                    event: originalEvent
                }
            }));
        });

        // 边双击事件（编辑关系文本）
        this.cy.on('dbltap', 'edge', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const edge = evt.target;
            const data = edge.data();

            // 允许编辑所有边的标签
            this.showInlineEdgeLabelEditor(edge);
        });

        // 边右键菜单事件（删除边）
        this.cy.on('cxttap', 'edge', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const edge = evt.target;
            const data = edge.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 获取目标节点的 nodeSons 信息
            const targetNode = this.cy!.$id(data.target);
            if (!targetNode.length) return;

            const targetData = targetNode.data();
            const targetNodeSons = targetData.originalNode ? targetData.originalNode.nodeSons : 1;

            // 触发边右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('edge-contextmenu', {
                detail: {
                    edgeId: data.id,
                    source: data.originalSource || data.source,  // 使用原始 ID
                    target: data.originalTarget || data.target,  // 使用原始 ID
                    type: data.type,
                    label: data.label,
                    targetNodeSons: targetNodeSons,  // 添加目标节点的子节点数量
                    event: originalEvent,
                    position: {
                        x: originalEvent.clientX,
                        y: originalEvent.clientY
                    }
                }
            }));
        });

        // 画板拖动视觉反馈（当空格键按下并拖动时）
        this.cy.on('grab', () => {
            if (this.cy) {
                const container = this.cy.container();
                if (container) {
                    container.style.cursor = 'grabbing';
                }
            }
        });

        this.cy.on('free', () => {
            if (this.cy && this.cy.userPanningEnabled()) {
                const container = this.cy.container();
                if (container) {
                    container.style.cursor = 'grab';
                }
            }
        });

        // 监听视图状态变化（缩放和平移）
        // 使用防抖避免频繁触发
        let viewStateTimeout: NodeJS.Timeout | null = null;
        this.cy.on('zoom pan', () => {
            if (viewStateTimeout) clearTimeout(viewStateTimeout);
            viewStateTimeout = setTimeout(() => {
                if (!this.cy) return;
                const zoom = this.cy.zoom();
                const pan = this.cy.pan();
                this.container?.dispatchEvent(new CustomEvent('viewStateChanged', {
                    detail: { zoom, pan }
                }));
            }, 150);
        });
    }

    /**
     * 绑定键盘事件
     */
    private bindKeyboardEvents(): void {
        if (!this.container) return;

        // 监听键盘按下事件
        const handleKeyDown = (event: KeyboardEvent) => {
            const targetEl = event.target as HTMLElement | null;
            const isInlineEditing = !!this.container?.querySelector('.node-label-editor') ||
                !!this.container?.querySelector('.edge-label-editor') ||
                !!this.container?.querySelector('.zk-text-md-live-edit-host');
            const isEventFromInlineEditor = !!targetEl?.closest(
                '.node-label-editor, .edge-label-editor, .zk-text-md-live-edit-host, .cm-editor, .cm-content, .node-link-suggester, .zk-text-selection-toolbar'
            );

            // 编辑器内按键不应触发图级快捷键（方向键切换、Tab 建节点等）
            if (isInlineEditing && isEventFromInlineEditor) {
                return;
            }

            // Cmd+F：搜索节点
            if (event.key === 'f' && event.metaKey && !event.ctrlKey && !event.repeat) {
                event.preventDefault();
                event.stopPropagation();
                this.showSearchBar();
                return;
            }

            // Cmd+C：复制选中节点
            if (event.key === 'c' && (event.metaKey || event.ctrlKey) && !event.repeat) {
                if (!this.cy) return;
                const selected = this.cy.$(':selected').filter((n: any) =>
                    n.isNode() && !n.data('isGroup') && !n.data('isPlaceholder') && !n.data('isCrossDomain')
                );
                if (selected.length === 0) return;
                event.preventDefault();
                event.stopPropagation();
                this.clipboardNodes = selected.map((node: any) => ({
                    originalNode: node.data('originalNode'),
                    position: { ...node.position() }
                })).filter((item: any) => item.originalNode);
                if (this.clipboardNodes.length > 0) {
                    this.container?.dispatchEvent(new CustomEvent('node-copy', {
                        detail: { count: this.clipboardNodes.length }
                    }));
                }
                return;
            }

            // Cmd+V：粘贴节点
            if (event.key === 'v' && (event.metaKey || event.ctrlKey) && !event.repeat) {
                if (!this.cy || this.clipboardNodes.length === 0) return;
                event.preventDefault();
                event.stopPropagation();
                const pan = this.cy.pan();
                const zoom = this.cy.zoom();
                const pasteCenter = {
                    x: (this.cy.width() / 2 - pan.x) / zoom,
                    y: (this.cy.height() / 2 - pan.y) / zoom
                };
                this.container?.dispatchEvent(new CustomEvent('node-paste', {
                    detail: { nodes: this.clipboardNodes, pasteCenter }
                }));
                return;
            }

            // Command/Meta 键：启用框选模式
            if ((event.key === 'Meta' || event.key === 'Meta') && !event.repeat) {
                this.isMetaPressed = true;
                if (this.cy) {
                    this.cy.boxSelectionEnabled(true);
                }
            }

            // Delete 或 Backspace 键
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (!this.cy) return;

                // 获取选中的元素
                const selected = this.cy.$(':selected');

                // 检查是否有选中的普通节点
                const selectedNodes = selected.filter('node[!isGroup]');

                if (selectedNodes.length > 0) {
                    // 阻止默认行为（避免浏览器后退）
                    event.preventDefault();
                    event.stopPropagation();

                    // 如果选中的节点 >= 2个，使用批量删除
                    if (selectedNodes.length >= 2) {
                        // 保存选中的节点 ID 和完整节点数据
                        this.batchSelectedNodeIds = [];
                        this.batchSelectedNodes = [];
                        selectedNodes.forEach((node: any) => {
                            const data = node.data();
                            if (data.originalNode && data.originalNode.IDStr) {
                                this.batchSelectedNodeIds.push(data.originalNode.IDStr);
                                // 保存完整节点数据，包含 isCrossDomain 等信息
                                this.batchSelectedNodes.push({
                                    IDStr: data.originalNode.IDStr,
                                    isCrossDomain: data.originalNode.isCrossDomain || false,
                                    originalNode: data.originalNode
                                });
                            }
                        });

                        // 触发批量删除
                        this.batchDeleteNodes();
                        return;
                    }

                    // 单个节点删除，使用现有的确认流程
                    selectedNodes.forEach((node: any) => {
                        const data = node.data();
                        const originalNode = data.originalNode;

                        if (originalNode) {
                            // 计算节点的关系数量（入边 + 出边）
                            const connectedEdges = node.connectedEdges();
                            const relationCount = connectedEdges.length;

                            this.container?.dispatchEvent(new CustomEvent('node-delete-key', {
                                detail: {
                                    node: originalNode,
                                    relationCount: relationCount
                                }
                            }));
                        }
                    });

                    return; // 处理完节点删除后返回
                }
                
                // 检查是否有选中的分组节点
                const selectedGroups = selected.filter('node[?isGroup]');
                
                if (selectedGroups.length > 0) {
                    // 阻止默认行为（避免浏览器后退）
                    event.preventDefault();
                    event.stopPropagation();
                    
                    // 触发删除分组事件
                    selectedGroups.forEach((groupNode: any) => {
                        const data = groupNode.data();
                        this.container?.dispatchEvent(new CustomEvent('group-delete-key', {
                            detail: {
                                groupId: data.id,
                                groupLabel: data.label
                            }
                        }));
                    });
                    
                    return;
                }
                
                // 检查是否有选中的边（所有类型）
                const selectedEdges = selected.filter('edge');

                if (selectedEdges.length > 0) {
                    // 阻止默认行为
                    event.preventDefault();
                    event.stopPropagation();

                    // 触发删除边事件
                    selectedEdges.forEach((edge: any) => {
                        const data = edge.data();

                        // 获取目标节点的 nodeSons 信息
                        const targetNode = this.cy!.$id(data.target);
                        if (!targetNode.length) return;

                        const targetData = targetNode.data();
                        const targetNodeSons = targetData.originalNode ? targetData.originalNode.nodeSons : 1;

                        this.container?.dispatchEvent(new CustomEvent('edge-delete-key', {
                            detail: {
                                edgeId: data.id,
                                source: data.originalSource || data.source,  // 使用原始 ID
                                target: data.originalTarget || data.target,  // 使用原始 ID
                                type: data.type,
                                label: data.label,
                                targetNodeSons: targetNodeSons  // 添加目标节点的子节点数量
                            }
                        }));
                    });
                }
            }

            // Space 键：选中单个节点时进入编辑态
            if ((event.key === ' ' || event.code === 'Space') && !event.repeat) {
                if (!this.cy || this.isReadOnlyMode()) return;

                const activeElement = document.activeElement as HTMLElement | null;
                const isTypingIntoInput = !!activeElement && (
                    activeElement.tagName === 'INPUT' ||
                    activeElement.tagName === 'TEXTAREA' ||
                    activeElement.isContentEditable
                );
                if (isTypingIntoInput) {
                    return;
                }

                const hasExistingEditor =
                    !!this.container?.querySelector('.node-label-editor') ||
                    !!this.container?.querySelector('.edge-label-editor');
                if (hasExistingEditor) {
                    return;
                }

                const selected = this.cy.$(':selected');
                const selectedNodes = selected.filter('node[!isGroup]');
                if (selectedNodes.length === 1) {
                    const node = selectedNodes.first();
                    const data = node.data();
                    if (!data || data.isCrossDomain) {
                        return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    this.showInlineNodeEditor(node);
                    return;
                }

                // 选中单条边时，Space 进入边标签编辑
                const selectedEdges = selected.filter('edge');
                if (selectedEdges.length === 1 && selectedNodes.length === 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.showInlineEdgeLabelEditor(selectedEdges.first());
                    return;
                }
            }

            // Tab 键：创建子节点
            if (event.key === 'Tab' && !event.shiftKey && !event.repeat) {
                event.preventDefault();
                this.handleCreateChildNode();
                return;
            }

            // Enter 键：创建兄弟节点（仅在没有打开内联编辑器时）
            if (event.key === 'Enter' && !event.repeat) {
                // 检查是否有打开的内联编辑器
                if (!isInlineEditing) {
                    event.preventDefault();
                    this.handleCreateSiblingNode();
                    return;
                }
            }

            // Shift+Tab 键：创建父节点
            if (event.key === 'Tab' && event.shiftKey && !event.repeat) {
                event.preventDefault();
                this.handleCreateParentNode();
                return;
            }

            // 方向键：切换选中节点
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.repeat) {
                // 检查是否有打开的内联编辑器
                if (!isInlineEditing) {
                    event.preventDefault();
                    this.handleArrowKeyNavigation(event.key);
                    return;
                }
            }
        };

        // 监听键盘松开事件
        const handleKeyUp = (event: KeyboardEvent) => {
            // Command/Meta 键：禁用框选模式
            if (event.key === 'Meta') {
                this.isMetaPressed = false;
                if (this.cy) {
                    this.cy.boxSelectionEnabled(false);
                }
            }
        };

        // 添加事件监听器
        this.addManagedDomListener(this.container, 'keydown', handleKeyDown);
        this.addManagedDomListener(this.container, 'keyup', handleKeyUp);
        this.addManagedDomListener(this.container, 'zk-open-search-bar', () => {
            this.showSearchBar();
        });

        // 确保容器可以接收键盘事件
        if (!this.container.hasAttribute('tabindex')) {
            this.container.setAttribute('tabindex', '0');
        }

        // 当容器获得焦点时，自动聚焦
        this.addManagedDomListener(this.container, 'mousedown', () => {
            this.container?.focus();
        });
    }

    /**
     * 判断是否需要重新布局
     */
    private shouldRelayout(changes: GraphChanges): boolean {
        if (!this.currentData) return true;

        const totalChanges = changes.addedNodes.length +
            changes.removedNodes.length +
            changes.addedEdges.length +
            changes.removedEdges.length;

        const currentNodeCount = this.currentData.nodes.length;
        const changeRatio = totalChanges / Math.max(currentNodeCount, 1);

        // 如果变化超过 20%，重新布局
        return changeRatio > 0.2;
    }

    /**
     * 添加分组调整大小手柄
     */
    private addGroupResizeHandles(): void {
        if (!this.cy || !this.container) return;

        // 移除旧的手柄容器
        const oldHandleContainer = this.container.querySelector('.zk-group-resize-handles');
        if (oldHandleContainer) {
            oldHandleContainer.remove();
        }

        // 创建手柄容器
        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-group-resize-handles';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 999;
        `;
        this.container.appendChild(handleContainer);

        let currentHandles: HTMLElement[] = [];
        let selectedGroup: any = null;
        let resizePreview: HTMLElement | null = null;  // 添加预览框

        // 清除所有手柄
        const clearHandles = () => {
            currentHandles.forEach(handle => handle.remove());
            currentHandles = [];
            selectedGroup = null;
            if (resizePreview) {
                resizePreview.remove();
                resizePreview = null;
            }
        };

        // 创建四个角的调整大小手柄
        const createResizeHandles = (groupNode: any) => {
            clearHandles();
            selectedGroup = groupNode;

            const positions = [
                { name: 'nw', cursor: 'nwse-resize', x: 0, y: 0 },      // 左上
                { name: 'ne', cursor: 'nesw-resize', x: 1, y: 0 },      // 右上
                { name: 'sw', cursor: 'nesw-resize', x: 0, y: 1 },      // 左下
                { name: 'se', cursor: 'nwse-resize', x: 1, y: 1 }       // 右下
            ];

            positions.forEach(pos => {
                const handle = document.createElement('div');
                handle.className = `zk-group-resize-handle zk-group-resize-${pos.name}`;
                handle.style.cssText = `
                    position: absolute;
                    width: 10px;
                    height: 10px;
                    background-color: #5b8fd9;
                    border: 2px solid #ffffff;
                    border-radius: 2px;
                    cursor: ${pos.cursor};
                    pointer-events: auto;
                    transform: translate(-50%, -50%);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    z-index: 1000;
                `;
                handleContainer.appendChild(handle);
                currentHandles.push(handle);


                // 绑定拖动事件
                this.bindResizeHandleDrag(handle, groupNode, pos, handleContainer);
            });

            // 更新手柄位置
            updateHandlePositions();
        };

        // 更新手柄位置
        const updateHandlePositions = () => {
            if (!selectedGroup || currentHandles.length === 0) return;
            if (!this.cy) return;

            const bb = selectedGroup.renderedBoundingBox();
            const positions = [
                { x: bb.x1, y: bb.y1 },  // 左上
                { x: bb.x2, y: bb.y1 },  // 右上
                { x: bb.x1, y: bb.y2 },  // 左下
                { x: bb.x2, y: bb.y2 }   // 右下
            ];


            currentHandles.forEach((handle, index) => {
                handle.style.transform = `translate(${positions[index].x}px, ${positions[index].y}px) translate(-50%, -50%)`;
            });
        };

        // 监听分组节点选中事件
        this.cy.on('select', 'node[?isGroup]', (evt: any) => {
            const groupNode = evt.target;
            createResizeHandles(groupNode);
        });

        // 监听分组节点取消选中事件
        this.cy.on('unselect', 'node[?isGroup]', () => {
            clearHandles();
        });

        // 注册到统一 overlay 调度器
        this.overlayUpdaters.add(updateHandlePositions);
    }

    /**
     * 绑定调整大小手柄的拖动事件
     */
    private bindResizeHandleDrag(
        handle: HTMLElement,
        groupNode: any,
        position: { name: string; cursor: string; x: number; y: number },
        handleContainer: HTMLElement
    ): void {
        if (!this.cy || !this.container) return;

        let isDragging = false;
        let startMousePos: { x: number; y: number } | null = null;
        let startBoundingBox: any = null;
        let originalNodeIds: string[] = [];
        let resizePreview: HTMLElement | null = null;

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            startMousePos = { x: e.clientX, y: e.clientY };
            startBoundingBox = groupNode.renderedBoundingBox();
            
            // 记录原始节点列表
            originalNodeIds = groupNode.data('nodeIds') || [];


            // 创建预览框
            resizePreview = document.createElement('div');
            resizePreview.className = 'zk-group-resize-preview';
            resizePreview.style.cssText = `
                position: absolute;
                border: 2px dashed #5b8fd9;
                background-color: rgba(91, 143, 217, 0.1);
                pointer-events: none;
                z-index: 998;
            `;
            handleContainer.appendChild(resizePreview);

            // 禁用 Cytoscape 的平移
            if (this.cy) {
                this.cy.userPanningEnabled(false);
                this.cy.boxSelectionEnabled(false);
            }

            // 添加全局鼠标移动和释放监听器
            let groupResizeRafId: number | null = null;
            let lastResizeMouseX = 0;
            let lastResizeMouseY = 0;
            const handleMouseMove = (e: MouseEvent) => {
                if (!isDragging || !startMousePos || !startBoundingBox || !this.cy) return;
                lastResizeMouseX = e.clientX;
                lastResizeMouseY = e.clientY;

                // 预览框位置立即更新（轻量 DOM 操作）
                const deltaX = (e.clientX - startMousePos.x);
                const deltaY = (e.clientY - startMousePos.y);
                let newX1 = startBoundingBox.x1;
                let newY1 = startBoundingBox.y1;
                let newX2 = startBoundingBox.x2;
                let newY2 = startBoundingBox.y2;
                if (position.x === 0) { newX1 += deltaX; } else { newX2 += deltaX; }
                if (position.y === 0) { newY1 += deltaY; } else { newY2 += deltaY; }
                const minSize = 50;
                if (newX2 - newX1 < minSize || newY2 - newY1 < minSize) return;
                if (resizePreview) {
                    resizePreview.style.transform = `translate(${newX1}px, ${newY1}px)`;
                    resizePreview.style.width = `${newX2 - newX1}px`;
                    resizePreview.style.height = `${newY2 - newY1}px`;
                }

                // 节点遍历和分组更新通过 RAF 节流（重操作）
                if (groupResizeRafId !== null) return;
                groupResizeRafId = requestAnimationFrame(() => {
                    groupResizeRafId = null;
                    if (!isDragging || !startMousePos || !startBoundingBox || !this.cy) return;

                    const dx = (lastResizeMouseX - startMousePos.x);
                    const dy = (lastResizeMouseY - startMousePos.y);
                    let x1 = startBoundingBox.x1;
                    let y1 = startBoundingBox.y1;
                    let x2 = startBoundingBox.x2;
                    let y2 = startBoundingBox.y2;
                    if (position.x === 0) { x1 += dx; } else { x2 += dx; }
                    if (position.y === 0) { y1 += dy; } else { y2 += dy; }
                    if (x2 - x1 < minSize || y2 - y1 < minSize) return;

                    const nodesInBounds: any[] = [];
                    this.cy!.nodes('[!isGroup]').forEach((node: any) => {
                        const nodeBB = node.renderedBoundingBox();
                        const nodeCenterX = (nodeBB.x1 + nodeBB.x2) / 2;
                        const nodeCenterY = (nodeBB.y1 + nodeBB.y2) / 2;
                        if (nodeCenterX >= x1 && nodeCenterX <= x2 &&
                            nodeCenterY >= y1 && nodeCenterY <= y2) {
                            nodesInBounds.push(node);
                        }
                    });

                    const newNodeIds = nodesInBounds
                        .filter(n => n.data('originalNode') && !n.data('isPlaceholder'))
                        .map(n => n.data('originalNode').ID);

                    nodesInBounds.forEach(node => {
                        if (!node.data('isPlaceholder') &&
                            node.data('originalNode') &&
                            !originalNodeIds.includes(node.data('originalNode').ID)) {
                            node.data('parent', groupNode.id());
                        }
                    });

                    this.cy!.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                        if (!node.data('isPlaceholder') && node.data('originalNode')) {
                            const nodeId = node.data('originalNode').ID;
                            if (!newNodeIds.includes(nodeId)) {
                                node.data('parent', undefined);
                            }
                        }
                    });
                });
            };

            const handleMouseUp = (e: MouseEvent) => {
                if (!isDragging) return;

                isDragging = false;

                // 移除预览框
                if (resizePreview) {
                    resizePreview.remove();
                    resizePreview = null;
                }

                // 恢复 Cytoscape 的平移
                if (this.cy) {
                    this.cy.userPanningEnabled(true);
                    this.cy.boxSelectionEnabled(true);
                }

                // 重新计算最终边界（使用最终鼠标位置）
                if (startMousePos && startBoundingBox && this.cy) {
                    const deltaX = e.clientX - startMousePos.x;
                    const deltaY = e.clientY - startMousePos.y;

                    let newX1 = startBoundingBox.x1;
                    let newY1 = startBoundingBox.y1;
                    let newX2 = startBoundingBox.x2;
                    let newY2 = startBoundingBox.y2;

                    if (position.x === 0) {
                        newX1 += deltaX;
                    } else {
                        newX2 += deltaX;
                    }

                    if (position.y === 0) {
                        newY1 += deltaY;
                    } else {
                        newY2 += deltaY;
                    }


                    // 确保最小尺寸
                    const minSize = 50;
                    if (newX2 - newX1 >= minSize && newY2 - newY1 >= minSize) {
                        // 查找最终边界内的所有节点
                        const nodesInBounds: any[] = [];
                        this.cy.nodes('[!isGroup]').forEach((node: any) => {
                            const nodeBB = node.renderedBoundingBox();
                            const nodeCenterX = (nodeBB.x1 + nodeBB.x2) / 2;
                            const nodeCenterY = (nodeBB.y1 + nodeBB.y2) / 2;

                            if (nodeCenterX >= newX1 && nodeCenterX <= newX2 &&
                                nodeCenterY >= newY1 && nodeCenterY <= newY2) {
                                nodesInBounds.push(node);
                            }
                        });


                        // 清除所有当前的 parent 关系
                        this.cy.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                            node.data('parent', undefined);
                        });

                        // 设置新的 parent 关系
                        nodesInBounds.forEach(node => {
                            const currentParent = node.data('parent');
                            const isGroup = node.data('isGroup');
                            const nodeId = node.data('originalNode')?.ID || node.id();
                    
                            // 分组节点不能作为子节点
                            if (isGroup) {
                                return;
                            }
                            
                            // 使用 move() 方法移动节点到新的 parent
                            try {
                                if (currentParent !== groupNode.id()) {
                                    node.move({ parent: groupNode.id() });

                                }
                            } catch (error) {
                                console.warn('  Failed to move node:', error);
                            }
                        });                    
                    }
                }

                // 获取最终的节点列表
                const finalNodeIds: string[] = [];
                this.cy?.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                    if (!node.data('isPlaceholder') && node.data('originalNode')) {
                        const nodeId = node.data('originalNode').ID;
                        finalNodeIds.push(nodeId);
                    }
                });


                // 更新分组的 nodeIds 数据
                groupNode.data('nodeIds', finalNodeIds);

                // 强制 Cytoscape 重新计算分组边界
                if (this.cy) {
                    // 触发布局更新
                    this.cy.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                        node.trigger('position');
                    });
                    
                    // 强制重绘
                    this.cy.forceRender();
                }

                // 触发分组更新事件
                if (finalNodeIds.length > 0 && 
                    JSON.stringify(finalNodeIds.sort()) !== JSON.stringify(originalNodeIds.sort())) {
                    this.container?.dispatchEvent(new CustomEvent('group-resize', {
                        detail: {
                            groupId: groupNode.id(),
                            groupLabel: groupNode.data('label'),
                            nodeIds: finalNodeIds
                        }
                    }));
                }

                // 移除全局监听器
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
    }

    /**
     * 选择选择框内的节点
     */
    private selectNodesInBox(left: number, top: number, width: number, height: number): void {
        if (!this.cy) return;

        const nodes = this.cy.nodes().filter((node: any) => !node.data('isGroup'));

        nodes.forEach((node: any) => {
            const bbox = node.renderedBoundingBox();
            const intersects = !(
                bbox.x2 < left ||
                bbox.x1 > left + width ||
                bbox.y2 < top ||
                bbox.y1 > top + height
            );

            if (intersects) {
                node.select();
            }
        });
    }

    /**
     * 初始化框选功能
     */
    private initBoxSelection(): void {
        if (!this.cy || !this.container) return;

        this.boxSelectionElement?.remove();

        // 创建选择框元素
        const selectionBox = document.createElement('div');
        selectionBox.className = 'zk-selection-box';
        selectionBox.style.cssText = `
            position: absolute;
            left: 0;
            top: 0;
            display: none;
            border: 2px dashed #5b8fd9;
            background-color: rgba(91, 143, 217, 0.1);
            border-radius: 4px;
            pointer-events: none;
            z-index: 9999;
            will-change: transform;
        `;
        this.container.appendChild(selectionBox);
        this.boxSelectionElement = selectionBox;

        let isDragging = false;
        let hasMoved = false;  // 标记是否真正移动了鼠标
        let startX = 0;
        let startY = 0;
        let isMultiSelect = false;

        // 鼠标按下开始框选
        this.addManagedDomListener(this.container, 'mousedown', (e: MouseEvent) => {
            const target = e.target as HTMLElement;

            // 只在 canvas 上点击时才开始框选
            if (target.tagName !== 'CANVAS') return;

            // 只有左键（button === 0）才能触发框选
            if (e.button !== 0) return;

            // 必须按住 Command 键才能开始框选
            if (!e.metaKey && !e.ctrlKey) return;

            // 检查点击位置是否有节点
            if (this.cy) {
                const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
                const clickX = e.clientX - rect.left;
                const clickY = e.clientY - rect.top;

                // 检查点击位置是否在某个节点上
                const clickedNode = this.cy.$('node').filter((node: any) => {
                    const bbox = node.renderedBoundingBox();
                    return clickX >= bbox.x1 && clickX <= bbox.x2 &&
                           clickY >= bbox.y1 && clickY <= bbox.y2;
                });

                // 如果点击在节点上，不开始框选
                if (clickedNode.length > 0) {
                    return;
                }
            }

            // 检查是否按住多选键
            isMultiSelect = e.shiftKey || e.ctrlKey || e.metaKey;

            // 如果没有按住多选键，先清除现有选择
            if (!isMultiSelect && this.cy) {
                this.cy.$(':selected').unselect();
                this.hideBatchToolbar();
            }

            const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;
            isDragging = true;
            hasMoved = false;  // 重置移动标记

            // 显示选择框
            selectionBox.style.display = 'block';
            selectionBox.style.transform = `translate(${startX}px, ${startY}px)`;
            selectionBox.style.width = '0px';
            selectionBox.style.height = '0px';

            e.preventDefault();
        });

        // 鼠标移动更新选择框
        let boxSelectRafId: number | null = null;
        let lastBoxLeft = 0, lastBoxTop = 0, lastBoxWidth = 0, lastBoxHeight = 0;
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;

            const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
            const currentX = e.clientX - rect.left;
            const currentY = e.clientY - rect.top;

            if (Math.abs(currentX - startX) > 5 || Math.abs(currentY - startY) > 5) {
                hasMoved = true;
            }

            lastBoxLeft = Math.min(startX, currentX);
            lastBoxTop = Math.min(startY, currentY);
            lastBoxWidth = Math.abs(currentX - startX);
            lastBoxHeight = Math.abs(currentY - startY);

            // 选择框视觉立即更新
            selectionBox.style.transform = `translate(${lastBoxLeft}px, ${lastBoxTop}px)`;
            selectionBox.style.width = `${lastBoxWidth}px`;
            selectionBox.style.height = `${lastBoxHeight}px`;

            // 节点选择检测通过 RAF 节流
            if (boxSelectRafId !== null) return;
            boxSelectRafId = requestAnimationFrame(() => {
                boxSelectRafId = null;
                if (!isDragging) return;
                this.selectNodesInBox(lastBoxLeft, lastBoxTop, lastBoxWidth, lastBoxHeight);
            });
        };

        // 鼠标释放结束框选
        const handleMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;

            // 隐藏选择框
            selectionBox.style.display = 'none';

            // 只有在真正移动了鼠标（框选操作）时才显示批量工具栏
            if (hasMoved) {
                setTimeout(() => {
                    this.showBatchToolbar();
                }, 20);
            }
        };

        this.addManagedDomListener(document, 'mousemove', handleMouseMove);
        this.addManagedDomListener(document, 'mouseup', handleMouseUp);
    }

    /**
     * 显示批量操作工具栏
     */
    private showBatchToolbar(): void {
        if (!this.cy || !this.container) return;
        if (this.isReadOnlyMode()) {
            this.hideBatchToolbar();
            return;
        }

        const selectedNodes = this.cy.$(':selected').filter('node[!isGroup]');
        const count = selectedNodes.length;

        if (count < 2) {
            this.hideBatchToolbar();
            return;
        }

        // 保存选中的节点ID（使用 originalNode.IDStr）
        this.batchSelectedNodeIds = [];
        this.batchSelectedNodes = [];
        selectedNodes.forEach((node: any) => {
            const data = node.data();
            if (data.originalNode && data.originalNode.IDStr) {
                this.batchSelectedNodeIds.push(data.originalNode.IDStr);
                this.batchSelectedNodes.push({
                    IDStr: data.originalNode.IDStr,
                    isCrossDomain: data.originalNode.isCrossDomain || false,
                    originalNode: data.originalNode
                });
            }
        });

        // 如果正在退出动画中，先移除
        let toolbar = this.container.querySelector('.zk-batch-toolbar') as HTMLElement | null;
        if (toolbar && toolbar.classList.contains('zk-batch-toolbar-exiting')) {
            toolbar.remove();
            toolbar = null;
        }
        if (!toolbar) {
            toolbar = this.createBatchToolbar();
            this.container.appendChild(toolbar);
        }

        // 更新计数
        const countLabel = toolbar.querySelector('.zk-batch-toolbar-count');
        if (countLabel) {
            countLabel.textContent = t('batch selected count').replace('{count}', String(count));
        }
    }

    /**
     * 显示搜索栏（Cmd+F）
     */
    private showSearchBar(): void {
        if (!this.cy || !this.container) return;

        // 如果已有搜索栏，聚焦输入框
        const existing = this.container.querySelector('.zk-search-bar');
        if (existing) {
            const input = existing.querySelector('.zk-search-bar-input') as HTMLInputElement;
            input?.focus();
            input?.select();
            return;
        }

        let matchedNodes: any[] = [];
        let filteredNodes: any[] = [];
        let currentIndex = -1;
        let activeSuggestionIndex = -1;

        const bar = document.createElement('div');
        bar.className = 'zk-search-bar';

        // 阻止事件穿透到画布
        bar.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
        bar.addEventListener('mousedown', (e) => { e.stopPropagation(); });

        const inputWrap = document.createElement('div');
        inputWrap.className = 'zk-search-bar-input-wrap';
        bar.appendChild(inputWrap);

        // 搜索输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'zk-search-bar-input';
        input.placeholder = t('search placeholder');
        inputWrap.appendChild(input);

        // 候选框
        const suggestionBox = document.createElement('div');
        suggestionBox.className = 'zk-search-suggestions zk-hidden';
        inputWrap.appendChild(suggestionBox);

        // 计数
        const countLabel = document.createElement('span');
        countLabel.className = 'zk-search-bar-count';
        countLabel.textContent = '';
        bar.appendChild(countLabel);

        // 上一个
        const prevBtn = document.createElement('button');
        prevBtn.className = 'zk-search-bar-btn';
        setIcon(prevBtn, 'chevron-up');
        prevBtn.title = 'Previous';
        bar.appendChild(prevBtn);

        // 下一个
        const nextBtn = document.createElement('button');
        nextBtn.className = 'zk-search-bar-btn';
        setIcon(nextBtn, 'chevron-down');
        nextBtn.title = 'Next';
        bar.appendChild(nextBtn);

        // 关闭
        const closeBtn = document.createElement('button');
        closeBtn.className = 'zk-search-bar-btn';
        setIcon(closeBtn, 'x');
        bar.appendChild(closeBtn);

        this.container.appendChild(bar);

        const clearHighlights = () => {
            this.cy?.nodes().forEach((n: any) => n.removeClass('zk-search-highlight'));
        };

        const highlightCurrent = () => {
            clearHighlights();
            if (matchedNodes.length === 0 || currentIndex < 0) return;
            const node = matchedNodes[currentIndex];
            node.addClass('zk-search-highlight');
            this.cy?.animate({ center: { eles: node }, duration: 200 });
            node.select();
        };

        const updateCount = () => {
            if (!input.value.trim()) {
                countLabel.textContent = '';
            } else if (matchedNodes.length > 0 && currentIndex >= 0) {
                countLabel.textContent = `${currentIndex + 1}/${matchedNodes.length}`;
            } else {
                countLabel.textContent = `${filteredNodes.length}`;
            }
        };

        const renderSuggestions = () => {
            suggestionBox.empty();
            if (!input.value.trim() || filteredNodes.length === 0) {
                suggestionBox.addClass('zk-hidden');
                return;
            }

            const visibleCount = Math.min(filteredNodes.length, 12);
            for (let i = 0; i < visibleCount; i++) {
                const node = filteredNodes[i];
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'zk-search-suggestion-item';
                if (i === activeSuggestionIndex) {
                    item.addClass('is-active');
                }

                const origNode = node.data('originalNode');
                const title = origNode?.title || node.data('label') || '';
                item.textContent = title;

                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                item.addEventListener('click', () => {
                    matchedNodes = filteredNodes;
                    currentIndex = i;
                    highlightCurrent();
                    updateCount();
                    suggestionBox.addClass('zk-hidden');
                    input.focus();
                });
                suggestionBox.appendChild(item);
            }

            suggestionBox.removeClass('zk-hidden');
        };

        const doSearch = () => {
            const term = input.value.trim().toLowerCase();
            clearHighlights();
            matchedNodes = [];
            filteredNodes = [];
            currentIndex = -1;
            activeSuggestionIndex = -1;

            if (!term || !this.cy) {
                suggestionBox.addClass('zk-hidden');
                updateCount();
                return;
            }

            this.cy.nodes('[!isGroup]').forEach((node: any) => {
                const label = (node.data('label') || '').toLowerCase();
                const origNode = node.data('originalNode');
                const filePath = (origNode?.file?.path || '').toLowerCase();
                if (/(^|\/)attachments\//.test(filePath)) {
                    return;
                }
                const idStr = (origNode?.IDStr || '').toLowerCase();
                const title = (origNode?.title || '').toLowerCase();
                if (label.includes(term) || idStr.includes(term) || title.includes(term)) {
                    filteredNodes.push(node);
                }
            });

            renderSuggestions();
            updateCount();
        };

        const goNext = () => {
            if (matchedNodes.length === 0 && filteredNodes.length > 0) {
                matchedNodes = filteredNodes;
                currentIndex = 0;
                highlightCurrent();
                updateCount();
                return;
            }
            if (matchedNodes.length === 0) return;
            currentIndex = (currentIndex + 1) % matchedNodes.length;
            highlightCurrent();
            updateCount();
        };

        const goPrev = () => {
            if (matchedNodes.length === 0 && filteredNodes.length > 0) {
                matchedNodes = filteredNodes;
                currentIndex = Math.max(0, matchedNodes.length - 1);
                highlightCurrent();
                updateCount();
                return;
            }
            if (matchedNodes.length === 0) return;
            currentIndex = (currentIndex - 1 + matchedNodes.length) % matchedNodes.length;
            highlightCurrent();
            updateCount();
        };

        const closeSearch = () => {
            clearHighlights();
            suggestionBox.addClass('zk-hidden');
            // 先收起键盘，等视口恢复后再移除搜索栏，避免移动端工具栏上移
            input.blur();
            setTimeout(() => {
                bar.remove();
            }, 100);
        };

        input.addEventListener('input', doSearch);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' && !suggestionBox.classList.contains('zk-hidden') && filteredNodes.length > 0) {
                e.preventDefault();
                const total = Math.min(filteredNodes.length, 12);
                activeSuggestionIndex = (activeSuggestionIndex + 1 + total) % total;
                renderSuggestions();
            } else if (e.key === 'ArrowUp' && !suggestionBox.classList.contains('zk-hidden') && filteredNodes.length > 0) {
                e.preventDefault();
                const total = Math.min(filteredNodes.length, 12);
                activeSuggestionIndex = (activeSuggestionIndex - 1 + total) % total;
                renderSuggestions();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                doSearch();
                if (filteredNodes.length > 0) {
                    if (activeSuggestionIndex < 0) {
                        activeSuggestionIndex = 0;
                    }
                    matchedNodes = filteredNodes;
                    currentIndex = activeSuggestionIndex;
                    highlightCurrent();
                    updateCount();
                    suggestionBox.addClass('zk-hidden');
                } else if (e.shiftKey) {
                    goPrev();
                } else {
                    goNext();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
            }
        });
        input.addEventListener('focus', () => {
            if (filteredNodes.length > 0) {
                renderSuggestions();
            }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => suggestionBox.addClass('zk-hidden'), 120);
        });

        prevBtn.addEventListener('click', goPrev);
        nextBtn.addEventListener('click', goNext);
        closeBtn.addEventListener('click', closeSearch);

        // 移动端触摸支持
        prevBtn.addEventListener('touchend', (e) => { e.preventDefault(); goPrev(); });
        nextBtn.addEventListener('touchend', (e) => { e.preventDefault(); goNext(); });
        closeBtn.addEventListener('touchend', (e) => { e.preventDefault(); closeSearch(); });

        // 自动聚焦
        setTimeout(() => input.focus(), 50);
    }

    /**
     * 隐藏批量操作工具栏
     */
    private hideBatchToolbar(): void {
        const toolbar = this.container?.querySelector('.zk-batch-toolbar') as HTMLElement | null;
        if (!toolbar) return;

        if (toolbar.classList.contains('zk-batch-toolbar-exiting')) return;

        toolbar.classList.add('zk-batch-toolbar-exiting');
        toolbar.addEventListener('animationend', () => {
            toolbar.remove();
        }, { once: true });

        // 兜底：动画未触发时也能移除
        setTimeout(() => {
            if (toolbar.parentNode) {
                toolbar.remove();
            }
        }, 250);
    }

    /**
     * 创建批量操作工具栏
     */
    private createBatchToolbar(): HTMLElement {
        const toolbar = document.createElement('div');
        toolbar.className = 'zk-batch-toolbar';

        // 防止事件穿透到画布
        const stopPropagation = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
        };
        toolbar.addEventListener('pointerdown', stopPropagation);
        toolbar.addEventListener('mousedown', stopPropagation);

        // 计数徽章
        const countBadge = document.createElement('span');
        countBadge.className = 'zk-batch-toolbar-count';
        countBadge.textContent = t('batch selected count').replace('{count}', '0');
        toolbar.appendChild(countBadge);

        // 分隔线
        const divider1 = document.createElement('div');
        divider1.className = 'zk-batch-toolbar-divider';
        toolbar.appendChild(divider1);

        // 分组按钮
        toolbar.appendChild(this.createToolbarButton('group', t('batch group'), '', () => this.batchCreateGroup()));

        // 删除按钮
        toolbar.appendChild(this.createToolbarButton('trash-2', t('batch delete'), 'zk-batch-btn-delete', () => this.batchDeleteNodes()));

        // 改颜色按钮
        toolbar.appendChild(this.createToolbarButton('palette', t('batch change color'), '', () => this.batchChangeColor()));

        // 分隔线
        const divider2 = document.createElement('div');
        divider2.className = 'zk-batch-toolbar-divider';
        toolbar.appendChild(divider2);

        // 取消按钮
        toolbar.appendChild(this.createToolbarButton('x', t('batch cancel'), 'zk-batch-btn-cancel', () => {
            if (this.cy) {
                this.cy.$(':selected').unselect();
            }
            this.hideBatchToolbar();
        }));

        return toolbar;
    }

    /**
     * 创建工具栏按钮（带 Lucide 图标）
     */
    private createToolbarButton(iconName: string, label: string, extraClass: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.className = `zk-batch-toolbar-btn ${extraClass}`.trim();

        // 图标
        const iconEl = document.createElement('span');
        iconEl.className = 'zk-batch-toolbar-icon';
        setIcon(iconEl, iconName);
        btn.appendChild(iconEl);

        // 文字
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        btn.appendChild(labelEl);

        btn.onclick = (event: MouseEvent) => {
            event.stopPropagation();
            onClick();
        };

        return btn;
    }

    /**
     * 批量创建分组
     */
    private batchCreateGroup(): void {
        if (this.batchSelectedNodeIds.length === 0) {
            return;
        }

        // 先隐藏工具栏，避免遮挡输入框
        this.hideBatchToolbar();

        // 批量分组：统一走 batch-create-group 事件链路（由 indexView 持久化）
        this.showGroupNameDialog((groupName) => {
            if (!groupName) {
                // 取消时恢复工具栏
                this.showBatchToolbar();
                return;
            }

            this.container?.dispatchEvent(new CustomEvent('batch-create-group', {
                detail: {
                    nodeIds: [...this.batchSelectedNodeIds],
                    groupName
                }
            }));

            // 清空选中缓存
            this.batchSelectedNodeIds = [];
            this.batchSelectedNodes = [];
        });
    }

    /**
     * 获取当前活动的节点（第一个选中的节点）
     */
    private getActiveNode(): any | null {
        if (!this.cy) return null;

        const selectedNodes = this.cy.$('node:selected');

        if (selectedNodes.length === 0) {
            new Notice('请先选择一个节点');
            return null;
        }

        return selectedNodes.first();
    }

    private normalizeVector(vx: number, vy: number): { x: number; y: number } {
        const len = Math.hypot(vx, vy);
        if (len < 1e-6) return { x: 1, y: 0 };
        return { x: vx / len, y: vy / len };
    }

    private getBranchDirection(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const parent = activeNode.incomers('edge').sources();
        if (parent.length > 0) {
            const parentPos = parent.first().position();
            return this.normalizeVector(nodePos.x - parentPos.x, nodePos.y - parentPos.y);
        }

        // 根节点：优先使用占用最少的象限方向
        const children = activeNode.outgoers('edge').targets();
        if (children.length === 0) return { x: 1, y: 0 };

        const cardinal = [
            { x: 1, y: 0 },   // 右
            { x: -1, y: 0 },  // 左
            { x: 0, y: 1 },   // 下
            { x: 0, y: -1 }   // 上
        ];
        const score = [0, 0, 0, 0];

        children.forEach((child: any) => {
            const cp = child.position();
            const dir = this.normalizeVector(cp.x - nodePos.x, cp.y - nodePos.y);
            let bestIndex = 0;
            let bestDot = -Infinity;
            cardinal.forEach((c, idx) => {
                const dot = dir.x * c.x + dir.y * c.y;
                if (dot > bestDot) {
                    bestDot = dot;
                    bestIndex = idx;
                }
            });
            score[bestIndex] += 1;
        });

        let minIdx = 0;
        for (let i = 1; i < score.length; i++) {
            if (score[i] < score[minIdx]) minIdx = i;
        }
        return cardinal[minIdx];
    }

    private getAutoLayoutDirection(node: any): { x: number; y: number } {
        const lineage: any[] = [node];
        let current = node;
        while (true) {
            const parents = current.incomers('edge').sources().filter((n: any) => !n.data('isGroup'));
            if (!parents || parents.length === 0) break;
            current = parents.first();
            lineage.push(current);
        }

        const root = lineage[lineage.length - 1];
        if (root.id() === node.id()) {
            return { x: 1, y: 0 };
        }

        const branchAnchor = lineage.length >= 2 ? lineage[lineage.length - 2] : node;
        const rootPos = root.position();
        const anchorPos = branchAnchor.position();
        const dx = anchorPos.x - rootPos.x;
        const dy = anchorPos.y - rootPos.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
            return { x: dx >= 0 ? 1 : -1, y: 0 };
        }
        return { x: 0, y: dy >= 0 ? 1 : -1 };
    }

    private getPerpendicular(dir: { x: number; y: number }): { x: number; y: number } {
        return { x: -dir.y, y: dir.x };
    }

    private getAutoLayoutStackDirection(dir: { x: number; y: number }): { x: number; y: number } {
        if (Math.abs(dir.x) > 0.5) {
            return { x: 0, y: 1 };
        }
        return { x: 1, y: 0 };
    }

    private nextOffsetByProjection(points: any[], anchor: { x: number; y: number }, normal: { x: number; y: number }, gap: number): number {
        const projections = points.map((n: any) => {
            const p = n.position();
            return (p.x - anchor.x) * normal.x + (p.y - anchor.y) * normal.y;
        });

        if (projections.length === 0) return 0;

        // 让新增节点延续当前侧向增长：优先正向堆叠，碰撞则继续外扩
        let offset = Math.max(...projections) + gap;
        const isOccupied = (candidate: number) => projections.some(v => Math.abs(v - candidate) < gap * 0.8);
        while (isOccupied(offset)) {
            offset += gap;
        }
        return offset;
    }

    private isAutoNodeLayoutStyle(): boolean {
        const style = this.currentOptions?.nodeLayoutStyle;
        if (typeof style !== 'string') return false;
        return style.trim().toLowerCase() === 'auto';
    }

    /**
     * 沿 ID 父链向上查找覆盖；未命中则回退到文件级默认
     */
    private isNodeAutoLayoutForId(nodeId: string): boolean {
        const overrides = this.currentOptions?.nodeLayoutOverrides || {};
        let current = nodeId;
        while (current.length > 0) {
            const override = overrides[current];
            if (override !== undefined) return override === 'auto';
            const parts: string[] = current.split('.');
            if (parts.length <= 1) break;
            current = parts.slice(0, -1).join('.');
        }
        return this.isAutoNodeLayoutStyle();
    }

    private estimateCollisionBox(referenceNode: any): { width: number; height: number } {
        const width = Math.max(Number(referenceNode.width?.() || 0), 120);
        const height = Math.max(Number(referenceNode.height?.() || 0), 64);
        return {
            width: width + 36,
            height: height + 30
        };
    }

    private getAxisSpan(size: { width: number; height: number }, dir: { x: number; y: number }): number {
        return Math.abs(dir.x) >= Math.abs(dir.y) ? size.width : size.height;
    }

    private getDirectionalDistance(referenceNode: any, dir: { x: number; y: number }, extraGap: number = 48): number {
        const referenceSize = this.estimateCollisionBox(referenceNode);
        const estimatedNewSize = referenceSize;
        const referenceSpan = this.getAxisSpan(referenceSize, dir);
        const newSpan = this.getAxisSpan(estimatedNewSize, dir);
        return referenceSpan / 2 + newSpan / 2 + extraGap;
    }

    private isPositionColliding(
        candidate: { x: number; y: number },
        size: { width: number; height: number },
        excludeNodeIds: string[] = []
    ): boolean {
        if (!this.cy) return false;

        const marginX = 26;
        const marginY = 22;
        const candidateRect = {
            x1: candidate.x - size.width / 2 - marginX,
            x2: candidate.x + size.width / 2 + marginX,
            y1: candidate.y - size.height / 2 - marginY,
            y2: candidate.y + size.height / 2 + marginY
        };

        return this.cy.nodes('[!isGroup]').some((node: any) => {
            if (node.removed() || !node.visible()) return false;
            if (node.hasClass('zk-collapsed-hidden')) return false;
            if (node.data('isPlaceholder')) return false;
            if (excludeNodeIds.includes(node.id())) return false;

            const pos = node.position();
            const otherWidth = Math.max(Number(node.width?.() || 0), 80);
            const otherHeight = Math.max(Number(node.height?.() || 0), 44);
            const otherRect = {
                x1: pos.x - otherWidth / 2 - marginX,
                x2: pos.x + otherWidth / 2 + marginX,
                y1: pos.y - otherHeight / 2 - marginY,
                y2: pos.y + otherHeight / 2 + marginY
            };

            const separated =
                candidateRect.x2 <= otherRect.x1 ||
                candidateRect.x1 >= otherRect.x2 ||
                candidateRect.y2 <= otherRect.y1 ||
                candidateRect.y1 >= otherRect.y2;

            return !separated;
        });
    }

    private resolveShortcutPosition(
        basePosition: { x: number; y: number },
        referenceNode: any,
        primaryAxis: { x: number; y: number },
        step: number,
        secondaryAxis?: { x: number; y: number },
        maxAttempts: number = 7
    ): { x: number; y: number } {
        const size = this.estimateCollisionBox(referenceNode);
        const excludeNodeIds = [referenceNode.id()];
        const tryCandidate = (candidate: { x: number; y: number }) =>
            !this.isPositionColliding(candidate, size, excludeNodeIds);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let candidate = { ...basePosition };

            if (attempt > 0) {
                const ring = Math.ceil(attempt / 2);
                const sign = attempt % 2 === 1 ? 1 : -1;
                candidate = {
                    x: basePosition.x + primaryAxis.x * step * ring * sign,
                    y: basePosition.y + primaryAxis.y * step * ring * sign
                };

                if (secondaryAxis && attempt >= 3) {
                    candidate.x += secondaryAxis.x * step * 0.35 * ring;
                    candidate.y += secondaryAxis.y * step * 0.35 * ring;
                }
            }

            if (tryCandidate(candidate)) {
                return candidate;
            }
        }

        const secondary = secondaryAxis || { x: -primaryAxis.y, y: primaryAxis.x };
        for (let ring = 1; ring <= maxAttempts + 14; ring++) {
            const offsets = [
                { a: ring, b: 0 },
                { a: ring, b: 1 },
                { a: ring, b: -1 },
                { a: ring, b: 2 },
                { a: ring, b: -2 },
                { a: -ring, b: 0 },
                { a: -ring, b: 1 },
                { a: -ring, b: -1 }
            ];

            for (const offset of offsets) {
                const candidate = {
                    x: basePosition.x + primaryAxis.x * step * offset.a + secondary.x * step * 0.7 * offset.b,
                    y: basePosition.y + primaryAxis.y * step * offset.a + secondary.y * step * 0.7 * offset.b
                };
                if (tryCandidate(candidate)) {
                    return candidate;
                }
            }
        }

        return {
            x: basePosition.x + primaryAxis.x * step * (maxAttempts + 16) + secondary.x * step * 1.4,
            y: basePosition.y + primaryAxis.y * step * (maxAttempts + 16) + secondary.y * step * 1.4
        };
    }

    /**
     * 处理创建子节点（Tab 键）
     * SimpleMind 风格：子节点基于视觉位置而非 ID
     */
    private getFreeChildShortcutPosition(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const children = activeNode.outgoers('edge').targets();
        const dir = this.getBranchDirection(activeNode);
        const normal = this.getPerpendicular(dir);
        const directionalDistance = this.getDirectionalDistance(activeNode, dir);
        const anchor = {
            x: nodePos.x + dir.x * directionalDistance,
            y: nodePos.y + dir.y * directionalDistance
        };
        const offset = this.nextOffsetByProjection(children, anchor, normal, this.VERTICAL_GAP);
        const rawPosition = {
            x: anchor.x + normal.x * offset,
            y: anchor.y + normal.y * offset
        };
        return this.resolveShortcutPosition(
            rawPosition,
            activeNode,
            normal,
            this.VERTICAL_GAP,
            dir
        );
    }

    private getAutoChildShortcutPosition(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const children = activeNode.outgoers('edge').targets();
        const dir = this.getAutoLayoutDirection(activeNode);
        const normal = this.getAutoLayoutStackDirection(dir);

        if (children.length > 0) {
            let lastChild: any = null;
            let maxProj = -Infinity;
            children.forEach((child: any) => {
                const cp = child.position();
                const proj = (cp.x - nodePos.x) * normal.x + (cp.y - nodePos.y) * normal.y;
                if (proj > maxProj) {
                    maxProj = proj;
                    lastChild = child;
                }
            });
            const lastPos = lastChild.position();
            return {
                x: lastPos.x + normal.x * this.SIBLING_GAP,
                y: lastPos.y + normal.y * this.SIBLING_GAP
            };
        }

        const anchor = {
            x: nodePos.x + dir.x * this.HORIZONTAL_GAP,
            y: nodePos.y + dir.y * this.HORIZONTAL_GAP
        };
        const offset = this.nextOffsetByProjection(children, anchor, normal, this.VERTICAL_GAP);
        return {
            x: anchor.x + normal.x * offset,
            y: anchor.y + normal.y * offset
        };
    }

    private handleCreateChildNode(): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodeData = activeNode.data();
        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;
        const finalPosition = this.isAutoNodeLayoutStyle()
            ? this.getAutoChildShortcutPosition(activeNode)
            : this.getFreeChildShortcutPosition(activeNode);

        this.container?.dispatchEvent(new CustomEvent('create-child-node-shortcut', {
            detail: { activeNodeId, position: finalPosition }
        }));
    }

    /**
     * 处理创建兄弟节点（Enter 键）
     * SimpleMind 风格：自动推开下方的兄弟节点及其子树
     */
    private getFreeSiblingShortcutPosition(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const parent = activeNode.incomers('edge').sources();
        if (parent.length === 0) {
            // 无父节点，直接在下方生成
            const downDir = { x: 0, y: 1 };
            const directionalDistance = this.getDirectionalDistance(activeNode, downDir, 36);
            const basePosition = { x: nodePos.x, y: nodePos.y + directionalDistance };
            return this.resolveShortcutPosition(
                basePosition,
                activeNode,
                downDir,
                directionalDistance,
                { x: 1, y: 0 },
                5
            );
        }

        // 有父节点时，沿垂直于父→子方向排列兄弟
        const parentPos = parent.first().position();
        const dir = this.getBranchDirection(activeNode);
        const normal = this.getPerpendicular(dir);
        const siblings = parent.first().outgoers('edge').targets();
        const siblingGap = this.getDirectionalDistance(activeNode, normal, 28);

        // 基础位置：在活动节点的法线方向偏移一个间距
        const basePosition = {
            x: nodePos.x + normal.x * siblingGap,
            y: nodePos.y + normal.y * siblingGap
        };

        return this.resolveShortcutPosition(
            basePosition,
            activeNode,
            normal,
            siblingGap,
            dir,
            5
        );
    }

    private getAutoSiblingShortcutPosition(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const parent = activeNode.incomers('edge').sources();
        const parentPos = parent.first().position();
        const siblings = parent.first().outgoers('edge').targets();
        const dir = this.getAutoLayoutDirection(activeNode);
        const normal = this.getAutoLayoutStackDirection(dir);
        const siblingGap = Math.max(this.SIBLING_GAP, this.VERTICAL_GAP + 40);
        const anchor = {
            x: parentPos.x + dir.x * this.HORIZONTAL_GAP,
            y: parentPos.y + dir.y * this.HORIZONTAL_GAP
        };
        const activeProj = (nodePos.x - anchor.x) * normal.x + (nodePos.y - anchor.y) * normal.y;
        let offset = activeProj + siblingGap;

        const projections = siblings.map((sib: any) => {
            const p = sib.position();
            return (p.x - anchor.x) * normal.x + (p.y - anchor.y) * normal.y;
        });
        const isOccupied = (candidate: number) => projections.some((v: number) => Math.abs(v - candidate) < siblingGap * 0.8);
        while (isOccupied(offset)) {
            offset += siblingGap;
        }

        return {
            x: anchor.x + normal.x * offset,
            y: anchor.y + normal.y * offset
        };
    }

    private handleCreateSiblingNode(): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodeData = activeNode.data();
        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;
        const nodePos = activeNode.position();
        const parent = activeNode.incomers('edge').sources();
        if (parent.length === 0) return;

        const finalPosition = this.isAutoNodeLayoutStyle()
            ? this.getAutoSiblingShortcutPosition(activeNode)
            : this.getFreeSiblingShortcutPosition(activeNode);

        // 触发创建兄弟节点事件
        this.container?.dispatchEvent(new CustomEvent('create-sibling-node-shortcut', {
            detail: {
                activeNodeId: activeNodeId,
                position: finalPosition
            }
        }));
    }

    /**
     * 处理创建父节点（Shift+Tab 键）
     */
    private getFreeParentShortcutPosition(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const dir = this.getBranchDirection(activeNode);
        const directionalDistance = this.getDirectionalDistance(activeNode, dir);
        const rawPosition = {
            x: nodePos.x - dir.x * directionalDistance,
            y: nodePos.y - dir.y * directionalDistance
        };
        return this.resolveShortcutPosition(
            rawPosition,
            activeNode,
            this.getPerpendicular(dir),
            this.VERTICAL_GAP,
            { x: -dir.x, y: -dir.y }
        );
    }

    private getAutoParentShortcutPosition(activeNode: any): { x: number; y: number } {
        const nodePos = activeNode.position();
        const dir = this.getBranchDirection(activeNode);
        return {
            x: nodePos.x - dir.x * this.HORIZONTAL_GAP,
            y: nodePos.y - dir.y * this.HORIZONTAL_GAP
        };
    }

    private handleCreateParentNode(): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const finalPosition = this.isAutoNodeLayoutStyle()
            ? this.getAutoParentShortcutPosition(activeNode)
            : this.getFreeParentShortcutPosition(activeNode);
        const nodeData = activeNode.data();

        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;


        // 触发创建父节点事件
        this.container?.dispatchEvent(new CustomEvent('create-parent-node-shortcut', {
            detail: {
                activeNodeId: activeNodeId,
                position: finalPosition
            }
        }));
    }

    /**
     * 创建占位符节点到父节点的连接线（绿色虚线）
     */
    private createPlaceholderConnectionLine(placeholderNodeId: string, parentNodeId: string): void {
        if (!this.cy || !this.container) return;

        const placeholderNode = this.cy.$id(placeholderNodeId);
        const parentNode = this.cy.$('node').filter((node: any) => {
            const data = node.data();
            return data.originalNode && data.originalNode.IDStr === parentNodeId;
        });

        if (!placeholderNode || placeholderNode.length === 0) {
            console.warn('[CytoscapeRenderer] 未找到占位符节点', placeholderNodeId);
            return;
        }

        if (!parentNode || parentNode.length === 0) {
            console.warn('[CytoscapeRenderer] 未找到父节点', parentNodeId);
            return;
        }

        // 创建 SVG 叠加层（如果不存在）
        let svgOverlay = this.container.querySelector('.placeholder-connections-svg') as SVGSVGElement;
        if (!svgOverlay) {
            svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgOverlay.classList.add('placeholder-connections-svg');
            svgOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 1;
            `;
            this.container.appendChild(svgOverlay);
        }

        // 创建连接线 - 使用绿色虚线（与智能连线一致）
        const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        connectionLine.setAttribute('stroke', '#10b981');  // 淡绿色
        connectionLine.setAttribute('stroke-width', '2');
        connectionLine.setAttribute('stroke-dasharray', '5,5');  // 虚线
        connectionLine.setAttribute('opacity', '0.8');
        connectionLine.classList.add('placeholder-connection-line');
        connectionLine.setAttribute('data-placeholder-id', placeholderNodeId);

        // 初始位置
        const placeholderPos = placeholderNode.renderedPosition();
        const parentPos = parentNode.renderedPosition();
        connectionLine.setAttribute('x1', parentPos.x.toString());
        connectionLine.setAttribute('y1', parentPos.y.toString());
        connectionLine.setAttribute('x2', placeholderPos.x.toString());
        connectionLine.setAttribute('y2', placeholderPos.y.toString());

        svgOverlay.appendChild(connectionLine);

        // 保存连接线引用
        const nodeData = placeholderNode.data();
        (nodeData as any).connectionLine = connectionLine;
        (nodeData as any).connectionParentNode = parentNode;

        // 缓存父节点引用，避免每次都遍历所有节点
        const cachedParent = this.cy.$('node').filter((node: any) => {
            const data = node.data();
            return data.originalNode && data.originalNode.IDStr === parentNodeId;
        });

        // 更新连接线位置的函数（轻量，只读取两个节点的位置）
        const updateConnectionLine = () => {
            if (!this.cy || !connectionLine.parentNode) return;

            const currentPlaceholder = this.cy.$id(placeholderNodeId);
            if (currentPlaceholder && currentPlaceholder.length > 0 &&
                cachedParent && cachedParent.length > 0) {
                const newPos = currentPlaceholder.renderedPosition();
                const parentPos = cachedParent.renderedPosition();

                connectionLine.setAttribute('x1', parentPos.x.toString());
                connectionLine.setAttribute('y1', parentPos.y.toString());
                connectionLine.setAttribute('x2', newPos.x.toString());
                connectionLine.setAttribute('y2', newPos.y.toString());
            }
        };

        // 注册到统一 overlay 调度器，而非单独绑定事件
        this.overlayUpdaters.add(updateConnectionLine);

        // 保存更新处理器引用，以便后续清理
        (nodeData as any).connectionLineUpdater = updateConnectionLine;
    }

    /**
     * 处理方向键导航
     */
    private handleArrowKeyNavigation(key: string): void {
        if (!this.cy) return;

        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodePosition = activeNode.position();
        const allNodes = this.cy.nodes().filter(node => !node.data().isPlaceholder);

        // 根据方向键找到最近的节点
        let targetNode: any | null = null;
        let minDistance = Infinity;

        allNodes.forEach((node: any) => {
            // 跳过当前节点
            if (node.id() === activeNode.id()) return;

            const nodePos = node.position();
            const dx = nodePos.x - nodePosition.x;
            const dy = nodePos.y - nodePosition.y;

            // 检查节点是否在指定方向上
            let isInDirection = false;
            switch (key) {
                case 'ArrowUp':
                    isInDirection = dy < 0 && Math.abs(dx) < Math.abs(dy);
                    break;
                case 'ArrowDown':
                    isInDirection = dy > 0 && Math.abs(dx) < Math.abs(dy);
                    break;
                case 'ArrowLeft':
                    isInDirection = dx < 0 && Math.abs(dx) > Math.abs(dy);
                    break;
                case 'ArrowRight':
                    isInDirection = dx > 0 && Math.abs(dx) > Math.abs(dy);
                    break;
            }

            if (isInDirection) {
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < minDistance) {
                    minDistance = distance;
                    targetNode = node;
                }
            }
        });

        if (targetNode) {
            // 取消当前选中
            this.cy.$(':selected').unselect();

            // 选中目标节点
            targetNode.select();

            // 可选：将视图中心移到选中的节点
            // this.cy.animate({
            //     center: { eles: targetNode },
            //     zoom: this.cy.zoom()
            // }, {
            //     duration: 200
            // });
        }
    }

    /**
     * 批量删除节点
     */
    private batchDeleteNodes(): void {
        if (this.batchSelectedNodeIds.length === 0) return;
        const nodeIdsSnapshot = [...this.batchSelectedNodeIds];
        const nodesSnapshot = this.batchSelectedNodes.map((n: any) => ({ ...n }));

        // 先隐藏工具栏，避免遮挡对话框
        this.hideBatchToolbar();

        // 创建确认对话框
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 15px;
            min-width: 300px;
        `;

        const title = document.createElement('h3');
        title.textContent = '确认删除';
        title.style.margin = '0';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.textContent = `确认删除 ${nodeIdsSnapshot.length} 个节点？`;
        message.style.margin = '0';
        dialog.appendChild(message);

        const buttonContainer = document.createElement('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.justifyContent = 'flex-end';

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '确认';
        confirmBtn.onclick = () => {
            // 触发批量删除事件
            this.container?.dispatchEvent(new CustomEvent('batch-delete-nodes', {
                detail: {
                    nodeIds: nodeIdsSnapshot,
                    nodes: nodesSnapshot
                }
            }));

            overlay.remove();

            // 清除选择并清空节点ID
            if (this.cy) {
                this.cy.$(':selected').unselect();
            }
            this.batchSelectedNodeIds = [];
            this.batchSelectedNodes = [];
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = () => {
            overlay.remove();
            // 用户取消，重新显示工具栏
            this.showBatchToolbar();
        };

        buttonContainer.appendChild(confirmBtn);
        buttonContainer.appendChild(cancelBtn);
        dialog.appendChild(buttonContainer);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    /**
     * 批量改变颜色
     */
    private batchChangeColor(): void {
        if (this.batchSelectedNodeIds.length === 0) return;
        const nodeIdsSnapshot = [...this.batchSelectedNodeIds];

        // 先隐藏工具栏
        this.hideBatchToolbar();

        // 触发批量颜色选择事件
        this.container?.dispatchEvent(new CustomEvent('batch-show-color-picker', {
            detail: { nodeIds: nodeIdsSnapshot }
        }));
    }

    /**
     * 检查智能连线功能是否启用
     */
    private isSmartConnectionEnabled(): boolean {
        if (this.currentOptions && typeof this.currentOptions.smartConnection === 'boolean') {
            return this.currentOptions.smartConnection;
        }

        // 从全局设置中获取智能连线开关状态
        const app = (window as any).app;
        if (!app || !app.plugins) return false;

        const plugin = app.plugins.plugins['thought-tree-navigator'];
        if (!plugin || !plugin.settings) return false;

        return plugin.settings.smartConnection === true;
    }
}
