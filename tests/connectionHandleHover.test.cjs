const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const cytoscape = require('cytoscape');
const source = fs.readFileSync(require.resolve('../src/renderer/edgeControls.ts'), 'utf8');
const start = source.indexOf('\t\t\t// 选中节点时操作柄持续可见');
const block = source.slice(start, source.indexOf('\t\t\tthis.bindConnectionDrag(handle, node);', start));
const compiled = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
class Handle extends EventTarget {
	style = { opacity: '0', display: 'none' };
	setCssStyles(styles) { Object.assign(this.style, styles); }
}
function setup() {
	const cy = cytoscape({ headless: true, elements: [{ data: { id: 'child' } }] });
	const node = cy.$id('child'), handle = new Handle();
	const timers = new Map(); let nextId = 0;
	const clock = { setTimeout(fn) { timers.set(++nextId, fn); return nextId; }, clearTimeout(id) { timers.delete(id); } };
	new Function('node', 'nodeId', 'handle', 'updateHandlePosition', 'window', compiled)
		.call({ isEdgeSelected: false, deps: { getContainer: () => null } }, node, 'child', handle,
			() => { handle.style.display = handle.style.opacity === '1' ? 'block' : 'none'; }, clock);
	return { cy, node, handle, timers, tick() { const queued = [...timers.values()]; timers.clear(); queued.forEach(fn => fn()); } };
}
test('late canvas mouseout cannot hide the button while the pointer remains on it', () => {
	const env = setup();
	try {
		env.node.emit('mouseover');
		env.handle.dispatchEvent(new Event('mouseenter'));
		env.node.emit('mouseout');
		for (let i = 0; i < 5; i++) env.tick();
		assert.equal(env.handle.style.opacity, '1');
		assert.equal(env.handle.style.display, 'block');
		env.handle.dispatchEvent(new Event('mouseleave'));
		env.tick();
		assert.equal(env.handle.style.display, 'none');
	} finally { env.cy.destroy(); }
});
test('entering the handle cancels a pending hide, and even an already queued callback rechecks hover', () => {
	const env = setup();
	try {
		env.node.emit('mouseover'); env.node.emit('mouseout');
		const pending = [...env.timers.values()][0];
		assert.ok(pending);
		env.handle.dispatchEvent(new Event('mouseenter'));
		assert.equal(env.timers.size, 0);
		pending();
		assert.equal(env.handle.style.display, 'block');
	} finally { env.cy.destroy(); }
});
test('returning to the node or selecting it keeps the handle visible', () => {
	const env = setup();
	try {
		env.node.emit('mouseover'); env.node.emit('mouseout');
		env.handle.dispatchEvent(new Event('mouseenter'));
		env.handle.dispatchEvent(new Event('mouseleave'));
		env.node.emit('mouseover'); env.tick();
		assert.equal(env.handle.style.display, 'block');
		env.node.emit('mouseout'); env.node.select(); env.tick();
		assert.equal(env.handle.style.display, 'block');
		env.node.unselect(); env.tick();
		assert.equal(env.handle.style.display, 'none');
	} finally { env.cy.destroy(); }
});
