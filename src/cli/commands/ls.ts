import { existsSync } from 'node:fs';
import { listStacks, listTasks, loadSharedProjects, loadStack } from '../../core/config/load.js';
import { paths } from '../../core/config/paths.js';
import { ConfigError } from '../../core/config/errors.js';
import { listLinks } from './link.js';
import { color, padEnd } from '../render/colors.js';
import { marks } from '../render/marks.js';

export const lsCommand = (env: NodeJS.ProcessEnv = process.env, json = false): number => {
  const home = paths(env);
  const mark = marks(env);

  if (!existsSync(home.root)) {
    console.error(`${mark.warn} ${color.yellow('no laracrew home yet')} — run ${color.cyan('laracrew init')}`);
    return 1;
  }

  const stackNames = listStacks(env);
  const taskNames = listTasks(env);
  const projects = loadSharedProjects(env);

  const linkedByStack = new Map(listLinks({ env }).map((link) => [link.stack, link.name] as const));

  const stacks = stackNames.map((name) => {
    try {
      const { config } = loadStack(name, env);
      return {
        name,
        description: config.description ?? '',
        services: config.services.length,
        profiles: Object.keys(config.profiles),
        command: linkedByStack.get(name) ?? null,
        valid: true,
      };
    } catch (error) {
      return {
        name,
        description: error instanceof ConfigError ? error.message : 'invalid',
        services: 0,
        profiles: [],
        command: linkedByStack.get(name) ?? null,
        valid: false,
      };
    }
  });

  if (json) {
    console.log(JSON.stringify({ root: home.root, stacks, tasks: taskNames, projects }, null, 2));
    return 0;
  }

  const heading = (label: string, count: number): string => `\n${color.bold(label)} ${color.gray(`(${count})`)}`;

  console.log(`${color.bold('laracrew')} ${color.gray(home.root)}`);

  console.log(heading('STACKS', stacks.length));
  if (stacks.length === 0) {
    console.log(color.gray('  none — run `laracrew init --examples`, or write stacks/<name>/stack.yaml'));
  }
  const width = Math.max(4, ...stacks.map((stack) => stack.name.length));
  const indent = ' '.repeat(width + 4);
  for (const stack of stacks) {
    if (stack.valid) {
      const meta = padEnd(`${stack.services} service${stack.services === 1 ? '' : 's'}`, 11);
      console.log(`  ${color.cyan.bold(padEnd(stack.name, width))}  ${color.gray(meta)}  ${stack.description}`.trimEnd());
    } else {
      console.log(
        `${mark.fail} ${color.red.bold(padEnd(stack.name, width))}  ${color.red(padEnd('invalid', 11))}  ${color.red(stack.description)}`,
      );
    }
    if (stack.command) console.log(`${indent}${color.green(`$ ${stack.command}`)} ${color.gray('global command')}`);
    if (stack.profiles.length > 0) console.log(`${indent}${color.gray(`profiles: ${stack.profiles.join(', ')}`)}`);
  }

  const projectKeys = Object.keys(projects);
  console.log(heading('PROJECTS', projectKeys.length));
  if (projectKeys.length === 0) console.log(color.gray('  none — add them to projects.yaml'));
  const projectWidth = Math.max(4, ...projectKeys.map((key) => key.length));
  for (const [key, project] of Object.entries(projects)) {
    const exists = existsSync(project.path);
    const lead = exists ? '  ' : `${mark.fail} `;
    const where = exists ? project.path : color.red(`${project.path} (missing)`);
    console.log(`${lead}${color.magenta.bold(padEnd(key, projectWidth))}  ${where}`);
  }

  console.log(heading('TASKS', taskNames.length));
  if (taskNames.length === 0) console.log(color.gray('  none'));
  for (const task of taskNames) console.log(`  ${color.green(task)}`);

  console.log('');
  return 0;
};
