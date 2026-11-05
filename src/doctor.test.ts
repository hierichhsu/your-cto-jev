import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { providers } from './api.js';
import { doctor } from './doctor.js';
import { setup } from './setup.js';

// a developer's global core.hooksPath or commit.gpgsign must not reach the temp repos; child git inherits process.env
process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'cto-gitconfig-')), 'gitconfig');
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read the user's real keys and prefs
process.env.CTO_NO_UPDATE_CHECK = '1';
for (const p of Object.values(providers)) for (const k of p.keys) delete process.env[k]; // no live probes

test('doctor flags a git hook whose cto block is from an older version, but not a CRLF copy of the current one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-doctor-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  setup(root, 'en', { agents: ['claude'] });
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  const text = async () => (await doctor(root, 'en')).lines.join('\n');

  let out = await text();
  assert.match(out, /OK git pre-commit installed/);
  assert.doesNotMatch(out, /older than this version/);

  writeFileSync(hook, readFileSync(hook, 'utf8').replace(/\n/g, '\r\n'));
  assert.doesNotMatch(await text(), /older than this version/, 'CRLF alone is not stale');

  // the ≤0.9.8 block: no exit-status guard as its first line
  writeFileSync(hook, readFileSync(hook, 'utf8').replace(/\r\n/g, '\n').replace('s=$?; [ $s -eq 0 ] || exit $s\n', ''));
  out = await text();
  assert.match(out, /!! git pre-commit hook block is from an older cto/);
  assert.match(out, /older than this version \(pre-commit hook\)\. Run cto setup --refresh/);
  assert.doesNotMatch(out, /pre-push hook/);

  setup(root, 'en', { agents: ['claude'] });
  assert.doesNotMatch(await text(), /older than this version/, 'cto setup brings it current');
});

test('doctor finds the hooks setup wrote in a husky repo (core.hooksPath = .husky/_)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cto-doctor-husky-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
  setup(root, 'en', { agents: ['claude'] });
  const out = (await doctor(root, 'en')).lines.join('\n');
  assert.match(out, /OK git pre-commit installed/);
  assert.match(out, /OK git pre-push installed/);
  assert.doesNotMatch(out, /!! .*pre-(commit|push)/);
});
