import { spawn } from 'node:child_process';

export type RunStep = {
  cmd: string;
  args: string[];
  cwd?: string;
  stdin?: string;
};

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

export function isAbortedError(err: unknown): boolean {
  return err instanceof AbortedError;
}

export function runStep(step: RunStep, logPrefix: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const child = spawn(step.cmd, step.args, {
      cwd: step.cwd,
      stdio: [step.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    let recent = '';
    const remember = (s: string): void => {
      recent = (recent + s).slice(-4000);
    };
    const onAbort = (): void => {
      aborted = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already dead */ }
        killTimer = setTimeout(() => {
          if (child.pid !== undefined) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }, 5000);
        killTimer.unref();
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      remember(s);
      console.log(`[${logPrefix}] ${s.trimEnd()}`);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      remember(s);
      console.error(`[${logPrefix}] ${s.trimEnd()}`);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted) reject(new AbortedError());
      else if (code === 0) resolve();
      else {
        const err = new Error(`${step.cmd} exited with code ${code}`);
        (err as Error & { recent?: string }).recent = recent;
        reject(err);
      }
    });
    if (step.stdin !== undefined && child.stdin) {
      child.stdin.end(step.stdin);
    }
  });
}

export function recentOutput(err: unknown): string {
  if (err && typeof err === 'object' && 'recent' in err) {
    const r = (err as { recent?: unknown }).recent;
    if (typeof r === 'string') return r;
  }
  return '';
}

// All the text we can scrape a failure signature out of: the captured tail of
// the child's output plus the Error message.
export function errText(err: unknown): string {
  return recentOutput(err) + (err instanceof Error ? ` ${err.message}` : '');
}

// The hard daily/session usage cap (distinct from a transient rate limit). Not
// retryable in-process — it only clears at the stated reset time.
export function isSessionLimitError(err: unknown): boolean {
  if (err instanceof AbortedError) return false;
  return /session limit/i.test(errText(err));
}

// The limit message looks like: "You've hit your session limit · resets 5pm
// (Europe/Stockholm)" or "... resets 1:40pm (Europe/Stockholm)".
const RESET_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i;

export function parseResetClock(
  text: string,
): { hour24: number; minute: number; tz: string } | null {
  const m = RESET_RE.exec(text);
  if (!m) return null;
  let hour24 = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] ?? '').toLowerCase();
  if (ap === 'pm' && hour24 !== 12) hour24 += 12;
  if (ap === 'am' && hour24 === 12) hour24 = 0;
  return { hour24, minute, tz: m[4]?.trim() || 'Europe/Stockholm' };
}

// Current wall-clock (hour/minute/second) in the given IANA timezone. Falls back
// to Europe/Stockholm if the tz string is unusable.
export function wallClockNow(
  now: Date,
  tz: string,
): { hour: number; minute: number; second: number } {
  const makeFmt = (zone: string): Intl.DateTimeFormat =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = makeFmt(tz);
  } catch {
    fmt = makeFmt('Europe/Stockholm');
  }
  const parts = fmt.formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0; // en-GB 2-digit renders midnight as "24"
  return { hour, minute: get('minute'), second: get('second') };
}

// Resolve the reset phrase in `text` to an absolute instant: the next occurrence
// of that wall-clock time in its timezone, plus a small buffer so freshly-reset
// quota has propagated. Returns null when there's no parseable reset time.
export function sessionLimitResetAt(
  text: string,
  now: Date = new Date(),
  bufferMs = 120_000,
): Date | null {
  const clock = parseResetClock(text);
  if (clock === null) return null;
  const wall = wallClockNow(now, clock.tz);
  const targetMin = clock.hour24 * 60 + clock.minute;
  const nowMin = wall.hour * 60 + wall.minute + wall.second / 60;
  let deltaMin = targetMin - nowMin;
  if (deltaMin < 0) {
    // Reset already passed today. The message is emitted *before* the reset, so
    // a small negative delta is just clock skew / a slightly stale parse — fire
    // almost immediately. Only a clearly-earlier time means "tomorrow".
    deltaMin = deltaMin > -60 ? 0 : deltaMin + 24 * 60;
  }
  return new Date(now.getTime() + deltaMin * 60_000 + bufferMs);
}

const TRANSIENT_PATTERNS = [
  /API Error: 5\d\d/,
  /\bOverloaded\b/i,
  /\b529\b/,
  /\bRate limit/i,                          // also matches "Rate limited"
  /Server is temporarily limiting/i,
  /Request was aborted by server/i,
];

