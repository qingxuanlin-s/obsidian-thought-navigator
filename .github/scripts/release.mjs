import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ASSETS = ['main.js', 'manifest.json', 'styles.css'];

export function validateMetadata(manifest, pkg, lock, versions) {
	const { version, minAppVersion } = manifest;
	assert.match(version, /^\d+\.\d+\.\d+$/, 'manifest.version must be a numeric version');
	assert.equal(pkg.version, version, 'package.json version differs from manifest.json');
	assert.equal(lock.version, version, 'package-lock.json version differs from manifest.json');
	assert.equal(lock.packages[''].version, version, 'package-lock root version differs');
	assert.equal(versions[version], minAppVersion, 'versions.json is missing the matching minimum app version');
	return { version, minAppVersion };
}

export function published(release) {
	return !!release && !release.draft && ASSETS.every(name => release.assets?.some(asset => asset.name === name && asset.size > 0));
}

export function planRelease(metadata, context, release, tagSha) {
	if (context.refType === 'tag') assert.equal(context.refName, metadata.version, 'Pushed tag must match manifest.version');
	if (published(release)) return { shouldRelease: false, version: metadata.version };
	if (tagSha) assert.equal(tagSha, context.sha, 'Existing version tag points to another commit; rerun the original workflow instead of overwriting it');
	return { shouldRelease: true, version: metadata.version };
}

export function releaseNotes(metadata, entries) {
	const entry = entries.find(item => item.version === metadata.version);
	assert.ok(entry?.highlights?.length, `Missing changelog for ${metadata.version}`);
	assert.ok(entry.highlights.every(item => item.zh && item.en), 'Changelog must include Chinese and English');
	return `## 更新内容\n\n${entry.highlights.map(item => '- ' + item.zh).join('\n')}\n\n## Changes\n\n${entry.highlights.map(item => '- ' + item.en).join('\n')}\n\n最低 Obsidian 版本：${metadata.minAppVersion}。安装文件：${ASSETS.join('、')}。\n`;
}

export function verifyAssets(release, expected) {
	for (const [name, data] of Object.entries(expected)) {
		const asset = release.assets.find(item => item.name === name);
		assert.ok(asset, `Release asset missing: ${name}`);
		assert.equal(asset.size, data.size, `Release asset size mismatch: ${name}`);
		if (asset.digest) assert.equal(asset.digest, data.digest, `Release asset checksum mismatch: ${name}`);
	}
}

export async function tagCommit(api, version) {
	const ref = await api(`git/ref/tags/${version}`, { allowMissing: true });
	if (!ref) return null;
	let object = ref.object;
	for (let depth = 0; object.type === 'tag'; depth++) {
		assert.ok(depth < 8, 'Excessive nested annotated tags');
		object = (await api(`git/tags/${object.sha}`)).object;
	}
	assert.equal(object.type, 'commit', 'Release tag must point to a commit');
	return object.sha;
}

export async function publishRelease({ api, metadata, context, body, expected, upload }) {
	let release = await api(`releases/tags/${metadata.version}`, { allowMissing: true });
	const tagSha = published(release) ? null : await tagCommit(api, metadata.version);
	if (!planRelease(metadata, context, release, tagSha).shouldRelease) return release;
	if (!tagSha) await api('git/refs', { method: 'POST', data: { ref: `refs/tags/${metadata.version}`, sha: context.sha } });
	if (!release) release = await api('releases', { method: 'POST', data: {
		tag_name: metadata.version, target_commitish: context.sha, name: metadata.version, body, draft: true,
	} });
	await upload(metadata.version);
	release = await api(`releases/tags/${metadata.version}`);
	verifyAssets(release, expected);
	return api(`releases/${release.id}`, { method: 'PATCH', data: { body, draft: false, make_latest: 'true' } });
}

async function main(command) {
	const read = file => JSON.parse(readFileSync(file, 'utf8'));
	const metadata = validateMetadata(read('manifest.json'), read('package.json'), read('package-lock.json'), read('versions.json'));
	const repository = process.env.GITHUB_REPOSITORY;
	assert.match(repository || '', /^[\w.-]+\/[\w.-]+$/, 'GITHUB_REPOSITORY is required');
	assert.ok(process.env.GH_TOKEN, 'GH_TOKEN is required');
	const api = async (path, { method = 'GET', data, allowMissing = false } = {}) => {
		const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/${path}`, {
			method,
			headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
			...(data ? { body: JSON.stringify(data) } : {}),
		});
		if (response.status === 404 && allowMissing) return null;
		const value = await response.json();
		assert.ok(response.ok, `GitHub API ${response.status}: ${value.message || path}`);
		return value;
	};
	const context = {
		sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
	};
	if (command === 'prepare') {
		const release = await api(`releases/tags/${metadata.version}`, { allowMissing: true });
		const tagSha = published(release) ? null : await tagCommit(api, metadata.version);
		const plan = planRelease(metadata, context, release, tagSha);
		assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required');
		appendFileSync(process.env.GITHUB_OUTPUT, `version=${plan.version}\nshould_release=${plan.shouldRelease}\n`);
		console.log(plan.shouldRelease ? `Preparing ${plan.version} from ${context.sha}` : `${plan.version} is already published; skipping`);
		return;
	}
	assert.equal(command, 'publish', 'Usage: release.mjs prepare|publish');
	const require = createRequire(import.meta.url);
	const ts = require('typescript');
	const compiled = ts.transpileModule(readFileSync('src/utils/changelog.ts', 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('module', 'exports', compiled)(loaded, loaded.exports);
	const body = releaseNotes(metadata, loaded.exports.CHANGELOG);
	const expected = Object.fromEntries(ASSETS.map(name => {
		const data = readFileSync(name);
		assert.ok(data.length > 0, `Empty release asset: ${name}`);
		return [name, { size: data.length, digest: 'sha256:' + createHash('sha256').update(data).digest('hex') }];
	}));
	const release = await publishRelease({ api, metadata, context, body, expected,
		upload: version => execFileSync('gh', ['release', 'upload', version, ...ASSETS, '--clobber', '--repo', repository], { stdio: 'inherit' }),
	});
	console.log(release.html_url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
