import { App, MarkdownRenderChild, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { parseMOCJson } from "src/utils/mocJsonCodec";
import { convertMOCToZKNodes } from "src/utils/utils";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { RenderOptions } from "src/renderer/types";

const PNG_SUFFIX = '.png';

/**
 * 计算 PNG 附件路径：保存在 .moc 文件所在目录的 attachments 子目录下
 */
function getPNGPath(mocFile: TFile): string {
    const dir = mocFile.parent?.path || '';
    const pngName = mocFile.name + PNG_SUFFIX;
    return dir ? `${dir}/attachments/${pngName}` : `attachments/${pngName}`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = (error) => {
            URL.revokeObjectURL(url);
            reject(error);
        };
        img.src = url;
    });
}

function waitForImages(root: HTMLElement, timeoutMs: number = 1800): Promise<void> {
    const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
    if (imgs.length === 0) return Promise.resolve();

    const waits = imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
        });
    });

    return Promise.race([
        Promise.all(waits).then(() => undefined),
        delay(timeoutMs)
    ]);
}

async function waitForPreviewCardsReady(root: HTMLElement, timeoutMs: number = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const cards = root.querySelectorAll('.zk-embed-preview-card, .zk-image-preview-card');
        if (cards.length > 0) {
            await waitForImages(root, 1200);
            return;
        }
        await delay(120);
    }
}

function previewCardHasRenderableContent(card: Element): boolean {
    const contentEl = card.querySelector('[data-role="embed-content"]') as HTMLElement | null;
    if (!contentEl) {
        // 图片卡片无 embed-content，直接看是否有 img
        return !!card.querySelector('img');
    }

    if (contentEl.querySelector('img, svg')) return true;
    const text = (contentEl.textContent || '').trim();
    return text.length > 0;
}

async function waitForPreviewContentReady(root: HTMLElement, timeoutMs: number = 6000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const cards = Array.from(
            root.querySelectorAll('.zk-embed-preview-card, .zk-image-preview-card')
        );
        if (cards.length > 0 && cards.every(previewCardHasRenderableContent)) {
            await waitForImages(root, 1200);
            return;
        }
        await delay(150);
    }
}

function parsePx(value: string | null | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

async function drawPreviewOverlays(
    hiddenDiv: HTMLElement,
    canvas: HTMLCanvasElement,
    originX: number,
    originY: number,
    scaleX: number = 1,
    scaleY: number = 1
): Promise<void> {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cards = Array.from(
        hiddenDiv.querySelectorAll('.zk-embed-preview-card, .zk-image-preview-card')
    ) as HTMLElement[];

    for (const card of cards) {
        const style = getComputedStyle(card);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const cardRect = card.getBoundingClientRect();
        const x = (cardRect.left - originX) * scaleX;
        const y = (cardRect.top - originY) * scaleY;
        const w = cardRect.width * scaleX;
        const h = cardRect.height * scaleY;
        if (w <= 1 || h <= 1) continue;

        // 卡片背景（当前多为 transparent，这里兼容未来样式）
        const bg = style.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            ctx.fillStyle = bg;
            ctx.fillRect(x, y, w, h);
        }

        const header = card.querySelector('[data-role="embed-header"], [data-role="image-header"]') as HTMLElement | null;
        const content = card.querySelector('[data-role="embed-content"]') as HTMLElement | null;
        const headerH = (header ? header.getBoundingClientRect().height : parsePx(style.height, 0) * 0.14) * scaleY;

        if (header) {
            const hs = getComputedStyle(header);
            const hb = hs.backgroundColor;
            if (hb && hb !== 'rgba(0, 0, 0, 0)' && hb !== 'transparent') {
                ctx.fillStyle = hb;
                ctx.fillRect(x, y, w, headerH);
            }

            const label = (header.textContent || '').trim();
            if (label) {
                ctx.fillStyle = hs.color || '#cbd5e1';
                const fontSize = parsePx(hs.fontSize, 12) * Math.min(scaleX, scaleY);
                const fontWeight = hs.fontWeight || '500';
                const fontFamily = hs.fontFamily || 'sans-serif';
                ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
                ctx.textBaseline = 'middle';
                ctx.fillText(label, x + 12 * scaleX, y + headerH / 2);
            }
        }

        const contentRect = content?.getBoundingClientRect();
        const cx = contentRect ? (contentRect.left - originX) * scaleX : x;
        const cy = contentRect ? (contentRect.top - originY) * scaleY : y + headerH;
        const cw = contentRect ? contentRect.width * scaleX : w;
        const ch = contentRect ? contentRect.height * scaleY : (h - headerH);

        const img = card.querySelector('img') as HTMLImageElement | null;
        if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, cx, cy, cw, ch);
            continue;
        }

        const svg = card.querySelector('svg') as SVGElement | null;
        if (svg) {
            try {
                const serialized = new XMLSerializer().serializeToString(svg);
                const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
                const svgImage = await blobToImage(svgBlob);
                ctx.drawImage(svgImage, cx, cy, cw, ch);
            } catch {
                // ignore svg draw failures
            }
        }
    }
}

