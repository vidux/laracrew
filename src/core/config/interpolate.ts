import { ConfigError } from './errors.js';

export interface InterpolationContext {
  /** process env of laracrew itself */
  env: NodeJS.ProcessEnv;
  /** the current service's project, when it has one */
  project?: { path: string; env: Record<string, string> };
  /** the stack's own folder, for hooks and fragments */
  stackDir?: string;
  /** collected by ${port:N} so `doctor` can report clashes */
  ports?: Set<number>;
}

const TOKEN = /\$\{([^}]*)\}/g;

const splitOnce = (input: string, separator: string): [string, string | undefined] => {
  const index = input.indexOf(separator);
  return index === -1 ? [input, undefined] : [input.slice(0, index), input.slice(index + separator.length)];
};

/**
 * Supported tokens:
 *   ${env:FOO}                  laracrew's own environment
 *   ${env:FOO:fallback}         with a default when unset
 *   ${project.path}             the service's project root
 *   ${project.env:REDIS_PORT}   a value from that project's .env
 *   ${stack.dir}                the stack folder
 *   ${port:8000}                a port, recorded for collision checks
 */
export const interpolate = (input: string, ctx: InterpolationContext): string =>
  input.replace(TOKEN, (match, body: string) => {
    const [scheme, rest] = splitOnce(body.trim(), ':');

    switch (scheme) {
      case 'env': {
        if (!rest) throw new ConfigError(`\${env:...} needs a variable name, got "${match}"`);
        const [key, fallback] = splitOnce(rest, ':');
        const value = ctx.env[key];
        if (value !== undefined) return value;
        if (fallback !== undefined) return fallback;
        throw new ConfigError(`environment variable "${key}" is not set (used in "${match}")`);
      }

      case 'project.path': {
        if (!ctx.project) throw new ConfigError(`"${match}" used on a service that has no \`project\``);
        return ctx.project.path;
      }

      case 'project.env': {
        if (!ctx.project) throw new ConfigError(`"${match}" used on a service that has no \`project\``);
        if (!rest) throw new ConfigError(`\${project.env:...} needs a variable name, got "${match}"`);
        const [key, fallback] = splitOnce(rest, ':');
        const value = ctx.project.env[key];
        if (value !== undefined) return value;
        if (fallback !== undefined) return fallback;
        throw new ConfigError(`"${key}" is not in the project's .env (used in "${match}")`);
      }

      case 'stack.dir': {
        if (!ctx.stackDir) throw new ConfigError(`"${match}" used outside a stack folder`);
        return ctx.stackDir;
      }

      case 'port': {
        const port = Number(rest);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new ConfigError(`"${match}" is not a valid port number`);
        }
        ctx.ports?.add(port);
        return String(port);
      }

      default:
        throw new ConfigError(
          `unknown token "${match}" — supported: \${env:VAR}, \${project.path}, \${project.env:VAR}, \${stack.dir}, \${port:N}`,
        );
    }
  });

/** Walks any parsed-YAML value and interpolates every string in it. */
export const interpolateDeep = <T>(value: T, ctx: InterpolationContext): T => {
  if (typeof value === 'string') return interpolate(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, ctx)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Guard against prototype pollution from a hand-written YAML file.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = interpolateDeep(item, ctx);
    }
    return out as unknown as T;
  }
  return value;
};
