import { describe, expect, it } from 'vitest';
import { DEVICES } from '../src/ui/lint.js';
import { uiProbeProgram } from '../src/ui/probe.js';
import { EDIT_HOST, mountProgram, previewProgram, UNSTAGE } from '../src/ui/stage.js';

const phone = DEVICES[1];

describe('edit-mode staging programs', () => {
  it('mount runs the chunk with host bound to a fresh CoreGui folder', () => {
    const p = mountProgram('UI.build(host)', 'host.Shop.Visible = true');
    expect(p).toContain(`"${EDIT_HOST}"`);
    expect(p).toMatch(/old:Destroy\(\)/);
    expect(p).toMatch(/local function __mount\(host\)\nUI\.build\(host\)\nend/);
    expect(p).toMatch(/local function __state\(host\)\nhost\.Shop\.Visible = true\nend/);
  });
  it('mount without a chunk clones the StarterGui ScreenGuis', () => {
    expect(mountProgram()).toMatch(/StarterGui[\s\S]*IsA\("ScreenGui"\)[\s\S]*Clone\(\)/);
  });
  it('the probe reads the edit host instead of the player when asked', () => {
    const p = uiProbeProgram(phone, 0, 1e6, 'edit');
    expect(p).toContain(EDIT_HOST);
    expect(p).not.toContain('LocalPlayer');
    expect(uiProbeProgram(phone)).toContain('LocalPlayer');
  });
  it('the probe reports button corner radius for the pill rule', () => {
    expect(uiProbeProgram(phone)).toMatch(/e\.cr =/);
  });
  it('preview stages one device in StarterGui and returns its viewport rect', () => {
    const p = previewProgram(phone);
    expect(p).toContain('__BloxUiPreview');
    expect(p).toContain('ShowDevelopmentGui');
    expect(p).toMatch(/JSONEncode\(\{ vw = /);
    expect(UNSTAGE).toContain('__BloxUiPreview');
    expect(UNSTAGE).toContain(EDIT_HOST);
  });
});
