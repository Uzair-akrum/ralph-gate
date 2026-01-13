# Ralph Gate v1 - Implementation Spec

A minimal TypeScript plugin that provides structured verification gates for Claude Code, preventing premature completion ("false finish") by running ordered verification commands before allowing the agent to stop.

## Architecture

```
Claude Code Agent
       │ (Stop event)
       ▼
  Stop Hook → npx ralph-gate --hook
       │
       ▼
  Gate Runner (fail-fast, ordered cheap→expensive)
       │
       ▼
  gate-results-<pid>.json + JSON response to Claude
       │
  Pass: {} (allow completion)
  Fail: {"decision": "block", "reason": "<failure context>", "warnings": [...]}
```

## Project Structure

```
ralph-gate/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── .gitignore
├── src/
│   ├── index.ts          # Main exports (full programmatic API)
│   ├── cli.ts            # CLI entry point
│   ├── types.ts          # Core type definitions
│   ├── config.ts         # Config loading/validation
│   ├── runner.ts         # Gate execution engine
│   ├── output.ts         # Result formatting
│   └── hook.ts           # Claude Code hook response
└── tests/
    └── runner.test.ts
```

## Implementation Steps

### Step 1: Project Setup
- Initialize package.json with name "ralph-gate", type "module"
- Configure tsconfig.json for ESM output (NodeNext module)
- Set engines.node to ">=18" (Node 18 LTS minimum)
- Add tsup.config.ts for building
- Create .gitignore

### Step 2: Core Types (`src/types.ts`)
Define interfaces:

```typescript
interface Gate {
  name: string;
  command: string;
  description?: string;
  order?: number;      // Default: 100
  enabled?: boolean;   // Default: true
  blocking?: boolean;  // Default: true (false = warn-only, non-blocking)
}

interface GateResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped: boolean;
  blocking: boolean;
}

interface GateRunSummary {
  passed: boolean;
  timestamp: string;
  totalDurationMs: number;
  results: GateResult[];
  firstFailure: GateResult | null;
  warnings: string[];  // Names of non-blocking gates that failed
}

interface GateConfig {
  gates: Gate[];
  outputPath?: string;  // Default: "gate-results-<pid>.json"
  failFast?: boolean;   // Default: true
}

interface HookOutput {
  decision?: "block";
  reason?: string;
  warnings?: string[];  // Names of non-blocking gates that failed
}
```

### Step 3: Config Loading (`src/config.ts`)
- Search order: `gate.config.json`, `.gaterc.json`, `.gaterc`
- **No config found**: Pass silently (return success, allow completion)
- **Invalid config (malformed JSON, missing required fields)**: Block with error as reason
- Validate: gates must have `name` + `command`
- Apply defaults:
  - `order`: 100
  - `enabled`: true
  - `blocking`: true
  - `failFast`: true
- Sort gates by order (cheap→expensive), preserve insertion order for ties
- Filter out disabled gates (`enabled: false`)
- **Empty gates array or all disabled**: Pass (nothing to check)

### Step 4: Gate Runner (`src/runner.ts`)
- Execute gates sequentially using `child_process.spawn` with `shell: true`
- Use user's `$SHELL` environment variable for shell execution
- Inherit full parent environment (no extra env vars, no clean env)
- Inherit current working directory from hook trigger location
- Implement fail-fast: skip remaining blocking gates after first blocking failure
- Non-blocking gates (`blocking: false`): Continue even if they fail, collect as warnings
- Capture stderr only for failure context (stdout not needed)
- Trust exit code: exit 0 = pass, non-zero = fail (stderr with exit 0 is still pass)
- Command not found treated as normal failure (non-zero exit)
- No timeouts: trust user's commands to exit
- Return GateRunSummary

### Step 5: Output Formatting (`src/output.ts`)
- `writeResultsFile()`: Write to `gate-results-<pid>.json` (PID-suffixed for concurrency)
- `formatConsoleOutput()`: Human-readable summary with colors + Unicode symbols
  - Pass: `✓` (green)
  - Fail: `✗` (red)
  - Skip: `⊘` (yellow/gray)
  - Auto-detect TTY for color support
- `formatFailureContext()`: Truncated stderr for Claude feedback
  - Tail truncation: last 2000 characters
  - Stderr only (not stdout)

### Step 6: Hook Integration (`src/hook.ts`)
- `generateHookResponse()`:
  - All blocking gates pass: `{}`
  - Blocking gate fails: `{ decision: "block", reason: "<structured prose>" }`
  - Non-blocking failures: add `warnings: ["gateName1", "gateName2"]`
- Reason format (structured prose):
  ```
  Gate 'typecheck' failed (exit 1):
  <last 2000 chars of stderr>
  ```
- First blocking failure only (not all failures)
- `outputHookResponse()`: JSON to stdout for Claude Code
- Write result file BEFORE outputting to stdout