/**
 * 将 .moc 文件渲染为 PNG，返回 PNG 的 TFile
 */
async function exportMOCToPNG(mocFile: TFile, plugin: ZKNavigationPlugin): Promise<TFile> {
    const app = plugin.app;
    const pngPath = getPNGPath(mocFile);

    // 读取并解析 .moc
    const content = await app.vault.read(mocFile);
    const mocData = parseMOCJson(content, mocFile.path, app);

    // 转换为 ZKNode
    const mocNodes = await convertMOCToZKNodes(
        plugin,
        mocData.nodes,
        mocData.reverseRelations,
        [],
        mocData.nodePositions
    );

    // 构建图形数据
    const graphData = GraphDataBuilder.fromMOCTree(
        mocNodes,
        mocData.reverseRelations,
        null,
        mocData.groups,
        mocData.edgeCurvatures,
        mocData.nodeColors,
        mocData.nodeStyleColors,
        mocData.crossDomainLinks || {},
        mocData.nodePositions,
        mocData.embedNodeSizes || {},
        mocData.nodeRemarks || {},
        mocData.nodeAnchors || {}
    );

    // 创建隐藏容器（Cytoscape 需要真实 DOM）
    // 缩小尺寸加快布局计算和 PNG 导出
    const hiddenDiv = document.createElement('div');
    hiddenDiv.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:900px;height:600px;opacity:0;pointer-events:none;';
    document.body.appendChild(hiddenDiv);

    const renderer = new CytoscapeRenderer();
    let pngBytes: ArrayBuffer;

    try {
        const options: RenderOptions = {
            direction: (plugin.settings.DirectionOfBranchGraph || 'LR') as any,
            layoutType: 'dagre',
            animate: false,
            nodeText: (plugin.settings.NodeText || 'both') as any,
            themeMode: plugin.settings.themeMode,
            themeStyle: plugin.settings.themeStyle || 'modern',
            edgeStyle: plugin.settings.edgeStyle || 'bezier',
            nodeLayoutStyle: mocData.nodeLayoutStyle || 'free',
            readOnly: true,
            exportMode: false,  // 截图模式：需要渲染 embed/image overlay
        };

        await renderer.render(hiddenDiv, graphData, options);
        await delay(500);
        await waitForPreviewCardsReady(hiddenDiv, 5000);
        await waitForPreviewContentReady(hiddenDiv, 6000);
        await waitForImages(hiddenDiv);

        const cy = renderer.getCytoscapeInstance();
        if (!cy) throw new Error('Cytoscape 实例不存在');

        // 底图：先导出 Cytoscape 画布，再叠加 HTML overlay（图片/excalidraw 预览）
        const canvasBg = getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || (plugin.settings.themeMode === 'light' ? '#ffffff' : '#0f172a');
        const exportScale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
        const blob: Blob = await (cy as any).png({ output: 'blob-promise', bg: canvasBg, full: false, scale: exportScale });
        const baseImage = await blobToImage(blob);

        const composedCanvas = document.createElement('canvas');
        composedCanvas.width = baseImage.width;
        composedCanvas.height = baseImage.height;
        const composedCtx = composedCanvas.getContext('2d');
        if (!composedCtx) throw new Error('导出画布初始化失败');
        composedCtx.imageSmoothingEnabled = true;
        composedCtx.imageSmoothingQuality = 'high';
        composedCtx.drawImage(baseImage, 0, 0);

        const hostRect = hiddenDiv.getBoundingClientRect();
        const scaleX = composedCanvas.width / Math.max(1, hostRect.width);
        const scaleY = composedCanvas.height / Math.max(1, hostRect.height);
        await drawPreviewOverlays(hiddenDiv, composedCanvas, hostRect.left, hostRect.top, scaleX, scaleY);

        const composedBlob: Blob = await new Promise((resolve, reject) => {
            composedCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 合成失败'))), 'image/png');
        });
        pngBytes = await composedBlob.arrayBuffer();
    } finally {
        renderer.destroy();
        document.body.removeChild(hiddenDiv);
    }

    // 确保 attachments 目录存在
    const attachmentsDir = pngPath.substring(0, pngPath.lastIndexOf('/'));
    if (!app.vault.getAbstractFileByPath(attachmentsDir)) {
        await app.vault.createFolder(attachmentsDir);
    }

    // 写入 vault
    const existingPng = app.vault.getFileByPath(pngPath);
    if (existingPng) {
        await app.vault.modifyBinary(existingPng, pngBytes);
        return existingPng;
    } else {
        return await app.vault.createBinary(pngPath, pngBytes);
    }
}

