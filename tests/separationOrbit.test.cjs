const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const cytoscape = require('cytoscape');
const compiled = ts.transpileModule(fs.readFileSync(require.resolve('../src/renderer/layoutAdapter.ts'), 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, loaded, loaded.exports);
const { getSeparationOrbit } = loaded.exports;
function graph() {
	return cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' }, elements: [
		{ data: { id: 'p', originalNode: { IDStr: 'parent' } }, position: { x: 20, y: 30 } },
		{ data: { id: 'a', originalNode: { IDStr: 'child.a' } }, position: { x: 320, y: 430 } },
		{ data: { id: 'b', originalNode: { IDStr: 'child.b' } }, position: { x: 620, y: 30 } },
		{ data: { id: 'free', originalNode: { IDStr: 'free.1' }, isFreeNode: true }, position: { x: 10000, y: 0 } },
		{ data: { id: 'aEdge', source: 'p', target: 'a', type: 'parent' } },
		{ data: { id: 'bEdge', source: 'p', target: 'b', type: 'parent' } },
		{ data: { id: 'freeEdge', source: 'p', target: 'free', type: 'parent' } },
	], style: [{ selector: 'node', style: { width: 200, height: 100 } }] });
}
test('orbit passes through the farthest child center, including the node being grabbed', () => {
	const cy = graph();
	try {
		assert.deepEqual(getSeparationOrbit(cy.$id('b'), () => true, new Set()), { cx: 20, cy: 30, radius: 600, parentId: 'parent' });
		assert.equal(getSeparationOrbit(cy.$id('a'), () => true, new Set()).radius, 600);
		cy.$id('b').remove();
		assert.equal(getSeparationOrbit(cy.$id('a'), () => true, new Set()).radius, 500);
	} finally { cy.destroy(); }
});
test('free, hidden, and previously separated children cannot inflate the orbit', () => {
	const cy = graph();
	try {
		assert.equal(getSeparationOrbit(cy.$id('a'), () => true, new Set(['child.b'])).radius, 500);
		cy.$id('b').addClass('zk-collapsed-hidden');
		assert.equal(getSeparationOrbit(cy.$id('a'), () => true, new Set()).radius, 500);
		assert.equal(getSeparationOrbit(cy.$id('a'), id => id !== 'parent', new Set()), null);
	} finally { cy.destroy(); }
});
test('the grabbed snapshot stays fixed as the child moves; model radius is independent of zoom', () => {
	const cy = graph();
	try {
		const orbit = getSeparationOrbit(cy.$id('b'), () => true, new Set());
		cy.zoom(0.5); cy.pan({ x: 80, y: 90 });
		assert.equal(getSeparationOrbit(cy.$id('b'), () => true, new Set()).radius, orbit.radius);
		cy.$id('b').position({ x: 2000, y: 0 });
		assert.equal(orbit.radius, 600);
	} finally { cy.destroy(); }
});
test('an all-separated family offers a size-based return orbit rather than using the distant child', () => {
	const cy = graph();
	try {
		cy.$id('a').position({ x: 10000, y: 0 });
		const separated = new Set(['child.a', 'child.b']);
		assert.equal(getSeparationOrbit(cy.$id('a'), () => true, separated).radius, 350);
		cy.$id('a').style('width', 400);
		assert.equal(getSeparationOrbit(cy.$id('a'), () => true, separated).radius, 450);
	} finally { cy.destroy(); }
});

const eventSource = fs.readFileSync(require.resolve('../src/renderer/events.ts'), 'utf8');
const updateStart = eventSource.indexOf('        const updateSeparationCircle = ');
const updateBody = eventSource.slice(updateStart, eventSource.indexOf('        const clearSeparation', updateStart));
function feedback(zoom) {
	const circle = { style: { display: 'none' }, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, setCssStyles(styles) { Object.assign(this.style, styles); } };
	let position = { x: 400, y: 0 };
	const code = ts.transpileModule(`
		let separationHasMoved = false, separationWillSeparate = false;
		const SEPARATION_SHOW_THRESHOLD_PX = 12, SEPARATION_TOLERANCE_PX = 8;
		const SEPARATION_STROKE = 'gray', SEPARATION_STROKE_ACTIVE = 'red';
		const autoHierarchyGrabStartX = 400, autoHierarchyGrabStartY = 0;
		const separationOrbit = {cx: 0, cy: 0, radius: 400};
		const separationCircle = circle;
		${updateBody}
		return updateSeparationCircle;
	`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
	const update = new Function('circle', code).call({ cy: { zoom: () => zoom, pan: () => ({ x: 0, y: 0 }) } }, circle);
	return { circle, move(pixels) { position = { x: 400 + pixels / zoom, y: 0 }; update({ position: () => position }); } };
}
for (const zoom of [0.5, 1, 2]) {
	test(`separation feedback at zoom ${zoom} ignores clicks and small movements until 12 screen pixels`, () => {
		const state = feedback(zoom);
		state.move(0);
		assert.equal(state.circle.style.display, 'none');
		state.move(8);
		assert.equal(state.circle.style.display, 'none');
		state.move(12);
		assert.equal(state.circle.style.display, 'block');
		assert.equal(Number(state.circle.attributes.r), 400 * zoom);
		state.move(100);
		assert.equal(Number(state.circle.attributes.r), 400 * zoom);
	});
}
