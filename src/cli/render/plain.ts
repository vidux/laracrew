import type { EventBus } from '../../core/events/bus.js';
import type { LaracrewEvent } from '../../core/events/types.js';
import type { ResolvedStack } from '../../core/config/resolve.js';
import { asColorName, padEnd, paint as defaultPaint, type Painter } from './colors.js';
import { write as safeWrite } from './output.js';

export interface PlainRendererOptions {
  stack: ResolvedStack;
  write?: (text: string) => void;
  painter?: Painter;
  timestamps?: boolean;
  now?: () => Date;
}

const time = (date: Date): string =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}`;

/**
 * `concurrently`-style interleaved output: one fixed-width, coloured prefix per service.
 * This is what runs when stdout is not a TTY, and what CI sees.
 */
export const attachPlainRenderer = (bus: EventBus, options: PlainRendererOptions): (() => void) => {
  const write = options.write ?? ((text: string) => safeWrite(text));
  const painter = options.painter ?? defaultPaint;
  const showTime = options.timestamps ?? true;
  const now = options.now ?? (() => new Date());

  const colorOf = new Map(options.stack.services.map((service) => [service.name, asColorName(service.color)]));
  const width = Math.max(8, ...options.stack.services.map((service) => service.name.length), 'laracrew'.length);

  const line = (service: string, text: string, colorName = colorOf.get(service) ?? 'cyan') => {
    const stamp = showTime ? painter('gray', `${time(now())} `) : '';
    const prefix = painter(colorName, padEnd(service, width));
    write(`${stamp}${prefix} ${painter('gray', '|')} ${text}\n`);
  };

  const system = (text: string, level: 'info' | 'warn' | 'error' = 'info') => {
    const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'gray';
    line('laracrew', painter(color, text), 'bold');
  };

  const handle = (event: LaracrewEvent): void => {
    switch (event.type) {
      case 'service:log':
        line(event.log.service, event.log.line);
        break;

      case 'stack:starting': {
        system(`starting ${event.stack} (${event.services.length} services)`);
        const manual = options.stack.services.filter((service) => !service.autostart && !service.external);
        if (manual.length > 0) {
          system(`not launched (autostart: false): ${manual.map((service) => service.name).join(', ')}`);
        }
        break;
      }

      case 'stack:ready':
        system(`${event.stack} ready in ${(event.durationMs / 1000).toFixed(1)}s`);
        break;

      case 'stack:stopping':
        system(`stopping ${event.stack}…`);
        break;

      case 'stack:stopped':
        system(`${event.stack} stopped`);
        break;

      case 'service:spawned':
        line(event.service, painter('gray', `$ ${event.command}`));
        break;

      case 'service:ready':
        line(event.service, painter('green', `ready (${event.probe}) in ${event.durationMs}ms`));
        break;

      case 'service:exit':
        if (!event.intentional) {
          line(
            event.service,
            painter('red', `exited (${event.signal ? `signal ${event.signal}` : `code ${event.code}`})`),
          );
        }
        break;

      case 'service:restart':
        line(
          event.service,
          painter('yellow', `restarting in ${event.delayMs}ms (attempt ${event.attempt}/${event.maxAttempts})`),
        );
        break;

      case 'service:state':
        if (event.to === 'failed') {
          line(event.service, painter('red', `failed${event.detail ? `: ${event.detail}` : ''}`));
        }
        break;

      case 'notice':
        if (event.service) {
          line(event.service, painter(event.level === 'error' ? 'red' : 'yellow', event.message));
        } else {
          system(event.message, event.level);
        }
        break;

      default:
        break;
    }
  };

  return bus.subscribe(handle);
};
