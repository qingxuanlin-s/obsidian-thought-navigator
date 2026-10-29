const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const cytoscape = require('cytoscape');
const cache = new Map();
function load(file) {
	file = path.normalize(file);
	if (cache.has(file)) return cache.get(file).exports;
	const mod = { exports: {} }; cache.set(file, mod);
	const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
	new Function('require', 'module', 'exports', code)(name => load(name.startsWith('.') ? path.join(path.dirname(file), name) : name), mod, mod.exports);
	return mod.exports;
}
const { GRAPH_STYLES, getGraphStyle, getGraphTheme, applyViewTheme } = load('src/renderer/theme');
const { buildStylesheet } = load('src/renderer/stylesheet');
const colors = load('src/renderer/colorMath');
const deps = {
	...colors, FIRST_LEVEL_NODE_FONT_SIZE: 24, ROOT_NODE_FONT_SIZE: 32,
	ROOT_TO_FIRST_LEVEL_EDGE_WIDTH: 3, ROOT_TO_FIRST_LEVEL_EDGE_OPACITY: 0.9,
	ACTIVE_ROOT_TO_FIRST_LEVEL_EDGE_OPACITY: 1, SECONDARY_PARENT_EDGE_OPACITY: 0.8,
	measureNodeLabel: () => ({ width: 200, height: 80, lineCount: 1 }),
	measureTextWidthCanvas: () => 160,
	compensateFreeLikeNodeFrameSize: (width, height) => ({ width, height }),
};
function contrast(a, b) {
	const lum = hex => {
		const rgb = colors.hexToRgb(hex);
		const values = [rgb.r, rgb.g, rgb.b].map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
		return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
	};
	const values = [lum(a), lum(b)].sort((x, y) => y - x);
	return (values[0] + 0.05) / (values[1] + 0.05);
}
for (const themeStyle of Object.keys(GRAPH_STYLES)) for (const themeMode of ['light', 'dark']) {
	test(`${themeStyle}/${themeMode}: resolves independent mode, branch, preview, and canvas rules`, () => {
		const options = { themeStyle, themeMode };
		const theme = getGraphTheme(options), style = getGraphStyle(options);
		assert.equal(theme.isLight, themeMode === 'light');
		const preview = style.preview(theme, '#d07a8a');
		assert.ok(preview.cardBorder && preview.textColor && preview.selectedBorder);
		const cy = cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' }, style: buildStylesheet(options, deps), elements: [
			{ data: { id: 'root', label: '根节点', isRoot: true } },
			{ data: { id: 'first', label: '一级节点', isFirstLevelNode: true, branchNodeBorder: '#d07a8a' } },
			{ data: { id: 'leaf', label: '普通节点', branchNodeBorder: '#d07a8a' } },
		] });
		try {
			cy.$id('first').select();
			const rgb = cy.$id('first').style('color').match(/\d+/g).map(Number);
			assert.ok(contrast(colors.rgbToHex(...rgb), theme.node.backgroundSelected) >= 7);
			if (themeMode === 'dark') assert.equal(cy.$id('first').style('color'), 'rgb(255,255,255)');
			if (themeStyle === 'nebula' && themeMode === 'dark') {
				assert.equal(cy.$id('first').style('background-fill'), 'solid');
				assert.equal(cy.$id('first').style('underlay-opacity'), '0');
				assert.ok(contrast(theme.node.textSelected, theme.node.backgroundSelected) >= 7);
			}
		} finally { cy.destroy(); }
	});
}
test('dark Nebula normal, secondary, preview, and selected text meet readable contrast without opacity filters', () => {
	const theme = getGraphTheme({ themeStyle: 'nebula', themeMode: 'dark' });
	assert.ok(contrast(theme.node.text, theme.node.background) >= 7);
	assert.ok(contrast(theme.node.textMuted, theme.node.background) >= 7);
	assert.ok(contrast(theme.node.firstLevelText, theme.node.firstLevelFallback) >= 7);
	const preview = getGraphStyle({ themeStyle: 'nebula' }).preview(theme, null);
	assert.equal(preview.opacity, '1'); assert.equal(preview.filter, 'none');
	assert.ok(contrast(preview.textColor, preview.cardBackground) >= 7);
	assert.ok(contrast(preview.headerText, preview.headerBackground) >= 4.5);
});
test('theme switches remove stale classes and invalid styles fall back consistently', () => {
	const classes = new Set(['zk-view-content']);
	const element = { classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)) } };
	for (const themeStyle of Object.keys(GRAPH_STYLES)) for (const themeMode of ['dark', 'light']) {
		applyViewTheme(element, { themeStyle, themeMode });
		assert.deepEqual([...classes].filter(n => n.startsWith('zk-theme-')), [`zk-theme-${themeMode}`]);
		assert.deepEqual([...classes].filter(n => n.startsWith('zk-style-')), [`zk-style-${themeStyle}`]);
	}
	assert.equal(getGraphStyle({ themeStyle: 'missing' }), GRAPH_STYLES.modern);
});

test('branch strategies retain modern colors and give Nebula an accent without a blurred shadow', () => {
	const light = getGraphTheme({ themeMode: 'light' });
	const dark = getGraphTheme({ themeMode: 'dark' });
	assert.equal(GRAPH_STYLES.default.branch, null);
	assert.equal(GRAPH_STYLES.modern.branch(light, '#173f36', '#5bbf9a').shadow, 'transparent');
	assert.equal(GRAPH_STYLES.modern.branch(dark, '#173f36', '#5bbf9a').background, '#173f36');
	assert.deepEqual(GRAPH_STYLES.nebula.branch(dark, '#173f36', '#5bbf9a'), { background: '#173f36', border: '#5bbf9a', shadow: 'transparent' });
});
