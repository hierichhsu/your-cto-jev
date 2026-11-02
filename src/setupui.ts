import { MultiSelectPrompt } from '@clack/core';
import { S_BAR, S_BAR_END, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_SUBMIT, confirm, intro, isCancel, log, note, outro, password, select, spinner, text } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import { styleText } from 'node:util';
import { agentNames, agents, type AgentName } from './agents.js';
import { DEFAULT_ORDER, probeProvider, providers } from './api.js';
import type { Credentials } from './brain.js';
import { t, type Lang } from './i18n.js';
import type { FileChange } from './setup.js';
import { MEMORY_FILES } from './skill.js';

export interface SetupState {
  agents: AgentName[];
  providers: string[]; // picked providers, in failover order
  keys: Credentials; // keys stored in the credentials file (env-only keys are never copied in)
  lang?: 'zh-TW' | 'en';
  goal: string; // sprint_goal, carried through unchanged: it is set in .cto.json, not asked in setup
  flow?: boolean; // the cto development flow; absent = off
}

export interface UIOptions {
  input?: Readable;
  output?: Writable;
  probe?: typeof probeProvider;
  detected?: AgentName[];
  env?: NodeJS.ProcessEnv;
  /** Files a save would write; when given, they are listed and confirmed before setupUI returns. */
  plan?: (s: SetupState) => FileChange[];
}

const BACK = Symbol('back');
type Step = (s: SetupState) => Promise<SetupState | typeof BACK>;
const PROVIDER_ORDER = DEFAULT_ORDER;
const dim = (s: string) => styleText('dim', s);
const tail = (v: string) => `…${v.slice(-4)}`;
/** Terminal columns: CJK and full-width characters take two. */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
export const displayWidth = (s: string) => [...s].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - displayWidth(s)));

/**
 * Interactive setup. First run walks agents -> providers -> keys -> flow (Esc goes back one step), then
 * shows the menu. Later runs open the menu directly, pre-filled with the current setup, so any single item can be
 * changed without touching the rest. Returns the final state, or null if the user quits without saving.
 */
