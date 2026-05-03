import type { ElementDefinition } from 'cytoscape';
import { ZKNode } from 'src/view/indexView';
import { isMocPath, stripMocSuffix } from 'src/utils/utils';
import { Edge, GraphData, RenderOptions } from './types';
import {
	getBranchStylePalette,
	hashString,
	hexToRgba,
	isModernThemeStyle,
	lightenColor,
	normalizeHexColor,
	softenColor,
} from './colorUtils';

export type NodeBranchStyle = { background: string; border: string; shadow: string };

export type EdgeControlPoint = { distance: number; weight: number };

export type ElementConversionContext = {
	nodeStyleMap: Map<string, NodeBranchStyle>;
	nodeById: Map<string, ZKNode>;
	parentLinkedNodeIds: Set<string>;
};

export interface ElementConversionOptions {
	options: RenderOptions | null;
	edgeControlPoints: Map<string, EdgeControlPoint>;
	rootToFirstLevelEdgeWidth: number;
}

function compareIds(id1: string, id2: string): number {
	const parts1 = id1.split('.');
	const parts2 = id2.split('.');
	const maxLength = Math.max(parts1.length, parts2.length);

	for (let i = 0; i < maxLength; i++) {
		const p1 = parts1[i];
		const p2 = parts2[i];
		if (p1 !== undefined && p2 === undefined) return 1;
		if (p1 === undefined && p2 !== undefined) return -1;
		const cmp = p1.localeCompare(p2, undefined, { numeric: true, sensitivity: 'base' });
		if (cmp !== 0) return cmp > 0 ? 1 : -1;
	}

	return 0;
}

export function convertToElementsWithGroups(data: GraphData, conversionOptions: ElementConversionOptions): ElementDefinition[] {
	const parentLinkedNodeIds = loadEdgeControlPointsAndParentLinks(data, conversionOptions.edgeControlPoints);
	const context = buildElementConversionContext(data, conversionOptions.options, parentLinkedNodeIds);
	const nodes = convertNodesToElements(data.nodes, data, conversionOptions.options, context);
	const edges = convertEdgesToElements(data.edges, context, conversionOptions.edgeControlPoints, conversionOptions.rootToFirstLevelEdgeWidth);
	const groups = (data.metadata as any)?.groups || [];

	const groupNodes = groups.map((group: any) => {
		return {
			group: 'nodes' as const,
			data: {
				id: group.id,
				originalNodeId: group.id,
				label: group.label,
				isGroup: true,
				nodeIds: group.nodeIds || []
			},
			classes: 'group-node'
		};
	});

	nodes.forEach((node: any) => {
		const nodeId = node.data.originalNode?.ID;
		if (!nodeId) return;
		const parentGroup = groups.find((g: any) => g.nodeIds.includes(nodeId));
		if (parentGroup) {
			node.data.parent = parentGroup.id;
		}
	});

	return [...groupNodes, ...nodes, ...edges];
}

export function convertToElements(data: GraphData, conversionOptions: ElementConversionOptions): ElementDefinition[] {
	const parentLinkedNodeIds = loadEdgeControlPointsAndParentLinks(data, conversionOptions.edgeControlPoints);
	const context = buildElementConversionContext(data, conversionOptions.options, parentLinkedNodeIds);
	const nodes = convertNodesToElements(data.nodes, data, conversionOptions.options, context);
	const edges = convertEdgesToElements(data.edges, context, conversionOptions.edgeControlPoints, conversionOptions.rootToFirstLevelEdgeWidth);
	return [...nodes, ...edges];
}

