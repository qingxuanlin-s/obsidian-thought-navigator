const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const cytoscape = require('cytoscape');

const source = fs.readFileSync(require.resolve('../src/renderer/embedPreview.ts'), 'utf8');
class Element extends EventTarget {
	interactive = false;
	style = {};
	setCssStyles(styles) { Object.assign(this.style, styles); }
	closest() { return this.interactive ? this : null; }
}
function mouse(target, type, extra = {}) {
	const event = new Event(type, { cancelable: true });
	Object.assign(event, { button: 0, detail: 1, clientX: 100, clientY: 100, ...extra });
	target.dispatchEvent(event);
}
function setup(kind, readOnly = false) {
	const from = kind === 'preview' ? '            let draggingFromHeader' : '            let draggingCard';
	const to = kind === 'preview' ? "            headerEl.addEventListener('dblclick'" : '            // 右下角拖拽调整尺寸';
	const start = source.indexOf(from);
	const block = source.slice(start, source.indexOf(to, start));
	const compiled = ts.transpileModule(`let headerWasDragged = false;\n${block}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
	const cy = cytoscape({ headless: true, layout: { name: 'preset' }, elements: [{ data: { id: 'child' }, position: { x: 200, y: 100 } }] });
	cy.zoom(1.5); cy.pan({ x: 50, y: 70 });
	const node = cy.$id('child');
	const content = new Element(), header = new Element(), img = new Element(), card = new Element(), doc = new EventTarget();
	const events = [];
	cy.on('grab drag dragfree free', 'node', (event, original) => events.push({ type: event.type, original }));
	const renderer = { cy, activeOverlayDragAborters: new Set(), isReadOnlyMode: () => readOnly };
	new Function('node', 'contentEl', 'headerEl', 'img', 'card', 'activeDocument', 'setCanvasInteractionSuppressed', compiled)
		.call(renderer, node, content, header, img, card, doc, () => {});
	return { cy, node, content, header, img, doc, events, renderer, target: kind === 'preview' ? header : img };
}
for (const kind of ['preview', 'image']) {
	test(`${kind} drag uses canvas lifecycle once, including the original mouse event`, () => {
		const env = setup(kind);
		try {
			mouse(env.target, 'mousedown');
			assert.deepEqual(env.events.map(e => e.type), ['grab']);
			mouse(env.doc, 'mousemove', { clientX: 250, clientY: 190, altKey: true });
			assert.deepEqual(env.node.position(), { x: 300, y: 160 });
			assert.equal(env.events[1].original.altKey, true);
			mouse(env.doc, 'mouseup');
			assert.deepEqual(env.events.map(e => e.type), ['grab', 'drag', 'dragfree', 'free']);
			assert.equal(env.renderer.activeOverlayDragAborters.size, 0);
			mouse(env.doc, 'mousemove', { clientX: 500 });
			assert.deepEqual(env.node.position(), { x: 300, y: 160 });
		} finally { env.cy.destroy(); }
	});
	test(`${kind} click does not trigger drag persistence; read-only preview does not drag`, () => {
		const env = setup(kind), readOnly = setup(kind, true);
		try {
			mouse(env.target, 'mousedown'); mouse(env.doc, 'mouseup');
			assert.deepEqual(env.events.map(e => e.type), ['grab', 'free']);
			mouse(readOnly.target, 'mousedown'); mouse(readOnly.doc, 'mousemove', { clientX: 400 });
			assert.deepEqual(readOnly.events, []);
		} finally { env.cy.destroy(); readOnly.cy.destroy(); }
	});
}
test('preview content does not drag; header controls remain interactive', () => {
	const env = setup('preview');
	try {
		mouse(env.content, 'mousedown');
		mouse(env.doc, 'mousemove', { clientX: 400 });
		assert.deepEqual(env.events, []);
		assert.deepEqual(env.node.position(), { x: 200, y: 100 });
		env.header.interactive = true;
		mouse(env.header, 'mousedown');
		assert.deepEqual(env.events, []);
		env.header.interactive = false;
		mouse(env.header, 'mousedown');
		assert.equal(env.events[0].type, 'grab');
		mouse(env.doc, 'mouseup');
	} finally { env.cy.destroy(); }
});
