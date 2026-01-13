export interface Gate {
  name: string;
  command: string;
  description?: string;
  order?: number;
  enabled?: boolean;
  blocking?: boolean;
}

export interface GateResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped: boolean;
  blocking: boolean;
  timestamp: string;
}

export interface GateRunSummary {
  passed: boolean;
  timestamp: string;
  totalDurationMs: number;
  results: GateResult[];
  firstFailure: GateResult | null;
  warnings: string[];
}

export interface GateConfig {
  gates: Gate[];
  outputPath?: string;
  failFast?: boolean;
}

export interface HookOutput {
  decision?: 'block';
  reason?: string;
  warnings?: string[];
}
