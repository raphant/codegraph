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

  // A library type reaches project code only through an extension method.
  it('C#: an extension method on a library type still links', async () => {
    write('Ext.cs', `namespace App {
  public static class ServiceExtensions {
    public static IServiceCollection AddCore(this IServiceCollection services) { return services; }
  }
}
`);
    write('Startup.cs', `namespace App {
  public class Startup {
    public void Configure(IServiceCollection services) { services.AddCore(); }
    public void Chain(Builder builder) { builder.Services.AddCore(); }
  }
}
`);
    const calls = await load();
    expect(callsFrom(calls, 'Configure')).toEqual(['App::ServiceExtensions::AddCore']);
    expect(callsFrom(calls, 'Chain')).toEqual(['App::ServiceExtensions::AddCore']);
  });

  it('Dart: an extension on a library type still links', async () => {
    write('lib/ext.dart', `extension Slug on String { String slugify() => this; }
`);
    write('lib/use.dart', `class Use { String run(String title) { String t = title; return t.slugify(); } }
`);
    const calls = await load();
    expect(callsFrom(calls, 'run')).toEqual(['Slug::slugify']);
  });
});

describe('the name guess needs a receiver it can read', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guess-recv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  // Index once, then list each named caller's method targets.
  const indexCalls = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const rows: { src: string; tgtQn: string }[] = (cg as any).db.db
      .prepare(
        `SELECT s.name src, t.qualified_name tgtQn FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls' AND t.kind = 'method'`,
      )
      .all();
    cg.close?.();
    return (src: string) => rows.filter((r) => r.src === src).map((r) => r.tgtQn);
  };
  const callsFrom = async (src: string) => (await indexCalls())(src);

  const frame = `namespace App {
  public class Frame { public static void Write(byte[] b) { } }
}
`;

  it('C#: a static call on a library class does not link', async () => {
    write('Frame.cs', frame);
    write('Bridge.cs', `namespace App {
  public class Bridge { static int last; static void Pump() { System.Threading.Volatile.Write(ref last, 1); Volatile.Write(ref last, 2); } }
}
`);
    expect(await callsFrom('Pump')).toEqual([]);
  });

  it('C#: a call on a property chain does not link', async () => {
    write('Frame.cs', frame);
    write('Server.cs', `namespace App {
  public class Server { static void Reply(HttpListenerContext context, byte[] bytes) { context.Response.OutputStream.Write(bytes, 0, bytes.Length); } }
}
`);
    expect(await callsFrom('Reply')).toEqual([]);
  });

  it('C#: base.M() inside an override does not link the method to itself', async () => {
    write('Settings.cs', `namespace App {
  public class Settings : ModSettings { public override void ExposeData() { base.ExposeData(); } }
}
`);
    expect(await callsFrom('ExposeData')).toEqual([]);
  });

  it('Java: super.m() still links to a parent method the class does not override', async () => {
    write('src/Base.java', `public class Base { protected void helper() { } }
`);
    write('src/Child.java', `public class Child extends Base { void run() { super.helper(); } }
`);
    expect(await callsFrom('run')).toEqual(['Base::helper']);
  });

  it('Java: a static method on a project enum and a chain rooted at a project type still link', async () => {
    write('src/Policy.java', `public enum Policy {
  UPPER;
  static String separate(String s) { return s; }
  Style style() { return null; }
}
`);
    write('src/Style.java', `public class Style {
  public static final Style COMPACT = new Style();
  public Style withNewline(String s) { return this; }
}
`);
    write('src/Use.java', `public class Use {
  String a() { return Policy.separate("x"); }
  Style b() { return Style.COMPACT.withNewline(""); }
}
`);
    const from = await indexCalls();
    expect(from('a')).toEqual(['Policy::separate']);
    expect(from('b')).toEqual(['Style::withNewline']);
  });
});
