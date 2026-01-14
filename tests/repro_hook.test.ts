import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { initConfigFile } from '../src/init.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-gate-repro-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('ralph-gate init hook fix', () => {
  it('fixes malformed Stop hooks and appends valid one', async () => {
    await withTempDir(async (dir) => {
      // Setup package.json so init runs
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'test-app', scripts: { test: 'echo "test"' } }),
      );

      // Setup broken settings.local.json
      const claudeDir = path.join(dir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });
      const brokenSettings = {
        hooks: {
          Stop: [
            { type: 'command', command: 'old-command' }, // Legacy/Broken (no hooks array)
            // We can also test the "matcher object" case if we want, but legacy is the main one causing "hooks: undefined"
          ],
        },
      };
      await fs.writeFile(
        path.join(claudeDir, 'settings.local.json'),
        JSON.stringify(brokenSettings),
      );

      // Run init
      const result = await initConfigFile({ cwd: dir });

      expect(result.created).toBe(true);
      expect(result.hookConfigured).toBe(true);

      // Read back
      const newSettingsRaw = await fs.readFile(
        path.join(claudeDir, 'settings.local.json'),
        'utf8',
      );
      const newSettings = JSON.parse(newSettingsRaw);

      // Verify Stop hooks
      const stopHooks = newSettings.hooks.Stop;
      expect(Array.isArray(stopHooks)).toBe(true);

      // The legacy hooks (both no-hooks-array, and object-matcher) should be gone
      expect(stopHooks.length).toBe(1);

      const hook = stopHooks[0];
      expect(hook.matcher).toBeUndefined(); // Should be undefined, not "*" or object
      expect(hook.hooks[0].command).toContain('ralph-gate');
    });
  });
});
