import type { MOCParseResult, MOCTreeNode } from './utils';
import { computeAutoLayout, AutoLayoutNodeInput } from './autoLayoutEngine';
import { NodeLayoutIntent, Vec2, LayoutPreset, PRESET_POOL, normalizeLayoutPreset, quantizeToPool, stackAxisOf } from './growthDirection';
import { NODE_FLAG_SEPARATED, NODE_FLAG_SIDE_PINNED } from './nodeFlags';

type LayoutData = Pick<MOCParseResult, 'nodes' | 'nodePositions' | 'nodeLayoutStyle' | 'nodeLayoutOverrides' | 'layoutPreset' | 'nodeLayoutPresets'>
	& Partial<Pick<MOCParseResult, 'nodeColors' | 'nodeStyleColors'>>;

export function getMOCLayoutContext(data: LayoutData) {
	const nodes = new Map<string, MOCTreeNode>();
	const parents: Record<string, string | undefined> = {};
	const auto = new Set<string>();
	const presets: Record<string, LayoutPreset> = {};
	const intents: Record<string, NodeLayoutIntent> = {};
	const roots = new Set(data.nodes.map(node => node.nodeID));
	const walk = (list: MOCTreeNode[], parent: string | undefined, style: 'auto' | 'free', preset: LayoutPreset) => {
		for (const node of list) {
			const id = node.nodeID;
			const effective = data.nodeLayoutOverrides?.[id] || style;
			const branchPreset = parent && roots.has(parent)
				? normalizeLayoutPreset(data.nodeLayoutPresets?.[id], preset) : preset;
			nodes.set(id, node);
			parents[id] = parent;
			presets[id] = branchPreset;
			intents[id] = { ...node.layout };
			if (effective === 'auto' && !id.startsWith('free.')) auto.add(id);
			walk(node.children || [], id, effective, branchPreset);
		}
	};
	walk(data.nodes, undefined, data.nodeLayoutStyle === 'auto' ? 'auto' : 'free', normalizeLayoutPreset(data.layoutPreset));
	return { nodes, parents, auto, presets, intents, roots };
}

/** 从旧文件坐标或本次交互的内存坐标提取方向/顺序，再过滤计算出来的自动坐标。 */
export function normalizeMOCLayout<T extends LayoutData>(data: T): T {
	const clone = (nodes: MOCTreeNode[]): MOCTreeNode[] => nodes.map(node => ({
		...node, layout: { ...node.layout }, children: clone(node.children || []),
	}));
	const next = { ...data, nodes: clone(data.nodes), nodePositions: { ...data.nodePositions } };
	const context = getMOCLayoutContext(next);
	const { nodes, parents, auto, presets, roots } = context;
	const positions = data.nodePositions || {};
	for (const [id, node] of nodes) {
		const parentId = parents[id];
		const p = positions[id];
		const parent = parentId ? positions[parentId] : undefined;
		const separated = !!((node.extBitMap || 0) & NODE_FLAG_SEPARATED);
		if (auto.has(id) && parentId) {
			const pool = PRESET_POOL[presets[id]];
			const inherited = nodes.get(parentId)?.layout?.direction;
			node.layout!.direction = p && parent && (p.x !== parent.x || p.y !== parent.y)
				? quantizeToPool(p.x - parent.x, p.y - parent.y, pool)
				: quantizeToPool(...directionVector(node.layout?.direction || inherited || pool[0]), pool);
			delete node.layout!.offset;
		} else if (!auto.has(id) && parentId && auto.has(parentId) && !separated) {
			if (p && parent) node.layout!.offset = { x: p.x - parent.x, y: p.y - parent.y };
		} else {
			delete node.layout!.offset;
		}
		if (auto.has(id) && parentId && !separated) delete next.nodePositions[id];
		if (roots.has(id) && !next.nodePositions[id]) next.nodePositions[id] = { x: 0, y: data.nodes.findIndex(node => node.nodeID === id) * 300 };
	}
	for (const parent of nodes.values()) {
		const groups = new Map<string, MOCTreeNode[]>();
		for (const child of parent.children || []) {
			if (!auto.has(child.nodeID)) continue;
			const direction = child.layout!.direction!;
			const list = groups.get(direction) || [];
			list.push(child);
			groups.set(direction, list);
		}
		for (const siblings of groups.values()) {
			const preset = presets[siblings[0].nodeID];
			const axis = preset === 'bidirectional' ? { x: 0, y: 1 }
				: preset === 'top-down' ? { x: 1, y: 0 } : stackAxisOf(siblings[0].layout!.direction!);
			// 部分位置快照不能与 order 混用不同单位。缺少完整快照时沿用已有顺序。
			const canSortPositions = siblings.every(node => !!positions[node.nodeID]);
			const rank = (node: MOCTreeNode) => canSortPositions
				? positions[node.nodeID].x * axis.x + positions[node.nodeID].y * axis.y
				: node.layout?.order ?? parent.children.indexOf(node);
			siblings.sort((a, b) => rank(a) - rank(b));
			siblings.forEach((node, index) => { node.layout!.order = index; });
		}
	}
	return next;
}

