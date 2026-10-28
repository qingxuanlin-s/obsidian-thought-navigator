const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const cytoscape = require('cytoscape');

const source = fs.readFileSync(require.resolve('../src/renderer/clipboard.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleForTest = { exports: {} };
new Function('module', 'exports', compiled)(moduleForTest, moduleForTest.exports);
const { getNodeClipboardContent, getPasteTarget, getPasteTranslation } = moduleForTest.exports;
const note = (overrides = {}) => ({ ID: 'a.1', IDStr: 'a.1', title: '知道了 `∀`', displayText: 'a.1: 知道了 `∀`', ...overrides });

test('copies source content even when display settings show the ID', () => {
	assert.equal(getNodeClipboardContent(note()), '知道了 `∀`');
	assert.equal(getNodeClipboardContent(note({ displayText: 'a.1' })), '知道了 `∀`');
	assert.equal(getNodeClipboardContent(note({ title: 'a.1: literal content' })), 'a.1: literal content');
});

test('legacy labels lose only their exact generated prefix; empty nodes do not copy IDs', () => {
	assert.equal(getNodeClipboardContent(note({ title: '' })), '知道了 `∀`');
	assert.equal(getNodeClipboardContent(note({ title: '', displayText: 'a.1' })), '');
	assert.equal(getNodeClipboardContent(note({ title: '', displayText: 'a.10: content' })), 'a.10: content');
	assert.equal(getNodeClipboardContent(note({ title: '', wikiLink: 'Notes/笔记#标题' })), 'Notes/笔记#标题');
});

function graph() {
	const cy = cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' }, elements: [
		{ data: { id: 'a', originalNodeId: 'a' }, position: { x: 100, y: 80 } },
		{ data: { id: 'b', originalNodeId: 'b' }, position: { x: 500, y: 240 } },
	] });
	cy.nodes().style({ width: 200, height: 100 });
	cy.width = () => 1000;
	cy.height = () => 600;
	return cy;
}

test('no selection targets the current viewport center after panning and zooming', () => {
	const cy = graph();
	try {
		cy.zoom(0.5); cy.pan({ x: 120, y: -70 });
		assert.deepEqual(getPasteTarget(cy), { x: 760, y: 740, align: 'center' });
	} finally { cy.destroy(); }
});

test('selection targets its right edge with a fixed model-space gap', () => {
	const cy = graph();
	try {
		cy.$id('a').select();
		const bb = cy.$id('a').boundingBox({ includeLabels: false, includeOverlays: false });
		const expected = { x: bb.x2 + 60, y: (bb.y1 + bb.y2) / 2, align: 'left' };
		assert.deepEqual(getPasteTarget(cy), expected);
		cy.zoom(0.3); cy.pan({ x: -500, y: 200 });
		assert.deepEqual(getPasteTarget(cy), expected);
		cy.$id('b').select();
		assert.ok(getPasteTarget(cy).x > cy.$id('b').position('x') + 100);
	} finally { cy.destroy(); }
});

test('selected groups do not become a paste anchor', () => {
	const cy = graph();
	try {
		cy.$id('a').data('isGroup', true).select();
		assert.equal(getPasteTarget(cy).align, 'center');
	} finally { cy.destroy(); }
});

// Exercise actual persistence and position updates with Cytoscape node dimensions.
const viewSource = fs.readFileSync(require.resolve('../src/view/indexView.ts'), 'utf8');
const ast = ts.createSourceFile('indexView.ts', viewSource, ts.ScriptTarget.Latest, true);
let method;
function visit(node) {
	if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'placePastedNodes') method = node.getText(ast);
	ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(method);
const viewCompiled = ts.transpileModule(`class View { ${method} }`, {
	compilerOptions: { target: ts.ScriptTarget.ES2018 },
}).outputText;
const createView = new Function('dataStr', 'getPasteTranslation', 'parseMOCStructure', 'saveMOCStructure', `${viewCompiled}\nreturn View;`);

test('pasted group keeps relative positions, clears the anchor, and persists the result', async () => {
	const cy = graph();
	try {
		const saved = { nodePositions: {} };
		const View = createView((n, key) => n.data(key), getPasteTranslation, async () => saved, async () => {});
		const view = new View();
		view.plugin = { settings: { mocHeadingTitle: '' } };
		view.ensureMOCNodeLayoutStyle = () => {};
		view.getRuntimeNodePositions = () => ({});
		view.branchRenderer = { getCytoscapeInstance: () => cy };
		await view.placePastedNodes({}, ['a', 'b'], { x: 900, y: 400, align: 'left' });
		let bb = cy.nodes().boundingBox({ includeLabels: false, includeOverlays: false });
		assert.equal(bb.x1, 900);
		assert.equal((bb.y1 + bb.y2) / 2, 400);
		assert.equal(cy.$id('b').position('x') - cy.$id('a').position('x'), 400);
		assert.equal(cy.$id('b').position('y') - cy.$id('a').position('y'), 160);
		assert.deepEqual(saved.nodePositions.a, cy.$id('a').position());
		await view.placePastedNodes({}, ['a', 'b'], { x: 300, y: 200, align: 'center' });
		bb = cy.nodes().boundingBox({ includeLabels: false, includeOverlays: false });
		assert.equal((bb.x1 + bb.x2) / 2, 300);
		assert.equal((bb.y1 + bb.y2) / 2, 200);
	} finally { cy.destroy(); }
});
