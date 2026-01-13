import { spawn } from 'node:child_process';
import type { Gate, GateResult, GateRunSummary } from './types.js';

export interface RunGatesOptions {
  failFast?: boolean;
  verbose?: boolean;
  shell?: string;
  cwd?: string;
}

function resolveShell(shell?: string): string | boolean {
  if (typeof shell === 'string' && shell.length > 0) {
    return shell;
  }
  const envShell = process.env.SHELL;
  return envShell && envShell.length > 0 ? envShell : true;
}

async function runGate(gate: Gate, options: RunGatesOptions): Promise<GateResult> {
  const start = Date.now();
  const shell = resolveShell(options.shell);
  const env = process.env;

  return new Promise((resolve) => {
    const child = spawn(gate.command, {
      shell,
      env,
      cwd: options.cwd
    });

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let resolved = false;

    const finalize = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      const durationMs = Date.now() - start;
      resolve({
        name: gate.name,
        passed: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs,
        skipped: false,
        blocking: gate.blocking !== false
      });
    };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.verbose) {
        process.stdout.write(text);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.verbose) {
        process.stderr.write(text);
      }
    });

    child.on('error', (error) => {
      stderr += error.message;
      exitCode = null;
      finalize();
    });

    child.on('close', (code) => {
      exitCode = code;
      finalize();
    });
  });
}

export async function runGates(
  gates: Gate[],
  options: RunGatesOptions = {}
): Promise<GateRunSummary> {
  const results: GateResult[] = [];
  const warnings: string[] = [];
  const start = Date.now();
  let firstFailure: GateResult | null = null;

  for (const gate of gates) {
    const isBlocking = gate.blocking !== false;
    const shouldSkip =
      options.failFast !== false &&
      firstFailure !== null &&
      isBlocking;

    if (shouldSkip) {
      results.push({
        name: gate.name,
        passed: true,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        skipped: true,
        blocking: isBlocking
      });
      continue;
    }

    const result = await runGate(gate, options);
    results.push(result);

    if (!result.passed) {
      if (result.blocking) {
        if (!firstFailure) {
          firstFailure = result;
        }
      } else {
        warnings.push(result.name);
      }
    }
  }

  const totalDurationMs = Date.now() - start;
  const passed = firstFailure === null;

  return {
    passed,
    timestamp: new Date().toISOString(),
    totalDurationMs,
    results,
    firstFailure,
    warnings
  };
}
