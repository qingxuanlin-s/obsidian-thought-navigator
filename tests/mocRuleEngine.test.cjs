const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(require.resolve('../src/utils/mocRuleEngine.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleForTest = { exports: {} };
const stubRequire = () => ({ createEmptyMOCJson: layout => JSON.stringify({ version: 1, nodes: [], nodePositions: {}, nodeLayoutStyle: layout }) });
new Function('require', 'module', 'exports', compiled)(stubRequire, moduleForTest, moduleForTest.exports);
const { previewMocRules, mocJsonFromPreview } = moduleForTest.exports;

const files = [
    { path: 'Notes/a 你好.md', basename: 'a 你好', folder: 'Notes', properties: { topic: 'Tree', code: 'a' } },
    { path: 'Notes/a.1 你好的父亲.md', basename: 'a.1 你好的父亲', folder: 'Notes', properties: { topic: 'Tree', code: 'a.1' } },
    { path: 'Notes/a.1.a 你好.md', basename: 'a.1.a 你好', folder: 'Notes', properties: { topic: 'Tree', code: 'a.1.a' } },
    { path: 'Other/b.1 Else.md', basename: 'b.1 Else', folder: 'Other', properties: { topic: 'Other', code: 'b.1' } },
];
const rules = {
    groupJoin: 'and',
    groups: [
        { join: 'or', conditions: [
            { field: 'folder', operator: 'equals', value: 'Notes' },
            { field: 'property', property: 'topic', operator: 'equals', value: 'Other' },
        ] },
        { join: 'and', conditions: [{ field: 'filename', operator: 'contains', value: '.' }] },
    ],
    parentSource: 'filename', parentProperty: '', separator: '.', stopMarker: ' ', rootPath: '',
};

test('condition joins filter file, folder, and property', () => {
    const result = previewMocRules(files, rules);
    assert.deepEqual(result.matched.map(file => file.basename), ['a.1 你好的父亲', 'a.1.a 你好', 'b.1 Else']);
    assert.equal(result.roots.length, 2);
    assert.equal(result.roots[0].children[0].file.basename, 'a.1.a 你好');
});

test('OR between groups admits files from either group', () => {
    const result = previewMocRules(files, { ...rules, groupJoin: 'or' });
    assert.equal(result.matched.length, 4);
});

test('explicit root and stop marker produce the requested three-level tree', () => {
    const result = previewMocRules(files, { ...rules, groups: [], rootPath: 'Notes/a 你好.md' });
    assert.equal(result.included, 3);
    assert.equal(result.excludedByRoot, 1);
    assert.equal(result.roots[0].file.basename, 'a 你好');
    assert.equal(result.roots[0].children[0].file.basename, 'a.1 你好的父亲');
    assert.equal(result.roots[0].children[0].children[0].file.basename, 'a.1.a 你好');
    const json = JSON.parse(mocJsonFromPreview(result, 'auto'));
    assert.equal(json.nodes[0].nodeID, 'a');
    assert.equal(json.nodes[0].children[0].nodeID, 'a.1');
    assert.equal(json.nodes[0].children[0].children[0].nodeID, 'a.1.a');
    assert.equal(json.nodes[0].children[0].children[0].target, 'Notes/a.1.a 你好.md');
});

test('property keys support hierarchy and a missing intermediate ancestor', () => {
    const result = previewMocRules([files[0], files[2]], {
        ...rules, groups: [], parentSource: 'property', parentProperty: 'code', rootPath: 'Notes/a 你好.md',
    });
    assert.equal(result.roots[0].children[0].file.path, files[2].path);
    const json = JSON.parse(mocJsonFromPreview(result, 'auto'));
    assert.equal(json.nodes[0].children[0].nodeID, 'a.1');
});

test('invalid or unmatched root cannot silently create the wrong tree', () => {
    assert.throws(() => previewMocRules(files, { ...rules, rootPath: 'Notes/a 你好.md' }), /root does not match/);
    assert.throws(() => previewMocRules(files, { ...rules, separator: '' }), /separator/);
});
