import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A .env reader with no side effects — it never touches process.env, because laracrew
 * reads several projects' files in one run and they routinely disagree.
 */
export const parseEnv = (content: string): Record<string, string> => {
  const out: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      // Only double quotes carry escapes, matching Laravel/phpdotenv behaviour.
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
};

/** Reads `<projectPath>/<envFile>`; a missing file is not an error, just an empty environment. */
export const readProjectEnv = (projectPath: string, envFile = '.env'): Record<string, string> => {
  try {
    return parseEnv(readFileSync(path.join(projectPath, envFile), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
};
