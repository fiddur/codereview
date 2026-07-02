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