function directionVector(direction: string): [number, number] {
	const x = direction.includes('E') ? 1 : direction.includes('W') ? -1 : 0;
	const y = direction.includes('S') ? 1 : direction.includes('N') ? -1 : 0;
	return [x, y];
}

/** 屏幕与 PNG 导出共用：每次根据实际尺寸计算自动位置，坐标仅在内存中存在。 */
export function computeMOCLayout(
	data: LayoutData,
	sizes: Record<string, { width: number; height: number }>,
	currentPositions: Record<string, Vec2> = {},
	hiddenIds: Set<string> = new Set()
): Record<string, Vec2> {
	const { nodes: tree, parents, auto, intents, roots } = getMOCLayoutContext(data);
	const positions: Record<string, Vec2> = { ...currentPositions, ...data.nodePositions };
	const nodes: Record<string, AutoLayoutNodeInput> = {};
	const childrenById: Record<string, string[]> = {};
	const sidePinnedIds = new Set<string>();
	for (const [id, node] of tree) {
		if (hiddenIds.has(id) || !sizes[id]) continue;
		nodes[id] = { id, size: sizes[id], position: positions[id] || { x: 0, y: 0 }, colorKey: dataColor(data, id) };
		childrenById[id] = (node.children || []).filter(child => auto.has(child.nodeID)
			&& !((child.extBitMap || 0) & NODE_FLAG_SEPARATED)
			&& !hiddenIds.has(child.nodeID) && !!sizes[child.nodeID]).map(child => child.nodeID);
		if (((node.extBitMap || 0) & NODE_FLAG_SIDE_PINNED) || (parents[id] && !auto.has(parents[id]!))) sidePinnedIds.add(id);
	}
	const visit = (node: MOCTreeNode, covered: boolean) => {
		const id = node.nodeID;
		if (!nodes[id]) return;
		const separated = !!((node.extBitMap || 0) & NODE_FLAG_SEPARATED);
		const anchored = roots.has(id) || !auto.has(id) || separated;
		const parentId = parents[id];
		if (!auto.has(id) && parentId && auto.has(parentId) && !separated && node.layout?.offset && positions[parentId]) {
			const previous = positions[id] || nodes[id].position;
			const next = { x: positions[parentId].x + node.layout.offset.x, y: positions[parentId].y + node.layout.offset.y };
			const dx = next.x - previous.x;
			const dy = next.y - previous.y;
			const translate = (branch: MOCTreeNode) => {
				const p = positions[branch.nodeID];
				if (p) positions[branch.nodeID] = { x: p.x + dx, y: p.y + dy };
				for (const child of branch.children || []) translate(child);
			};
			translate(node);
			positions[id] = next;
		}
		if (anchored || !covered) {
			nodes[id].position = positions[id] || { x: 0, y: 0 };
			Object.assign(positions, computeAutoLayout({
				relayoutRootId: id, nodes, parentById: parents, childrenById,
				realMocRootIds: roots, nodePositions: data.nodePositions || {},
				nodeLayoutIntents: intents, sidePinnedIds,
				ignoreSavedPositionsForIds: auto,
				layoutPreset: data.layoutPreset, nodeLayoutPresets: data.nodeLayoutPresets,
			}));
		}
		for (const child of node.children || []) visit(child, true);
	};
	for (const root of data.nodes) visit(root, false);
	return positions;
}

function dataColor(data: LayoutData, id: string): string {
	return data.nodeColors?.[id] || data.nodeStyleColors?.[id] || '__default__';
}
