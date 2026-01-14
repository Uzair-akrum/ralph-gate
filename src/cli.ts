#!/usr/bin/env node
import path from 'node:path';
import type { Gate, GateRunSummary } from './types.js';
import { loadConfig } from './config.js';
import { initConfigFile } from './init.js';
import { runGates, type RunGatesOptions } from './runner.js';
import { formatConsoleOutput, writeResultsFile } from './output.js';
import { generateHookResponse, outputHookResponse } from './hook.js';

interface CliOptions {
  hook: boolean;
  dryRun: boolean;
  only?: string;
  verbose: boolean;
}

interface InitCliOptions {
  force: boolean;
  print: boolean;
  skipHook: boolean;
}

function parseArgs(args: string[]): { options: CliOptions; error?: string } {
  const options: CliOptions = {
    hook: false,
    dryRun: false,
    verbose: false,
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

function parseInitArgs(args: string[]): {
  options: InitCliOptions;
  error?: string;
} {
  const options: InitCliOptions = {
    force: false,
    print: false,
    skipHook: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--force':
        options.force = true;
        break;
      case '--print':
        options.print = true;
        break;
      case '--skip-hook':
        options.skipHook = true;
        break;
      default:
        return { options, error: `Unknown argument: ${arg}` };
    }
  }

  return { options };
}

function defaultOutputPath(): string {
  return path.join('gate-results', `gate-results-${process.pid}.json`);
}

function createEmptySummary(passed: boolean): GateRunSummary {
  return {
    passed,
    timestamp: new Date().toISOString(),
    totalDurationMs: 0,
    results: [],
    firstFailure: null,
    warnings: [],
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

function createHookProgressReporter(
  enabled: boolean,
): Partial<RunGatesOptions> {
  if (!enabled) {
    return {};
  }

  const prefix = '[ralph-gate]';
  const writeLine = (line: string) => {
    process.stderr.write(`${prefix} ${line}\n`);
  };

  return {
    onGateStart: (gate) => {
      writeLine(`running ${gate.name}: ${gate.command}`);
    },
    onGateOutput: (_gate, _stream, text) => {
      process.stderr.write(text);
    },
    onGateComplete: (result) => {
      if (result.skipped) {
        writeLine(`${result.name} skipped`);
        return;
      }
      const status = result.passed
        ? `passed in ${result.durationMs}ms`
        : `failed (exit ${result.exitCode ?? 'null'}) in ${result.durationMs}ms`;
      writeLine(`${result.name} ${status}`);
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'init') {
    const { options, error } = parseInitArgs(argv.slice(1));
    if (error) {
      console.error(error);
      process.exitCode = 1;
      return;
    }

    const result = await initConfigFile({
      force: options.force,
      print: options.print,
      skipHook: options.skipHook,
    });
    if (result.error) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }

    for (const warning of result.warnings) {
      console.error(`Warning: ${warning}`);
    }

    if (options.print) {
      console.log(JSON.stringify(result.config, null, 2));
      return;
    }

    console.log(
      `Created ${path.basename(result.configPath)} with ${result.config.gates.length} gate(s).`,
    );
    if (result.gitignoreUpdated) {
      console.log('Updated .gitignore to exclude gate-results/ folder.');
    }
    if (result.hookConfigured) {
      console.log(
        'Added Stop hook to .claude/settings.local.json for automatic gate runs.',
      );
    } else if (result.hookAlreadyExists) {
      console.log('Stop hook already exists in .claude/settings.local.json.');
    }
    return;
  }

  const { options, error } = parseArgs(argv);
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

  const hookProgress = createHookProgressReporter(options.hook);
  const summary = await runGates(gates, {
    failFast: config.failFast,
    verbose: options.verbose && !options.hook,
    ...hookProgress,
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