export function convertNodesToElements(
	nodes: ZKNode[],
	data: GraphData | null,
	options: RenderOptions | null,
	context?: ElementConversionContext
): any[] {
	const currentFilePath = data?.metadata.currentFile || '';
	const nodeColors = data?.metadata.nodeColors || {};
	const nodeRemarks = data?.metadata.nodeRemarks || {};
	const nodeAnchors = data?.metadata.nodeAnchors || {};
	const embedNodeSizes = ((data?.metadata as any)?.embedNodeSizes || {}) as Record<string, { width: number; height: number }>;
	const resolvedContext = context || buildElementConversionContext(data, options);
	const vividStyleMap = resolvedContext.nodeStyleMap;
	const parentLinkedNodeIds = resolvedContext.parentLinkedNodeIds;

	return nodes.map(node => {
		const vividStyle = vividStyleMap.get(node.IDStr);
		const hasParentChildLink = parentLinkedNodeIds.has(node.ID) || parentLinkedNodeIds.has(node.IDStr);
		const isFirstLevelNode = isDirectChildOfRootNode(node, resolvedContext.nodeById);
		const firstLevelBranchNode = getFirstLevelBranchNode(node, resolvedContext.nodeById);
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
		let customFillTextColor: string | null = null;
		if (customFillColor) {
			const nc = normalizeHexColor(customFillColor);
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
				id: escapeId(node.ID),
				originalNodeId: node.IDStr || node.ID,
				label: getNodeLabel(node, options),
				badge: getNodeBadge(node, options),
				title: node.title,
				filePath: node.file?.path || '',
				displayText: node.displayText,
				position: node.position,
				isCurrentFile: node.file?.path === currentFilePath,
				originalNode: node,
				isRoot: node.isRoot || false,
				isFirstLevelNode,
				firstLevelBranchId: firstLevelBranchNode?.ID || firstLevelBranchNode?.IDStr || '',
				customColor: rawCustomColor,
				customFillColor,
				customFillTextColor,
				hasCustomColor: hasLegacyCustomColor,
				isCrossDomain: node.isCrossDomain || false,
				isTextOnly: node.isTextOnly || false,
				isStandaloneText: (node.isTextOnly || false) && !hasParentChildLink && !node.isRoot,
				isEmbed: node.isEmbed || false,
				isInlink: (node.ID || '').startsWith('inlink-'),
				isOutlink: (node.ID || '').startsWith('outlink-'),
				isFreeNode: (node.ID || '').startsWith('free.'),
				remark: nodeRemarks[node.IDStr] || nodeRemarks[node.ID] || '',
				hasRemark: !!(nodeRemarks[node.IDStr] || nodeRemarks[node.ID]),
				isAnchor: !!(nodeAnchors[node.IDStr] || nodeAnchors[node.ID]),
				hasFileIcon: (!node.isTextOnly && node.file) ? true : false,
				manualWidthModel: manualSize?.width || null,
				manualHeightModel: manualSize?.height || null,
				branchNodeBackground: vividStyle?.background || null,
				branchNodeBorder: vividStyle?.border || null,
				branchNodeShadow: vividStyle?.shadow || null
			}
		};

		if (node.savedPosition) {
			element.position = {
				x: node.savedPosition.x,
				y: node.savedPosition.y
			};
		}

		return element;
	});
}

export function convertEdgesToElements(
	edges: Edge[],
	context: ElementConversionContext,
	edgeControlPoints: Map<string, EdgeControlPoint>,
	rootToFirstLevelEdgeWidth: number
): any[] {
	const nodeById = context.nodeById;
	const nodeStyleMap = context.nodeStyleMap;

	return edges.map(edge => {
		const sourceNode = nodeById.get(edge.source);
		const targetNode = nodeById.get(edge.target);
		const targetIdStr = targetNode?.IDStr || targetNode?.ID || '';
		const isRootToFirstLevel =
			!!sourceNode &&
			!!targetNode &&
			!!sourceNode.isRoot &&
			isDirectChildOfRootNode(targetNode, nodeById) &&
			targetIdStr.substring(0, targetIdStr.lastIndexOf('.')) === sourceNode.IDStr;

		let branchEdgeColor = nodeStyleMap.get(edge.source)?.border || null;
		if (isRootToFirstLevel && targetNode) {
			branchEdgeColor = nodeStyleMap.get(targetNode.IDStr)?.border || branchEdgeColor;
		}
		const hierarchyDepth = targetNode
			? getDepthFromNearestRoot(targetNode.IDStr, nodeById)
			: null;
		const hierarchyEdgeWidth = edge.type === 'parent'
			? getHierarchyEdgeWidth(hierarchyDepth, rootToFirstLevelEdgeWidth)
			: null;
		const element: any = {
			group: 'edges' as const,
			data: {
				id: escapeId(edge.id),
				source: escapeId(edge.source),
				target: escapeId(edge.target),
				label: edge.label || '',
				type: edge.type,
				originalSource: edge.source,
				originalTarget: edge.target,
				branchEdgeColor,
				isRootToFirstLevel,
				hierarchyEdgeWidth
			}
		};

		const key = `${edge.source}-${edge.target}`;
		const curvature = edgeControlPoints.get(key);
		if (curvature) {
			element.data.controlPointDistance = curvature.distance;
			element.data.controlPointWeight = curvature.weight;
		}

		return element;
	});
}

