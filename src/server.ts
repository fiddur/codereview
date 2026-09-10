import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIssueCommentEvent, isPullRequestEvent, resumeSkipReason, reviewSkipReason, shouldReview, shouldTryout, verifySignature, type PullRequestEvent } from './webhook.ts';
import { reviewPR, isAbortedError, type ReviewConfig } from './review.ts';
import { tryoutPR, type TryoutConfig, type TryoutTarget, type DeployedTryoutTarget } from './tryout.ts';
import { releaseTryoutPR } from './release.ts';
import { appendPrEvent } from './eventlog.ts';
import { errText, isSessionLimitError, isTransientApiFailure, redispatchDelayMs, REDISPATCH_DELAYS_MS, sessionLimitResetAt } from './run.ts';
import { createRecoveryScheduler } from './recovery.ts';
// Repo → tryout-target config lives in a gitignored local module (real infra
// details). Copy src/targets.example.ts to src/targets.local.ts and edit.
import { TRYOUT_TARGETS } from './targets.local.ts';

const PORT = Number(process.env.PORT ?? 6666);
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const HOST = process.env.HOST ?? '::';

// Append-only feed of PR review-lifecycle events. Sibling agents working in the
// repo clones tail -F this to replace GitHub polling: they see their PR's URL
// appear ("review started" / "updated") and pull the details from `gh`.
const EVENT_LOG = process.env.EVENT_LOG ?? '/home/fiddur/src/codereview/events.log';

const MCP_CONFIG = process.env.MCP_CONFIG ?? '/home/fiddur/src/codereview/empty-mcp.json';

const reviewConfig: ReviewConfig = {
  workBase: process.env.WORK_BASE ?? '/home/fiddur/src/codereview/work',
  ghBin: process.env.GH_BIN ?? 'gh',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  mcpConfig: MCP_CONFIG,
};

const tryoutConfig: TryoutConfig = {
  runsBase: process.env.TRYOUT_RUNS_BASE ?? '/home/fiddur/src/codereview/tryout/runs',
  ghBin: process.env.GH_BIN ?? 'gh',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  timeoutBin: process.env.TIMEOUT_BIN ?? '/usr/bin/timeout',
  timeoutDuration: process.env.TRYOUT_TIMEOUT ?? '30m',
  mcpConfigFallback: MCP_CONFIG,
};

// Auto-recovery for usage-limit failures: when a review/tryout dies on the
// account's session cap, we re-fire it just after the stated reset instead of
// losing it. `tryout:` keys are namespaced so a PR can hold both a review and a
// docker-tryout recovery independently.
const recovery = createRecoveryScheduler({ log: (m) => console.log(m) });
const tryoutRecoveryKey = (repo: string, number: number): string => `tryout:${repo}#${number}`;

type PRSlotKind = 'review' | 'release-tryout';
type PRSlot = {
  next: PullRequestEvent | null;
  controller: AbortController | null;
  kind: PRSlotKind;
  releaseTarget?: DeployedTryoutTarget;
};
const slots = new Map<string, PRSlot>();

// How many times a PR has already been re-dispatched after a transient API
// failure (see runPRChain). INVARIANT: this is cleared by a genuine webhook and
// by a successful run — never by schedulePR, which the re-dispatch itself calls.
// Clearing it there would reset the count on every retry and loop forever.
const transientAttempts = new Map<string, number>();

function clearTransientAttempts(key: string): void {
  transientAttempts.delete(key);
}

async function executeSlot(
  slot: PRSlot,
  event: PullRequestEvent,
  signal: AbortSignal,
): Promise<void> {
  if (slot.kind === 'release-tryout') {
    if (!slot.releaseTarget) throw new Error('release-tryout slot missing target');
    await releaseTryoutPR(event, slot.releaseTarget, tryoutConfig, signal);
  } else {
    await reviewPR(event, reviewConfig, signal);
  }
}

