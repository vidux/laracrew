import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../../core/config/paths.js';
import { color, padEnd } from '../render/colors.js';
import { marks } from '../render/marks.js';
import {
  CONFIG_YAML,
  EXAMPLE_STACK_YAML,
  HOME_README,
  PROJECTS_YAML,
  REAL_STACK_TEMPLATE,
  RESET_TASK_YAML,
} from './templates.js';

export interface InitOptions {
  /** Also write the demo stack, the two-project template and the sample task. */
  examples?: boolean;
}

export interface InitResult {
  root: string;
  created: string[];
  skipped: string[];
  examples: boolean;
}

/** Idempotent: re-running never overwrites something you edited. */
export const runInit = (env: NodeJS.ProcessEnv = process.env, options: InitOptions = {}): InitResult => {
  const home = paths(env);
  const created: string[] = [];
  const skipped: string[] = [];

  for (const dir of [home.root, home.stacksDir, home.tasksDir, home.fragmentsDir, home.logsDir, home.runDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const files: [string, string][] = [
    [home.configFile, CONFIG_YAML],
    [home.projectsFile, PROJECTS_YAML],
    [path.join(home.root, 'README.md'), HOME_README],
  ];

  if (options.examples) {
    mkdirSync(path.join(home.stacksDir, 'example'), { recursive: true });
    mkdirSync(path.join(home.stacksDir, 'dual'), { recursive: true });
    files.push(
      [path.join(home.stacksDir, 'example', 'stack.yaml'), EXAMPLE_STACK_YAML],
      [path.join(home.stacksDir, 'dual', 'stack.yaml'), REAL_STACK_TEMPLATE],
      [path.join(home.tasksDir, 'reset.yaml'), RESET_TASK_YAML],
    );
  }

  for (const [file, contents] of files) {
    if (existsSync(file)) {
      skipped.push(file);
      continue;
    }
    writeFileSync(file, contents, 'utf8');
    created.push(file);
  }

  return { root: home.root, created, skipped, examples: options.examples ?? false };
};

export const initCommand = (options: InitOptions = {}, env: NodeJS.ProcessEnv = process.env): void => {
  const result = runInit(env, options);
  const mark = marks(env);

  console.log(`${color.bold('laracrew home')} ${color.gray(result.root)}`);
  for (const file of result.created) console.log(`  ${mark.ok} ${path.relative(result.root, file)}`);
  for (const file of result.skipped) {
    console.log(`  ${mark.skip} ${color.gray(`${path.relative(result.root, file)} (kept)`)}`);
  }

  // One command per line, its purpose beside it; a continuation line lines up under the purpose.
  const step = (command: string, why: string): string => `  ${mark.hint} ${color.cyan(padEnd(command, 25))}  ${why}`;
  const more = (why: string): string => `${' '.repeat(31)}${why}`;

  if (result.examples) {
    console.log(`
${color.bold('Next')}
${step('laracrew up example', 'run the demo stack — proves it works, no Laravel needed')}
${step('laracrew link example', 'install it as a global command you can type from anywhere')}
${step('laracrew doctor dual', `check the real stack once ${color.gray(path.join(result.root, 'projects.yaml'))}`)}
${more(`has your project paths, then ${color.cyan('laracrew up dual')}`)}
`);
    return;
  }

  console.log(`
${color.bold('Next')}
${step('laracrew init --examples', 'add a runnable demo stack and a two-project template,')}
${more(`or write your own at ${color.gray(path.join(result.root, 'stacks', '<name>', 'stack.yaml'))}`)}
${step('laracrew up <name>', `boot it — ${color.cyan('laracrew ls')} shows what is defined`)}
`);
};
