const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const cache = new Map();
function load(relativePath) {
	const file = path.normalize(relativePath);
	if (cache.has(file)) return cache.get(file).exports;
	const loaded = { exports: {} };
	cache.set(file, loaded);
	const source = fs.readFileSync(path.join(__dirname, '..', `${file}.ts`), 'utf8');
	const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
	const localRequire = name => name === 'obsidian' ? {} : load(name.startsWith('.') ? path.join(path.dirname(file), name) : name);
	new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
	return loaded.exports;
}
global.window = { setTimeout };
const { parseMOCJson, serializeMOCJson } = load('src/utils/mocJsonCodec');
const { normalizeMOCLayout, computeMOCLayout } = load('src/utils/mocAutoLayout');
const { MOCHandler } = load('src/view/index/mocHandler');
const app = { metadataCache: { getFirstLinkpathDest: () => null }, vault: { getFileByPath: () => null } };
const node = (nodeID, children = [], extra = {}) => ({ nodeID, nodeType: 'text', target: nodeID, children, ...extra });
const parse = value => parseMOCJson(JSON.stringify(value), 'test.moc.md', app);
const roundTrip = data => parseMOCJson(serializeMOCJson(data), 'test.moc.md', app);
const fixture = () => parse({
	nodeLayoutStyle: 'auto', layoutPreset: 'bidirectional',
	nodes: [node('a', [node('a.1'), node('a.2', [], { nodeType: 'embed', extBitMap: 2 })])],
	nodePositions: { a: { x: 50, y: 60 }, 'a.1': { x: 500, y: 140 }, 'a.2': { x: 500, y: -140 } },
});
const sizes = { a: { width: 260, height: 100 }, 'a.1': { width: 311.4, height: 103.4 }, 'a.2': { width: 280, height: 220 } };
const flat = data => {
	const result = {};
	const walk = nodes => nodes.forEach(node => { result[node.nodeID] = node; walk(node.children); });
	walk(data.nodes);
	return result;
};
function assertSeparate(positions, sizes, a, b) {
	assert.ok(Math.abs(positions[a].x - positions[b].x) >= (sizes[a].width + sizes[b].width) / 2
		|| Math.abs(positions[a].y - positions[b].y) >= (sizes[a].height + sizes[b].height) / 2, `${a} overlaps ${b}`);
}

test('legacy automatic coordinates become direction and visual order without mutating input', () => {
	const data = fixture();
	assert.deepEqual(data.nodePositions, { a: { x: 50, y: 60 } });
	assert.equal(data.metadata.needsLayoutMigration, true);
	const nodes = flat(data);
	assert.equal(nodes['a.1'].layout.direction, 'E');
	assert.equal(nodes['a.2'].layout.direction, 'E');
	assert.equal(nodes['a.2'].layout.order, 0);
	assert.equal(nodes['a.1'].layout.order, 1);
	const snapshot = JSON.stringify(data);
	const saved = roundTrip(data);
	assert.equal(JSON.stringify(data), snapshot);
	assert.equal(saved.metadata.needsLayoutMigration, false);
	assert.equal(serializeMOCJson(saved), serializeMOCJson(roundTrip(saved)));
	const positions = computeMOCLayout(saved, sizes);
	assert.ok(positions['a.1'].x > positions.a.x && positions['a.2'].x > positions.a.x);
	assert.ok(positions['a.2'].y < positions['a.1'].y);
	assertSeparate(positions, sizes, 'a.1', 'a.2');
});

for (const preset of ['bidirectional', 'top-down', 'radial']) {
	for (const height of [220, 440]) {
		test(`${preset}: actual preview size ${height} is used on every reopen`, () => {
			const data = fixture();
			data.layoutPreset = preset;
			const actual = { ...sizes, 'a.2': { width: height === 440 ? 560 : 280, height } };
			const positions = computeMOCLayout(roundTrip(data), actual);
			assertSeparate(positions, actual, 'a.1', 'a.2');
			const next = roundTrip({ ...data, nodePositions: positions });
			assert.deepEqual(Object.keys(next.nodePositions), ['a']);
			assert.deepEqual(computeMOCLayout(next, actual), positions);
		}
		);
	}
}