async function runPRChain(key: string, first: PullRequestEvent, slot: PRSlot): Promise<void> {
  let current: PullRequestEvent | null = first;
  const label = slot.kind === 'release-tryout' ? 'release tryout' : 'review';
  try {
    while (current) {
      const ev: PullRequestEvent = current;
      current = null;
      const controller = new AbortController();
      slot.controller = controller;
      const url = ev.pull_request.html_url;
      await appendPrEvent(EVENT_LOG, url, `${label} started`);
      try {
        await executeSlot(slot, ev, controller.signal);
        await appendPrEvent(EVENT_LOG, url, 'updated');
        clearTransientAttempts(key);
      } catch (err: unknown) {
        // Every branch must write a terminal event. Watchers block until one
        // arrives, so a failure that logged only to stdout was indistinguishable
        // from a still-running job and hung them indefinitely.
        if (isAbortedError(err)) {
          console.log(`🛑 [${key}] ${label} aborted (SHA ${ev.pull_request.head.sha} superseded)`);
          await appendPrEvent(EVENT_LOG, url, 'aborted');
        } else if (isSessionLimitError(err)) {
          scheduleRecovery(key, `${label} ${key}`, err, () =>
            schedulePR(key, ev, slot.kind, slot.releaseTarget),
          );
          await appendPrEvent(EVENT_LOG, url, 'failed (retry scheduled)');
        } else if (isTransientApiFailure(err)) {
          // run.ts already burned its in-process ladder (~2 minutes) on this.
          // A 529 storm that outlasts that used to fall through to a plain
          // `failed` and sit until a human re-fired it — weloveblueai#569 lost
          // ~90 minutes that way. Re-dispatch on a longer, bounded schedule.
          const attempt = transientAttempts.get(key) ?? 0;
          const delay = redispatchDelayMs(attempt);
          if (delay === null) {
            clearTransientAttempts(key);
            console.error(
              `💥 [${key}] ${label} failed (transient API, ${attempt} re-dispatches exhausted):`,
              err,
            );
            await appendPrEvent(EVENT_LOG, url, 'failed');
          } else {
            transientAttempts.set(key, attempt + 1);
            const at = new Date(Date.now() + delay);
            console.error(
              `💥 [${key}] ${label} failed (transient API) — re-dispatch ${attempt + 1}/${REDISPATCH_DELAYS_MS.length} at ${at.toISOString()}`,
            );
            recovery.record(key, at, `${label} ${key} (transient retry ${attempt + 1})`, () =>
              schedulePR(key, ev, slot.kind, slot.releaseTarget),
            );
            await appendPrEvent(EVENT_LOG, url, 'failed (retry scheduled)');
          }
        } else {
          console.error(`💥 [${key}] ${label} failed:`, err);
          await appendPrEvent(EVENT_LOG, url, 'failed');
        }
      } finally {
        slot.controller = null;
      }
      if (slot.next) {
        current = slot.next;
        slot.next = null;
        console.log(`🔁 [${key}] running queued ${label} for SHA ${current.pull_request.head.sha}`);
      }
    }
  } finally {
    slots.delete(key);
  }
}

// Record a usage-limit failure for auto-recovery, or log it plainly if the reset
// time can't be parsed (nothing to schedule against).
function scheduleRecovery(key: string, label: string, err: unknown, redispatch: () => void): void {
  const resetAt = sessionLimitResetAt(errText(err));
  if (resetAt === null) {
    console.error(`💥 [${key}] ${label} failed (usage limit, reset time unparsed):`, err);
    return;
  }
  console.error(`💥 [${key}] ${label} failed (usage limit) — auto-recovery at ${resetAt.toISOString()}`);
  recovery.record(key, resetAt, label, redispatch);
}

function schedulePR(
  key: string,
  event: PullRequestEvent,
  kind: PRSlotKind,
  releaseTarget?: DeployedTryoutTarget,
): void {
  // A fresh event supersedes any pending usage-limit recovery for this PR.
  recovery.cancel(key);
  const label = kind === 'release-tryout' ? 'release tryout' : 'review';
  const existing = slots.get(key);
  if (existing) {
    existing.next = event;
    if (existing.controller && !existing.controller.signal.aborted) {
      console.log(`⏳ [${key}] new SHA ${event.pull_request.head.sha} — aborting current ${label}`);
      existing.controller.abort();
    } else {
      console.log(`⏳ [${key}] queued ${label} for SHA ${event.pull_request.head.sha}`);
    }
    return;
  }
  const slot: PRSlot = { next: null, controller: null, kind, releaseTarget };
  slots.set(key, slot);
  void runPRChain(key, event, slot);
}

