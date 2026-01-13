import { promises as fs } from 'node:fs';
import type { GateResult, GateRunSummary } from './types.js';

const MAX_FAILURE_CHARS = 2000;

function colorize(text: string, code: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  return `\u001b[${code}m${text}\u001b[0m`;
}

function formatResultLine(result: GateResult, color: boolean): string {
  const statusSymbol = result.skipped
    ? '⊘'
    : result.passed
      ? '✓'
      : '✗';

  let symbolColor = '32';
  if (result.skipped) {
    symbolColor = '90';
  } else if (!result.passed) {
    symbolColor = '31';
  }

  const parts: string[] = [];
  if (result.skipped) {
    parts.push('skipped');
  } else if (!result.passed) {
    parts.push(`exit ${result.exitCode ?? 'null'}`);
  }
  parts.push(`${result.durationMs}ms`);

  const details = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const coloredSymbol = colorize(statusSymbol, symbolColor, color);
  return `${coloredSymbol} ${result.name}${details}`;
}

export function formatFailureContext(stderr: string): string {
  const trimmed = stderr.trimEnd();
  if (trimmed.length <= MAX_FAILURE_CHARS) {
    return trimmed;
  }
  return trimmed.slice(-MAX_FAILURE_CHARS);
}

export function formatConsoleOutput(summary: GateRunSummary): string {
  const color = Boolean(process.stdout.isTTY);
  const lines: string[] = [];

  for (const result of summary.results) {
    lines.push(formatResultLine(result, color));
  }

  if (summary.warnings.length > 0) {
    const warningLine = `Warnings: ${summary.warnings.join(', ')}`;
    lines.push(colorize(warningLine, '33', color));
  }

  const finalLine = summary.passed
    ? colorize('All blocking gates passed.', '32', color)
    : colorize('Blocking gate failed.', '31', color);
  lines.push(finalLine);

  return lines.join('\n');
}

export async function writeResultsFile(
  summary: GateRunSummary,
  outputPath: string
): Promise<void> {
  const data = JSON.stringify(summary, null, 2);
  await fs.writeFile(outputPath, data, 'utf8');
}