export async function setupUI(initial: SetupState, firstRun: boolean, lang: Lang, o: UIOptions = {}): Promise<SetupState | null> {
  const io = { input: o.input, output: o.output };
  const env = o.env ?? process.env;
  const probe = o.probe ?? probeProvider;
  const detected = o.detected ?? [];
  let state: SetupState = { ...initial, keys: { ...initial.keys } };

  const agentsStep: Step = async (s) => {
    const r = await agentPicker(lang, io, s.agents, detected);
    return typeof r === 'symbol' ? BACK : { ...s, agents: r };
  };

  const providersStep: Step = async (s) => {
    const r = await orderedMultiselect(lang, io, PROVIDER_ORDER, s.providers);
    if (typeof r === 'symbol') return BACK;
    if (!r.length) log.warn(t(lang, 'ui_no_provider'), io);
    return { ...s, providers: r };
  };

  const hasKeys = (p: string, keys: Record<string, string | undefined>) => providers[p].keys.every((k) => keys[k] || env[k]);

  /**
   * Ask for keys. With `before` (the picks before this edit), only providers that are new or missing a key are asked;
   * the rest are kept as they are, so changing the order alone asks nothing. Without it, every pick is asked (rotate keys).
   */
  const keysStepFor = (before: string[] | null): Step => async (s) => {
    const keys = { ...s.keys } as Record<string, string>;
    const kept: string[] = [];
    for (const p of s.providers) {
      if (before && before.includes(p) && hasKeys(p, keys)) { kept.push(p); continue; }
      const label = providers[p].label;
      for (;;) {
        const candidate: Record<string, string> = {};
        for (const k of providers[p].keys) {
          const stored = keys[k];
          const fromEnv = !stored && env[k] ? env[k] : undefined;
          if (stored || fromEnv) {
            const keep = await select({
              ...io,
              showInstructions: false,
              message: `${label} ${t(lang, 'key_' + k)}`,
              options: [
                { value: 'keep', label: t(lang, fromEnv ? 'ui_keep_env' : 'ui_keep', { tail: tail((stored ?? fromEnv)!) }) },
                { value: 'new', label: t(lang, 'ui_reenter') },
              ],
            });
            if (isCancel(keep)) return BACK;
            if (keep === 'keep') { if (stored) candidate[k] = stored; continue; }
          }
          const ask = k.endsWith('ACCOUNT_ID') ? text : password;
          const v = await ask({ ...io, message: `${label} ${t(lang, 'key_' + k)}`, validate: (x) => (x?.trim() ? undefined : t(lang, 'ui_required')) });
          if (isCancel(v)) return BACK;
          candidate[k] = v.trim();
        }
        // Verify with one real request using exactly these values (env-only ones stay as they are).
        const saved = Object.fromEntries(providers[p].keys.map((k) => [k, env[k]]));
        Object.assign(env, candidate);
        const sp = spinner(io);
        sp.start(t(lang, 'wiz_checking', { name: label }));
        const res = await probe(p);
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete env[k]; else env[k] = v;
        if (res.ok) {
          sp.stop(t(lang, 'wiz_ok', { name: label }));
          Object.assign(keys, candidate);
          kept.push(p);
          break;
        }
        sp.stop(t(lang, 'wiz_fail', { name: label, status: res.status, msg: res.message ?? '' }));
        const next = await select({
          ...io,
          showInstructions: false,
          message: t(lang, 'ui_fail_q', { name: label }),
          options: [
            { value: 'retry', label: t(lang, 'ui_retry') },
            { value: 'save', label: t(lang, 'ui_save_anyway') },
            { value: 'drop', label: t(lang, 'ui_drop', { name: label }) },
          ],
        });
        if (isCancel(next)) return BACK;
        if (next === 'save') { Object.assign(keys, candidate); kept.push(p); break; }
        if (next === 'drop') break;
      }
    }
    return { ...s, keys: keys as Credentials, providers: kept };
  };

  const flowStep: Step = async (s) => {
    const r = await select({
      ...io,
      showInstructions: false,
      message: t(lang, 'ui_flow_q'),
      initialValue: s.flow ? 'yes' : 'no',
      options: [{ value: 'no', label: t(lang, 'ui_flow_no') }, { value: 'yes', label: t(lang, 'ui_flow_yes') }],
    });
    return isCancel(r) ? BACK : { ...s, flow: r === 'yes' };
  };

  const langStep: Step = async (s) => {
    const r = await select({
      ...io,
      showInstructions: false,
      message: t(lang, 'ui_lang_q'),
      initialValue: s.lang ?? 'auto',
      options: [{ value: 'auto', label: t(lang, 'ui_lang_auto') }, { value: 'zh-TW', label: '繁體中文' }, { value: 'en', label: 'English' }],
    });
    return isCancel(r) ? BACK : { ...s, lang: r === 'auto' ? undefined : (r as 'zh-TW' | 'en') };
  };

  /** Run steps in order; Esc on a step goes back one. Returns BACK if the user backs out of the first step. */
  const walk = async (steps: Step[]): Promise<SetupState | typeof BACK> => {
    let s = state;
    for (let i = 0; i < steps.length; ) {
      const r = await steps[i](s);
      if (r === BACK) { if (i === 0) return BACK; i--; } else { s = r; i++; }
    }
    return s;
  };

  intro(t(lang, 'ui_title'), io);
  if (firstRun) {
    log.info(t(lang, 'ui_first_run'), io);
    const r = await walk([agentsStep, providersStep, keysStepFor(initial.providers), flowStep]);
    if (r === BACK) { outro(t(lang, 'ui_quit'), io); return null; }
    state = r;
  }

  for (let first = firstRun; ; first = false) {
    const rows: [string, string, string][] = [
      ['agents', t(lang, 'ui_m_agents'), state.agents.map((n) => agents[n].label).join(', ') || t(lang, 'doc_none')],
      ['providers', t(lang, 'ui_m_providers'), state.providers.map((p, i) => `${i + 1}. ${providers[p].label}`).join('  ') || t(lang, 'doc_none')],
      ['keys', t(lang, 'ui_m_keys'), state.providers.map((p) => { const v = providers[p].keys.map((k) => (state.keys as Record<string, string>)[k] ?? env[k]).filter(Boolean).pop(); return v ? `${providers[p].label} ${tail(v)}` : ''; }).filter(Boolean).join('  ') || t(lang, 'doc_none')],
      ['flow', t(lang, 'ui_m_flow'), t(lang, state.flow ? 'ui_on' : 'ui_off')],
      ['lang', t(lang, 'ui_m_lang'), state.lang ?? t(lang, 'ui_lang_auto')],
    ];
    const width = Math.max(...rows.map(([, l]) => displayWidth(l)));
    const choice = await select({
      ...io,
      showInstructions: false,
      message: t(lang, 'ui_menu_q'),
      initialValue: first ? 'save' : 'agents',
      options: [
        ...rows.map(([value, label, current]) => ({ value, label: `${pad(label, width)}  ${dim(current)}` })),
        { value: 'save', label: t(lang, 'ui_m_save') },
        { value: 'quit', label: t(lang, 'ui_m_quit') },
      ],
    });
    if (isCancel(choice) || choice === 'quit') { outro(t(lang, 'ui_quit'), io); return null; }
    if (choice === 'save') {
      if (o.plan && !(await confirmPlan(lang, io, o.plan(state)))) continue; // "No" goes back to the overview
      outro(t(lang, 'ui_saved'), io);
      return state;
    }
    const steps: Record<string, Step[]> = {
      agents: [agentsStep],
      providers: [providersStep, keysStepFor(state.providers)],
      keys: [keysStepFor(null)],
      flow: [flowStep],
      lang: [langStep],
    };
    const r = await walk(steps[choice]);
    if (r !== BACK) state = r;
  }
}

