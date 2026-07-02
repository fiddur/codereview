import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullRequestEvent } from './webhook.ts';
import { AbortedError, isAbortedError, runClaudeWithRetry, runStep } from './run.ts';
import {
  ensureDemoToken,
  waitForDeployedCommit,
  waitForHealthy,
  type DeployedTryoutTarget,
  type TryoutConfig,
} from './tryout.ts';
import { parseReviewFile, postReview, type ReviewChecklistItem, type ReviewFile } from './review.ts';

const REVIEW_FILE = '.review.json';

type ParsedChecklistItem = { index: number; text: string };

const CHECKBOX_LINE_RE = /^(\s*[-*]\s+)\[([ xX])\](\s+.*)$/;

export function parseChecklistFromBody(body: string): ParsedChecklistItem[] {
  const items: ParsedChecklistItem[] = [];
  const lines = body.split('\n');
  let idx = 0;
  for (const line of lines) {
    const match = CHECKBOX_LINE_RE.exec(line);
    if (match) {
      items.push({ index: idx, text: (match[3] ?? '').trim() });
      idx++;
    }
  }
  return items;
}

export function applyChecklistToBody(body: string, decisions: ReviewChecklistItem[]): string {
  const byIndex = new Map(decisions.map((d) => [d.index, d.checked] as const));
  const lines = body.split('\n');
  let idx = 0;
  return lines
    .map((line) => {
      const match = CHECKBOX_LINE_RE.exec(line);
      if (!match) return line;
      const decided = byIndex.get(idx);
      idx++;
      if (decided === undefined) return line;
      return `${match[1] ?? ''}[${decided ? 'x' : ' '}]${match[3] ?? ''}`;
    })
    .join('\n');
}

const ALLOWED_TOOLS = [
  'Bash(gh:*)',
  'Bash(curl:*)',
  'Bash(jq:*)',
  'Bash(node:*)',
  'Bash(cat:*)',
  'Bash(ls:*)',
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
].join(' ');

const DISALLOWED_TOOLS = ['Agent', 'WebFetch', 'WebSearch'].join(' ');

