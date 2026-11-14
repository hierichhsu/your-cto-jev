import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODELS, credentialsPath, loadPrefs, modelsPrefs, savePrefs, type ModelsPrefs } from './brain.js';
import { MSG, advisorOf, applyModels, clearScope, driftCheck, fableReminder, isMainModel, isSubagentModel, switchScope, writeJsonIfUnchanged, writeTextIfUnchanged } from './models.js';
import { AGENT_FILES, RULES_BLOCK, SKILL_MARK, SKILL_PATH, SKILL_TEXT, VERSION_LINE, fileVersion, staleGuidance, syncGuidance, tooNew } from './skill.js';
import { currentVersion } from './update.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cto-models-'));
const write = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); };
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const CONSISTENT = { model: 'sonnet', advisorModel: 'fable', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } };

/** A fresh prefs file, home, project and (absent) managed file per test: nothing real is read or written. */
function fresh(models?: Partial<ModelsPrefs>) {
  process.env.APPDATA = process.env.XDG_CONFIG_HOME = tmp();
  if (models) savePrefs({ models: { ...DEFAULT_MODELS, ...models } });
  const home = tmp(), root = tmp();
  const user = join(home, '.claude', 'settings.json');
  const opts = { home, env: {}, managedPath: join(tmp(), 'managed-settings.json') };
  const agentsOk = () => { for (const [n, t] of Object.entries(AGENT_FILES)) write(join(home, '.claude', 'agents', n), t); };
  return { home, root, user, opts, agentsOk };
}

test('matchers: sonnet main, fable or Opus 5+ advisor, haiku subagent', () => {
  for (const v of ['sonnet', 'SONNET', 'claude-sonnet-4-6', 'claude-sonnet-5[1m]', 'sonnet[1m]']) assert.ok(isMainModel(v), v);
  for (const v of ['opus', 'haiku', 'claude-sonnet', undefined, 3]) assert.ok(!isMainModel(v), String(v));
  assert.equal(advisorOf('fable'), 'fable');
  assert.equal(advisorOf('claude-fable-1'), 'fable');
  assert.equal(advisorOf('opus'), 'opus');
  assert.equal(advisorOf('claude-opus-5'), 'opus');
  assert.equal(advisorOf('Claude-Opus-6-1'), 'opus');
  assert.equal(advisorOf('claude-opus-4-8'), undefined);
  assert.equal(advisorOf('sonnet'), undefined);
  for (const v of ['haiku', 'claude-haiku-4-5']) assert.ok(isSubagentModel(v), v);
  assert.ok(!isSubagentModel('sonnet'));
});

test('prefs: models defaults when absent, validated on load, kept by other saves', () => {
  fresh();
  assert.deepEqual(modelsPrefs(), { scope: 'global', advisor: 'fable', autoFix: true });
  assert.equal(loadPrefs().models, undefined);
  write(credentialsPath(), JSON.stringify({ models: { scope: 'nowhere', advisor: 'opus', autoFix: 'yes' } }));
  assert.deepEqual(loadPrefs().models, { scope: 'global', advisor: 'opus', autoFix: true });
  savePrefs({ lang: 'en' });
  assert.equal(loadPrefs().models?.advisor, 'opus', 'a save without models keeps them');
});

test('auto-fix: model opus becomes sonnet, other keys untouched, agent files written', () => {
  const { user, root, home, opts } = fresh();
  write(user, { theme: 'dark', model: 'opus', advisorModel: 'fable', env: { FOO: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } });
  const r = driftCheck(root, opts);
  assert.deepEqual(json(user), { theme: 'dark', model: 'sonnet', advisorModel: 'fable', env: { FOO: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } });
  assert.ok(r.fixed.includes(MSG.fixed('model', 'opus', 'sonnet')));
  assert.match(r.fixed.join('\n'), /model opus → sonnet \(takes effect next session\)/);
  assert.match(readFileSync(join(home, '.claude', 'agents', 'cto-reviewer.md'), 'utf8'), /^model: opus$/m);
  assert.match(readFileSync(join(home, '.claude', 'agents', 'Explore.md'), 'utf8'), /^model: haiku$/m);
  assert.ok(!('CLAUDE_CODE_SUBAGENT_MODEL_FORCE' in json(user).env));
  assert.deepEqual(r.reported, []);
});