type IO = { input?: Readable; output?: Writable };

/**
 * Agent checklist. Above it, what is installed whatever you pick (the git hooks and the shared config); next to each
 * agent, the files it adds; under it, the current picks and the keys. Space toggles, Enter confirms, Esc goes back.
 */
async function agentPicker(lang: Lang, io: IO, initial: AgentName[], detected: AgentName[]): Promise<AgentName[] | symbol> {
  const files = (n: AgentName) => [agents[n].settings, ...MEMORY_FILES.filter((m) => m.agents.includes(n)).map((m) => m.path)].join(', ');
  const labelW = Math.max(...agentNames.map((n) => displayWidth(agents[n].label)));
  const filesW = Math.max(...agentNames.map((n) => files(n).length));
  const rule = (title: string) => `${S_BAR}  ${dim('──')} ${title} ${dim('─'.repeat(Math.max(4, 34 - displayWidth(title))))}`;
  const p = new MultiSelectPrompt<{ value: AgentName; label: string }>({
    ...io,
    options: agentNames.map((n) => ({ value: n, label: agents[n].label })),
    initialValues: initial,
    required: false,
    render() {
      const head = t(lang, 'ui_agents_q');
      const picked = (this.value ?? []) as AgentName[];
      const names = picked.map((n) => agents[n].label).join(', ');
      if (this.state === 'submit') return `${S_STEP_SUBMIT}  ${head}\n${S_BAR}  ${dim(names || t(lang, 'doc_none'))}\n`;
      if (this.state === 'cancel') return `${S_STEP_CANCEL}  ${head}\n${S_BAR}\n`;
      const rows = this.options.map((opt, i) => {
        const mark = picked.includes(opt.value) ? styleText('green', '●') : dim('○');
        const tag = detected.includes(opt.value) ? `  ${t(lang, 'ui_detected')}` : '';
        const line = `${mark} ${pad(opt.label, labelW)}  ${dim(tag ? files(opt.value).padEnd(filesW) : files(opt.value))}${tag}`;
        return `${S_BAR}  ${i === this.cursor ? styleText('cyan', '› ') : '  '}${line}`;
      });
      return [
        `${S_STEP_ACTIVE}  ${head}`,
        rule(t(lang, 'ui_always')),
        `${S_BAR}      • ${pad(t(lang, 'ui_always_git'), labelW)}  ${dim('pre-commit, pre-push')}`, // the folder may be .husky/ or core.hooksPath; the save summary shows it
        `${S_BAR}      • ${pad(t(lang, 'ui_always_cfg'), labelW)}  ${dim('.cto.json, .gitignore')}`,
        rule(t(lang, 'ui_choose')),
        ...rows,
        S_BAR,
        `${S_BAR}  ${names ? `${styleText('green', t(lang, 'ui_selected'))} ${names}` : dim(`${t(lang, 'ui_selected')} ${t(lang, 'doc_none')}`)}`,
        `${S_BAR}  ${dim(t(lang, 'ui_agents_help'))}`,
        S_BAR_END,
        '',
      ].join('\n');
    },
  });
  return p.prompt() as Promise<AgentName[] | symbol>;
}

