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

const RETRY_DELAYS_MS = [10_000, 30_000, 90_000];

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