test('a missing file gets all three keys, never the FORCE env', () => {
  const { user, root, opts } = fresh();
  driftCheck(root, opts);
  assert.deepEqual(json(user), CONSISTENT);
});

test('/advisor switch: advisorModel opus with profile fable updates the profile, file unchanged, nothing said', () => {
  const { user, root, opts, agentsOk } = fresh();
  agentsOk();
  const s = { ...CONSISTENT, advisorModel: 'opus' };
  write(user, s);
  const r = driftCheck(root, opts);
  assert.deepEqual(json(user), s);
  assert.equal(modelsPrefs().advisor, 'opus');
  assert.deepEqual(r, { fixed: [], reported: [] });
});

test('advisor removed, sonnet or Opus 4 goes back to the profile advisor', () => {
  for (const v of [undefined, 'sonnet', 'claude-opus-4-8']) {
    const { user, root, opts } = fresh();
    write(user, { ...CONSISTENT, advisorModel: v });
    driftCheck(root, opts);
    assert.equal(json(user).advisorModel, 'fable', String(v));
    assert.equal(modelsPrefs().advisor, 'fable');
  }
});

test('scope local: a user-level /advisor switch updates the profile and the local file', () => {
  const { user, root, opts } = fresh({ scope: 'local' });
  write(user, { advisorModel: 'opus' });
  const local = join(root, '.claude', 'settings.local.json');
  write(local, CONSISTENT);
  driftCheck(root, opts);
  assert.equal(modelsPrefs().advisor, 'opus');
  assert.equal(json(local).advisorModel, 'opus');
  assert.deepEqual(json(user), { advisorModel: 'opus' }, 'scope local never writes the user settings');
  assert.ok(existsSync(join(root, '.claude', 'agents', 'cto-reviewer.md')), 'local agent files');
});

test('scope global: the project local key is removed, the shared one only reported', () => {
  const { user, root, opts, agentsOk } = fresh();
  agentsOk();
  write(user, CONSISTENT);
  const local = join(root, '.claude', 'settings.local.json');
  write(local, { model: 'opus', permissions: { allow: ['Bash(ls)'] } });
  const shared = join(root, '.claude', 'settings.json');
  const sharedText = JSON.stringify({ model: 'opus' });
  write(shared, sharedText);
  const r = driftCheck(root, opts);
  assert.deepEqual(json(local), { permissions: { allow: ['Bash(ls)'] } });
  assert.equal(readFileSync(shared, 'utf8'), sharedText);
  assert.deepEqual(r.fixed, [MSG.removed('model', '.claude/settings.local.json')]);
  assert.deepEqual(r.reported, [MSG.shared('model', '.claude/settings.json')]);
});

test('autoFix off: nothing is written, the drift is reported with the way to turn it on', () => {
  const { user, root, home, opts } = fresh({ autoFix: false });
  const text = JSON.stringify({ ...CONSISTENT, model: 'opus' });
  write(user, text);
  const r = driftCheck(root, opts);
  assert.equal(readFileSync(user, 'utf8'), text);
  assert.ok(!existsSync(join(home, '.claude', 'agents')));
  assert.deepEqual(r.fixed, []);
  assert.match(r.reported.join('\n'), /model opus \(should be sonnet\)/);
  assert.match(r.reported.join('\n'), /cto models autofix on/);
});

test('all consistent: nothing fixed, nothing reported', () => {
  const { user, root, opts, agentsOk } = fresh();
  agentsOk();
  write(user, CONSISTENT);
  assert.deepEqual(driftCheck(root, opts), { fixed: [], reported: [] });
});

