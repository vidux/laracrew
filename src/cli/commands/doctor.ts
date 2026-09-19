import { existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../../core/config/errors.js';
import type { ResolvedProject, ResolvedStack } from '../../core/config/resolve.js';
import { isPortFree, tcpProbe } from '../../core/health/probes.js';
import { runOnce } from '../../core/process/spawn.js';
import { paint } from '../render/colors.js';
import { prepareStack } from './up.js';

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  message: string;
  hint?: string;
}

const PORT_IN_COMMAND = /--port[= ](\d{2,5})/g;

/** Ports the stack will try to bind: ${port:N} tokens plus anything passed as --port. */
export const declaredPorts = (stack: ResolvedStack): number[] => {
  const ports = new Set<number>(stack.ports);
  for (const service of stack.services) {
    const line =
      service.command?.kind === 'shell'
        ? service.command.line
        : service.command
          ? [service.command.file, ...service.command.args].join(' ')
          : '';
    for (const match of line.matchAll(PORT_IN_COMMAND)) {
      const port = Number(match[1]);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
};

const redisTargetOf = (project: ResolvedProject): string =>
  `${project.env.REDIS_HOST ?? '127.0.0.1'}:${project.env.REDIS_PORT ?? '6379'}`;

/** Laravel's Str::slug($value, '_'). */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * The prefix Laravel will actually use. Most projects never set REDIS_PREFIX, and the
 * framework default is derived from APP_NAME — so two apps on one Redis database are usually
 * isolated anyway. Reading only REDIS_PREFIX here would cry wolf on every normal setup.
 */
export const redisPrefixOf = (project: ResolvedProject): string =>
  project.env.REDIS_PREFIX ?? `${slug(project.env.APP_NAME ?? 'laravel')}_database_`;

/** Which Redis logical namespace a project writes into — host:port/db + prefix. */
const redisNamespaceOf = (project: ResolvedProject): string =>
  `${redisTargetOf(project)}/${project.env.REDIS_DB ?? '0'}#${redisPrefixOf(project)}`;

const checkProjects = (stack: ResolvedStack): Finding[] => {
  const findings: Finding[] = [];

  for (const project of Object.values(stack.projects)) {
    if (!existsSync(project.path)) {
      findings.push({ level: 'error', message: `project "${project.key}": path does not exist — ${project.path}` });
      continue;
    }
    if (!existsSync(path.join(project.path, 'artisan'))) {
      findings.push({
        level: 'warn',
        message: `project "${project.key}": no \`artisan\` file in ${project.path}`,
        hint: 'laracrew will still run the commands, but this does not look like a Laravel root',
      });
    }
    if (Object.keys(project.env).length === 0) {
      findings.push({
        level: 'warn',
        message: `project "${project.key}": ${project.envFile} is missing or empty`,
        hint: 'queue/Redis checks and ${project.env:...} tokens need it',
      });
    }
  }

  return findings;
};

/** The check that pays for this whole command: two apps quietly sharing one Redis namespace. */
const checkRedisCollisions = (stack: ResolvedStack): Finding[] => {
  const findings: Finding[] = [];
  const projects = Object.values(stack.projects);

  const byNamespace = new Map<string, ResolvedProject[]>();
  for (const project of projects) {
    const namespace = redisNamespaceOf(project);
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), project]);
  }

  for (const [namespace, sharing] of byNamespace) {
    if (sharing.length < 2) continue;

    const queuesByProject = new Map<string, Set<string>>();
    const streamsByProject = new Map<string, Set<string>>();
    for (const service of stack.services) {
      if (!service.project || !service.metrics) continue;
      const key = service.project.key;
      for (const queue of service.metrics.queues) {
        queuesByProject.set(key, (queuesByProject.get(key) ?? new Set()).add(queue));
      }
      for (const stream of service.metrics.streams) {
        streamsByProject.set(key, (streamsByProject.get(key) ?? new Set()).add(`${stream.key}/${stream.group}`));
      }
    }

    const names = sharing.map((project) => project.key);
    const overlap = (map: Map<string, Set<string>>): string[] => {
      const counts = new Map<string, number>();
      for (const key of names) {
        for (const value of map.get(key) ?? []) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
    };

    const sharedQueues = overlap(queuesByProject);
    const sharedStreams = overlap(streamsByProject);

    if (sharedQueues.length > 0) {
      findings.push({
        level: 'error',
        message: `${names.join(' and ')} share Redis ${namespace} AND queue(s): ${sharedQueues.join(', ')}`,
        hint: "each project's workers will steal the other's jobs — set a different REDIS_DB or REDIS_PREFIX",
      });
    }
    if (sharedStreams.length > 0) {
      findings.push({
        level: 'error',
        message: `${names.join(' and ')} share Redis ${namespace} AND stream/group: ${sharedStreams.join(', ')}`,
        hint: 'two consumers in one group split the entries between them — give each project its own group name',
      });
    }
    if (sharedQueues.length === 0 && sharedStreams.length === 0) {
      findings.push({
        level: 'warn',
        message: `${names.join(' and ')} share Redis ${namespace}`,
        hint: 'no queue or stream overlap declared, but cache and session keys can still collide',
      });
    }
  }

  // Same server and database, different prefix: worth stating plainly, because it is the
  // thing standing between two projects' queues.
  const byServer = new Map<string, ResolvedProject[]>();
  for (const project of projects) {
    const server = `${redisTargetOf(project)}/${project.env.REDIS_DB ?? '0'}`;
    byServer.set(server, [...(byServer.get(server) ?? []), project]);
  }
  for (const [server, sharing] of byServer) {
    if (sharing.length < 2) continue;
    const prefixes = new Set(sharing.map(redisPrefixOf));
    if (prefixes.size === sharing.length) {
      findings.push({
        level: 'ok',
        message: `${sharing.map((p) => p.key).join(' and ')} share Redis ${server} but are isolated by prefix (${[...prefixes].join(', ')})`,
      });
    }
  }

  return findings;
};

