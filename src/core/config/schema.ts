import { z } from 'zod';

/**
 * The on-disk shape of ~/.laracrew files. Everything here is what the *user* writes;
 * `resolve.ts` turns it into the fully-defaulted runtime shape the supervisor consumes.
 */

export const restartPolicy = z.enum(['never', 'on-failure', 'always']);
export type RestartPolicy = z.infer<typeof restartPolicy>;

export const watchStrategy = z.enum(['restart', 'artisan-queue-restart', 'none']);
export type WatchStrategy = z.infer<typeof watchStrategy>;

export const readyProbeSchema = z
  .object({
    tcp: z.string().optional(), // "127.0.0.1:6379"
    http: z.string().url().optional(),
    logMatch: z.string().optional(), // regex source
    delayMs: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().positive().default(30_000),
    intervalMs: z.number().int().positive().default(250),
  })
  .strict()
  .refine((p) => Boolean(p.tcp ?? p.http ?? p.logMatch ?? p.delayMs !== undefined), {
    message: 'a `ready` probe needs one of: tcp, http, logMatch, delayMs',
  });
export type ReadyProbe = z.infer<typeof readyProbeSchema>;

export const backoffSchema = z
  .object({
    initialMs: z.number().int().positive().default(1_000),
    maxMs: z.number().int().positive().default(30_000),
    factor: z.number().positive().default(2),
    maxRestarts: z.number().int().nonnegative().default(10),
    /** Stay up this long and the attempt counter resets, so a slow leak can't exhaust it. */
    resetAfterMs: z.number().int().positive().default(60_000),
  })
  .strict();
export type Backoff = z.infer<typeof backoffSchema>;

export const stopPolicySchema = z
  .object({
    /** Laravel-native graceful shutdown, e.g. "queue:restart" or "horizon:terminate". */
    artisan: z.string().optional(),
    signal: z.string().default('SIGTERM'),
    graceMs: z.number().int().positive().default(10_000),
  })
  .strict();
export type StopPolicy = z.infer<typeof stopPolicySchema>;

export const watchSchema = z
  .object({
    paths: z.array(z.string()).min(1),
    ignore: z.array(z.string()).default([]),
    strategy: watchStrategy.default('restart'),
    debounceMs: z.number().int().nonnegative().default(800),
  })
  .strict();
export type WatchConfig = z.infer<typeof watchSchema>;

export const metricsSchema = z
  .object({
    queues: z.array(z.string()).default([]),
    streams: z
      .array(z.object({ key: z.string(), group: z.string() }).strict())
      .default([]),
  })
  .strict();
export type MetricsConfig = z.infer<typeof metricsSchema>;

/** `cmd` accepts a shell line or an argv array. The array form skips shell parsing. */
export const commandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const serviceSchema = z
  .object({
    name: z.string().min(1),
    project: z.string().optional(),
    cmd: commandSchema.optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).default({}),
    groups: z.array(z.string()).default([]),
    needs: z.array(z.string()).default([]),
    ready: readyProbeSchema.optional(),
    restart: restartPolicy.optional(),
    backoff: backoffSchema.partial().optional(),
    stop: stopPolicySchema.partial().optional(),
    watch: watchSchema.optional(),
    metrics: metricsSchema.optional(),
    url: z.string().optional(),
    /** Health-checked but never spawned: Redis, MySQL, a Docker service. */
    external: z.boolean().default(false),
    /** false = defined but not launched; press `s` in the TUI to start it when you need it. */
    autostart: z.boolean().default(true),
    enabled: z.boolean().default(true),
    color: z.string().optional(),
  })
  .strict()
  .refine((s) => s.external || s.cmd !== undefined, {
    message: 'a service needs a `cmd` unless it is marked `external: true`',
  });
export type ServiceConfig = z.infer<typeof serviceSchema>;

export const projectSchema = z
  .object({
    path: z.string().min(1),
    php: z.string().default('php'),
    envFile: z.string().default('.env'),
    color: z.string().optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectSchema>;

export const projectsFileSchema = z
  .object({ projects: z.record(projectSchema).default({}) })
  .strict();

export const profileSchema = z
  .object({
    only: z.array(z.string()).default([]),
    except: z.array(z.string()).default([]),
  })
  .strict();
export type ProfileConfig = z.infer<typeof profileSchema>;

export const stackDefaultsSchema = z
  .object({
    restart: restartPolicy.default('on-failure'),
    backoff: backoffSchema.partial().default({}),
    stop: stopPolicySchema.partial().default({}),
    logs: z
      .object({
        /** Lines kept in memory per service, for the live log view. */
        maxLines: z.number().int().positive().default(5_000),
        /**
         * On by default: an in-memory buffer holds minutes, and losing the exception you
         * just watched scroll past is the fastest way to stop trusting the tool.
         */
        toFile: z.boolean().default(true),
        /** Rotate a service's log once it passes this size. */
        maxFileBytes: z.number().int().positive().default(5_000_000),
        /** How many rotated files to keep beside the current one. */
        keepFiles: z.number().int().nonnegative().default(1),
      })
      .strict()
      .default({}),
  })
  .strict();
export type StackDefaults = z.infer<typeof stackDefaultsSchema>;

export const stackSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** The global command name `laracrew link` installs for this stack. Defaults to `name`. */
    command: z.string().min(1).optional(),
    /** Project keys pulled in from ~/.laracrew/projects.yaml. */
    use: z.array(z.string()).default([]),
    /** Projects declared inline; merged over the shared ones. */
    projects: z.record(projectSchema).default({}),
    defaults: stackDefaultsSchema.default({}),
    services: z.array(serviceSchema).min(1),
    profiles: z.record(profileSchema).default({}),
    hooks: z
      .object({ preUp: z.string().nullish(), postDown: z.string().nullish() })
      .strict()
      .default({}),
  })
  .strict();
export type StackConfig = z.infer<typeof stackSchema>;

export const globalConfigSchema = z
  .object({
    theme: z.enum(['auto', 'dark', 'light', 'mono', 'high-contrast']).default('auto'),
    editor: z.string().optional(),
    defaultStack: z.string().optional(),
    metricsIntervalMs: z.number().int().positive().default(2_000),
  })
  .strict();
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export const taskStepSchema: z.ZodType<TaskStep, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z
      .object({
        project: z.string().optional(),
        cwd: z.string().optional(),
        cmd: commandSchema,
        continueOnError: z.boolean().default(false),
      })
      .strict(),
    z.object({ parallel: z.array(taskStepSchema).min(1) }).strict(),
  ]),
);
export type TaskStep =
  | { project?: string; cwd?: string; cmd: string | string[]; continueOnError: boolean }
  | { parallel: TaskStep[] };

export const taskSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    pauseServices: z.array(z.string()).default([]),
    steps: z.array(taskStepSchema).min(1),
  })
  .strict();
export type TaskConfig = z.infer<typeof taskSchema>;
