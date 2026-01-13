# Ralph Gate

**Structured verification gates for Claude Code** - Prevent premature completion with ordered validation checks.

Ralph Gate is a minimal TypeScript plugin that provides verification gates for Claude Code, preventing false completion by running ordered verification commands before allowing the agent to stop.

## Features

- **Fail-Fast Execution**: Stops at first blocking failure to save time
- **Ordered Gates**: Run checks from cheapest to most expensive
- **Non-Blocking Gates**: Support for warning-only checks that don't stop execution
- **Hook Integration**: Seamlessly integrates with Claude Code's stop hook
- **Hook Progress Streaming**: Stream gate output to stderr so hooks don't look stuck
- **Full Programmatic API**: Use as a library in your own tools
- **Zero Runtime Dependencies**: Lightweight and fast
- **ESM-Only**: Modern Node.js (>=18)

## Installation

```bash
npm install -D ralph-gate
```

## Quick Start

1. Create a `gate.config.json` in your project root:

```json
{
  "gates": [
    { "name": "lint", "command": "npm run lint", "order": 10 },
    { "name": "typecheck", "command": "npm run typecheck", "order": 20 },
    { "name": "test", "command": "npm test", "order": 30 },
    { "name": "build", "command": "npm run build", "order": 40 }
  ]
}
```

2. Add to your `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "npx ralph-gate --hook"
      }
    ]
  }
}
```

3. Now when Claude Code tries to stop, your gates will run first!

## Configuration

### Gate Fields

| Field         | Type    | Default  | Description                             |
| ------------- | ------- | -------- | --------------------------------------- |
| `name`        | string  | required | Unique identifier for the gate          |
| `command`     | string  | required | Shell command to execute                |
| `description` | string  | -        | Human-readable description              |
| `order`       | number  | 100      | Execution order (lower = earlier)       |
| `enabled`     | boolean | true     | Whether to run this gate                |
| `blocking`    | boolean | true     | If false, failures warn but don't block |

### Config Fields

| Field        | Type    | Default                   | Description                       |
| ------------ | ------- | ------------------------- | --------------------------------- |
| `gates`      | Gate[]  | required                  | Array of gate definitions         |
| `failFast`   | boolean | true                      | Stop after first blocking failure |
| `outputPath` | string  | "gate-results-<pid>.json" | Path for result file              |

### Example Configuration

```json
{
  "gates": [
    {
      "name": "lint",
      "command": "npm run lint",
      "description": "Run ESLint",
      "order": 10
    },
    {
      "name": "typecheck",
      "command": "tsc --noEmit",
      "order": 20
    },
    {
      "name": "test",
      "command": "npm test",
      "order": 30
    },
    {
      "name": "audit",
      "command": "npm audit",
      "order": 50,
      "blocking": false
    }
  ],
  "failFast": true
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

## Programmatic API

Ralph Gate can be used as a library in your own tools:

```typescript
import { runGates, loadConfig, generateHookResponse } from 'ralph-gate';

// Load and run gates
const config = await loadConfig();
const summary = await runGates(config);

// Generate hook response
const hookResponse = generateHookResponse(summary);
console.log(hookResponse);
```

### Available Exports

```typescript
export { runGates } from './runner';
export { loadConfig } from './config';
export { generateHookResponse } from './hook';
export { formatConsoleOutput, formatFailureContext } from './output';
export type {
  Gate,
  GateResult,
  GateRunSummary,
  GateConfig,
  HookOutput,
} from './types';
```

## How It Works

1. **Stop Event**: Claude Code triggers the stop hook
2. **Gate Runner**: Executes gates in order (cheap → expensive)
3. **Fail-Fast**: Stops at first blocking failure
4. **Result File**: Writes `gate-results-<pid>.json`
5. **Hook Response**: Returns JSON to Claude Code
   - Pass: `{}` (allow completion)
   - Fail: `{"decision": "block", "reason": "<context>", "warnings": [...]}`

## Non-Blocking Gates

Gates with `blocking: false` will collect failures as warnings but won't prevent completion:

```json
{
  "gates": [
    {
      "name": "audit",
      "command": "npm audit",
      "blocking": false
    }
  ]
}
```

## Design Principles

- **Exit 0 in hook mode**: Control via JSON `decision` field
- **Fail-fast default**: Skip expensive gates if cheap ones fail
- **Truncated failure context**: Stdout + stderr with head/tail truncation (max 4000 chars)
- **Zero runtime dependencies**: Only dev deps for build/test
- **ESM-only**: Modern Node.js (>=18)
- **Trust exit codes**: Exit 0 = pass regardless of stderr

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © Uzair Akram
