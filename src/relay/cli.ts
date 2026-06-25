import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { addMember, removeMember, listMembers } from './members.js';

function membersPath(projectPath: string): string {
  const config = loadConfig(projectPath, { projectPath });
  const rel = config.relay?.membersPath ?? '.blox/relay-members.json';
  return join(config.projectPath, rel);
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
