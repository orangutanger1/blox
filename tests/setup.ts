import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests never see the developer's real credentials (~/.config/blox: auth.json,
// opencloud.env) or a real Open Cloud key: a fallback once sent a test upload
// to the live API.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'blox-test-config-'));
delete process.env.ROBLOX_OPEN_CLOUD_KEY;
