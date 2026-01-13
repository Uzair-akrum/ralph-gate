import { describe, expect, it } from 'vitest';
import { runGates } from '../src/runner.js';
import type { Gate } from '../src/types.js';

const node = process.execPath;

function cmd(code: string): string {
  return `${node} -e "${code}"`;
}

describe('runGates', () => {
  it('records blocking failures and skips later blocking gates', async () => {
    const gates: Gate[] = [
      { name: 'pass', command: cmd('process.exit(0)') },
      { name: 'fail', command: cmd('process.exit(1)') },
      { name: 'skipped', command: cmd('process.exit(0)') }
    ];

    const summary = await runGates(gates, { failFast: true });

    expect(summary.passed).toBe(false);
    expect(summary.firstFailure?.name).toBe('fail');
    const skipped = summary.results.find((result) => result.name === 'skipped');
    expect(skipped?.skipped).toBe(true);
  });

  it('continues running non-blocking gates after failure', async () => {
    const gates: Gate[] = [
      { name: 'fail', command: cmd('process.exit(1)') },
      { name: 'warn', command: cmd('process.exit(2)'), blocking: false }
    ];

    const summary = await runGates(gates, { failFast: true });

    const warnResult = summary.results.find((result) => result.name === 'warn');
    expect(warnResult?.skipped).toBe(false);
    expect(summary.warnings).toEqual(['warn']);
  });

  it('captures stderr for failures', async () => {
    const gates: Gate[] = [
      { name: 'fail', command: cmd("console.error('boom'); process.exit(1)") }
    ];

    const summary = await runGates(gates, { failFast: true });

    expect(summary.firstFailure?.stderr).toContain('boom');
  });
});
