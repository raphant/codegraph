/**
 * `codegraph_feedback` — an agent reports where CodeGraph was wrong or missing
 * something, and the report lands as one Markdown file in a shared inbox that a
 * review team reads (fork feature; see the inbox's own CLAUDE.md for the review
 * rules).
 *
 * Inbox folder, first that exists:
 *   1. `CODEGRAPH_FEEDBACK_DIR`
 *   2. DEFAULT_FEEDBACK_DIR (absolute: agent runs can have a throwaway `$HOME`,
 *      and Paperclip starts MCP servers with only `PATH`)
 *   3. `<project>/.codegraph/feedback/` — so a report is never lost on a machine
 *      without the shared folder
 * New reports go in `<inbox>/inbox/`; the review team moves them to
 * `accepted/`, `rejected/`, `duplicate/` or `done/`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** Raphant's shared folder (Taildrive), reachable from every machine and agent. */
export const DEFAULT_FEEDBACK_DIR = '/home/raphant/shared/codegraph-inbox';

export const FEEDBACK_KINDS = [
  'missing-link',
  'wrong-link',
  'missing-symbol',
  'bad-explore',
  'error-or-slow',
  'idea',
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackReport {
  kind: FeedbackKind;
  summary: string;
  /** file:line spots or the command that showed the problem; optional only for `idea`. */
  evidence: string;
  symbol?: string;
  expected?: string;
  got?: string;
  reporter?: string;
}

/** Facts the tool collects itself so the review team can reproduce the report. */
export interface FeedbackContext {
  codegraphVersion: string;
  projectRoot?: string;
  projectCommit?: string;
  /** The graph's answer for `symbol` at report time, one line per caller. */
  graphAnswer?: string[];
  now?: Date;
}

/**
 * The folder whose `inbox/` gets new reports, or null when there is neither a
 * shared inbox nor a project to fall back to.
 */
export function feedbackInboxDir(projectRoot?: string): { dir: string; shared: boolean } | null {
  const configured = process.env.CODEGRAPH_FEEDBACK_DIR?.trim();
  if (configured) return { dir: configured, shared: true };
  if (fs.existsSync(DEFAULT_FEEDBACK_DIR)) return { dir: DEFAULT_FEEDBACK_DIR, shared: true };
  if (projectRoot) return { dir: path.join(projectRoot, '.codegraph', 'feedback'), shared: false };
  return null;
}

/** Write one report as `<dir>/inbox/YYYY-MM-DD-<kind>-<slug>-<id>.md`; returns the file path. */
export function writeFeedback(dir: string, report: FeedbackReport, context: FeedbackContext): string {
  const now = context.now ?? new Date();
  const id = crypto.randomBytes(3).toString('hex');
  const slug = (report.symbol || report.summary)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'report';
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, `${now.toISOString().slice(0, 10)}-${report.kind}-${slug}-${id}.md`);
  fs.writeFileSync(file, renderFeedback(id, report, context, now), { flag: 'wx' });
  return file;
}

export function renderFeedback(id: string, report: FeedbackReport, context: FeedbackContext, now: Date): string {
  const yaml = (v: string) => JSON.stringify(v);
  const front = [
    '---',
    `id: ${id}`,
    `kind: ${report.kind}`,
    `created: ${now.toISOString()}`,
    `codegraph: ${yaml(context.codegraphVersion)}`,
    context.projectRoot ? `project: ${yaml(context.projectRoot)}` : null,
    context.projectCommit ? `projectCommit: ${context.projectCommit}` : null,
    report.symbol ? `symbol: ${yaml(report.symbol)}` : null,
    report.reporter ? `reporter: ${yaml(report.reporter)}` : null,
    '---',
  ].filter((l): l is string => l !== null);
  const section = (title: string, body?: string) => (body?.trim() ? [`## ${title}`, '', body.trim(), ''] : []);
  const graph = context.graphAnswer
    ? [
        '## What the graph said',
        '',
        ...(context.graphAnswer.length ? context.graphAnswer.map((l) => `- ${l}`) : ['- (no callers)']),
        '',
      ]
    : [];
  return [
    ...front,
    '',
    `# ${report.summary.trim()}`,
    '',
    ...section('Evidence', report.evidence),
    ...section('Expected', report.expected),
    ...section('Got', report.got),
    ...graph,
  ].join('\n');
}
