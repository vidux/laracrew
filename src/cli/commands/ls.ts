import { existsSync } from 'node:fs';
import { listStacks, listTasks, loadSharedProjects, loadStack } from '../../core/config/load.js';
import { paths } from '../../core/config/paths.js';
import { ConfigError } from '../../core/config/errors.js';
import { listLinks } from './link.js';
import { padEnd, paint } from '../render/colors.js';

export const lsCommand = (env: NodeJS.ProcessEnv = process.env, json = false): number => {
  const home = paths(env);

  if (!existsSync(home.root)) {
    console.error(`${paint('yellow', 'no laracrew home yet')} — run ${paint('cyan', 'laracrew init')}`);
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

  console.log(paint('gray', home.root));

  console.log(`\n${paint('bold', 'STACKS')}`);
  if (stacks.length === 0) console.log(paint('gray', '  none'));
  const width = Math.max(4, ...stacks.map((stack) => stack.name.length));
  for (const stack of stacks) {
    const label = stack.valid ? paint('cyan', padEnd(stack.name, width)) : paint('red', padEnd(stack.name, width));
    const meta = stack.valid ? paint('gray', `${stack.services} services`) : paint('red', 'invalid');
    console.log(`  ${label}  ${meta}  ${paint('gray', stack.description)}`);
    if (stack.command) {
      console.log(`  ${' '.repeat(width)}  ${paint('green', `$ ${stack.command}`)} ${paint('gray', '(global command)')}`);
    }
    if (stack.profiles.length > 0) {
      console.log(`  ${' '.repeat(width)}  ${paint('gray', `profiles: ${stack.profiles.join(', ')}`)}`);
    }
  }

  console.log(`\n${paint('bold', 'PROJECTS')}`);
  const projectKeys = Object.keys(projects);
  if (projectKeys.length === 0) console.log(paint('gray', '  none — add them to projects.yaml'));
  const projectWidth = Math.max(4, ...projectKeys.map((key) => key.length));
  for (const [key, project] of Object.entries(projects)) {
    const exists = existsSync(project.path);
    console.log(
      `  ${paint('magenta', padEnd(key, projectWidth))}  ${project.path} ${
        exists ? '' : paint('red', '(missing)')
      }`,
    );
  }

  console.log(`\n${paint('bold', 'TASKS')}`);
  if (taskNames.length === 0) console.log(paint('gray', '  none'));
  for (const task of taskNames) console.log(`  ${paint('green', task)}`);

  console.log('');
  return 0;
};
