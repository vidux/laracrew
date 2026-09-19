import path from 'node:path';
import { existsSync } from 'node:fs';
import { readProjectEnv } from '../laravel/env.js';
import { ConfigError, didYouMean } from './errors.js';
import { interpolateDeep, type InterpolationContext } from './interpolate.js';
import type { LoadedStack } from './load.js';
import {
  backoffSchema,
  stopPolicySchema,
  type Backoff,
  type MetricsConfig,
  type ProjectConfig,
  type ReadyProbe,
  type RestartPolicy,
  type ServiceConfig,
  type StopPolicy,
  type WatchConfig,
} from './schema.js';

export type Command =
  | { kind: 'shell'; line: string }
  | { kind: 'argv'; file: string; args: string[] };

export interface ResolvedProject {
  key: string;
  path: string;
  php: string;
  envFile: string;
  env: Record<string, string>;
  color: string;
}

/** Step 1 of the stop ladder, already resolved to something runnable. */
export interface GracefulStop {
  command: Command;
  cwd: string;
}

export interface ResolvedService {
  name: string;
  project?: ResolvedProject;
  command?: Command;
  /** From `stop.exec`, or from `stop.artisan` on a project. Absent = go straight to the signal. */
  graceful?: GracefulStop;
  cwd: string;
  env: Record<string, string>;
  groups: string[];
  needs: string[];
  ready?: ReadyProbe;
  restart: RestartPolicy;
  backoff: Backoff;
  stop: StopPolicy;
  watch?: WatchConfig;
  metrics?: MetricsConfig;
  url?: string;
  external: boolean;
  /** false = created but not launched by `up`; the user starts it on demand. */
  autostart: boolean;
  color: string;
}

export interface ResolvedStack {
  name: string;
  description?: string;
  dir: string;
  file: string;
  services: ResolvedService[];
  /** Topologically sorted groups; everything in a level can start in parallel. */
  levels: string[][];
  projects: Record<string, ResolvedProject>;
  ports: number[];
  logs: { maxLines: number; toFile: boolean; maxFileBytes: number; keepFiles: number };
}

export interface ResolveOptions {
  profile?: string;
  only?: string[];
  except?: string[];
  env?: NodeJS.ProcessEnv;
  sharedProjects?: Record<string, ProjectConfig>;
}

const PALETTE = ['cyan', 'magenta', 'green', 'yellow', 'blue', 'red'] as const;

const toCommand = (cmd: string | string[]): Command =>
  Array.isArray(cmd)
    ? { kind: 'argv', file: cmd[0]!, args: cmd.slice(1) }
    : { kind: 'shell', line: cmd };

/** Matches a service against a selector: its exact name, or one of its groups. */
const matches = (service: ResolvedService, selectors: string[]): boolean =>
  selectors.some((selector) => service.name === selector || service.groups.includes(selector));

const resolveProjects = (
  stack: LoadedStack,
  shared: Record<string, ProjectConfig>,
): Record<string, ResolvedProject> => {
  const wanted = new Map<string, ProjectConfig>();

  for (const key of stack.config.use) {
    const project = shared[key];
    if (!project) {
      const suggestion = didYouMean(key, Object.keys(shared));
      throw new ConfigError(
        `\`use:\` refers to project "${key}", which is not in projects.yaml` +
          (suggestion ? ` — did you mean "${suggestion}"?` : ''),
        { file: stack.file },
      );
    }
    wanted.set(key, project);
  }
  // Inline definitions win over shared ones with the same key.
  for (const [key, project] of Object.entries(stack.config.projects)) wanted.set(key, project);

  const out: Record<string, ResolvedProject> = {};
  let index = 0;
  for (const [key, project] of wanted) {
    const root = path.resolve(project.path);
    out[key] = {
      key,
      path: root,
      php: project.php,
      envFile: project.envFile,
      env: readProjectEnv(root, project.envFile),
      color: project.color ?? PALETTE[index % PALETTE.length]!,
    };
    index += 1;
  }
  return out;
};

