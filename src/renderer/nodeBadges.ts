import { Component, Platform, finishRenderMath, renderMath, setIcon } from 'obsidian';
import type * as cytoscape from 'cytoscape';
import { ZKNode } from 'src/view/indexView';
import { CrossDomainLink } from 'src/utils/utils';
import { darkenColor, hexToRgba, isModernThemeStyle, normalizeHexColor } from './colorUtils';
import { estimateWrappedLines } from './renderPipeline';
import { renderExcalidrawPreview, wrapForImageToolkit } from './embedPreview';
import type { TextMdOverlayEntry } from './CytoscapeRenderer';

export const TEXT_MD_OVERLAY_RENDER_VERSION = 3;

// overlay 定位 updater + 其所属 Cytoscape 节点(用于视口剔除)。
// node 为 null 表示该 updater 不绑定单一节点(始终执行,不参与剔除)。
type BadgeUpdater = { node: cytoscape.NodeSingular | null; fn: () => void };

// 交互(pan/zoom/drag)期视口剔除的安全外扩边距(rendered px):
// 节点中心在 [视口 - M, 视口 + M] 外才剔除,覆盖节点自身尺寸 + 单帧快速 pan 的位移,
// 避免节点刚滑入视口时 overlay 慢一帧。交互结束后 scheduleExtra/immediate 会全量补正。
const OVERLAY_CULL_MARGIN = 320;

function middleEllipsizeToWidth(text: string, maxWidth: number, ctx: CanvasRenderingContext2D | null, font: string): string {
	const fullText = String(text || '');
	if (!fullText || maxWidth <= 0 || !ctx) return fullText;

	ctx.font = font;
	if (ctx.measureText(fullText).width <= maxWidth) return fullText;

	const chars = Array.from(fullText);
	const ellipsis = '...';
	if (ctx.measureText(ellipsis).width > maxWidth) return '';

	let low = 0;
	let high = chars.length;
	let best = ellipsis;

	while (low <= high) {
		const keep = Math.floor((low + high) / 2);
		const leftCount = Math.ceil(keep / 2);
		const rightCount = Math.floor(keep / 2);
		const candidate = `${chars.slice(0, leftCount).join('')}${ellipsis}${rightCount > 0 ? chars.slice(-rightCount).join('') : ''}`;

		if (ctx.measureText(candidate).width <= maxWidth) {
			best = candidate;
			low = keep + 1;
		} else {
			high = keep - 1;
		}
	}

	return best;
}

function parseRenderedNumber(value: unknown, fallback = 0): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const parsed = parseFloat(String(value ?? ''));
	return Number.isFinite(parsed) ? parsed : fallback;
}

function measureVisibleTextWidth(ctx: CanvasRenderingContext2D, text: string, fallbackWidth: number): number {
	const metrics = ctx.measureText(text || ' ');
	const visibleWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
	return Number.isFinite(visibleWidth) && visibleWidth > 0
		? Math.min(fallbackWidth, visibleWidth)
		: fallbackWidth;
}

function getRscratchValue(rscratch: Record<string, unknown> | null | undefined, propName: string): unknown {
	return rscratch ? rscratch[propName] : undefined;
}

function modelToRendered(value: number, zoom: number, panValue: number): number {
	return value * zoom + panValue;
}

