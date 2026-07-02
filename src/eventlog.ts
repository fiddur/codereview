import { appendFile } from 'node:fs/promises';

// One line per PR review-lifecycle event, e.g.
//   2026-07-01T06:49:15Z https://github.com/fiddur/aurboda/pull/820 review started
//   2026-07-01T06:50:30Z https://github.com/fiddur/aurboda/pull/820 updated
// Agents tail -F this file, spot their PR's URL, and pull details from `gh`.
export function formatPrEvent(prUrl: string, action: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${ts} ${prUrl} ${action}\n`;
}

export async function appendPrEvent(logPath: string, prUrl: string, action: string): Promise<void> {
  try {
    await appendFile(logPath, formatPrEvent(prUrl, action));
  } catch (err: unknown) {
    console.error(`⚠️  failed to append event log: ${(err as Error).message}`);
  }
}
