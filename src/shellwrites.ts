// Heuristic: which files does a shell command write? Agents often edit with sed -i, redirects or formatters instead
// of their edit tools, and both loop detection and the done check need to know an edit happened.
// Returns the files it can name, ['?'] when it clearly writes but the target is unclear, or [] for no write.
// ponytail: regex over the command line, no shell parser. Misses writes hidden in scripts (node -e, python -c);
// upgrade to a real shell tokenizer if false negatives matter.

const WRITERS: { re: RegExp; target?: RegExp }[] = [
  { re: /\bsed\b[^|;&]*\s-i\b|\bsed\s+-[a-zA-Z]*i/, target: /(\S+)\s*$/ }, // sed -i ... file
  { re: /\bperl\b[^|;&]*\s-[a-zA-Z]*p[a-zA-Z]*i|\bperl\b[^|;&]*\s-[a-zA-Z]*i[a-zA-Z]*p/, target: /(\S+)\s*$/ },
  { re: /\btee\b(?:\s+-a)?\s+(\S+)/ },
  { re: /\b(?:cp|mv)\b(?:\s+-\S+)*\s+\S+\s+\S+/, target: /(\S+)\s*$/ }, // last argument is the destination, however many sources
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

export function shellWrites(command: string): string[] {
  const files = new Set<string>();
  let unknown = false;
  // Look at each simple command of a pipeline/list separately; positions come from the blanked copy.
  const blank = blankQuotes(command);
  const parts: string[] = [];
  let from = 0;
  for (const m of blank.matchAll(/&&|\|\||;|\n|\|/g)) { parts.push(command.slice(from, m.index)); from = m.index! + m[0].length; }
  parts.push(command.slice(from));
  for (const part of parts) {
    const bp = blankQuotes(part);
    // A `>` inside quotes is not a redirect; the target itself is read back from the original text.
    for (const m of bp.matchAll(REDIRECT)) { const end = m.index! + m[0].length; files.add(clean(part.slice(end - m[1].length, end))); }
    // The command's own words end at a redirect, background `&`, comment or closing paren.
    const cut = bp.search(/\s(?:\d*>|[&#])|\)\s*$/);
    const words = cut < 0 ? part : part.slice(0, cut);
    for (const w of WRITERS) {
      const m = w.re.exec(words);
      if (!m) continue;
      const t = w.target ? w.target.exec(words)?.[1] : m[1];
      if (t && !t.startsWith('-')) files.add(clean(t)); else unknown = true;
    }
  }
  return files.size ? [...files] : unknown ? ['?'] : [];
}
