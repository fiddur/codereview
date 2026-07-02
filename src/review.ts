import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullRequestEvent } from './webhook.ts';
import { AbortedError, runClaudeWithRetry, runStep } from './run.ts';

export { isAbortedError } from './run.ts';

export type ReviewConfig = {
  workBase: string;
  ghBin: string;
  claudeBin: string;
  mcpConfig: string;
};

const ALLOWED_TOOLS = [
  'Bash(gh:*)',
  'Bash(git:*)',
  'Read',
  'Grep',
  'Glob',
  'Write(./.review.json)',
].join(' ');

const REVIEW_FILE = '.review.json';

function buildPrompt(event: PullRequestEvent): string {
  const { repository, number, pull_request } = event;
  return `You are reviewing pull request ${repository.full_name}#${number}.

Title: ${pull_request.title}
URL: ${pull_request.html_url}
Head SHA: ${pull_request.head.sha}
Base branch: ${pull_request.base.ref}
Head branch: ${pull_request.head.ref}

The PR head is already checked out (detached) in your current working directory, and \`origin/${pull_request.base.ref}\` is up to date. Review according to the code standards in this project's CLAUDE.md / AGENTS.md files and any in parent directories (e.g. /home/fiddur/src/CLAUDE.md).

Steps:
1. Run \`git diff origin/${pull_request.base.ref}...HEAD\` and inspect changed files as needed.
2. Identify issues that matter: bugs, security problems, correctness errors, broken tests, and clear violations of the documented code standards. Skip nitpicks and personal style preferences not in the standards.
3. **Before writing any inline comment**, run \`git diff origin/${pull_request.base.ref}...HEAD --unified=0\` once and treat its output as the authoritative catalog of anchorable lines:
   - Each \`+\` line is anchorable with \`side: "RIGHT"\` and \`line\` = that line's number in the head file.
   - Each \`-\` line is anchorable with \`side: "LEFT"\` and \`line\` = that line's number in the base file.
   - Lines that aren't shown as \`+\` or \`-\` in this output are NOT anchorable (no context, since \`--unified=0\`). To anchor on context, you'd have to re-run with a wider \`--unified=N\`, but you almost never need that — if a remark isn't about an actually-changed line, put it in \`summary\` instead.
   - When you pick a line number for a comment, copy it directly from the \`@@\` hunk header math or from the \`+\`/\`-\` line you actually see in this diff output. Do NOT infer line numbers by opening the file and counting — file line numbers and diff line numbers diverge across edits.
   - After drafting \`comments\`, do one self-check pass: for each comment, locate the matching \`+\`/\`-\` line in the \`--unified=0\` output. If you can't, drop the comment or move its content to \`summary\` before writing the file. A single bad anchor causes GitHub to reject the WHOLE review (HTTP 422) and the server then has to fold every comment into the summary.
4. Write the review to \`./${REVIEW_FILE}\` (JSON) with this exact schema:

   {
     "verdict": "approved" | "changes_required",
     "summary": "<markdown overall summary>",
     "comments": [
       {
         "path": "src/foo.ts",
         "line": 42,
         "side": "RIGHT",
         "body": "<short focused comment about THIS line>"
       }
     ]
   }

   - \`verdict\`: "approved" if there are no blocking issues, "changes_required" otherwise.
   - \`summary\`: overall review in markdown. A few sentences to a few short paragraphs. The server prepends the verdict marker — do NOT include it here.
   - \`comments\` (optional): inline comments anchored to specific lines. STRICT rules — GitHub rejects the whole review (HTTP 422) if any comment violates them:
       - \`path\` must be a file that appears in the PR diff. Files NOT in the diff (even if they exist in the repo) cannot be commented on — put remarks about unchanged files in \`summary\` instead.
       - \`line\` must be a line that appears in a diff hunk for that file: a \`+\` line (added/modified), a \`-\` line (deleted), or a context line that's shown inside a hunk window. Lines OUTSIDE the diff hunks cannot be commented on — put those remarks in \`summary\` instead.
       - For \`+\` and context lines, use \`"side": "RIGHT"\` (the default) and \`line\` = the line number in the head/new file.
       - For \`-\` lines, use \`"side": "LEFT"\` and \`line\` = the line number in the base/old file.
       - For multi-line comments add \`"start_line"\` and matching \`"start_side"\`.
       - If you're unsure whether a line is in the diff, put the remark in \`summary\` instead. Prefer fewer reliable inline comments over many uncertain ones.
   - Omit \`comments\` (or pass \`[]\`) if there's nothing line-specific to flag.

4. Do NOT call \`gh pr review\` yourself — the server posts the review after you exit. Just exit cleanly after writing the JSON.`;
}

type ReviewComment = {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
};

export type ReviewChecklistItem = {
  index: number;
  checked: boolean;
  evidence: string;
};