const tryoutQueues = new Map<string, Promise<unknown>>();

function scheduleTryout(event: PullRequestEvent, target: TryoutTarget): void {
  const repo = event.repository.full_name;
  const tag = `tryout ${repo}#${event.number}`;
  recovery.cancel(tryoutRecoveryKey(repo, event.number));
  const onFailure = (err: unknown): void => {
    const key = tryoutRecoveryKey(repo, event.number);
    if (isSessionLimitError(err)) {
      scheduleRecovery(key, tag, err, () => scheduleTryout(event, target));
    } else if (isTransientApiFailure(err)) {
      const attempt = transientAttempts.get(key) ?? 0;
      const delay = redispatchDelayMs(attempt);
      if (delay === null) {
        clearTransientAttempts(key);
        console.error(`💥 [${tag}] failed (transient API, ${attempt} re-dispatches exhausted):`, err);
      } else {
        transientAttempts.set(key, attempt + 1);
        const at = new Date(Date.now() + delay);
        console.error(
          `💥 [${tag}] failed (transient API) — re-dispatch ${attempt + 1}/${REDISPATCH_DELAYS_MS.length} at ${at.toISOString()}`,
        );
        recovery.record(key, at, `${tag} (transient retry ${attempt + 1})`, () =>
          scheduleTryout(event, target),
        );
      }
    } else {
      console.error(`💥 [${tag}] failed:`, err);
    }
  };
  const prev = tryoutQueues.get(repo) ?? Promise.resolve<unknown>(undefined);
  const next = prev
    .then(
      () => tryoutPR(event, target, tryoutConfig),
      () => tryoutPR(event, target, tryoutConfig),
    )
    .catch(onFailure);
  tryoutQueues.set(repo, next);
  next.finally(() => {
    if (tryoutQueues.get(repo) === next) tryoutQueues.delete(repo);
  });
}

// The shape of `gh api repos/<repo>/pulls/<n>` that we actually read. Kept as a
// guard rather than a cast so a changed/failed response fails loudly here
// instead of somewhere deep in a review run.
type GhPullResponse = {
  html_url: string;
  title: string;
  body?: string | null;
  draft: boolean;
  merged?: boolean;
  merge_commit_sha?: string | null;
  head: { sha: string; ref: string };
  base: { ref: string; repo: { full_name: string; clone_url: string } };
  user: { login: string; type: string };
};

function isGhPullResponse(payload: unknown): payload is GhPullResponse {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.html_url !== 'string' || typeof p.title !== 'string') return false;
  if (typeof p.draft !== 'boolean') return false;
  if (p.body !== undefined && p.body !== null && typeof p.body !== 'string') return false;
  if (p.merged !== undefined && typeof p.merged !== 'boolean') return false;
  if (p.merge_commit_sha !== undefined && p.merge_commit_sha !== null
      && typeof p.merge_commit_sha !== 'string') return false;
  const head = p.head, base = p.base, user = p.user;
  if (typeof head !== 'object' || head === null) return false;
  if (typeof base !== 'object' || base === null) return false;
  if (typeof user !== 'object' || user === null) return false;
  const h = head as Record<string, unknown>;
  const b = base as Record<string, unknown>;
  const u = user as Record<string, unknown>;
  if (typeof h.sha !== 'string' || typeof h.ref !== 'string') return false;
  if (typeof b.ref !== 'string') return false;
  const repo = b.repo;
  if (typeof repo !== 'object' || repo === null) return false;
  const r = repo as Record<string, unknown>;
  if (typeof r.full_name !== 'string' || typeof r.clone_url !== 'string') return false;
  if (typeof u.login !== 'string' || typeof u.type !== 'string') return false;
  return true;
}

