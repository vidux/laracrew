import { run } from './cli/program.js';
import { color } from './cli/render/colors.js';
import { marks } from './cli/render/marks.js';
import { installPipeGuards } from './cli/render/output.js';

installPipeGuards();

run().catch((error: unknown) => {
  // Set exitCode rather than calling process.exit(), which truncates pending stdout writes.
  const [head, ...trace] = (error instanceof Error ? (error.stack ?? error.message) : String(error)).split('\n');
  console.error(`${marks().fail} ${color.red.bold(head ?? 'unexpected error')}`);
  if (trace.length > 0) console.error(color.gray(trace.join('\n')));
  process.exitCode = 1;
});
