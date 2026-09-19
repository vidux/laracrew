import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { z } from 'zod';
import { ConfigError, formatZodIssues, ALL_KNOWN_KEYS } from './errors.js';
import { paths, stackDir, stackFile, taskFile } from './paths.js';
import {
  globalConfigSchema,
  projectsFileSchema,
  stackSchema,
  taskSchema,
  type GlobalConfig,
  type ProjectConfig,
  type StackConfig,
  type TaskConfig,
} from './schema.js';

/** Parses YAML, converting a syntax error into a ConfigError that names the line. */
export const parseYaml = (source: string, file: string): unknown => {
  try {
    return YAML.parse(source, { prettyErrors: true }) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`invalid YAML: ${message}`, { file, cause: error });
  }
};

export const readYamlFile = (file: string): unknown => {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`file not found`, { file, cause: error });
    }
    throw error;
  }
  return parseYaml(source, file);
};

// Generic over the schema, not its output: `.default()` makes input and output differ.
const validate = <S extends z.ZodTypeAny>(schema: S, value: unknown, file: string): z.infer<S> => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ConfigError('this file does not match the laracrew schema', {
    file,
    details: formatZodIssues(result.error, ALL_KNOWN_KEYS),
  });
};

/** ~/.laracrew/config.yaml — absent means "all defaults". */
export const loadGlobalConfig = (env: NodeJS.ProcessEnv = process.env): GlobalConfig => {
  const file = paths(env).configFile;
  if (!existsSync(file)) return globalConfigSchema.parse({});
  return validate(globalConfigSchema, readYamlFile(file), file);
};

/** ~/.laracrew/projects.yaml — absent means "no shared projects". */
export const loadSharedProjects = (env: NodeJS.ProcessEnv = process.env): Record<string, ProjectConfig> => {
  const file = paths(env).projectsFile;
  if (!existsSync(file)) return {};
  return validate(projectsFileSchema, readYamlFile(file), file).projects;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merges a stack's optional `services/*.yaml` fragments into the main document.
 * Each fragment is either a list of services or `{ services: [...] }`.
 */
const mergeServiceFragments = (document: unknown, dir: string): unknown => {
  const servicesDir = path.join(dir, 'services');
  if (!existsSync(servicesDir) || !statSync(servicesDir).isDirectory()) return document;
  if (!isRecord(document)) return document;

  const extra: unknown[] = [];
  for (const entry of readdirSync(servicesDir).sort()) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const file = path.join(servicesDir, entry);
    const fragment = readYamlFile(file);
    if (Array.isArray(fragment)) {
      extra.push(...fragment);
    } else if (isRecord(fragment) && Array.isArray(fragment.services)) {
      extra.push(...fragment.services);
    } else {
      throw new ConfigError('a service fragment must be a list of services, or { services: [...] }', { file });
    }
  }

  if (extra.length === 0) return document;
  const existing = Array.isArray(document.services) ? document.services : [];
  return { ...document, services: [...existing, ...extra] };
};

export interface LoadedStack {
  config: StackConfig;
  file: string;
  dir: string;
}

/** Loads ~/.laracrew/stacks/<name>/stack.yaml plus its fragments. */
export const loadStack = (name: string, env: NodeJS.ProcessEnv = process.env): LoadedStack => {
  const dir = stackDir(name, env);
  const file = stackFile(name, env);

  if (!existsSync(file)) {
    const available = listStacks(env);
    const hint = available.length > 0 ? ` Available: ${available.join(', ')}.` : ' Run `laracrew init` first.';
    throw new ConfigError(`no stack named "${name}".${hint}`, { file });
  }

  const document = mergeServiceFragments(readYamlFile(file), dir);
  const config = validate(stackSchema, document, file);

  if (config.name !== name) {
    throw new ConfigError(
      `stack folder is "${name}" but \`name:\` says "${config.name}" — they must match`,
      { file },
    );
  }

  return { config, file, dir };
};

export const listStacks = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const dir = paths(env).stacksDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'stack.yaml')))
    .map((entry) => entry.name)
    .sort();
};

export const listTasks = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const dir = paths(env).tasksDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => entry.replace(/\.ya?ml$/i, ''))
    .sort();
};

export const loadTask = (name: string, env: NodeJS.ProcessEnv = process.env): { config: TaskConfig; file: string } => {
  const file = taskFile(name, env);
  if (!existsSync(file)) {
    const available = listTasks(env);
    const hint = available.length > 0 ? ` Available: ${available.join(', ')}.` : '';
    throw new ConfigError(`no task named "${name}".${hint}`, { file });
  }
  return { config: validate(taskSchema, readYamlFile(file), file), file };
};