function buildPrompt(
  event: PullRequestEvent,
  target: DeployedTryoutTarget,
  checklist: ParsedChecklistItem[],
  alreadyVerified: ReviewChecklistItem[],
): string {
  const { repository, number, pull_request } = event;
  const releaseNotes = pull_request.body?.trim() ?? '(no description)';
  const tokenPath = join(target.sharedDir, target.tokenFile);
  const statePath = join(target.sharedDir, 'state.json');
  const checklistLines = checklist.map((i) => {
    const prev = alreadyVerified.find((p) => p.index === i.index);
    const tag = prev ? (prev.checked ? ' ✓ already verified' : ' ✗ previously failed') : '';
    return `[${i.index}]${tag} ${i.text}`;
  });
  const resumeNote = alreadyVerified.length === 0
    ? ''
    : `\n\n**Resume from previous run**: a previous attempt verified ${alreadyVerified.filter(p => p.checked).length} of ${checklist.length} items (marked ✓ above). Their evidence is already in \`./${REVIEW_FILE}\`. Do NOT re-verify them — copy them verbatim into your output and focus on the unchecked items. The previously-failed items (✗) should be re-tried since the SHA may have changed since.`;
  const checklistSection = checklist.length === 0
    ? ''
    : `\n\n## Checklist (return decisions for each by index)\n\n${checklistLines.join('\n')}${resumeNote}\n\nFor each item, include an entry in \`.review.json\`'s \`checklist\` array:\n\n\`\`\`json\n{ "index": <N>, "checked": <bool>, "evidence": "<one-line proof of what you observed>" }\n\`\`\`\n\nThe server will tick the boxes in the PR body for items you mark \`checked: true\` (and untick ones you mark \`false\`, so a regression in a re-run will downgrade). Set \`verdict: "approved"\` only if every item is \`checked: true\`; any \`false\` means \`changes_required\`.\n\n**Write the file incrementally** — after each checklist item you complete, rewrite \`./${REVIEW_FILE}\` with all decisions so far. This keeps progress safe across timeouts: if you run out of time, the server posts what you've written; the next run resumes from there. Include items you haven't reached yet either by omitting them or marking them \`checked: false, evidence: "(not yet verified)"\`.`;
  return `You are verifying a RELEASE pull request before it ships to production.

PR: ${repository.full_name}#${number}  (head ${pull_request.head.ref} → base ${pull_request.base.ref})
Title: ${pull_request.title}
URL: ${pull_request.html_url}
Head SHA: ${pull_request.head.sha}

The preview deployment at ${target.baseUrl} is currently serving exactly this head SHA (the server polled ${target.versionEndpoint} before invoking you). The preview Supabase has been seeded with throwaway users for this run.

**Auth model**: \`${tokenPath}\` contains a magic-link URL (not a bearer token). Navigate puppeteer to that URL — the redirect chain logs the browser in and lands you on /auth/callback signed in. \`${statePath}\` is a JSON file with richer context: \`{ admin: { userId, email, actionLink }, test: { userId, email, actionLink } }\`. The test user is the default; switch to the admin link if you need to exercise /admin/* routes. For API-only checks, pull the Supabase JWT out of localStorage after the magic-link redirect and send it as Authorization: Bearer <jwt>.

## Release notes from the PR description

This is your test plan. Every claim here should be verifiable on the preview deployment.

"""
${releaseNotes}
"""

If the release notes are empty or just "merge main into prod" boilerplate, fail loudly: write \`./${REVIEW_FILE}\` with verdict "changes_required" and a summary that says the release PR has no notes to verify against — releases must describe what's in them.

## Verification

For each distinct feature/fix in the release notes:
1. Identify the specific observable behavior promised.
2. Drive it on the preview deployment (puppeteer for UI, fetch/curl for API).
3. Capture concrete evidence: a quoted response snippet, a described screenshot, or specific UI state.

If you find issues, the release should NOT ship. Use \`changes_required\` and describe each issue in the summary (and optionally as inline comments, though release PRs rarely have meaningful line anchors — summary is fine). Each blocking issue should also be filed as its own followup GitHub issue:

\`\`\`
gh issue create --repo ${repository.full_name} \\
  --label release-block \\
  --title "<short summary>" \\
  --body "$(cat <<'EOF'
Blocking release #${number}.

## Problem
<observed behavior with evidence>

## Expected
<what the release notes promised>

## Repro
<exact steps you took on ${target.baseUrl}>
EOF
)"
\`\`\`

When all items in the release notes verify cleanly, write the review with verdict "approved" and a summary listing each item with one-line evidence. Otherwise write "changes_required" with the blocking issues.

## Output

Write the review to \`./${REVIEW_FILE}\` (JSON):

\`\`\`json
{
  "verdict": "approved" | "changes_required",
  "summary": "<markdown summary, one bullet per release-notes item with evidence>",
  "comments": [],
  "checklist": [ /* see Checklist section above */ ]
}
\`\`\`

Do NOT call \`gh pr review\` or \`gh pr edit\` yourself — the server posts the review and updates the PR body's checkboxes after you exit.${checklistSection}

Verification is successful ONLY if all three hold for every release-notes item:
1. You can name the specific observable behavior.
2. You executed an API call or puppeteer interaction that exercises it.
3. You can quote the response/screenshot evidence.
"200 OK" or "page rendered" alone is NOT sufficient.`;
}

async function readExistingReview(reviewPath: string): Promise<ReviewFile | null> {
  try {
    const raw = await readFile(reviewPath, 'utf8');
    return parseReviewFile(raw);
  } catch {
    return null;
  }
}

function annotateInterrupted(review: ReviewFile, totalItems: number): ReviewFile {
  const checkedItems = review.checklist?.filter((c) => c.checked).length ?? 0;
  const note = `_(release tryout interrupted — ${checkedItems}/${totalItems} items verified so far. Re-trigger the release tryout to resume on the remaining items.)_`;
  return {
    ...review,
    verdict: 'changes_required',
    summary: `${review.summary.trim()}\n\n${note}`,
  };
}