export type ReviewFile = {
  verdict: 'approved' | 'changes_required';
  summary: string;
  comments?: ReviewComment[];
  checklist?: ReviewChecklistItem[];
};

export function parseReviewFile(raw: string): ReviewFile {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null) throw new Error('review file must be a JSON object');
  const r = v as Record<string, unknown>;
  if (r.verdict !== 'approved' && r.verdict !== 'changes_required') {
    throw new Error('verdict must be "approved" or "changes_required"');
  }
  if (typeof r.summary !== 'string') throw new Error('summary must be a string');
  const out: ReviewFile = { verdict: r.verdict, summary: r.summary };
  if (r.comments !== undefined) {
    if (!Array.isArray(r.comments)) throw new Error('comments must be an array');
    out.comments = r.comments.map((c, i) => parseComment(c, i));
  }
  if (r.checklist !== undefined) {
    if (!Array.isArray(r.checklist)) throw new Error('checklist must be an array');
    out.checklist = r.checklist.map((c, i) => parseChecklistItem(c, i));
  }
  return out;
}

function parseChecklistItem(c: unknown, i: number): ReviewChecklistItem {
  if (typeof c !== 'object' || c === null) throw new Error(`checklist[${i}] must be an object`);
  const o = c as Record<string, unknown>;
  if (typeof o.index !== 'number' || !Number.isInteger(o.index)) {
    throw new Error(`checklist[${i}].index must be an integer`);
  }
  if (typeof o.checked !== 'boolean') throw new Error(`checklist[${i}].checked must be a boolean`);
  if (typeof o.evidence !== 'string') throw new Error(`checklist[${i}].evidence must be a string`);
  return { index: o.index, checked: o.checked, evidence: o.evidence };
}

function parseComment(c: unknown, i: number): ReviewComment {
  if (typeof c !== 'object' || c === null) throw new Error(`comments[${i}] must be an object`);
  const o = c as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new Error(`comments[${i}].path must be a string`);
  if (typeof o.line !== 'number' || !Number.isInteger(o.line)) {
    throw new Error(`comments[${i}].line must be an integer`);
  }
  if (typeof o.body !== 'string') throw new Error(`comments[${i}].body must be a string`);
  const out: ReviewComment = { path: o.path, line: o.line, body: o.body };
  if (o.side !== undefined) {
    if (o.side !== 'LEFT' && o.side !== 'RIGHT') throw new Error(`comments[${i}].side must be LEFT or RIGHT`);
    out.side = o.side;
  }
  if (o.start_line !== undefined) {
    if (typeof o.start_line !== 'number' || !Number.isInteger(o.start_line)) {
      throw new Error(`comments[${i}].start_line must be an integer`);
    }
    out.start_line = o.start_line;
  }
  if (o.start_side !== undefined) {
    if (o.start_side !== 'LEFT' && o.start_side !== 'RIGHT') {
      throw new Error(`comments[${i}].start_side must be LEFT or RIGHT`);
    }
    out.start_side = o.start_side;
  }
  return out;
}

function buildReviewBody(review: ReviewFile): string {
  const verdictLine = review.verdict === 'approved' ? '✅ Approved' : '🛑 Changes required';
  const summary = review.summary.trim();
  return summary ? `${verdictLine}\n\n${summary}` : verdictLine;
}

