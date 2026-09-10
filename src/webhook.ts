import { createHmac, timingSafeEqual } from 'node:crypto';

export type PullRequestEvent = {
  action: string;
  number: number;
  pull_request: {
    html_url: string;
    title: string;
    body: string | null;
    draft: boolean;
    merged: boolean;
    merge_commit_sha: string | null;
    head: { sha: string; ref: string };
    base: { ref: string };
    user: { login: string; type: string };
  };
  repository: {
    full_name: string;
    clone_url: string;
  };
};

export function isPullRequestEvent(payload: unknown): payload is PullRequestEvent {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.action !== 'string') return false;
  if (typeof p.number !== 'number') return false;
  const pr = p.pull_request;
  if (typeof pr !== 'object' || pr === null) return false;
  const prr = pr as Record<string, unknown>;
  if (typeof prr.html_url !== 'string') return false;
  if (typeof prr.title !== 'string') return false;
  if (typeof prr.draft !== 'boolean') return false;
  if (typeof prr.merged !== 'boolean') return false;
  if (prr.body !== null && typeof prr.body !== 'string') return false;
  if (prr.merge_commit_sha !== null && typeof prr.merge_commit_sha !== 'string') return false;
  const head = prr.head, base = prr.base, user = prr.user;
  if (typeof head !== 'object' || head === null) return false;
  if (typeof base !== 'object' || base === null) return false;
  if (typeof user !== 'object' || user === null) return false;
  const h = head as Record<string, unknown>, b = base as Record<string, unknown>, u = user as Record<string, unknown>;
  if (typeof h.sha !== 'string' || typeof h.ref !== 'string') return false;
  if (typeof b.ref !== 'string') return false;
  if (typeof u.login !== 'string' || typeof u.type !== 'string') return false;
  const repo = p.repository;
  if (typeof repo !== 'object' || repo === null) return false;
  const r = repo as Record<string, unknown>;
  if (typeof r.full_name !== 'string' || typeof r.clone_url !== 'string') return false;
  return true;
}

export const REVIEW_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

export function shouldReview(event: PullRequestEvent): boolean {
  return reviewSkipReason(event) === null;
}

export function reviewSkipReason(event: PullRequestEvent): string | null {
  if (!REVIEW_ACTIONS.has(event.action)) return `action=${event.action}`;
  if (event.pull_request.draft && event.action !== 'ready_for_review') return 'draft';
  if (event.pull_request.user.type === 'Bot') return 'bot author';
  return null;
}

export const DEFAULT_TRYOUT_BRANCHES = ['develop'];

export function shouldTryout(event: PullRequestEvent): boolean {
  if (event.action !== 'closed') return false;
  if (!event.pull_request.merged) return false;
  return true;
}

export function verifySignature(body: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Issue comments — the self-service trigger for resuming an interrupted
// release tryout.
//
// A release tryout that hits its timeout ceiling posts a partial review saying
// how to resume. Before this, nothing could act on that sentence except a human
// running retrigger.mjs, so an interrupted run sat parked. A PR comment is a
// channel the coding agent already has (`gh pr comment`), so it can pull the
// trigger itself.

export type IssueCommentEvent = {
  action: string;
  issue: { number: number; pull_request?: { url: string } | null };
  comment: {
    id: number;
    body: string;
    user: { login: string; type: string };
    author_association: string;
  };
  repository: { full_name: string; clone_url: string };
};

export function isIssueCommentEvent(payload: unknown): payload is IssueCommentEvent {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.action !== 'string') return false;
  const issue = p.issue;
  if (typeof issue !== 'object' || issue === null) return false;
  const i = issue as Record<string, unknown>;
  if (typeof i.number !== 'number') return false;
  // `pull_request` is present only when the issue is really a PR. Absent is a
  // normal payload (a plain issue comment), not a malformed one — validate it
  // only when it's there.
  if (i.pull_request !== undefined && i.pull_request !== null) {
    if (typeof i.pull_request !== 'object') return false;
  }
  const comment = p.comment;
  if (typeof comment !== 'object' || comment === null) return false;
  const c = comment as Record<string, unknown>;
  if (typeof c.id !== 'number') return false;
  if (typeof c.body !== 'string') return false;
  if (typeof c.author_association !== 'string') return false;
  const user = c.user;
  if (typeof user !== 'object' || user === null) return false;
  const u = user as Record<string, unknown>;
  if (typeof u.login !== 'string' || typeof u.type !== 'string') return false;
  const repo = p.repository;
  if (typeof repo !== 'object' || repo === null) return false;
  const r = repo as Record<string, unknown>;
  if (typeof r.full_name !== 'string' || typeof r.clone_url !== 'string') return false;
  return true;
}

export const RESUME_PHRASE = 'continue tryout';

// Who may pull the trigger. GitHub sends author_association on every issue
// comment, so gating on it costs no extra API call.
const RESUME_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Markdown decoration to ignore around the phrase, so `Continue tryout` and
// **Continue tryout** both count.
const DECORATION_RE = /^[`*_\s]+|[`*_\s]+$/g;

// The phrase must be a line of its own. A substring match would fire on a
// comment that merely *mentions* the phrase ("add a comment with `Continue
// tryout` when CI is green"), which is exactly the sentence the resume
// instructions are written in.
export function hasResumePhrase(body: string): boolean {
  return body
    .split('\n')
    .some((line) => line.replace(DECORATION_RE, '').toLowerCase() === RESUME_PHRASE);
}

export function resumeSkipReason(event: IssueCommentEvent): string | null {
  if (event.action !== 'created') return `action=${event.action}`;
  if (!event.issue.pull_request) return 'not a pull request';
  if (event.comment.user.type === 'Bot') return 'bot author';
  if (!RESUME_ASSOCIATIONS.has(event.comment.author_association)) {
    return `author_association=${event.comment.author_association}`;
  }
  if (!hasResumePhrase(event.comment.body)) return 'no resume phrase';
  return null;
}

export function isResumeComment(event: IssueCommentEvent): boolean {
  return resumeSkipReason(event) === null;
}
