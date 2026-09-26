/**
 * RimWorld Framework Resolver
 *
 * A RimWorld mod wires its C# into the game through XML Defs, not through
 * code: `<tabWindowClass>RimIpc.MainTabWindow_Message</tabWindowClass>` is the
 * only place `MainTabWindow_Message` is ever named, and the game creates it by
 * reflection. Nothing in C# calls it, so the graph showed the class as unused
 * and a rename broke the mod with no error until the button was clicked.
 *
 * This resolver reads the Defs and links them to the C# classes they name:
 *  - each Def under `<Defs>` becomes a node named by its `<defName>` (or its
 *    `Name="…"` for an abstract parent), e.g. `MainButtonDef::RimIpcMessage`;
 *  - three places name a class, and each becomes a `references` edge from the
 *    Def (or from the file, outside any Def, e.g. in a Patch):
 *      an element whose tag ends in `Class`  `<thingClass>X</thingClass>`
 *      a `Class="…"` attribute               `<li Class="X">`
 *      the Def's own tag                     `<MyMod.MyDef>`
 *
 * A namespaced name links only to the C# class with that full name. A bare
 * name links only when one C# class has it. Vanilla classes (`Building`,
 * `PatchOperationAdd`, `ThingDef`) are not in the project and stay unlinked.
 * Class names in plain `<li>` text (`inspectorTabs`) and defName strings read
 * from C# (`DefDatabase<T>.GetNamed("X")`, `[DefOf]`) are not followed.
 */

import { Node } from '../../types';
import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import {
  FrameworkResolver,
  FrameworkExtractionResult,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types';

/** Every mod has `About/About.xml` with a `<ModMetaData>` root. */
const ABOUT_FILE = /(^|\/)About\/About\.xml$/i;

/** One XML tag: closing slash, name, attributes, self-closing slash. */
const TAG = /<(\/?)([\w.:-]+)((?:\s[^>]*?)?)(\/?)>/g;

/** A C# type name as XML writes it: `Building` or `RimIpc.MainTabWindow_Message`. */
const TYPE_NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

const CLASS_ATTR = /\bClass\s*=\s*["']([^"']+)["']/;
const NAME_ATTR = /\bName\s*=\s*["']([^"']+)["']/;

export const rimworldResolver: FrameworkResolver = {
  name: 'rimworld',
  languages: ['xml'],

  detect(context: ResolutionContext): boolean {
    return context
      .getAllFiles()
      .some((f) => ABOUT_FILE.test(f) && (context.readFile(f) ?? '').includes('<ModMetaData'));
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    return extractDefs(filePath, content);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'xml' || ref.referenceKind !== 'references') return null;
    if (!TYPE_NAME.test(ref.referenceName)) return null;
    const cls = findCSharpClass(ref.referenceName, context);
    if (!cls) return null;
    return { original: ref, targetNodeId: cls.id, confidence: 0.9, resolvedBy: 'framework' };
  },
};

/** Def nodes and class references for one XML file. */
function extractDefs(filePath: string, content: string): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const source = blankComments(content);
  const lineAt = lineFinder(source);
  // The MyBatis extractor makes this file node for every .xml file.
  const fileNodeId = generateNodeId(filePath, 'file', filePath, 1);

  let depth = 0;
  let rootIsDefs = false;
  let def: { tag: string; line: number; name: string | null; refs: [string, number][] } | null = null;

  const addRef = (name: string, line: number) => {
    const clean = name.trim();
    if (!TYPE_NAME.test(clean)) return;
    if (def) def.refs.push([clean, line]);
    else references.push(ref(fileNodeId, clean, line, filePath));
  };

  for (const m of source.matchAll(TAG)) {
    const [whole, closing, tag, attrs, selfClosing] = m;
    const line = lineAt(m.index!);

    if (closing) {
      depth--;
      if (def && depth === 1) {
        if (def.name) {
          const id = generateNodeId(filePath, 'constant', def.name, def.line);
          nodes.push({
            id,
            kind: 'constant',
            name: def.name,
            qualifiedName: `${def.tag}::${def.name}`,
            filePath,
            language: 'xml',
            startLine: def.line,
            endLine: line,
            startColumn: 0,
            endColumn: 0,
            updatedAt: Date.now(),
          });
          for (const [name, refLine] of def.refs) references.push(ref(id, name, refLine, filePath));
        } else {
          for (const [name, refLine] of def.refs) references.push(ref(fileNodeId, name, refLine, filePath));
        }
        def = null;
      }
      continue;
    }
    if (depth === 0) rootIsDefs = tag === 'Defs';
    if (depth === 1 && rootIsDefs) {
      def = { tag: tag!, line, name: attrs!.match(NAME_ATTR)?.[1] ?? null, refs: [] };
      if (tag!.includes('.')) addRef(tag!, line);
    }

    const classAttr = attrs!.match(CLASS_ATTR);
    if (classAttr) addRef(classAttr[1]!, line);

    if (!selfClosing) {
      const textEnd = source.indexOf('<', m.index! + whole!.length);
      const text = textEnd < 0 ? '' : source.slice(m.index! + whole!.length, textEnd);
      if (def && depth === 2 && tag === 'defName' && text.trim()) def.name = text.trim();
      if (tag!.endsWith('Class') && tag !== 'Class') addRef(text, line);
      depth++;
    }
  }

  return { nodes, references };
}

function ref(fromNodeId: string, referenceName: string, line: number, filePath: string): UnresolvedRef {
  return { fromNodeId, referenceName, referenceKind: 'references', line, column: 0, filePath, language: 'xml' };
}

/**
 * The C# class an XML type name points at. `A.B.C` must match the class's
 * full name; a bare `C` must be the only C# class named `C`.
 */
function findCSharpClass(typeName: string, context: ResolutionContext): Node | null {
  const simple = typeName.split('.').pop()!;
  const classes = context
    .getNodesByName(simple)
    .filter((n) => n.kind === 'class' && n.language === 'csharp');
  if (typeName.includes('.')) {
    return classes.find((n) => n.qualifiedName.replace(/::/g, '.') === typeName) ?? null;
  }
  return classes.length === 1 ? classes[0]! : null;
}

/** Replace `<!-- … -->` with spaces, keeping newlines so line numbers hold. */
function blankComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}

/** Returns a function that maps a character offset to a 1-based line. */
function lineFinder(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