test('shell env CLAUDE_CODE_SUBAGENT_MODEL that breaks the split is reported, not changed', () => {
  const { user, root, opts, agentsOk } = fresh();
  agentsOk();
  write(user, CONSISTENT);
  assert.deepEqual(driftCheck(root, { ...opts, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }).reported, []);
  const r = driftCheck(root, { ...opts, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
  assert.deepEqual(r.reported, [MSG.envSet('opus', 'the shell environment')]);
  assert.deepEqual(json(user), CONSISTENT);
});

test('broken JSON target: not written, reported by name', () => {
  const { user, root, opts } = fresh();
  write(user, '{ "model": "opus",');
  const r = driftCheck(root, opts);
  assert.equal(readFileSync(user, 'utf8'), '{ "model": "opus",');
  assert.deepEqual(r.reported, [MSG.badJson('~/.claude/settings.json')]);
});

test('a file changed between read and write is left with the other writer\'s content', () => {
  const { user } = fresh();
  write(user, { model: 'opus' });
  const before = readFileSync(user, 'utf8');
  write(user, { model: 'claude-opus-5', other: true });
  const theirs = readFileSync(user, 'utf8');
  assert.equal(writeJsonIfUnchanged(user, before, { model: 'sonnet' }), false);
  assert.equal(readFileSync(user, 'utf8'), theirs);
  assert.equal(writeJsonIfUnchanged(user, theirs, { model: 'sonnet' }), true);
  assert.deepEqual(json(user), { model: 'sonnet' });
});

test('managed availableModels ["opus"]: model is not written, the conflict is reported', () => {
  const { user, root, opts } = fresh();
  write(opts.managedPath, { availableModels: ['opus'] });
  write(user, { model: 'opus' });
  const r = driftCheck(root, opts);
  assert.equal(json(user).model, 'opus');
  assert.ok(r.reported.includes(MSG.managed('model', 'sonnet')));
});

test('cto files: a stale skill is rewritten, a newer one is kept with the upgrade hint', () => {
  const { user, root, opts, agentsOk } = fresh();
  agentsOk();
  write(user, CONSISTENT);
  write(join(root, '.claude', 'settings.local.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cto --hook claude-stop' }] }] } });
  write(join(root, SKILL_PATH), `${SKILL_MARK}\nold\n`);
  const r = driftCheck(root, opts);
  assert.equal(readFileSync(join(root, SKILL_PATH), 'utf8'), SKILL_TEXT);
  assert.ok(r.fixed.includes(MSG.wrote(SKILL_PATH)));

  const newer = `---\nname: cto\n---\n${SKILL_MARK}\n<!-- cto 9.9.9 -->\nfrom the future\n`;
  write(join(root, SKILL_PATH), newer);
  const r2 = driftCheck(root, opts);
  assert.equal(readFileSync(join(root, SKILL_PATH), 'utf8'), newer);
  assert.match(r2.reported.join('\n'), /is older than \.agents\/skills\/cto\/SKILL\.md \(9\.9\.9\)/);
  assert.match(r2.reported.join('\n'), /npm install -g your-cto-jev/);
  assert.ok(!r2.fixed.includes(MSG.wrote(SKILL_PATH)));
});

test('cto files with autoFix off: listed, not written', () => {
  const { user, root, opts, agentsOk } = fresh({ autoFix: false });
  agentsOk();
  write(user, CONSISTENT);
  write(join(root, '.claude', 'settings.local.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cto --hook claude-stop' }] }] } });
  write(join(root, SKILL_PATH), `${SKILL_MARK}\nold\n`);
  const r = driftCheck(root, opts);
  assert.equal(readFileSync(join(root, SKILL_PATH), 'utf8'), `${SKILL_MARK}\nold\n`);
  assert.ok(r.reported.includes(MSG.stale(SKILL_PATH)));
});

