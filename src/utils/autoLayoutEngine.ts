import {
	DEFAULT_LAYOUT_PRESET,
	DIR_VECTORS,
	GrowthDirection,
	LayoutPreset,
	PRESET_POOL,
	Vec2,
	normalizeLayoutPreset,
	projectSize,
	quantizeToPool,
	stackAxisOf,
} from "src/utils/growthDirection";

export interface AutoLayoutNodeInput {
	id: string;
	size: { width: number; height: number };
	position: Vec2;
	colorKey: string;
}

export interface ComputeAutoLayoutInput {
	relayoutRootId: string;
	nodes: Record<string, AutoLayoutNodeInput>;
	parentById: Record<string, string | undefined>;
	childrenById: Record<string, string[]>;
	realMocRootIds: Set<string>;
	nodePositions: Record<string, Vec2>;
	layoutPreset?: LayoutPreset;
	nodeLayoutPresets?: Record<string, LayoutPreset>;
	forwardGap?: number;
	stackGap?: number;
}

interface LayoutNode {
	id: string;
	size: { width: number; height: number };
	dir: GrowthDirection | null;
	stackAxis: Vec2 | null;
	groupChildren: boolean;
	children: LayoutNode[];
	subtreeSpan: number;
}

const DIAGONAL_GAP_FACTOR = 1.2;

