export type GrowthDirection = 'E' | 'NE' | 'N' | 'NW' | 'W' | 'SW' | 'S' | 'SE';
export type LayoutPreset = 'bidirectional' | 'top-down' | 'radial';

export interface Vec2 {
	x: number;
	y: number;
}

const R = Math.SQRT1_2;

export const DEFAULT_LAYOUT_PRESET: LayoutPreset = 'bidirectional';

export const DIR_VECTORS: Record<GrowthDirection, Vec2> = {
	E: { x: 1, y: 0 },
	NE: { x: R, y: -R },
	N: { x: 0, y: -1 },
	NW: { x: -R, y: -R },
	W: { x: -1, y: 0 },
	SW: { x: -R, y: R },
	S: { x: 0, y: 1 },
	SE: { x: R, y: R },
};

export const PRESET_POOL: Record<LayoutPreset, GrowthDirection[]> = {
	bidirectional: ['E', 'W'],
	'top-down': ['S', 'N'],
	radial: ['NE', 'SE', 'SW', 'NW'],
};

export function normalizeLayoutPreset(value: unknown, fallback: LayoutPreset = DEFAULT_LAYOUT_PRESET): LayoutPreset {
	if (value === 'bidirectional' || value === 'top-down' || value === 'radial') {
		return value;
	}
	return fallback;
}

export function normalizeNodeLayoutPresets(value: unknown): Record<string, LayoutPreset> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const result: Record<string, LayoutPreset> = {};
	for (const [nodeId, preset] of Object.entries(value as Record<string, unknown>)) {
		if (typeof nodeId !== 'string' || !nodeId) continue;
		if (preset === 'bidirectional' || preset === 'top-down' || preset === 'radial') {
			result[nodeId] = preset;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function stackAxisOf(dir: GrowthDirection): Vec2 {
	const v = DIR_VECTORS[dir];
	return { x: -v.y, y: v.x };
}

export function quantizeToPool(dx: number, dy: number, pool: GrowthDirection[]): GrowthDirection {
	let best = pool[0];
	let bestDot = -Infinity;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	for (const dir of pool) {
		const v = DIR_VECTORS[dir];
		const dot = v.x * ux + v.y * uy;
		if (dot > bestDot) {
			bestDot = dot;
			best = dir;
		}
	}
	return best;
}

export function projectSize(size: { width: number; height: number }, axis: Vec2): number {
	return Math.abs(size.width * axis.x) + Math.abs(size.height * axis.y);
}
