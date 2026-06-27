import type { ElementDefinition, Position } from 'cytoscape';
import { ZKNode } from 'src/view/indexView';
import { isMocPath, stripMocSuffix, GroupInfo } from 'src/utils/utils';
import { Edge, GraphData, RenderOptions, CyData } from './types';
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
	const groups: GroupInfo[] = data.metadata.groups || [];

	const groupNodes = groups.map((group) => {
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

	nodes.forEach((node) => {
		const nodeId = (node.data as CyData).originalNode?.ID;
		if (!nodeId) return;
		const parentGroup = groups.find((g) => g.nodeIds.includes(nodeId));
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
): ElementDefinition[] {
	const currentFilePath = data?.metadata.currentFile || '';
	const nodeColors = data?.metadata.nodeColors || {};
	const nodeRemarks = data?.metadata.nodeRemarks || {};
	const nodeAnchors = data?.metadata.nodeAnchors || {};
	// 跨领域链接:不再物化为虚拟节点,而是挂在源节点上由 badge 层渲染成「出口角标」(↗)
	const crossDomainLinks = ((data?.metadata as any)?.crossDomainLinks || {}) as Record<string, any[]>;
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
		// 允许部分锁定:文本节点可能只锁宽度(高度走内容自适配),此时 height=0。
		// 嵌入节点仍需要两个维度都有值,因此调用方根据节点类型自行决定写入哪些字段。
		const manualSize = persistedSize && ((persistedSize.width || 0) > 0 || (persistedSize.height || 0) > 0)
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
		const element: ElementDefinition = {
			group: 'nodes' as const,
			data: {
				id: escapeId(node.ID),
				originalNodeId: node.IDStr || node.ID,
				label: getNodeLabel(node, options),
				badge: getNodeBadge(node, options),
				title: node.title,
				filePath: node.file?.path || '',
				displayText: node.displayText,
				// node.position 是排序序号(number),借 data.position 透传;cytoscape 的
				// ElementDataDefinition.position 类型是 Position,故 cast 保留既有行为。
				position: node.position as unknown as Position,
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
				crossDomainLinks: crossDomainLinks[node.IDStr] || crossDomainLinks[node.ID] || [],
				hasCrossDomain: (crossDomainLinks[node.IDStr] || crossDomainLinks[node.ID] || []).length > 0,
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
): ElementDefinition[] {
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
		const element: ElementDefinition = {
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

		// 跨领域边:透传链接信息 + 持久化定位键(供双击改标签写回 ext metadata)
		if ((edge as any).crossDomainLink) {
			element.data.crossDomainLink = (edge as any).crossDomainLink;
			element.data.crossDomainSourceNodeId = (edge as any).crossDomainSourceNodeId;
		}

		const key = `${edge.source}-${edge.target}`;
		const curvature = edgeControlPoints.get(key);
		if (curvature) {
			element.data.controlPointDistance = curvature.distance;
			element.data.controlPointWeight = curvature.weight;
		}

		return element;
	});
}

/**
 * 方向感知的三次贝塞尔(S 形流线)控制点。
 *
 * 目标:让层级边在父节点沿布局主轴切出、在子节点沿主轴切入(LR=水平、TB=竖直),
 * 像 org-chart / D3 linkHorizontal 那样顺滑,而不是固定垂直偏移的通用圆弧。
 *
 * 做法:在绝对坐标里定出两个三次贝塞尔控制点 C1/C2(经典 k=0.5),再换算成 Cytoscape
 * `unbundled-bezier` 的「弦上权重 weight + 法向距离 distance」表示——因为 Cytoscape 用
 * `控制点 = 弦点(weight) + 法向(-dy,dx)/L × distance` 实时重算,两者可逆且无损还原 C1/C2。
 * 需配合样式 `edge-distances: node-position`,使其法向基准取节点中心(与此处一致)。
 *
 * 返回长度 2 的数组 → 渲染为三次(双控制点)贝塞尔。
 *
 * 切向距离按 source/target 分别给:源端常是小节点、目标端常是大卡片,共用一个值(取两端较大)
 * 会让小源端被迫甩出一段长水平肩再拐弯,呈生硬肘弯。分开后各取自身半尺寸做下限,等尺寸时退化为原行为。
 *
 * targetHalfMain:目标节点在主轴上的半尺寸。自动布局把同级子节点按「近端边框」对齐(见
 * autoLayoutEngine 的 placeChildGroup),宽窄不同的兄弟近端齐、中心 x 却不齐。源端肩长若按
 * 中心距 |delta|*k 算,各边肩长就随子节点宽度漂移,在父节点旁交叉打结。改用「到目标近端边框」
 * 的距离 |delta|-targetHalfMain 来算源端肩长:近端对齐的兄弟此值恒等 ⇒ 源端控制点重合 ⇒
 * 干净的「单干再扇出」。默认 0 时退化为原中心距行为。
 */
export function computeDirectionalEdgeControlPoints(
	sx: number,
	sy: number,
	tx: number,
	ty: number,
	direction: 'LR' | 'RL' | 'TB' | 'BT',
	k = 0.5,
	minTangentSource = 12,
	minTangentTarget = minTangentSource,
	targetHalfMain = 0
): { distances: number[]; weights: number[] } {
	const dx = tx - sx;
	const dy = ty - sy;
	const L2 = dx * dx + dy * dy;
	if (L2 < 1) {
		// 端点几乎重合:退化为近直线,避免除零
		return { distances: [0, 0], weights: [0.33, 0.66] };
	}
	const L = Math.sqrt(L2);
	const horizontal = direction === 'LR' || direction === 'RL';
	// 控制点离端点的最小切向距离。两个作用:
	//  1) 节点沿主轴对齐时 dx*k(或 dy*k)趋近 0,控制点塌到端点 → 端点切线退化为 NaN,边不渲染;
	//  2) 更关键:Cytoscape 从「最后一个控制点」朝目标中心射线求节点边框交点,控制点一旦落进
	//     目标节点框内部就找不到交点("invalid endpoints",边消失)。因此下限需 ≥ 该端节点半尺寸,
	//     由调用方按 source/target 各自尺寸传入,保证控制点始终在节点外。正常间距下 |dx|*k 远大于它。
	// shrink:从主轴跨度里先扣掉的长度(源端扣 targetHalfMain → 用「到目标近端边框」的距离算肩长)。
	const axisTangent = (delta: number, flow: number, floor: number, shrink = 0): number => {
		const sign = delta !== 0 ? Math.sign(delta) : flow;
		const mag = Math.max(0, Math.abs(delta) - shrink);
		return Math.max(mag * k, floor) * sign;
	};
	let c1x: number, c1y: number, c2x: number, c2y: number;
	if (horizontal) {
		const flow = direction === 'RL' ? -1 : 1;
		c1x = sx + axisTangent(dx, flow, minTangentSource, targetHalfMain); c1y = sy;
		c2x = tx - axisTangent(dx, flow, minTangentTarget); c2y = ty;
	} else {
		const flow = direction === 'BT' ? -1 : 1;
		c1x = sx; c1y = sy + axisTangent(dy, flow, minTangentSource, targetHalfMain);
		c2x = tx; c2y = ty - axisTangent(dy, flow, minTangentTarget);
	}
	// 绝对坐标 → (weight 沿弦, distance 沿法向 (-dy,dx)/L)
	const toWD = (cx: number, cy: number): { w: number; d: number } => {
		const rx = cx - sx;
		const ry = cy - sy;
		return {
			w: (rx * dx + ry * dy) / L2,
			d: (rx * -dy + ry * dx) / L,
		};
	};
	const a = toWD(c1x, c1y);
	const b = toWD(c2x, c2y);
	return { distances: [a.d, b.d], weights: [a.w, b.w] };
}

export function getNodeLabel(node: ZKNode, options: RenderOptions | null): string {
	if (node.isTextOnly) {
		return String(node.title || node.displayText || '').replace(/\\n/g, '\n');
	}

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
	label = label || node.title || node.displayText || node.ID || '';

	label = processDisplayText(label, nodeText, showNoteId);
	return label.replace(/\\n/g, '\n');
}

export function getNodeBadge(node: ZKNode, options: RenderOptions | null): string {
	const nodeText = options?.nodeText || 'both';
	const isFreeNode = (node.ID || node.IDStr || '').startsWith('free.');
	const isLocalLinkNode = (node.ID || '').startsWith('inlink-') || (node.ID || '').startsWith('outlink-');
	const showNoteId = (options?.showNoteId ?? true) && !isFreeNode;

	if (!showNoteId || isLocalLinkNode) return '';
	// 跨领域节点的 node.ID 是合成 ID(cd-<原ID>-<MOC基名>),展示原节点 ID 更有意义。
	if (node.isCrossDomain) {
		const originalId = node.crossDomainOriginalNodeId || '';
		return (nodeText === 'id-title' || nodeText === 'both') ? originalId : '';
	}
	if (nodeText === 'id-title' || nodeText === 'both') return node.ID;
	return '';
}

export function processDisplayText(text: string, nodeText: string, showNoteId: boolean): string {
	text = String(text ?? '');
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
	// 步长 0.7 + floor 1.8:主干(root→L1)保持粗,L1→L2 起明显渐细呈锥度;但深层末梢不再
	// 细到 ~1.3px 溶进背景,保底 1.8px 仍清晰可读(配合提亮的 normal 色与次级透明度)。
	const width = rootToFirstLevelEdgeWidth - (depth - 1) * 0.7;
	return Math.max(1.8, Math.round(width * 10) / 10);
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
	const isNebula = options?.themeStyle === 'nebula';
	// Nebula 也需要分支色(左侧色条 / 1 级边框继承),与 modern 共用调色板但取更亮的 accent。
	if (!isModernThemeStyle(options) && !isNebula) return styleMap;

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
	const styleColorMap = data?.metadata.nodeStyleColors || {};
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
		if (isNebula) {
			// border 用鲜亮 accent —— 既作概念节点左侧色条,又作 1 级节点边框,继承分支色系。
			background = baseBackground;
			border = accentColor;
			shadow = hexToRgba(accentColor, 0.3);
		} else if (isLight) {
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

let _canvasMeasureCtx: CanvasRenderingContext2D | null = null;

function getCanvasCtx(): CanvasRenderingContext2D | null {
	if (_canvasMeasureCtx) return _canvasMeasureCtx;
	try {
		const canvas = activeDocument.createElement('canvas');
		_canvasMeasureCtx = canvas.getContext('2d');
	} catch { /* ignore */ }
	return _canvasMeasureCtx;
}

// 文本测宽缓存：measureText 是纯函数(同 text/fontSize/fontWeight 必得同宽),
// 但在全量渲染时会被逐节点反复调用。缓存命中可省去大量 canvas measureText 调用。
const _textWidthCache = new Map<string, number>();

export function measureTextWidthCanvas(text: string, fontSize: number, fontWeight = '500'): number {
	const cacheKey = `${fontWeight} ${fontSize} ${text}`;
	const cached = _textWidthCache.get(cacheKey);
	if (cached !== undefined) return cached;

	let width: number;
	const ctx = getCanvasCtx();
	if (ctx) {
		ctx.font = `${fontWeight} ${fontSize}px system-ui, -apple-system, sans-serif`;
		width = ctx.measureText(text).width;
	} else {
		// fallback: rough estimate
		let w = 0;
		for (const ch of text) {
			w += isCJKChar(ch) ? fontSize * 1.1 : fontSize * 0.6;
		}
		width = w;
	}

	// 防止无界增长：超过阈值清空(标签集合通常远小于此)
	if (_textWidthCache.size > 4000) _textWidthCache.clear();
	_textWidthCache.set(cacheKey, width);
	return width;
}

export function measureNodeLabel(label: string, options?: {
	baseWidth?: number;
	minHeight?: number;
	maxWidth?: number;
	fontSize?: number;
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
		lineHeight = Math.ceil((options?.fontSize ?? 20) * 1.4),
		paddingX = 32,
		paddingY = 24
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
		return new Array<string>(wrappedCount).fill(raw);
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
