const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const cytoscape = require('cytoscape');
const source = fs.readFileSync(require.resolve('../src/renderer/overlayScheduler.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { OverlayScheduler } = loaded.exports;
function setup() {
	const frames = [];
	global.window = { requestAnimationFrame: fn => frames.push(fn), setTimeout, clearTimeout };
	const cy = cytoscape({ headless: true, layout: { name: 'preset' }, elements: [{ data: { id: 'a' }, position: { x: 0, y: 0 } }] });
	const scheduler = new OverlayScheduler({ getCy: () => cy, getContainer: () => ({ isConnected: true }) });
	scheduler.bindListeners();
	return { cy, scheduler, frames, close() { scheduler.cleanupEventBindings(); scheduler.cleanupScheduler(); cy.destroy(); } };
}
test('node overlays match the canvas in the same render, with no duplicate next-frame update', () => {
	const env = setup();
	try {
		const node = env.cy.$id('a');
		let overlayX = 0, calls = 0;
		env.scheduler.updaters.add(() => { overlayX = node.position('x'); calls++; });
		node.position({ x: 200, y: 80 });
		assert.equal(overlayX, 0);
		env.cy.on('render', () => assert.equal(overlayX, node.position('x')));
		env.cy.emit('render');
		assert.equal(calls, 1);
		env.frames.splice(0).forEach(fn => fn());
		assert.equal(calls, 1);
		env.cy.emit('render');
		assert.equal(calls, 1);
	} finally { env.close(); }
});
test('collapse and expand update DOM visibility before that canvas frame is presented', () => {
	const env = setup();
	try {
		const node = env.cy.$id('a');
		let overlayVisible = true;
		const painted = [];
		env.scheduler.updaters.add(() => { overlayVisible = !node.hasClass('collapsed'); });
		env.cy.on('render', () => painted.push(overlayVisible));
		node.addClass('collapsed'); env.cy.emit('render');
		node.removeClass('collapsed'); env.cy.emit('render');
		assert.deepEqual(painted, [false, true]);
	} finally { env.close(); }
});
test('extra updates requested during a pending normal update are kept and shared updaters run once', () => {
	const env = setup();
	try {
		let regular = 0, extra = 0, immediate = 0;
		const shared = () => regular++;
		env.scheduler.updaters.add(shared);
		env.scheduler.immediateUpdaters.add(shared);
		env.scheduler.extraUpdaters.add(shared);
		env.scheduler.extraUpdaters.add(() => extra++);
		env.scheduler.immediateUpdaters.add(() => immediate++);
		env.scheduler.schedule(); env.scheduler.scheduleExtra();
		env.cy.emit('render');
		env.frames.splice(0).forEach(fn => fn());
		assert.deepEqual({ regular, extra, immediate }, { regular: 1, extra: 1, immediate: 1 });
	} finally { env.close(); }
});
test('scheduled fallback works without a canvas paint and cleanup discards pending work', () => {
	const env = setup();
	try {
		let calls = 0;
		env.scheduler.updaters.add(() => calls++);
		env.scheduler.scheduleExtra(); env.frames.shift()();
		assert.equal(calls, 1);
		env.scheduler.schedule(); env.scheduler.cleanupScheduler();
		env.frames.splice(0).forEach(fn => fn()); env.cy.emit('render');
		assert.equal(calls, 1);
	} finally { env.close(); }
});