export function computeAutoLayout(input: ComputeAutoLayoutInput): Record<string, Vec2> {
	const forwardGap = input.forwardGap ?? 150;
	const stackGap = input.stackGap ?? 56;
	const positions: Record<string, Vec2> = {};
	const filePreset = normalizeLayoutPreset(input.layoutPreset, DEFAULT_LAYOUT_PRESET);
	const branchPresetCache = new Map<string, LayoutPreset>();
	const directionCache = new Map<string, GrowthDirection | null>();

	const isBranchStart = (nodeId: string): boolean => {
		const parentId = input.parentById[nodeId];
		return !!parentId && input.realMocRootIds.has(parentId);
	};

	const getBranchPreset = (nodeId: string): LayoutPreset => {
		const cached = branchPresetCache.get(nodeId);
		if (cached) return cached;

		const parentId = input.parentById[nodeId];
		let preset: LayoutPreset;
		if (!parentId || input.realMocRootIds.has(nodeId)) {
			preset = filePreset;
		} else if (input.realMocRootIds.has(parentId)) {
			preset = normalizeLayoutPreset(input.nodeLayoutPresets?.[nodeId], filePreset);
		} else {
			preset = getBranchPreset(parentId);
		}
		branchPresetCache.set(nodeId, preset);
		return preset;
	};

	const resolveFromPool = (nodeId: string, parentId: string, preset: LayoutPreset): GrowthDirection => {
		const pool = PRESET_POOL[preset];
		const savedPos = input.nodePositions[nodeId];
		const parentPos = input.nodePositions[parentId] || input.nodes[parentId]?.position;
		if (savedPos && parentPos) {
			return quantizeToPool(savedPos.x - parentPos.x, savedPos.y - parentPos.y, pool);
		}
		const siblings = input.childrenById[parentId] || [];
		const index = Math.max(0, siblings.indexOf(nodeId));
		return pool[index % pool.length];
	};

	const getDirection = (nodeId: string): GrowthDirection | null => {
		if (directionCache.has(nodeId)) {
			return directionCache.get(nodeId) ?? null;
		}
		if (input.realMocRootIds.has(nodeId)) {
			directionCache.set(nodeId, null);
			return null;
		}

		const parentId = input.parentById[nodeId];
		const parent = parentId ? input.nodes[parentId] : undefined;
		if (!parentId || !parent) {
			directionCache.set(nodeId, 'E');
			return 'E';
		}

		let direction: GrowthDirection;
		if (input.realMocRootIds.has(parentId)) {
			direction = resolveFromPool(nodeId, parentId, filePreset);
		} else if (isBranchStart(parentId)) {
			direction = resolveFromPool(nodeId, parentId, getBranchPreset(parentId));
		} else {
			direction = getDirection(parentId) || PRESET_POOL[getBranchPreset(parentId)][0];
		}

		directionCache.set(nodeId, direction);
		return direction;
	};

	const sortChildren = (children: string[], axis: Vec2, center: Vec2): string[] => {
		const sorted = [...children].sort((a, b) => {
			const ap = input.nodes[a].position;
			const bp = input.nodes[b].position;
			const aproj = (ap.x - center.x) * axis.x + (ap.y - center.y) * axis.y;
			const bproj = (bp.x - center.x) * axis.x + (bp.y - center.y) * axis.y;
			return aproj - bproj;
		});

		const colorOrder = new Map<string, number>();
		for (const childId of sorted) {
			const colorKey = input.nodes[childId].colorKey;
			if (!colorOrder.has(colorKey)) {
				colorOrder.set(colorKey, colorOrder.size);
			}
		}

		return sorted.sort((a, b) => {
			const colorRankA = colorOrder.get(input.nodes[a].colorKey) ?? Number.MAX_SAFE_INTEGER;
			const colorRankB = colorOrder.get(input.nodes[b].colorKey) ?? Number.MAX_SAFE_INTEGER;
			if (colorRankA !== colorRankB) return colorRankA - colorRankB;
			const ap = input.nodes[a].position;
			const bp = input.nodes[b].position;
			const aproj = (ap.x - center.x) * axis.x + (ap.y - center.y) * axis.y;
			const bproj = (bp.x - center.x) * axis.x + (bp.y - center.y) * axis.y;
			return aproj - bproj;
		});
	};

	const buildLayout = (nodeId: string): LayoutNode => {
		const node = input.nodes[nodeId];
		const dir = getDirection(nodeId);
		const stackAxis = dir ? stackAxisOf(dir) : null;
		const groupChildren = input.realMocRootIds.has(nodeId) || isBranchStart(nodeId);
		const childAxis = stackAxis || { x: 0, y: 1 };
		const childIds = sortChildren(input.childrenById[nodeId] || [], childAxis, node.position);
		const children = childIds.map((childId) => buildLayout(childId));
		const childrenSpan = children.reduce((sum, child) => sum + child.subtreeSpan, 0)
			+ Math.max(0, children.length - 1) * stackGap;
		const selfSpan = stackAxis ? projectSize(node.size, stackAxis) : projectSize(node.size, childAxis);
		return {
			id: nodeId,
			size: node.size,
			dir,
			stackAxis,
			groupChildren,
			children,
			subtreeSpan: Math.max(selfSpan, childrenSpan),
		};
	};

	const avgProjection = (children: LayoutNode[], axis: Vec2): number => {
		if (children.length === 0) return 0;
		return children.reduce((sum, child) => sum + projectSize(child.size, axis), 0) / children.length;
	};

	const gapFor = (dir: GrowthDirection): number => {
		return dir.length === 2 ? forwardGap * DIAGONAL_GAP_FACTOR : forwardGap;
	};

	const placeDirectedChildren = (layout: LayoutNode, cx: number, cy: number) => {
		if (!layout.dir || !layout.stackAxis) return;
		const dirVec = DIR_VECTORS[layout.dir];
		const axis = layout.stackAxis;
		const forward = projectSize(layout.size, dirVec) / 2
			+ gapFor(layout.dir)
			+ avgProjection(layout.children, dirVec) / 2;
		const total = layout.children.reduce((sum, child) => sum + child.subtreeSpan, 0)
			+ Math.max(0, layout.children.length - 1) * stackGap;
		let cursor = -total / 2;

		for (const child of layout.children) {
			const stackOff = cursor + child.subtreeSpan / 2;
			placeLayout(
				child,
				cx + dirVec.x * forward + axis.x * stackOff,
				cy + dirVec.y * forward + axis.y * stackOff
			);
			cursor += child.subtreeSpan + stackGap;
		}
	};

	const placeRootGrouped = (layout: LayoutNode, cx: number, cy: number) => {
		const groups = new Map<GrowthDirection, LayoutNode[]>();
		for (const child of layout.children) {
			if (!child.dir) continue;
			const group = groups.get(child.dir) || [];
			group.push(child);
			groups.set(child.dir, group);
		}

		for (const [dir, children] of groups.entries()) {
			const dirVec = DIR_VECTORS[dir];
			const axis = stackAxisOf(dir);
			const forward = projectSize(layout.size, dirVec) / 2
				+ gapFor(dir)
				+ avgProjection(children, dirVec) / 2;
			const total = children.reduce((sum, child) => sum + child.subtreeSpan, 0)
				+ Math.max(0, children.length - 1) * stackGap;
			let cursor = -total / 2;

			for (const child of children) {
				const stackOff = cursor + child.subtreeSpan / 2;
				placeLayout(
					child,
					cx + dirVec.x * forward + axis.x * stackOff,
					cy + dirVec.y * forward + axis.y * stackOff
				);
				cursor += child.subtreeSpan + stackGap;
			}
		}
	};

	const placeLayout = (layout: LayoutNode, cx: number, cy: number) => {
		positions[layout.id] = {
			x: Math.round(cx * 100) / 100,
			y: Math.round(cy * 100) / 100,
		};
		if (layout.children.length === 0) return;
		if (layout.groupChildren) {
			placeRootGrouped(layout, cx, cy);
			return;
		}
		placeDirectedChildren(layout, cx, cy);
	};

	const root = input.nodes[input.relayoutRootId];
	if (!root) return positions;
	placeLayout(buildLayout(input.relayoutRootId), root.position.x, root.position.y);
	return positions;
}