export function getNodeLabel(node: ZKNode, options: RenderOptions | null): string {
	const nodeText = options?.nodeText || 'both';
	const isFreeNode = (node.ID || node.IDStr || '').startsWith('free.');
	const isLocalLinkNode = (node.ID || '').startsWith('inlink-') || (node.ID || '').startsWith('outlink-');
	const showNoteId = (options?.showNoteId ?? true) && !isFreeNode;

	if (isLocalLinkNode) {
		return processDisplayText(
			node.title || node.displayText || node.file?.basename || '',
			'title',
			false
		).replace(/\\n/g, '\n');
	}

	let label = '';
	switch (nodeText) {
		case 'id':
			label = showNoteId ? node.ID : (node.title || node.displayText);
			break;
		case 'title':
			label = node.title || node.displayText;
			break;
		case 'id-title':
			label = node.title || node.displayText;
			break;
		case 'both':
		default:
			label = showNoteId ? node.displayText : (node.title || node.displayText);
			break;
	}

	label = processDisplayText(label, nodeText, showNoteId);
	return label.replace(/\\n/g, '\n');
}

export function getNodeBadge(node: ZKNode, options: RenderOptions | null): string {
	const nodeText = options?.nodeText || 'both';
	const isFreeNode = (node.ID || node.IDStr || '').startsWith('free.');
	const isLocalLinkNode = (node.ID || '').startsWith('inlink-') || (node.ID || '').startsWith('outlink-');
	const showNoteId = (options?.showNoteId ?? true) && !isFreeNode;

	if (!showNoteId || isLocalLinkNode) return '';
	if (nodeText === 'id-title' || nodeText === 'both') return node.ID;
	return '';
}

export function processDisplayText(text: string, nodeText: string, showNoteId: boolean): string {
	if (!showNoteId) {
		return text
			.replace(/^[a-zA-Z0-9._]+(?::\s*|\s+)/, '')
			.replace(/^\d+\s+/, '');
	}

	if (nodeText === 'id-title') {
		return text
			.replace(/^[a-zA-Z0-9._]+(?::\s*|\s+)/, '')
			.replace(/^\d+\s+/, '');
	} else if (nodeText === 'title' || nodeText === 'both') {
		return text.replace(/^\d+\s+/, '');
	}

	return text;
}

export function escapeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function buildWikiLinkForFile(file: any): string {
	const path = String(file?.path || '').trim();
	const name = String(file?.name || '').trim();
	const basename = String(file?.basename || '').trim();

	if (isMocPath(path) || isMocPath(name)) {
		return name || basename;
	}

	return basename || name || path;
}

export function getMocPreviewPngCandidates(mocFilePath: string): string[] {
	const normalized = String(mocFilePath || '').trim();
	if (!isMocPath(normalized)) return [];

	const dir = normalized.includes('/') ? normalized.substring(0, normalized.lastIndexOf('/')) : '';
	const mocFileName = normalized.includes('/') ? normalized.substring(normalized.lastIndexOf('/') + 1) : normalized;
	const mocBasename = stripMocSuffix(mocFileName);

	return Array.from(new Set([
		dir ? `${dir}/attachments/${mocFileName}.png` : `attachments/${mocFileName}.png`,
		dir ? `${dir}/attachments/${mocBasename}.png` : `attachments/${mocBasename}.png`
	]));
}

export function getTopBranchId(nodeId: string): string {
	const parts = (nodeId || '').split('.').filter(Boolean);
	if (parts.length <= 1) return nodeId;
	return `${parts[0]}.${parts[1]}`;
}

export function isDirectChildOfRootNode(node: ZKNode, nodeMap: Map<string, ZKNode>): boolean {
	const nodeId = (node.IDStr || node.ID || '').trim();
	if (!nodeId.includes('.')) return false;

	const parentId = nodeId.substring(0, nodeId.lastIndexOf('.'));
	const parentNode = nodeMap.get(parentId);
	return !!parentNode?.isRoot && parentNode.IDStr === parentId;
}

export function getFirstLevelBranchNode(node: ZKNode, nodeMap: Map<string, ZKNode>): ZKNode | null {
	let currentId = (node.IDStr || node.ID || '').trim();
	while (currentId.includes('.')) {
		const currentNode = nodeMap.get(currentId);
		if (currentNode && isDirectChildOfRootNode(currentNode, nodeMap)) {
			return currentNode;
		}
		currentId = currentId.substring(0, currentId.lastIndexOf('.'));
	}
	return null;
}

