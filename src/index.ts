#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentNames, agents, type AgentName } from './agents.js';
import { applyCredentials, findRoot, loadConfig, loadCredentials, loadPrefs, saveCredentials, savePrefs } from './brain.js';
import { DEFAULT_ORDER, providerOrder, providers } from './api.js';
import { agentEdit, agentGuard, agentPost, agentPre, agentPrompt, agentReply, agentStop, gitCommit, gitPush, stagedDiff } from './hooks.js';
import { checkUpdate, currentVersion, runUpdate } from './update.js';
import { doctor } from './doctor.js';
import type { HookOutput } from './agents.js';
import { detectLang, t } from './i18n.js';
import { maskDiff, maskSensitiveState } from './masker.js';
import { detectAgents, gitRoot, isSetUp, planSetup, setup, wiredAgents } from './setup.js';
import type { SetupState } from './setupui.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let s = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function emit(out: HookOutput) {
  if (out.stdout) process.stdout.write(out.stdout + '\n');
  if (out.stderr.length) process.stderr.write(out.stderr.join('\n') + '\n');
  process.exitCode = out.code;
}

async function runHook(name: string): Promise<HookOutput> {
  const lang = detectLang();
  const debug = (root: string, text: string) => {
    if (process.env.CTO_DEBUG === '1') writeFileSync(join(root, 'debug_stdin.json'), text);
  };
  if (name === 'git-commit') {
    // Read the staged diff ourselves with pinned args. Never touch stdin here: older hook blocks still pipe a diff
    // (ignored, harmless), and an agent's shell may hand us a pipe that never closes.
    const root = findRoot();
    const diff = stagedDiff(process.cwd());
    debug(root, maskDiff(diff));
    return gitCommit(diff, { root, lang });
  }
  const raw = await readStdin();
  if (name === 'git-push') return gitPush(raw, { root: findRoot(), lang });
  const m = /^(claude|cursor|gemini|codex)-(pre|post|stop|edit|reply|start|prompt|guard)$/.exec(name);
  if (!m) return { code: 0, stderr: [] };
  const agent = agents[m[1] as AgentName];
  let input: any = {};
  try { input = JSON.parse(raw); } catch { /* fail-open below */ }
  if (m[2] === 'start') {
    const { brief } = await import('./brief.js');
    return { code: 0, stdout: brief(findRoot(typeof input?.cwd === 'string' ? input.cwd : process.cwd())).join('\n'), stderr: [] };
  }
  if (m[2] === 'edit') {
    const cwd = typeof input?.cwd === 'string' ? input.cwd : typeof input?.workspace_roots?.[0] === 'string' ? input.workspace_roots[0] : process.cwd();
    return agentEdit(agent.parseEdit?.(input), { root: findRoot(cwd), lang }, agent.transcriptTurns ? undefined : agent.session(input));
  }
  if (m[2] === 'reply') {
    if (!agent.parseReply) return { code: 0, stderr: [] };
    const reply = agent.parseReply(input);
    return agentReply(reply, { root: findRoot(reply.cwd ?? process.cwd()), lang });
  }
  if (m[2] === 'stop') {
    if (!agent.parseStop) return { code: 0, stderr: [] };
    const stop = agent.parseStop(input);
    const root = findRoot(stop.cwd ?? process.cwd());
    debug(root, maskSensitiveState(raw));
    return agentStop(agent, stop, { root, lang });
  }
  if (m[2] === 'prompt') {
    if (!agent.parsePrompt) return { code: 0, stderr: [] };
    const prompt = agent.parsePrompt(input);
    return agentPrompt(prompt, { root: findRoot(prompt.cwd ?? process.cwd()), lang });
  }
  if (m[2] === 'guard') {
    if (!agent.parseGuard) return { code: 0, stderr: [] };
    const guard = agent.parseGuard(input);
    return agentGuard(agent, guard, { root: findRoot(guard.cwd ?? process.cwd()), lang });
  }
  if (m[2] === 'pre') {
    const pre = agent.parsePre(input);
    const root = findRoot(pre.cwd ?? process.cwd());
    debug(root, maskSensitiveState(raw));
    return agentPre(agent, pre, { root, lang });
  }
  const post = agent.parsePost(input);
  const root = findRoot(post?.cwd ?? input?.cwd ?? process.cwd());
  debug(root, maskSensitiveState(raw));
  return agentPost(post, { root, lang }, m[1]);
}

const args = process.argv.slice(2);
const lang = detectLang();
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

