/**
 * `svc.getById()` where `const svc = issueService(db)` links to the function
 * the factory returns under that key.
 *
 * Service factories (`export function issueService(db) { …; return { getById:
 * async (id) => {…} } }`) are how Paperclip and many Node servers wire routes to
 * services. The returned functions had no node and the receiver had no type,
 * so every route → service call was unlinked. The extractor now makes
 * `issueService::getById`, and the resolver follows the `const svc = factory()`
 * binding to it. These tests run the full `indexAll()` path, including a
 * barrel re-export, and pin that a receiver bound to two different factories
 * links nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('service factory member calls', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-member-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  // Index once, then list each named caller's function targets.
  const indexCalls = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const rows: { src: string; tgtQn: string }[] = (cg as any).db.db
      .prepare(
        `SELECT s.name src, t.qualified_name tgtQn FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls'`,
      )
      .all();
    cg.close?.();
    return (src: string) => rows.filter((r) => r.src === src).map((r) => r.tgtQn).sort();
  };

  const services = () => {
    write('src/services/issues.ts', `export function issueService(db: unknown) {
  async function remove(id: string) { return id; }
  return {
    remove,
    getById: async (id: string) => id,
    list() { return []; },
  };
}
`);
    write('src/services/agents.ts', `export function agentService(db: unknown) {
  return { list: () => [], wake: (id: string) => id };
}
`);
    write('src/services/index.ts', `export { issueService } from './issues.js';
export { agentService } from './agents.js';
`);
  };

  it('links route handler calls to the returned functions, through a barrel import', async () => {
    services();
    write('src/routes/issues.ts', `import { issueService, agentService } from '../services/index.js';
export function issueRoutes(db: unknown) {
  const svc = issueService(db);
  const agents = agentService(db);
  return {
    get: async (id: string) => svc.getById(id),
    all: () => { svc.list(); return agents.list(); },
    drop: (id: string) => svc.remove(id),
  };
}
`);
    const from = await indexCalls();
    expect(from('get')).toEqual(['issueService::getById']);
    expect(from('all')).toEqual(['agentService::list', 'issueService::list']);
    expect(from('drop')).toEqual(['issueService::remove']);
  });

  it('links an object bound then returned by name, and a renamed entry', async () => {
    write('src/services/projects.ts', `async function getProjectById(id: string) { return id; }
export function projectService(db: unknown) {
  async function listAll() { return []; }
  const service = {
    getById: getProjectById,
    list: listAll,
    archive: async (id: string) => id,
  };
  const api = service as ProjectApi;
  return api;
}
interface ProjectApi { archive(id: string): Promise<string> }
`);
    write('src/routes/projects.ts', `import { projectService } from '../services/projects.js';
export function projectRoutes(db: unknown) {
  const projects = projectService(db);
  return {
    one: (id: string) => projects.getById(id),
    all: () => projects.list(),
    drop: (id: string) => projects.archive(id),
  };
}
`);
    const from = await indexCalls();
    expect(from('one')).toEqual(['getProjectById']);
    expect(from('all')).toEqual(['projectService::listAll']);
    expect(from('drop')).toEqual(['projectService::archive']);
  });

  it('links nothing when the name is bound to two factories that both have the member', async () => {
    services();
    write('src/routes/mixed.ts', `import { issueService, agentService } from '../services/index.js';
export function a(db: unknown) { const svc = issueService(db); return svc.list(); }
export function b(db: unknown) { const svc = agentService(db); return svc.list(); }
`);
    const from = await indexCalls();
    expect(from('a').filter((t) => t.endsWith('::list'))).toEqual([]);
    expect(from('b').filter((t) => t.endsWith('::list'))).toEqual([]);
  });

  it('a binding to one factory still links when another binding of the name has no such member', async () => {
    services();
    write('src/routes/agents.ts', `import { agentService } from '../services/index.js';
function asRecord(x: unknown) { return x as Record<string, unknown>; }
export function agentRoutes(db: unknown, cfg: unknown) {
  const heartbeat = agentService(db);
  function read() { const heartbeat = asRecord(cfg); return heartbeat; }
  return { wakeOne: (id: string) => heartbeat.wake(id), read };
}
`);
    const from = await indexCalls();
    expect(from('wakeOne')).toEqual(['agentService::wake']);
  });
});