export function getDepthFromNearestRoot(nodeId: string, nodeMap: Map<string, ZKNode>): number {
	const normalizedId = (nodeId || '').trim();
	if (!normalizedId) return 1;
	let current = normalizedId;
	let depth = 0;
	while (current.includes('.')) {
		const parentId = current.substring(0, current.lastIndexOf('.'));
		depth += 1;
		const parentNode = nodeMap.get(parentId);
		if (parentNode?.isRoot && parentNode.IDStr === parentId) return depth;
		current = parentId;
	}
	return Math.max(1, normalizedId.split('.').filter(Boolean).length - 1);
}

export function getHierarchyEdgeWidth(depthFromRoot: number | null, rootToFirstLevelEdgeWidth: number): number {
	const depth = Math.max(1, depthFromRoot || 1);
	const width = rootToFirstLevelEdgeWidth - (depth - 1) * 0.55;
	return Math.max(1.6, Math.round(width * 10) / 10);
}

export function loadEdgeControlPointsAndParentLinks(
	data: GraphData,
	edgeControlPoints: Map<string, EdgeControlPoint>
): Set<string> {
	edgeControlPoints.clear();
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
			edgeControlPoints.set(key, curvature);
		}
	});

	return parentLinkedNodeIds;
}

export function buildElementConversionContext(
	data: GraphData | null,
	options: RenderOptions | null,
	parentLinkedNodeIds?: Set<string>
): ElementConversionContext {
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
		nodeStyleMap: buildVividNodeStyleMap(allNodes, data, options),
		nodeById,
		parentLinkedNodeIds: resolvedParentLinkedNodeIds
	};
}

export function buildVividNodeStyleMap(
	nodes: ZKNode[],
	data: GraphData | null,
	options: RenderOptions | null
): Map<string, NodeBranchStyle> {
	const styleMap = new Map<string, NodeBranchStyle>();
	if (!isModernThemeStyle(options)) return styleMap;

	const branchIds = Array.from(
		new Set(
			nodes
				.filter((node) => !node.isRoot)
				.map((node) => getTopBranchId(node.IDStr))
				.filter(Boolean)
		)
	).sort(compareIds);

	const isLight = options?.themeMode === 'light';
	const branchColorById = new Map<string, NodeBranchStyle>();
	const styleColorMap = (data?.metadata as any)?.nodeStyleColors || {};
	const palette = getBranchStylePalette();
	branchIds.forEach((branchId) => {
		const storedColor = normalizeHexColor(styleColorMap[branchId]);
		const paletteColor = palette[hashString(branchId) % palette.length];
		const baseBackground = storedColor || paletteColor.background;
		const accentColor = storedColor
			? lightenColor(baseBackground, isLight ? 0.10 : 0.22)
			: paletteColor.accent;
		let background: string;
		let border: string;
		let shadow: string;
		if (isLight) {
			border = softenColor(accentColor, true);
			background = hexToRgba(border, 0.12);
			shadow = 'transparent';
		} else {
			background = baseBackground;
			border = lightenColor(baseBackground, 0.12);
			shadow = hexToRgba(baseBackground, 0.22);
		}
		branchColorById.set(branchId, { background, border, shadow });
	});

	nodes.forEach((node) => {
		if (node.isRoot) return;
		const branchId = getTopBranchId(node.IDStr);
		const style = branchColorById.get(branchId);
		if (style) styleMap.set(node.IDStr, style);
	});

	return styleMap;
}

export function measureNodeLabel(label: string, options?: {
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

	const estimateTextWidth = (text: string): number => {
		let w = 0;
		for (const ch of text) {
			w += isCJKChar(ch) ? charWidth * 2 : charWidth;
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

export function compensateFreeLikeNodeFrameSize(
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
	const lineCount = estimateWrappedLines(label, { maxWidth, charWidth }).length;
	const minVisualWidth = lineCount <= 1 ? 136 : 152;
	const width = Math.max(measured.width, minVisualWidth);
	const minVisualHeight = 80;
	const height = Math.max(measured.height, minVisualHeight);

	return {
		width: Math.round(width),
		height: Math.round(height)
	};
}

export function estimateWrappedLines(label: string, options?: {
	maxWidth?: number;
	charWidth?: number;
}): string[] {
	const {
		maxWidth = 220,
		charWidth = 8
	} = options || {};

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

function isCJKChar(ch: string): boolean {
	const code = ch.codePointAt(0) || 0;
	return (code >= 0x4E00 && code <= 0x9FFF) ||
		(code >= 0x3000 && code <= 0x303F) ||
		(code >= 0xFF00 && code <= 0xFFEF) ||
		(code >= 0x3400 && code <= 0x4DBF) ||
		(code >= 0x20000 && code <= 0x2A6DF);
}
