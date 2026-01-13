import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Gate, GateConfig } from './types.js';

const CONFIG_FILES = ['gate.config.json', '.gaterc.json', '.gaterc'];

export interface LoadConfigResult {
  config: GateConfig | null;
  configPath?: string;
  error?: string;
}

function normalizeGate(gate: Gate): Gate {
  const order = typeof gate.order === 'number' ? gate.order : 100;
  const enabled = typeof gate.enabled === 'boolean' ? gate.enabled : true;
  const blocking = typeof gate.blocking === 'boolean' ? gate.blocking : true;

  return {
    ...gate,
    order,
    enabled,
    blocking,
    description:
      typeof gate.description === 'string' ? gate.description : undefined,
    name: gate.name,
    command: gate.command,
  } as Gate;
}

function validateGate(gate: unknown): string | null {
  if (!gate || typeof gate !== 'object') {
    return 'Gate entries must be objects.';
  }
  const maybeGate = gate as Gate;
  if (typeof maybeGate.name !== 'string' || maybeGate.name.trim() === '') {
    return 'Gate is missing required field: name.';
  }
  if (
    typeof maybeGate.command !== 'string' ||
    maybeGate.command.trim() === ''
  ) {
    return `Gate '${maybeGate.name}' is missing required field: command.`;
  }
  return null;
}

function sortGates(gates: Gate[]): Gate[] {
  const withIndex = gates.map((gate, index) => ({ gate, index }));
  withIndex.sort((a, b) => {
    const orderA = typeof a.gate.order === 'number' ? a.gate.order : 100;
    const orderB = typeof b.gate.order === 'number' ? b.gate.order : 100;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.index - b.index;
  });
  return withIndex.map((entry) => entry.gate);
}

export async function loadConfig(
  cwd: string = process.cwd(),
): Promise<LoadConfigResult> {
  for (const filename of CONFIG_FILES) {
    const filePath = path.join(cwd, filename);
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      return {
        config: null,
        configPath: filePath,
        error: `Invalid config: unable to read ${filename}: ${(error as Error).message}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        config: null,
        configPath: filePath,
        error: `Invalid config: malformed JSON in ${filename}: ${(error as Error).message}`,
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        config: null,
        configPath: filePath,
        error: `Invalid config: expected object in ${filename}.`,
      };
    }

    const config = parsed as GateConfig;
    if (!Array.isArray(config.gates)) {
      return {
        config: null,
        configPath: filePath,
        error: `Invalid config: missing required 'gates' array in ${filename}.`,
      };
    }

    const normalized: Gate[] = [];
    for (const gate of config.gates) {
      const gateError = validateGate(gate as Gate);
      if (gateError) {
        return {
          config: null,
          configPath: filePath,
          error: `Invalid config: ${gateError}`,
        };
      }
      const normalizedGate = normalizeGate(gate as Gate);
      if (normalizedGate.enabled === false) {
        continue;
      }
      normalized.push(normalizedGate);
    }

    const failFast =
      typeof config.failFast === 'boolean' ? config.failFast : true;
    const outputPath =
      typeof config.outputPath === 'string' ? config.outputPath : undefined;

    const sorted = sortGates(normalized);

    return {
      config: {
        gates: sorted,
        failFast,
        outputPath,
      },
      configPath: filePath,
    };
  }

  return { config: null };
}
