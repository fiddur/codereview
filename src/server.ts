import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isPullRequestEvent, reviewSkipReason, shouldReview, shouldTryout, verifySignature, type PullRequestEvent } from './webhook.ts';
import { reviewPR, isAbortedError, type ReviewConfig } from './review.ts';
import { tryoutPR, type TryoutConfig, type TryoutTarget, type DeployedTryoutTarget } from './tryout.ts';
import { releaseTryoutPR } from './release.ts';
import { appendPrEvent } from './eventlog.ts';
import { errText, isSessionLimitError, sessionLimitResetAt } from './run.ts';
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
    if (isSessionLimitError(err)) {
      scheduleRecovery(tryoutRecoveryKey(repo, event.number), tag, err, () =>
        scheduleTryout(event, target),
      );
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
