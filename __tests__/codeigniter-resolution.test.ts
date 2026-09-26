/**
 * CodeIgniter loaded-property resolution.
 *
 * `$this->load->model('attendance_day_model')` creates `$this->attendance_day_model`
 * at runtime, so no declaration types it and the declared-type inference in the
 * name-matcher leaves `$this->attendance_day_model->gate_present()` unlinked. The
 * `codeigniter` framework resolver maps the property to the class the loader
 * would create: same name ignoring case, in a file of that name. These tests run
 * the full `indexAll()` path, and the negative cases pin that it only fires in a
 * CodeIgniter project and never guesses between two equally-close classes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('CodeIgniter loaded-property resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-resolve-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  const load = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const calls: { src: string; srcFile: string; tgtQn: string; tgtFile: string }[] = db
      .prepare(
        `SELECT s.name src, s.file_path srcFile, t.qualified_name tgtQn, t.file_path tgtFile
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls' AND t.kind = 'method'`,
      )
      .all();
    cg.close?.();
    return calls;
  };
  const hasCall = (calls: any[], src: string, tgtQn: string) =>
    calls.some((e) => e.src === src && e.tgtQn === tgtQn);

  const model = `<?php
class Attendance_day_model extends CI_Model {
  public function gate_present($id) { return true; }
}
`;

  it('links a model loaded by lower-case name to its class', async () => {
    write('application/models/Attendance_day_model.php', model);
    write('application/models/Gateevent_model.php', `<?php
class Gateevent_model extends CI_Model {
  public function __construct() { $this->load->model('attendance_day_model'); }
  public function record($e) { return $this->attendance_day_model->gate_present($e); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'record', 'Attendance_day_model::gate_present')).toBe(true);
  });

  it('links an upper-case property and a library from a controller', async () => {
    write('application/models/Attendance_day_model.php', model);
    write('application/libraries/Gate_log.php', `<?php
class Gate_log { public function write($m) { return $m; } }
`);
    write('application/controllers/Gateevent.php', `<?php
class Gateevent extends CI_Controller {
  public function batch() {
    $this->load->model('Attendance_day_model');
    $this->load->library('gate_log');
    $this->Attendance_day_model->gate_present(1);
    $this->gate_log->write('x');
  }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'batch', 'Attendance_day_model::gate_present')).toBe(true);
    expect(hasCall(calls, 'batch', 'Gate_log::write')).toBe(true);
  });

  it('prefers the class in the same app when two apps declare it', async () => {
    for (const app of ['nps', 'cst']) {
      write(`${app}/application/models/Attendance_day_model.php`, model);
      write(`${app}/application/controllers/Gate.php`, `<?php
class Gate extends CI_Controller {
  public function scan() { return $this->attendance_day_model->gate_present(1); }
}
`);
    }
    const calls = (await load()).filter((e) => e.src === 'scan');
    expect(calls).toHaveLength(2);
    for (const e of calls) {
      expect(e.tgtFile.split('/')[0]).toBe(e.srcFile.split('/')[0]);
    }
  });

  it('links nothing when two classes are equally close', async () => {
    write('a/Attendance_day_model.php', model);
    write('b/Attendance_day_model.php', model);
    write('application/controllers/Gate.php', `<?php
class Gate extends CI_Controller {
  public function scan() { return $this->attendance_day_model->gate_present(1); }
}
`);
    const calls = await load();
    expect(calls.some((e) => e.src === 'scan')).toBe(false);
  });

  it('links nothing when the class has no such method', async () => {
    write('application/models/Attendance_day_model.php', model);
    write('application/controllers/Gate.php', `<?php
class Gate extends CI_Controller {
  public function scan() { return $this->attendance_day_model->missing(1); }
}
`);
    const calls = await load();
    expect(calls.some((e) => e.src === 'scan')).toBe(false);
  });

  it('does nothing outside a CodeIgniter project', async () => {
    write('src/Attendance_day_model.php', `<?php
class Attendance_day_model { public function gate_present($id) { return true; } }
`);
    write('src/Gate.php', `<?php
class Gate {
  public function scan() { return $this->attendance_day_model->gate_present(1); }
}
`);
    const calls = await load();
    expect(calls.some((e) => e.src === 'scan')).toBe(false);
  });
});
