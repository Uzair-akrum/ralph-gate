import { promises as fs } from 'node:fs';
import type { GateResult, GateRunSummary } from './types.js';

const MAX_FAILURE_CHARS = 4000;
const HEAD_RATIO = 0.6;

function truncateOutput(text: string, maxChars: number): string {
  const trimmed = text.trimEnd();
  if (maxChars <= 0 || trimmed.length === 0) {
    return '';
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const headChars = Math.max(1, Math.floor(maxChars * HEAD_RATIO));
  const tailChars = Math.max(0, maxChars - headChars);
  const omitted = trimmed.length - maxChars;
  const marker = `\n...<${omitted} chars omitted>...\n`;
  const head = trimmed.slice(0, headChars);
  const tail = tailChars > 0 ? trimmed.slice(-tailChars) : '';
  return `${head}${marker}${tail}`;
}

function splitBudget(stdoutLen: number, stderrLen: number): {
  stdout: number;
  stderr: number;
} {
  if (stdoutLen === 0 && stderrLen === 0) {
    return { stdout: 0, stderr: 0 };
  }
  if (stdoutLen === 0) {
    return { stdout: 0, stderr: MAX_FAILURE_CHARS };
  }
  if (stderrLen === 0) {
    return { stdout: MAX_FAILURE_CHARS, stderr: 0 };
  }

  const base = Math.floor(MAX_FAILURE_CHARS / 2);
  let stdout = Math.min(stdoutLen, base);
  let stderr = Math.min(stderrLen, base);
  let remaining = MAX_FAILURE_CHARS - stdout - stderr;

  if (remaining > 0) {
    const stdoutRemaining = stdoutLen - stdout;
    const stderrRemaining = stderrLen - stderr;
    if (stdoutRemaining === 0) {
      stderr += remaining;
    } else if (stderrRemaining === 0) {
      stdout += remaining;
    } else {
      const totalRemaining = stdoutRemaining + stderrRemaining;
      const stdoutExtra = Math.round(
        (stdoutRemaining / totalRemaining) * remaining,
      );
      stdout += stdoutExtra;
      stderr += remaining - stdoutExtra;
    }
  }

  return { stdout, stderr };
}

function colorize(text: string, code: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  return `\u001b[${code}m${text}\u001b[0m`;
}

function formatResultLine(result: GateResult, color: boolean): string {
  const statusSymbol = result.skipped ? '⊘' : result.passed ? '✓' : '✗';

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

export function formatFailureContext(stderr: string, stdout = ''): string {
  const trimmedStderr = stderr.trimEnd();
  const trimmedStdout = stdout.trimEnd();

  if (trimmedStderr.length === 0 && trimmedStdout.length === 0) {
    return 'No output captured.';
  }

  if (trimmedStderr.length > 0 && trimmedStdout.length > 0) {
    const budget = splitBudget(trimmedStdout.length, trimmedStderr.length);
    const stderrSection = truncateOutput(trimmedStderr, budget.stderr);
    const stdoutSection = truncateOutput(trimmedStdout, budget.stdout);
    return `STDERR:\n${stderrSection}\n\nSTDOUT:\n${stdoutSection}`;
  }

  if (trimmedStderr.length > 0) {
    return truncateOutput(trimmedStderr, MAX_FAILURE_CHARS);
  }

  return truncateOutput(trimmedStdout, MAX_FAILURE_CHARS);
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
  outputPath: string,
): Promise<void> {
  const data = JSON.stringify(summary, null, 2);
  await fs.writeFile(outputPath, data, 'utf8');
}
