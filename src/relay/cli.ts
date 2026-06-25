import { resolve } from 'node:path';
import { loadConfig, type BloxConfig, type Relay } from '../config.js';
import { addMember, removeMember, listMembers } from './members.js';

export type RelayServeResolved = { error: string } | { realKey: string };

export function resolveRelayServe(config: BloxConfig, env: NodeJS.ProcessEnv): RelayServeResolved {
  if (!config.relay) return { error: 'no `relay` block in blox.config.json — add one (see docs)' };
  const realKey = env[config.relay.apiKeyEnv];
  if (!realKey) return { error: `no team API key in $${config.relay.apiKeyEnv}` };
  return { realKey };
}

// Resolve the relay's members/ledger paths against the PROJECT ROOT, not the
// process CWD, so `relay serve` and the member commands agree on the files no
// matter where serve is launched from. An absolute configured path is honored.
export function resolveRelayPaths(config: BloxConfig): Relay {
  const relay = config.relay!;
  return {
    ...relay,
    membersPath: resolve(config.projectPath, relay.membersPath),
    ledgerPath: resolve(config.projectPath, relay.ledgerPath),
  };
}

function membersPath(projectPath: string): string {
  const config = loadConfig(projectPath, { projectPath });
  if (config.relay) return resolveRelayPaths(config).membersPath;
  return resolve(config.projectPath, '.blox/relay-members.json');
}

export function relayMemberCommand(action: 'add' | 'rm' | 'list', projectPath: string, email?: string): string {
  const path = membersPath(projectPath);
  if (action === 'add') {
    if (!email) throw new Error('add-member needs an email');
    const token = addMember(path, email);
    return `added ${email}\n  token: ${token}\n  store this now — it will not be shown again`;
  }
  if (action === 'rm') {
    if (!email) throw new Error('rm-member needs an email');
    return removeMember(path, email) ? `removed ${email}` : `no such member: ${email}`;
  }
  const members = listMembers(path);
  return members.length ? members.join('\n') : '(no members)';
}