applyCredentials();
if (args[0] === '--hook' && args[1]) {
  try {
    emit(await runHook(args[1]));
  } catch (e) {
    // Fail-open: a crash in the gate must never block a commit or a tool call.
    if (process.env.CTO_DEBUG === '1') process.stderr.write(String((e as Error)?.stack ?? e) + '\n');
    process.exitCode = 0;
  }
} else if (args[0] === 'setup') {
  const uninstall = args.includes('--uninstall');
  let chosen: AgentName[] | undefined;
  let interactive = false; // the menu lists every agent, so what is left unticked loses its cto hooks (exact mode)
  let flow = args.includes('--flow') ? true : args.includes('--no-flow') ? false : undefined;
  const root = gitRoot(process.cwd());
  const list = flag('--agents');
  if (args.includes('--refresh')) {
    // Re-write everything cto manages for the agents already wired here; choices stay as they are.
    chosen = root ? wiredAgents(root) : [];
    if (root && !isSetUp(root)) { console.log(t(lang, 'refresh_none')); process.exit(0); }
  } else if (list) chosen = list.split(',').map((s) => s.trim()).filter((s): s is AgentName => (agentNames as string[]).includes(s));
  else if (!uninstall && root && process.stdin.isTTY && process.stdout.isTTY && !args.includes('--yes')) {
    // Interactive: start from what is actually set up now, so re-running setup edits instead of starting over.
    const fileKeys = loadCredentials();
    const prefs = loadPrefs();
    const wired = wiredAgents(root);
    const initial: SetupState = {
      agents: wired.length ? wired : detectAgents(),
      providers: prefs.provider_order ?? DEFAULT_ORDER.filter((p) => providers[p].enabled()),
      keys: fileKeys,
      lang: prefs.lang,
      goal: loadConfig(root).sprint_goal,
      flow: loadConfig(root).flow,
    };
    const firstRun = !wired.length && !providerOrder().length;
    const { setupUI } = await import('./setupui.js'); // clack loads only for interactive setup, never on the hook path
    const s = await setupUI(initial, firstRun, lang, { detected: detectAgents(), plan: (st) => planSetup(root, st.agents, st.flow ?? false, st.goal) });
    if (!s) process.exit(0); // quit without saving: nothing was written
    saveCredentials(s.keys);
    savePrefs({ provider_order: s.providers, ...(s.lang && { lang: s.lang }) });
    chosen = s.agents;
    interactive = true;
    flow = s.flow ?? false;
  } else if (!uninstall) {
    chosen = detectAgents();
  }
  const r = setup(process.cwd(), lang, { uninstall, agents: chosen, exact: interactive, flow });
  const latest = r.code ? undefined : await checkUpdate();
  if (latest) r.lines.push(t(lang, 'update_available', { latest, current: currentVersion() }));
  (r.code ? process.stderr : process.stdout).write(r.lines.join('\n') + '\n');
  process.exitCode = r.code;
} else if (args[0] === 'update') {
  process.exitCode = runUpdate();
  if (!process.exitCode) {
    console.log(t(lang, 'update_done'));
    // The new version refreshes this repo's managed hooks and rules, so changes reach it without re-running setup.
    const root = gitRoot(process.cwd());
    let setUp = false;
    // isSetUp runs git with --path-format, which git < 2.31 rejects; the update already succeeded, so just skip the refresh.
    try { setUp = !!root && isSetUp(root); } catch { /* skip refresh */ }
    if (root && setUp) {
      console.log(t(lang, 'refresh_after_update'));
      spawnSync('cto setup --refresh', { stdio: 'inherit', shell: true, cwd: root });
    }
  }
} else if (args[0] === 'check') {
  const root = gitRoot(process.cwd());
  if (!root) {
    process.stderr.write(t(lang, 'setup_not_git') + '\n');
    process.exitCode = 1;
  } else {
    const { runCheck } = await import('./check.js');
    const r = await runCheck(root, lang, flag('--base'));
    console.log(r.lines.join('\n'));
    process.exitCode = r.code;
  }
} else if (args[0] === 'log' || args[0] === 'report') {
  const root = gitRoot(process.cwd());
  if (!root) {
    process.stderr.write(t(lang, 'setup_not_git') + '\n');
    process.exitCode = 1;
  } else {
    const { showLog, report } = await import('./report.js');
    const r = args[0] === 'log' ? showLog(root, lang) : report(root, lang, args[1]);
    (r.code ? process.stderr : process.stdout).write(r.lines.join('\n') + '\n');
    process.exitCode = r.code;
  }
} else if (args[0] === 'brief') {
  const root = gitRoot(process.cwd());
  if (!root) {
    process.stderr.write(t(lang, 'setup_not_git') + '\n');
    process.exitCode = 1;
  } else {
    const { brief } = await import('./brief.js');
    console.log(brief(root).join('\n'));
  }
} else if (args[0] === 'index' || args[0] === 'docs') {
  const root = gitRoot(process.cwd());
  if (!root) {
    process.stderr.write(t(lang, 'setup_not_git') + '\n');
    process.exitCode = 1;
  } else if (args[0] === 'index') {
    const { writeIndex } = await import('./flow.js');
    const r = writeIndex(root);
    console.log(r.changed ? `[cto] ${r.path} updated` : `[cto] ${r.path} is up to date`);
  } else {
    const { docsReport } = await import('./docs.js');
    const { loadBrain, saveBrain } = await import('./brain.js');
    const brain = loadBrain(root);
    console.log((await docsReport(root, { brain, lang, timeoutMs: 5000, notices: new Set() })).join('\n'));
    saveBrain(root, brain); // provider cooldowns, as the hook paths do
  }
} else if (args[0] === 'doctor') {
  const r = await doctor(process.cwd(), lang);
  console.log(r.lines.join('\n'));
  process.exitCode = r.code;
} else if (args[0] === '--version' || args[0] === '-v') {
  console.log(currentVersion());
} else {
  process.stderr.write(t(lang, 'usage') + '\n');
  process.exitCode = args.length ? 1 : 0;
}