function postReviewOnce(
  repo: string,
  number: number,
  headSha: string,
  body: string,
  comments: ReviewComment[],
  ghBin: string,
  tag: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = { commit_id: headSha, event: 'COMMENT' as const, body, comments };
    const child = spawn(
      ghBin,
      ['api', '-X', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
    );
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) =>
      console.log(`[${tag}] post-review: ${d.toString().trimEnd()}`),
    );
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      console.error(`[${tag}] post-review: ${s.trimEnd()}`);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh api review post failed (code ${code}): ${stderr.trim()}`));
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

function renderOrphanedComments(comments: ReviewComment[]): string {
  const lines: string[] = ['---', '', '_The following inline notes couldn\'t be anchored to the diff and are included here instead:_', ''];
  for (const c of comments) {
    const range = c.start_line !== undefined && c.start_line !== c.line
      ? `lines ${c.start_line}–${c.line}`
      : `line ${c.line}`;
    const side = c.side === 'LEFT' ? ' (base)' : '';
    lines.push(`**\`${c.path}\` ${range}${side}:**`);
    for (const bodyLine of c.body.split('\n')) lines.push(`> ${bodyLine}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export async function postReview(
  repo: string,
  number: number,
  headSha: string,
  review: ReviewFile,
  ghBin: string,
  tag: string,
): Promise<void> {
  const body = buildReviewBody(review);
  const comments = review.comments ?? [];
  try {
    await postReviewOnce(repo, number, headSha, body, comments, ghBin, tag);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeAnchorProblem = /Unprocessable|could not be resolved|422/i.test(msg);
    if (comments.length === 0 || !looksLikeAnchorProblem) throw err;
    console.warn(
      `[${tag}] inline comments rejected (${comments.length}) — folding them into the summary and retrying`,
    );
    const bodyWithComments = `${body}\n\n${renderOrphanedComments(comments)}`;
    await postReviewOnce(repo, number, headSha, bodyWithComments, [], ghBin, tag);
  }
}

const repoLocks = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve<unknown>(undefined);
  const next = prev.then(() => fn(), () => fn());
  repoLocks.set(repo, next.catch(() => undefined));
  return next;
}

async function ensureBaseRepo(
  repo: string,
  baseDir: string,
  ghBin: string,
  tag: string,
): Promise<void> {
  // Bare repos have HEAD at the root (no .git/ subdir).
  if (existsSync(join(baseDir, 'HEAD'))) return;
  await rm(baseDir, { recursive: true, force: true });
  await mkdir(join(baseDir, '..'), { recursive: true });
  await runStep(
    {
      cmd: ghBin,
      args: ['repo', 'clone', repo, baseDir, '--', '--bare', '--filter=blob:none', '--no-tags'],
    },
    tag,
  );
  await runStep(
    {
      cmd: 'git',
      args: ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      cwd: baseDir,
    },
    tag,
  );
}

async function fetchRefs(
  baseDir: string,
  prNumber: number,
  baseRef: string,
  tag: string,
): Promise<void> {
  await runStep(
    {
      cmd: 'git',
      args: [
        'fetch', '--no-tags', '--force', 'origin',
        `+refs/pull/${prNumber}/head:refs/pr/${prNumber}`,
        `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
      ],
      cwd: baseDir,
    },
    tag,
  );
}

async function prepareWorktree(
  baseDir: string,
  workdir: string,
  prNumber: number,
  tag: string,
): Promise<void> {
  await runStep(
    { cmd: 'git', args: ['worktree', 'remove', '--force', workdir], cwd: baseDir },
    tag,
  ).catch(() => undefined);
  await rm(workdir, { recursive: true, force: true });
  await mkdir(join(workdir, '..'), { recursive: true });
  await runStep(
    {
      cmd: 'git',
      args: ['worktree', 'add', '--detach', '--force', workdir, `refs/pr/${prNumber}`],
      cwd: baseDir,
    },
    tag,
  );
}

async function cleanupWorktree(baseDir: string, workdir: string, tag: string): Promise<void> {
  await runStep(
    { cmd: 'git', args: ['worktree', 'remove', '--force', workdir], cwd: baseDir },
    tag,
  ).catch(() => undefined);
  await rm(workdir, { recursive: true, force: true });
}

export async function reviewPR(
  event: PullRequestEvent,
  config: ReviewConfig,
  signal?: AbortSignal,
): Promise<void> {
  const tag = `${event.repository.full_name}#${event.number}`;
  const safeRepo = event.repository.full_name.replace(/\//g, '-');
  const baseDir = join(config.workBase, 'repos', `${safeRepo}.git`);
  const workdir = join(config.workBase, 'wt', `${safeRepo}-pr${event.number}`);

  console.log(`🤖 [${tag}] starting review at SHA ${event.pull_request.head.sha} in ${workdir}`);

  await withRepoLock(event.repository.full_name, async () => {
    await ensureBaseRepo(event.repository.full_name, baseDir, config.ghBin, tag);
    await fetchRefs(baseDir, event.number, event.pull_request.base.ref, tag);
    await prepareWorktree(baseDir, workdir, event.number, tag);
  });

  try {
    await runClaudeWithRetry(
      {
        cmd: config.claudeBin,
        args: [
          '-p', buildPrompt(event),
          '--allowedTools', ALLOWED_TOOLS,
          '--mcp-config', config.mcpConfig,
          '--strict-mcp-config',
        ],
        cwd: workdir,
      },
      tag,
      signal,
    );

    if (signal?.aborted) throw new AbortedError();

    const reviewPath = join(workdir, REVIEW_FILE);
    let raw: string;
    try {
      raw = await readFile(reviewPath, 'utf8');
    } catch (err: unknown) {
      throw new Error(
        `claude did not write ${REVIEW_FILE}: ${(err as Error).message}`,
      );
    }
    const review = parseReviewFile(raw);
    console.log(
      `📝 [${tag}] posting review (verdict=${review.verdict}, comments=${review.comments?.length ?? 0})`,
    );
    await postReview(
      event.repository.full_name,
      event.number,
      event.pull_request.head.sha,
      review,
      config.ghBin,
      tag,
    );
  } finally {
    await withRepoLock(event.repository.full_name, () =>
      cleanupWorktree(baseDir, workdir, tag),
    );
  }

  console.log(`✅ [${tag}] review complete`);
}
