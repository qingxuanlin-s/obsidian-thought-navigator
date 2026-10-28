const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(require.resolve('../src/renderer/previewEvents.ts'), 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { interceptPreviewWheel } = loaded.exports;
class Container extends EventTarget {
	insidePreview = true;
	closest() { return this.insidePreview ? this : null; }
}
function wheel(container, ctrlKey = false) {
	const event = new Event('wheel', { cancelable: true });
	Object.assign(event, { ctrlKey });
	container.dispatchEvent(event);
	return event;
}
test('first preview wheel is intercepted before the canvas capture listener, with native scrolling allowed', () => {
	const container = new Container();
	interceptPreviewWheel(container);
	let canvasCalls = 0;
	container.addEventListener('wheel', () => canvasCalls++, { capture: true });
	assert.equal(wheel(container).defaultPrevented, false);
	assert.equal(wheel(container).defaultPrevented, false);
	assert.equal(canvasCalls, 0);
	container.insidePreview = false;
	wheel(container);
	assert.equal(canvasCalls, 1);
});
test('pinch zoom inside a preview cannot zoom the application; cleanup releases the listener', () => {
	const container = new Container();
	const cleanup = interceptPreviewWheel(container);
	assert.equal(wheel(container, true).defaultPrevented, true);
	cleanup();
	assert.equal(wheel(container, true).defaultPrevented, false);
});
