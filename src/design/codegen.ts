// src/design/codegen.ts
import type { DesignDoc } from './schema.js';

// design.json → a deep-frozen Luau module the game requires, so simulated and
// shipped numbers are the same numbers. Arrays of {id,...} become id-keyed maps
// (Tunables.economy.generators.dropper.cost.base).

export const TUNABLES_PATH = 'src/ReplicatedStorage/Design/Tunables.luau';
const HEADER = '-- GENERATED from .blox/design.json by `blox design codegen`. Do not edit.';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LUAU_KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue']);

function str(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function byId(v: unknown): unknown {
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')) {
    return Object.fromEntries(v.map((x) => {
      const { id, ...rest } = x as { id: string };
      return [id, byId(rest)];
    }));
  }
  if (Array.isArray(v)) return v.map(byId);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, byId(x)]));
  return v;
}

export function toLuau(v: unknown, indent: string): string {
  if (typeof v === 'number') {
    if (v === Infinity) return 'math.huge';
    if (v === -Infinity) return '-math.huge';
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? v.toFixed(0) : String(v);
  }
  if (typeof v === 'string') return str(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'nil';
  if (Array.isArray(v)) {
    if (!v.length) return 'table.freeze({})';
    return `table.freeze({ ${v.map((x) => toLuau(x, indent)).join(', ')} })`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return 'table.freeze({})';
  const inner = indent + '\t';
  const body = entries.map(([k, x]) => `${inner}${IDENT.test(k) && !LUAU_KEYWORDS.has(k) ? k : `[${str(k)}]`} = ${toLuau(x, inner)},`).join('\n');
  return `table.freeze({\n${body}\n${indent}})`;
}

export function renderTunables(doc: DesignDoc): string {
  const data = {
    meta: doc.meta,
    economy: byId(doc.economy),
    tunables: doc.tunables,
    monetization: byId(doc.monetization),
    // FTUE step ids in design order (BloxTelemetry numbers onboarding funnel steps by it)
    ftue: doc.ftue.map((f) => f.id),
  };
  return `${HEADER}\nreturn ${toLuau(data, '')}\n`;
}