export async function releaseTryoutPR(
  event: PullRequestEvent,
  target: DeployedTryoutTarget,
  config: TryoutConfig,
  signal?: AbortSignal,
): Promise<void> {
  const tag = `release-tryout ${event.repository.full_name}#${event.number}`;
  const runDir = join(config.runsBase, `${target.appName}-release-pr${event.number}`);
  const reviewPath = join(runDir, REVIEW_FILE);

  console.log(`🚀 [${tag}] starting release tryout for "${event.pull_request.title}"`);

  // Preserve runDir across attempts so claude can resume from .review.json,
  // reuse its puppeteer scripts/node_modules, and accumulate shots/. Only
  // create what's missing.
  await mkdir(join(runDir, 'shots'), { recursive: true });

  await waitForDeployedCommit(target, event.pull_request.head.sha, tag, signal);
  if (signal?.aborted) throw new AbortedError();
  await waitForHealthy(target, tag);

  const token = await ensureDemoToken(target, tag);
  // token is captured but the spawned claude reads token.txt/state.json directly;
  // no MCP config for release tryouts (magic-link auth, not bearer).
  void token;

  const releaseBody = event.pull_request.body ?? '';
  const checklist = parseChecklistFromBody(releaseBody);
  console.log(`[${tag}] parsed ${checklist.length} checklist item(s) from PR body`);

  const previous = await readExistingReview(reviewPath);
  const previousItems = previous?.checklist ?? [];
  if (previousItems.length > 0) {
    const prevChecked = previousItems.filter((p) => p.checked).length;
    console.log(`[${tag}] resuming with ${prevChecked}/${checklist.length} items already verified`);
  }

  const prompt = buildPrompt(event, target, checklist, previousItems);

  const timeoutDuration = target.releaseTimeoutDuration ?? '30m';

  let interrupted = false;
  try {
    await runClaudeWithRetry(
      {
        cmd: config.timeoutBin,
        args: [
          timeoutDuration,
          config.claudeBin,
          '-p', prompt,
          '--allowedTools', ALLOWED_TOOLS,
          '--disallowedTools', DISALLOWED_TOOLS,
          '--mcp-config', config.mcpConfigFallback,
          '--strict-mcp-config',
        ],
        cwd: runDir,
      },
      tag,
      signal,
    );
  } catch (err: unknown) {
    if (isAbortedError(err) || signal?.aborted) throw err;
    interrupted = true;
    console.warn(`[${tag}] claude exited non-zero (${(err as Error).message}) — looking for partial .review.json`);
  }

  if (signal?.aborted) throw new AbortedError();

  let rawReview: ReviewFile | null;
  try {
    const raw = await readFile(reviewPath, 'utf8');
    rawReview = parseReviewFile(raw);
  } catch (err: unknown) {
    if (interrupted) {
      // No partial review at all — surface the failure, don't post anything.
      throw new Error(`claude exited without writing ${REVIEW_FILE}: ${(err as Error).message}`);
    }
    throw new Error(`claude did not write ${REVIEW_FILE}: ${(err as Error).message}`);
  }

  const review = interrupted ? annotateInterrupted(rawReview, checklist.length) : rawReview;

  if (review.checklist && review.checklist.length > 0 && checklist.length > 0) {
    const updatedBody = applyChecklistToBody(releaseBody, review.checklist);
    if (updatedBody !== releaseBody) {
      const bodyPath = join(runDir, '.updated-pr-body.md');
      await writeFile(bodyPath, updatedBody);
      const checkedCount = review.checklist.filter((c) => c.checked).length;
      console.log(
        `📝 [${tag}] updating PR body checkboxes (${checkedCount}/${checklist.length} checked)`,
      );
      await runStep(
        {
          cmd: config.ghBin,
          args: [
            'pr', 'edit', String(event.number),
            '--repo', event.repository.full_name,
            '--body-file', bodyPath,
          ],
        },
        tag,
      );
    } else {
      console.log(`[${tag}] no checkbox changes to apply`);
    }
  }

  console.log(
    `📝 [${tag}] posting release review (verdict=${review.verdict}, comments=${review.comments?.length ?? 0}${interrupted ? ', interrupted' : ''})`,
  );
  await postReview(
    event.repository.full_name,
    event.number,
    event.pull_request.head.sha,
    review,
    config.ghBin,
    tag,
  );

  console.log(`${interrupted ? '⚠️' : '✅'} [${tag}] release tryout ${interrupted ? 'partial (resume on next trigger)' : 'complete'}`);
}