/**
 * 确保 .moc 对应预览 PNG 可用（不存在或过期则重新生成）
 */
export async function ensureMOCPreviewPNG(mocFile: TFile, plugin: ZKNavigationPlugin): Promise<TFile> {
    const app = plugin.app;
    const pngPath = getPNGPath(mocFile);
    let pngFile = app.vault.getFileByPath(pngPath);
    if (pngNeedsUpdate(mocFile, pngFile)) {
        pngFile = await exportMOCToPNG(mocFile, plugin);
    }
    if (!pngFile) {
        throw new Error('PNG 生成失败');
    }
    return pngFile;
}

/**
 * 判断 PNG 是否需要重新生成（.moc 比 PNG 新）
 */
function pngNeedsUpdate(mocFile: TFile, pngFile: TFile | null): boolean {
    if (!pngFile) return true;
    return mocFile.stat.mtime > pngFile.stat.mtime;
}

/**
 * MarkdownRenderChild：处理 ![[xxx.moc]] 内嵌，展示为 PNG 图片
 */
export class MOCEmbedRenderChild extends MarkdownRenderChild {
    private currentImg: HTMLImageElement | null = null;
    private regenerateTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        containerEl: HTMLElement,
        private mocFile: TFile,
        private plugin: ZKNavigationPlugin
    ) {
        super(containerEl);
    }

    async onload() {
        // 立即移除 src 属性，并从 Obsidian 默认 internal-embed 点击链路中摘出，
        // 避免点击/刷新后被当作普通内嵌文件再次打开。
        this.containerEl.removeAttribute('src');
        this.containerEl.removeAttribute('alt');
        this.containerEl.removeAttribute('data-href');
        this.containerEl.classList.remove('internal-embed');
        this.containerEl.empty();
        this.containerEl.addClass('zk-moc-embed');
        this.preventDefaultOpenBehavior(this.containerEl);

        const app = this.plugin.app;
        const pngPath = getPNGPath(this.mocFile);

        try {
            let pngFile = app.vault.getFileByPath(pngPath);

            if (pngNeedsUpdate(this.mocFile, pngFile)) {
                const loading = this.containerEl.createDiv('zk-moc-embed-loading');
                loading.setText('渲染思维树...');
                pngFile = await ensureMOCPreviewPNG(this.mocFile, this.plugin);
                loading.remove();
            }

            if (!pngFile) throw new Error('PNG 生成失败');

            const img = this.containerEl.createEl('img');
            img.addClass('zk-moc-embed-img');
            img.src = app.vault.getResourcePath(pngFile);
            img.style.cssText = 'width:100%;height:auto;border-radius:6px;';
            img.alt = this.mocFile.basename;
            this.preventDefaultOpenBehavior(img);
            this.currentImg = img;
        } catch (e) {
            this.containerEl.createDiv('zk-moc-embed-error').setText(`思维树预览失败: ${e.message}`);
        }

        // 监听 .moc 文件修改，5 秒后重新生成 PNG
        this.registerEvent(
            app.vault.on('modify', (file) => {
                if (file.path === this.mocFile.path) {
                    this.scheduleRegenerate();
                }
            })
        );
    }

    onunload() {
        if (this.regenerateTimer !== null) {
            clearTimeout(this.regenerateTimer);
            this.regenerateTimer = null;
        }
    }

    private scheduleRegenerate() {
        if (this.regenerateTimer !== null) clearTimeout(this.regenerateTimer);
        this.regenerateTimer = setTimeout(async () => {
            this.regenerateTimer = null;
            try {
                const pngFile = await ensureMOCPreviewPNG(this.mocFile, this.plugin);
                if (this.currentImg) {
                    // 加时间戳破坏浏览器缓存，强制刷新图片
                    this.currentImg.src = this.plugin.app.vault.getResourcePath(pngFile) + '?t=' + Date.now();
                }
            } catch (e) {
                console.error('[zk-moc-embed] 自动重新生成失败:', e);
            }
        }, 5000);
    }

    private preventDefaultOpenBehavior(el: HTMLElement): void {
        const stop = (evt: Event) => {
            evt.preventDefault();
            evt.stopPropagation();
        };

        this.registerDomEvent(el, 'click', stop);
        this.registerDomEvent(el, 'auxclick', stop);
        this.registerDomEvent(el, 'dblclick', stop);
        this.registerDomEvent(el, 'mousedown', stop);
        this.registerDomEvent(el, 'mouseup', stop);
        this.registerDomEvent(el, 'touchend', stop);
    }
}