test('a cto-reviewer.md without the cto mark is the user\'s: not overwritten, reported', () => {
  const { user, root, home, opts } = fresh();
  write(user, CONSISTENT);
  const mine = join(home, '.claude', 'agents', 'cto-reviewer.md');
  write(mine, '---\nname: cto-reviewer\nmodel: sonnet\n---\nmine\n');
  const r = driftCheck(root, opts);
  assert.equal(readFileSync(mine, 'utf8'), '---\nname: cto-reviewer\nmodel: sonnet\n---\nmine\n');
  assert.ok(r.reported.includes(MSG.conflict('~/.claude/agents/cto-reviewer.md')));
  assert.ok(existsSync(join(home, '.claude', 'agents', 'Explore.md')), 'the other agent file is still written');
});

test('agent files: model lines, read-only tools, the mark and version line right after it', () => {
  const reviewer = AGENT_FILES['cto-reviewer.md'], explore = AGENT_FILES['Explore.md'];
  assert.match(reviewer, /^model: opus$/m);
  assert.match(explore, /^model: haiku$/m);
  for (const t of [reviewer, explore]) {
    assert.match(t, /^tools: Read, Grep, Glob, Bash$/m);
    assert.ok(t.includes(`${SKILL_MARK}\n${VERSION_LINE}\n`));
    assert.equal(fileVersion(t), currentVersion());
  }
  assert.match(reviewer, /P1/);
  assert.match(reviewer, /one finding per line/i);
  assert.ok(SKILL_TEXT.includes(`${SKILL_MARK}\n${VERSION_LINE}\n`), 'skills carry the version line too');
});

test('Fable reminder only when the advisor is Fable, and never in the drift output', () => {
  const { root, opts } = fresh();
  assert.match(fableReminder()!, /\/model fable/);
  assert.match(fableReminder()!, /cto models advisor opus/);
  assert.ok(!driftCheck(root, opts).fixed.concat(driftCheck(root, opts).reported).some((l) => l.includes('/model fable')));
  assert.equal(fableReminder({ ...DEFAULT_MODELS, advisor: 'opus' }), undefined);
});

test('applyModels advisor opus: target and profile both opus', () => {
  const { user, root, opts } = fresh();
  write(user, CONSISTENT);
  applyModels(root, { advisor: 'opus' }, opts);
  assert.equal(modelsPrefs().advisor, 'opus');
  assert.equal(json(user).advisorModel, 'opus');
  applyModels(root, { autoFix: false }, opts);
  assert.equal(modelsPrefs().autoFix, false);
  assert.equal(modelsPrefs().advisor, 'opus');
});

test('scope local: a user advisorModel left behind does not undo `cto models advisor`; a new /advisor switch still does', () => {
  const { user, root, opts } = fresh({ scope: 'local' });
  write(user, { advisorModel: 'fable' });
  const local = join(root, '.claude', 'settings.local.json');
  driftCheck(root, opts);
  applyModels(root, { advisor: 'opus' }, opts);
  assert.equal(json(local).advisorModel, 'opus');
  driftCheck(root, opts);
  assert.equal(modelsPrefs().advisor, 'opus', 'the old user fable is not a new switch');
  assert.equal(json(local).advisorModel, 'opus');
  write(user, { advisorModel: 'opus' });
  driftCheck(root, opts);
  write(user, { advisorModel: 'fable' });
  driftCheck(root, opts);
  assert.equal(modelsPrefs().advisor, 'fable', 'a changed user value is a switch');
  assert.equal(json(local).advisorModel, 'fable');
});

test('a credentials file that does not parse is never overwritten, and nothing else is written either', () => {
  const { user, root, opts } = fresh();
  write(credentialsPath(), '{ "OPENROUTER_API_KEY": "k",');
  assert.throws(() => savePrefs({ lang: 'en' }), /not valid JSON/);
  write(user, { ...CONSISTENT, advisorModel: 'opus', model: 'haiku' });
  const r = driftCheck(root, opts);
  assert.equal(readFileSync(credentialsPath(), 'utf8'), '{ "OPENROUTER_API_KEY": "k",');
  assert.match(r.reported.join('\n'), /model split was not saved/);
  assert.equal(json(user).model, 'haiku', 'no settings write without the profile');
  const a = applyModels(root, { advisor: 'opus' }, opts);
  assert.match(a.reported.join('\n'), /model split was not saved/);
  assert.equal(readFileSync(credentialsPath(), 'utf8'), '{ "OPENROUTER_API_KEY": "k",');
});

