import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ConfigError } from '../core/config/errors.js';
import { listStacks } from '../core/config/load.js';
import { loadGlobalConfig } from '../core/config/load.js';
import { color } from './render/colors.js';
import { marks } from './render/marks.js';
import { doctorCommand } from './commands/doctor.js';
import { draftAddCommand, draftCommand, draftPublishCommand } from './commands/draft.js';
import { initCommand } from './commands/init.js';
import { linkCommand, unlinkCommandAction } from './commands/link.js';
import { logsCommand } from './commands/logs.js';
import { lsCommand } from './commands/ls.js';
import { upCommand } from './commands/up.js';

/** Replaced by tsup at build time; only the `tsx` dev path falls through to the lookup below. */
declare const __LARACREW_VERSION__: string | undefined;

/** Walks up from this file to laracrew's own package.json — the depth differs dev vs bundled. */
const versionFromPackageJson = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up += 1) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'laracrew' && pkg.version) return pkg.version;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0-unknown';
};

export const VERSION =
  typeof __LARACREW_VERSION__ === 'string' ? __LARACREW_VERSION__ : versionFromPackageJson();

/**
 * Picks the stack when the user did not name one: the configured default, else the only
 * stack that exists, else an error that lists the options.
 */
export const resolveStackName = (explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string => {
  if (explicit) return explicit;

  const configured = loadGlobalConfig(env).defaultStack;
  if (configured) return configured;

  const stacks = listStacks(env);
  if (stacks.length === 1) return stacks[0]!;
  if (stacks.length === 0) {
    throw new ConfigError('no stacks defined yet — run `laracrew init`');
  }
  throw new ConfigError(
    `several stacks exist, so name one: ${stacks.join(', ')}`,
    { details: ['or set `defaultStack:` in ~/.laracrew/config.yaml'] },
  );
};

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export const buildProgram = (): Command => {
  const program = new Command();

  program
    .name('laracrew')
    .description('Boot and supervise all the long-running processes of your projects with one command.')
    .version(VERSION, '-v, --version')
    .showHelpAfterError()
    .configureHelp({
      styleTitle: (text) => color.bold(text),
      styleCommandText: (text) => color.cyan(text),
      styleSubcommandText: (text) => color.cyan(text),
      styleOptionText: (text) => color.green(text),
      styleArgumentText: (text) => color.yellow(text),
    })
    .configureOutput({
      // One colour decision for the whole program — ours, so NO_COLOR is honoured here too.
      getOutHasColors: () => color.level > 0,
      getErrHasColors: () => color.level > 0,
      outputError: (message, write) => write(`${marks().fail} ${color.red(message.trimEnd())}
`),
    });

  program
    .command('init')
    .description('create ~/.laracrew')
    .option('--examples', 'also write a runnable demo stack and a two-project template')
    .action((options: { examples?: boolean }) => {
      initCommand({ examples: options.examples ?? false });
    });

  const draft = program
    .command('draft')
    .description('build a stack step by step in the current folder, then publish it')
    .argument('[name]', 'start a draft with this stack name, or show it if it exists; omit to show the only draft here')
    .option('--force', 'start over when a draft of that name already exists here')
    .action((name: string | undefined, options: { force?: boolean }) => {
      process.exitCode = draftCommand(name, options);
    });

  draft
    .command('add')
    .description('append a service to the draft in this folder')
    .requiredOption('--command, --cmd <line>', 'what to run, e.g. "php artisan queue:work"')
    .option('--project <key>', 'the project it runs in — any short key, e.g. api')
    .option('--path <dir>', "the project's folder, or where the command runs when there is no --project; defaults to this folder")
    .option('--name <service>', 'service name (default: project + command, e.g. api:queue:work)')
    .option('--default-state <state>', '"running" (default) or "stopped": defined, but idle until you start it')
    .option('--draft <name>', 'which draft, when this folder holds several')
    .action((options: Record<string, unknown>) => {
      process.exitCode = draftAddCommand({
        command: (options.command ?? options.cmd) as string,
        project: options.project as string | undefined,
        path: options.path as string | undefined,
        name: options.name as string | undefined,
        state: options.defaultState as string | undefined,
        draft: options.draft as string | undefined,
      });
    });

  draft
    .command('publish')
    .description('validate the draft and install it as a stack in ~/.laracrew')
    .option('--force', 'replace a stack of the same name')
    .option('--link', 'also install the global command, as `laracrew link` would')
    .option('--draft <name>', 'which draft, when this folder holds several')
    .action((options: { force?: boolean; link?: boolean; draft?: string }) => {
      process.exitCode = draftPublishCommand(options);
    });

  program
    .command('ls')
    .alias('list')
    .description('list stacks, projects and tasks')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      process.exitCode = lsCommand(process.env, options.json ?? false);
    });

  program
    .command('up')
    .argument('[stack]', 'stack to boot')
    .description('boot a stack and supervise it')
    .option('--only <selector>', 'only these services or groups (repeatable, comma-separated)', collect, [])
    .option('--except <selector>', 'skip these services or groups (repeatable, comma-separated)', collect, [])
    .option('--profile <name>', 'apply a profile from the stack')
    .option('--plain', 'prefixed interleaved logs instead of the full-screen view')
    .option('--json', 'newline-delimited JSON events')
    .action(async (stack: string | undefined, options: Record<string, unknown>) => {
      const name = resolveStackName(stack);
      process.exitCode = await upCommand(name, {
        only: options.only as string[],
        except: options.except as string[],
        profile: options.profile as string | undefined,
        plain: options.plain as boolean | undefined,
        json: options.json as boolean | undefined,
      });
    });

  program
    .command('logs')
    .argument('[service]', 'service to read; omit for every service in the stack')
    .description('read what a stack wrote to disk, after the fact')
    .option('--stack <name>', 'which stack (defaults the same way `up` does)')
    .option('-n, --lines <count>', 'how many lines to show', (value: string) => Number(value), 200)
    .option('-f, --follow', 'keep printing new lines as they arrive')
    .option('--since <window>', 'only lines newer than this: 10m, 2h, 1d, or a date')
    .option('--all', 'merge every service in the stack')
    .option('--list', 'list the services that have a log file')
    .action(async (service: string | undefined, options: Record<string, unknown>) => {
      process.exitCode = await logsCommand(service, {
        stack: resolveStackName(options.stack as string | undefined),
        lines: options.lines as number,
        follow: options.follow as boolean | undefined,
        since: options.since as string | undefined,
        all: options.all as boolean | undefined,
        list: options.list as boolean | undefined,
      });
    });

  program
    .command('link')
    .argument('[stack]', 'stack to give its own global command')
    .description('install a global command that boots one stack')
    .option('--as <name>', 'name the command something other than the stack name')
    .option('--all', 'link every stack that declares `command:` in its stack.yaml')
    .option('--dir <path>', 'install into this directory instead of the npm global bin')
    .option('--force', 'overwrite a name that is taken or reserved')
    .action((stack: string | undefined, options: Record<string, unknown>) => {
      process.exitCode = linkCommand(
        stack,
        {
          as: options.as as string | undefined,
          all: options.all as boolean | undefined,
          dir: options.dir as string | undefined,
          force: options.force as boolean | undefined,
        },
        process.env,
      );
    });

  program
    .command('unlink')
    .argument('<name>', 'the global command to remove')
    .description('remove a global command laracrew installed')
    .action((name: string) => {
      process.exitCode = unlinkCommandAction(name);
    });

  program
    .command('doctor')
    .argument('[stack]', 'stack to check')
    .description('check a stack before booting it')
    .action(async (stack: string | undefined) => {
      process.exitCode = await doctorCommand(resolveStackName(stack));
    });

  return program;
};

/** `ConfigError.format()` with the parts told apart by colour: heading, file, message, hints. */
const renderConfigError = (error: ConfigError): string => {
  const lines = [`${marks().fail} ${color.red.bold('config error')}`];
  if (error.file) lines.push(`  ${color.gray(error.file)}`);
  lines.push(`  ${error.message}`);
  for (const detail of error.details) lines.push(`    ${color.gray('-')} ${detail}`);
  return lines.join('\n');
};

export const run = async (argv: string[] = process.argv): Promise<void> => {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(renderConfigError(error));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
};