export function isTransientApiFailure(err: unknown): boolean {
  if (err instanceof AbortedError) return false;
  const txt = recentOutput(err) + (err instanceof Error ? ` ${err.message}` : '');
  return TRANSIENT_PATTERNS.some((re) => re.test(txt));
}

// A quota attached to one model family, where switching models actually helps:
// "You've reached your Fable limit. Switch to another model, or manage usage
// credits at claude.ai/settings/usage…, to continue." The family is matched
// generically rather than hard-coding Fable, so this keeps working if the
// inherited model changes. Deliberately NOT the account-wide caps ("weekly
// usage limit", "out of usage credits") — those follow you to every model, so a
// fallback would just burn a second run; nor the session limit, which carries a
// reset time and is handled by the recovery scheduler instead.
const MODEL_QUOTA_RE = /reached your\s+(?:Fable|Mythos|Opus|Sonnet|Haiku)[\w\s.-]*\blimit\b/i;

export function isModelQuotaError(err: unknown): boolean {
  if (err instanceof AbortedError) return false;
  return MODEL_QUOTA_RE.test(errText(err));
}

const RETRY_DELAYS_MS = [10_000, 30_000, 90_000];

// Second tier, used by the server once the in-process ladder above is spent.
// That ladder covers a blip (~2 minutes of retries); a 529 storm that outlasts
// it needs a much longer wait, and the work has to survive it rather than being
// dropped until a human notices. Bounded on purpose — after the last entry the
// failure is reported as terminal.
export const REDISPATCH_DELAYS_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000];

// 0-based attempt number → how long to wait before re-dispatching, or null when
// the schedule is exhausted.
export function redispatchDelayMs(attempt: number): number | null {
  return REDISPATCH_DELAYS_MS[attempt] ?? null;
}

export async function runClaudeWithRetry(
  step: RunStep,
  logPrefix: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await runStep(step, logPrefix, signal);
      return;
    } catch (err: unknown) {
      lastErr = err;
      if (signal?.aborted || err instanceof AbortedError) throw err;
      if (!isTransientApiFailure(err) || attempt === RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt] ?? 60_000;
      console.warn(
        `[${logPrefix}] transient API failure, retrying in ${delay / 1000}s (attempt ${attempt + 2}/${RETRY_DELAYS_MS.length + 1})`,
      );
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        const onAbort = (): void => {
          clearTimeout(t);
          reject(new AbortedError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  throw lastErr;
}

// The spawned command is either `claude …` (review) or `timeout <dur> claude …`
// (tryout/release), so the flag goes on the end either way — the same place the
// other flags already sit, after the `-p <prompt>` pair.
export function withModel(step: RunStep, model: string): RunStep {
  return { ...step, args: [...step.args, '--model', model] };
}

export function hasModelFlag(step: RunStep): boolean {
  return step.args.includes('--model');
}

// Spawned agents inherit whatever model ~/.claude/settings.json pins, and that
// model has its own weekly quota. When it runs out the CLI exits immediately
// ("You've reached your Fable limit. Switch to another model…") — not a
// transient failure the retry ladder can ride out, and not the account-wide
// session limit the recovery scheduler waits out. The CLI's own
// `--fallback-model` does not cover it (that handles "overloaded or not
// available"), so re-run the whole step once on another model instead.
export async function runClaudeWithFallback(
  step: RunStep,
  logPrefix: string,
  fallbackModel: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runClaudeWithRetry(step, logPrefix, signal);
  } catch (err: unknown) {
    if (signal?.aborted || err instanceof AbortedError) throw err;
    if (!fallbackModel || !isModelQuotaError(err)) throw err;
    // Loop guard: an explicit --model means this step *is* the fallback run, so
    // "reached your Opus limit" must not send us round again.
    if (hasModelFlag(step)) throw err;
    // Warn, not log: this changes what the run costs, so it has to be visible
    // in server.out. No events.log line — watchers block on that log until a
    // terminal event arrives, and a fallback is not terminal; the run still
    // ends in the usual `updated` / `failed` line.
    console.warn(`⚠️  [${logPrefix}] model quota exhausted — retrying this run on ${fallbackModel}`);
    await runClaudeWithRetry(withModel(step, fallbackModel), logPrefix, signal);
  }
}