export function renderNodeBadges(this: any): void {
        if (!this.cy || !this.container) return;

        // 性能埋点(window.__zkPerf=true):细分 renderNodeBadges 内部各子系统耗时
        const __zkPerf = (window as unknown as { __zkPerf?: boolean }).__zkPerf === true;
        const __bMark: Record<string, number> = {};
        let __bPrev = __zkPerf ? performance.now() : 0;
        const __bLap = (name: string) => {
            if (!__zkPerf) return;
            const t = performance.now();
            __bMark[name] = (__bMark[name] || 0) + (t - __bPrev);
            __bPrev = t;
        };

        // 增量新增模式(#43):由 render() 在"free 布局 + 纯新增 + 无样式/数据变化"路径上设置
        // this._incrementalAddIds = 新节点 id 集合。命中时只为这些新节点追加 badge/textMD overlay,
        // 不清理调度器、不摘除已有 overlay、复用现有容器,其余节点的 overlay 及其已注册 updater 原地
        // 保留(pan/zoom 仍由 scheduler 统一更新)。这样新增节点不再付"全部节点重建+重定位"的成本。
        // 一次性消费,避免标记泄漏到后续全量渲染。
        let incIds: Set<string> | null = this._incrementalAddIds || null;
        this._incrementalAddIds = null;
        // 已有节点被推开(仅位置变化)时为 true:增量末尾需重定位全部 overlay 而非只定位新节点。
        const repositionAll = this._incrementalRepositionAll === true;
        this._incrementalRepositionAll = false;

        const isLightTheme = this.currentOptions?.themeMode === 'light' || activeDocument.body.classList.contains('theme-light');

        const existingBadgeContainer = this.container.querySelector('.zk-node-badges') as HTMLElement | null;
        const existingGlassLayer = this.container.querySelector('.zk-group-glass-layer') as HTMLElement | null;
        // 缺少可复用容器(理论上增量前必有一次全量渲染)→ 降级为全量,避免空指针
        if (incIds && (!existingBadgeContainer || !existingGlassLayer)) {
            incIds = null;
        }

        let glassLayer: HTMLElement;
        let badgeContainer: HTMLElement;

        if (incIds) {
            // 复用现有容器,不做任何清理
            glassLayer = existingGlassLayer!;
            badgeContainer = existingBadgeContainer!;
        } else {
            // 全量重建:清理调度器 + 摘除缓存 overlay + 重建容器
            this.overlayScheduler.cleanupScheduler();
            this.cleanupBadgeInteractionBindings();

            // 先从旧 badgeContainer 中摘下缓存的 MD overlay（保持 DOM 节点存活，便于下面复用）
            this.textMdOverlayCache.forEach((entry: TextMdOverlayEntry) => {
                entry.usedInCycle = false;
                // 防御性清理：清除可能遗留的编辑标记和隐藏样式，避免下次复用时继续不显示
                if (entry.el.dataset.editing === '1') {
                    // 编辑期 overlay 的 cssText 可能被内联编辑器改写,失效 styleSig 以强制
                    // 下个渲染周期重写基样式(否则 styleSig 守卫会误判为无变化而跳过恢复)。
                    delete entry.el.dataset.styleSig;
                }
                delete entry.el.dataset.editing;
                entry.el.setCssStyles({ display: 'block' });
                if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
            });

            // 移除旧的徽章容器
            if (existingBadgeContainer) existingBadgeContainer.remove();
            // 移除旧的分组 glass 层
            if (existingGlassLayer) existingGlassLayer.remove();

            // 创建分组 glass 层（插到最前，位于 canvas 下方）
            glassLayer = activeDocument.createElement('div');
            glassLayer.className = 'zk-group-glass-layer';
            glassLayer.setCssStyles({
                position: 'absolute',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: '0',
                overflow: 'hidden',
            });
            this.container.insertBefore(glassLayer, this.container.firstChild);

            // 创建徽章容器
            badgeContainer = activeDocument.createElement('div');
            badgeContainer.className = 'zk-node-badges';
            badgeContainer.setCssStyles({
                position: 'absolute',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: '3',
            });
            this.container.appendChild(badgeContainer);
        }

        // 存储所有徽章的更新函数
        const badgeUpdaters: BadgeUpdater[] = [];
        const readOnly = this.isReadOnlyMode();
        const underlineMeasure = activeDocument.createElement('canvas');
        const underlineMeasureCtx = underlineMeasure.getContext('2d');
        const badgeMeasure = activeDocument.createElement('canvas');
        const badgeMeasureCtx = badgeMeasure.getContext('2d');

        // 分组 glass overlay
        this.cy.nodes('.group-node').forEach((groupNode: cytoscape.NodeSingular) => {
            // 增量模式跳过分组 glass:组 bbox 由 Cytoscape 复合节点维护,旧 glass updater 仍在
            // scheduler 中,pan/zoom 时会自动把新子节点纳入。
            if (incIds) return;
            const glassEl = activeDocument.createElement('div');
            glassEl.className = 'zk-group-glass';
            glassEl.setCssStyles({
                position: 'absolute',
                left: '0',
                top: '0',
                borderRadius: '12px',
                border: isLightTheme
                ? '1px solid rgba(180, 195, 220, 0.34)'
                : '1px solid rgba(255, 255, 255, 0.075)',
                background: isLightTheme
                ? 'rgba(255, 255, 255, 0.18)'
                : 'rgba(255, 255, 255, 0.022)',
            });
            glassEl.setCssStyles({ boxShadow: isLightTheme
                ? '0 1px 8px rgba(0,0,0,0.035)'
                : '0 1px 10px rgba(0,0,0,0.16)' });
            glassLayer.appendChild(glassEl);

            // 标签下方的遮罩层：用于“切断”被标签覆盖区域的上边框，降低视觉噪声
            const labelMaskEl = activeDocument.createElement('div');
            labelMaskEl.className = 'zk-group-glass-label-mask';
            labelMaskEl.setCssStyles({
                position: 'absolute',
                top: '0',
                left: '0',
                transform: 'translate(0, -50%)',
                borderRadius: '999px',
                pointerEvents: 'none',
                zIndex: '1',
            });
            const containerBg = this.container ? getComputedStyle(this.container).backgroundColor : '';
            labelMaskEl.setCssStyles({ background: containerBg || (isLightTheme ? '#f5f5f5' : '#2a2a2a') });
            glassEl.appendChild(labelMaskEl);

            const labelEl = activeDocument.createElement('div');
            labelEl.className = 'zk-group-glass-label';
            labelEl.textContent = groupNode.data('label') || '';
            labelEl.setCssStyles({
                position: 'absolute',
                fontWeight: '600',
                color: isLightTheme ? '#5b6578' : 'rgba(235, 241, 255, 0.78)',
                pointerEvents: 'none',
                userSelect: 'none',
                whiteSpace: 'nowrap',
                left: '0',
                top: '0',
                transform: 'translate(0, -50%)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: isLightTheme
                ? '1px solid rgba(168, 184, 214, 0.54)'
                : '1px solid rgba(206, 220, 245, 0.30)',
            });
            // 通过弱化底边制造“标签压在边框上”的半镶嵌感
            labelEl.setCssStyles({
                borderBottomColor: isLightTheme
                ? 'rgba(168, 184, 214, 0.15)'
                : 'rgba(206, 220, 245, 0.12)',
                borderRadius: '999px',
                background: isLightTheme
                ? 'rgba(255, 255, 255, 0.42)'
                : 'rgba(14, 24, 40, 0.46)',
            });
            labelEl.setCssStyles({
                boxShadow: isLightTheme
                ? '0 1px 4px rgba(50, 70, 100, 0.09)'
                : '0 1px 5px rgba(0, 0, 0, 0.22)',
                zIndex: '2',
            });
            glassEl.appendChild(labelEl);

            const updateGlassPos = () => {
                if (!this.cy || groupNode.removed()) {
                    glassEl.setCssStyles({ display: 'none' });
                    return;
                }
                const bb = groupNode.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
                if (!bb || bb.w <= 0 || bb.h <= 0) {
                    glassEl.setCssStyles({ display: 'none' });
                    return;
                }
                glassEl.setCssStyles({
                    display: 'block',
                    transform: `translate(${bb.x1}px, ${bb.y1}px)`,
                    width: `${bb.w}px`,
                    height: `${bb.h}px`,
                });

                // 分组拖拽反馈：拖出原分组或拖入目标分组时高亮边框
                if (groupNode.hasClass('group-exit-warning') || groupNode.hasClass('group-join-warning')) {
                    glassEl.setCssStyles({
                        border: '1.5px dashed rgba(245, 158, 11, 0.85)',
                        boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.12), 0 1px 10px rgba(0,0,0,0.16)',
                    });
                } else {
                    glassEl.setCssStyles({
                        border: isLightTheme
                        ? '1px solid rgba(180, 195, 220, 0.34)'
                        : '1px solid rgba(255, 255, 255, 0.075)',
                        boxShadow: isLightTheme
                        ? '0 1px 8px rgba(0,0,0,0.035)'
                        : '0 1px 10px rgba(0,0,0,0.16)',
                    });
                }

                // 边界标签化：标签压在容器上边框，内部空间不占用
                const zoom = this.cy.zoom();
                labelEl.setCssStyles({
                    left: `${Math.max(10, 14 * zoom)}px`,
                    fontSize: `${Math.max(11, 13 * zoom)}px`,
                    padding: `${Math.max(2, 3 * zoom)}px ${Math.max(10, 14 * zoom)}px`,
                });
                labelEl.textContent = groupNode.data('label') || '';

                // 遮罩尺寸略大于标签，确保边框不会穿透到文字和标签底色
                const labelW = labelEl.offsetWidth || 0;
                const labelH = labelEl.offsetHeight || 0;
                const maskPadX = Math.max(4, 6 * zoom);
                const maskPadY = Math.max(1, 2 * zoom);
                labelMaskEl.setCssStyles({
                    left: `${Math.max(10, 14 * zoom) - maskPadX / 2}px`,
                    width: `${labelW + maskPadX}px`,
                    height: `${Math.max(4, labelH + maskPadY)}px`,
                });
            };

            // 不在此 inline 定位:末尾 overlayScheduler.immediate() 会在同一同步周期内
            // (paint 前)统一跑一遍全部 updater,inline 调用纯属重复昂贵的 renderedBoundingBox。
            // node:null = 不参与视口剔除。分组可能跨越整个视口而中心在视口外,
            // 基于中心的剔除会误删其 glass;分组数量少,始终更新成本可忽略。
            badgeUpdaters.push({ node: null, fn: updateGlassPos });
        });

        this.cy.nodes('[?hasFileIcon]').forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            // 跳过所有 embed 节点（由预览卡片渲染标题和内容）
            if (node.data('isEmbed')) return;
			const underlineGroupEl = activeDocument.createElement('div');
			underlineGroupEl.className = 'zk-node-file-underline-group';
			underlineGroupEl.dataset.nodeId = node.id();
			underlineGroupEl.setCssStyles({
				position: 'absolute',
				pointerEvents: 'none',
			});
            badgeContainer.appendChild(underlineGroupEl);

            // 缓存：label 不变时复用 wrappedLines 和 modelLineWidths，避免每帧 measureText
            let cachedLabel = '';
            let cachedWrappedLines: string[] = [];
            let cachedModelLineWidths: number[] = []; // 模型坐标系下的宽度（不含 zoom）
            let cachedIsRoot = false;
            let cachedIsFirstLevel = false;
            // DOM 元素池：创建一次，后续只更新位置
            const lineElements: Array<{ hitEl: HTMLElement; underlineEl: HTMLElement }> = [];

            const rebuildWrappedLinesCache = (label: string, isRoot: boolean, isFirstLevel: boolean) => {
                cachedLabel = label;
                cachedIsRoot = isRoot;
                cachedIsFirstLevel = isFirstLevel;
                const fontPx = isRoot
                    ? this.ROOT_NODE_FONT_SIZE
                    : (isFirstLevel ? this.FIRST_LEVEL_NODE_FONT_SIZE : 20);
                const fontWeight = isRoot
                    ? `${this.ROOT_NODE_FONT_WEIGHT}`
                    : (isFirstLevel ? `${this.FIRST_LEVEL_NODE_FONT_WEIGHT}` : '500');
                const renderedTextMaxWidth = parseRenderedNumber(node.style('text-max-width'), 0);
                const textMaxWidth = renderedTextMaxWidth > 0
                    ? renderedTextMaxWidth
                    : (isRoot ? 560 : (isFirstLevel ? 340 : 280));

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
                    // 预计算模型坐标系下每行可见字形宽度。换行用 advance width,
                    // 下划线用 visible width,避免线头伸到首字之前。
                    cachedModelLineWidths = cachedWrappedLines.map(line =>
                        measureVisibleTextWidth(
                            underlineMeasureCtx!,
                            line || ' ',
                            underlineMeasureCtx!.measureText(line || ' ').width
                        )
                    );
                } else {
                    cachedWrappedLines = estimateWrappedLines(
                        label,
                        isRoot
                            ? { maxWidth: 560, charWidth: 18 }
                            : (isFirstLevel ? { maxWidth: 340, charWidth: 12 } : undefined)
                    );
                    cachedModelLineWidths = cachedWrappedLines.map(line => {
                        const cjkCount = [...line].filter(ch => {
                            const code = ch.codePointAt(0) || 0;
                            return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F);
                        }).length;
                        return cjkCount * 16 + (line.length - cjkCount) * 8;
                    });
                }
            };

            const getCytoscapeLabelLayout = (): Array<{ centerX: number; baselineY: number; width: number; lineHeight: number }> | null => {
                if (!this.cy || !underlineMeasureCtx) return null;

                const rscratch = (node?.[0] as unknown as { _private?: { rscratch?: Record<string, unknown> } } | undefined)?._private?.rscratch;
                if (!rscratch) return null;

                const rawLines = getRscratchValue(rscratch, 'labelWrapCachedLines');
                const labelXModel = parseRenderedNumber(getRscratchValue(rscratch, 'labelX'), NaN);
                const labelYModel = parseRenderedNumber(getRscratchValue(rscratch, 'labelY'), NaN);
                const labelWidthModel = parseRenderedNumber(getRscratchValue(rscratch, 'labelWidth'), NaN);
                const labelHeightModel = parseRenderedNumber(getRscratchValue(rscratch, 'labelHeight'), NaN);
                const lineHeightModel = parseRenderedNumber(getRscratchValue(rscratch, 'labelLineHeight'), NaN);
                if (
                    !Array.isArray(rawLines) ||
                    rawLines.length === 0 ||
                    !Number.isFinite(labelXModel) ||
                    !Number.isFinite(labelYModel) ||
                    !Number.isFinite(labelWidthModel) ||
                    !Number.isFinite(labelHeightModel) ||
                    !Number.isFinite(lineHeightModel)
                ) {
                    return null;
                }

                const lines = rawLines.map((line: unknown) => String(line || ' '));
                const zoom = this.cy.zoom();
                const pan = this.cy.pan();
                const marginXModel = parseRenderedNumber(node.style('text-margin-x'), 0);
                const marginYModel = parseRenderedNumber(node.style('text-margin-y'), 0);
                const halign = String(node.style('text-halign') || 'center');
                const valign = String(node.style('text-valign') || 'center');
                const justificationStyle = String(node.style('text-justification') || 'auto');
                const justification = justificationStyle === 'auto'
                    ? (halign === 'left' ? 'right' : (halign === 'right' ? 'left' : 'center'))
                    : justificationStyle;

                let textXModel = labelXModel + marginXModel;
                let textYModel = labelYModel + marginYModel;

                if (valign === 'center') {
                    textYModel += labelHeightModel / 2;
                } else if (valign === 'bottom') {
                    textYModel += labelHeightModel;
                }

                const halfTextW = labelWidthModel / 2;
                if (halign === 'left') {
                    if (justification === 'left') {
                        textXModel -= labelWidthModel;
                    } else if (justification === 'center') {
                        textXModel -= halfTextW;
                    }
                } else if (halign === 'center') {
                    if (justification === 'left') {
                        textXModel -= halfTextW;
                    } else if (justification === 'right') {
                        textXModel += halfTextW;
                    }
                } else if (halign === 'right') {
                    if (justification === 'center') {
                        textXModel += halfTextW;
                    } else if (justification === 'right') {
                        textXModel += labelWidthModel;
                    }
                }

                textYModel -= (lines.length - 1) * lineHeightModel;

                const fontPx = parseRenderedNumber(node.style('font-size'), 20);
                const fontWeight = String(node.style('font-weight') || '500');
                const fontFamily = String(node.style('font-family') || 'sans-serif');
                underlineMeasureCtx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;
                const underlineOffset = Math.max(2, fontPx * 0.08) * zoom;
                const hitHeight = Math.max(16 * zoom, lineHeightModel * zoom);

                return lines.map((line: string, index: number) => {
                    const advanceWidth = underlineMeasureCtx.measureText(line || ' ').width;
                    const visibleWidth = measureVisibleTextWidth(underlineMeasureCtx, line || ' ', advanceWidth);
                    const lineWidth = Math.max(24 * zoom, visibleWidth * zoom);
                    const anchorX = modelToRendered(textXModel, zoom, pan.x);
                    const baselineY = modelToRendered(textYModel + index * lineHeightModel, zoom, pan.y);
                    const centerX = justification === 'left'
                        ? anchorX + lineWidth / 2
                        : (justification === 'right' ? anchorX - lineWidth / 2 : anchorX);
                    return {
                        centerX,
                        baselineY: baselineY + underlineOffset,
                        width: lineWidth,
                        lineHeight: hitHeight
                    };
                });
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
                    const hitEl = activeDocument.createElement('div');
                    hitEl.className = 'zk-node-file-link-hit';
                    hitEl.setCssStyles({
                        position: 'absolute',
                        background: 'transparent',
                        pointerEvents: 'auto',
                        cursor: 'pointer',
                    });
                    hitEl.addEventListener('mousedown', (e: MouseEvent) => {
                        if (e.button !== 0) return;
                        // 标记:本次点击落在文件链接区,tap 不应触发选中/detail
                        this.suppressTapSelectAt = performance.now();
                        if (e.metaKey || e.ctrlKey) {
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    });
                    hitEl.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
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

                    const underlineEl = activeDocument.createElement('div');
                    underlineEl.className = 'zk-node-file-underline';
                    underlineEl.setCssStyles({
                        position: 'absolute',
                        background: 'rgba(255, 255, 255, 0.58)',
                        borderRadius: '999px',
                        pointerEvents: 'none',
                    });

                    underlineGroupEl.appendChild(hitEl);
                    underlineGroupEl.appendChild(underlineEl);
                    lineElements.push({ hitEl, underlineEl });
                }
            };

            const updateUnderlinePosition = () => {
                if (!this.cy) return;
                if (this.overlayScheduler.isInteracting || this.container?.dataset.zkTextNodeResizing === '1') {
                    underlineGroupEl.setCssStyles({ display: 'none' });
                    return;
                }

                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();

                if (isHidden) {
                    underlineGroupEl.setCssStyles({ display: 'none' });
                    return;
                }

                const label = String(node.data('label') || '').trim();
                if (!label) {
                    underlineGroupEl.setCssStyles({ display: 'none' });
                    return;
                }

                const isRoot = !!node.data('isRoot');
                const isFirstLevel = !!node.data('isFirstLevelNode');
                const cytoscapeLayout = getCytoscapeLabelLayout();

                // 仅在 label 或 isRoot 变化时重新计算换行（zoom/pan 期间跳过）
                if (!cytoscapeLayout && (label !== cachedLabel || isRoot !== cachedIsRoot || isFirstLevel !== cachedIsFirstLevel)) {
                    rebuildWrappedLinesCache(label, isRoot, isFirstLevel);
                }

                const zoom = this.cy.zoom();
                const box = node.renderedBoundingBox();

                underlineGroupEl.setCssStyles({ display: 'block' });

                if (cytoscapeLayout) {
                    ensureLineElements(cytoscapeLayout.length);
                    for (let i = 0; i < cytoscapeLayout.length; i++) {
                        const { hitEl, underlineEl } = lineElements[i];
                        const layout = cytoscapeLayout[i];
                        const underlineWidth = Math.min(box.w - 24 * zoom, layout.width);
                        hitEl.setCssStyles({
                            width: `${underlineWidth}px`,
                            height: `${layout.lineHeight}px`,
                            left: `${layout.centerX - underlineWidth / 2}px`,
                            top: `${layout.baselineY - layout.lineHeight}px`,
                        });

                        underlineEl.setCssStyles({
                            width: `${underlineWidth}px`,
                            height: `${Math.max(1, 2 * zoom)}px`,
                            left: `${layout.centerX - underlineWidth / 2}px`,
                            top: `${layout.baselineY}px`,
                        });
                    }
                    return;
                }

                const fontPx = isRoot
                    ? this.ROOT_NODE_FONT_SIZE
                    : (isFirstLevel ? this.FIRST_LEVEL_NODE_FONT_SIZE : 20);
                const lineHeightModel = isRoot ? 42 : Math.ceil(fontPx * 1.4);
                const lineHeight = lineHeightModel * zoom;
                const textMarginY = parseRenderedNumber(node.style('text-margin-y'), 0) * zoom;
                const centerX = box.x1 + box.w / 2;
                const centerY = box.y1 + box.h / 2 + textMarginY;
                const textBlockHeight = cachedWrappedLines.length * lineHeight;
                const firstLineCenterY = centerY - textBlockHeight / 2 + lineHeight / 2;

                ensureLineElements(cachedWrappedLines.length);

                for (let i = 0; i < cachedWrappedLines.length; i++) {
                    const modelWidth = cachedModelLineWidths[i] || 24;
                    const lineWidth = modelWidth * zoom;
                    const underlineWidth = Math.min(box.w - 24 * zoom, Math.max(24 * zoom, lineWidth));
                    const lineCenterY = firstLineCenterY + i * lineHeight;
                    const hitHeight = Math.max(16 * zoom, lineHeight);
                    const { hitEl, underlineEl } = lineElements[i];

                    hitEl.setCssStyles({
                        width: `${underlineWidth}px`,
                        height: `${hitHeight}px`,
                        left: `${centerX - underlineWidth / 2}px`,
                        top: `${lineCenterY - hitHeight / 2}px`,
                    });

                    const underlineY = lineCenterY + (fontPx * 0.58 * zoom);
                    underlineEl.setCssStyles({
                        width: `${underlineWidth}px`,
                        height: `${Math.max(1, 2 * zoom)}px`,
                        left: `${centerX - underlineWidth / 2}px`,
                        top: `${underlineY}px`,
                    });
                }
            };

            badgeUpdaters.push({ node, fn: updateUnderlinePosition });
        });

        this.cy.nodes().forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            if (node.data('isGroup') || node.data('isPlaceholder') || node.data('isEmbed')) {
                return;
            }

			const remarkEl = activeDocument.createElement('div');
			remarkEl.className = 'zk-node-remark-badge';
			remarkEl.dataset.nodeId = node.id();
			remarkEl.textContent = 'R';
            let lastRemarkColor = '';
            const applyRemarkBadgeStyle = () => {
                const remarkColor = node.data('branchNodeBorder') || '#ef4444';
                if (remarkColor === lastRemarkColor) return;
                lastRemarkColor = remarkColor;
                remarkEl.setCssStyles({
                    position: 'absolute',
                    transformOrigin: 'top left',
                    width: '28px',
                    height: '28px',
                    background: `radial-gradient(circle at 50% 32%, ${remarkColor} 0%, ${remarkColor} 58%, ${remarkColor}d8 100%)`,
                    color: '#ffffff',
                    fontSize: '16px',
                    fontWeight: '700',
                    borderRadius: '999px',
                    border: '1.5px solid rgba(255, 255, 255, 0.5)',
                    boxShadow: `0 0 8px ${remarkColor}59, 0 1px 3px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.3)`,
                    textShadow: '0 1px 1px rgba(0, 0, 0, 0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'auto',
                    cursor: `${readOnly ? 'default' : 'pointer'}`,
                    userSelect: 'none',
                });
            };
            applyRemarkBadgeStyle();
            badgeContainer.appendChild(remarkEl);

			const tooltipEl = activeDocument.createElement('div');
			tooltipEl.className = 'zk-node-remark-tooltip markdown-rendered';
			tooltipEl.dataset.nodeId = node.id();
			tooltipEl.setCssStyles({
				position: 'absolute',
				maxWidth: '280px',
				padding: '8px 10px',
				background: 'rgba(15, 23, 42, 0.96)',
				color: '#ffffff',
				fontSize: '12px',
				lineHeight: '1.45',
				borderRadius: '8px',
				border: '1px solid rgba(148, 163, 184, 0.28)',
				boxShadow: '0 8px 24px rgba(0, 0, 0, 0.32)',
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-word',
				pointerEvents: 'none',
				opacity: '0',
				transform: 'translateY(4px)',
				transition: 'opacity 0.12s ease, transform 0.12s ease',
				zIndex: '20',
			});
            badgeContainer.appendChild(tooltipEl);

            // 懒缓存：embed/image 卡片在 addNodeBadges 之后才创建，首次查到后复用
            let remarkImageCardCache: HTMLElement | null = null;
            let remarkEmbedCardCache: HTMLElement | null = null;
            // tooltip 富文本懒渲染:打开 MOC 时不为每个备注跑 MarkdownRenderer,推迟到首次 hover。
            // renderedTooltipSource = 当前已渲染进 DOM 的源文本;与最新备注不一致时下次 hover 才重渲。
            let renderedTooltipSource: string | null = null;
            const ensureTooltipRendered = () => {
                const remarkText = node.data('remark') || '';
                if (remarkText === renderedTooltipSource) return;
                renderedTooltipSource = remarkText;
                this.renderRemarkTooltipContent(tooltipEl, remarkText);
            };

            const updateRemarkPosition = () => {
                if (!this.cy) return;
                const remarkText = node.data('remark') || '';
                const isSelected = node.selected();
                // 快速路径：无 remark 且未选中时直接隐藏，跳过 visibility 检查和 boundingBox 计算
                if (!remarkText && !isSelected) {
                    if (remarkEl.style.display !== 'none') {
                        remarkEl.setCssStyles({ display: 'none' });
                        tooltipEl.setCssStyles({
                            display: 'none',
                            opacity: '0',
                        });
                    }
                    return;
                }
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                const shouldShow = !isHidden;
                // 备注 tooltip 内容改为懒渲染(见 ensureTooltipRendered):此处不再每帧/首帧跑
                // MarkdownRenderer,推迟到 hover 时才渲染,避免打开 MOC 时为全部备注一次性渲染。
                applyRemarkBadgeStyle();

                if (!shouldShow) {
                    remarkEl.setCssStyles({ display: 'none' });
                    tooltipEl.setCssStyles({
                        display: 'none',
                        opacity: '0',
                        transform: 'translateY(4px)',
                    });
                    return;
                }

                remarkEl.setCssStyles({ display: 'flex' });
                tooltipEl.setCssStyles({ display: 'block' });
                const zoom = this.cy.zoom();
                // 文本节点的 Canvas label 会被 markdown overlay 替换（text-opacity:0），
                // 但仍会撑大默认 boundingBox。排除 labels 后位置才贴合实际可视卡片。
                const bbOpts = node.data('hasMarkdownOverlay')
                    ? { includeLabels: false, includeOverlays: false }
                    : undefined;
                const boundingBox = bbOpts ? node.renderedBoundingBox(bbOpts) : node.renderedBoundingBox();
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

                // 尺寸固定为基准 28px 一档,缩放交给 transform: scale,每帧只写 transform(无重排)。
                remarkEl.setCssStyles({ transform: `translate(${x}px, ${y}px) scale(${zoom})` });

                const tooltipX = x + size + (8 * zoom);
                const tooltipY = y - (6 * zoom);
                tooltipEl.setCssStyles({
                    left: `${tooltipX}px`,
                    top: `${tooltipY}px`,
                });
            };

            badgeUpdaters.push({ node, fn: updateRemarkPosition });

            // R 角标点击 = 打开/切换该节点的详情侧栏(读+编辑都在面板里完成)。
            // 只读态也允许点开查看备注,编辑能力由面板内部 canEdit 把关。
            remarkEl.addEventListener('click', (e) => {
                e.stopPropagation();
                node.select();
                this.container?.dispatchEvent(new CustomEvent('node-detail-toggle', {
                    detail: {
                        node: node.data('originalNode'),
                        event: e
                    }
                }));
            });

            remarkEl.addEventListener('mouseenter', () => {
                const remarkText = node.data('remark') || '';
                if (!remarkText) return;
                ensureTooltipRendered(); // 首次 hover 才渲染富文本(懒加载)
                tooltipEl.setCssStyles({
                    opacity: '1',
                    transform: 'translateY(0)',
                });
            });

            remarkEl.addEventListener('mouseleave', () => {
                tooltipEl.setCssStyles({
                    opacity: '0',
                    transform: 'translateY(4px)',
                });
            });
        });

        // 锚点星星 badge — 金色圆环 + 深色底 + 发光星标
        const MIN_ANCHOR_PX = 20;
        this.cy.nodes('[?isAnchor]').forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            if (node.data('isGroup') || node.data('isPlaceholder')) return;

			const starEl = activeDocument.createElement('div');
			starEl.className = 'zk-node-anchor-badge';
			starEl.dataset.nodeId = node.id();
			starEl.textContent = '✦';
            // 星图风格:发光的星而非卡通贴纸 —— 通透光晕 + 外发光,去掉不透明深色圆底
            const anchorBadgeBackground = isLightTheme
                ? 'radial-gradient(circle at 50% 45%, rgba(255, 246, 214, 0.85) 0%, rgba(254, 240, 196, 0.5) 50%, rgba(254, 240, 196, 0) 80%)'
                : 'radial-gradient(circle at 50% 45%, rgba(255, 226, 150, 0.16) 0%, rgba(255, 214, 120, 0.06) 50%, rgba(255, 214, 120, 0) 78%)';
            const anchorBadgeShadow = isLightTheme
                ? `0 1px 4px rgba(120, 84, 16, 0.16)`
                : `0 0 4px rgba(255, 216, 128, 0.22),
                    inset 0 0 4px rgba(255, 232, 160, 0.12)`;
            const anchorBadgeTextShadow = isLightTheme
                ? `0 1px 0 rgba(255, 255, 255, 0.5)`
                : `0 0 3px rgba(255, 224, 140, 0.5),
                    0 0 7px rgba(255, 206, 100, 0.3)`;
            starEl.setCssStyles({
                position: 'absolute',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: `${isLightTheme ? '#b8860b' : '#f0d489'}`,
                fontSize: '18px',
                lineHeight: '1',
                pointerEvents: 'none',
                background: `${anchorBadgeBackground}`,
                border: `1px solid ${isLightTheme ? 'rgba(204, 155, 22, 0.35)' : 'rgba(255, 234, 154, 0.32)'}`,
                borderRadius: '999px',
                boxShadow: `${anchorBadgeShadow}`,
                textShadow: `${anchorBadgeTextShadow}`,
                zIndex: '8',
                transform: 'translate(-50%, -50%)',
            });
            badgeContainer.appendChild(starEl);

            const updateAnchorPos = () => {
                if (!this.cy) return;
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) { starEl.setCssStyles({ display: 'none' }); return; }

                starEl.setCssStyles({ display: 'block' });
                const zoom = this.cy.zoom();
                const bb = node.renderedBoundingBox();
                const badgeSize = Math.max(MIN_ANCHOR_PX, 26 * zoom);
                const fontSize = Math.max(14, badgeSize * 0.62);
                const borderWidth = Math.max(1, badgeSize * 0.045);
                starEl.setCssStyles({
                    width: `${badgeSize}px`,
                    height: `${badgeSize}px`,
                    fontSize: `${fontSize}px`,
                    borderWidth: `${borderWidth}px`,
                    transform: `translate(${bb.x1 + badgeSize * 0.48}px, ${bb.y1 + badgeSize * 0.48}px) translate(-50%, -50%)`,
                });
            };

            badgeUpdaters.push({ node, fn: updateAnchorPos });
        });

        // 草稿节点角标 — 左上角小药丸,AI=紫/人工=灰,标识待审批节点(#20)
        const MIN_DRAFT_PX = 16;
        this.cy.nodes('[?isDraft]').forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            const origin = node.data('draftOrigin') === 'ai' ? 'ai' : 'manual';
            const badgeText = origin === 'ai' ? 'AI' : '草';
            const badgeColor = origin === 'ai' ? '#a855f7' : '#64748b';

            const draftEl = activeDocument.createElement('div');
            draftEl.className = 'zk-node-draft-badge';
            draftEl.dataset.nodeId = node.id();
            draftEl.textContent = badgeText;
            draftEl.setCssStyles({
                position: 'absolute',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                fontWeight: '700',
                lineHeight: '1',
                pointerEvents: 'none',
                background: `${badgeColor}`,
                border: `1.5px solid ${isLightTheme ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)'}`,
                borderRadius: '999px',
                boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                zIndex: '8',
                transform: 'translate(-50%, -50%)',
            });
            badgeContainer.appendChild(draftEl);

            const updateDraftPos = () => {
                if (!this.cy) return;
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) { draftEl.setCssStyles({ display: 'none' }); return; }

                draftEl.setCssStyles({ display: 'flex' });
                const zoom = this.cy.zoom();
                const bb = node.renderedBoundingBox();
                const badgeSize = Math.max(MIN_DRAFT_PX, 22 * zoom);
                const fontSize = Math.max(9, badgeSize * 0.5);
                draftEl.setCssStyles({
                    width: `${badgeSize}px`,
                    height: `${badgeSize}px`,
                    fontSize: `${fontSize}px`,
                    transform: `translate(${bb.x1 + badgeSize * 0.4}px, ${bb.y1 + badgeSize * 0.4}px) translate(-50%, -50%)`,
                });
            };

            badgeUpdaters.push({ node, fn: updateDraftPos });
        });

        // 跨领域「出口角标」(↗) — 挂在【源节点右下角】,标识"此节点链向其它 MOC 的笔记"。
        // 不再把外部笔记物化成画布上的虚拟节点;链接列表 hover 展开成卡片,点击跳转、× 删除。
        // 与 R 备注角标(右上)分居两角,语义左右分明。
        const MIN_CD_PX = 18;
        const cdBadgeColor = isLightTheme ? '#7357c6' : '#a08be8';
        const cdMocBasename = (p: string) =>
            String(p || '').split('/').pop()?.replace(/\.moc\.md$|\.md$/i, '') || '';
        const cdLinkTargetText = (link: CrossDomainLink) => {
            const fileBase = link?.filePath
                ? String(link.filePath).split('/').pop()?.replace(/\.md$/i, '') || ''
                : '';
            return link?.displayText || fileBase || link?.nodeId || '未命名';
        };
        this.cy.nodes('[?hasCrossDomain]').forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            if (node.data('isGroup') || node.data('isPlaceholder')) return;
            const links: CrossDomainLink[] = node.data('crossDomainLinks') || [];
            if (!links.length) return;
            const sourceNodeId = String(node.data('originalNodeId') || node.id());

            const cdEl = activeDocument.createElement('div');
            cdEl.className = 'zk-node-cross-domain-badge';
            cdEl.dataset.nodeId = node.id();
            cdEl.textContent = links.length > 1 ? `↗ ${links.length}` : '↗';
            cdEl.title = links.length > 1
                ? `${links.length} 个跨领域链接`
                : `跨领域链接 · ${cdLinkTargetText(links[0])}`;
            cdEl.setCssStyles({
                position: 'absolute',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '2px',
                color: '#ffffff',
                fontWeight: '700',
                lineHeight: '1',
                whiteSpace: 'nowrap',
                pointerEvents: 'auto',
                cursor: 'pointer',
                background: `${cdBadgeColor}`,
                border: `1.5px solid ${isLightTheme ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)'}`,
                borderRadius: '999px',
                boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                zIndex: '8',
                transform: 'translate(-50%, -50%)',
            });
            badgeContainer.appendChild(cdEl);

            // hover 展开卡片:列出每条链接(关系标签 / 目标笔记 / 来源 MOC / 删除)
            const cdPanel = activeDocument.createElement('div');
            cdPanel.className = 'zk-node-cross-domain-panel';
            cdPanel.dataset.nodeId = node.id();
            cdPanel.setCssStyles({
                position: 'absolute',
                minWidth: '200px',
                maxWidth: '320px',
                padding: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                background: `${isLightTheme ? 'rgba(255,255,255,0.98)' : 'rgba(15,23,42,0.97)'}`,
                color: `${isLightTheme ? '#1f2937' : '#f1f5f9'}`,
                borderRadius: '10px',
                border: `1px solid ${isLightTheme ? 'rgba(115,87,198,0.25)' : 'rgba(160,139,232,0.3)'}`,
                boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
                pointerEvents: 'auto',
                opacity: '0',
                transform: 'translateY(4px)',
                transition: 'opacity 0.12s ease, transform 0.12s ease',
                zIndex: '21',
            });
            cdPanel.setCssStyles({ display: 'none' });
            badgeContainer.appendChild(cdPanel);

            links.forEach((link) => {
                const row = activeDocument.createElement('div');
                row.className = 'zk-cd-panel-row';
                row.setCssStyles({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 8px',
                    borderRadius: '7px',
                    cursor: 'pointer',
                    transition: 'background 0.1s ease',
                });
                row.addEventListener('mouseenter', () => {
                    row.setCssStyles({ background: isLightTheme ? 'rgba(115,87,198,0.10)' : 'rgba(160,139,232,0.16)' });
                });
                row.addEventListener('mouseleave', () => { row.setCssStyles({ background: 'transparent' }); });

                const relText = (link?.relationLabel && String(link.relationLabel).trim()) || '跨领域';
                const chip = activeDocument.createElement('span');
                chip.textContent = relText;
                chip.setCssStyles({
                    flex: '0 0 auto',
                    fontSize: '11px',
                    fontWeight: '600',
                    padding: '1px 6px',
                    borderRadius: '999px',
                    color: `${cdBadgeColor}`,
                    background: `${isLightTheme ? 'rgba(115,87,198,0.12)' : 'rgba(160,139,232,0.18)'}`,
                    border: `1px solid ${isLightTheme ? 'rgba(115,87,198,0.3)' : 'rgba(160,139,232,0.35)'}`,
                });

                const textWrap = activeDocument.createElement('div');
                textWrap.setCssStyles({
                    flex: '1 1 auto',
                    minWidth: '0',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1px',
                });
                const nameEl = activeDocument.createElement('div');
                nameEl.textContent = cdLinkTargetText(link);
                nameEl.setCssStyles({
                    fontSize: '13px',
                    fontWeight: '600',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                });
                const mocEl = activeDocument.createElement('div');
                const mocName = cdMocBasename(link?.mocPath);
                mocEl.textContent = mocName ? `来自《${mocName}》` : '来自其它 MOC';
                mocEl.setCssStyles({
                    fontSize: '11px',
                    opacity: '0.65',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                });
                textWrap.appendChild(nameEl);
                textWrap.appendChild(mocEl);

                row.appendChild(chip);
                row.appendChild(textWrap);

                // 点击行 → 跳转到目标 MOC 并定位节点
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.container?.dispatchEvent(new CustomEvent('cross-domain-jump', {
                        detail: { link }
                    }));
                });

                // 删除 ×(只读态隐藏)
                if (!readOnly) {
                    const delEl = activeDocument.createElement('span');
                    delEl.textContent = '×';
                    delEl.title = '删除此跨领域链接';
                    delEl.setCssStyles({
                        flex: '0 0 auto',
                        width: '18px',
                        height: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '15px',
                        lineHeight: '1',
                        borderRadius: '5px',
                        opacity: '0.5',
                        cursor: 'pointer',
                    });
                    delEl.addEventListener('mouseenter', () => {
                        delEl.setCssStyles({
                            opacity: '1',
                            background: isLightTheme ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.22)',
                            color: '#ef4444',
                        });
                    });
                    delEl.addEventListener('mouseleave', () => {
                        delEl.setCssStyles({
                            opacity: '0.5',
                            background: 'transparent',
                            color: 'inherit',
                        });
                    });
                    delEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.container?.dispatchEvent(new CustomEvent('cross-domain-remove', {
                            detail: { sourceNodeId, link }
                        }));
                    });
                    row.appendChild(delEl);
                }

                cdPanel.appendChild(row);
            });

            // 悬停出入:角标与卡片任一被悬停则保持显示,移出后延时收起(允许鼠标从角标移到卡片上)
            let cdHideTimer: number | null = null;
            const showCdPanel = () => {
                if (cdHideTimer !== null) { window.clearTimeout(cdHideTimer); cdHideTimer = null; }
                cdPanel.setCssStyles({ display: 'flex' });
                // 触发过渡
                window.requestAnimationFrame(() => {
                    cdPanel.setCssStyles({
                        opacity: '1',
                        transform: 'translateY(0)',
                    });
                });
            };
            const hideCdPanel = () => {
                if (cdHideTimer !== null) window.clearTimeout(cdHideTimer);
                cdHideTimer = window.setTimeout(() => {
                    cdPanel.setCssStyles({
                        opacity: '0',
                        transform: 'translateY(4px)',
                        display: 'none',
                    });
                    cdHideTimer = null;
                }, 140);
            };
            cdEl.addEventListener('mouseenter', showCdPanel);
            cdEl.addEventListener('mouseleave', hideCdPanel);
            cdPanel.addEventListener('mouseenter', showCdPanel);
            cdPanel.addEventListener('mouseleave', hideCdPanel);

            const updateCdPos = () => {
                if (!this.cy) return;
                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) {
                    cdEl.setCssStyles({ display: 'none' });
                    if (cdPanel.style.display !== 'none') hideCdPanel();
                    return;
                }

                cdEl.setCssStyles({ display: 'flex' });
                const zoom = this.cy.zoom();
                const bb = node.renderedBoundingBox();
                const badgeSize = Math.max(MIN_CD_PX, 22 * zoom);
                const fontSize = Math.max(10, badgeSize * 0.5);
                cdEl.setCssStyles({
                    height: `${badgeSize}px`,
                    minWidth: `${badgeSize}px`,
                    padding: links.length > 1 ? `0 ${badgeSize * 0.28}px` : '0',
                    fontSize: `${fontSize}px`,
                });
                // 右下角:贴在节点右下角内侧
                const cx = bb.x2 - badgeSize * 0.4;
                const cy = bb.y2 - badgeSize * 0.4;
                cdEl.setCssStyles({ transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%)` });
                // 卡片定位在角标下方偏左,避免越过容器右边界
                cdPanel.setCssStyles({
                    left: `${cx}px`,
                    top: `${cy + badgeSize * 0.5 + 6}px`,
                    transformOrigin: 'top left',
                });
            };

            badgeUpdaters.push({ node, fn: updateCdPos });
        });

        // 兼容旧语义：文字前小色点（legacy customColor）
        this.cy.nodes('[customColor]').forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            if (node.data('isGroup') || node.data('isEmbed')) return;
            const rawColor = String(node.data('customColor') || '');
            if (!rawColor || rawColor.startsWith('fill2:')) return;
            const color = normalizeHexColor(rawColor);
            if (!color) return;

			const dotEl = activeDocument.createElement('div');
			dotEl.className = 'zk-node-color-dot';
			dotEl.dataset.nodeId = node.id();
			dotEl.setCssStyles({
				position: 'absolute',
				pointerEvents: 'none',
				borderRadius: '999px',
				transform: 'translate(-50%, -50%)',
			});
            dotEl.setCssStyles({
                backgroundColor: color,
                boxShadow: `0 0 6px 1px ${color}66`,
            });
            badgeContainer.appendChild(dotEl);

            const updateDotPos = () => {
                if (!this.cy || node.removed()) { dotEl.setCssStyles({ display: 'none' }); return; }
                const isHidden =
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) { dotEl.setCssStyles({ display: 'none' }); return; }

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
                    dotEl.setCssStyles({ display: 'none' });
                    return;
                }

                const centerY = renderedPos.y;
                const textStartX = renderedPos.x - renderedWidth / 2 + 20 * zoom;

                dotEl.setCssStyles({
                    display: 'block',
                    width: `${dotSize}px`,
                    height: `${dotSize}px`,
                    transform: `translate(${textStartX}px, ${centerY}px) translate(-50%, -50%)`,
                });
            };

            badgeUpdaters.push({ node, fn: updateDotPos });
        });

        // 为每个有 badge 的节点创建徽章元素（跳过 embed 节点，由预览卡片展示）
        this.cy.nodes('[badge]').forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            const badge = String(node.data('badge') || '');
            if (!badge || node.data('isEmbed')) return;
            const isModern = isModernThemeStyle(this.currentOptions);
            const branchBorderColor = typeof node.data('branchNodeBorder') === 'string'
                ? normalizeHexColor(node.data('branchNodeBorder'))
                : null;
            const modernBase = branchBorderColor || '#64748b';
            const badgeBackgroundColor = isModern
                ? hexToRgba(darkenColor(modernBase, 0.62), 0.22)
                : 'rgba(0, 0, 0, 0.25)';
            const badgeTextColor = isModern
                ? hexToRgba(darkenColor(modernBase, 0.30), 0.86)
                : 'rgba(255, 255, 255, 0.9)';
            const badgeBorderColor = isModern
                ? hexToRgba(darkenColor(modernBase, 0.42), 0.38)
                : 'transparent';

			const badgeEl = activeDocument.createElement('div');
			badgeEl.className = 'zk-node-badge';
			badgeEl.dataset.nodeId = node.id();
			badgeEl.textContent = badge;
            badgeEl.title = badge;
            badgeEl.setAttribute('aria-label', badge);
            badgeEl.setCssStyles({
                position: 'absolute',
                backgroundColor: `${badgeBackgroundColor}`,
                color: `${badgeTextColor}`,
                border: `1px solid ${badgeBorderColor}`,
                fontSize: '9px',
                fontWeight: '600',
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                padding: '3px 8px',
                borderRadius: '20px',
                whiteSpace: 'nowrap',
                pointerEvents: 'auto',
                cursor: 'pointer',
            });
            badgeEl.setCssStyles({ transformOrigin: 'right bottom' });
            badgeContainer.appendChild(badgeEl);

            // 徽章文本按"模型宽度"截断并缓存:zoom/pan 不改变模型宽度,故截断结果在缩放过程中不变。
            // 仅当节点模型宽度真正变化时才重新跑 middleEllipsizeToWidth(二分 measureText,昂贵)。
            // 字号/内边距/圆角全部固定为基准 9px 一档,缩放交给 transform: scale —— 每帧只写一次 transform。
            // (maxZoom=1,scale 永远是缩小,文本不会被放大糊化。)
            let cachedTextKey = -1;
            const updateBadgePosition = () => {
                if (!this.cy) return;

                const isHidden =
                    node.removed() ||
                    node.hasClass('zk-collapsed-hidden') ||
                    node.style('display') === 'none' ||
                    !node.visible();
                if (isHidden) {
                    badgeEl.setCssStyles({ display: 'none' });
                    return;
                }
                badgeEl.setCssStyles({ display: '' });

                const zoom = this.cy.zoom();
                const boundingBox = node.renderedBoundingBox();

                // 徽章位置：节点右下角内侧
                const x = boundingBox.x2 - 8 * zoom;
                const y = boundingBox.y2 - 8 * zoom;
                // 移动端用 0.28 下限保证最小可读字号;桌面端 zoom(maxZoom=1) 直接作 scale。
                const scale = Platform.isMobile ? Math.max(0.28, zoom) : zoom;

                // 基准坐标系(9px)下的可用文本宽度 = 模型宽度 - 左右内缩 - 内边距 - 余量。
                const modelW = boundingBox.w / zoom;
                const baseMaxTextWidth = Math.max(0, modelW - 16 - 16 - 2);
                const key = Math.round(baseMaxTextWidth);
                if (key !== cachedTextKey) {
                    cachedTextKey = key;
                    badgeEl.textContent = middleEllipsizeToWidth(badge, baseMaxTextWidth, badgeMeasureCtx, '600 9px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace');
                }
                badgeEl.setCssStyles({ transform: `translate(${x}px, ${y}px) translate(-100%, -100%) scale(${scale})` });
            };

            badgeUpdaters.push({ node, fn: updateBadgePosition });

            // 点击徽章时选中节点
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                node.select();
            });
        });

        // 文本节点右下角拉伸手柄（仅选中时可见）
        if (!readOnly) {
            this.cy.nodes('[?isTextOnly]').forEach((node: cytoscape.NodeSingular) => {
                if (incIds && !incIds.has(node.id())) return;
                if (node.data('isGroup') || node.data('isPlaceholder') || node.data('isEmbed')) return;

                const resizeEl = activeDocument.createElement('div');
                resizeEl.className = 'zk-text-node-resize-handle';
                resizeEl.setCssStyles({
                    position: 'absolute',
                    width: '18px',
                    height: '18px',
                    borderTopLeftRadius: '6px',
                    background: 'rgba(91, 143, 217, 0.9)',
                    color: 'rgba(255, 255, 255, 0.95)',
                    fontSize: '11px',
                    fontWeight: '700',
                    display: 'flex',
                    alignItems: 'flex-end',
                    justifyContent: 'flex-end',
                    lineHeight: '1',
                    paddingRight: '2px',
                    cursor: 'nwse-resize',
                    pointerEvents: 'none',
                    opacity: '0',
                    transition: 'opacity 0.15s ease',
                    zIndex: '10',
                    userSelect: 'none',
                });
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
                    this.overlayScheduler.immediate();
                };

                const onUp = () => {
                    if (!resizing || !this.cy) return;
                    resizing = false;
                    if (this.container) delete this.container.dataset.zkTextNodeResizing;
                    activeDocument.removeEventListener('mousemove', onMove);
                    activeDocument.removeEventListener('mouseup', onUp);
                    this.overlayScheduler.immediate();
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
                    if (this.container) this.container.dataset.zkTextNodeResizing = '1';
                    startX = e.clientX;
                    startY = e.clientY;
                    startWModel = Number(node.width() || 0);
                    startHModel = Number(node.height() || 0);
                    const startPos = node.position();
                    startLeftModel = startPos.x - startWModel / 2;
                    startTopModel = startPos.y - startHModel / 2;
                    activeDocument.addEventListener('mousemove', onMove);
                    activeDocument.addEventListener('mouseup', onUp);
                });

                const updateResizeHandle = () => {
                    if (!this.cy) return;
                    const isHidden =
                        node.removed() ||
                        node.hasClass('zk-collapsed-hidden') ||
                        node.style('display') === 'none' ||
                        !node.visible();
                    if (isHidden || !node.selected()) {
                        resizeEl.setCssStyles({
                            display: 'none',
                            pointerEvents: 'none',
                        });
                        return;
                    }
                    resizeEl.setCssStyles({
                        display: 'flex',
                        pointerEvents: 'auto',
                        opacity: '1',
                    });
                    const zoom = this.cy.zoom();
                    // 文本节点 Canvas label 透明但仍参与默认 boundingBox 计算，
                    // 大段文本会让句柄飘到节点下方很远 — 用纯形状 box 修正
                    const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
                    const size = Math.max(14, 18 * zoom);
                    resizeEl.setCssStyles({
                        width: `${size}px`,
                        height: `${size}px`,
                        fontSize: `${Math.max(8, 11 * zoom)}px`,
                        transform: `translate(${bb.x2 - size}px, ${bb.y2 - size}px)`,
                    });
                };

                badgeUpdaters.push({ node, fn: updateResizeHandle });
            });
        }

        // embed toggle 按钮（睁眼/闭眼，文件节点⟷预览节点互转）
        if (!readOnly) {
            this.cy.nodes().forEach((node: cytoscape.NodeSingular) => {
                if (incIds && !incIds.has(node.id())) return;
                if (node.data('isRoot') || node.data('isPlaceholder') || node.data('isGroup') || node.data('isStandaloneText')) return;
                if (node.data('isTextOnly')) return;
                if (node.data('isCrossDomain')) return;
                const isEmbed = !!node.data('isEmbed');
                if (isEmbed) return;
                const toggleEl = activeDocument.createElement('div');
                toggleEl.className = 'zk-embed-toggle';
                const toggleLabel = isEmbed ? '切换为文件节点' : '切换为 Embed 节点';
                toggleEl.setAttribute('aria-label', toggleLabel);
                setIcon(toggleEl, isEmbed ? 'eye-off' : 'eye');
                toggleEl.setCssStyles({
                    position: 'absolute',
                    cursor: 'pointer',
                    pointerEvents: 'auto',
                    opacity: '0.88',
                    transition: 'opacity 0.15s ease, transform 0.15s ease',
                    userSelect: 'none',
                    zIndex: '10',
                    width: '24px',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-normal)',
                });
                const toggleSvg = toggleEl.querySelector('svg') as SVGElement | null;
                if (toggleSvg) {
                    toggleSvg.setCssStyles({
                        width: '95%',
                        height: '95%',
                        strokeWidth: '2.2',
                    });
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
                    if (isHidden) { toggleEl.setCssStyles({ display: 'none' }); return; }
                    if (!node.selected()) {
                        toggleEl.setCssStyles({
                            display: 'none',
                            pointerEvents: 'none',
                        });
                        return;
                    }
                    toggleEl.setCssStyles({
                        display: '',
                        opacity: '1',
                        pointerEvents: 'auto',
                    });
                    const zoom = this.cy.zoom();
                    const bb = node.renderedBoundingBox();
                    const size = Math.max(20, 24 * zoom);
                    toggleEl.setCssStyles({
                        width: `${size}px`,
                        height: `${size}px`,
                    });
                    let x = bb.x1 + bb.w / 2 - size / 2;
                    let y = bb.y2 + 8 * zoom;

                    if (isEmbed) {
                        if (!toggleEmbedCardCache) toggleEmbedCardCache = this.container?.querySelector(`.zk-embed-preview-card[data-node-id="${node.id()}"]`) as HTMLElement ?? null;
                        if (toggleEmbedCardCache) {
                            x = toggleEmbedCardCache.offsetLeft + (toggleEmbedCardCache.offsetWidth - size) / 2;
                            y = toggleEmbedCardCache.offsetTop + toggleEmbedCardCache.offsetHeight + 8 * zoom;
                        }
                    }

                    toggleEl.setCssStyles({ transform: `translate(${x}px, ${y}px)` });
                };

                badgeUpdaters.push({ node, fn: updateTogglePos });
            });
        }

        __bLap('domPasses');

        // 文本节点 Markdown 渲染 overlay（增量模式只处理新节点、不做缓存淘汰）
        buildTextMarkdownOverlays.call(this, badgeContainer, badgeUpdaters, incIds);
        __bLap('textMD');

        // 注册到统一 overlay 调度器。增量模式下 badgeUpdaters 只含新节点的 updater,
        // 这里追加一个新的 badgePositionUpdater(不清理旧的),旧节点的 updater 仍在调度器中,
        // pan/zoom 时新旧并集都会被更新。
        const badgePositionUpdater = () => {
            // 非交互帧(idle / 交互结束后的 scheduleExtra/immediate):全量定位,保证稳态精确。
            if (!this.cy || !this.overlayScheduler.isInteracting) {
                for (const u of badgeUpdaters) u.fn();
                return;
            }
            // 交互(pan/zoom/drag)帧:剔除中心远离视口的节点 overlay。判据用 node.position()
            // (模型坐标,廉价,不触发 renderedBoundingBox),换算到 rendered 坐标后与视口比较。
            const pan = this.cy.pan();
            const zoom = this.cy.zoom();
            const W = this.container?.clientWidth ?? 0;
            const H = this.container?.clientHeight ?? 0;
            const M = OVERLAY_CULL_MARGIN;
            for (const u of badgeUpdaters) {
                if (u.node && !u.node.removed()) {
                    const p = u.node.position();
                    const rx = p.x * zoom + pan.x;
                    const ry = p.y * zoom + pan.y;
                    if (rx < -M || rx > W + M || ry < -M || ry > H + M) continue;
                }
                u.fn();
            }
        };
        this.overlayScheduler.updaters.add(badgePositionUpdater);
        this.overlayScheduler.immediateUpdaters.add(badgePositionUpdater);
        this.overlayScheduler.extraUpdaters.add(badgePositionUpdater);
        this.overlayScheduler.selectionUpdaters.add(badgePositionUpdater);

        if (incIds) {
            // 增量模式:默认只定位本次新增节点的 overlay。边控制点/端点(选中时惰性创建,select 处理器
            // 仍是上次全量渲染所绑、对新边同样有效)、收起手柄、分组手柄、glass 均保持原状;省去全图重定位成本。
            if (repositionAll) {
                // 已有同级被推开(auto 布局新增):已有 overlay DOM 仍有效但坐标过期,
                // immediate() 跑一遍全部已注册 updater 重定位全图(成本=一帧 pan,远低于重建 N 个 DOM)。
                this.overlayScheduler.immediate();
            } else {
                badgeUpdaters.forEach(u => u.fn());
            }
            // 连线手柄(hover 小蓝点)是逐节点绑定的,新节点必须重建才有手柄。addConnectionHandles
            // 已做自幂等(注销旧 updater + 解绑旧逐节点监听),可独立调用而不累积、不影响边 select 处理器。
            // 手柄默认 opacity:0、hover 才显示+定位,故无需在此跑全图定位。
            this.edgeControls.addConnectionHandles();
            __bLap('schedulerImmediate');
        } else {
            // 添加边控制点
            this.edgeControls.addEdgeControlPoints();

            // 添加边端点手柄
            this.edgeControls.addEdgeEndpointHandles();

            // 添加连线手柄
            this.edgeControls.addConnectionHandles();
            __bLap('edgeControls');

            // 添加折叠/展开子节点手柄
            addCollapseToggleHandle.call(this);
            __bLap('collapseHandle');

            // 添加分组调整大小手柄
            this.addGroupResizeHandles();
            __bLap('groupResize');

            // 所有 overlay 子系统注册完毕后，绑定统一事件监听
            this.overlayScheduler.bindListeners();
            this.overlayScheduler.immediate();
            __bLap('schedulerImmediate');
        }
        if (__zkPerf) {
            const total = Object.values(__bMark).reduce((a, b) => a + b, 0);
            console.log(
                `[zkPerf:badges] total=${total.toFixed(1)}ms`,
                Object.fromEntries(Object.entries(__bMark).map(([k, v]) => [k, +v.toFixed(1)]))
            );
        }
    }

    /**
     * 为所有 isTextOnly 节点构建 Markdown 渲染 overlay
     * 性能优化：
     *   1) 内容 hash 缓存 —— 跨 addNodeBadges 重建复用 overlay DOM + Component
     *   2) 快路径检测 —— 无 MD 语法时跳过 MarkdownRenderer，直接 textContent
     *   3) 批量尺寸回写 —— Promise.all 完成后 cy.batch 一次性刷新节点宽高
     */
function buildTextMarkdownOverlays(this: any, badgeContainer: HTMLElement, badgeUpdaters: BadgeUpdater[], incIds: Set<string> | null = null): void {
        if (!this.cy) return;
        const app = this.currentOptions?.app;
        if (!app) return;
        const sourcePath = this.currentData?.metadata?.currentFile || '';

        const measureAndSizePending: Array<{ node: cytoscape.NodeSingular; entry: { el: HTMLElement; width: number; height: number } }> = [];
        const renderPromises: Promise<void>[] = [];

        this.cy.nodes('[?isTextOnly]').forEach((node: cytoscape.NodeSingular) => {
            if (incIds && !incIds.has(node.id())) return;
            const data = node.data();
            if (data.isPlaceholder) return;
            // 草稿节点(#20)虽有 synthetic originalNode,但走 Cytoscape 原生 label 渲染,不建 Markdown overlay
            // (否则与原生 label 叠成双重文字,且需全量重建 overlay 影响 embed 预览)
            if (data.isDraft) return;
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
                || originalNode?.IDStr
                || originalNode?.ID
                || node.id?.()
                || ''
            );
            const cacheKey = `${TEXT_MD_OVERLAY_RENDER_VERSION}||${sourcePath}||${nodeCacheId}||${rawSource}`;
            const isRootTextNode = !!data.isRoot && !data.isFreeNode;
            const isFirstLevelTextNode = !!data.isFirstLevelNode && !data.isRoot && !data.isFreeNode;
            // 与 stylesheet.ts 中 'node[!isRoot][!isFirstLevelNode][!isFreeNode][!isEmbed][!isStandaloneText][!isCurrentFile]'
            // 的判定保持一致：2 级及以下普通节点的文字走 muted 色。
            // 此前 file 节点的 canvas label 已经吃了这条规则,但 text-only 走 DOM overlay,漏网,
            // 造成同层级 text/file 子节点颜色不一致(text 亮、file 暗)。这里补齐。
            const isLevelMutedTextNode = !data.isRoot
                && !data.isFirstLevelNode
                && !data.isFreeNode
                && !data.isStandaloneText
                && !data.isCurrentFile;
            const overlayFontSize = isRootTextNode
                ? this.ROOT_NODE_FONT_SIZE
                : (isFirstLevelTextNode ? this.FIRST_LEVEL_NODE_FONT_SIZE : 20);
            const applyTextOverlayBaseStyle = (overlayEl: HTMLElement) => {
                const overlayDisplay = isRootTextNode ? 'flex' : 'block';
                // padding 用 em,跟随当前 font-size(== base * zoom)等比伸缩
                const overlayPadding = isRootTextNode ? '0 0.923em' : '1.2em 1.2em 0.6em 1.2em';
                const overlayFontWeight = isRootTextNode
                    ? `${this.ROOT_NODE_FONT_WEIGHT}`
                    : (isFirstLevelTextNode ? `${this.FIRST_LEVEL_NODE_FONT_WEIGHT}` : '500');
                const overlayTextAlign = isRootTextNode ? 'center' : 'left';
                const overlayAlignItems = isRootTextNode ? 'center' : 'stretch';
                // 缩放策略:不用 transform: scale,改用 font-size * zoom 让文本与布局随白板缩放伸缩
                // (对齐 Obsidian Canvas 的做法)。这样 CM/vim 永远在"自然像素"里工作,fat cursor
                // 不会被 scaled parent 的亚像素误差弄歪。updateOverlayPos 会改写 font-size。
                overlayEl.dataset.baseFontSize = String(overlayFontSize);
                if (isLevelMutedTextNode) {
                    overlayEl.dataset.levelMuted = '1';
                } else {
                    delete overlayEl.dataset.levelMuted;
                }
                // 重建/重用 overlay 时,从 cy 节点的 class 同步 ancestor-active 状态,
                // 避免 select 之后任何 re-render 把高亮丢掉。
                if (node.hasClass?.('zk-ancestor-active') === true) {
                    overlayEl.classList.add('zk-ancestor-active');
                } else {
                    overlayEl.classList.remove('zk-ancestor-active');
                }
                // 注意:不要在 cssText 里写 color,让 CSS 选择器(基于 [data-level-muted="1"]
                // 和 .zk-ancestor-active)处理颜色,这样祖先链高亮可以靠 class 切换来覆盖 muted。
                // 仅当影响 cssText 的静态输入(层级/字号/对齐等)变化时才整段重写。大字符串
                // cssText 赋值会触发样式失效与重排;缓存命中复用 overlay 时这些值通常不变,
                // 逐节点跳过可显著降低 textMD 阶段成本。位置类属性由 updateOverlayPos 单独写入,
                // 不受此守卫影响。
                const styleSig = `${overlayDisplay}|${overlayAlignItems}|${overlayPadding}|${overlayFontSize}|${overlayFontWeight}|${overlayTextAlign}`;
                if (overlayEl.dataset.styleSig !== styleSig) {
                    overlayEl.dataset.styleSig = styleSig;
                    overlayEl.setCssStyles({
                        position: 'absolute',
                        left: '0',
                        top: '0',
                        display: `${overlayDisplay}`,
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: `${overlayAlignItems}`,
                        pointerEvents: 'none',
                        overflow: 'hidden',
                        boxSizing: 'border-box',
                        padding: `${overlayPadding}`,
                        maxWidth: 'none',
                        fontFamily: 'var(--font-text)',
                        fontSize: `${overlayFontSize}px`,
                        fontWeight: `${overlayFontWeight}`,
                        lineHeight: '1.35',
                        wordWrap: 'break-word',
                        overflowWrap: 'anywhere',
                        userSelect: 'none',
                        textAlign: `${overlayTextAlign}`,
                    });
                }
                const isLevelDimmed = node.hasClass?.('zk-level-dimmed') === true;
                if (isLevelDimmed) {
                    const isLightTheme = this.container?.classList.contains('zk-theme-light')
                        || (!this.container?.classList.contains('zk-theme-dark') && activeDocument.body.classList.contains('theme-light'));
                    overlayEl.dataset.levelDimmed = '1';
                    overlayEl.setCssStyles({
                        opacity: isLightTheme ? '0.92' : '0.16',
                        filter: isLightTheme ? 'none' : 'brightness(0.62) saturate(0.58)',
                    });
                } else {
                    delete overlayEl.dataset.levelDimmed;
                }
            };

            let entry = this.textMdOverlayCache.get(cacheKey);

            if (entry) {
                // 缓存命中：直接复用
                entry.usedInCycle = true;
                applyTextOverlayBaseStyle(entry.el);
                badgeContainer.appendChild(entry.el);
                // 旧数据可能只有 manualWidthModel、没有 manualHeightModel。
                // 缓存命中时也要用 overlay 真实高度同步一次节点尺寸，否则会落回
                // stylesheet 的纯文本估算高度，导致旧宽度锁定节点被压扁。
                if (Number(node.data('manualWidthModel') || 0) > 0
                    || Number(node.data('manualHeightModel') || 0) > 0) {
                    measureAndSizePending.push({ node, entry });
                }
            } else {
                // 缓存未命中：创建新 overlay
                const overlayEl = activeDocument.createElement('div');
                overlayEl.className = 'zk-text-md-overlay markdown-rendered';
                applyTextOverlayBaseStyle(overlayEl);
                overlayEl.addEventListener('click', (e: MouseEvent) => {
                    if (overlayEl.dataset.editing === '1') return;
                    e.preventDefault();
                    e.stopPropagation();
                    const nodeId = overlayEl.dataset.nodeId || '';
                    const latestNode = nodeId && this.cy ? this.cy.$id(nodeId) : null;
                    const originalNode = latestNode?.length
                        ? latestNode.data('originalNode')
                        : node.data('originalNode');
                    this.container?.dispatchEvent(new CustomEvent('node-select', {
                        detail: {
                            node: originalNode,
                            event: e
                        }
                    }));
                });
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
                // 本节点是否含 $...$ / $$...$$ 数学公式(决定是否在渲染后 flush MathJax 并重新测量)
                let mathRendered = false;
                // 粗糙渲染：用 DOM API 构建，避免大量字符串拼接
                const applyRoughInlineMarkdown = (container: HTMLElement, input: string): void => {
                    const toOverlayEm = (px: number): string => `${Number((px / overlayFontSize).toFixed(4))}em`;
                    const createExternalLink = (rawUrl: string, text?: string): HTMLAnchorElement => {
                        const a = activeDocument.createElement('a');
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
                        const a = activeDocument.createElement('a');
                        a.className = 'internal-link';
                        a.href = linkText;
                        a.dataset.href = linkText;
                        a.textContent = displayText || linkText;
                        a.addEventListener('mousedown', (e: MouseEvent) => {
                            // 标记:本次点击落在 wiki 链接区,tap 不应触发选中/detail
                            if (e.button === 0) this.suppressTapSelectAt = performance.now();
                        });
                        a.addEventListener('click', (e: MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!linkText) return;
                            const forceTab = e.ctrlKey || e.metaKey;
                            const openLink = this.currentOptions?.openLink;
                            if (openLink) openLink(linkText, sourcePath, forceTab);
                            else app?.workspace?.openLinkText?.(linkText, sourcePath, forceTab ? 'tab' : undefined);
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
                        const [targetPart, sizePart] = rawTarget.split('|');
                        const linkText = (targetPart || '').trim();
                        const pathWithoutSubpath = linkText.split('#')[0].trim();
                        const ext = pathWithoutSubpath.split('.').pop()?.toLowerCase() || '';
                        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
                        const isAudio = ['m4a', 'mp3', 'wav', 'ogg', 'oga', 'aac', 'flac', 'webm'].includes(ext);
                        const isExcalidraw = /\.excalidraw(\.md)?$/i.test(pathWithoutSubpath);
                        if (!isImage && !isAudio && !isExcalidraw) return createInternalLink(rawTarget);

                        const file = app?.metadataCache?.getFirstLinkpathDest?.(linkText, sourcePath)
                            || app?.vault?.getAbstractFileByPath?.(pathWithoutSubpath);
                        if (!file) return createInternalLink(rawTarget);

                        if (isExcalidraw) {
                            const preview = activeDocument.createElement('div');
                            preview.className = 'zk-text-md-excalidraw-embed';
                            preview.textContent = file.basename || linkText;
                            preview.title = `${file.basename || linkText}\n按住 Cmd/Ctrl 点击打开`;
                            const openExcalidraw = (e: MouseEvent) => {
                                if (!(e.ctrlKey || e.metaKey)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                app?.workspace?.openLinkText?.(linkText, sourcePath, 'tab');
                            };
                            preview.addEventListener('mousedown', openExcalidraw);
                            preview.addEventListener('click', openExcalidraw);
                            void renderExcalidrawPreview(app, preview, file, linkText).then((rendered) => {
                                if (!rendered && preview.isConnected) {
                                    preview.textContent = `Excalidraw 预览不可用：${file.basename || linkText}`;
                                }
                            });
                            return preview;
                        }

                        if (isAudio) {
                            const audio = activeDocument.createElement('audio');
                            audio.className = 'zk-text-md-embed-audio';
                            audio.src = app.vault.getResourcePath(file);
                            audio.controls = true;
                            audio.preload = 'metadata';
                            audio.title = `${file.basename || linkText}\n按住 Cmd/Ctrl 点击打开`;

                            const stopAudioInteraction = (e: Event) => {
                                e.stopPropagation();
                            };
                            audio.addEventListener('pointerdown', stopAudioInteraction);
                            audio.addEventListener('mousedown', stopAudioInteraction);
                            audio.addEventListener('click', stopAudioInteraction);
                            audio.addEventListener('dblclick', stopAudioInteraction);
                            audio.addEventListener('wheel', stopAudioInteraction);
                            audio.addEventListener('contextmenu', stopAudioInteraction);

                            audio.addEventListener('mousedown', (e: MouseEvent) => {
                                if (!(e.ctrlKey || e.metaKey)) return;
                                e.preventDefault();
                                app?.workspace?.openLinkText?.(linkText, sourcePath, 'tab');
                            });
                            return audio;
                        }

                        const img = activeDocument.createElement('img');
                        img.className = 'zk-text-md-embed-image';
                        img.src = app.vault.getResourcePath(file);
                        img.alt = linkText;
                        img.draggable = false;
                        img.title = `${file.basename || linkText}\n按住 Cmd/Ctrl 点击打开`;
                        const sizeMatch = (sizePart || '').trim().match(/^(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?$/i);
                        if (sizeMatch) {
                            const width = Math.max(1, Math.min(4096, Number(sizeMatch[1])));
                            const height = sizeMatch[2] !== undefined
                                ? Math.max(1, Math.min(4096, Number(sizeMatch[2])))
                                : null;
                            img.setCssStyles({
                                width: toOverlayEm(width),
                                maxWidth: 'none',
                            });
                            if (height !== null) {
                                img.setCssStyles({
                                    height: toOverlayEm(height),
                                    maxHeight: 'none',
                                });
                            }
                        } else {
                            const applyNaturalWidth = () => {
                                const naturalWidth = Math.max(1, Math.min(4096, img.naturalWidth || 0));
                                if (naturalWidth > 0) {
                                    img.setCssStyles({ width: toOverlayEm(naturalWidth) });
                                }
                            };
                            if (img.complete) {
                                applyNaturalWidth();
                            } else {
                                img.addEventListener('load', applyNaturalWidth, { once: true });
                            }
                        }
                        const openImage = (e: MouseEvent) => {
                            if (!(e.ctrlKey || e.metaKey)) return;
                            e.preventDefault();
                            e.stopPropagation();
                            app?.workspace?.openLinkText?.(linkText, sourcePath, 'tab');
                        };
                        img.addEventListener('mousedown', openImage);
                        img.addEventListener('click', openImage);
                        return wrapForImageToolkit(img);
                    };
                    // 按内联标记拆分并逐段追加 DOM 节点
                    const renderMathInline = (expr: string, display: boolean): HTMLElement => {
                        mathRendered = true;
                        const wrap = activeDocument.createElement('span');
                        wrap.className = 'zk-text-md-math';
                        try {
                            wrap.appendChild(renderMath(expr, display));
                        } catch {
                            wrap.textContent = display ? `$$${expr}$$` : `$${expr}$`;
                        }
                        return wrap;
                    };
                    const tokenRe = /!\[\[([^\]\n]+)\]\]|\[\[([^\]\n]+)\]\]|\*\*(.+?)\*\*|~~(.+?)~~|__(.+?)__|<u>(.*?)<\/u>|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|<span\s+style=["']([^"']+)["']>(.*?)<\/span>|((?:https?:\/\/|www\.)[^\s<>()\]]+)|\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;
                    let lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = tokenRe.exec(input)) !== null) {
                        if (m.index > lastIndex) {
                            container.appendChild(activeDocument.createTextNode(input.slice(lastIndex, m.index)));
                        }
                        if (m[1] !== undefined) {
                            container.appendChild(createEmbedNode(m[1]));
                        } else if (m[2] !== undefined) {
                            container.appendChild(createInternalLink(m[2]));
                        } else if (m[3] !== undefined) {
                            const strong = activeDocument.createElement('strong');
                            strong.textContent = m[3];
                            container.appendChild(strong);
                        } else if (m[4] !== undefined) {
                            const del = activeDocument.createElement('del');
                            del.textContent = m[4];
                            container.appendChild(del);
                        } else if (m[5] !== undefined) {
                            const u = activeDocument.createElement('u');
                            u.textContent = m[5];
                            container.appendChild(u);
                        } else if (m[6] !== undefined) {
                            const u = activeDocument.createElement('u');
                            u.textContent = m[6];
                            container.appendChild(u);
                        } else if (m[7] !== undefined) {
                            const a = createExternalLink(m[8] || '', m[7]);
                            if (m[9]) a.title = m[9];
                            container.appendChild(a);
                        } else if (m[10] !== undefined) {
                            const span = activeDocument.createElement('span');
                            const spanStyles: Record<string, string> = {};
                            for (const decl of m[10].split(';')) {
                                const ci = decl.indexOf(':');
                                if (ci === -1) continue;
                                const key = decl.slice(0, ci).trim();
                                if (key) spanStyles[key] = decl.slice(ci + 1).trim();
                            }
                            span.setCssProps(spanStyles);
                            span.textContent = m[11];
                            container.appendChild(span);
                        } else if (m[12] !== undefined) {
                            const rawUrl = m[12];
                            const trimmedUrl = rawUrl.replace(/[.,;:!?，。；：！？]+$/, '');
                            const trailing = rawUrl.slice(trimmedUrl.length);
                            container.appendChild(createExternalLink(trimmedUrl));
                            if (trailing) {
                                container.appendChild(activeDocument.createTextNode(trailing));
                            }
                        } else if (m[13] !== undefined) {
                            container.appendChild(renderMathInline(m[13], true));
                        } else if (m[14] !== undefined) {
                            container.appendChild(renderMathInline(m[14], false));
                        }
                        lastIndex = m.index + m[0].length;
                    }
                    if (lastIndex < input.length) {
                        container.appendChild(activeDocument.createTextNode(input.slice(lastIndex)));
                    }
                };
                // 列表缩进层级：tab 折算 4 空格，每 2 空格算 1 级，封顶 8 级
                const computeListIndentLevel = (ws: string): number => {
                    const normalized = ws.replace(/\t/g, '    ');
                    return Math.min(Math.floor(normalized.length / 2), 8);
                };
                const buildRoughLines = (parent: HTMLElement) => {
                    const lines = normalizedSource.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) {
                            const empty = activeDocument.createElement('div');
                            empty.className = 'zk-rough-empty-line';
                            parent.appendChild(empty);
                            continue;
                        }
                        const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
                        if (headingMatch) {
                            const level = Math.min(headingMatch[1].length, 6);
                            const div = activeDocument.createElement('div');
                            div.className = `zk-rough-heading-line zk-rough-h${level}-line`;
                            applyRoughInlineMarkdown(div, headingMatch[2]);
                            parent.appendChild(div);
                            continue;
                        }
                        // 无序列表:- / * / + 后跟空白(`---` 等分隔线因首字符后无空白不会命中)
                        const bulletMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
                        // 有序列表:1. / 2) 这类数字+. 或 ) 后跟空白
                        const orderedMatch = bulletMatch ? null : line.match(/^(\s*)(\d{1,9})([.)])\s+(.*)$/);
                        if (bulletMatch || orderedMatch) {
                            const indentWs = (bulletMatch ? bulletMatch[1] : orderedMatch![1]) || '';
                            const indentLevel = computeListIndentLevel(indentWs);
                            const content = bulletMatch ? bulletMatch[3] : orderedMatch![4];
                            const div = activeDocument.createElement('div');
                            div.className = `zk-rough-list-line ${bulletMatch ? 'zk-rough-list-bullet' : 'zk-rough-list-ordered'}`;
                            if (indentLevel > 0) {
                                div.setCssStyles({ marginLeft: `${indentLevel * 1.2}em` });
                            }
                            const marker = activeDocument.createElement('span');
                            marker.className = 'zk-rough-list-marker';
                            marker.textContent = bulletMatch ? '•' : `${orderedMatch![2]}${orderedMatch![3]}`;
                            div.appendChild(marker);
                            const body = activeDocument.createElement('span');
                            body.className = 'zk-rough-list-content';
                            applyRoughInlineMarkdown(body, content);
                            div.appendChild(body);
                            parent.appendChild(div);
                            continue;
                        }
                        const div = activeDocument.createElement('div');
                        div.className = 'zk-rough-text-line';
                        applyRoughInlineMarkdown(div, line);
                        parent.appendChild(div);
                    }
                };
                overlayEl.empty?.();
                if (isRootTextNode) {
                    const inner = activeDocument.createElement('div');
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
                // 含公式时 MathJax 异步排版，typeset 完成后再测一次尺寸(供手动锁宽高节点回写)
                if (mathRendered) {
                    const mathEntry = entry;
                    renderPromises.push(
                        finishRenderMath().then(() => {
                            if (node.removed?.()) return;
                            const r = mathEntry.el.getBoundingClientRect();
                            mathEntry.width = Math.max(80, Math.min(r.width + 4, 640));
                            mathEntry.height = Math.max(32, Math.min(r.height + 4, 640));
                            measureAndSizePending.push({ node, entry: mathEntry });
                        }).catch(() => { /* ignore */ })
                    );
                }
            }

            // 标记节点已有 overlay（供样式层判断是否隐藏 Canvas 文字）
            node.data('hasMarkdownOverlay', true);
            // 挂载 overlay 引用到节点，便于编辑期查找
            node.scratch('_zkMdOverlay', entry.el);

            // 位置同步 updater
			const currentEntry = entry;
			currentEntry.el.dataset.nodeId = node.id();
			const baseFontSize = isRootTextNode
                ? this.ROOT_NODE_FONT_SIZE
                : (isFirstLevelTextNode ? this.FIRST_LEVEL_NODE_FONT_SIZE : 20);
            const updateOverlayPos = () => {
                if (!this.cy || node.removed()) {
                    currentEntry.el.setCssStyles({ display: 'none' });
                    return;
                }
                // 使用 includeLabels:false 获取纯形状边界，避免不可见标签
                // （text-opacity:0）撑大 boundingBox 导致 overlay 宽于节点形状
                const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
                if (!bb || bb.w <= 0) {
                    currentEntry.el.setCssStyles({ display: 'none' });
                    return;
                }
                const zoom = this.cy.zoom();
                const isEditing = currentEntry.el.dataset.editing === '1';
                currentEntry.el.setCssStyles({
                    display: 'block',
                    left: `${bb.x1}px`,
                    top: `${bb.y1}px`,
                });
                // 直接按屏幕像素赋尺寸 + 用 font-size * zoom 模拟缩放(替代 transform: scale)。
                // 内部 padding / heading / cm editor 都用 em,跟随 font-size 等比伸缩。
                currentEntry.el.setCssStyles({
                    width: `${bb.w}px`,
                    height: `${bb.h}px`,
                    fontSize: `${baseFontSize * zoom}px`,
                });
                // 非编辑态缓存 model 尺寸(供手动拉伸等逻辑使用)
                if (!isEditing) {
                    currentEntry.width = bb.w / zoom;
                    currentEntry.height = bb.h / zoom;
                }
                // 溢出检测要读 scrollHeight/clientHeight,紧跟在上面的尺寸写入之后会触发强制同步重排。
                // pan/zoom 交互帧跳过它(沿用上一帧的 overflow 状态),仅在交互结束的空闲帧精确计算。
                if (!this.overlayScheduler.isInteracting) {
                    const isSelected = node.selected();
                    // overlay 用 font-size * zoom 模拟缩放，但高度直接取渲染像素盒。
                    // zoom != 1 时缩放后的换行/行高存在亚像素取整误差，可能比 clientHeight
                    // 多出近一行，导致“内容明明全展开”的节点被误判为溢出而冒出滚动条。
                    // 容差按 zoom 放大到接近一个缩放行高，吸收这种取整噪声；真正的手动压缩
                    // 通常溢出多行，仍能超过容差被检出。
                    const overflowTol = Math.max(2, baseFontSize * zoom);
                    const overflowY = (currentEntry.el.scrollHeight - currentEntry.el.clientHeight) > overflowTol;
                    currentEntry.el.dataset.overflowing = overflowY ? '1' : '0';
                    currentEntry.el.setCssStyles({
                        overflowX: 'hidden',
                        overflowY: (isSelected && overflowY) ? 'auto' : 'hidden',
                        pointerEvents: (isSelected && overflowY) ? 'auto' : 'none',
                    });
                }
            };
            badgeUpdaters.push({ node, fn: updateOverlayPos });
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
                el.setCssStyles({
                    fontSize: `${base}px`,
                    width: `${width}px`,
                    height: 'auto',
                });
                const measured = Math.ceil(Math.max(el.scrollHeight, el.getBoundingClientRect().height)) + 12;
                return Math.max(32, Math.min(640, measured));
            } catch {
                return fallbackHeight;
            } finally {
                el.setCssStyles({
                    width: prevWidth,
                    height: prevHeight,
                    fontSize: prevFontSize,
                });
            }
        };

        const applySizes = (pending: typeof measureAndSizePending) => {
            if (!this.cy || pending.length === 0) return;
            this.cy.batch(() => {
                pending.forEach(({ node, entry: e }) => {
                    if (node.removed()) return;
                    const currentWidthModel = Number(node.data('manualWidthModel') || 0);
                    const currentHeightModel = Number(node.data('manualHeightModel') || 0);
                    if (currentWidthModel <= 0 && currentHeightModel <= 0) return;
                    const targetWidth = currentWidthModel > 0 ? currentWidthModel : e.width;
                    // 仅当用户显式锁过高度（currentHeightModel > 0）才回写 data；
                    // 否则只在视觉层用 overlay 测量动态适配高度，避免把"为了当前内容渲染的临时高度"固化成用户手动尺寸，
                    // 否则改短内容后旧高度会被持续保留下来。
                    const targetHeight = currentHeightModel > 0
                        ? currentHeightModel
                        : measureOverlayHeightForWidth(e.el, targetWidth, e.height);
                    e.width = targetWidth;
                    e.height = targetHeight;
                    if (currentWidthModel > 0) {
                        node.data('manualWidthModel', targetWidth);
                    }
                    if (currentHeightModel > 0) {
                        node.data('manualHeightModel', targetHeight);
                    }
                    node.style({ width: targetWidth, height: targetHeight });
                });
            });
        };

        // 同步快路径批量写入
        const syncPending = measureAndSizePending.splice(0);
        applySizes(syncPending);

        // 异步 MD 渲染完成后批量写入（不阻塞后续 addNodeBadges 流程）
        if (renderPromises.length > 0) {
            void Promise.all(renderPromises).then(() => {
                applySizes(measureAndSizePending.splice(0));
            });
        }

        // 清理本次未使用的缓存项（mark-sweep）。增量模式跳过:本次只遍历了新节点,
        // 其余缓存项的 usedInCycle 没被置位,若清理会误删仍在用的 overlay。
        const toEvict: string[] = [];
        if (!incIds) {
            this.textMdOverlayCache.forEach((e: TextMdOverlayEntry, key: string) => {
                if (!e.usedInCycle) {
                    toEvict.push(key);
                }
            });
        }
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

function addCollapseToggleHandle(this: any): void {
        if (!this.cy || !this.container) return;

        if (this.collapseHandleCleanup) {
            this.collapseHandleCleanup();
            this.collapseHandleCleanup = null;
        }

        const handleContainer = activeDocument.createElement('div');
        handleContainer.className = 'zk-collapse-toggle-handle';
        handleContainer.setCssStyles({
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '4',
        });
        this.container.appendChild(handleContainer);
        const handleUpdaters: Array<() => void> = [];
        const nodeHoverCleanups: Array<() => void> = [];

        // 预计算"哪些 originalId 拥有子节点":单趟 O(N) 收集所有 IDStr 的点号祖先前缀,
        // 取代每节点 O(N) 的 cy.nodes().some() 全量扫描(整体 O(N²) → O(N))。
        // 一个 id 的"严格点号前缀"(段数更少且 id.startsWith(prefix + '.'))恰好等价于原
        // childId.startsWith(`${originalId}.`) 的判定,故二者结果完全一致。
        const parentIdsWithChildren = new Set<string>();
        this.cy.nodes().forEach((n: cytoscape.NodeSingular) => {
            const id = n.data()?.originalNode?.IDStr;
            if (typeof id !== 'string' || !id) return;
            const parts = id.split('.');
            let prefix = '';
            for (let i = 0; i < parts.length - 1; i++) {
                prefix = i === 0 ? parts[0] : `${prefix}.${parts[i]}`;
                parentIdsWithChildren.add(prefix);
            }
        });
        const hasChildren = (originalId: string): boolean => parentIdsWithChildren.has(originalId);

        this.cy.nodes().forEach((node: cytoscape.NodeSingular) => {
            const data = node.data();
            const originalId = data?.originalNode?.IDStr;
            if (!originalId || data?.isGroup || data?.isPlaceholder) return;
            if (!hasChildren(originalId)) return;

            const handle = activeDocument.createElement('div');
            handle.setCssStyles({
                position: 'absolute',
                width: '24px',
                height: '24px',
                borderRadius: '12px',
                backgroundColor: 'rgba(17, 24, 39, 0.85)',
                border: '1px solid rgba(148, 163, 184, 0.45)',
                color: '#e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px',
                fontWeight: '700',
                lineHeight: '1',
                cursor: 'pointer',
                pointerEvents: 'auto',
                userSelect: 'none',
                touchAction: 'manipulation',
                zIndex: '10',
            });
            handleContainer.appendChild(handle);

            // hover 节点即显示收起按钮（与右侧连线手柄一致）；已收起/选中时常驻。
            // 用「在节点上 || 在按钮上」两个标志桥接节点与按钮之间的间隙，避免移动途中闪退。
            let overNode = false;
            let overHandle = false;
            // 移出节点/手柄后的隐藏宽限期 timer:给鼠标从节点移到框外手柄的时间(见 shouldShow)。
            let hideTimer: number | null = null;
            const clearHideTimer = () => {
                if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
            };
            const scheduleHide = () => {
                clearHideTimer();
                hideTimer = window.setTimeout(() => { hideTimer = null; updateHandle(); }, 260);
            };

            const updateHandle = () => {
                if (!this.cy) return;

                const isHidden = node.hasClass('zk-collapsed-hidden') || !node.visible();
                if (isHidden) {
                    handle.setCssStyles({ display: 'none' });
                    return;
                }

                const bb = node.renderedBoundingBox();
                const size = 24;
                // 负间隙：按钮右侧叠在节点左边缘上，消除节点→按钮移动途中的鼠标死区
                const gap = -4;
                const rawLeft = bb.x1 - size - gap;
                const left = rawLeft < 4 ? bb.x1 + 4 : rawLeft;
                const rawTop = bb.y1 + (bb.h - size) / 2;
                const maxTop = Math.max(4, this.container.clientHeight - size - 4);
                const top = Math.min(Math.max(rawTop, 4), maxTop);
                const isCollapsed = this.collapsedNodeIds.has(originalId);
                // 宽限期内(hideTimer 未到期)保持显示:手柄在节点框左外侧,鼠标从节点移到手柄
                // 途中会先触发节点 mouseout,若此刻就隐藏则手柄消失、收不到 mouseenter → 点不到。
                const shouldShow = isCollapsed || node.selected() || overNode || overHandle || hideTimer !== null;

                if (!shouldShow) {
                    handle.setCssStyles({ display: 'none' });
                    return;
                }

                handle.textContent = isCollapsed ? '▶' : '▼';
                handle.title = isCollapsed ? '展开子节点' : '收起子节点';
                handle.setCssStyles({
                    width: `${size}px`,
                    height: `${size}px`,
                    borderRadius: `${size / 2}px`,
                    transform: `translate(${left}px, ${top}px)`,
                    fontSize: '14px',
                    display: 'flex',
                });
            };

            handleUpdaters.push(updateHandle);

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
                this.container?.dispatchEvent(new CustomEvent('node-collapse-state-changed', {
                    detail: {
                        nodeId: originalId,
                        collapsed: this.collapsedNodeIds.has(originalId),
                        collapsedNodeIds: Array.from(this.collapsedNodeIds)
                    }
                }));
            };
            handle.addEventListener('click', toggleCollapse);
            handle.addEventListener('touchend', toggleCollapse, { passive: false });

            // hover 节点 / hover 按钮本身 → 显示；移开两者 → 宽限期后隐藏（未收起且未选中时）。
            // 进入任一方立即取消待隐藏;离开任一方走 scheduleHide,期间鼠标落到手柄会被 onHandleEnter 取消。
            const onNodeOver = () => { clearHideTimer(); overNode = true; updateHandle(); };
            const onNodeOut = () => { overNode = false; scheduleHide(); };
            node.on('mouseover', onNodeOver);
            node.on('mouseout', onNodeOut);
            const onHandleEnter = () => { clearHideTimer(); overHandle = true; updateHandle(); };
            const onHandleLeave = () => { overHandle = false; scheduleHide(); };
            handle.addEventListener('mouseenter', onHandleEnter);
            handle.addEventListener('mouseleave', onHandleLeave);
            nodeHoverCleanups.push(() => {
                clearHideTimer();
                node.off('mouseover', undefined, onNodeOver);
                node.off('mouseout', undefined, onNodeOut);
            });
        });

        // 注册到统一 overlay 调度器
        const collapsePositionUpdater = () => handleUpdaters.forEach((fn) => fn());
        this.overlayScheduler.updaters.add(collapsePositionUpdater);
        this.overlayScheduler.extraUpdaters.add(collapsePositionUpdater);

        this.collapseHandleCleanup = () => {
            this.overlayScheduler.updaters.delete(collapsePositionUpdater);
            this.overlayScheduler.extraUpdaters.delete(collapsePositionUpdater);
            nodeHoverCleanups.forEach((fn) => fn());
            handleContainer.remove();
        };
    }