// Build the same synthetic `pull_request` event retrigger.mjs replays, but
// in-process — an issue_comment payload carries no PR details, so we have to go
// and fetch them. Keep the field mapping in step with retrigger.mjs.
function fetchPullRequestEvent(
  repo: string,
  number: number,
  ghBin: string,
): Promise<PullRequestEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBin, ['api', `repos/${repo}/pulls/${number}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`gh pull query failed (${code}): ${stderr.trim()}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (err: unknown) {
        reject(new Error(`gh pull query produced invalid JSON: ${(err as Error).message}`));
        return;
      }
      if (!isGhPullResponse(parsed)) {
        reject(new Error(`gh pull query returned an unexpected shape for ${repo}#${number}`));
        return;
      }
      const event: PullRequestEvent = {
        action: 'synchronize',
        number,
        pull_request: {
          html_url: parsed.html_url,
          title: parsed.title,
          body: parsed.body ?? null,
          draft: parsed.draft,
          merged: parsed.merged ?? false,
          merge_commit_sha: parsed.merge_commit_sha ?? null,
          head: { sha: parsed.head.sha, ref: parsed.head.ref },
          base: { ref: parsed.base.ref },
          user: { login: parsed.user.login, type: parsed.user.type },
        },
        repository: {
          full_name: parsed.base.repo.full_name,
          clone_url: parsed.base.repo.clone_url,
        },
      };
      if (!isPullRequestEvent(event)) {
        reject(new Error(`built an invalid pull_request event for ${repo}#${number}`));
        return;
      }
      resolve(event);
    });
  });
}

