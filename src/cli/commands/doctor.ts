import { existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../../core/config/errors.js';
import type { ResolvedProject, ResolvedService, ResolvedStack } from '../../core/config/resolve.js';
import { describeProbe, httpProbe, isPortFree, tcpProbe } from '../../core/health/probes.js';
import { runOnce } from '../../core/process/spawn.js';
import { paint } from '../render/colors.js';
import { prepareStack } from './up.js';

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  message: string;
  hint?: string;
}

const PORT_IN_COMMAND = /--port[= ](\d{2,5})/g;

/** The command line a service will actually run, in one form the pattern checks can match. */
const commandLine = (service: ResolvedService): string => {
  if (!service.command) return '';
  return service.command.kind === 'shell'
    ? service.command.line
    : [service.command.file, ...service.command.args].join(' ');
};

/** `php`, `php8.2`, `C:\php\php.exe` — anywhere in the line, not just at the front. */
const PHP_BINARY = /(^|[\\/\s"'])php[\d.]*(\.exe)?(\s|$)/i;

/**
 * Which projects are PHP projects at all.
 *
 * laracrew supervises any process, so a stack can be pure Node, Python or Go. Running
 * `php --version` for those projects is noise on a machine that has PHP and a blocking
 * error on one that does not — so every Laravel-specific check is gated on this.
 */
const phpProjects = (stack: ResolvedStack): Set<string> => {
  const keys = new Set<string>();
  for (const service of stack.services) {
    const key = service.project?.key;
    if (!key) continue;
    const line = commandLine(service);
    const php = stack.projects[key]?.php;
    // `stop.artisan` runs `<php> artisan ...`, so it needs PHP whatever the service itself is.
    if (service.stop.artisan || PHP_BINARY.test(line) || (php !== undefined && line.startsWith(php))) {
      keys.add(key);
    }
  }
  return keys;
};

/** Env keys whose value being "redis" means the project talks to Redis. */
const REDIS_DRIVER_KEYS = [
  'QUEUE_CONNECTION',
  'CACHE_STORE',
  'CACHE_DRIVER',
  'SESSION_DRIVER',
  'BROADCAST_CONNECTION',
  'BROADCAST_DRIVER',
];

/**
 * Which projects talk to Redis — from their own env, or from what their services run.
 * Without this every project defaults to 127.0.0.1:6379, so two Node projects with no
 * `.env` would be reported as sharing a Redis namespace neither of them uses.
 */
const redisProjects = (stack: ResolvedStack): Set<string> => {
  const keys = new Set<string>();

  for (const [key, project] of Object.entries(stack.projects)) {
    const declared = Object.keys(project.env).some((name) => name.startsWith('REDIS_'));
    const driver = REDIS_DRIVER_KEYS.some((name) => project.env[name]?.toLowerCase() === 'redis');
    if (declared || driver) keys.add(key);
  }

  for (const service of stack.services) {
    const key = service.project?.key;
    if (!key) continue;
    // Horizon is Redis-only, and declared metrics are read straight off Redis.
    if (service.metrics || /\b(redis|horizon)\b/i.test(commandLine(service))) keys.add(key);
  }

  return keys;
};

/** Ports the stack will try to bind: ${port:N} tokens plus anything passed as --port. */
export const declaredPorts = (stack: ResolvedStack): number[] => {
  const ports = new Set<number>(stack.ports);
  for (const service of stack.services) {
    for (const match of commandLine(service).matchAll(PORT_IN_COMMAND)) {
      const port = Number(match[1]);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
};

/** redis://[user:pass@]host:port[/db] — the usual form outside Laravel. */
const parseRedisUrl = (url: string): { host: string; port: string } | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.hostname ? { host: parsed.hostname, port: parsed.port || '6379' } : undefined;
  } catch {
    return undefined;
  }
};

const redisTargetOf = (project: ResolvedProject): string => {
  const url = project.env.REDIS_URL ? parseRedisUrl(project.env.REDIS_URL) : undefined;
  const host = project.env.REDIS_HOST ?? url?.host ?? '127.0.0.1';
  const port = project.env.REDIS_PORT ?? url?.port ?? '6379';
  return `${host}:${port}`;
};

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

const checkProjects = (stack: ResolvedStack, php: Set<string>, redis: Set<string>): Finding[] => {
  const findings: Finding[] = [];

  for (const project of Object.values(stack.projects)) {
    if (!existsSync(project.path)) {
      findings.push({ level: 'error', message: `project "${project.key}": path does not exist — ${project.path}` });
      continue;
    }
    // Only a project something runs `php` for is expected to have an artisan file.
    if (php.has(project.key) && !existsSync(path.join(project.path, 'artisan'))) {
      findings.push({
        level: 'warn',
        message: `project "${project.key}": no \`artisan\` file in ${project.path}`,
        hint: 'laracrew will still run the commands, but this does not look like a Laravel root',
      });
    }
    // A Node or Python project with no .env is normal; one whose checks need it is not.
    if (Object.keys(project.env).length === 0 && (php.has(project.key) || redis.has(project.key))) {
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
const checkRedisCollisions = (stack: ResolvedStack, redis: Set<string>): Finding[] => {
  const findings: Finding[] = [];
  // Projects that never touch Redis would otherwise all collide on the synthesized default.
  const projects = Object.values(stack.projects).filter((project) => redis.has(project.key));

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
        return /\b(queue:work|queue:listen|horizon)\b/.test(commandLine(service));
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

/** Only for projects something actually runs PHP for — a Node or Python stack needs none. */
const checkPhp = async (stack: ResolvedStack, php: Set<string>): Promise<Finding[]> => {
  const binaries = new Set(
    Object.values(stack.projects)
      .filter((project) => php.has(project.key))
      .map((project) => project.php),
  );
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

/**
 * The language-agnostic dependency check: every `external: true` service is something the
 * stack expects to already be running, and it already declares how to test for it.
 */
const checkExternalServices = async (stack: ResolvedStack): Promise<Finding[]> => {
  const external = stack.services.filter((service) => service.external && (service.ready?.tcp ?? service.ready?.http));

  return Promise.all(
    external.map(async (service): Promise<Finding> => {
      const probe = service.ready!;
      const label = describeProbe(probe);
      const result = probe.http
        ? await httpProbe(probe.http, 2_000)
        : await tcpProbe(probe.tcp!, 2_000);

      return result.ok
        ? { level: 'ok', message: `${service.name} is reachable — ${label}` }
        : {
            level: 'warn',
            message: `${service.name} is not reachable — ${label}${result.detail ? ` (${result.detail})` : ''}`,
            hint: 'laracrew never starts an external service; anything that needs it will wait at its gate',
          };
    }),
  );
};

/** Ports already covered by an external service's own gate, so they are not probed twice. */
const externalTcpTargets = (stack: ResolvedStack): Set<string> =>
  new Set(
    stack.services
      .filter((service) => service.external && service.ready?.tcp)
      .map((service) => service.ready!.tcp!),
  );

const checkRedisReachable = async (stack: ResolvedStack, redis: Set<string>): Promise<Finding[]> => {
  const covered = externalTcpTargets(stack);
  const targets = new Set(
    Object.values(stack.projects)
      .filter((project) => redis.has(project.key))
      .map(redisTargetOf)
      .filter((target) => !covered.has(target)),
  );

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

  // Classified once: every Laravel-specific check below is gated on these, so a stack with
  // no PHP in it gets no PHP findings and a stack with no Redis gets no Redis findings.
  const php = phpProjects(stack);
  const redis = redisProjects(stack);

  const findings: Finding[] = [
    { level: 'ok', message: `stack "${stack.name}" is valid — ${stack.services.length} services` },
    ...checkProjects(stack, php, redis),
    ...checkQueueConnections(stack),
    ...checkRedisCollisions(stack, redis),
  ];

  const async = await Promise.all([
    checkPhp(stack, php),
    checkPorts(stack),
    checkExternalServices(stack),
    checkRedisReachable(stack, redis),
  ]);
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
