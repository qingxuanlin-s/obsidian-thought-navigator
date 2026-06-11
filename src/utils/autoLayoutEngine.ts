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
	ignoreSavedPositionsForIds?: Set<string>;
	// 侧别已固定的节点:无论层级都按自身保存位置导出方向,不继承父方向。
	sidePinnedIds?: Set<string>;
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

/**
 * 思维导图自动布局引擎(两遍式,所有 preset 共用同一实现):
 * 1. buildLayout 自底向上累计子树跨度;分组放置的节点各方向组独立铺开,跨度取各组的 max。
 * 2. placeLayout 自顶向下分槽;根/分支起点/方向混合的节点按方向分组对称放置,
 *    其余沿继承方向单侧铺开。有保存位置且不在 ignore 集的节点以保存位置为锚,
 *    其子树围绕实际锚点继续放置(saved wins)。
 *
 * 方向解析:分支起点按"保存位置相对父节点的偏移"量化到所属 preset 的方向池
 * (bidirectional=E/W、top-down=S/N、radial=四对角);深层节点继承父方向,
 * 除非带 SIDE_PINNED 标志(按自身位置定向)。
 *
 * 堆叠轴:同一 preset 内符号固定(bidirectional 恒竖直 {0,1}、top-down 恒水平 {1,0}),
 * 使两侧(E/W 或 S/N)的排序与放置共用同一条带符号的轴,不会出现一侧顺序镜像;
 * radial 的堆叠轴依对角方向而定(stackAxisOf)。
 */
