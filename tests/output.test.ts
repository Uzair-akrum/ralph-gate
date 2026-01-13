import { describe, expect, it } from 'vitest';
import { formatFailureContext } from '../src/output.js';

describe('formatFailureContext', () => {
  it('uses stdout when stderr is empty', () => {
    const output = formatFailureContext('', 'stdout message');
    expect(output).toContain('stdout message');
  });

  it('includes both stdout and stderr when present', () => {
    const output = formatFailureContext('stderr message', 'stdout message');
    expect(output).toContain('STDERR:');
    expect(output).toContain('STDOUT:');
  });

  it('adds head and tail context when output is long', () => {
    const longOutput = `${'A'.repeat(5000)}${'B'.repeat(5000)}`;
    const output = formatFailureContext(longOutput, '');
    expect(output).toContain('chars omitted');
    expect(output.startsWith('A')).toBe(true);
    expect(output.endsWith('B')).toBe(true);
  });

  it('returns a fallback message when no output is captured', () => {
    const output = formatFailureContext('', '');
    expect(output).toBe('No output captured.');
  });
});
