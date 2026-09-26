/**
 * `codegraph_feedback` — an agent reports where CodeGraph was wrong, and the
 * report lands as one Markdown file in the feedback inbox (fork feature).
 *
 * Pins: a good report is filed with the graph's own answer for the symbol, a
 * report without evidence is sent back with guidance (never `isError`), an
 * `idea` needs no evidence, and the file carries the frontmatter the review
 * team sorts by.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_FEEDBACK_DIR';

describe('codegraph_feedback', () => {
  let dir: string;
  let inbox: string;
  const original = process.env[ENV];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-feedback-'));
    inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-feedback-inbox-'));
    process.env[ENV] = inbox;
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(inbox, { recursive: true, force: true });
  });

  const indexed = async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), `export function target() { return 1; }
export function caller() { return target(); }
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    return cg;
  };
  const filed = () => fs.readdirSync(path.join(inbox, 'inbox'));
  const text = (res: { content: { text: string }[] }) => res.content[0].text;

  it('files a report with the graph answer for the symbol', async () => {
    const cg = await indexed();
    const res = await new ToolHandler(cg).execute('codegraph_feedback', {
      kind: 'missing-link',
      summary: 'target is also called from b.ts',
      evidence: 'b.ts:3 calls target()',
      symbol: 'target',
      expected: 'b.ts listed as a caller',
      reporter: 'test-agent',
    });
    cg.close();
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/^Filed: /);
    const files = filed();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-missing-link-target-[0-9a-f]{6}\.md$/);
    const body = fs.readFileSync(path.join(inbox, 'inbox', files[0]), 'utf8');
    expect(body).toMatch(/^---\nid: [0-9a-f]{6}\nkind: missing-link\n/);
    expect(body).toContain(`project: ${JSON.stringify(cg.getProjectRoot())}`);
    expect(body).toContain('symbol: "target"');
    expect(body).toContain('reporter: "test-agent"');
    expect(body).toContain('# target is also called from b.ts');
    expect(body).toContain('## Evidence\n\nb.ts:3 calls target()');
    expect(body).toContain('## Expected\n\nb.ts listed as a caller');
    expect(body).not.toContain('## Got');
    expect(body).toContain('## What the graph said');
    expect(body).toMatch(/- target \(a\.ts:1\): 1 caller\(s\)\n- {3}caller — a\.ts:2/);
  });

  it('sends a report without evidence back with guidance, not an error', async () => {
    const res = await new ToolHandler(null).execute('codegraph_feedback', {
      kind: 'wrong-link', summary: 'x links to y',
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/^Not filed: add evidence/);
    expect(fs.existsSync(path.join(inbox, 'inbox'))).toBe(false);
  });

  it('rejects an unknown kind with the list of kinds', async () => {
    const res = await new ToolHandler(null).execute('codegraph_feedback', {
      kind: 'bug', summary: 's', evidence: 'e',
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('missing-link, wrong-link');
  });

  it('files an idea without evidence and without a project', async () => {
    const res = await new ToolHandler(null).execute('codegraph_feedback', {
      kind: 'idea', summary: 'Follow ReturnType<typeof f> aliases',
    });
    expect(text(res)).toMatch(/^Filed: /);
    const body = fs.readFileSync(path.join(inbox, 'inbox', filed()[0]), 'utf8');
    expect(body).toContain('kind: idea');
    expect(body).not.toContain('project:');
    expect(body).not.toContain('## Evidence');
  });
});