test('a newer cto file in the repo: staleGuidance skips it and sync leaves the rules blocks alone', () => {
  fresh();
  const root = tmp();
  write(join(root, SKILL_PATH), `${SKILL_MARK}\n<!-- cto 9.9.9 -->\n`);
  assert.deepEqual(staleGuidance(root, ['claude']), []);
  assert.deepEqual(syncGuidance(root, new Set(['claude']), false), { written: [], removed: [] });
  assert.ok(!existsSync(join(root, 'CLAUDE.md')));
  const other = tmp();
  assert.deepEqual(staleGuidance(other, ['claude']), ['CLAUDE.md', SKILL_PATH], 'without a newer file both are stale');
});

test('version line: a prerelease suffix is read and compared by its x.y.z', () => {
  assert.equal(fileVersion('<!-- cto 9.9.9-beta.1 -->'), '9.9.9-beta.1');
  assert.ok(tooNew('<!-- cto 9.9.9-beta.1 -->'));
  assert.ok(!tooNew('<!-- cto 0.0.1-rc.2 -->'));
  assert.ok(!tooNew(`<!-- cto ${currentVersion()} -->`));
});

test('a symlinked settings file stays a symlink and keeps its mode', (t) => {
  const { user, root, opts, agentsOk } = fresh();
  agentsOk();
  const real = join(tmp(), 'settings.json');
  write(real, { model: 'opus' });
  if (process.platform !== 'win32') chmodSync(real, 0o640);
  mkdirSync(dirname(user), { recursive: true });
  try { symlinkSync(real, user, 'file'); } catch { t.skip('symlinks not allowed here'); return; }
  driftCheck(root, opts);
  assert.ok(lstatSync(user).isSymbolicLink());
  assert.equal(json(real).model, 'sonnet');
  if (process.platform !== 'win32') assert.equal(statSync(real).mode & 0o777, 0o640);
});

test('unreadable files: the target is reported, an unreadable managed file means no limits', () => {
  const { user, root, opts } = fresh();
  mkdirSync(user, { recursive: true }); // EISDIR
  mkdirSync(opts.managedPath, { recursive: true });
  const r = driftCheck(root, opts);
  assert.ok(r.reported.includes(MSG.unreadable('~/.claude/settings.json')));
  assert.ok(!r.reported.some((l) => l.includes('availableModels')));
});

test('a non-object env is reported and the file not written', () => {
  const { user, root, opts } = fresh();
  const text = JSON.stringify({ model: 'opus', env: 'x' });
  write(user, text);
  const r = driftCheck(root, opts);
  assert.equal(readFileSync(user, 'utf8'), text);
  assert.ok(r.reported.includes(MSG.badShape('~/.claude/settings.json')));
});

