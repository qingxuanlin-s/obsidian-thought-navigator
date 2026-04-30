import { App, TFile } from "obsidian";
import { toBlob } from "html-to-image";
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

function waitForImages(root: HTMLElement, timeoutMs = 1800): Promise<void> {
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

function getVisibleExportBoundingBox(cy: any): { x1: number; y1: number; w: number; h: number } {
	const visibleElements = cy.elements().filter((ele: any) => {
		if (ele.removed?.()) return false;
		if (ele.hasClass?.('zk-collapsed-hidden')) return false;
		if (ele.style?.('display') === 'none') return false;
		if (!ele.visible?.()) return false;
		if (ele.isNode?.() && ele.data?.('isPlaceholder')) return false;
		return true;
	});
	const target = visibleElements.length > 0 ? visibleElements : cy.elements();
	return target.boundingBox();
}

async function waitForPreviewCardsReady(root: HTMLElement, timeoutMs = 5000): Promise<void> {
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

async function waitForPreviewContentReady(root: HTMLElement, timeoutMs = 6000): Promise<void> {
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

	// 创建隐藏容器（Cytoscape 需要真实 DOM 才能完成布局/overlay 渲染）
	// opacity 必须保持 1，否则 html-to-image 截图全透明
	const hiddenDiv = document.createElement('div');
	hiddenDiv.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:900px;height:600px;pointer-events:none;';
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

		const cy = renderer.getCytoscapeInstance();
		if (!cy) throw new Error('Cytoscape 实例不存在');

		// 撑开容器到全图尺寸，让 cytoscape canvas + 所有 overlay 一起被截
		const bb = getVisibleExportBoundingBox(cy);
		const padding = 60;
		const maxCanvasDim = 8192;
		const exportScale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));

		const rawW = bb.w + padding * 2;
		const rawH = bb.h + padding * 2;
		let exportZoom = 1;
		const maxDim = Math.max(rawW, rawH) * exportScale;
		if (maxDim > maxCanvasDim) {
			exportZoom = maxCanvasDim / (Math.max(rawW, rawH) * exportScale);
		}

		const fullW = Math.ceil(rawW * exportZoom);
		const fullH = Math.ceil(rawH * exportZoom);

		hiddenDiv.style.width = `${fullW}px`;
		hiddenDiv.style.height = `${fullH}px`;
		cy.resize();
		cy.viewport({
			zoom: exportZoom,
			pan: { x: (-bb.x1 + padding) * exportZoom, y: (-bb.y1 + padding) * exportZoom }
		});

		// 等 overlay 重新定位 + 异步预览内容（excalidraw、markdown、图片）就绪
		await delay(300);
		await waitForPreviewCardsReady(hiddenDiv, 5000);
		await waitForPreviewContentReady(hiddenDiv, 6000);
		await waitForImages(hiddenDiv);

		const canvasBg = getComputedStyle(document.body).getPropertyValue('--background-primary').trim()
			|| (plugin.settings.themeMode === 'light' ? '#ffffff' : '#0f172a');

		// 一次截图同时拿到 cytoscape canvas 和 HTML overlay（含 markdown 富文本）
		// 关键：用 style 覆盖克隆根的定位，否则 position:fixed/left:-99999px 会被一并克隆到
		// foreignObject 里，导致内容渲染到 SVG 视口之外，结果一片纯背景色
		const blob = await toBlob(hiddenDiv, {
			pixelRatio: exportScale,
			backgroundColor: canvasBg,
			width: fullW,
			height: fullH,
			cacheBust: true,
			style: {
				position: 'static',
				left: '0',
				top: '0',
				margin: '0',
				transform: 'none',
			},
		});
		if (!blob) throw new Error('PNG 导出失败');
		pngBytes = await blob.arrayBuffer();
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
