import { resolve, sep } from 'node:path';
import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

// True when `target` resolves to `projectPath` or a descendant of it. Relative
// targets resolve against the project root. The `+ sep` boundary stops a sibling
// like /game-evil from matching the root /game.
export function isPathContained(projectPath: string, target: string): boolean {
  const root = resolve(projectPath);
  const p = resolve(root, target);
  return p === root || p.startsWith(root + sep);
}

// True for the only file types blox writes — Roblox source synced by Rojo.
export function isLuauPath(target: string): boolean {
  const t = target.toLowerCase();
  return t.endsWith('.luau') || t.endsWith('.lua');
}

// True when Luau source reaches an external endpoint. HttpService covers the
// HttpService:GetAsync/PostAsync/RequestAsync surface; HttpGet covers the
// game:HttpGet / game:HttpGetAsync DataModel shortcuts.
export function referencesExternalHttp(code: string): boolean {
  return /HttpService|HttpGet/i.test(code);
}

const CONTINUE: HookJSONOutput = { continue: true };

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// Match a tool by its bare name or any MCP-qualified form (mcp__<server>__<bare>).
function is(toolName: string, bare: string): boolean {
  return toolName === bare || toolName.endsWith(`__${bare}`);
}

const WRITE_TOOLS = new Set(['Write', 'Edit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// PreToolUse guardrail (spec §5). Fires on EVERY tool call — the only
// enforcement point that works under --auto's bypassPermissions, where the
// permission callback is never consulted. Denies the deterministic exfil/escape
// invariants; everything else continues untouched.
export function buildGuardrailHook(projectPath: string): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return CONTINUE;
    const name = input.tool_name;
    const args = (input.tool_input ?? {}) as Record<string, unknown>;

    // External-fetch tool: exfil (secrets in the query string) + untrusted-content
    // ingestion. Not on blox's allow-list, but reachable in both modes.
    if (is(name, 'http_get')) {
      return deny(
        'External web requests are blocked. blox edits a Roblox project on disk; it does not fetch external URLs.',
      );
    }

    // Live verification probe must not call out.
    if (is(name, 'execute_luau')) {
      const code = typeof args.code === 'string' ? args.code : '';
      if (referencesExternalHttp(code)) {
        return deny(
          'execute_luau must not make external HttpService requests during verification. If the game itself needs HTTP, author it in a .luau file (Rojo syncs it) instead of a live probe.',
        );
      }
      return CONTINUE;
    }

    // Writes: inside the project AND a .luau/.lua file only.
    if (WRITE_TOOLS.has(name)) {
      const fp = typeof args.file_path === 'string' ? args.file_path : '';
      if (!fp || !isPathContained(projectPath, fp)) {
        return deny(`Writes are limited to files inside the project (${projectPath}); "${fp}" is outside it.`);
      }
      if (!isLuauPath(fp)) {
        return deny(
          `Writes are limited to .luau/.lua files; "${fp}" is not one. Edit Roblox source on disk so Rojo stays the source of truth.`,
        );
      }
      return CONTINUE;
    }

    // Reads/searches: inside the project only. Grep/Glob path is optional —
    // when absent it defaults to cwd (the project), so only a present path is checked.
    if (READ_TOOLS.has(name)) {
      const fp =
        typeof args.file_path === 'string'
          ? args.file_path
          : typeof args.path === 'string'
            ? args.path
            : '';
      if (fp && !isPathContained(projectPath, fp)) {
        return deny(`Reads are limited to files inside the project (${projectPath}); "${fp}" is outside it.`);
      }
      return CONTINUE;
    }

    return CONTINUE;
  };
}