test('shared settings with matching values and a shell env equal to the target are not reported', () => {
  const { user, root, opts, agentsOk } = fresh({ autoFix: false });
  agentsOk();
  write(user, { ...CONSISTENT, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
  write(join(root, '.claude', 'settings.json'), { model: 'claude-sonnet-5', advisorModel: 'opus' });
  const r = driftCheck(root, { ...opts, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
  assert.deepEqual(r.reported, [MSG.drift('CLAUDE_CODE_SUBAGENT_MODEL', 'opus', 'haiku'), MSG.shared('advisorModel', '.claude/settings.json')]);
});

test('Windows: a project root that is the home in another case is not treated as a project', { skip: process.platform !== 'win32' }, () => {
  const { user, home, opts, agentsOk } = fresh();
  agentsOk();
  write(user, CONSISTENT);
  const local = join(home, '.claude', 'settings.local.json');
  write(local, { model: 'opus' });
  driftCheck(home.toUpperCase(), opts);
  assert.deepEqual(json(local), { model: 'opus' });
});

test('switchScope carries over an /advisor switch made in the old scope since the last session', () => {
  const { user, root, opts } = fresh();
  write(user, { ...CONSISTENT, advisorModel: 'opus' });
  switchScope(root, 'local', opts);
  assert.equal(modelsPrefs().advisor, 'opus');
  assert.equal(json(join(root, '.claude', 'settings.local.json')).advisorModel, 'opus');
  assert.deepEqual(json(user), {}, 'the old scope is cleared, the carried-over advisor included');
});

test('a newer cto file in the repo: removeOthers leaves the other agents\' rules blocks too', () => {
  fresh();
  const root = tmp();
  write(join(root, SKILL_PATH), `${SKILL_MARK}\n<!-- cto 9.9.9 -->\n`);
  const agentsMd = join(root, 'AGENTS.md');
  write(agentsMd, `# mine\n\n${RULES_BLOCK}`);
  assert.deepEqual(syncGuidance(root, new Set(['claude']), true), { written: [], removed: [] });
  assert.equal(readFileSync(agentsMd, 'utf8'), `# mine\n\n${RULES_BLOCK}`);
});

test('savePrefs writes credentials.json readable by the owner only', { skip: process.platform === 'win32' }, () => {
  fresh();
  savePrefs({ lang: 'en' });
  assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
});

test('clearScope keeps an agent file written by a newer cto', () => {
  const { root, home, opts } = fresh();
  const file = join(home, '.claude', 'agents', 'Explore.md');
  write(file, `${SKILL_MARK}\n<!-- cto 9.9.9 -->\n`);
  const r = clearScope(root, 'global', opts);
  assert.ok(existsSync(file));
  assert.match(r.reported.join('\n'), /older than ~\/\.claude\/agents\/Explore\.md \(9\.9\.9\)/);
});

test('switchScope local: user settings lose the three keys and agent files, the project gets them', () => {
  const { user, root, home, opts } = fresh();
  write(user, { ...CONSISTENT, theme: 'dark' });
  driftCheck(root, opts);
  const userAgents = join(home, '.claude', 'agents');
  assert.ok(existsSync(join(userAgents, 'cto-reviewer.md')));
  write(join(userAgents, 'mine.md'), 'mine');

  switchScope(root, 'local', opts);
  assert.equal(modelsPrefs().scope, 'local');
  assert.deepEqual(json(user), { theme: 'dark' });
  assert.ok(!existsSync(join(userAgents, 'cto-reviewer.md')) && !existsSync(join(userAgents, 'Explore.md')));
  assert.ok(existsSync(join(userAgents, 'mine.md')), 'other agent files stay');
  assert.deepEqual(json(join(root, '.claude', 'settings.local.json')), CONSISTENT);
  assert.ok(existsSync(join(root, '.claude', 'agents', 'cto-reviewer.md')) && existsSync(join(root, '.claude', 'agents', 'Explore.md')));

  // Clearing a scope removes only keys that still hold the profile's values.
  write(join(root, '.claude', 'settings.local.json'), { ...CONSISTENT, model: 'claude-sonnet-5' });
  clearScope(root, 'local', opts);
  assert.deepEqual(json(join(root, '.claude', 'settings.local.json')), { model: 'claude-sonnet-5' });

  // Back to global: the user settings get the keys again, and the global rule clears the project's local override.
  switchScope(root, 'global', opts);
  assert.equal(modelsPrefs().scope, 'global');
  assert.deepEqual(json(user), { theme: 'dark', ...CONSISTENT });
  assert.deepEqual(json(join(root, '.claude', 'settings.local.json')), {});
  assert.ok(existsSync(join(userAgents, 'cto-reviewer.md')));
});

test('files check: a user command above cto\'s block is reported for cto setup --refresh; the file is not moved, autofix on or off', () => {
  const { root, opts } = fresh();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  const block = '# >>> YOUR CTO JEV START >>>\nold\n# <<< YOUR CTO JEV END <<<\n';
  const text = '#!/bin/sh\nnpx biome check\n' + block;
  write(hook, text);
  const off = driftCheck(root, { ...opts, models: false, autoFix: false });
  assert.equal(readFileSync(hook, 'utf8'), text, 'dry run writes nothing');
  assert.ok(off.reported.some((l) => /pre-commit/.test(l) && /cto setup --refresh/.test(l)), off.reported.join('\n'));
  const on = driftCheck(root, { ...opts, models: false });
  assert.equal(readFileSync(hook, 'utf8'), text, 'not moved silently');
  assert.ok(on.reported.some((l) => /pre-commit/.test(l) && /cto setup --refresh/.test(l)), on.reported.join('\n'));
  assert.ok(!on.fixed.some((l) => /pre-commit/.test(l)), on.fixed.join('\n'));
});

test('files check: a .gitignore block without the lock entry gets it on the next session; autofix off only says so', () => {
  const { root, opts } = fresh();
  write(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cto --hook x-stop' }] }] } }));
  const ignore = join(root, '.gitignore');
  const before = '# >>> YOUR CTO JEV START >>>\n.cto-brain.json\n.cto-brain.json.*tmp\ndebug_stdin.json\n.claude/settings.local.json\n# <<< YOUR CTO JEV END <<<\n';
  write(ignore, before);
  const off = driftCheck(root, { ...opts, models: false, autoFix: false });
  assert.equal(readFileSync(ignore, 'utf8'), before, 'dry run writes nothing');
  assert.ok(off.reported.some((l) => l.includes('.gitignore')), off.reported.join('\n'));
  const on = driftCheck(root, { ...opts, models: false, autoFix: true });
  assert.ok(readFileSync(ignore, 'utf8').includes('.cto-brain.json.lock*'), 'the entry is added');
  assert.ok(on.fixed.some((l) => l.includes('.gitignore')), on.fixed.join('\n'));
});

test('files check: a .gitignore that already has the lock line is not checked against git or rewritten', () => {
  const { root, opts } = fresh();
  write(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cto --hook x-stop' }] }] } }));
  const ignore = join(root, '.gitignore');
  write(ignore, '.cto-brain.json.lock*\n');
  driftCheck(root, { ...opts, models: false, autoFix: true });
  assert.equal(readFileSync(ignore, 'utf8'), '.cto-brain.json.lock*\n');
});

test('files check: when only the lock line is missing, that line goes into the cto block and the other lines stay as they are', () => {
  const { root, opts } = fresh();
  write(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cto --hook x-stop' }] }] } }));
  const ignore = join(root, '.gitignore');
  const block = '# >>> YOUR CTO JEV START >>>\n.cto-brain.json\n.cto-brain.json.*tmp\ndebug_stdin.json\n.claude/settings.local.json\n# <<< YOUR CTO JEV END <<<\n';
  write(ignore, 'node_modules\n' + block);
  driftCheck(root, { ...opts, models: false, autoFix: true });
  assert.equal(readFileSync(ignore, 'utf8'), 'node_modules\n' + block.replace('# <<< YOUR', '.cto-brain.json.lock*\n# <<< YOUR'));
});

test('files check: SessionStart adds only the lock line; a block missing another entry is not rewritten to add it', () => {
  const { root, opts } = fresh();
  write(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cto --hook x-stop' }] }] } }));
  const ignore = join(root, '.gitignore');
  const block = '# >>> YOUR CTO JEV START >>>\n.cto-brain.json\n.cto-brain.json.*tmp\n# <<< YOUR CTO JEV END <<<\n';
  write(ignore, block);
  driftCheck(root, { ...opts, models: false, autoFix: true });
  assert.equal(readFileSync(ignore, 'utf8'), block.replace('# <<< YOUR', '.cto-brain.json.lock*\n# <<< YOUR'));
});

test('writeTextIfUnchanged: writes only when the file still reads as it was read; a missing file reads as empty', () => {
  const p = join(tmp(), 'f.txt');
  assert.equal(writeTextIfUnchanged(p, '', 'new'), true, 'a missing file reads as empty');
  assert.equal(readFileSync(p, 'utf8'), 'new');
  assert.equal(writeTextIfUnchanged(p, 'other', 'C'), false, 'changed since it was read');
  assert.equal(readFileSync(p, 'utf8'), 'new', 'left alone');
  assert.equal(writeTextIfUnchanged(p, 'new', 'C'), true);
  assert.equal(readFileSync(p, 'utf8'), 'C');
});


test('files check: a block already first is not moved or re-rendered, and nothing is reported as moved', () => {
  const { root, opts } = fresh();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  const stale = '# >>> YOUR CTO JEV START >>>\nold body\n# <<< YOUR CTO JEV END <<<\n';
  write(hook, '#!/bin/sh\n' + stale + 'npx biome check\n');
  const r = driftCheck(root, { ...opts, models: false });
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\n' + stale + 'npx biome check\n', 'untouched, the stale body included');
  assert.ok(!r.fixed.some((l) => /pre-commit/.test(l)), r.fixed.join('\n'));
});

test('files check: a block with a user command above it stays put and its body is not re-rendered', () => {
  const { root, opts } = fresh();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  const stale = '# >>> YOUR CTO JEV START >>>\nold body\n# <<< YOUR CTO JEV END <<<\n';
  write(hook, '#!/bin/sh\nnpx biome check\n' + stale);
  driftCheck(root, { ...opts, models: false });
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nnpx biome check\n' + stale, 'untouched; the user\'s command is not moved');
});

test('files check: the guard matcher gains Agent and SubagentStop is added; removed cto hooks and the user\'s own hook stay as they were', () => {
  const { root, opts } = fresh();
  const local = join(root, '.claude', 'settings.local.json');
  const mine = { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'my-lint' }] };
  const old = { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'cto --hook claude-pre' }] },
    { matcher: 'Edit|Write|MultiEdit|PowerShell|AskUserQuestion', hooks: [{ type: 'command', command: 'cto --hook claude-guard' }] },
    mine,
  ] } };
  write(local, old);
  const guardOf = () => json(local).hooks.PreToolUse.find((m: any) => m.hooks.some((h: any) => h.command === 'cto --hook claude-guard'));

  const off = driftCheck(root, { ...opts, models: false, autoFix: false });
  assert.deepEqual(json(local), old, 'autoFix off: nothing written');
  assert.ok(off.reported.some((l) => l.includes('.claude/settings.local.json')), off.reported.join('\n'));
  assert.ok(off.reported.some((l) => /cto setup --refresh/.test(l) && /autofix on/.test(l)), 'a dry run says what to do, not that hooks were added');
  assert.ok(!off.reported.some((l) => /restart|重開/.test(l)), 'nothing was written, so no restart line');

  const r = driftCheck(root, { ...opts, models: false });
  assert.equal(guardOf().matcher, 'Edit|Write|MultiEdit|PowerShell|AskUserQuestion|Agent|Task');
  assert.deepEqual(json(local).hooks.PreToolUse.find((m: any) => m.hooks.some((h: any) => h.command === 'my-lint')), mine, 'the user hook is unchanged');
  assert.deepEqual(json(local).hooks.SubagentStop, [{ hooks: [{ type: 'command', command: 'cto --hook claude-agent' }] }], 'the review hook is added');
  assert.ok(!JSON.stringify(json(local)).includes('claude-menu') && !json(local).hooks.Stop, 'other cto hooks the user took out stay out');
  assert.ok(r.fixed.some((l) => l.includes('.claude/settings.local.json')), r.fixed.join('\n'));
  assert.ok(r.fixed.some((l) => l.includes('.claude/settings.local.json') && /restart|重開/.test(l)), 'the drift line says the session must restart');
  assert.ok(!driftCheck(root, { ...opts, models: false }).fixed.some((l) => l.includes('settings.local.json')), 'current: no second write');
});