const mergeService = (
  raw: ServiceConfig,
  stack: LoadedStack,
  projects: Record<string, ResolvedProject>,
  ports: Set<number>,
  processEnv: NodeJS.ProcessEnv,
  colorIndex: number,
): ResolvedService => {
  const defaults = stack.config.defaults;

  let project: ResolvedProject | undefined;
  if (raw.project) {
    project = projects[raw.project];
    if (!project) {
      const suggestion = didYouMean(raw.project, Object.keys(projects));
      throw new ConfigError(
        `service "${raw.name}" refers to project "${raw.project}", which this stack does not define` +
          (suggestion ? ` — did you mean "${suggestion}"?` : ''),
        { file: stack.file },
      );
    }
  }

  const ctx: InterpolationContext = {
    env: processEnv,
    stackDir: stack.dir,
    ports,
    ...(project ? { project: { path: project.path, env: project.env } } : {}),
  };

  let service: ServiceConfig;
  try {
    service = interpolateDeep(raw, ctx);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`service "${raw.name}": ${error.message}`, { file: stack.file, cause: error });
    }
    throw error;
  }

  const cwd = service.cwd
    ? path.resolve(project?.path ?? stack.dir, service.cwd)
    : (project?.path ?? stack.dir);

  // A service declaring its own graceful step replaces the inherited one, whichever kind it is.
  const inheritedStop = { ...defaults.stop };
  const ownStop = service.stop ?? {};
  if (ownStop.exec !== undefined) delete inheritedStop.artisan;
  if (ownStop.artisan !== undefined) delete inheritedStop.exec;
  const stop = stopPolicySchema.parse({ ...inheritedStop, ...ownStop });

  if (stop.exec !== undefined && stop.artisan !== undefined) {
    throw new ConfigError(
      `service "${service.name}" declares both \`stop.exec\` and \`stop.artisan\``,
      { file: stack.file, details: ['keep one — `artisan` is only shorthand for an `exec` that runs artisan'] },
    );
  }
  if (stop.artisan !== undefined && !project) {
    throw new ConfigError(
      `service "${service.name}" declares \`stop.artisan\` but belongs to no project`,
      {
        file: stack.file,
        details: ['`artisan` runs `<project php> artisan ...`, so it needs a project', 'for any other command use `stop.exec`'],
      },
    );
  }

  const graceful: GracefulStop | undefined = stop.exec
    ? { command: toCommand(stop.exec), cwd }
    : stop.artisan && project
      ? // artisan must run from the Laravel root even when the service sets its own cwd.
        { command: { kind: 'argv', file: project.php, args: ['artisan', ...stop.artisan.split(/\s+/)] }, cwd: project.path }
      : undefined;

  return {
    name: service.name,
    ...(project ? { project } : {}),
    ...(service.cmd ? { command: toCommand(service.cmd) } : {}),
    ...(graceful ? { graceful } : {}),
    cwd,
    env: { ...service.env },
    groups: service.groups,
    needs: service.needs,
    ...(service.ready ? { ready: service.ready } : {}),
    restart: service.restart ?? defaults.restart,
    backoff: backoffSchema.parse({ ...defaults.backoff, ...(service.backoff ?? {}) }),
    stop,
    ...(service.watch ? { watch: service.watch } : {}),
    ...(service.metrics ? { metrics: service.metrics } : {}),
    ...(service.url ? { url: service.url } : {}),
    external: service.external,
    autostart: service.autostart,
    color: service.color ?? project?.color ?? PALETTE[colorIndex % PALETTE.length]!,
  };
};

/**
 * Kahn's algorithm, but it keeps each "level" so the supervisor can start independent
 * services in parallel instead of one at a time. Throws with the actual cycle members.
 */
