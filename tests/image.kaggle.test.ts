import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KaggleUnavailable, batchKernel, runKaggleBatch, weightsKernel, type KaggleCli } from '../src/image/kaggle.js';

const items = [{ file: 'coin.png', prompt: 'a gold coin', seed: 7 }, { file: 'gem.png', prompt: 'a gem', seed: 8 }];

function fakeCli(o: { statuses?: string[]; push?: { code: number; stderr: string }; results?: unknown; log?: string } = {}) {
  const calls: string[][] = [];
  const statuses = [...(o.statuses ?? ['RUNNING', 'COMPLETE'])];
  const cli: KaggleCli = async (args) => {
    calls.push(args);
    if (args[0] === 'config') return { code: 0, stdout: '- username: alice\n', stderr: '' };
    if (args[1] === 'push') {
      const dir = args[args.indexOf('-p') + 1];
      expect(existsSync(join(dir, 'kernel-metadata.json'))).toBe(true);
      return o.push ? { code: o.push.code, stdout: '', stderr: o.push.stderr } : { code: 0, stdout: 'Kernel version 3 successfully pushed.', stderr: '' };
    }
    if (args[1] === 'status') return { code: 0, stdout: `alice/blox-image-batch has status "KernelWorkerStatus.${statuses.shift() ?? 'COMPLETE'}"`, stderr: '' };
    if (args[1] === 'output') {
      const dir = args[args.indexOf('-p') + 1];
      mkdirSync(join(dir, 'out'), { recursive: true });
      writeFileSync(join(dir, 'out/results.json'), JSON.stringify(o.results ?? { status: 'DONE', results: [{ file: 'coin.png', seed: 7, channels: 3 }, { file: 'gem.png', error: 'OutOfMemoryError: x' }] }));
      writeFileSync(join(dir, 'out/coin.png'), 'PNGDATA');
      writeFileSync(join(dir, 'blox-image-batch.log'), o.log ?? 'line1\nline2');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { cli, calls };
}
const instant = async () => {};

describe('kaggle kernels', () => {
  it('batch kernel: private GPU script with the runtime dataset and the weights kernel attached', () => {
    const k = batchKernel('alice', items, 512);
    expect(k.meta).toMatchObject({ id: 'alice/blox-image-batch', is_private: true, enable_gpu: true, enable_internet: true, kernel_type: 'script', dataset_sources: ['tamadaresearch/qwen-image21-t4-runtime'], kernel_sources: ['alice/blox-qwen21-weights'] });
    expect(k.script).toContain('a gold coin');
    expect(k.script).toContain('SIZE = 512');
  });
  it('weights kernel runs on CPU', () => {
    expect(weightsKernel('alice').meta).toMatchObject({ id: 'alice/blox-qwen21-weights', enable_gpu: false, enable_internet: true });
  });
});

describe('runKaggleBatch', () => {
  it('pushes, polls to complete, downloads, returns images and per-item errors', async () => {
    const { cli, calls } = fakeCli();
    const work = mkdtempSync(join(tmpdir(), 'blox-kg-'));
    const r = await runKaggleBatch(items, { size: 512, workDir: work, cli, sleep: instant });
    expect(calls.map((c) => c[1] ?? c[0])).toEqual(['view', 'push', 'status', 'status', 'output']);
    expect(r.find((x) => x.file === 'coin.png')!.data!.toString()).toBe('PNGDATA');
    expect(r.find((x) => x.file === 'gem.png')!.error).toMatch(/OutOfMemory/);
  });
  it('a kernel error shows the log tail', async () => {
    const { cli } = fakeCli({ statuses: ['ERROR'], results: { status: 'FAILED', error: 'weights: missing', results: [] }, log: 'a\nb\nTraceback: boom' });
    await expect(runKaggleBatch(items, { size: 512, workDir: mkdtempSync(join(tmpdir(), 'blox-kg-')), cli, sleep: instant })).rejects.toThrow(/weights: missing[\s\S]*boom/);
  });
  it('quota or auth failures are KaggleUnavailable (the fallback trigger)', async () => {
    const { cli } = fakeCli({ push: { code: 1, stderr: '429 Client Error: weekly GPU quota exceeded' } });
    await expect(runKaggleBatch(items, { size: 512, workDir: mkdtempSync(join(tmpdir(), 'blox-kg-')), cli, sleep: instant })).rejects.toBeInstanceOf(KaggleUnavailable);
  });
});
