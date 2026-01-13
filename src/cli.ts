#!/usr/bin/env node
import type { Gate, GateRunSummary } from './types.js';
import { loadConfig } from './config.js';
import { runGates } from './runner.js';
import { formatConsoleOutput, writeResultsFile } from './output.js';
import { generateHookResponse, outputHookResponse } from './hook.js';

interface CliOptions {
  hook: boolean;
  dryRun: boolean;
  only?: string;
  verbose: boolean;
}

function parseArgs(args: string[]): { options: CliOptions; error?: string } {
  const options: CliOptions = {
    hook: false,
    dryRun: false,
    verbose: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--hook':
        options.hook = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--only': {
        const value = args[i + 1];
        if (!value) {
          return { options, error: 'Missing value for --only.' };
        }
        options.only = value;
        i += 1;
        break;
      }
      default:
        return { options, error: `Unknown argument: ${arg}` };
    }
  }

  return { options };
}

function defaultOutputPath(): string {
  return `gate-results-${process.pid}.json`;
}

function createEmptySummary(passed: boolean): GateRunSummary {
  return {
    passed,
    timestamp: new Date().toISOString(),
    totalDurationMs: 0,
    results: [],
    firstFailure: null,
    warnings: []
  };
}

function formatDryRun(gates: Gate[], shell: string): string {
  const lines = [`SHELL: ${shell}`];
  if (gates.length === 0) {
    lines.push('No gates to run.');
    return lines.join('\n');
  }
  for (const gate of gates) {
    const order = typeof gate.order === 'number' ? gate.order : 100;
    lines.push(`- ${gate.name} (order ${order}): ${gate.command}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { options, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }

  const configResult = await loadConfig();
  if (configResult.error) {
    const summary = createEmptySummary(false);
    const outputPath = defaultOutputPath();
    await writeResultsFile(summary, outputPath);

    if (options.hook) {
      outputHookResponse({ decision: 'block', reason: configResult.error });
      process.exitCode = 0;
      return;
    }

    console.error(configResult.error);
    process.exitCode = 1;
    return;
  }

  if (!configResult.config) {
    if (options.dryRun) {
      const shellLabel = process.env.SHELL ?? '(default)';
      console.log(formatDryRun([], shellLabel));
    }
    if (options.hook) {
      outputHookResponse({});
      process.exitCode = 0;
    }
    return;
  }

  const config = configResult.config;
  const shellLabel = process.env.SHELL ?? '(default)';

  if (options.dryRun) {
    console.log(formatDryRun(config.gates, shellLabel));
    return;
  }

  let gates = config.gates;
  if (options.only) {
    const match = gates.find((gate) => gate.name === options.only);
    if (!match) {
      console.error(`Gate not found: ${options.only}`);
      process.exitCode = 1;
      return;
    }
    gates = [match];
  }

  const outputPath = config.outputPath ?? defaultOutputPath();

  if (gates.length === 0) {
    const summary = createEmptySummary(true);
    await writeResultsFile(summary, outputPath);
    if (options.hook) {
      outputHookResponse({});
      process.exitCode = 0;
      return;
    }
    console.log(formatConsoleOutput(summary));
    return;
  }

  const summary = await runGates(gates, {
    failFast: config.failFast,
    verbose: options.verbose
  });

  await writeResultsFile(summary, outputPath);

  if (options.hook) {
    outputHookResponse(generateHookResponse(summary));
    process.exitCode = 0;
    return;
  }

  console.log(formatConsoleOutput(summary));
  if (!summary.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