export function computeAutoLayout(input: ComputeAutoLayoutInput): Record<string, Vec2> {
	const forwardGap = input.forwardGap ?? 150;
	const stackGap = input.stackGap ?? 56;
	const positions: Record<string, Vec2> = {};
	const filePreset = normalizeLayoutPreset(input.layoutPreset, DEFAULT_LAYOUT_PRESET);
	const branchPresetCache = new Map<string, LayoutPreset>();
	const directionCache = new Map<string, GrowthDirection | null>();
	const layoutById = new Map<string, LayoutNode>();

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

	const axisFor = (dir: GrowthDirection, preset: LayoutPreset): Vec2 => {
		if (preset === 'bidirectional') return { x: 0, y: 1 };
		if (preset === 'top-down') return { x: 1, y: 0 };
		return stackAxisOf(dir);
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
			const fallback = PRESET_POOL[getBranchPreset(nodeId)][0];
			directionCache.set(nodeId, fallback);
			return fallback;
		}

		let direction: GrowthDirection;
		// relayout 根(auto 子树岛顶点,挂在 free 祖先链下)按自身位置定向,
		// 不沿 free 链继承——否则会继承到远祖的方向,导致子节点朝反方向生长。
		// 分支起点(父为 MOC 根)同样按自身位置量化到所属分支的方向池。
		if (nodeId === input.relayoutRootId || input.realMocRootIds.has(parentId)) {
			direction = resolveFromPool(nodeId, parentId, getBranchPreset(nodeId));
		} else if (isBranchStart(parentId) || input.sidePinnedIds?.has(nodeId)) {
			// 二级节点定分支内侧别;侧别已固定(SIDE_PINNED)的深层节点也按自身保存位置
			// 导出方向,不继承父方向。
			direction = resolveFromPool(nodeId, parentId, getBranchPreset(parentId));
		} else {
			direction = getDirection(parentId) || PRESET_POOL[getBranchPreset(parentId)][0];
		}

		directionCache.set(nodeId, direction);
		return direction;
	};

	const getSortPosition = (id: string): Vec2 => input.nodePositions[id] || input.nodes[id].position;

	// 颜色分组优先、组内按轴投影排序;投影只计算一次
	const sortIdsByAxis = (ids: string[], axis: Vec2): string[] => {
		if (ids.length <= 1) return [...ids];
		const proj = new Map<string, number>();
		for (const id of ids) {
			const p = getSortPosition(id);
			proj.set(id, p.x * axis.x + p.y * axis.y);
		}
		const byProj = [...ids].sort((a, b) => proj.get(a)! - proj.get(b)!);
		const colorOrder = new Map<string, number>();
		for (const id of byProj) {
			const colorKey = input.nodes[id].colorKey;
			if (!colorOrder.has(colorKey)) {
				colorOrder.set(colorKey, colorOrder.size);
			}
		}
		return byProj.sort((a, b) => {
			const rankA = colorOrder.get(input.nodes[a].colorKey) ?? Number.MAX_SAFE_INTEGER;
			const rankB = colorOrder.get(input.nodes[b].colorKey) ?? Number.MAX_SAFE_INTEGER;
			if (rankA !== rankB) return rankA - rankB;
			return proj.get(a)! - proj.get(b)!;
		});
	};

	const buildLayout = (nodeId: string): LayoutNode => {
		const node = input.nodes[nodeId];
		const dir = getDirection(nodeId);
		const stackAxis = dir ? axisFor(dir, getBranchPreset(nodeId)) : null;
		const childAxis = stackAxis || { x: 0, y: 1 };
		const children = (input.childrenById[nodeId] || []).map((childId) => buildLayout(childId));
		// 子节点方向不一致(如部分被固定到对侧)时也分组放置,否则单方向放置会把对侧子节点拉回。
		const groupChildren = input.realMocRootIds.has(nodeId) || isBranchStart(nodeId)
			|| new Set(children.map((c) => c.dir)).size > 1;
		// 跨度:分组节点各方向组独立铺开互不叠加,取各组跨度的 max;单方向铺开则求和
		let childrenSpan = 0;
		if (children.length > 0) {
			if (groupChildren) {
				const groupSpan = new Map<GrowthDirection | null, number>();
				for (const child of children) {
					const prev = groupSpan.get(child.dir);
					groupSpan.set(child.dir, prev === undefined ? child.subtreeSpan : prev + stackGap + child.subtreeSpan);
				}
				childrenSpan = Math.max(...groupSpan.values());
			} else {
				childrenSpan = children.reduce((sum, child) => sum + child.subtreeSpan, 0)
					+ (children.length - 1) * stackGap;
			}
		}
		const selfSpan = projectSize(node.size, childAxis);
		const layout: LayoutNode = {
			id: nodeId,
			size: node.size,
			dir,
			stackAxis,
			groupChildren,
			children,
			subtreeSpan: Math.max(selfSpan, childrenSpan),
		};
		layoutById.set(nodeId, layout);
		return layout;
	};

	const avgProjection = (children: LayoutNode[], axis: Vec2): number => {
		if (children.length === 0) return 0;
		return children.reduce((sum, child) => sum + projectSize(child.size, axis), 0) / children.length;
	};

	const gapFor = (dir: GrowthDirection): number => {
		return dir.length === 2 ? forwardGap * DIAGONAL_GAP_FACTOR : forwardGap;
	};

	// 把一组同方向子节点围绕 (cx, cy) 沿该组的堆叠轴对称铺开。
	// 组内按组轴重排序:排序轴与放置轴一致,各侧/各象限都保持现有视觉顺序。
	const placeChildGroup = (parent: LayoutNode, group: LayoutNode[], dir: GrowthDirection, cx: number, cy: number) => {
		const dirVec = DIR_VECTORS[dir];
		const axis = group[0].stackAxis || axisFor(dir, filePreset);
		const ordered = sortIdsByAxis(group.map((c) => c.id), axis).map((id) => layoutById.get(id)!);
		const forward = projectSize(parent.size, dirVec) / 2
			+ gapFor(dir)
			+ avgProjection(ordered, dirVec) / 2;
		const total = ordered.reduce((sum, child) => sum + child.subtreeSpan, 0)
			+ Math.max(0, ordered.length - 1) * stackGap;
		let cursor = -total / 2;

		for (const child of ordered) {
			const stackOff = cursor + child.subtreeSpan / 2;
			placeLayout(
				child,
				cx + dirVec.x * forward + axis.x * stackOff,
				cy + dirVec.y * forward + axis.y * stackOff
			);
			cursor += child.subtreeSpan + stackGap;
		}
	};

	const placeChildren = (layout: LayoutNode, cx: number, cy: number) => {
		if (layout.groupChildren) {
			const groups = new Map<GrowthDirection, LayoutNode[]>();
			for (const child of layout.children) {
				if (!child.dir) continue;
				const group = groups.get(child.dir) || [];
				group.push(child);
				groups.set(child.dir, group);
			}
			for (const [dir, group] of groups.entries()) {
				placeChildGroup(layout, group, dir, cx, cy);
			}
			return;
		}
		if (!layout.dir) return;
		placeChildGroup(layout, layout.children, layout.dir, cx, cy);
	};

	const placeLayout = (layout: LayoutNode, cx: number, cy: number) => {
		const saved = layout.id !== input.relayoutRootId && !input.ignoreSavedPositionsForIds?.has(layout.id)
			? input.nodePositions[layout.id]
			: undefined;
		const ax = saved ? saved.x : cx;
		const ay = saved ? saved.y : cy;
		positions[layout.id] = {
			x: Math.round(ax * 100) / 100,
			y: Math.round(ay * 100) / 100,
		};
		if (layout.children.length === 0) return;
		placeChildren(layout, ax, ay);
	};

	const root = input.nodes[input.relayoutRootId];
	if (!root) return positions;
	placeLayout(buildLayout(input.relayoutRootId), root.position.x, root.position.y);
	return positions;
}
