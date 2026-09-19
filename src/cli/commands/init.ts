import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../../core/config/paths.js';
import { paint } from '../render/colors.js';
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

  console.log(`${paint('bold', 'laracrew')} home: ${result.root}`);
  for (const file of result.created) console.log(`  ${paint('green', '+')} ${path.relative(result.root, file)}`);
  for (const file of result.skipped) {
    console.log(`  ${paint('gray', '·')} ${path.relative(result.root, file)} ${paint('gray', '(kept)')}`);
  }

  if (result.examples) {
    console.log(`
${paint('bold', 'Next:')}
  ${paint('cyan', 'laracrew up example')}      run the demo stack — proves it works, no Laravel needed
  ${paint('cyan', 'laracrew link example')}    install it as a global command you can type from anywhere
  edit ${paint('gray', path.join(result.root, 'projects.yaml'))} with your project paths,
  then ${paint('cyan', 'laracrew doctor dual')} and ${paint('cyan', 'laracrew up dual')}
`);
    return;
  }

  console.log(`
${paint('bold', 'Next:')}
  ${paint('cyan', 'laracrew init --examples')}   add a runnable demo stack and a two-project template
  or write your own at ${paint('gray', path.join(result.root, 'stacks', '<name>', 'stack.yaml'))}
  then ${paint('cyan', 'laracrew ls')} and ${paint('cyan', 'laracrew up <name>')}
`);
};
