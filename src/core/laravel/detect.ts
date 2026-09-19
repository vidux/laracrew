import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readProjectEnv } from './env.js';

export interface DetectedProject {
  path: string;
  name: string;
  isLaravel: boolean;
  packages: string[];
  features: {
    horizon: boolean;
    octane: boolean;
    reverb: boolean;
    pulse: boolean;
    telescope: boolean;
    vite: boolean;
  };
  env: Record<string, string>;
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

export const isLaravelProject = (dir: string): boolean =>
  existsSync(path.join(dir, 'artisan')) && existsSync(path.join(dir, 'composer.json'));

export const detectProject = (dir: string): DetectedProject => {
  const root = path.resolve(dir);
  const composer = readJson(path.join(root, 'composer.json')) ?? {};
  const require = (composer.require ?? {}) as Record<string, string>;
  const requireDev = (composer['require-dev'] ?? {}) as Record<string, string>;
  const packages = [...Object.keys(require), ...Object.keys(requireDev)];
  const packageJson = readJson(path.join(root, 'package.json'));

  const has = (name: string): boolean => packages.includes(name);

  return {
    path: root,
    name: path.basename(root),
    isLaravel: isLaravelProject(root),
    packages,
    features: {
      horizon: has('laravel/horizon'),
      octane: has('laravel/octane'),
      reverb: has('laravel/reverb'),
      pulse: has('laravel/pulse'),
      telescope: has('laravel/telescope'),
      vite: Boolean(packageJson) && existsSync(path.join(root, 'vite.config.js'))
        ? true
        : existsSync(path.join(root, 'vite.config.ts')),
    },
    env: readProjectEnv(root),
  };
};

/** Finds Laravel projects one or two levels below `dir` — deeper scanning is rarely wanted. */
export const scanForProjects = (dir: string, depth = 2): DetectedProject[] => {
  const found: DetectedProject[] = [];

  const walk = (current: string, remaining: number): void => {
    if (isLaravelProject(current)) {
      found.push(detectProject(current));
      return; // Don't descend into a project's vendor/ or node_modules/.
    }
    if (remaining <= 0) return;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue;
      walk(path.join(current, entry.name), remaining - 1);
    }
  };

  walk(path.resolve(dir), depth);
  return found.sort((a, b) => a.name.localeCompare(b.name));
};

/** The worker/listener commands that make sense for a detected project. */
export const suggestServices = (project: DetectedProject): { name: string; cmd: string; groups: string[] }[] => {
  const key = project.name;
  const suggestions: { name: string; cmd: string; groups: string[] }[] = [
    { name: `${key}:serve`, cmd: 'php artisan serve', groups: ['http'] },
  ];

  if (project.features.horizon) {
    suggestions.push({ name: `${key}:horizon`, cmd: 'php artisan horizon', groups: ['workers'] });
  } else if ((project.env.QUEUE_CONNECTION ?? 'sync') !== 'sync') {
    suggestions.push({ name: `${key}:queue`, cmd: 'php artisan queue:work', groups: ['workers'] });
  }

  suggestions.push({ name: `${key}:schedule`, cmd: 'php artisan schedule:work', groups: ['workers'] });

  if (project.features.reverb) {
    suggestions.push({ name: `${key}:reverb`, cmd: 'php artisan reverb:start', groups: ['http'] });
  }
  if (project.features.vite) {
    suggestions.push({ name: `${key}:vite`, cmd: 'npm run dev', groups: ['assets'] });
  }

  return suggestions;
};
