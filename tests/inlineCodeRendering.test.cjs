const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

// Exercise the actual inline renderer without booting Obsidian or Cytoscape.
const source = fs.readFileSync(require.resolve('../src/renderer/nodeBadges.ts'), 'utf8');
const ast = ts.createSourceFile('nodeBadges.ts', source, ts.ScriptTarget.Latest, true);
let initializer;
function visit(node) {
	if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'applyRoughInlineMarkdown') {
		initializer = node.initializer.getText(ast);
	}
	ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(initializer, 'inline renderer exists');
const compiled = ts.transpileModule(`const render = ${initializer};`, {
	compilerOptions: { target: ts.ScriptTarget.ES2018 },
}).outputText;

const utilitySource = fs.readFileSync(require.resolve('../src/utils/inlineMarkdown.ts'), 'utf8');
const utilityModule = { exports: {} };
const utilityCompiled = ts.transpileModule(utilitySource, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2018 },
}).outputText;
new Function('require', 'module', 'exports', utilityCompiled)(require, utilityModule, utilityModule.exports);
const { renderInlineMarkdown, parseInlineMarkdown } = utilityModule.exports;

class Element {
	constructor(tagName, text = '') {
		this.tagName = tagName;
		this.textContent = text;
		this.children = [];
		this.dataset = {};
		this.style = {};
		this.ownerDocument = activeDocument;
	}
	appendChild(child) { this.children.push(child); }
	addEventListener() {}
}
const activeDocument = {
	createElement: tagName => new Element(tagName),
	createTextNode: text => new Element('#text', text),
};
const render = new Function('activeDocument', 'renderInlineMarkdown', `${compiled}\nreturn render;`)(activeDocument, renderInlineMarkdown);
function parts(input) {
	const root = new Element('div');
	render(root, input);
	const text = child => child.textContent + child.children.map(text).join('');
	return root.children.map(child => [child.tagName, text(child)]);
}

test('renders the reported symbols as separate inline code spans', () => {
	assert.deepEqual(parts('知道了 `∀`、`∃`、`∈`'), [
		['#text', '知道了 '], ['code', '∀'], ['#text', '、'],
		['code', '∃'], ['#text', '、'], ['code', '∈'],
	]);
});

test('preserves Markdown, HTML, links, and formulas literally inside code', () => {
	const literal = '**bold** <span>text</span> [[note]] https://example.com $x$';
	assert.deepEqual(parts('`' + literal + '`'), [['code', literal]]);
});

test('matches equal backtick runs and preserves enclosed single backticks', () => {
	assert.deepEqual(parts('`` `value` ``'), [['code', '`value`']]);
	assert.deepEqual(parts('```a``b```'), [['code', 'a``b']]);
	assert.deepEqual(parts('``value`'), [['#text', '``value`']]);
	assert.deepEqual(parts('`value'), [['#text', '`value']]);
});

test('normalizes padding without removing meaningful spaces', () => {
	assert.deepEqual(parts('` value `'), [['code', 'value']]);
	assert.deepEqual(parts('`  `'), [['code', '  ']]);
	assert.deepEqual(parts('` value`'), [['code', ' value']]);
});

test('keeps adjacent bold text working', () => {
	assert.deepEqual(parts('**知道了** `∀`'), [
		['strong', '知道了'], ['#text', ' '], ['code', '∀'],
	]);
});

function tree(input) {
	const root = new Element('div');
	render(root, input);
	const serialize = element => [element.tagName, element.textContent, element.children.map(serialize)];
	return root.children.map(serialize);
}

test('supports nested code, emphasis, and bold instead of treating inner markup as text', () => {
	assert.deepEqual(tree('**a `b` *c***'), [
		['strong', '', [
			['#text', 'a ', []], ['code', 'b', []], ['#text', ' ', []],
			['em', '', [['#text', 'c', []]]],
		]],
	]);
});

test('uses standard double underscore bold and supports strikethrough', () => {
	assert.deepEqual(tree('__bold__ ~~gone~~'), [
		['strong', '', [['#text', 'bold', []]]], ['#text', ' ', []],
		['s', '', [['#text', 'gone', []]]],
	]);
});

test('respects escaped delimiters and decodes entities', () => {
	assert.deepEqual(parts('\\*literal\\* &amp; \\`value\\`'), [
		['#text', '*literal* & `value`'],
	]);
});

test('retains wiki aliases, embed targets/sizes, and math tokens', () => {
	const tokens = parseInlineMarkdown('[[笔记#标题|别名]] ![[图.png|120x80]] $x$ $$y$$');
	assert.deepEqual(tokens.filter(t => t.type.startsWith('zk_')).map(t => [t.type, t.content, t.markup]), [
		['zk_wikilink', '笔记#标题|别名', ''], ['zk_embed', '图.png|120x80', ''],
		['zk_math', 'x', '$'], ['zk_math', 'y', '$$'],
	]);
});

test('does not parse escaped or code-contained wiki links and math', () => {
	const tokens = parseInlineMarkdown(String.raw`\[[笔记]] \$x$` + ' `[[笔记]] $x$`');
	assert.equal(tokens.some(t => t.type.startsWith('zk_')), false);
	assert.equal(tokens.find(t => t.type === 'code_inline').content, '[[笔记]] $x$');
});

test('retains nested toolbar underline and styled span formatting', () => {
	assert.deepEqual(tree('<u>**a** <span style="color:red">`b`</span></u>'), [
		['u', '', [
			['strong', '', [['#text', 'a', []]]], ['#text', ' ', []],
			['span', '', [['code', 'b', []]]],
		]],
	]);
	const root = new Element('div');
	render(root, '<span style="color:red">red</span>');
	assert.equal(root.children[0].style.cssText, 'color:red');
});

test('does not turn arbitrary HTML or event attributes into elements', () => {
	const root = new Element('div');
	render(root, '<img src=x onerror="alert(1)"><script>alert(1)</script><u onclick="alert(1)">x</u>');
	assert.equal(root.children.some(t => t.tagName !== '#text'), false);
});

test('parses nested link labels and rejects unsafe link protocols', () => {
	assert.deepEqual(tree('[**bold**](https://example.com "title")'), [
		['a', '', [['strong', '', [['#text', 'bold', []]]]]],
	]);
	assert.equal(parseInlineMarkdown('[x](javascript:alert(1))').some(t => t.type === 'link_open'), false);
});

test('recognizes bare http and www links', () => {
	assert.equal(parseInlineMarkdown('https://example.com www.example.com').filter(t => t.type === 'link_open').length, 2);
});

test('retains unmatched markers as text', () => {
	assert.deepEqual(parts('a **b [[c $d'), [['#text', 'a **b [[c $d']]);
});

test('delegates custom tokens to the existing link, embed, and math handlers', () => {
	const calls = [];
	const root = new Element('div');
	const handler = name => (...args) => {
		calls.push([name, ...args]);
		return new Element(name);
	};
	renderInlineMarkdown(root, '**[[笔记|别名]]** ![[图.png|80]] $x$ $$y$$', {
		createExternalLink: handler('external'),
		createInternalLink: handler('internal'),
		createEmbed: handler('embed'),
		renderMath: handler('math'),
	});
	assert.deepEqual(calls, [
		['internal', '笔记|别名'], ['embed', '图.png|80'],
		['math', 'x', false], ['math', 'y', true],
	]);
	assert.equal(root.children[0].tagName, 'strong');
	assert.equal(root.children[0].children[0].tagName, 'internal');
});