export const topoLevels = (services: ResolvedService[], file?: string): string[][] => {
  const names = new Set(services.map((s) => s.name));
  const remaining = new Map<string, Set<string>>();

  for (const service of services) {
    for (const need of service.needs) {
      if (!names.has(need)) {
        const suggestion = didYouMean(need, [...names]);
        throw new ConfigError(
          `service "${service.name}" needs "${need}", which is not in this stack` +
            (suggestion ? ` — did you mean "${suggestion}"?` : ''),
          file ? { file } : {},
        );
      }
    }
    remaining.set(service.name, new Set(service.needs));
  }

  const levels: string[][] = [];
  const done = new Set<string>();

  while (done.size < services.length) {
    const level = [...remaining.entries()]
      .filter(([name, needs]) => !done.has(name) && [...needs].every((need) => done.has(need)))
      .map(([name]) => name);

    if (level.length === 0) {
      const stuck = services.filter((s) => !done.has(s.name)).map((s) => s.name);
      throw new ConfigError(
        `dependency cycle between: ${stuck.join(' -> ')}`,
        file ? { file } : {},
      );
    }

    for (const name of level) done.add(name);
    levels.push(level);
  }

  return levels;
};

export const resolveStack = (stack: LoadedStack, options: ResolveOptions = {}): ResolvedStack => {
  const processEnv = options.env ?? process.env;
  const projects = resolveProjects(stack, options.sharedProjects ?? {});
  const ports = new Set<number>();

  const seen = new Set<string>();
  for (const service of stack.config.services) {
    if (seen.has(service.name)) {
      throw new ConfigError(`two services are both named "${service.name}"`, { file: stack.file });
    }
    seen.add(service.name);
  }

  let services = stack.config.services
    .filter((service) => service.enabled)
    .map((service, index) => mergeService(service, stack, projects, ports, processEnv, index));

  // Profile first, then explicit CLI flags, so --only can override a profile.
  const profile = options.profile ? stack.config.profiles[options.profile] : undefined;
  if (options.profile && !profile) {
    const suggestion = didYouMean(options.profile, Object.keys(stack.config.profiles));
    throw new ConfigError(
      `no profile "${options.profile}" in this stack` + (suggestion ? ` — did you mean "${suggestion}"?` : ''),
      { file: stack.file },
    );
  }

  const only = options.only?.length ? options.only : profile?.only;
  const except = options.except?.length ? options.except : profile?.except;

  if (only?.length) services = services.filter((service) => matches(service, only));
  if (except?.length) services = services.filter((service) => !matches(service, except));

  if (services.length === 0) {
    throw new ConfigError('the selection matched no services', { file: stack.file });
  }

  // A filtered-out dependency must not block the survivors.
  const kept = new Set(services.map((service) => service.name));
  services = services.map((service) => ({
    ...service,
    needs: service.needs.filter((need) => kept.has(need)),
  }));

  // An auto-started service cannot depend on one the user has to start by hand — that would
  // leave it waiting on a gate nobody opened.
  const manual = new Set(
    services.filter((service) => !service.autostart && !service.external).map((service) => service.name),
  );
  for (const service of services) {
    if (!service.autostart) continue;
    const blocked = service.needs.filter((need) => manual.has(need));
    if (blocked.length > 0) {
      throw new ConfigError(
        `service "${service.name}" starts at launch but needs "${blocked.join('", "')}", which ${
          blocked.length === 1 ? 'does' : 'do'
        } not`,
        { file: stack.file, details: ['give it `autostart: false` too, or start the dependency at launch'] },
      );
    }
  }

  for (const service of services) {
    if (!service.external && !existsSync(service.cwd)) {
      throw new ConfigError(
        `service "${service.name}" has cwd "${service.cwd}", which does not exist`,
        { file: stack.file },
      );
    }
  }

  return {
    name: stack.config.name,
    ...(stack.config.description ? { description: stack.config.description } : {}),
    dir: stack.dir,
    file: stack.file,
    services,
    levels: topoLevels(services, stack.file),
    projects,
    ports: [...ports].sort((a, b) => a - b),
    logs: stack.config.defaults.logs,
  };
};
