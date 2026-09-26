/**
 * CodeIgniter Framework Resolver
 *
 * CodeIgniter never declares the properties its loader creates:
 * `$this->load->model('attendance_day_model')` assigns a new
 * `Attendance_day_model` to `$this->attendance_day_model` at runtime, and the
 * same goes for `load->library('gate_log')` → `Gate_log`. The declared-type
 * inference in the name-matcher has nothing to read, so every
 * `$this->some_model->method()` call (encoded `this->some_model.method`) was
 * left unlinked — in a CodeIgniter app that is most of the cross-file calls.
 *
 * The loader's own naming rule closes the gap: the property name is the
 * model/library name as passed, and the class is that name with its first
 * letter upper-cased. PHP class names are case-insensitive, so the property
 * maps to the class whose name matches it ignoring case. Aliased loads
 * (`load->model('x', 'alias')`) are not followed.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/** `$this->prop->method()` as the PHP extractor encodes it. */
const PROP_CALL = /^this->(\w+)\.(\w+)$/;

/** Folders CodeIgniter apps keep controllers and models in. */
const CI_APP_FILE = /(^|\/)application\/(controllers|models)\/.+\.php$/;

/** A class that only a CodeIgniter app declares. */
const CI_BASE_CLASS = /\bextends\s+(CI|MY)_(Controller|Model)\b/;

/** How many app files `detect` reads before giving up. */
const DETECT_READ_LIMIT = 50;

export const codeigniterResolver: FrameworkResolver = {
  name: 'codeigniter',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('system/core/CodeIgniter.php')) return true;
    // An add-on or a partial checkout has no `system/`, so also accept an
    // `application/` controller or model that extends a CodeIgniter base class.
    // Zend 1 uses the same folder names, which is why the path alone is not enough.
    let read = 0;
    for (const file of context.getAllFiles()) {
      if (!CI_APP_FILE.test(file)) continue;
      const content = context.readFile(file);
      if (content && CI_BASE_CLASS.test(content)) return true;
      if (++read >= DETECT_READ_LIMIT) break;
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'calls') return null;
    const match = ref.referenceName.match(PROP_CALL);
    if (!match) return null;
    const [, propName, methodName] = match;

    const cls = findLoadedClass(propName!, ref.filePath, context);
    if (!cls) return null;

    const method = context
      .getNodesInFile(cls.filePath)
      .find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.endsWith(`${cls.name}::${methodName}`)
      );
    if (!method) return null;

    return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
  },
};

/**
 * The class CodeIgniter's loader would put on `$this-><propName>`: a PHP class
 * whose name and file name both match the property ignoring case (the loader
 * finds the class by file name). When several apps in one tree declare it, the
 * one sharing the longest path with the calling file wins; a tie links nothing.
 */
function findLoadedClass(propName: string, fromFile: string, context: ResolutionContext): Node | null {
  const lower = propName.toLowerCase();
  const classes = context
    .getNodesByLowerName(lower)
    .filter(
      (n) =>
        n.kind === 'class' &&
        n.language === 'php' &&
        (n.filePath.split('/').pop() ?? '').toLowerCase() === `${lower}.php`
    );
  if (classes.length <= 1) return classes[0] ?? null;

  const scored = classes
    .map((n) => ({ n, shared: sharedPrefixLength(n.filePath, fromFile) }))
    .sort((a, b) => b.shared - a.shared);
  return scored[0]!.shared > scored[1]!.shared ? scored[0]!.n : null;
}

/** Number of leading path segments two relative paths have in common. */
function sharedPrefixLength(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  return i;
}
