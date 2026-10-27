import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { PHASES, agents, hookCommand, type AgentName } from './agents.js';
import { SKILL_MARK } from './skill.js';

// What else is steering the agents in this repo, and does it fight cto? Three looks, all local and read-only:
// other hooks on the events cto uses, guidance that tells the agent to do what cto blocks, and skills installed twice.

export interface Conflict { kind: 'hook' | 'guidance' | 'dup_skill'; where: string; detail: string }

const OTHER_SETTINGS: Record<AgentName, string> = { claude: '.claude/settings.json', cursor: '', gemini: '', codex: '' };
const USER_SETTINGS: Record<AgentName, string> = { claude: '.claude/settings.json', cursor: '', gemini: '.gemini/settings.json', codex: '.codex/hooks.json' };

/** Hook commands other than cto's on the same events, per file. The order is the order they run in. */
function hooksOn(file: string, name: AgentName): { event: string; commands: string[] }[] {
  let json: any;
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  const a = agents[name];
  const out: { event: string; commands: string[] }[] = [];
  for (const phase of PHASES) {
    const spec = a[phase];
    const arr = spec && json?.hooks?.[spec.event];
    if (!spec || !Array.isArray(arr)) continue;
    const commands = arr.flatMap((m: any) => (a.style === 'cursor' ? [m?.command] : (m?.hooks ?? []).map((h: any) => h?.command)))
      .filter((c: unknown): c is string => typeof c === 'string' && !c.startsWith('cto --hook '));
    if (commands.length) out.push({ event: spec.event, commands });
  }
  return out;
}

const mdBlockRe = /<!-- >>> YOUR CTO JEV START >>> -->[\s\S]*?<!-- <<< YOUR CTO JEV END <<< -->/g;
// Instructions that would undo a cto rule. A line that forbids the thing ("never --no-verify") is not a conflict.
const AGAINST = /--no-verify|skip(?:ping)? (?:the )?tests?|commit(?:s)? (?:directly |straight )?(?:to|on) (?:main|master)|force[- ]push|push -f\b|disable (?:the )?hooks?|\bit\.skip\b/i;
// "no" alone is not here: "--no-verify" and "no PRs" would hide the very lines this looks for.
const NEGATED = /\b(?:never|not|don'?t|avoid|forbidden|forbid)\b|禁止|不要|不准|嚴禁|不可|別/i;

function guidanceFiles(root: string, home: string): string[] {
  const files = [join(home, '.claude', 'CLAUDE.md'), ...['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'].map((f) => join(root, f))];
  const skillDirs = [join(home, '.claude', 'skills'), join(root, '.claude', 'skills'), join(root, '.agents', 'skills'), join(root, '.cursor', 'rules')];
  for (const d of skillDirs) {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) files.push(join(d, e.name, 'SKILL.md'));
        else if (/\.mdc?$/.test(e.name)) files.push(join(d, e.name));
      }
    } catch { /* no such dir */ }
  }
  return files.filter(existsSync);
}

function skillNames(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

export function findConflicts(root: string, wired: AgentName[], home = homedir()): Conflict[] {
  const out: Conflict[] = [];
  const show = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : relative(root, p) || p).replace(/\\/g, '/');

  for (const name of wired) {
    const files = [join(root, agents[name].settings), OTHER_SETTINGS[name] && join(root, OTHER_SETTINGS[name]), USER_SETTINGS[name] && join(home, USER_SETTINGS[name])];
    for (const f of files) {
      if (!f || !existsSync(f)) continue;
      const events = new Map<string, string[]>(); // one line per command, listing its events
      for (const h of hooksOn(f, name)) for (const c of h.commands) events.set(c, [...(events.get(c) ?? []), h.event]);
      for (const [c, ev] of events) out.push({ kind: 'hook', where: show(f), detail: `${c} (${ev.join(', ')})` });
    }
  }

  for (const f of guidanceFiles(root, home)) {
    let text = readFileSync(f, 'utf8');
    if (text.includes(SKILL_MARK)) continue; // cto's own skill
    text = text.replace(mdBlockRe, '');
    text.split(/\r?\n/).forEach((line, i) => {
      if (AGAINST.test(line) && !NEGATED.test(line)) out.push({ kind: 'guidance', where: `${show(f)}:${i + 1}`, detail: line.trim().slice(0, 100) });
    });
  }

  const global = skillNames(join(home, '.claude', 'skills'));
  for (const d of ['.claude/skills', '.agents/skills']) {
    for (const s of skillNames(join(root, d))) if (global.includes(s)) out.push({ kind: 'dup_skill', where: s, detail: `~/.claude/skills and ${d}` });
  }
  return out;
}
