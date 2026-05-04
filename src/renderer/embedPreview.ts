import { Component, MarkdownRenderer, resolveSubpath, setIcon } from 'obsidian';
import { ZKNode } from 'src/view/indexView';
import { isMocPath } from 'src/utils/utils';
import { applyPreviewHeaderLinkStyle, getPreviewCardTheme } from './colorUtils';
import { getMocPreviewPngCandidates } from './renderPipeline';

const wrapForImageToolkit = (img: HTMLElement): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-content';
    wrap.style.display = 'contents';
    wrap.appendChild(img);
    return wrap;
};

const getWikiSubpath = (wikiLink: string): string => {
    const rawLink = wikiLink.trim();
    const hashIdx = rawLink.indexOf('#');
    if (hashIdx < 0) return '';

    const pipeIdx = rawLink.indexOf('|', hashIdx);
    const subpath = rawLink.substring(hashIdx, pipeIdx >= 0 ? pipeIdx : rawLink.length).trim();
    return subpath;
};

const normalizeSubpath = (subpath: string): string => {
    try {
        return decodeURIComponent(subpath);
    } catch {
        return subpath;
    }
};

const extractSubpathMarkdown = (app: any, sourceFile: any, markdown: string, wikiLink: string): string | null => {
    const subpath = getWikiSubpath(wikiLink);
    if (!subpath || subpath.startsWith('#^')) return null;

    const cache = app.metadataCache.getFileCache(sourceFile);
    if (!cache) return null;

    const resolved = resolveSubpath(cache, subpath) || resolveSubpath(cache, normalizeSubpath(subpath));
    if (!resolved || resolved.type !== 'heading') return null;

    const currentHeading = resolved.current;
    const headings = cache.headings || [];
    const currentOffset = currentHeading.position.start.offset;
    const nextHeading = headings.find((heading: any) =>
        heading.position.start.offset > currentOffset && heading.level <= currentHeading.level
    );
    const startOffset = currentHeading.position.start.offset;
    const endOffset = nextHeading?.position.start.offset ?? markdown.length;
    return markdown.slice(startOffset, endOffset).trim();
};

export function renderEmbedNodePreviews(this: any): void {
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
			node.style({
				'background-opacity': 0,
				'border-opacity': 0,
				'border-width': 0,
				'label': '',
				'overlay-opacity': 0,
				'padding': 0
			});
			const theme = getPreviewCardTheme(data, this.currentOptions);
            const resolvedCardBorder = isExcalidrawFile && !!data.isFreeNode ? 'none' : theme.cardBorder;
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
                opacity: 0.82;
                filter: brightness(0.86) saturate(0.92);
                transition: opacity 0.15s ease, filter 0.15s ease;
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
            applyPreviewHeaderLinkStyle(headerLink);
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
                card.style.opacity = isSelected ? '1' : '0.82';
                card.style.filter = isSelected ? 'brightness(1) saturate(1)' : 'brightness(0.86) saturate(0.92)';
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
                    const candidates = getMocPreviewPngCandidates(sourceFile.path);
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

                    const rawLink = String(originalNode?.wikiLink || '').trim();
                    const markdownToRender = extractSubpathMarkdown(app, sourceFile, markdown, rawLink) || markdown;
                    // 控制渲染量，避免超长笔记影响图形交互
                    const snippet = markdownToRender.length > 3000 ? `${markdownToRender.slice(0, 3000)}\n\n...` : markdownToRender;
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
        this.overlayScheduler.updaters.add(embedPositionUpdater);
        this.overlayScheduler.selectionUpdaters.add(embedSelectionUpdater);

        this.embedPreviewCleanup = () => {
            this.overlayScheduler.updaters.delete(embedPositionUpdater);
            this.overlayScheduler.selectionUpdaters.delete(embedSelectionUpdater);
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
export function renderImageNodePreviews(this: any): void {
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

            const theme = getPreviewCardTheme(data, this.currentOptions);
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
                opacity: 0.82;
                filter: brightness(0.86) saturate(0.92);
                transition: border-color 0.15s ease, opacity 0.15s ease, filter 0.15s ease;
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
            applyPreviewHeaderLinkStyle(headerLink);
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
                card.style.opacity = isSelected ? '1' : '0.82';
                card.style.filter = isSelected ? 'brightness(1) saturate(1)' : 'brightness(0.86) saturate(0.92)';
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
        this.overlayScheduler.updaters.add(imagePositionUpdater);
        this.overlayScheduler.selectionUpdaters.add(imageSelectionUpdater);

        this.imagePreviewCleanup = () => {
            this.overlayScheduler.updaters.delete(imagePositionUpdater);
            this.overlayScheduler.selectionUpdaters.delete(imageSelectionUpdater);
            if (this.cy) {
                this.cy.userZoomingEnabled(true);
                this.cy.userPanningEnabled(true);
            }
            previewContainer.remove();
        };
    }
