/**
 * A receiver whose declared type comes from a library gets no guessed edge.
 *
 * matchMethodCall reads a receiver's declared type first (`Stream stream`,
 * `var found = new List<Def>()`). When the project does not define that type,
 * the method lives in the library, but the name-similarity strategies used to
 * run anyway: `stream.Read()` went to the project's only `Read` method and
 * `found.Add()` to a project class named `Found`. JS/TS already stopped for
 * builtin types (#1566, #1840); this pins the same rule for other languages,
 * and that project-typed and untyped receivers still resolve as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('library receiver types get no guessed edge', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-recv-')); });
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
    const calls: { src: string; tgtQn: string }[] = db
      .prepare(
        `SELECT s.name src, t.qualified_name tgtQn
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls' AND t.kind = 'method'`,
      )
      .all();
    cg.close?.();
    return calls;
  };
  const callsFrom = (calls: any[], src: string) => calls.filter((e) => e.src === src).map((e) => e.tgtQn);

  const frame = `namespace App {
  public class Frame {
    public static bool Read(System.IO.Stream s, int max) { return true; }
    public static void Write(System.IO.Stream s, byte[] b) { }
  }
}
`;
  const found = `namespace App {
  public class Gather {
    public class Found { public void Add(string def, int n) { } }
  }
}
`;

  it('C#: a Stream parameter does not link to the project\'s lone Read/Write', async () => {
    write('Frame.cs', frame);
    write('Server.cs', `using System.IO;
namespace App {
  public class Server {
    static bool Pump(Stream stream, byte[] buffer) {
      stream.Write(buffer, 0, buffer.Length);
      return stream.Read(buffer, 0, 1) > 0;
    }
  }
}
`);
    const calls = await load();
    expect(callsFrom(calls, 'Pump')).toEqual([]);
  });

  it('C#: `var found = new List<T>()` does not link to a project class Found', async () => {
    write('Gather.cs', found);
    write('Catalog.cs', `using System.Collections.Generic;
namespace App {
  public class Catalog {
    static List<string> Pick(string[] names) {
      var found = new List<string>();
      foreach (var n in names) found.Add(n);
      return found;
    }
  }
}
`);
    const calls = await load();
    expect(callsFrom(calls, 'Pick')).toEqual([]);
  });

  it('C#: a receiver typed by a project class still links', async () => {
    write('Frame.cs', `namespace App {
  public class Frame { public bool Read(int max) { return true; } }
}
`);
    write('Server.cs', `namespace App {
  public class Server {
    static bool Pump() { var frame = new Frame(); return frame.Read(1); }
  }
}
`);
    const calls = await load();
    expect(callsFrom(calls, 'Pump')).toContain('App::Frame::Read');
  });

  it('C#: a receiver with no declared type still falls back to the class-name match', async () => {
    write('Gather.cs', found);
    write('Catalog.cs', `namespace App {
  public class Catalog {
    static void Pick(Gather.Found found) { }
    static void Fill() { found.Add("wood", 1); }
  }
}
`);
    const calls = await load();
    expect(callsFrom(calls, 'Fill')).toContain('App::Gather::Found::Add');
  });

  it('Java: a StringBuilder local does not link to the project\'s lone append', async () => {
    write('src/Log.java', `public class Log { public Log append(String s) { return this; } }
`);
    write('src/Report.java', `public class Report {
  String render(String[] rows) {
    StringBuilder sb = new StringBuilder();
    for (String r : rows) sb.append(r);
    return sb.toString();
  }
}
`);
    const calls = await load();
    expect(callsFrom(calls, 'render')).toEqual([]);
  });
});