test('dragging saves side and order without saving automatic coordinates', () => {
	let data = fixture();
	data.nodePositions = { a: { x: 50, y: 60 }, 'a.1': { x: -500, y: 200 }, 'a.2': { x: -500, y: -200 } };
	data = roundTrip(data);
	const positions = computeMOCLayout(data, sizes);
	assert.ok(positions['a.1'].x < positions.a.x && positions['a.2'].x < positions.a.x);
	assert.ok(positions['a.2'].y < positions['a.1'].y);
	assert.deepEqual(Object.keys(data.nodePositions), ['a']);
});

test('a pinned branch flips while its unpinned descendants inherit the new direction', () => {
	const data = parse({ nodeLayoutStyle: 'auto', nodes: [node('a', [node('a.1', [node('a.1.child')], { extBitMap: 2 })])],
		nodePositions: { a: { x: 0, y: 0 }, 'a.1': { x: -400, y: 0 }, 'a.1.child': { x: -100, y: 0 } } });
	const positions = computeMOCLayout(data, { a: sizes.a, 'a.1': sizes.a, 'a.1.child': sizes.a });
	assert.ok(positions['a.1'].x < positions.a.x);
	assert.ok(positions['a.1.child'].x < positions['a.1'].x);
});

test('free branches retain offsets; separated automatic islands retain only their anchor', () => {
	const data = parse({
		nodeLayoutStyle: 'auto', nodeLayoutOverrides: { 'a.1.f': 'free', 'a.1.f.auto': 'auto' },
		nodes: [node('a', [node('a.1', [node('a.1.f', [node('a.1.f.free'), node('a.1.f.auto', [node('a.1.f.auto.child')])])]), node('a.2', [node('a.2.child')], { extBitMap: 1 })])],
		nodePositions: { a: { x: 0, y: 0 }, 'a.1': { x: 300, y: 0 }, 'a.1.f': { x: 350, y: 70 }, 'a.1.f.free': { x: 400, y: 130 },
			'a.1.f.auto': { x: 700, y: 70 }, 'a.1.f.auto.child': { x: 1000, y: 70 }, 'a.2': { x: -800, y: 600 }, 'a.2.child': { x: -1100, y: 600 } },
	});
	const allSizes = Object.fromEntries(Object.keys(flat(data)).map(id => [id, { width: 200, height: 80 }]));
	const saved = roundTrip(data);
	assert.deepEqual(Object.keys(saved.nodePositions).sort(), ['a', 'a.1.f', 'a.1.f.free', 'a.2']);
	const positions = computeMOCLayout(saved, allSizes);
	assert.deepEqual(positions['a.2'], { x: -800, y: 600 });
	assert.ok(positions['a.2.child'].x < positions['a.2'].x);
	assert.equal(positions['a.1.f'].x - positions['a.1'].x, 50);
	assert.equal(positions['a.1.f'].y - positions['a.1'].y, 70);
	assert.equal(positions['a.1.f.free'].x - positions['a.1.f'].x, 50);
	assert.equal(positions['a.1.f.free'].y - positions['a.1.f'].y, 60);
	assert.ok(positions['a.1.f.auto'].x > positions['a.1.f'].x);
	assert.deepEqual(computeMOCLayout(roundTrip({ ...saved, nodePositions: positions }), allSizes), positions);
});

test('collapsed children do not consume layout space or lose their saved order', () => {
	const data = fixture();
	const full = computeMOCLayout(data, sizes);
	const collapsed = computeMOCLayout(data, sizes, {}, new Set(['a.2']));
	assert.equal(collapsed['a.2'], undefined);
	assert.notEqual(collapsed['a.1'].y, full['a.1'].y);
	const saved = roundTrip({ ...data, nodePositions: collapsed });
	assert.equal(flat(saved)['a.2'].layout.order, 0);
	assert.deepEqual(computeMOCLayout(saved, sizes), full);
});

