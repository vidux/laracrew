import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { ConfigError } from '../../core/config/errors.js';
import { parseYaml, validateStack } from '../../core/config/load.js';
import { stackDir, stackFile } from '../../core/config/paths.js';
import type { StackConfig } from '../../core/config/schema.js';
import { color, padEnd } from '../render/colors.js';
import { marks, nextSteps } from '../render/marks.js';
import { linkCommand } from './link.js';

/**
 * A stack built one command at a time in the folder you are standing in, then published into
 * ~/.laracrew. The draft is an ordinary stack.yaml — same schema, same validation — so it can
 * be edited by hand, kept next to the code and committed.
 */

const SUFFIX = '.laracrew.yaml';
const DRAFT_FILE = /^(.+)\.laracrew\.ya?ml$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Commands that say how something runs, not what it is — skipped when deriving a name. */
const RUNNERS = new Set(['node', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'python', 'python3', 'php', 'run', 'exec', 'poetry']);

const forward = (value: string): string => value.replace(/\\/g, '/');

// realpath so a Windows 8.3 short name and its long form count as the same folder.
const canonical = (value: string): string => {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
};

const samePath = (a: string, b: string): boolean => {
  const [x, y] = [canonical(a), canonical(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const draftFile = (name: string, cwd: string = process.cwd()): string => path.join(cwd, `${name}${SUFFIX}`);

export interface DraftRef {
  name: string;
  file: string;
}

/** Every draft in a folder, by stack name. */
export const listDrafts = (cwd: string = process.cwd()): DraftRef[] =>
  readdirSync(cwd)
    .map((entry) => ({ entry, match: DRAFT_FILE.exec(entry) }))
    .filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
    .map(({ entry, match }) => ({ name: match[1]!, file: path.join(cwd, entry) }))
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The draft a command works on: the one named, else the only one in the folder. `pick` is how
 * the caller's command names a draft, for the message when there are several.
 */
export const resolveDraft = (cwd: string = process.cwd(), name?: string, pick = '--draft <name>'): DraftRef => {
  if (name) {
    const file = draftFile(name, cwd);
    if (!existsSync(file)) {
      throw new ConfigError(`no draft named "${name}" in ${cwd}`, { details: ['start one with `laracrew draft <name>`'] });
    }
    return { name, file };
  }
  const drafts = listDrafts(cwd);
  if (drafts.length === 1) return drafts[0]!;
  if (drafts.length === 0) {
    throw new ConfigError(`no draft in ${cwd}`, { details: ['start one with `laracrew draft <name>`'] });
  }
  throw new ConfigError(`several drafts here: ${drafts.map((draft) => draft.name).join(', ')} — pick one with ${pick}`);
};

// Reads sensibly both as a draft and after publish copies it into ~/.laracrew verbatim.
const template = (name: string): string => `# Built with \`laracrew draft\`. Add services with \`laracrew draft add\`, install the stack with
# \`laracrew draft publish\`, or edit by hand — this is an ordinary stack.yaml.
#
#   laracrew draft add --project api --path C:/work/api --command "php artisan queue:work"
#   laracrew draft add --project api --command "php artisan schedule:work"
#   laracrew draft add --command "npm run dev" --default-state stopped
name: ${name}
command: ${name} # \`laracrew link ${name}\` installs this as a global command
projects: {}
services: []
`;

export const createDraft = (name: string, options: { cwd?: string; force?: boolean } = {}): string => {
  const cwd = options.cwd ?? process.cwd();
  if (!NAME.test(name)) {
    throw new ConfigError(`"${name}" is not a usable stack name — letters, digits, dot, dash and underscore only`);
  }
  if (name === 'add' || name === 'publish') {
    throw new ConfigError(`"${name}" would clash with \`laracrew draft ${name}\` — pick another name`);
  }
  const file = draftFile(name, cwd);
  if (existsSync(file) && !options.force) {
    throw new ConfigError(`${path.basename(file)} already exists here`, {
      details: ['add to it with `laracrew draft add`, or pass --force to start over'],
    });
  }
  writeFileSync(file, template(name), 'utf8');
  return file;
};

// ---------------------------------------------------------------- add

const readDraft = (file: string): Document => {
  const doc = parseDocument(readFileSync(file, 'utf8'), { prettyErrors: true });
  const [problem] = doc.errors;
  if (problem) throw new ConfigError(`invalid YAML: ${problem.message}`, { file });
  if (!isMap(doc.contents)) throw new ConfigError('the draft should be a YAML mapping (name:, services: …)', { file });
  return doc;
};

const mapAt = (doc: Document, key: string, file: string): YAMLMap => {
  let node: unknown = doc.get(key);
  if (node === undefined || node === null) {
    node = doc.createNode({});
    doc.set(key, node);
  }
  if (!isMap(node)) throw new ConfigError(`\`${key}:\` should be a map`, { file });
  return node;
};

const seqAt = (doc: Document, key: string, file: string): YAMLSeq => {
  let node: unknown = doc.get(key);
  if (node === undefined || node === null) {
    node = doc.createNode([]);
    doc.set(key, node);
  }
  if (!isSeq(node)) throw new ConfigError(`\`${key}:\` should be a list`, { file });
  return node;
};

/**
 * `php artisan queue:work …` → `queue:work`; otherwise the first word that is not a runner
 * (`npm run dev` → `dev`, `node server.js` → `server`). Prefixed with the project key.
 */
export const deriveServiceName = (command: string, project?: string): string => {
  const artisan = /\bartisan\s+([A-Za-z0-9:_.-]+)/.exec(command);
  let verb = artisan?.[1];
  if (!verb) {
    const words = command
      .trim()
      .split(/\s+/)
      .filter((word) => word && !word.startsWith('-'))
      .map((word) => word.split(/[\\/]/).pop() ?? word);
    const word = words.find((candidate) => !RUNNERS.has(candidate.toLowerCase())) ?? words[0] ?? 'service';
    verb = word.replace(/\.[A-Za-z0-9]+$/, '');
  }
  const clean =
    verb
      .toLowerCase()
      .replace(/[^a-z0-9:_.-]+/g, '-')
      .replace(/^[-.:]+|[-.:]+$/g, '') || 'service';
  return project ? `${project}:${clean}` : clean;
};

const uniqueName = (base: string, taken: Set<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const parseState = (value: string | undefined): boolean => {
  if (value === undefined || value === 'running') return true;
  if (value === 'stopped') return false;
  throw new ConfigError(`--default-state is "running" or "stopped", not "${value}"`);
};

export interface AddOptions {
  command: string;
  project?: string;
  path?: string;
  name?: string;
  /** "running" (the default) or "stopped" — a stopped service is defined but idle until started. */
  state?: string;
  draft?: string;
  cwd?: string;
}

export interface AddResult {
  draft: string;
  file: string;
  service: { name: string; cmd: string; autostart: boolean; cwd?: string };
  project?: { key: string; path: string; created: boolean };
  /** How many services the draft holds now. */
  services: number;
}

export const addToDraft = (options: AddOptions): AddResult => {
  const cwd = options.cwd ?? process.cwd();
  const command = options.command.trim();
  if (!command) throw new ConfigError('--command needs something to run, e.g. "php artisan queue:work"');
  const autostart = parseState(options.state);
  if (options.project !== undefined && !NAME.test(options.project)) {
    throw new ConfigError(`"${options.project}" is not a usable project key — letters, digits, dot, dash and underscore only`);
  }

  const { name: draftName, file } = resolveDraft(cwd, options.draft);
  const doc = readDraft(file);

  let project: AddResult['project'];
  if (options.project) {
    const projects = mapAt(doc, 'projects', file);
    const wanted = options.path ? forward(path.resolve(cwd, options.path)) : undefined;
    const existing: unknown = projects.get(options.project);
    if (existing !== undefined && existing !== null) {
      const current = isMap(existing) ? String(existing.get('path') ?? '') : '';
      if (wanted && !samePath(current, wanted)) {
        throw new ConfigError(`project "${options.project}" already points at ${current}`, {
          file,
          details: ['a draft keeps one path per project — leave --path off to reuse it, or pick another key'],
        });
      }
      project = { key: options.project, path: current, created: false };
    } else {
      const dir = wanted ?? forward(cwd);
      projects.set(options.project, doc.createNode({ path: dir }));
      projects.flow = false;
      project = { key: options.project, path: dir, created: true };
    }
  }

  const services = seqAt(doc, 'services', file);
  const taken = new Set(services.items.map((item) => (isMap(item) ? String(item.get('name') ?? '') : '')));
  let name: string;
  if (options.name) {
    if (!SERVICE_NAME.test(options.name)) {
      throw new ConfigError(`"${options.name}" is not a usable service name — letters, digits, colon, dot, dash and underscore only`);
    }
    if (taken.has(options.name)) throw new ConfigError(`a service named "${options.name}" is already in the draft`, { file });
    name = options.name;
  } else {
    name = uniqueName(deriveServiceName(command, options.project), taken);
  }

  // Key order is what a reader sees first, so: what it is, where, what it runs, then the extras.
  const service: Record<string, unknown> = { name };
  if (options.project) service.project = options.project;
  service.cmd = command;
  // Without a project there is nothing to inherit a folder from, and a linked command runs from
  // anywhere — so the folder is pinned now, while we know it.
  const serviceCwd = options.project ? undefined : forward(path.resolve(cwd, options.path ?? '.'));
  if (serviceCwd) service.cwd = serviceCwd;
  if (!autostart) service.autostart = false;
  services.add(doc.createNode(service));
  services.flow = false;

  writeFileSync(file, doc.toString(), 'utf8');

  return {
    draft: draftName,
    file,
    service: { name, cmd: command, autostart, ...(serviceCwd ? { cwd: serviceCwd } : {}) },
    ...(project ? { project } : {}),
    services: services.items.length,
  };
};

// ---------------------------------------------------------------- show

export interface DraftSummary {
  name: string;
  file: string;
  stackName: string;
  command: string;
  projects: { key: string; path: string }[];
  services: { name: string; cmd: string; project?: string; autostart: boolean }[];
}

/** What the draft holds, read leniently — this is for looking, publish is what validates. */
export const describeDraft = (cwd: string = process.cwd(), name?: string): DraftSummary => {
  const ref = resolveDraft(cwd, name, 'laracrew draft <name>');
  const raw = parseYaml(readFileSync(ref.file, 'utf8'), ref.file);
  const record = isRecord(raw) ? raw : {};
  const stackName = typeof record.name === 'string' ? record.name : ref.name;

  const projects = isRecord(record.projects)
    ? Object.entries(record.projects).map(([key, value]) => ({
        key,
        path: isRecord(value) && typeof value.path === 'string' ? value.path : '',
      }))
    : [];

  const services = Array.isArray(record.services)
    ? record.services.filter(isRecord).map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '?',
        cmd: Array.isArray(entry.cmd) ? entry.cmd.map(String).join(' ') : typeof entry.cmd === 'string' ? entry.cmd : '',
        ...(typeof entry.project === 'string' ? { project: entry.project } : {}),
        autostart: entry.autostart !== false,
      }))
    : [];

  return {
    name: ref.name,
    file: ref.file,
    stackName,
    command: typeof record.command === 'string' ? record.command : stackName,
    projects,
    services,
  };
};

// ---------------------------------------------------------------- publish

export interface PublishOptions {
  cwd?: string;
  draft?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PublishResult {
  name: string;
  draft: string;
  file: string;
  target: string;
  replaced: boolean;
  config: StackConfig;
}

/** Validates the draft with the real schema and copies it, comments and all, into the home. */
export const publishDraft = (options: PublishOptions = {}): PublishResult => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const { name: draftName, file } = resolveDraft(cwd, options.draft);

  const source = readFileSync(file, 'utf8');
  const raw = parseYaml(source, file);
  if (isRecord(raw) && Array.isArray(raw.services) && raw.services.length === 0) {
    throw new ConfigError('the draft has no services yet', {
      file,
      details: ['add one with `laracrew draft add --command "…"`'],
    });
  }
  const config = validateStack(raw, file);

  const target = stackFile(config.name, env);
  const replaced = existsSync(target);
  if (replaced && !options.force) {
    throw new ConfigError(`a stack named "${config.name}" already exists`, {
      file: target,
      details: ['pass --force to replace it, or change `name:` in the draft'],
    });
  }
  mkdirSync(stackDir(config.name, env), { recursive: true });
  writeFileSync(target, source, 'utf8');

  return { name: config.name, draft: draftName, file, target, replaced, config };
};

// ---------------------------------------------------------------- console

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const draftCommand = (
  name: string | undefined,
  options: { force?: boolean } = {},
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const mark = marks(env);

  // `draft <name>` starts a draft, and shows it when it already exists — one verb for both.
  if (name && (options.force || !existsSync(draftFile(name, cwd)))) {
    const file = createDraft(name, { cwd, ...(options.force ? { force: true } : {}) });
    console.log(`${mark.ok} started draft ${color.bold(name)} ${mark.arrow} ${color.gray(path.basename(file))}`);
    console.log(
      `\n${nextSteps(
        [
          ['laracrew draft add', `--project api --path C:/work/api --command ${color.green('"php artisan queue:work"')}`],
          ['', `--project api --command ${color.green('"php artisan schedule:work"')}   ${color.gray('the path is remembered')}`],
          ['', `--command ${color.green('"npm run dev"')} --default-state stopped   ${color.gray('idle until you press s')}`],
          ['laracrew draft', 'show what the draft holds so far'],
          ['laracrew draft publish', `install it as the ${color.cyan(name)} stack in ~/.laracrew`],
        ],
        env,
      )}\n`,
    );
    return 0;
  }

  const draft = describeDraft(cwd, name);
  console.log(`${color.bold('draft')} ${color.gray('·')} ${color.cyan.bold(draft.stackName)} ${color.gray(path.basename(draft.file))}`);
  if (draft.command !== draft.stackName) console.log(`  ${color.gray(`command: ${draft.command}`)}`);

  console.log(`\n${color.bold('PROJECTS')} ${color.gray(`(${draft.projects.length})`)}`);
  if (draft.projects.length === 0) console.log(color.gray('  none — `--project <key> --path <dir>` on the next add'));
  const keyWidth = Math.max(4, ...draft.projects.map((project) => project.key.length));
  for (const project of draft.projects) {
    console.log(`  ${color.magenta.bold(padEnd(project.key, keyWidth))}  ${project.path}`);
  }

  console.log(`\n${color.bold('SERVICES')} ${color.gray(`(${draft.services.length})`)}`);
  if (draft.services.length === 0) console.log(color.gray('  none yet — `laracrew draft add --command "…"`'));
  const nameWidth = Math.max(4, ...draft.services.map((service) => service.name.length));
  for (const service of draft.services) {
    const idle = service.autostart ? '' : `  ${color.yellow('idle until started')}`;
    console.log(`  ${color.cyan.bold(padEnd(service.name, nameWidth))}  ${service.cmd}${idle}`);
  }

  console.log(
    `\n${nextSteps(
      [
        ['laracrew draft add', `--command ${color.green('"…"')} to add another`],
        ['laracrew draft publish', `install it as the ${color.cyan(draft.stackName)} stack`],
      ],
      env,
    )}\n`,
  );
  return 0;
};

export const draftAddCommand = (
  options: Omit<AddOptions, 'cwd'>,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const result = addToDraft({ ...options, cwd });
  const mark = marks(env);

  const idle = result.service.autostart ? '' : `  ${color.yellow('idle until started')}`;
  console.log(`${mark.ok} added ${color.bold(result.service.name)} ${mark.arrow} ${color.gray(result.service.cmd)}${idle}`);
  if (result.project?.created) {
    const guessed = options.path ? '' : `  ${color.yellow('this folder — pass --path if that is wrong')}`;
    console.log(`  ${mark.ok} project ${color.magenta.bold(result.project.key)} ${mark.arrow} ${color.gray(result.project.path)}${guessed}`);
  }
  if (result.service.cwd) console.log(`  ${color.gray(`runs in ${result.service.cwd}`)}`);
  console.log(
    `  ${color.gray(`${plural(result.services, 'service')} in ${path.basename(result.file)} — \`laracrew draft publish\` when done`)}`,
  );
  return 0;
};

export const draftPublishCommand = (
  options: { force?: boolean; link?: boolean; draft?: string } = {},
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const result = publishDraft({
    cwd,
    env,
    ...(options.draft ? { draft: options.draft } : {}),
    ...(options.force ? { force: true } : {}),
  });
  const mark = marks(env);
  const command = result.config.command ?? result.name;

  console.log(
    `${mark.ok} ${color.green(result.replaced ? 'replaced' : 'published')} ${color.bold(result.name)} ${mark.arrow} ${color.gray(result.target)}`,
  );
  console.log(
    `  ${color.gray(
      `${plural(Object.keys(result.config.projects).length, 'project')}, ${plural(result.config.services.length, 'service')}; the draft stays at ${path.basename(result.file)}`,
    )}`,
  );

  if (options.link) {
    console.log('');
    const code = linkCommand(result.name, {}, env);
    if (code !== 0) return code;
  }

  const steps: [string, string][] = [
    [`laracrew doctor ${result.name}`, 'check paths, ports and PHP before the first boot'],
    [`laracrew up ${result.name}`, 'boot it'],
  ];
  if (!options.link) steps.push([`laracrew link ${result.name}`, `type ${color.cyan(command)} from anywhere to boot it`]);
  console.log(`\n${nextSteps(steps, env)}\n`);
  return 0;
};
