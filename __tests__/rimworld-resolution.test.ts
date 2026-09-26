/**
 * RimWorld XML Def → C# class links.
 *
 * A mod names its C# classes only in XML (`<tabWindowClass>`, `<li Class>`,
 * a custom Def's own tag); the game creates them by reflection, so nothing in
 * C# calls them. The `rimworld` framework resolver turns each Def into a node
 * and links it to the classes it names. These tests run the full `indexAll()`
 * path, and the negative cases pin that vanilla classes, a wrong namespace,
 * and non-RimWorld projects link nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('RimWorld XML Def resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimworld-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  // Every `references` edge from an XML node to a C# node: source name → target qualified name.
  const xmlLinks = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const rows: { src: string; srcKind: string; tgtQn: string }[] = (cg as any).db.db
      .prepare(
        `SELECT s.name src, s.kind srcKind, t.qualified_name tgtQn FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references' AND s.language = 'xml' AND t.language = 'csharp'`,
      )
      .all();
    cg.close?.();
    return rows;
  };

  const about = `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData><packageId>me.mod</packageId></ModMetaData>
`;
  const csharp = `namespace MyMod {
  public class MainTabWindow_Panel { }
  public class CompProperties_Glow { }
  public class Building_Lamp { }
  public class LampDef { }
}
`;

  it('links a Def to the classes it names, and a Patch file to its Class attribute', async () => {
    write('About/About.xml', about);
    write('Source/Mod.cs', csharp);
    write('Defs/Defs.xml', `<?xml version="1.0" encoding="utf-8"?>
<Defs>
  <!-- <MainButtonDef><defName>Old</defName><tabWindowClass>MyMod.Building_Lamp</tabWindowClass></MainButtonDef> -->
  <MainButtonDef>
    <defName>Panel</defName>
    <tabWindowClass>MyMod.MainTabWindow_Panel</tabWindowClass>
  </MainButtonDef>
  <MyMod.LampDef>
    <defName>Lamp</defName>
    <thingClass>Building_Lamp</thingClass>
    <comps>
      <li Class="MyMod.CompProperties_Glow" />
      <li Class="CompProperties_Power" />
    </comps>
  </MyMod.LampDef>
</Defs>
`);
    write('Patches/Patch.xml', `<Patch>
  <Operation Class="PatchOperationAdd">
    <value><li Class="MyMod.CompProperties_Glow"/></value>
  </Operation>
</Patch>
`);
    const links = await xmlLinks();
    const pairs = links.map((l) => `${l.src} -> ${l.tgtQn}`).sort();
    expect(pairs).toEqual([
      'Lamp -> MyMod::Building_Lamp',
      'Lamp -> MyMod::CompProperties_Glow',
      'Lamp -> MyMod::LampDef',
      'Panel -> MyMod::MainTabWindow_Panel',
      'Patch.xml -> MyMod::CompProperties_Glow',
    ]);
    expect(links.find((l) => l.src === 'Panel')!.srcKind).toBe('constant');
  });

  it('links nothing when the namespace does not match or a bare name is shared', async () => {
    write('About/About.xml', about);
    write('Source/Mod.cs', csharp);
    write('Source/Other.cs', `namespace Other { public class Building_Lamp { } }
`);
    write('Defs/Defs.xml', `<Defs>
  <MainButtonDef><defName>Panel</defName><tabWindowClass>Wrong.MainTabWindow_Panel</tabWindowClass></MainButtonDef>
  <ThingDef><defName>Lamp</defName><thingClass>Building_Lamp</thingClass></ThingDef>
</Defs>
`);
    expect(await xmlLinks()).toEqual([]);
  });

  it('does nothing outside a RimWorld mod', async () => {
    write('Source/Mod.cs', csharp);
    write('Defs/Defs.xml', `<Defs>
  <MainButtonDef><defName>Panel</defName><tabWindowClass>MyMod.MainTabWindow_Panel</tabWindowClass></MainButtonDef>
</Defs>
`);
    expect(await xmlLinks()).toEqual([]);
  });
});
