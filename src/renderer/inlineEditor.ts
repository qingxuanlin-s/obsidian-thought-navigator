import { Component, setIcon } from 'obsidian';
import { ZKNode } from 'src/view/indexView';
import { EmbeddableMarkdownEditor } from 'src/utils/EmbeddableMarkdownEditor';
import {
    DEFAULT_SELECTION_BG_COLOR,
    DEFAULT_SELECTION_TEXT_COLOR,
    createSelectionColorPanel,
} from './colorUtils';
import { buildWikiLinkForFile } from './renderPipeline';
import { TEXT_MD_OVERLAY_RENDER_VERSION } from './nodeBadges';

function isLivePreviewMediaInteraction(target: EventTarget | null): boolean {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    return !!el.closest([
        '.internal-embed',
        '.markdown-embed',
        '.image-embed',
        '.media-embed',
        '.cm-embed-block',
        '.cm-widgetBuffer',
        'img',
        'audio',
        'video'
    ].join(', '));
}

function extractWikiLinkAtPos(doc: string, pos: number): string {
    const pattern = /!?\[\[([^\]\n]+)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(doc)) !== null) {
        if (pos >= match.index && pos <= match.index + match[0].length) {
            return match[1].split('|')[0].trim();
        }
    }
    return '';
}

function getLivePreviewLinkText(target: EventTarget | null): string {
    const el = target instanceof Element ? target : null;
    if (!el) return '';
    const linkEl = el.closest<HTMLElement>([
        'a.internal-link',
        'a.external-link',
        'a[href]',
        '.internal-embed',
        '.markdown-embed'
    ].join(', '));
    if (!linkEl) return '';

    const dataset = linkEl.dataset || {};
    const raw = dataset.href
        || dataset.src
        || linkEl.getAttribute('data-href')
        || linkEl.getAttribute('data-src')
        || linkEl.getAttribute('href')
        || '';
    return raw.trim();
}

