// Heuristic: which files does a shell command write? Agents often edit with sed -i, redirects or formatters instead
// of their edit tools, and both loop detection and the done check need to know an edit happened.
// Returns the files it can name, ['?'] when it clearly writes but the target is unclear, or [] for no write.
// ponytail: regex over the command line, no shell parser. Misses writes hidden in scripts (node -e, python -c);
// upgrade to a real shell tokenizer if false negatives matter.

// mv is a command only at the start of a command (after VAR=…, sudo, command, xargs or git): `grep mv x` is an argument.
const MV_CMD = /^\s*(?:\w+=\S*\s+)*(?:(?:sudo|command|xargs|git)\s+(?:-\S+\s+)*)*mv\b((?:\s+\S+)+)/;
const WRITERS: { re: RegExp; target?: RegExp; args?: boolean }[] = [
  { re: /\bsed\b[^|;&]*\s-i\b|\bsed\s+-[a-zA-Z]*i/, target: /(\S+)\s*$/ }, // sed -i ... file
  { re: /\bperl\b[^|;&]*\s-[a-zA-Z]*p[a-zA-Z]*i|\bperl\b[^|;&]*\s-[a-zA-Z]*i[a-zA-Z]*p/, target: /(\S+)\s*$/ },
  { re: /\btee\b(?:\s+-a)?\s+(\S+)/ },
  { re: /\bcp\b(?:\s+-\S+)*\s+\S+\s+\S+/, target: /(\S+)\s*$/ }, // last argument is the destination, however many sources
  // mv removes its sources too, so every argument is a path it touches (a moved-away settings file is a write).
  { re: MV_CMD, args: true },
  { re: /\brm\b(?:\s+-\S+)*\s+(\S+)/ },
  { re: /\bgit\s+(?:apply|am|checkout\s+--|restore)\b/ },
  { re: /\bpatch\b\s+(?:-\S+\s+)*(\S+)?/ },
  { re: /\b(?:prettier|biome)\b[^|;&]*--write\b/ },
  { re: /\b(?:eslint|ruff|rubocop)\b[^|;&]*--fix\b/ },
  { re: /\b(?:black|gofmt\s+-w|cargo\s+fmt|ruff\s+format)\b/ },
];
// Redirect into a file: > or >> followed by a path. Not 2>&1, not >&2, not /dev/null, not process substitution.
const REDIRECT = /(?:^|[^\d&>])>>?\s*(?!&|\/dev\/null|\()([^\s;&|<>]+)/g;

const clean = (p: string) => p.replace(/^['"]|['"]$/g, '');

// Quoted text blanked to `_` at the same length, so separators inside a sed script cannot split or cut the command.
const blankQuotes = (s: string) => s.replace(/'[^']*'|"[^"]*"/g, (q) => q[0] + '_'.repeat(q.length - 2) + q.at(-1));

// Look at each simple command of a pipeline/list separately; positions come from the blanked copy.
function simpleParts(command: string): string[] {
  const blank = blankQuotes(command);
  const parts: string[] = [];
  let from = 0;
  for (const m of blank.matchAll(/&&|\|\||;|\n|\|/g)) { parts.push(command.slice(from, m.index)); from = m.index! + m[0].length; }
  parts.push(command.slice(from));
  return parts;
}

/**
 * The paths a shell command deletes or moves away: rm's arguments, and mv's sources (every argument but the last).
 * Only these can take a folder above a guarded path with them, so a copy into `.` or a move into `.` does not count.
 */
export function shellRemoves(command: string): string[] {
  const out: string[] = [];
  for (const part of simpleParts(command)) {
    const bp = blankQuotes(part);
    const cut = bp.search(/\s(?:\d*>|[&#])|\)\s*$/);
    const words = cut < 0 ? part : part.slice(0, cut);
    const bw = blankQuotes(words);
    // `git rm --cached` only unstages: the files stay on disk, so nothing is removed.
    if (/\bgit\b.*\brm\b/.test(bw) && /\s--cached(?=\s|$)/.test(bw)) continue;
    // rm is a command only at the start of a command (after VAR=…, sudo, command, xargs or git): `docker build --rm` is a flag.
    for (const [re, dropLast] of [[/^\s*(?:\w+=\S*\s+)*(?:(?:sudo|command|xargs|git)\s+(?:-\S+\s+)*)*rm\b((?:\s+\S+)*)/, false], [MV_CMD, true]] as const) {
      const m = re.exec(bw);
      if (!m) continue;
      const end = m.index + m[0].length;
      const args = words.slice(end - m[1].length, end).trim().split(/\s+/).filter((a) => a && !a.startsWith('-') && clean(a));
      for (const a of dropLast ? args.slice(0, -1) : args) out.push(clean(a));
    }
  }
  return out;
}

export function shellWrites(command: string): string[] {
  const files = new Set<string>();
  let unknown = false;
  for (const part of simpleParts(command)) {
    const bp = blankQuotes(part);
    // A `>` inside quotes is not a redirect; the target itself is read back from the original text.
    for (const m of bp.matchAll(REDIRECT)) { const end = m.index! + m[0].length; files.add(clean(part.slice(end - m[1].length, end))); }
    // The command's own words end at a redirect, background `&`, comment or closing paren.
    const cut = bp.search(/\s(?:\d*>|[&#])|\)\s*$/);
    const words = cut < 0 ? part : part.slice(0, cut);
    const bw = blankQuotes(words); // a writer's name inside quotes (grep "mv ") is not the command
    for (const w of WRITERS) {
      if (w.args) {
        const bm = w.re.exec(bw);
        if (!bm) continue;
        // The arguments as typed (quotes kept), at the positions the blanked copy matched.
        const end = bm.index + bm[0].length;
        // Every non-flag argument. shortcut: a quoted path with a space is split at the space.
        for (const a of words.slice(end - bm[1].length, end).trim().split(/\s+/)) if (a && !a.startsWith('-') && clean(a)) files.add(clean(a));
        continue;
      }
      const m = w.re.exec(words);
      if (!m) continue;
      const t = w.target ? w.target.exec(words)?.[1] : m[1];
      if (t && !t.startsWith('-')) files.add(clean(t)); else unknown = true;
    }
  }
  return files.size ? [...files] : unknown ? ['?'] : [];
}
