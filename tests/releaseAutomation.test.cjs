const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const automation = import(pathToFileURL(path.join(__dirname, '../.github/scripts/release.mjs')));
const metadata = { version: '0.3.12', minAppVersion: '1.8.7' };
const context = { sha: 'new-commit', refType: 'branch', refName: 'master' };
const expected = Object.fromEntries(['main.js', 'manifest.json', 'styles.css'].map(name => [name, { size: 42, digest: 'sha256:test' }]));
const completeAssets = () => Object.entries(expected).map(([name, value]) => ({ name, ...value }));

function server({ initialRelease = null, initialTag = null, badChecksum = false, uploadError = false } = {}) {
	let release = initialRelease, tag = initialTag;
	const calls = [];
	return {
		calls,
		get release() { return release; },
		get tag() { return tag; },
		async api(route, options = {}) {
			calls.push([options.method || 'GET', route, options.data]);
			if (route.startsWith('releases/tags/')) return structuredClone(release);
			if (route.startsWith('git/ref/tags/')) return tag ? { object: { type: 'commit', sha: tag } } : null;
			if (route === 'git/refs') { tag = options.data.sha; return { object: { type: 'commit', sha: tag } }; }
			if (route === 'releases') { release = { id: 1, assets: [], ...options.data }; return structuredClone(release); }
			if (route === 'releases/1') { Object.assign(release, options.data); return structuredClone(release); }
			throw new Error(`Unexpected route: ${route}`);
		},
		async upload(version) {
			assert.equal(version, metadata.version);
			assert.equal(release.draft, true, 'Assets should upload while the new release is still a draft');
			if (uploadError) throw new Error('Upload interrupted');
			release.assets = completeAssets();
			if (badChecksum) release.assets[0].digest = 'sha256:wrong';
		},
	};
}

test('version metadata must agree before any release mutation', async () => {
	const { validateMetadata } = await automation;
	const manifest = { version: '0.3.12', minAppVersion: '1.8.7' };
	const pkg = { version: '0.3.12' }, lock = { version: '0.3.12', packages: { '': { version: '0.3.12' } } };
	assert.deepEqual(validateMetadata(manifest, pkg, lock, { '0.3.12': '1.8.7' }), metadata);
	assert.throws(() => validateMetadata(manifest, { version: '0.3.11' }, lock, {}), /package.json/);
	assert.throws(() => validateMetadata(manifest, pkg, lock, {}), /versions.json/);
	assert.throws(() => validateMetadata({ ...manifest, version: '../bad' }, pkg, lock, {}), /numeric version/);
});

test('master push with an unpublished version creates its tag, uploads verified assets, then publishes', async () => {
	const { publishRelease } = await automation;
	const state = server();
	const released = await publishRelease({ ...state, api: state.api, upload: state.upload, metadata, context, expected, body: '中文 / English' });
	assert.equal(state.tag, context.sha);
	assert.equal(released.draft, false);
	assert.equal(released.make_latest, 'true');
	assert.equal(released.body, '中文 / English');
	assert.deepEqual(state.calls.filter(call => call[0] !== 'GET').map(call => call.slice(0, 2)), [['POST', 'git/refs'], ['POST', 'releases'], ['PATCH', 'releases/1']]);
});

test('repeated pushes of an already published version do not move its tag or replace assets', async () => {
	const { publishRelease, planRelease } = await automation;
	const release = { id: 1, draft: false, assets: completeAssets() };
	assert.equal(planRelease(metadata, context, release, 'old-commit').shouldRelease, false);
	const state = server({ initialRelease: release, initialTag: 'old-commit' });
	await publishRelease({ api: state.api, upload: () => assert.fail('Must not upload'), metadata, context, expected, body: 'notes' });
	assert.equal(state.tag, 'old-commit');
	assert.ok(state.calls.every(call => call[0] === 'GET'));
});

test('existing tags cannot silently be reassigned to a different commit', async () => {
	const { publishRelease, planRelease } = await automation;
	const state = server({ initialTag: 'old-commit' });
	await assert.rejects(publishRelease({ api: state.api, upload: state.upload, metadata, context, expected, body: 'notes' }), /another commit/);
	assert.ok(state.calls.every(call => call[0] === 'GET'));
	assert.throws(() => planRelease(metadata, { ...context, refType: 'tag', refName: '0.3.11' }, null, null), /Pushed tag/);
});

test('failed uploads and checksum mismatches leave the release unpublished', async () => {
	const { publishRelease } = await automation;
	for (const options of [{ badChecksum: true }, { uploadError: true }]) {
		const state = server(options);
		await assert.rejects(publishRelease({ api: state.api, upload: state.upload, metadata, context, expected, body: 'notes' }));
		assert.equal(state.release.draft, true);
		assert.ok(!state.calls.some(call => call[0] === 'PATCH'));
	}
});

test('a failed draft can be resumed using the same version and commit', async () => {
	const { publishRelease } = await automation;
	const state = server({ initialTag: context.sha, initialRelease: { id: 1, draft: true, assets: [] } });
	const result = await publishRelease({ api: state.api, upload: state.upload, metadata, context, expected, body: 'new notes' });
	assert.equal(result.draft, false);
	assert.ok(!state.calls.some(call => call[0] === 'POST'));
});

test('manual annotated tags are dereferenced, and release notes come directly from bilingual changelog entries', async () => {
	const { tagCommit, releaseNotes } = await automation;
	const sha = await tagCommit(async route => route.startsWith('git/ref/') ? { object: { type: 'tag', sha: 'tag-object' } } : { object: { type: 'commit', sha: context.sha } }, metadata.version);
	assert.equal(sha, context.sha);
	const notes = releaseNotes(metadata, [{ version: metadata.version, highlights: [{ zh: '修复悬停', en: 'Fix hover' }] }]);
	assert.match(notes, /修复悬停/); assert.match(notes, /Fix hover/); assert.match(notes, /1\.8\.7/);
	assert.throws(() => releaseNotes(metadata, []), /Missing changelog/);
});