const checkQueueConnections = (stack: ResolvedStack): Finding[] => {
  const findings: Finding[] = [];
  const workerProjects = new Set(
    stack.services
      .filter((service) => {
        // A service you start by hand is a deliberate choice, not a misconfiguration.
        if (!service.autostart) return false;
        const line =
          service.command?.kind === 'shell'
            ? service.command.line
            : service.command
              ? [service.command.file, ...service.command.args].join(' ')
              : '';
        return /\b(queue:work|queue:listen|horizon)\b/.test(line);
      })
      .map((service) => service.project?.key)
      .filter((key): key is string => Boolean(key)),
  );

  for (const key of workerProjects) {
    const project = stack.projects[key];
    if (!project) continue;
    const connection = project.env.QUEUE_CONNECTION;
    if (connection === undefined) continue;
    if (connection === 'sync') {
      findings.push({
        level: 'error',
        message: `project "${key}" runs a queue worker but QUEUE_CONNECTION=sync`,
        hint: 'jobs run inline on dispatch, so the worker will sit idle forever — set it to redis or database',
      });
    }
  }

  return findings;
};

const checkPhp = async (stack: ResolvedStack): Promise<Finding[]> => {
  const binaries = new Set(Object.values(stack.projects).map((project) => project.php));
  const findings: Finding[] = [];

  for (const binary of binaries) {
    try {
      const result = await runOnce({ kind: 'argv', file: binary, args: ['--version'] }, {
        cwd: process.cwd(),
        timeoutMs: 8_000,
      });
      if (result.code === 0) {
        const version = result.stdout.split('\n')[0]?.trim() ?? '';
        findings.push({ level: 'ok', message: `php: ${version}` });
      } else {
        findings.push({ level: 'error', message: `"${binary} --version" exited with code ${result.code}` });
      }
    } catch {
      findings.push({
        level: 'error',
        message: `cannot run "${binary}"`,
        hint: 'put PHP on PATH, or set an absolute path in projects.yaml',
      });
    }
  }

  return findings;
};

const checkPorts = async (stack: ResolvedStack): Promise<Finding[]> => {
  const findings: Finding[] = [];
  for (const port of declaredPorts(stack)) {
    const free = await isPortFree(port);
    findings.push(
      free
        ? { level: 'ok', message: `port ${port} is free` }
        : {
            level: 'error',
            message: `port ${port} is already in use`,
            hint: 'something else is bound to it — a stale worker from a previous run, most likely',
          },
    );
  }
  return findings;
};

const checkRedisReachable = async (stack: ResolvedStack): Promise<Finding[]> => {
  const targets = new Set(Object.values(stack.projects).map(redisTargetOf));
  const findings: Finding[] = [];
  for (const target of targets) {
    const result = await tcpProbe(target, 2_000);
    findings.push(
      result.ok
        ? { level: 'ok', message: `redis reachable at ${target}` }
        : { level: 'warn', message: `redis not reachable at ${target}${result.detail ? ` (${result.detail})` : ''}` },
    );
  }
  return findings;
};

export const runDoctor = async (stackName: string, env: NodeJS.ProcessEnv = process.env): Promise<Finding[]> => {
  let stack: ResolvedStack;
  try {
    stack = prepareStack(stackName, { env });
  } catch (error) {
    if (error instanceof ConfigError) return [{ level: 'error', message: error.format() }];
    throw error;
  }

  const findings: Finding[] = [
    { level: 'ok', message: `stack "${stack.name}" is valid — ${stack.services.length} services` },
    ...checkProjects(stack),
    ...checkQueueConnections(stack),
    ...checkRedisCollisions(stack),
  ];

  const async = await Promise.all([checkPhp(stack), checkPorts(stack), checkRedisReachable(stack)]);
  return [...findings, ...async.flat()];
};

export const doctorCommand = async (stackName: string, env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const findings = await runDoctor(stackName, env);

  const glyph = { ok: paint('green', '✔'), warn: paint('yellow', '▲'), error: paint('red', '✖') };
  for (const finding of findings) {
    console.log(`${glyph[finding.level]} ${finding.message}`);
    if (finding.hint) console.log(`  ${paint('gray', finding.hint)}`);
  }

  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;

  console.log(
    `\n${errors === 0 ? paint('green', 'no blocking problems') : paint('red', `${errors} problem(s)`)}` +
      (warnings > 0 ? paint('yellow', `, ${warnings} warning(s)`) : ''),
  );

  return errors > 0 ? 1 : 0;
};
