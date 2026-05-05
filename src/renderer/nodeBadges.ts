import { Component, Platform, setIcon } from 'obsidian';
import { ZKNode } from 'src/view/indexView';
import { EmbeddableMarkdownEditor } from 'src/utils/EmbeddableMarkdownEditor';
import { darkenColor, hexToRgba, isModernThemeStyle, normalizeHexColor } from './colorUtils';
import { estimateWrappedLines } from './renderPipeline';

export function renderNodeBadges(this: any): void {
        if (!this.cy || !this.container) return;

        // 清理旧的统一 overlay 调度器（badge 重建时所有子系统也会重建）
        this.overlayScheduler.cleanupScheduler();
        this.cleanupBadgeInteractionBindings();

        // 先从旧 badgeContainer 中摘下缓存的 MD overlay（保持 DOM 节点存活，便于下面复用）
        this.textMdOverlayCache.forEach((entry: any) => {
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
                ? '1px solid rgba(180, 195, 220, 0.34)'
                : '1px solid rgba(255, 255, 255, 0.075)';
            glassEl.style.background = isLightTheme
                ? 'rgba(255, 255, 255, 0.18)'
                : 'rgba(255, 255, 255, 0.022)';
            (glassEl.style as any).backdropFilter = 'blur(6px)';
            (glassEl.style as any).webkitBackdropFilter = 'blur(6px)';
            glassEl.style.boxShadow = isLightTheme
                ? '0 1px 8px rgba(0,0,0,0.035)'
                : '0 1px 10px rgba(0,0,0,0.16)';
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
                ? '1px solid rgba(168, 184, 214, 0.54)'
                : '1px solid rgba(206, 220, 245, 0.30)';
            // 通过弱化底边制造“标签压在边框上”的半镶嵌感
            labelEl.style.borderBottomColor = isLightTheme
                ? 'rgba(168, 184, 214, 0.15)'
                : 'rgba(206, 220, 245, 0.12)';
            labelEl.style.borderRadius = '999px';
            labelEl.style.background = isLightTheme
                ? 'rgba(255, 255, 255, 0.42)'
                : 'rgba(14, 24, 40, 0.46)';
            (labelEl.style as any).backdropFilter = 'blur(5px)';
            (labelEl.style as any).webkitBackdropFilter = 'blur(5px)';
            labelEl.style.boxShadow = isLightTheme
                ? '0 1px 4px rgba(50, 70, 100, 0.09)'
                : '0 1px 5px rgba(0, 0, 0, 0.22)';
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

                // 分组拖拽反馈：拖出原分组或拖入目标分组时高亮边框
                if (groupNode.hasClass('group-exit-warning') || groupNode.hasClass('group-join-warning')) {
                    glassEl.style.border = '1.5px dashed rgba(245, 158, 11, 0.85)';
                    glassEl.style.boxShadow = '0 0 0 2px rgba(245, 158, 11, 0.12), 0 1px 10px rgba(0,0,0,0.16)';
                } else {
                    glassEl.style.border = isLightTheme
                        ? '1px solid rgba(180, 195, 220, 0.34)'
                        : '1px solid rgba(255, 255, 255, 0.075)';
                    glassEl.style.boxShadow = isLightTheme
                        ? '0 1px 8px rgba(0,0,0,0.035)'
                        : '0 1px 10px rgba(0,0,0,0.16)';
                }

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
			underlineGroupEl.dataset.nodeId = node.id();
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
            let cachedIsFirstLevel = false;
            // DOM 元素池：创建一次，后续只更新位置
            let lineElements: Array<{ hitEl: HTMLElement; underlineEl: HTMLElement }> = [];

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
                const textMaxWidth = isRoot ? 560 : (isFirstLevel ? 340 : 280);

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
                if (this.overlayScheduler.isInteracting || this.container?.dataset.zkTextNodeResizing === '1') {
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
                const isFirstLevel = !!node.data('isFirstLevelNode');

                // 仅在 label 或 isRoot 变化时重新计算换行（zoom/pan 期间跳过）
                if (label !== cachedLabel || isRoot !== cachedIsRoot || isFirstLevel !== cachedIsFirstLevel) {
                    rebuildWrappedLinesCache(label, isRoot, isFirstLevel);
                }

                const zoom = this.cy.zoom();
                const box = node.renderedBoundingBox();
                const fontPx = isRoot
                    ? this.ROOT_NODE_FONT_SIZE
                    : (isFirstLevel ? this.FIRST_LEVEL_NODE_FONT_SIZE : 20);
                const lineHeightModel = isRoot ? 42 : (isFirstLevel ? 28 : 18);
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
			remarkEl.dataset.nodeId = node.id();
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
			tooltipEl.dataset.nodeId = node.id();
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
			starEl.dataset.nodeId = node.id();
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
            const color = normalizeHexColor(rawColor);
            if (!color) return;

			const dotEl = document.createElement('div');
			dotEl.className = 'zk-node-color-dot';
			dotEl.dataset.nodeId = node.id();
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

			const badgeEl = document.createElement('div');
			badgeEl.className = 'zk-node-badge';
			badgeEl.dataset.nodeId = node.id();
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
                    this.overlayScheduler.immediate();
                };

                const onUp = () => {
                    if (!resizing || !this.cy) return;
                    resizing = false;
                    if (this.container) delete this.container.dataset.zkTextNodeResizing;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
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
                    // 文本节点 Canvas label 透明但仍参与默认 boundingBox 计算，
                    // 大段文本会让句柄飘到节点下方很远 — 用纯形状 box 修正
                    const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
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
        buildTextMarkdownOverlays.call(this, badgeContainer, badgeUpdaters);

        // 注册到统一 overlay 调度器
        const badgePositionUpdater = () => badgeUpdaters.forEach(updater => updater());
        this.overlayScheduler.updaters.add(badgePositionUpdater);
        this.overlayScheduler.immediateUpdaters.add(badgePositionUpdater);
        this.overlayScheduler.extraUpdaters.add(badgePositionUpdater);
        this.overlayScheduler.selectionUpdaters.add(badgePositionUpdater);

        // 添加边控制点
        this.edgeControls.addEdgeControlPoints();

        // 添加边端点手柄
        this.edgeControls.addEdgeEndpointHandles();

        // 添加连线手柄
        this.edgeControls.addConnectionHandles();

        // 添加折叠/展开子节点手柄
        addCollapseToggleHandle.call(this);
        
        // 添加分组调整大小手柄
        this.addGroupResizeHandles();

        // 所有 overlay 子系统注册完毕后，绑定统一事件监听
        this.overlayScheduler.bindListeners();
        this.overlayScheduler.immediate();
    }

    /**
     * 为所有 isTextOnly 节点构建 Markdown 渲染 overlay
     * 性能优化：
     *   1) 内容 hash 缓存 —— 跨 addNodeBadges 重建复用 overlay DOM + Component
     *   2) 快路径检测 —— 无 MD 语法时跳过 MarkdownRenderer，直接 textContent
     *   3) 批量尺寸回写 —— Promise.all 完成后 cy.batch 一次性刷新节点宽高
     */
function buildTextMarkdownOverlays(this: any, badgeContainer: HTMLElement, badgeUpdaters: Array<() => void>): void {
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
            const isFirstLevelTextNode = !!data.isFirstLevelNode && !data.isRoot && !data.isFreeNode;
            const applyTextOverlayBaseStyle = (overlayEl: HTMLElement) => {
                const overlayDisplay = isRootTextNode ? 'flex' : 'block';
                // padding 用 em,跟随当前 font-size(== base * zoom)等比伸缩
                const overlayPadding = isRootTextNode ? '0 0.923em' : '1.2em 1.2em 0.6em 1.2em';
                const overlayFontSize = isRootTextNode
                    ? this.ROOT_NODE_FONT_SIZE
                    : (isFirstLevelTextNode ? this.FIRST_LEVEL_NODE_FONT_SIZE : 20);
                const overlayFontWeight = isRootTextNode
                    ? `${this.ROOT_NODE_FONT_WEIGHT}`
                    : (isFirstLevelTextNode ? `${this.FIRST_LEVEL_NODE_FONT_WEIGHT}` : '500');
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
			currentEntry.el.dataset.nodeId = node.id();
			const baseFontSize = isRootTextNode
                ? this.ROOT_NODE_FONT_SIZE
                : (isFirstLevelTextNode ? this.FIRST_LEVEL_NODE_FONT_SIZE : 20);
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
                const measured = Math.ceil(Math.max(el.scrollHeight, el.getBoundingClientRect().height)) + 12;
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
        this.textMdOverlayCache.forEach((e: any, key: string) => {
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

function addCollapseToggleHandle(this: any): void {
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
        this.overlayScheduler.updaters.add(collapsePositionUpdater);
        this.overlayScheduler.extraUpdaters.add(collapsePositionUpdater);

        this.collapseHandleCleanup = () => {
            this.overlayScheduler.updaters.delete(collapsePositionUpdater);
            this.overlayScheduler.extraUpdaters.delete(collapsePositionUpdater);
            handleContainer.remove();
        };
    }