### Step 7: CLI (`src/cli.ts`)
Parse flags:
- `--hook`: Hook mode (output JSON, always exit 0)
- `--dry-run`: Show which gates would run without executing
  - Display ordered gate list with names, commands, order values
  - Show resolved `$SHELL` that would be used
- `--only <name>`: Run a single specific gate by name
- `--verbose`: Stream real-time output from gates to console

Execution flow:
1. Load config
2. If `--dry-run`: display gate list and exit
3. Sort and filter gates
4. If `--only`: filter to just that gate
5. Run gates
6. Write results file (gate-results-<pid>.json)
7. If `--hook`: output JSON response to stdout, exit 0
8. Else: output console summary with colors/symbols

### Step 8: Main Exports (`src/index.ts`)
Full programmatic API for library usage:
```typescript
export { runGates } from './runner';
export { loadConfig } from './config';
export { generateHookResponse } from './hook';
export { formatConsoleOutput, formatFailureContext } from './output';
export type { Gate, GateResult, GateRunSummary, GateConfig, HookOutput } from './types';
```

## Config Format (`gate.config.json`)

```json
{
  "gates": [
    { "name": "lint", "command": "npm run lint", "order": 10 },
    { "name": "typecheck", "command": "npm run typecheck", "order": 20 },
    { "name": "test", "command": "npm test", "order": 30 },
    { "name": "build", "command": "npm run build", "order": 40 },
    { "name": "audit", "command": "npm audit", "order": 50, "blocking": false }
  ],
  "failFast": true,
  "outputPath": "gate-results.json"
}
```

### Gate Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Unique identifier for the gate |
| `command` | string | required | Shell command to execute |
| `description` | string | - | Human-readable description |
| `order` | number | 100 | Execution order (lower = earlier, cheap→expensive) |
| `enabled` | boolean | true | Whether to run this gate |
| `blocking` | boolean | true | If false, failures warn but don't block completion |

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `gates` | Gate[] | required | Array of gate definitions |
| `failFast` | boolean | true | Stop after first blocking failure |
| `outputPath` | string | "gate-results-<pid>.json" | Path for result file |

## Claude Code Integration

Add to `.claude/settings.local.json`:
```json
{
  "hooks": {
    "Stop": [{
      "type": "command",
      "command": "npx ralph-gate --hook"
    }]
  }
}
```

## CLI Reference

```bash
# Run all gates with console output
npx ralph-gate

# Run in hook mode (JSON output, always exits 0)
npx ralph-gate --hook

# Preview which gates would run
npx ralph-gate --dry-run

# Run a single gate
npx ralph-gate --only typecheck

# Verbose mode with real-time output
npx ralph-gate --verbose
```

## Key Design Decisions

1. **Exit 0 in hook mode** - Control via JSON `decision` field, not exit code
2. **Fail-fast default** - Skip expensive gates if cheap blocking ones fail
3. **Truncated failure context** - Last 2000 chars of stderr to avoid context overflow
4. **Zero runtime dependencies** - Only dev deps for build/test
5. **ESM-only** - Modern Node.js (>=18)
6. **No timeouts** - Trust user's commands to exit; their responsibility
7. **PID-suffixed result files** - Avoid race conditions with concurrent sessions
8. **Stderr only for failures** - Errors are in stderr; stdout is noise
9. **User's $SHELL** - Respect shell config and aliases
10. **Trust exit codes** - Exit 0 = pass regardless of stderr output
11. **Silent on missing config** - No gates means nothing to check = pass
12. **Block on invalid config** - Fail safe; likely misconfiguration
13. **Non-blocking gates** - `blocking: false` for warn-only checks
14. **Warnings in response** - Non-blocking failures listed by name
15. **First failure only** - Keep Claude focused on one issue at a time
16. **File before stdout** - Ensure persistence before hook response
17. **Full programmatic API** - Export functions for library use

## Verification

1. Build: `npm run build` should produce `dist/cli.js` and `dist/index.js`
2. Dry-run: `npx ralph-gate --dry-run` should list gates and shell
3. Manual test: Create `gate.config.json`, run `npx ralph-gate` - should execute gates
4. Hook test: Run `npx ralph-gate --hook` - should output JSON
5. Single gate: `npx ralph-gate --only lint` - should run only lint
6. Non-blocking: Configure a gate with `blocking: false`, make it fail, verify it warns but passes
7. Integration test: Configure Claude Code hook, trigger Stop event, verify gates run

## Out of Scope (v1)

- Budget tracking (time/cost limits)
- MCP server integration
- Parallel gate execution
- Gate dependencies (DAG)
- Per-gate timeouts
- Per-gate working directory
- Per-gate environment variables
- Environment variable expressions for `enabled` field
- Automatic result file cleanup
