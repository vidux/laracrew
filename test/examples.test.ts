import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { stackSchema } from '../src/core/config/schema.js';
import { formatZodIssues, ALL_KNOWN_KEYS } from '../src/core/config/errors.js';

/**
 * The examples ship in the npm tarball, so a broken one is a broken release. These load
 * every example through the real schema. Paths are not resolved — an example points at
 * directories that only exist on the author's machine — so this validates shape, not disk.
 */

const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');

const exampleNames = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const load = (name: string): unknown =>
  YAML.parse(readFileSync(path.join(EXAMPLES_DIR, name, 'stack.yaml'), 'utf8'));

describe('examples', () => {
  test('there are several, and they are not all Laravel', () => {
    expect(exampleNames.length).toBeGreaterThanOrEqual(5);

    const laravelish = exampleNames.filter((name) => name.includes('laravel'));
    expect(laravelish.length).toBeLessThan(exampleNames.length);
  });

  test.each(exampleNames)('%s validates against the schema', (name) => {
    const result = stackSchema.safeParse(load(name));

    if (!result.success) {
      throw new Error(
        `examples/${name}/stack.yaml does not validate:\n  ${formatZodIssues(result.error, ALL_KNOWN_KEYS).join('\n  ')}`,
      );
    }
    expect(result.success).toBe(true);
  });

  test.each(exampleNames)('%s is named after its folder', (name) => {
    const parsed = stackSchema.parse(load(name));
    // loadStack refuses a mismatch, so a copied example must work unedited.
    expect(parsed.name).toBe(name);
  });

  test.each(exampleNames)('%s opens with a comment explaining what it demonstrates', (name) => {
    const source = readFileSync(path.join(EXAMPLES_DIR, name, 'stack.yaml'), 'utf8');
    expect(source.startsWith('#')).toBe(true);
    expect(source).toMatch(/Demonstrates:/);
    expect(source).toMatch(/cp -r .* ~\/\.laracrew\/stacks\//);
  });

  test.each(exampleNames)('%s declares a global command name', (name) => {
    expect(stackSchema.parse(load(name)).command).toBeTruthy();
  });

  test('every example has a self-contained project definition', () => {
    for (const name of exampleNames) {
      const parsed = stackSchema.parse(load(name));
      // `use:` would point at a projects.yaml the reader does not have.
      expect(parsed.use).toEqual([]);
      expect(Object.keys(parsed.projects).length).toBeGreaterThan(0);
    }
  });

  test('every service referencing a project uses one the example declares', () => {
    for (const name of exampleNames) {
      const parsed = stackSchema.parse(load(name));
      const known = new Set(Object.keys(parsed.projects));
      for (const service of parsed.services) {
        if (service.project) expect(known).toContain(service.project);
      }
    }
  });

  test('every `needs` names a service that exists in the same stack', () => {
    for (const name of exampleNames) {
      const parsed = stackSchema.parse(load(name));
      const names = new Set(parsed.services.map((service) => service.name));
      for (const service of parsed.services) {
        for (const need of service.needs) {
          expect(names, `${name}: ${service.name} needs ${need}`).toContain(need);
        }
      }
    }
  });

  test('no auto-started service depends on one the user has to start by hand', () => {
    for (const name of exampleNames) {
      const parsed = stackSchema.parse(load(name));
      const manual = new Set(
        parsed.services.filter((service) => !service.autostart && !service.external).map((s) => s.name),
      );
      for (const service of parsed.services) {
        if (!service.autostart) continue;
        for (const need of service.needs) {
          expect(manual, `${name}: ${service.name} needs manual ${need}`).not.toContain(need);
        }
      }
    }
  });

  test('every profile selector matches a real service or group', () => {
    for (const name of exampleNames) {
      const parsed = stackSchema.parse(load(name));
      const targets = new Set<string>();
      for (const service of parsed.services) {
        targets.add(service.name);
        for (const group of service.groups) targets.add(group);
      }
      for (const [profile, config] of Object.entries(parsed.profiles)) {
        for (const selector of [...config.only, ...config.except]) {
          expect(targets, `${name}: profile "${profile}" selects "${selector}"`).toContain(selector);
        }
      }
    }
  });

  test('the folder has a README pointing at each example', () => {
    const readme = path.join(EXAMPLES_DIR, 'README.md');
    expect(existsSync(readme)).toBe(true);

    const contents = readFileSync(readme, 'utf8');
    for (const name of exampleNames) expect(contents).toContain(name);
  });
});