test('free-only files retain all coordinates and renderer restores them unchanged', () => {
	const data = parse({ nodeLayoutStyle: 'free', nodes: [node('a', [node('b')])], nodePositions: { a: { x: 42, y: 77 }, b: { x: -84, y: 500 } } });
	const saved = roundTrip(data);
	assert.deepEqual(saved.nodePositions, data.nodePositions);
	assert.deepEqual(computeMOCLayout(saved, { a: sizes.a, b: sizes['a.1'] }), data.nodePositions);
});

test('every save filters computed coordinates while retaining sizes, undo data, and intent through rename', () => {
	const data = fixture();
	data.embedNodeSizes = { 'a.2': { width: 560, height: 440 } };
	const positions = computeMOCLayout(data, sizes);
	const existing = serializeMOCJson(data);
	const changed = roundTrip({ ...data, nodePositions: positions });
	changed.nodes[0].children[1].nodeID = 'renamed';
	const saved = roundTrip(changed);
	assert.equal(flat(saved).renamed.layout.direction, 'E');
	assert.equal(flat(saved).renamed.layout.order, 0);
	assert.deepEqual(Object.keys(saved.nodePositions), ['a']);
	assert.deepEqual(saved.embedNodeSizes, data.embedNodeSizes);
	assert.equal(serializeMOCJson(parseMOCJson(existing, 'test.moc.md', app)), existing);
});

test('CLI creation and subsequent callbacks cannot reintroduce automatic coordinates', async () => {
	let content = serializeMOCJson(fixture());
	const file = { path: 'test.moc.md' };
	let writes = 0;
	const runtime = computeMOCLayout(fixture(), sizes);
	const vaultApp = { ...app, vault: {
		adapter: { read: async () => content }, read: async () => content, getFileByPath: () => file,
		modify: async (_file, next) => { writes++; content = next; },
	} };
	const handler = new MOCHandler({ settings: { mocHeadingTitle: '', autoLayoutDefaultGrowthDirection: 'bidirectional' } }, vaultApp, { getNodePositions: () => runtime });
	await handler.addChildNodeToMOC(file, 'a', 'new node');
	let json = JSON.parse(content);
	assert.deepEqual(Object.keys(json.nodePositions), ['a']);
	assert.equal(json.nodes[0].children.length, 3);
	assert.ok(json.nodes[0].children[2].layout.direction);
	await handler.modifyMOCData(file, data => { data.nodePositions['a.1'] = { x: -999, y: 222 }; });
	json = JSON.parse(content);
	assert.deepEqual(Object.keys(json.nodePositions), ['a']);
	assert.equal(json.nodes[0].children[0].layout.direction, 'W');
	const writeCount = writes;
	const noRuntimeHandler = new MOCHandler({ settings: {} }, vaultApp);
	await noRuntimeHandler.modifyMOCData(file, () => {});
	assert.equal(writes, writeCount);
});

test('rapid collapse and expand compares disk contents rather than stale vault.read cache', async () => {
	let content = serializeMOCJson(fixture());
	const cachedContent = content;
	const file = { path: 'test.moc.md' };
	const vaultApp = { ...app, vault: {
		adapter: { read: async () => content }, read: async () => cachedContent, getFileByPath: () => file,
		modify: async (_file, next) => { content = next; },
	} };
	const handler = new MOCHandler({ settings: {} }, vaultApp);
	await handler.modifyMOCData(file, data => { data.collapsedNodeIds = ['a.2']; });
	assert.deepEqual(JSON.parse(content).collapsedNodeIds, ['a.2']);
	await handler.modifyMOCData(file, data => { data.collapsedNodeIds = []; });
	assert.deepEqual(JSON.parse(content).collapsedNodeIds, []);
});
