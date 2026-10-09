import { describe, it, expect } from 'vitest';
import { DEVICES } from '../src/ui/lint.js';
import { forOrientation } from '../src/ui/run.js';

describe('forOrientation', () => {
  it('drops phone-portrait when StarterGui is landscape-locked, with a note', () => {
    for (const o of ['Enum.ScreenOrientation.LandscapeSensor', 'Enum.ScreenOrientation.LandscapeLeft', 'Enum.ScreenOrientation.LandscapeRight']) {
      const r = forOrientation(DEVICES, o);
      expect(r.devices.map((d) => d.name)).not.toContain('phone-portrait');
      expect(r.devices.length).toBe(DEVICES.length - 1);
      expect(r.note).toMatch(/phone-portrait skipped/);
    }
  });
  it('keeps every device for portrait, sensor or unknown orientation', () => {
    for (const o of ['Enum.ScreenOrientation.Sensor', 'Enum.ScreenOrientation.Portrait', undefined]) {
      const r = forOrientation(DEVICES, o);
      expect(r.devices).toEqual(DEVICES);
      expect(r.note).toBeUndefined();
    }
  });
});
