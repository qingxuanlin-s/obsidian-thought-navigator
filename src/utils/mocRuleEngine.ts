import { createEmptyMOCJson } from "./mocJsonCodec";

export type RuleJoin = 'and' | 'or';
export type RuleField = 'filename' | 'folder' | 'property';
export type RuleOperator = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'exists' | 'notContains';

export interface MocRuleCondition {
	field: RuleField;
	property?: string;
	operator: RuleOperator;
	value: string;
}

export interface MocRuleGroup {
	join: RuleJoin;
	conditions: MocRuleCondition[];
}

export interface MocCreationRules {
	groupJoin: RuleJoin;
	groups: MocRuleGroup[];
	parentSource: 'filename' | 'property';
	parentProperty: string;
	separator: string;
	stopMarker: string;
	rootPath: string;
}

export interface MocCandidate {
	path: string;
	basename: string;
	folder: string;
	properties: Record<string, unknown>;
}

export interface MocPreviewNode {
	file: MocCandidate;
	key: string;
	children: MocPreviewNode[];
}

export interface MocRulePreview {
	matched: MocCandidate[];
	roots: MocPreviewNode[];
	included: number;
	excludedByRoot: number;
	missingKeys: number;
}

function propertyValues(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(propertyValues);
	if (value === null || value === undefined || typeof value === 'object') return [];
	return [String(value)];
}

function valuesFor(file: MocCandidate, condition: MocRuleCondition): string[] {
	if (condition.field === 'filename') return [file.basename];
	if (condition.field === 'folder') return [file.folder];
	return propertyValues(file.properties[condition.property?.trim() || '']);
}

function matchesCondition(file: MocCandidate, condition: MocRuleCondition): boolean {
	const values = valuesFor(file, condition).map(value => value.toLocaleLowerCase());
	const query = condition.value.trim().toLocaleLowerCase();
	if (condition.operator === 'exists') return values.some(value => value.trim().length > 0);
	const contains = values.some(value => value.includes(query));
	if (condition.operator === 'notContains') return !contains;
	if (condition.operator === 'contains') return contains;
	if (condition.operator === 'equals') return values.some(value => value === query);
	if (condition.operator === 'startsWith') return values.some(value => value.startsWith(query));
	return values.some(value => value.endsWith(query));
}

export function validateMocRules(rules: MocCreationRules): string | null {
	for (const group of rules.groups) {
		if (group.conditions.length === 0) return 'Each group needs a condition';
		for (const condition of group.conditions) {
			if (condition.field === 'property' && !condition.property?.trim()) return 'Enter a property name';
			if (condition.operator !== 'exists' && !condition.value.trim()) return 'Enter a condition value';
		}
	}
	if (!rules.separator) return 'Enter a hierarchy separator';
	if (rules.parentSource === 'property' && !rules.parentProperty.trim()) return 'Enter a hierarchy property';
	return null;
}

function matchesRules(file: MocCandidate, rules: MocCreationRules): boolean {
	if (rules.groups.length === 0) return true;
	const results = rules.groups.map(group => group.join === 'and'
		? group.conditions.every(condition => matchesCondition(file, condition))
		: group.conditions.some(condition => matchesCondition(file, condition)));
	return rules.groupJoin === 'and' ? results.every(Boolean) : results.some(Boolean);
}

function hierarchyKey(file: MocCandidate, rules: MocCreationRules): string {
	const raw = rules.parentSource === 'filename'
		? file.basename
		: propertyValues(file.properties[rules.parentProperty.trim()])[0] || '';
	const prefix = rules.stopMarker ? raw.split(rules.stopMarker, 1)[0] : raw;
	return prefix.split(rules.separator).map(part => part.trim()).filter(Boolean).join(rules.separator);
}

export function previewMocRules(files: MocCandidate[], rules: MocCreationRules): MocRulePreview {
	const error = validateMocRules(rules);
	if (error) throw new Error(error);
	const matched = files.filter(file => matchesRules(file, rules)).sort((a, b) => a.path.localeCompare(b.path));
	const byPath = new Map(matched.map(file => [file.path, file]));
	const root = rules.rootPath ? byPath.get(rules.rootPath) : undefined;
	if (rules.rootPath && !root) throw new Error('Selected root does not match the filter');
	const rootKey = root ? hierarchyKey(root, rules) : '';
	if (root && !rootKey) throw new Error('Selected root has no hierarchy key');
	const keyed = matched.map(file => ({ file, key: hierarchyKey(file, rules) }));
	const eligible = root ? keyed.filter(item => item.file.path === root.path || item.key.startsWith(rootKey + rules.separator)) : keyed;
	const nodes = eligible.map(item => ({ file: item.file, key: item.key, children: [] as MocPreviewNode[] }));
	const firstByKey = new Map<string, MocPreviewNode>();
	for (const node of nodes) if (node.key && !firstByKey.has(node.key)) firstByKey.set(node.key, node);
	if (root) firstByKey.set(rootKey, nodes.find(node => node.file.path === root.path)!);
	const roots: MocPreviewNode[] = [];
	for (const node of nodes) {
		if (root && node.file.path === root.path) { roots.unshift(node); continue; }
		let parent: MocPreviewNode | undefined;
		if (node.key) {
			let index = node.key.lastIndexOf(rules.separator);
			while (index > 0 && !parent) {
				const candidate = firstByKey.get(node.key.slice(0, index));
				if (candidate !== node) parent = candidate;
				index = node.key.lastIndexOf(rules.separator, index - 1);
			}
		}
		if (root && !parent) parent = nodes.find(item => item.file.path === root.path);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return {
		matched,
		roots,
		included: nodes.length,
		excludedByRoot: matched.length - nodes.length,
		missingKeys: nodes.filter(node => !node.key).length,
	};
}

export function mocJsonFromPreview(preview: MocRulePreview, layout: 'free' | 'auto'): string {
	const json = JSON.parse(createEmptyMOCJson(layout)) as { nodes: unknown[] };
	const used = new Set<string>();
	const convert = (node: MocPreviewNode, depth: number, parentId: string, parentKey: string, index: number): unknown => {
		const keyIsId = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/.test(node.key)
			&& !used.has(node.key)
			&& (!parentId || (parentId === parentKey && node.key.startsWith(parentKey + '.')
				&& !node.key.slice(parentKey.length + 1).includes('.')));
		let id = keyIsId ? node.key : parentId ? `${parentId}.${index + 1}` : `r${index + 1}`;
		let suffix = index + 1;
		while (used.has(id)) id = parentId ? `${parentId}.${++suffix}` : `r${++suffix}`;
		used.add(id);
		return {
			nodeID: id,
			nodeType: 'file',
			target: node.file.path,
			depth,
			children: node.children.map((child, childIndex) => convert(child, depth + 1, id, node.key, childIndex)),
			relationText: '',
		};
	};
	json.nodes = preview.roots.map((root, index) => convert(root, 0, '', '', index));
	return JSON.stringify(json, null, 2);
}
