import type * as cytoscape from 'cytoscape';
import type { ZKNode } from 'src/view/indexView';

export interface PasteTarget {
	x: number;
	y: number;
	align: 'left' | 'center';
}

/** Prefer source content over labels that may include a generated node ID. */
export function getNodeClipboardContent(node: Pick<ZKNode, 'title' | 'displayText' | 'wikiLink' | 'ID' | 'IDStr'>): string {
	if (node.title) return node.title.trim();
	if (node.wikiLink) return node.wikiLink.trim();
	let text = (node.displayText || '').trim();
	for (const id of [node.ID, node.IDStr]) {
		if (!id) continue;
		if (text === id) return '';
		if (text.startsWith(`${id}: `)) text = text.slice(id.length + 2).trim();
	}
	return text;
}

/** Model coordinates: right edge of the selection, or the current viewport center. */
export function getPasteTarget(cy: cytoscape.Core | null | undefined): PasteTarget {
	if (!cy) return { x: 0, y: 0, align: 'center' };
	const selected = cy.nodes(':selected').filter('[!isGroup][!isPlaceholder]');
	if (selected.length > 0) {
		const bb = selected.boundingBox({ includeLabels: false, includeOverlays: false });
		return { x: bb.x2 + 60, y: (bb.y1 + bb.y2) / 2, align: 'left' };
	}
	const pan = cy.pan();
	const zoom = cy.zoom();
	return {
		x: (cy.width() / 2 - pan.x) / zoom,
		y: (cy.height() / 2 - pan.y) / zoom,
		align: 'center',
	};
}

export function getPasteTranslation(bb: { x1: number; x2: number; y1: number; y2: number }, target: PasteTarget): { x: number; y: number } {
	return {
		x: target.x - (target.align === 'left' ? bb.x1 : (bb.x1 + bb.x2) / 2),
		y: target.y - (bb.y1 + bb.y2) / 2,
	};
}