export function attachInlineTextSelectionToolbar(this: any, inputEl: HTMLInputElement | HTMLTextAreaElement): {
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
                const initial = this.lastPickedTextColor ?? DEFAULT_SELECTION_TEXT_COLOR;
                colorPanel = createSelectionColorPanel(initial, this.lastPickedTextColor, '自定义颜色', (color) => {
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
                const initial = this.lastPickedBgColor ?? DEFAULT_SELECTION_BG_COLOR;
                bgColorPanel = createSelectionColorPanel(initial, this.lastPickedBgColor, '自定义背景色', (color) => {
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

export function attachContentSelectionToolbar(this: any, rootEl: HTMLElement,
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
                const initial = this.lastPickedTextColor ?? DEFAULT_SELECTION_TEXT_COLOR;
                colorPanel = createSelectionColorPanel(initial, this.lastPickedTextColor, '自定义颜色', (color) => {
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
                const initial = this.lastPickedBgColor ?? DEFAULT_SELECTION_BG_COLOR;
                bgColorPanel = createSelectionColorPanel(initial, this.lastPickedBgColor, '自定义背景色', (color) => {
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
export function showInlineEdgeLabelEditor(this: any, edge: any): void {
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
export function showInlineNodeEditor(this: any, node: any): void {
        if (!this.cy || !this.container || this.isReadOnlyMode()) return;

        const data = node.data();
        const originalNode = data.originalNode;
        const isPlaceholder = !!data.isPlaceholder;
        const isDraft = !!data.isDraft;  // 草稿节点(#20):复用同一文本框编辑,保存时只更新内存
        const isExistingNode = !!originalNode && !data.isGroup;
        if (!isPlaceholder && !isExistingNode && !isDraft) return;

        this.ensureNodeVisibleInViewport(node);

        // 移除已存在的编辑器
        const existingEditor = this.container.querySelector('.node-label-editor');
        if (existingEditor) {
            existingEditor.remove();
        }

        // 占位符 / 草稿节点(#20):使用与文本节点一致的 CM6 原地编辑器
        if (isPlaceholder || isDraft) {
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
            const cacheKey = `${TEXT_MD_OVERLAY_RENDER_VERSION}||${sourcePath}||${nodeCacheId}||${rawSource}`;
            const cachedEntry = this.textMdOverlayCache.get(cacheKey);
            if (cachedEntry) {
                this.startInPlaceTextEdit(node, originalNode, cachedEntry);
                return;
            }
        }

        const renderedPosition = node.renderedPosition();
        const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
        const initialBoxWidth = Math.max(bb.w, 80);
        const initialBoxHeight = Math.max(bb.h, 44);
        const lockedBoxLeft = bb.x1;
        const lockedBoxTop = bb.y1;

        // 创建 textarea，直接覆盖在节点上
        const textarea = document.createElement('textarea');
        const originalDisplayLabel = data.label || '';
        const initialValue = (isPlaceholder || isDraft)
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
        // 文本节点使用与 MD overlay 一致的字体和左对齐(草稿也走文本编辑样式)
        const isTextOnlyEdit = !!originalNode?.isTextOnly || isDraft;
        const isRootEdit = !!data.isRoot && !data.isFreeNode;
        const isFirstLevelEdit = !!data.isFirstLevelNode && !data.isRoot && !data.isFreeNode;
        const nodeFontSize = isTextOnlyEdit
            ? (isRootEdit
                ? `${this.ROOT_NODE_FONT_SIZE}px`
                : (isFirstLevelEdit ? `${this.FIRST_LEVEL_NODE_FONT_SIZE}px` : '20px'))
            : getRenderedNodeFontSize();
        const nodeFontFamily = getRenderedNodeFontFamily();
        const nodeFontWeight = isTextOnlyEdit
            ? (isRootEdit
                ? `${this.ROOT_NODE_FONT_WEIGHT}`
                : (isFirstLevelEdit ? `${this.FIRST_LEVEL_NODE_FONT_WEIGHT}` : '500'))
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
            border-radius: 16px;
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
            const wikiLink = buildWikiLinkForFile(file);
            const wikiText = `${embed ? '!' : ''}[[${wikiLink}]]`;

            textarea.value = `${before}${wikiText}${after}`;
            const newCursor = before.length + wikiText.length;
            textarea.setSelectionRange(newCursor, newCursor);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };

        // 保存函数
        const saveNode = async () => {
            const newLabel = textarea.value.trim();

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
                        position: actualPosition,
                        // 草稿节点没有 originalNode,带上 cy id + 标记,交给 indexView 路由到内存更新
                        nodeId: data.id,
                        isDraft: isDraft
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
                if (e.shiftKey || e.metaKey || e.ctrlKey) {
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
                        wikiLink: buildWikiLinkForFile(file),
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
export function startInPlaceTextEdit(this: any, node: any,
        originalNode: ZKNode,
        entry: {
            el: HTMLElement;
            component: Component;
            mdEditor?: EmbeddableMarkdownEditor | null;
            width: number;
            height: number;
            isPlainText: boolean;
            usedInCycle: boolean;
        }): void {
        if (!this.cy || !this.container) return;

        // 先卸载只读展示用的 editor，避免与可编辑 editor 冲突
        if (entry.mdEditor) {
            try { entry.mdEditor.unload(); } catch { /* ignore */ }
            entry.mdEditor = null;
        }

        this.ensureNodeVisibleInViewport(node);

        const overlayEl = entry.el;
        const savedNodes = Array.from(overlayEl.childNodes).map((child) => child.cloneNode(true));
        const restoreSavedOverlay = () => {
            overlayEl.replaceChildren(...savedNodes.map((child) => child.cloneNode(true)));
        };
        // 用节点真实样式尺寸(不含边框)。此前用 entry.width/height(展示态 renderedBoundingBox
        // 含边框,根节点边框 4.5px),取消编辑时会把含边框尺寸锁成 manualWidthModel,导致
        // 每次"双击不编辑再退出"都涨一圈。
        const savedWidth = Number(node.width()) || entry.width;
        const savedHeight = Number(node.height()) || entry.height;
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
        const logGlobalEnter = (scope: 'window' | 'document') => (e: KeyboardEvent) => {
            if (e.key !== 'Enter') return;
            const activeEl = document.activeElement as HTMLElement | null;
            const isInThisEditor = !!activeEl && editorHost.contains(activeEl);
            if (scope === 'window' && isInThisEditor && (e.shiftKey || e.metaKey || e.ctrlKey) && mdEditor) {
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
        const stopPointerPropagationUnlessMedia = (evt: Event) => {
            if (isLivePreviewMediaInteraction(evt.target)) return;
            evt.stopPropagation();
        };
        const stopWheelPropagation = (evt: WheelEvent) => {
            evt.stopPropagation();
            // 触控板捏合/浏览器缩放手势不应继续传给白板缩放
            if (evt.ctrlKey || evt.metaKey) {
                evt.preventDefault();
            }
        };
        const openLivePreviewLink = (evt: MouseEvent) => {
            if (!(evt.metaKey || evt.ctrlKey)) return;
            let linkText = getLivePreviewLinkText(evt.target);
            if (!linkText) {
                const cm = mdEditor?.getCM?.();
                if (cm) {
                    const pos = cm.posAtCoords?.({ x: evt.clientX, y: evt.clientY }, false);
                    if (pos != null) {
                        linkText = extractWikiLinkAtPos(cm.state.doc.toString(), pos);
                    }
                }
            }
            if (!linkText) return;
            evt.preventDefault();
            evt.stopPropagation();
            if (/^(https?:\/\/|mailto:)/i.test(linkText)) {
                window.open(linkText, '_blank');
                return;
            }
            this.currentOptions?.app?.workspace?.openLinkText?.(linkText, sourcePath, 'tab');
        };
        const pointerEventsToStop = [
            'mousedown', 'mousemove', 'mouseup',
            'pointerdown', 'pointermove', 'pointerup',
            'touchstart', 'touchmove', 'touchend',
            'dragstart', 'click', 'dblclick'
        ];
        editorHost.addEventListener('click', openLivePreviewLink, true);
        pointerEventsToStop.forEach((name) => {
            editorHost.addEventListener(name, stopPointerPropagationUnlessMedia, true);
            editorHost.addEventListener(name, stopPointerPropagation);
        });
        editorHost.addEventListener('wheel', stopWheelPropagation, { capture: true, passive: false });

        const restoreNodeInteractivity = () => {
            if (this.cy && !node.removed() && typeof node.grabbable === 'function') {
                node.grabbable(nodeWasGrabbable);
            }
            this.cy?.userZoomingEnabled(prevZoomingEnabled);
        };

        let cleanupOverlaySync = () => {};
        let labelUpdateRaf: number | null = null;
        const clearLiveEdit = () => {
            this.liveEditCleanupHandlers.delete(clearLiveEdit);
            cleanupOverlaySync();
            if (labelUpdateRaf !== null) {
                cancelAnimationFrame(labelUpdateRaf);
                labelUpdateRaf = null;
            }
            selectionToolbar?.destroy();
            selectionToolbar = null;
            if (mdEditor) {
                mdEditor.unload();
                mdEditor = null;
            }
            (editorHost as any)._mdEditor = null;
            window.removeEventListener('keydown', onWindowKeyDown, true);
            document.removeEventListener('keydown', onDocumentKeyDown, true);
            editorHost.removeEventListener('click', openLivePreviewLink, true);
            pointerEventsToStop.forEach((name) => {
                editorHost.removeEventListener(name, stopPointerPropagationUnlessMedia, true);
                editorHost.removeEventListener(name, stopPointerPropagation);
            });
            editorHost.removeEventListener('wheel', stopWheelPropagation, true);
        };
        this.liveEditCleanupHandlers.add(clearLiveEdit);

        const restoreOverlay = () => {
            clearLiveEdit();
            restoreNodeInteractivity();
            restoreSavedOverlay();
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
                    node.data('label', rawSource);
                    node.data('manualWidthModel', savedWidth);
                    node.data('manualHeightModel', savedHeight);
                    node.style({ width: savedWidth, height: savedHeight });
                });
            }
            this.container?.focus();
        };

        let editRenderRaf: number | null = null;
        const syncOverlayPos = () => {
            if (!this.cy || node.removed() || !mdEditor) return null;
            const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
            if (!bb || bb.w <= 0 || bb.h <= 0) return null;
            const zoom = this.cy.zoom() || 1;
            overlayEl.style.left = `${bb.x1}px`;
            overlayEl.style.top = `${bb.y1}px`;
            overlayEl.style.width = `${bb.w}px`;
            overlayEl.style.height = `${bb.h}px`;
            // 编辑态字号与展示态 overlay 同源:根=36/一级=24/普通=20(写在 dataset.baseFontSize)。
            // 此前写死 20px,导致根节点编辑时字号被缩小、与展示态不一致。
            const overlayBaseFontSize = Number(overlayEl.dataset.baseFontSize) || 20;
            overlayEl.style.fontSize = `${overlayBaseFontSize * zoom}px`;
            entry.width = Number(node.width() || entry.width);
            entry.height = Number(node.height() || entry.height);
            return entry.height;
        };

        const scheduleOverlaySync = () => {
            if (editRenderRaf !== null) return;
            editRenderRaf = requestAnimationFrame(() => {
                editRenderRaf = null;
                syncOverlayPos();
            });
        };

        const updateLiveEditLabelNow = () => {
            labelUpdateRaf = null;
            if (!this.cy || node.removed() || !mdEditor) return;
            node.data('label', mdEditor.getValue() ?? '');
            this.cy.style().update();
            this.overlayScheduler?.immediate?.();
            scheduleOverlaySync();
        };
        const updateLiveEditLabel = () => {
            if (labelUpdateRaf !== null) return;
            labelUpdateRaf = requestAnimationFrame(updateLiveEditLabelNow);
        };

        const saveEdit = () => {
            if (isSaved) return;
            const rawValue = (mdEditor?.getValue() ?? '').replace(/\r\n/g, '\n');
            if (!rawValue.trim()) {
                cancelEdit();
                return;
            }
            if (rawValue === rawSource) {
                cancelEdit();
                return;
            }
            // 内容变化时让高度回归"按新内容自动适配":
            // 清掉旧的高度锁定（含 inline style 与 data），下一轮 applySizes 会基于新内容重新测量。
            // 宽度保持用户已锁定的值不动。
            const widthLockedByUser = Number(node.data('manualWidthModel') || 0) > 0;
            const heightLockedByUser = Number(node.data('manualHeightModel') || 0) > 0;
            try { (node as any).removeStyle?.('height'); } catch { /* ignore */ }
            if (heightLockedByUser) {
                node.removeData('manualHeightModel');
            }
            node.data('label', rawValue);
            this.cy?.style().update();
            syncOverlayPos();
            const rawCurrentWidth = Number(node.width());
            const rawCurrentHeight = Number(node.height());
            const currentWidth = Number.isFinite(rawCurrentWidth) && rawCurrentWidth > 0 ? rawCurrentWidth : entry.width;
            const currentHeight = Number.isFinite(rawCurrentHeight) && rawCurrentHeight > 0 ? rawCurrentHeight : entry.height;
            const finalWidth = currentWidth;
            const finalHeightModel = currentHeight;
            // 只在用户显式锁过宽度时才回写 embed_node_sizes;高度走自动适配,不再持久化。
            const shouldPersistManualSize = widthLockedByUser;
            isSaved = true;
            clearLiveEdit();
            restoreNodeInteractivity();
            overlayEl.style.pointerEvents = prevPointerEvents || 'none';

            const nodePosition = node.position();
            const anchoredPosition = {
                x: nodePosition.x + (finalWidth - currentWidth) / 2,
                y: nodePosition.y + (finalHeightModel - currentHeight) / 2
            };
            this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
                detail: {
                    node: originalNode,
                    content: rawValue,
                    position: anchoredPosition,
                    nodeSize: shouldPersistManualSize ? {
                        widthModel: finalWidth,
                        // 高度走自动适配:用 0 表示"无锁定",由 stylesheet/overlay 测量动态决定。
                        heightModel: 0
                    } : undefined
                }
            }));

            setTimeout(() => {
                if (overlayEl.isConnected && overlayEl.dataset.editing === '1') {
                    restoreSavedOverlay();
                    delete overlayEl.dataset.editing;
                    overlayEl.style.pointerEvents = prevPointerEvents || 'none';
                    restoreNodeInteractivity();
                }
            }, 50);

            this.container?.focus();
        };

        const onRender = () => scheduleOverlaySync();
        this.cy.on('render zoom pan', onRender);
        cleanupOverlaySync = () => {
            if (editRenderRaf !== null) {
                cancelAnimationFrame(editRenderRaf);
                editRenderRaf = null;
            }
            this.cy?.off('render zoom pan', onRender);
        };

        try {
            mdEditor = new EmbeddableMarkdownEditor({
                app: this.currentOptions?.app,
                containerEl: editorHost,
                initialValue: rawSource,
                sourcePath,
                onChange: () => updateLiveEditLabel(),
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
            (editorHost as any)._mdEditor = mdEditor;
            mdEditor.focus();
            const editorDom = mdEditor.getDom();
            if (editorDom) {
                selectionToolbar = this.attachContentSelectionToolbar(editorHost, (formatter: (selectedText: string) => string) => {
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
export function startPlaceholderInPlaceEdit(this: any, node: any): void {
        if (!this.cy || !this.container) return;

        const data = node.data();
        const isDraft = !!data.isDraft;                 // 草稿节点(#20):复用本 CM6 编辑器,但保存只更新内存
        const originalLabel = String(data.label || ''); // 草稿原始内容,用于取消时还原 / 判断是否新建空节点

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
        const stopPointerPropagationUnlessMedia = (evt: Event) => {
            if (isLivePreviewMediaInteraction(evt.target)) return;
            evt.stopPropagation();
        };
        const stopWheelPropagation = (evt: WheelEvent) => {
            evt.stopPropagation();
            if (evt.ctrlKey || evt.metaKey) evt.preventDefault();
        };
        const openLivePreviewLink = (evt: MouseEvent) => {
            if (!(evt.metaKey || evt.ctrlKey)) return;
            let linkText = getLivePreviewLinkText(evt.target);
            if (!linkText) {
                const cm = mdEditor?.getCM?.();
                if (cm) {
                    const pos = cm.posAtCoords?.({ x: evt.clientX, y: evt.clientY }, false);
                    if (pos != null) {
                        linkText = extractWikiLinkAtPos(cm.state.doc.toString(), pos);
                    }
                }
            }
            if (!linkText) return;
            evt.preventDefault();
            evt.stopPropagation();
            if (/^(https?:\/\/|mailto:)/i.test(linkText)) {
                window.open(linkText, '_blank');
                return;
            }
            this.currentOptions?.app?.workspace?.openLinkText?.(linkText, sourcePath, 'tab');
        };
        const pointerEventsToStop = [
            'mousedown', 'mousemove', 'mouseup',
            'pointerdown', 'pointermove', 'pointerup',
            'touchstart', 'touchmove', 'touchend',
            'dragstart', 'click', 'dblclick'
        ];
        editorHost.addEventListener('click', openLivePreviewLink, true);
        pointerEventsToStop.forEach((name) => {
            editorHost.addEventListener(name, stopPointerPropagationUnlessMedia, true);
            editorHost.addEventListener(name, stopPointerPropagation);
        });
        editorHost.addEventListener('wheel', stopWheelPropagation, { capture: true, passive: false });

        const restoreNodeInteractivity = () => {
            if (this.cy && !node.removed() && typeof node.grabbable === 'function') {
                node.grabbable(nodeWasGrabbable);
            }
            this.cy?.userZoomingEnabled(prevZoomingEnabled);
        };

        let syncRaf: number | null = null;
        const autoGrow = () => {
            if (!this.cy || node.removed()) return;
            const value = mdEditor?.getValue() ?? '';
            node.data('label', value);
            this.cy.batch(() => {
                if (value.trim() && typeof node.removeStyle === 'function') {
                    node.removeStyle('width height');
                }
            });
            this.cy.style().update();
            if (syncRaf !== null) return;
            syncRaf = requestAnimationFrame(() => {
                syncRaf = null;
                syncOverlayPos();
            });
        };

        const cleanup = () => {
            this.liveEditCleanupHandlers.delete(cleanup);
            selectionToolbar?.destroy();
            selectionToolbar = null;
            if (mdEditor) {
                mdEditor.unload();
                mdEditor = null;
            }
            pointerEventsToStop.forEach((name) => {
                editorHost.removeEventListener(name, stopPointerPropagationUnlessMedia, true);
                editorHost.removeEventListener(name, stopPointerPropagation);
            });
            editorHost.removeEventListener('click', openLivePreviewLink, true);
            editorHost.removeEventListener('wheel', stopWheelPropagation, true);
            restoreNodeInteractivity();
            if (overlayEl.parentNode) overlayEl.remove();
            if (syncRaf !== null) {
                cancelAnimationFrame(syncRaf);
                syncRaf = null;
            }
            this.cy?.off('render zoom pan', onRender);
        };
        this.liveEditCleanupHandlers.add(cleanup);

        const cancelEdit = () => {
            if (isSaved) return;
            isSaved = true;
            cleanup();
            // 草稿(#20):取消不走占位符删除流程。空的新草稿删掉,否则还原原内容、保留节点
            if (isDraft) {
                if (!originalLabel.trim()) {
                    this.container?.dispatchEvent(new CustomEvent('draft-node-delete', { detail: { draftId: data.id } }));
                } else {
                    node.data('label', originalLabel);
                }
                this.container?.focus();
                return;
            }
            this.container?.dispatchEvent(new CustomEvent('placeholder-node-cancel', {
                detail: { nodeId: data.id }
            }));
            this.container?.focus();
        };

        const saveEdit = () => {
            if (isSaved) return;
            const newValue = (mdEditor?.getValue() ?? '').trim();
            // 草稿(#20):保存只更新内存草稿内容(不写 MOC);空内容则删除该草稿
            if (isDraft) {
                isSaved = true;
                cleanup();
                if (!newValue) {
                    this.container?.dispatchEvent(new CustomEvent('draft-node-delete', { detail: { draftId: data.id } }));
                } else {
                    node.data('label', newValue);
                    this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
                        detail: { nodeId: data.id, content: newValue, isDraft: true }
                    }));
                }
                this.container?.focus();
                return;
            }
            if (!newValue) {
                cancelEdit();
                return;
            }
            node.data('label', newValue);
            if (typeof node.removeStyle === 'function') {
                node.removeStyle('width height');
            }
            this.cy?.style().update();
            syncOverlayPos();
            // 捕获占位符当前的模型尺寸。
            // 该尺寸只适合文件/嵌入节点；普通文本节点应走文字测量自适应，
            // 否则会把占位符默认 240×80 持久化为手动尺寸。
            const editWidthModel = Number(node.width()) || defaultW;
            const editHeightModel = Number(node.height()) || defaultH;
            const nodeSize = { width: editWidthModel, height: editHeightModel };

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
                            suggestedNodeId: data.suggestedNodeId,
                            nodeSize
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
                    suggestedNodeId: data.suggestedNodeId,
                    nodeSize: undefined
                }
            }));
            this.container?.focus();
        };

        const onRender = () => {
            if (syncRaf !== null) return;
            syncRaf = requestAnimationFrame(() => {
                syncRaf = null;
                syncOverlayPos();
            });
        };

        // 监听真实渲染与视口变化同步 overlay 位置
        this.cy.on('render zoom pan', onRender);

        const sourcePath = this.currentData?.metadata?.currentFile || '';

        try {
            mdEditor = new EmbeddableMarkdownEditor({
                app: this.currentOptions?.app,
                containerEl: editorHost,
                initialValue: isDraft ? originalLabel : '',
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
                selectionToolbar = this.attachContentSelectionToolbar(editorHost, (formatter: (selectedText: string) => string) => {
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
export function startPlaceholderTextareaFallback(this: any, node: any): void {
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
            border-radius: 12px;
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
                if (e.shiftKey || e.metaKey || e.ctrlKey) {
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
export function startInPlaceTextEditLegacy(this: any, node: any,
        originalNode: ZKNode,
        entry: {
            el: HTMLElement;
            component: Component;
            mdEditor?: EmbeddableMarkdownEditor | null;
            width: number;
            height: number;
            isPlainText: boolean;
            usedInCycle: boolean;
        }): void {
        if (!this.cy || !this.container) return;

        this.ensureNodeVisibleInViewport(node);

        const overlayEl = entry.el;
        const savedNodes = Array.from(overlayEl.childNodes).map((child) => child.cloneNode(true));
        const restoreSavedOverlay = () => {
            overlayEl.replaceChildren(...savedNodes.map((child) => child.cloneNode(true)));
        };
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
            restoreSavedOverlay();
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
            const originalValue = String(
                originalNode.title
                || originalNode.displayText
                || node.data('label')
                || ''
            ).replace(/\\n/g, '\n').trim();
            if (newValue === originalValue) {
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
            // 内容变化时让高度回归"按新内容自动适配":
            // 清掉旧的高度锁定（含 inline style 与 data），避免把旧内容的高度延续到新内容。
            const widthLockedByUser = Number(node.data('manualWidthModel') || 0) > 0;
            try { (node as any).removeStyle?.('height'); } catch { /* ignore */ }
            node.removeData('manualHeightModel');
            this.cy?.style().update();
            const shouldPersistManualSize = widthLockedByUser;
            this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
                detail: {
                    node: originalNode,
                    content: newValue,
                    position: { x: nodePosition.x, y: nodePosition.y },
                    nodeSize: shouldPersistManualSize ? {
                        widthModel: Number(node.width()),
                        // 高度走自动适配:用 0 表示"无锁定"。
                        heightModel: 0
                    } : undefined
                }
            }));

            // 兜底：若事件处理不触发重建（内容未变化），需要恢复 overlay 的原 HTML
            // 延迟一帧检查：若 overlayEl 仍存在且仍在 DOM 中且没有被新渲染填充，则恢复
            setTimeout(() => {
                if (overlayEl.isConnected && overlayEl.dataset.editing === '1') {
                    restoreSavedOverlay();
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
                if (e.shiftKey || e.metaKey || e.ctrlKey) {
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
            const wikiLink = buildWikiLinkForFile(file);
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

export function ensureNodeVisibleInViewport(this: any, node: any, padding: number = 40): void {
        if (!this.cy || !this.container || !node || node.length === 0) return;

        // 文本节点用 markdown overlay 渲染，Canvas label 透明但仍参与默认 boundingBox。
        // 若包含 labels，长文本会让 box 远超实际卡片，触发误判把画布平移开。
        const box = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
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
export function checkForLinkPattern(this: any, textarea: HTMLTextAreaElement,
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
export function showLinkSuggester(this: any, textarea: HTMLTextAreaElement,
        node: any,
        boundingBox: any,
        suggesterPopoverRef: { value: HTMLElement | null },
        isEmbed: boolean = false,
        onSelectFile?: (file: any, isEmbed: boolean) => void
    ): void {
        // 获取所有 markdown + moc 文件
        const app = this.currentOptions?.app;
        if (!app) return;
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

                const basenameEl = item.createEl('span', { text: file.basename });
                basenameEl.style.fontWeight = '500';
                basenameEl.style.color = 'var(--text-normal)';
                const pathEl = item.createEl('span', { text: file.path });
                pathEl.style.fontSize = '11px';
                pathEl.style.color = 'var(--text-muted)';

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
                    wikiLink: buildWikiLinkForFile(file),
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
