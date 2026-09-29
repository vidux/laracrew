import type { EventBus } from '../../core/events/bus.js';
import type { LaracrewEvent } from '../../core/events/types.js';
import type { ResolvedStack } from '../../core/config/resolve.js';
import { glyphs, type Glyphs } from '../../tui/theme.js';
import { asColorName, padEnd, paint as defaultPaint, type Painter } from './colors.js';
import { write as safeWrite } from './output.js';

export interface PlainRendererOptions {
  stack: ResolvedStack;
  write?: (text: string) => void;
  painter?: Painter;
  glyph?: Glyphs;
  timestamps?: boolean;
  now?: () => Date;
}

type Tone = 'info' | 'ok' | 'warn' | 'error';

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
  const glyph = options.glyph ?? glyphs();
  const showTime = options.timestamps ?? true;
  const now = options.now ?? (() => new Date());

  const colorOf = new Map(options.stack.services.map((service) => [service.name, asColorName(service.color)]));
  const width = Math.max(8, ...options.stack.services.map((service) => service.name.length), 'laracrew'.length);

  const line = (service: string, text: string, colorName = colorOf.get(service) ?? 'cyan') => {
    const stamp = showTime ? painter('gray', `${time(now())} `) : '';
    const prefix = painter(colorName, padEnd(service, width));
    write(`${stamp}${prefix} ${painter('gray', '|')} ${text}\n`);
  };

  // Lifecycle notes carry a mark and a colour so they stand apart from the log lines around them.
  const note = (tone: Tone, text: string): string => {
    switch (tone) {
      case 'ok':
        return `${painter('green', glyph.tick)} ${painter('green', text)}`;
      case 'warn':
        return `${painter('yellow', glyph.warn)} ${painter('yellow', text)}`;
      case 'error':
        return `${painter('red', glyph.failed)} ${painter('red', text)}`;
      default:
        return painter('gray', text);
    }
  };

  const system = (text: string, tone: Tone = 'info') => line('laracrew', note(tone, text), 'bold');

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
        system(`${event.stack} ready in ${(event.durationMs / 1000).toFixed(1)}s`, 'ok');
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
        line(event.service, note('ok', `ready (${event.probe}) in ${event.durationMs}ms`));
        break;

      case 'service:exit':
        if (!event.intentional) {
          // A clean exit is worth a look; a crash is a failure.
          const clean = event.code === 0 && !event.signal;
          const why = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
          line(event.service, note(clean ? 'warn' : 'error', `exited (${why})`));
        }
        break;

      case 'service:restart':
        line(
          event.service,
          `${painter('yellow', glyph.restart)} ${painter(
            'yellow',
            `restarting in ${event.delayMs}ms (attempt ${event.attempt}/${event.maxAttempts})`,
          )}`,
        );
        break;

      case 'service:state':
        if (event.to === 'failed') {
          line(event.service, note('error', `failed${event.detail ? `: ${event.detail}` : ''}`));
        }
        break;

      case 'notice':
        if (event.service) {
          line(event.service, note(event.level, event.message));
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
