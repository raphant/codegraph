/**
 * `codegraph.json` `maxFileSizeMB` — index a hand-written file over 1 MB.
 *
 * Files over 1 MB are skipped so generated bundles stay out, but some projects
 * keep real code in one big file (Paperclip's 1.1 MB `server/src/services/heartbeat.ts`),
 * and skipping it hides every function in it. Two layers under test:
 *   1. Loader: default, valid value, and every bad value keeping the default.
 *   2. Behavior: a 1.2 MB file is skipped by default and indexed when the
 *      setting allows it, on both the bulk and the single-file indexing paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { loadMaxFileSize, clearProjectConfigCache, DEFAULT_MAX_FILE_SIZE } from '../src/project-config';

describe('maxFileSizeMB (codegraph.json)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-size-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (obj: unknown) => fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify(obj));
  // About 1.2 MB of TypeScript with one named function at the end.
  const writeBigFile = () =>
    fs.writeFileSync(
      path.join(dir, 'big.ts'),
      'export const filler = 1;\n'.repeat(50_000) + 'export function heartbeatTick(): number { return 1; }\n',
    );

  it('defaults to 1 MB with no codegraph.json', () => {
    expect(loadMaxFileSize(dir)).toBe(DEFAULT_MAX_FILE_SIZE);
    expect(DEFAULT_MAX_FILE_SIZE).toBe(1024 * 1024);
  });

  it('reads a positive number of megabytes', () => {
    writeConfig({ maxFileSizeMB: 2.5 });
    expect(loadMaxFileSize(dir)).toBe(Math.floor(2.5 * 1024 * 1024));
  });

  it('keeps the default for a bad value', () => {
    for (const bad of [0, -1, '2', null, [2]]) {
      clearProjectConfigCache();
      writeConfig({ maxFileSizeMB: bad });
      expect(loadMaxFileSize(dir)).toBe(DEFAULT_MAX_FILE_SIZE);
    }
  });

  it('skips a 1.2 MB file by default and says how to index it', async () => {
    writeBigFile();
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const error = cg.getFiles().find((f) => f.path === 'big.ts')?.errors?.[0];
    expect(error?.code).toBe('size_exceeded');
    expect(error?.message).toContain('maxFileSizeMB');
    expect(cg.searchNodes('heartbeatTick')).toHaveLength(0);
    cg.close();
  });

  it('indexes the file when maxFileSizeMB allows it (bulk path)', async () => {
    writeBigFile();
    writeConfig({ maxFileSizeMB: 2 });
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    expect(cg.getFiles().find((f) => f.path === 'big.ts')?.errors ?? []).toEqual([]);
    expect(cg.searchNodes('heartbeatTick').map((r) => r.node.name)).toContain('heartbeatTick');
    cg.close();
  });

  it('indexes the file when maxFileSizeMB allows it (single-file path)', async () => {
    writeBigFile();
    writeConfig({ maxFileSizeMB: 2 });
    const cg = await CodeGraph.init(dir, { silent: true });
    const indexed = await cg.indexFiles(['big.ts']);
    expect(indexed.filesSkipped).toBe(0);
    expect(cg.searchNodes('heartbeatTick').map((r) => r.node.name)).toContain('heartbeatTick');
    cg.close();
  });
});