/** The files a save will write, then "Proceed?". True to save; false (No or Esc) goes back to the overview. */
async function confirmPlan(lang: Lang, io: IO, plan: FileChange[]): Promise<boolean> {
  if (!plan.length) { log.info(t(lang, 'ui_plan_none'), io); return true; }
  const w = Math.max(...plan.map((f) => f.path.length));
  const tag = (c: FileChange['change']) => (c === 'new' ? styleText('green', t(lang, 'ui_plan_new')) : c === 'remove' ? styleText('yellow', t(lang, 'ui_plan_remove')) : dim(t(lang, 'ui_plan_update')));
  note(plan.map((f) => `${f.path.padEnd(w)}  ${tag(f.change)}`).join('\n'), t(lang, 'ui_plan_title'), { ...io, format: (l) => l });
  const ok = await confirm({ ...io, message: t(lang, 'ui_plan_q'), active: t(lang, 'ui_yes'), inactive: t(lang, 'ui_no') });
  return ok === true;
}

/**
 * Checkbox list whose marks are numbers: the order you tick items is their priority (failover order).
 * Up/Down move, Space toggles, a digit moves the item under the cursor to that position (ticking it if needed),
 * Enter confirms, Esc goes back.
 */
async function orderedMultiselect(lang: Lang, io: { input?: Readable; output?: Writable }, values: string[], initial: string[]): Promise<string[] | symbol> {
  const p = new MultiSelectPrompt<{ value: string; label: string }>({
    ...io,
    options: values.map((v) => ({ value: v, label: providers[v].label })),
    initialValues: initial.filter((v) => values.includes(v)),
    required: false,
    render() {
      const head = t(lang, 'ui_providers_q');
      const labelWidth = Math.max(...this.options.map((o) => o.label.length));
      const picked = (this.value ?? []) as string[];
      if (this.state === 'submit') {
        const summary = picked.map((v) => providers[v].label).join(' → ') || t(lang, 'doc_none');
        return `${S_STEP_SUBMIT}  ${head}\n${S_BAR}  ${dim(summary)}\n`;
      }
      if (this.state === 'cancel') return `${S_STEP_CANCEL}  ${head}\n${S_BAR}\n`;
      const rows = this.options.map((opt, i) => {
        const n = picked.indexOf(opt.value);
        const box = n >= 0 ? `[${n + 1}]` : '[ ]';
        const line = `${box} ${pad(opt.label, labelWidth)}  ${dim(t(lang, 'ui_p_' + opt.value))}`;
        return `${S_BAR}  ${i === this.cursor ? styleText('cyan', '› ' + line) : '  ' + line}`;
      });
      return [`${S_STEP_ACTIVE}  ${head}`, ...rows, `${S_BAR}  ${dim(t(lang, 'ui_providers_help'))}`, S_BAR_END, ''].join('\n');
    },
  });
  p.on('key', (char) => {
    const d = Number(char);
    if (!Number.isInteger(d) || d < 1 || d > values.length) return;
    const v = p.options[p.cursor].value;
    const rest = (p.value ?? []).filter((x) => x !== v);
    rest.splice(Math.min(d - 1, rest.length), 0, v);
    p.value = rest;
  });
  return p.prompt() as Promise<string[] | symbol>;
}
