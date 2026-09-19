import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Everything laracrew owns lives under one root. `LARACREW_HOME` overrides it,
 * which is what the test suite uses to stay out of the real home directory.
 */
export const home = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LARACREW_HOME ? path.resolve(env.LARACREW_HOME) : path.join(homedir(), '.laracrew');

export interface HomePaths {
  root: string;
  configFile: string;
  projectsFile: string;
  stacksDir: string;
  tasksDir: string;
  fragmentsDir: string;
  logsDir: string;
  runDir: string;
}

export const paths = (env: NodeJS.ProcessEnv = process.env): HomePaths => {
  const root = home(env);
  return {
    root,
    configFile: path.join(root, 'config.yaml'),
    projectsFile: path.join(root, 'projects.yaml'),
    stacksDir: path.join(root, 'stacks'),
    tasksDir: path.join(root, 'tasks'),
    fragmentsDir: path.join(root, 'fragments'),
    logsDir: path.join(root, 'logs'),
    runDir: path.join(root, 'run'),
  };
};

export const stackDir = (name: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(paths(env).stacksDir, name);

export const stackFile = (name: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(stackDir(name, env), 'stack.yaml');

export const taskFile = (name: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(paths(env).tasksDir, `${name}.yaml`);
