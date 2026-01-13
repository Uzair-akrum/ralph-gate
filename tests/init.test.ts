import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG_FILENAME,
  generateGateConfig,
  initConfigFile,
} from '../src/init.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-gate-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('ralph-gate init', () => {
  it('generates gates from package.json scripts (npm)', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify(
          {
            name: 'example',
            scripts: {
              lint: 'eslint .',
              typecheck: 'tsc --noEmit',
              test: 'vitest run',
              build: 'tsup',
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');

      const { config, projectKind } = await generateGateConfig(dir);

      expect(projectKind).toBe('node');
      expect(config.gates.map((gate) => gate.name)).toEqual([
        'lint',
        'typecheck',
        'test',
        'build',
      ]);
      expect(config.gates.map((gate) => gate.command)).toEqual([
        'npm run lint',
        'npm run typecheck',
        'npm run test',
        'npm run build',
      ]);
    });
  });

  it("adds a default tsc typecheck when typescript exists but no 'typecheck' script", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify(
          {
            name: 'example',
            devDependencies: {
              typescript: '^5.0.0',
            },
            scripts: {
              lint: 'eslint .',
              test: 'vitest run',
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(path.join(dir, 'tsconfig.json'), '{}');

      const { config, warnings } = await generateGateConfig(dir);

      expect(warnings.join('\n')).toContain("No 'typecheck' script found");
      const typecheck = config.gates.find((gate) => gate.name === 'typecheck');
      expect(typecheck?.command).toBe('npx tsc -p tsconfig.json --noEmit');
    });
  });

  it('writes gate.config.json by default and refuses to overwrite without --force', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify(
          {
            name: 'example',
            scripts: {
              test: 'vitest run',
            },
          },
          null,
          2,
        ),
      );

      const first = await initConfigFile({ cwd: dir });
      expect(first.created).toBe(true);
      expect(first.error).toBeUndefined();

      const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { gates: Array<{ name: string }> };
      expect(parsed.gates.map((gate) => gate.name)).toEqual(['test']);

      const second = await initConfigFile({ cwd: dir });
      expect(second.created).toBe(false);
      expect(second.error).toContain('already exists');

      const forced = await initConfigFile({ cwd: dir, force: true });
      expect(forced.created).toBe(true);
      expect(forced.error).toBeUndefined();
    });
  });

  it('supports --print mode without writing', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'example', scripts: { test: 'vitest run' } }),
      );

      const result = await initConfigFile({ cwd: dir, print: true });
      expect(result.created).toBe(false);
      expect(result.config.gates.map((gate) => gate.name)).toEqual(['test']);
      expect(
        await fs.access(path.join(dir, DEFAULT_CONFIG_FILENAME)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    });
  });

  it('creates .gitignore with gate-results pattern when it does not exist', async () => {
    await withTempDir(async (dir) => {
      // Initialize git repo for git check-ignore to work
      execSync('git init', { cwd: dir, stdio: 'ignore' });

      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'example', scripts: { test: 'vitest run' } }),
      );

      const result = await initConfigFile({ cwd: dir });
      expect(result.created).toBe(true);
      expect(result.gitignoreUpdated).toBe(true);

      const gitignoreContent = await fs.readFile(
        path.join(dir, '.gitignore'),
        'utf8',
      );
      expect(gitignoreContent).toContain('gate-results-*.json');
    });
  });

  it('appends gate-results pattern to existing .gitignore', async () => {
    await withTempDir(async (dir) => {
      execSync('git init', { cwd: dir, stdio: 'ignore' });

      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'example', scripts: { test: 'vitest run' } }),
      );

      await fs.writeFile(
        path.join(dir, '.gitignore'),
        'node_modules/\ndist/\n',
      );

      const result = await initConfigFile({ cwd: dir });
      expect(result.created).toBe(true);
      expect(result.gitignoreUpdated).toBe(true);

      const gitignoreContent = await fs.readFile(
        path.join(dir, '.gitignore'),
        'utf8',
      );
      expect(gitignoreContent).toContain('node_modules/');
      expect(gitignoreContent).toContain('dist/');
      expect(gitignoreContent).toContain('gate-results-*.json');
    });
  });

  it('does not duplicate gate-results pattern if already present', async () => {
    await withTempDir(async (dir) => {
      execSync('git init', { cwd: dir, stdio: 'ignore' });

      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'example', scripts: { test: 'vitest run' } }),
      );

      await fs.writeFile(
        path.join(dir, '.gitignore'),
        'node_modules/\ngate-results-*.json\n',
      );

      const result = await initConfigFile({ cwd: dir });
      expect(result.created).toBe(true);
      expect(result.gitignoreUpdated).toBe(false);

      const gitignoreContent = await fs.readFile(
        path.join(dir, '.gitignore'),
        'utf8',
      );
      const matches = gitignoreContent.match(/gate-results-\*\.json/g);
      expect(matches).toHaveLength(1);
    });
  });

  it('does not add pattern if broader pattern already covers it', async () => {
    await withTempDir(async (dir) => {
      execSync('git init', { cwd: dir, stdio: 'ignore' });

      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'example', scripts: { test: 'vitest run' } }),
      );

      // *.json would already ignore gate-results-*.json
      await fs.writeFile(path.join(dir, '.gitignore'), '*.json\n');

      const result = await initConfigFile({ cwd: dir });
      expect(result.created).toBe(true);
      expect(result.gitignoreUpdated).toBe(false);

      const gitignoreContent = await fs.readFile(
        path.join(dir, '.gitignore'),
        'utf8',
      );
      expect(gitignoreContent).not.toContain('gate-results-*.json');
      expect(gitignoreContent).toContain('*.json');
    });
  });
});