// A `Continue tryout` comment on a release PR resumes its interrupted release
// tryout. Returns the HTTP status to answer the webhook with.
async function handleResumeComment(payload: unknown): Promise<number> {
  if (!isIssueCommentEvent(payload)) return 400;
  const repo = payload.repository.full_name;
  const key = `${repo}#${payload.issue.number}`;

  const skip = resumeSkipReason(payload);
  if (skip !== null) {
    // Once the hook is subscribed to issue_comment, every comment on every
    // watched repo lands here — so the common path is a cheap, quiet skip.
    if (skip !== 'no resume phrase' && skip !== 'not a pull request') {
      console.log(`⏭️  skip resume ${key} (${skip})`);
    }
    return 200;
  }

  // Already running is the state the comment is asking for. schedulePR would
  // abort the live run and restart it, throwing away whatever the agent has
  // done since its last incremental .review.json write.
  const running = slots.get(key);
  if (running) {
    console.log(`⏭️  skip resume ${key} (a ${running.kind} is already running)`);
    return 200;
  }

  const repoTarget = TRYOUT_TARGETS[repo];
  const releaseTarget: DeployedTryoutTarget | undefined =
    repoTarget?.kind === 'deployed' && repoTarget.releaseBranch ? repoTarget : undefined;
  if (!releaseTarget) {
    console.log(`⏭️  skip resume ${key} (no release target configured for ${repo})`);
    return 200;
  }

  const event = await fetchPullRequestEvent(repo, payload.issue.number, reviewConfig.ghBin);
  if (event.pull_request.base.ref !== releaseTarget.releaseBranch) {
    console.log(
      `⏭️  skip resume ${key} (base=${event.pull_request.base.ref}, not ${releaseTarget.releaseBranch})`,
    );
    return 200;
  }

  console.log(
    `▶️  [${key}] resuming release tryout on request from @${payload.comment.user.login}`,
  );
  clearTransientAttempts(key);
  schedulePR(key, event, 'release-tryout', releaseTarget);
  return 202;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseWebhookBody(body: Buffer, contentType: string): unknown {
  const text = body.toString('utf8');
  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(text);
    const p = params.get('payload');
    if (p === null) throw new Error('form-encoded body missing "payload" field');
    return JSON.parse(p);
  }
  // Default to JSON for application/json and unknown content types.
  return JSON.parse(text);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/github') {
    res.writeHead(404).end('not found\n');
    return;
  }

  const body = await readBody(req);
  const sigHeader = req.headers['x-hub-signature-256'];
  const signature = typeof sigHeader === 'string' ? sigHeader : undefined;

  if (!verifySignature(body, signature, SECRET)) {
    console.warn('🚫 invalid signature');
    res.writeHead(401).end('invalid signature\n');
    return;
  }

  const eventHeader = req.headers['x-github-event'];
  const eventType = typeof eventHeader === 'string' ? eventHeader : undefined;
  const deliveryHeader = req.headers['x-github-delivery'];
  const delivery = typeof deliveryHeader === 'string' ? deliveryHeader.slice(0, 8) : '?';
  const contentTypeHeader = req.headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : '';

  let payload: unknown;
  try {
    payload = parseWebhookBody(body, contentType);
  } catch (err: unknown) {
    console.warn(`📥 webhook ${delivery} ${eventType ?? '?'} parse failed (content-type=${contentType || '<none>'}): ${(err as Error).message}`);
    res.writeHead(400).end('invalid payload\n');
    return;
  }

  const repoHint = (payload && typeof payload === 'object' && 'repository' in payload
    ? ((payload as { repository?: { full_name?: string } }).repository?.full_name)
    : undefined) ?? '?';
  console.log(`📥 webhook ${delivery} ${eventType ?? '?'} ${repoHint}`);

  if (eventType === 'ping') {
    res.writeHead(200).end('pong\n');
    return;
  }

  if (eventType === 'issue_comment') {
    const status = await handleResumeComment(payload);
    res.writeHead(status).end(status === 202 ? 'accepted\n' : status === 400 ? 'invalid payload\n' : 'ignored\n');
    return;
  }

  if (eventType !== 'pull_request') {
    res.writeHead(200).end('ignored\n');
    return;
  }

  if (!isPullRequestEvent(payload)) {
    res.writeHead(400).end('invalid payload\n');
    return;
  }

  const key = `${payload.repository.full_name}#${payload.number}`;
  let routed = false;
  let matched = false;

  const repoTarget = TRYOUT_TARGETS[payload.repository.full_name];
  const releaseTarget: DeployedTryoutTarget | undefined =
    repoTarget?.kind === 'deployed' && repoTarget.releaseBranch
      ? repoTarget
      : undefined;
  const isReleasePR =
    releaseTarget !== undefined &&
    payload.pull_request.base.ref === releaseTarget.releaseBranch;

  if (shouldReview(payload)) {
    matched = true;
    // A real webhook is a fresh start: drop any transient-failure history so the
    // re-dispatch schedule doesn't carry over from a previous SHA.
    clearTransientAttempts(key);
    if (isReleasePR && releaseTarget) {
      console.log(`🚀 [${key}] queueing release tryout (base=${payload.pull_request.base.ref})`);
      schedulePR(key, payload, 'release-tryout', releaseTarget);
    } else {
      schedulePR(key, payload, 'review');
    }
    routed = true;
  }
  if (shouldTryout(payload)) {
    matched = true;
    const target = TRYOUT_TARGETS[payload.repository.full_name];
    if (!target) {
      console.log(`⏭️  skip tryout ${key} (no tryout target configured for ${payload.repository.full_name})`);
    } else {
      const branches = target.tryoutBranches ?? ['develop'];
      const base = payload.pull_request.base.ref;
      if (branches.includes(base)) {
        console.log(`🧪 [${key}] queueing tryout (merged into ${base})`);
        clearTransientAttempts(tryoutRecoveryKey(payload.repository.full_name, payload.number));
        scheduleTryout(payload, target);
        routed = true;
      } else {
        console.log(`⏭️  skip tryout ${key} (base=${base} not in [${branches.join(',')}])`);
      }
    }
  }

  if (!matched) {
    const reason = reviewSkipReason(payload);
    const why = reason ?? `action=${payload.action}`;
    console.log(`⏭️  skip ${key} (${why})`);
  }

  res.writeHead(routed ? 202 : 200).end(routed ? 'accepted\n' : 'ignored\n');
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('💥 handler error:', err);
    if (!res.headersSent) res.writeHead(500).end('error\n');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`👂 listening on [${HOST}]:${PORT}`);
});
