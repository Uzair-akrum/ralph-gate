import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import type { Gate, GateConfig } from './types.js';

export const DEFAULT_CONFIG_FILENAME = 'gate.config.json';

type PackageManager = 'npm' | 'yarn' | 'pnpm';

type DetectedProject =
  | {
      kind: 'node';
      packageManager: PackageManager;
      packageJson: Record<string, unknown>;
    }
  | { kind: 'python'; requirements: Set<string> }
  | { kind: 'unknown' };

export interface InitOptions {
  cwd?: string;
  filename?: string;
  force?: boolean;
  print?: boolean;
  skipHook?: boolean;
}

export interface InitResult {
  config: GateConfig;
  configPath: string;
  created: boolean;
  projectKind: DetectedProject['kind'];
  warnings: string[];
  error?: string;
  gitignoreUpdated?: boolean;
  hookConfigured?: boolean;
  hookAlreadyExists?: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await fileExists(path.join(cwd, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await fileExists(path.join(cwd, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

function runScriptCommand(
  packageManager: PackageManager,
  scriptName: string,
): string {
  switch (packageManager) {
    case 'yarn':
      return `yarn ${scriptName}`;
    case 'pnpm':
      return `pnpm run ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function extractRequirementName(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return null;
  }
  const noEnvMarker = trimmed.split(';', 1)[0]?.trim() ?? '';
  if (noEnvMarker.length === 0) {
    return null;
  }
  const name = noEnvMarker.split(/[<>=\[]/, 1)[0]?.trim();
  if (!name) {
    return null;
  }
  return name.toLowerCase();
}

async function detectProject(cwd: string): Promise<DetectedProject> {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (await fileExists(packageJsonPath)) {
    const pm = await detectPackageManager(cwd);
    const parsed = await readJsonFile(packageJsonPath);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('package.json is not a JSON object.');
    }
    return {
      kind: 'node',
      packageManager: pm,
      packageJson: parsed as Record<string, unknown>,
    };
  }

  const requirementsPath = path.join(cwd, 'requirements.txt');
  const pyprojectPath = path.join(cwd, 'pyproject.toml');

  if (
    (await fileExists(requirementsPath)) ||
    (await fileExists(pyprojectPath))
  ) {
    const requirements = new Set<string>();
    if (await fileExists(requirementsPath)) {
      const raw = await fs.readFile(requirementsPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const name = extractRequirementName(line);
        if (name) {
          requirements.add(name);
        }
      }
    }
    return { kind: 'python', requirements };
  }

  return { kind: 'unknown' };
}

function getPackageJsonScripts(
  packageJson: Record<string, unknown>,
): Record<string, string> {
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== 'object') {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    scripts as Record<string, unknown>,
  )) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function getPackageJsonDeps(packageJson: Record<string, unknown>): Set<string> {
  const deps = new Set<string>();
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const;
  for (const section of sections) {
    const values = packageJson[section];
    if (!values || typeof values !== 'object') {
      continue;
    }
    for (const name of Object.keys(values as Record<string, unknown>)) {
      deps.add(name);
    }
  }
  return deps;
}

async function inferNodeGates(
  cwd: string,
  packageManager: PackageManager,
  packageJson: Record<string, unknown>,
  warnings: string[],
): Promise<Gate[]> {
  const gates: Gate[] = [];
  const scripts = getPackageJsonScripts(packageJson);
  const deps = getPackageJsonDeps(packageJson);

  const addIfScript = (name: string, order: number) => {
    if (!scripts[name]) {
      return;
    }
    gates.push({
      name,
      order,
      command: runScriptCommand(packageManager, name),
    });
  };

  addIfScript('lint', 10);
  addIfScript('typecheck', 20);
  addIfScript('test', 30);
  addIfScript('build', 40);

  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  const hasTypescript = deps.has('typescript');
  if (hasTypescript && (await fileExists(tsconfigPath)) && !scripts.typecheck) {
    warnings.push(
      "No 'typecheck' script found; generating a default tsc gate.",
    );
    gates.splice(1, 0, {
      name: 'typecheck',
      order: 20,
      command: 'npx tsc -p tsconfig.json --noEmit',
    });
  }

  return gates;
}

function inferPythonGates(
  requirements: Set<string>,
  warnings: string[],
): Gate[] {
  const gates: Gate[] = [];

  if (requirements.has('ruff')) {
    gates.push({ name: 'lint', order: 10, command: 'python -m ruff check .' });
  }

  if (requirements.has('mypy')) {
    gates.push({ name: 'typecheck', order: 20, command: 'python -m mypy .' });
  }

  if (requirements.has('pytest')) {
    gates.push({ name: 'test', order: 30, command: 'python -m pytest -q' });
  } else {
    warnings.push(
      'pytest not detected in requirements; no test gate generated.',
    );
  }

  return gates;
}

async function updateGitignore(cwd: string): Promise<boolean> {
  const gitignorePath = path.join(cwd, '.gitignore');
  const filePattern = 'gate-results-*.json';

  try {
    // Use git check-ignore to test if the pattern would already cover gate result files
    // This handles all edge cases: broader patterns, multiple patterns, etc.
    execSync('git check-ignore -q gate-results-12345.json', {
      cwd,
      stdio: 'ignore',
    });
    // Exit code 0 means the file would be ignored - pattern already covered
    return false;
  } catch {
    // Not ignored or git not available - need to add the pattern
  }

  try {
    // Check if .gitignore exists and read it
    const exists = await fileExists(gitignorePath);
    const content = exists ? await fs.readFile(gitignorePath, 'utf8') : '';

    // Append the pattern with proper newline handling
    const newline = content && !content.endsWith('\n') ? '\n' : '';
    await fs.appendFile(gitignorePath, `${newline}${filePattern}\n`, 'utf8');
    return true;
  } catch {
    // Silently fail if we can't update .gitignore
    return false;
  }
}

interface ClaudeHookCommand {
  type: string;
  command: string;
}

interface ClaudeHookConfig {
  matcher?: Record<string, unknown> | string;
  hooks: ClaudeHookCommand[];
}

interface ClaudeSettings {
  hooks?: {
    Stop?: ClaudeHookConfig[];
    [key: string]: ClaudeHookConfig[] | undefined;
  };
  [key: string]: unknown;
}

const RALPH_GATE_HOOK_COMMAND = 'npx ralph-gate --hook';

async function setupClaudeHook(
  cwd: string,
): Promise<{ configured: boolean; alreadyExists: boolean }> {
  const claudeDir = path.join(cwd, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  try {
    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    let settings: ClaudeSettings = {};

    // Read existing settings if file exists
    if (await fileExists(settingsPath)) {
      try {
        const content = await fs.readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
          settings = parsed as ClaudeSettings;
        }
      } catch {
        // If we can't parse existing file, start fresh but warn
        settings = {};
      }
    }

    // Initialize hooks structure if needed
    if (!settings.hooks) {
      settings.hooks = {};
    }
    if (!settings.hooks.Stop) {
      settings.hooks.Stop = [];
    }

    // Filter out invalid/legacy hook configurations
    // 1. Must have 'hooks' array
    // 2. Must NOT have a matcher that is an object (Stop hooks expect string or undefined)
    settings.hooks.Stop = settings.hooks.Stop.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      if (!('hooks' in item) || !Array.isArray(item.hooks)) return false;
      if ('matcher' in item && typeof item.matcher === 'object') return false; // Remove legacy object matchers
      return true;
    });

    // Check if ralph-gate hook already exists in new format
    let hookExists = false;
    for (const item of settings.hooks.Stop) {
      if ('hooks' in item && Array.isArray(item.hooks)) {
        const hasRalphGate = item.hooks.some(
          (hook) =>
            hook.type === 'command' && hook.command === RALPH_GATE_HOOK_COMMAND,
        );
        if (hasRalphGate) {
          hookExists = true;
          break;
        }
      }
    }

    if (hookExists) {
      return { configured: false, alreadyExists: true };
    }

    // Append the ralph-gate hook with new format (no matcher for Stop hooks)
    settings.hooks.Stop.push({
      hooks: [
        {
          type: 'command',
          command: RALPH_GATE_HOOK_COMMAND,
        },
      ],
    });

    // Write updated settings
    await fs.writeFile(
      settingsPath,
      JSON.stringify(settings, null, 2) + '\n',
      'utf8',
    );

    return { configured: true, alreadyExists: false };
  } catch {
    // Silently fail if we can't setup hook
    return { configured: false, alreadyExists: false };
  }
}

export async function generateGateConfig(cwd: string): Promise<{
  config: GateConfig;
  projectKind: DetectedProject['kind'];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const detected = await detectProject(cwd);

  let gates: Gate[] = [];

  if (detected.kind === 'node') {
    gates = await inferNodeGates(
      cwd,
      detected.packageManager,
      detected.packageJson,
      warnings,
    );
  } else if (detected.kind === 'python') {
    gates = inferPythonGates(detected.requirements, warnings);
  } else {
    warnings.push(
      'No supported project markers found; creating an empty gate config.',
    );
  }

  return {
    config: {
      gates,
      failFast: true,
    },
    projectKind: detected.kind,
    warnings,
  };
}

export async function initConfigFile(
  options: InitOptions = {},
): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const filename = options.filename ?? DEFAULT_CONFIG_FILENAME;
  const configPath = path.join(cwd, filename);

  const { config, projectKind, warnings } = await generateGateConfig(cwd);

  if (options.print) {
    return {
      config,
      configPath,
      created: false,
      projectKind,
      warnings,
    };
  }

  const writeFlag = options.force ? 'w' : 'wx';

  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf8',
      flag: writeFlag,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (!options.force && code === 'EEXIST') {
      return {
        config,
        configPath,
        created: false,
        projectKind,
        warnings,
        error: `Config already exists at ${configPath}. Use --force to overwrite.`,
      };
    }
    return {
      config,
      configPath,
      created: false,
      projectKind,
      warnings,
      error: `Unable to write config at ${configPath}: ${message}`,
    };
  }

  // Update .gitignore to include gate result files
  const gitignoreUpdated = await updateGitignore(cwd);

  // Setup Claude hook unless skipped
  let hookConfigured: boolean | undefined;
  let hookAlreadyExists: boolean | undefined;

  if (!options.skipHook) {
    const hookResult = await setupClaudeHook(cwd);
    hookConfigured = hookResult.configured;
    hookAlreadyExists = hookResult.alreadyExists;
  }

  return {
    config,
    configPath,
    created: true,
    projectKind,
    warnings,
    gitignoreUpdated,
    hookConfigured,
    hookAlreadyExists,
  };
}
