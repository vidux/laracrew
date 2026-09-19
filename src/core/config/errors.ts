import type { ZodError, ZodIssue } from 'zod';

/**
 * Config problems are the most common failure a user hits, so they get a real error type
 * with file/line context and a suggestion — never a raw zod issue tree.
 */
export class ConfigError extends Error {
  readonly file?: string;
  readonly details: string[];

  constructor(message: string, opts: { file?: string; details?: string[]; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ConfigError';
    this.file = opts.file;
    this.details = opts.details ?? [];
  }

  /** Multi-line, terminal-ready rendering. */
  format(): string {
    const head = this.file ? `${this.file}\n  ${this.message}` : this.message;
    if (this.details.length === 0) return head;
    return `${head}\n${this.details.map((d) => `  - ${d}`).join('\n')}`;
  }
}

const levenshtein = (a: string, b: string): number => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
    }
  }
  return rows[a.length]![b.length]!;
};

/** "watchs" -> "watch". Returns undefined when nothing is close enough to be helpful. */
export const didYouMean = (input: string, candidates: readonly string[]): string | undefined => {
  let best: { word: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (!best || distance < best.distance) best = { word: candidate, distance };
  }
  if (!best) return undefined;
  const threshold = Math.max(2, Math.floor(input.length / 3));
  return best.distance <= threshold ? best.word : undefined;
};

const pathOf = (issue: ZodIssue): string =>
  issue.path.length === 0
    ? '(root)'
    : issue.path
        .map((segment, index) => (typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`))
        .join('');

/** Turns a ZodError into one readable line per problem, with spelling suggestions. */
export const formatZodIssues = (error: ZodError, knownKeys: readonly string[] = []): string[] =>
  error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys
        .map((key) => {
          const suggestion = didYouMean(key, knownKeys);
          const at = pathOf(issue);
          const where = at === '(root)' ? '' : ` at ${at}`;
          return suggestion
            ? `unknown field "${key}"${where} — did you mean "${suggestion}"?`
            : `unknown field "${key}"${where}`;
        })
        .join('; ');
    }
    return `${pathOf(issue)}: ${issue.message}`;
  });

/** Every field name the schema knows about, used to power "did you mean". */
export const KNOWN_SERVICE_KEYS = [
  'name',
  'project',
  'cmd',
  'cwd',
  'env',
  'groups',
  'needs',
  'ready',
  'restart',
  'backoff',
  'stop',
  'watch',
  'metrics',
  'url',
  'external',
  'autostart',
  'enabled',
  'color',
] as const;

export const KNOWN_STACK_KEYS = [
  'name',
  'description',
  'command',
  'use',
  'projects',
  'defaults',
  'services',
  'profiles',
  'hooks',
] as const;

export const ALL_KNOWN_KEYS = [...KNOWN_SERVICE_KEYS, ...KNOWN_STACK_KEYS] as const;
