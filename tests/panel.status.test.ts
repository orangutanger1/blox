import { describe, it, expect } from 'vitest';
import { checkPanel, formatPanelStatus } from '../src/panel/status.js';
import type { PanelFetchFn } from '../src/panel/status.js';

const up: PanelFetchFn = async () => ({ ok: true, json: async () => ({ project: 'blox-playground', protocol: 4, runId: 'abcd1234ef' }) });
const notOk: PanelFetchFn = async () => ({ ok: false, json: async () => ({}) });
const refused: PanelFetchFn = async () => { throw new Error('ECONNREFUSED'); };

describe('checkPanel', () => {
  it('running when /info returns ok', async () => {
    expect(await checkPanel(35768, up)).toMatchObject({ running: true, port: 35768, project: 'blox-playground', protocol: 4 });
  });
  it('not running on non-ok or refused', async () => {
    expect(await checkPanel(35768, notOk)).toEqual({ running: false, port: 35768 });
    expect(await checkPanel(35768, refused)).toEqual({ running: false, port: 35768 });
  });
});

describe('formatPanelStatus', () => {
  it('shows RUNNING with project + truncated runId', () => {
    const s = formatPanelStatus({ running: true, port: 35768, project: 'g', protocol: 4, runId: 'abcd1234ef' });
    expect(s).toContain('RUNNING (:35768)');
    expect(s).toContain('run abcd1234');
  });
  it('shows NOT RUNNING with a start hint', () => {
    const s = formatPanelStatus({ running: false, port: 35768 });
    expect(s).toContain('NOT RUNNING');
    expect(s).toContain('blox panel serve');
  });
});
