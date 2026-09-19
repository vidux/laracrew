import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, didYouMean } from '../../core/config/errors.js';
import { paths } from '../../core/config/paths.js';
import { fileNamesFor } from '../../core/logs/file-sink.js';
import { followFile, parseSince, tailFile, toEntries } from '../../core/logs/read.js';
import type { LogLine } from '../../core/events/types.js';
import { asColorName, padEnd, paint } from '../render/colors.js';
import { write as safeWrite } from '../render/output.js';
import { prepareStack } from './up.js';

export interface LogsOptions {
  stack?: string;
  lines?: number;
  follow?: boolean;
  since?: string;
  all?: boolean;
  list?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const logDirFor = (stackName: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(paths(env).logsDir, stackName);

interface Target {
  service: string;
  file: string;
  color: string;
}

/** Every service of a stack that has a log file on disk. */
export const targetsFor = (stackName: string, env: NodeJS.ProcessEnv = process.env): Target[] => {
  const stack = prepareStack(stackName, { env });
  const dir = logDirFor(stackName, env);
  const names = fileNamesFor(stack.services.map((service) => service.name));

  return stack.services
    .map((service) => ({
      service: service.name,
      file: path.join(dir, names.get(service.name)!),
      color: service.color,
    }))
    .filter((target) => existsSync(target.file));
};

const formatEntry = (entry: LogLine, width: number, withName: boolean): string => {
  const time = new Date(entry.at || Date.now());
  const clock = [time.getHours(), time.getMinutes(), time.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');

  const who = withName ? `${paint(asColorName(undefined), padEnd(entry.service, width))} ` : '';
  const body = entry.stream === 'stderr' ? paint('red', entry.line) : entry.line;
  return `${paint('gray', clock)} ${who}${paint('gray', '|')} ${body}\n`;
};

export const logsCommand = async (service: string | undefined, options: LogsOptions = {}): Promise<number> => {
  const env = options.env ?? process.env;
  const stackName = options.stack;
  if (!stackName) throw new ConfigError('name a stack with --stack, or run `laracrew logs` from a known stack');

  const dir = logDirFor(stackName, env);
  const available = targetsFor(stackName, env);

  if (options.list) {
    if (available.length === 0) {
      console.log(paint('yellow', `no log files yet in ${dir}`));
      console.log(paint('gray', 'they appear once the stack has run at least once'));
      return 0;
    }
    console.log(paint('gray', dir));
    for (const target of available) {
      console.log(`  ${paint('cyan', target.service)}  ${paint('gray', path.basename(target.file))}`);
    }
    return 0;
  }

  if (available.length === 0) {
    console.error(paint('yellow', `no log files in ${dir}`));
    console.error(
      paint(
        'gray',
        'run the stack at least once, and check `defaults.logs.toFile` is not set to false',
      ),
    );
    return 1;
  }

  let selected: Target[];
  if (options.all || !service) {
    selected = available;
  } else {
    const match = available.find((target) => target.service === service);
    if (!match) {
      const suggestion = didYouMean(
        service,
        available.map((target) => target.service),
      );
      throw new ConfigError(
        `no log for service "${service}" in stack "${stackName}"` +
          (suggestion ? ` — did you mean "${suggestion}"?` : ''),
        { details: [`available: ${available.map((target) => target.service).join(', ')}`] },
      );
    }
    selected = [match];
  }

  const withName = selected.length > 1;
  const width = Math.max(...selected.map((target) => target.service.length));
  const limit = options.lines ?? 200;
  const since = options.since ? parseSince(options.since) : undefined;

  if (options.since && since === undefined) {
    throw new ConfigError(`could not read --since "${options.since}"`, {
      details: ['try a relative window like 10m, 2h, 1d, or an absolute date'],
    });
  }

  // History first, merged across services and ordered by time.
  const history: LogLine[] = [];
  for (const target of selected) {
    // When filtering by time we need a wider net than `limit`, since the matching lines
    // may be spread across a much longer file.
    history.push(...toEntries(target.service, tailFile(target.file, since ? Math.max(limit, 5_000) : limit)));
  }

  history.sort((a, b) => a.at - b.at);
  const filtered = since ? history.filter((entry) => entry.at >= since) : history;
  for (const entry of filtered.slice(-limit)) safeWrite(formatEntry(entry, width, withName));

  if (!options.follow) return 0;

  // Then tail.
  const controller = new AbortController();
  const stops = selected.map((target) =>
    followFile(target.file, {
      signal: controller.signal,
      onLines: (lines) => {
        for (const entry of toEntries(target.service, lines)) {
          safeWrite(formatEntry(entry, width, withName));
        }
      },
    }),
  );

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      controller.abort();
      for (const stop of stops) stop();
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });

  return 0;
};

/** Stacks that have a log directory, for a helpful error when none is named. */
export const stacksWithLogs = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const root = paths(env).logsDir;
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};
