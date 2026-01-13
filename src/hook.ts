import type { GateRunSummary, HookOutput } from './types.js';
import { formatFailureContext } from './output.js';

export function generateHookResponse(summary: GateRunSummary): HookOutput {
  const warnings = summary.warnings.length > 0 ? summary.warnings : undefined;

  if (summary.passed) {
    return warnings ? { warnings } : {};
  }

  const failure = summary.firstFailure;
  if (failure) {
    const reason = `Gate '${failure.name}' failed (exit ${failure.exitCode ?? 'null'}):\n${formatFailureContext(failure.stderr)}`;
    return warnings ? { decision: 'block', reason, warnings } : { decision: 'block', reason };
  }

  const reason = 'Gate run failed without a blocking gate result.';
  return warnings ? { decision: 'block', reason, warnings } : { decision: 'block', reason };
}

export function outputHookResponse(output: HookOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
