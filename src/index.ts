import { run } from './cli/program.js';
import { paint } from './cli/render/colors.js';
import { installPipeGuards } from './cli/render/output.js';

installPipeGuards();

run().catch((error: unknown) => {
  // Set exitCode rather than calling process.exit(), which truncates pending stdout writes.
  console.error(paint('red', error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exitCode = 1;
});
