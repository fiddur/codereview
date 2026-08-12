import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullRequestEvent } from './webhook.ts';
import { AbortedError, runClaudeWithRetry, runStep } from './run.ts';

export type TryoutMcp = {
  serverName: string;
  url: string;
};

// Two flavours of tryout target:
//   - docker:   tryouts pull a local docker image and verify against
//               localhost. The merged commit appears on the box as soon as
//               `docker compose pull` succeeds.
//   - deployed: tryouts wait for a preview deployment to come online at a
//               public URL and verify against that. We poll the
//               `versionEndpoint` until it reports the merge commit, so we
//               only run claude once the deploy is live.
type CommonFields = {
  appName: string;
  healthUrl: string;          // GET; status < 500 = up
  mcp?: TryoutMcp;
  tryoutBranches?: string[];  // base branches that count; default ['develop']
  // What `tokenFile` actually contains. Drives prompt language and skips the
  // MCP-bearer probe when the file isn't a bearer.
  //   'bearer'         - a string used as Authorization: Bearer <token> (default)
  //   'magic-link-url' - a URL the agent navigates in puppeteer to establish a
  //                      browser session; useful when auth is session-cookie-based
  //   'session-cookie' - the value of an HttpOnly session cookie; the agent
  //                      sends it as `Cookie: <name>=<token>` (no bearer path),
  //                      and sets it via page.setCookie in puppeteer
  tokenKind?: 'bearer' | 'magic-link-url' | 'session-cookie';
};

export type DockerTryoutTarget = CommonFields & {
  kind: 'docker';
  sharedDir: string;          // contains docker-compose.yml + scripts + state
  dockerService: string;      // compose service to pull/up
  signupScript: string;       // node script in sharedDir that mints the demo token
  tokenFile: string;          // file in sharedDir, written by signupScript
  // If set, wait for a GitHub Actions workflow run on the merge commit to
  // succeed before `docker compose pull && up`. Avoids racing CI: without
  // this, the container can be re-upped on the previous PR's image because
  // the docker-build workflow for the merge SHA hadn't finished yet.
  // Matched by name (substring), case-insensitive.
  dockerBuildWorkflow?: string;
  // Optional override of the claude timeout for this docker target. Defaults
  // to TryoutConfig.timeoutDuration (env-driven, currently 30m).
  timeoutDuration?: string;
};

export type DeployedTryoutTarget = CommonFields & {
  kind: 'deployed';
  // Public base URL of the preview deploy (https://preview.example.com).
  // Used in prompts as the "the app is running at <baseUrl>" pointer.
  baseUrl: string;
  // Endpoint to poll for the deployed commit-ish. JSON: { [versionField]: "<sha-or-prefix>" }.
  // If versionField is omitted, the response body itself is treated as the version string.
  versionEndpoint: string;
  versionField?: string;        // default 'commit'
  versionPollAttempts?: number; // default 60
  versionPollIntervalMs?: number; // default 10000
  // Per-tryout auth. The signup contract is the same as docker mode (run a
  // node script that writes a bearer to ./<tokenFile>), but the script lives
  // wherever you set sharedDir and is expected to be safe to run repeatedly
  // against the preview deployment (e.g. login as a fixed demo user rather
  // than minting a fresh signup every time).
  sharedDir: string;
  signupScript: string;
  tokenFile: string;
  // If set, PRs whose base.ref matches will trigger a release-tryout (gates
  // the release via a PR review, distinct from post-merge tryouts driven by
  // `tryoutBranches`). The HEAD of the release PR is the commit currently
  // deployed to the preview; the agent verifies the PR description as a test
  // plan and posts approved/changes_required as a PR review.
  releaseBranch?: string;
  // Override for the release-tryout `timeout` duration. Release tryouts walk
  // every release-notes checklist item, which is heavier than per-PR tryouts,
  // so they need a longer ceiling than `TryoutConfig.timeoutDuration`.
  // Defaults to '30m' inside release.ts.
  releaseTimeoutDuration?: string;
};

export type TryoutTarget = DockerTryoutTarget | DeployedTryoutTarget;

export type TryoutConfig = {
  runsBase: string;
  ghBin: string;
  claudeBin: string;
  timeoutBin: string;
  timeoutDuration: string;
  mcpConfigFallback: string;
};

const BASE_ALLOWED_TOOLS = [
  'Bash(gh:*)',
  'Bash(curl:*)',
  'Bash(jq:*)',
  'Bash(node:*)',
  'Bash(cat:*)',
  'Bash(ls:*)',
  'Bash(docker compose logs:*)',
  'Bash(docker compose ps:*)',
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
];

const DISALLOWED_TOOLS = ['Agent', 'WebFetch', 'WebSearch'].join(' ');

function buildAllowedTools(target: TryoutTarget): string {
  const tools = [...BASE_ALLOWED_TOOLS];
  if (target.mcp) tools.push(`mcp__${target.mcp.serverName}`);
  return tools.join(' ');
}

function buildPrompt(
  event: PullRequestEvent,
  target: TryoutTarget,
  mcpAvailable: boolean,
): string {
  const { repository, number, pull_request } = event;
  const body = pull_request.body?.trim() ?? '(no description)';
  const tokenPath = join(target.sharedDir, target.tokenFile);
  const signupPath = join(target.sharedDir, target.signupScript);

  const liveLocation = target.kind === 'docker'
    ? `A live ${target.appName} instance is running on ${target.healthUrl} with the freshly built \`:develop\` image (the server has already pulled and re-upped it).`
    : `The preview deployment of ${target.appName} is live at ${target.baseUrl} and matches the merge commit ${pull_request.merge_commit_sha?.slice(0, 10) ?? '(unknown)'} (the server polled \`${target.versionEndpoint}\` before invoking you, so don't worry about staleness). This is a PUBLIC deployment — be conservative about creating data, sending emails, or anything else with side effects.`;

  const tokenKind = target.tokenKind ?? 'bearer';
  const statePath = join(target.sharedDir, 'state.json');
  const appOrigin = new URL(target.healthUrl).origin;
  const tokenDescription = tokenKind === 'magic-link-url'
    ? `**Auth model**: \`${tokenPath}\` contains a magic-link URL (not a bearer token). Navigate puppeteer to that URL — the redirect chain logs the browser in and lands you on /auth/callback signed in. \`${statePath}\` (if present) is a JSON file written alongside it with richer context: \`{ admin: { userId, email, actionLink }, test: { userId, email, actionLink } }\`. The test user is the default; switch to the admin link if you need to exercise \`/admin/*\` routes. For API-only checks (no browser), pull the Supabase JWT out of localStorage after the magic-link redirect and send it as \`Authorization: Bearer <jwt>\` — Supabase access tokens are valid for /api/* routes that accept session auth.`
    : tokenKind === 'session-cookie'
    ? `**Auth model**: \`${tokenPath}\` contains a **session cookie value** (an \`HttpOnly\` cookie), not a bearer token — this app authenticates by cookie only, there is no \`Authorization: Bearer\` path. \`${statePath}\` has \`{ cookieName, token, baseUrl, account: { id, email, roles } }\`; read \`cookieName\` from there rather than hard-coding it. For \`/api/*\` calls with curl, send it as a cookie: \`curl -H "Cookie: <cookieName>=$(cat ${tokenPath})" ${appOrigin}/api/...\`. For puppeteer, set the cookie before navigating — it is \`HttpOnly\`, so \`document.cookie\` cannot set it: \`await page.setCookie({ name: '<cookieName>', value: '<token>', url: '${appOrigin}', httpOnly: true })\`. The demo account holds the \`admin\` role, so admin-only routes are reachable. On a 401 the cookie has expired or the container's DB was reset — re-run \`${signupPath}\` to mint a fresh one.`
    : `**Auth model**: \`${tokenPath}\` is a bearer token. Use as \`Authorization: Bearer <token>\` for /api/* calls.`;

  const mcpSection = target.mcp
    ? mcpAvailable
      ? `\n\nThe \`${target.mcp.serverName}\` MCP server is wired up and points at this ${target.kind === 'docker' ? 'LOCAL docker container' : 'PREVIEW deployment'} (${target.mcp.url}), authenticated as the demo user. You can use \`mcp__${target.mcp.serverName}__*\` tools to read AND mutate state. ${target.kind === 'docker' ? 'Do NOT worry about touching production; the MCP is locally scoped.' : 'Be conservative — mutations on the preview deploy may persist across tryouts.'} If a tool fails with a 401, the demo token has rotated — re-run \`${signupPath}\` to refresh it, but note the MCP server is started by claude with the token from when this session began, so a token refresh during the same session won't take effect; complete this tryout with curl + token instead.\n\n${tokenDescription}`
      : `\n\nThe ${target.mcp.serverName} MCP server is disabled for this run (the /mcp endpoint didn't accept the demo token). ${tokenDescription}`
    : `\n\nNo MCP server is configured for ${target.appName}. ${tokenDescription}`;

  return `You are trying out a freshly merged pull request to verify the feature actually works.${mcpSection}

PR: ${repository.full_name}#${number}
Title: ${pull_request.title}
URL: ${pull_request.html_url}
Merge commit: ${pull_request.merge_commit_sha ?? '(unknown)'}
Head branch: ${pull_request.head.ref}

PR description:
"""
${body}
"""

${liveLocation} Your working directory is a fresh per-run workspace. Reference scripts and shared state live in \`${target.sharedDir}\`:

- \`${signupPath}\` — runs the demo-user signup/login flow and writes \`${tokenPath}\`. Run this if \`${tokenPath}\` is missing or returns 401 against the API.
- Other \`*.mjs\` files in \`${target.sharedDir}\` may include seed/verify examples. They use puppeteer-core, \`/usr/bin/chromium\`, screenshots, and \`page.evaluate(() => ({ ... }))\` for JSON summaries. Read them for the shape; write your own scripts in your cwd (not in the shared dir).

Verification pattern:
1. \`gh pr view ${number} --repo ${repository.full_name}\` and \`gh pr diff ${number} --repo ${repository.full_name}\` to figure out what the PR claims to do.
2. If the change is backend/data: \`curl\` with the bearer token from \`${tokenPath}\`, assert with \`jq\`.
3. If the change is UI: write a small puppeteer script in your cwd that exercises the feature, takes screenshots to \`./shots/\`, and emits a JSON summary on stdout. Then Read the screenshots back — the vision model catches visual regressions (dark-mode breakage, overlap, missing elements) that text assertions miss.
4. Seed data first if the feature needs state.
5. If the API token fails, re-run \`${signupPath}\` and re-read \`${tokenPath}\`.

Verification is successful ONLY if all three hold:
1. You can name the specific feature behavior promised in the PR body.
2. You executed an API call or puppeteer interaction that exercises that behavior.
3. You can quote the response/screenshot evidence that the behavior occurred.
"200 OK" or "page rendered" alone is NOT sufficient. If you can't satisfy all three, keep trying with a different approach before declaring victory.

If you find anything surprising (bug, regression, broken UI, unexpected state, behavior that doesn't match the PR description), file a followup issue:

\`\`\`
gh issue create --repo ${repository.full_name} \\
  --label tryout-finding \\
  --title "<short summary>" \\
  --body "$(cat <<'EOF'
Followup from #${number}.

## Problem
<what you observed, with the specific evidence — quoted response, described screenshot, or both>

## Suggestion
<what should change>

## Repro
<commands or steps; reference the scripts/state in ${target.sharedDir} if relevant>
EOF
)"
\`\`\`

File one issue per distinct finding. If everything works as promised, file no issues and exit cleanly.

When done, exit. The server does not collect a JSON output for tryouts — your only artifacts are the issues you filed and the screenshots you wrote.`;
}

async function refreshImage(target: DockerTryoutTarget, tag: string): Promise<void> {
  await runStep(
    { cmd: 'docker', args: ['compose', 'pull', target.dockerService], cwd: target.sharedDir },
    `${tag} docker`,
  );
  await runStep(
    { cmd: 'docker', args: ['compose', 'up', '-d', target.dockerService], cwd: target.sharedDir },
    `${tag} docker`,
  );
}

export async function waitForHealthy(target: TryoutTarget, tag: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(target.healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) {
        console.log(`[${tag}] ${target.appName} responsive at ${target.healthUrl} (status ${res.status})`);
        return;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${target.appName} did not become responsive at ${target.healthUrl} after ${attempts}s`);
}

function matchesCommit(deployed: string, expected: string): boolean {
  const a = deployed.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

async function fetchDeployedVersion(target: DeployedTryoutTarget): Promise<string | null> {
  try {
    const res = await fetch(target.versionEndpoint, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const field = target.versionField ?? 'commit';
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await res.json() as Record<string, unknown>;
      const v = body[field];
      return typeof v === 'string' ? v : null;
    }
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

export async function waitForDeployedCommit(
  target: DeployedTryoutTarget,
  expectedCommit: string,
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  const attempts = target.versionPollAttempts ?? 60;
  const interval = target.versionPollIntervalMs ?? 10_000;
  const want = expectedCommit.slice(0, 10);
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new AbortedError();
    const got = await fetchDeployedVersion(target);
    if (got && matchesCommit(got, expectedCommit)) {
      console.log(`[${tag}] preview at ${got.slice(0, 10)} matches ${want}, proceeding`);
      return;
    }
    const seen = got ? got.slice(0, 10) : 'unreachable';
    console.log(`[${tag}] preview ${seen} ≠ ${want} (attempt ${i + 1}/${attempts})`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, interval);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  throw new Error(`preview never reached ${want} after ${attempts} attempts`);
}

type WorkflowRun = {
  name?: string;
  status?: string;
  conclusion?: string | null;
};

async function listRunsForCommit(
  repo: string,
  sha: string,
  ghBin: string,
): Promise<WorkflowRun[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBin, [
      'api', `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`,
      '--jq', '[.workflow_runs[] | {name, status, conclusion}]',
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`gh runs query failed (${code}): ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkflowRun[]);
      } catch (err: unknown) {
        reject(new Error(`gh runs query produced invalid JSON: ${(err as Error).message}`));
      }
    });
  });
}

async function waitForBuildWorkflow(
  target: DockerTryoutTarget,
  sha: string,
  ghBin: string,
  tag: string,
  repo: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!target.dockerBuildWorkflow) return;
  const namePattern = target.dockerBuildWorkflow.toLowerCase();
  const attempts = 40;
  const interval = 15_000;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new AbortedError();
    let runs: WorkflowRun[] = [];
    try {
      runs = await listRunsForCommit(repo, sha, ghBin);
    } catch (err: unknown) {
      console.warn(`[${tag}] gh runs query error (will retry): ${(err as Error).message}`);
    }
    const run = runs.find((r) => (r.name ?? '').toLowerCase().includes(namePattern));
    if (run?.status === 'completed') {
      if (run.conclusion === 'success') {
        console.log(`[${tag}] build workflow "${run.name}" succeeded for ${sha.slice(0, 10)}, proceeding`);
        return;
      }
      throw new Error(`build workflow "${run.name}" concluded ${run.conclusion} for ${sha.slice(0, 10)}`);
    }
    const seen = run ? `${run.name}/${run.status ?? '?'}` : 'no matching run yet';
    console.log(`[${tag}] waiting for build workflow (${seen}) attempt ${i + 1}/${attempts}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, interval);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  throw new Error(`build workflow matching "${target.dockerBuildWorkflow}" never completed for ${sha.slice(0, 10)} after ${attempts} attempts`);
}

export async function ensureDemoToken(target: TryoutTarget, tag: string): Promise<string> {
  const tokenPath = join(target.sharedDir, target.tokenFile);
  try {
    const t = (await readFile(tokenPath, 'utf8')).trim();
    if (t) return t;
  } catch { /* missing */ }
  console.log(`[${tag}] no ${target.tokenFile} — running ${target.signupScript} to mint one`);
  await runStep(
    { cmd: 'node', args: [join(target.sharedDir, target.signupScript)], cwd: target.sharedDir },
    tag,
  );
  return (await readFile(tokenPath, 'utf8')).trim();
}

async function probeMcp(url: string, token: string): Promise<Response | null> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codereview-probe', version: '0' } },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
}

async function writeTryoutMcpConfig(
  runDir: string,
  target: TryoutTarget,
  token: string,
  fallback: string,
  tag: string,
): Promise<string> {
  if (!target.mcp) return fallback;
  if ((target.tokenKind ?? 'bearer') !== 'bearer') {
    console.log(`[${tag}] skipping MCP probe — tokenKind=${target.tokenKind} not a bearer`);
    return fallback;
  }
  const { url, serverName } = target.mcp;
  let probe: Response | null = null;
  let lastStatus: number | string = 'no response';
  for (let i = 0; i < 20; i++) {
    probe = await probeMcp(url, token);
    if (probe?.ok) break;
    lastStatus = probe?.status ?? 'no response';
    if (probe?.status === 401 || probe?.status === 403) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!probe || !probe.ok) {
    console.warn(`[${tag}] ${url} didn't accept the demo token (${lastStatus}) after retries — disabling MCP for this run`);
    return fallback;
  }
  const path = join(runDir, '.mcp-tryout.json');
  await writeFile(path, JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2));
  console.log(`[${tag}] wrote tryout MCP config → ${path} (${serverName} → ${url})`);
  return path;
}

export async function tryoutPR(
  event: PullRequestEvent,
  target: TryoutTarget,
  config: TryoutConfig,
): Promise<void> {
  const tag = `tryout ${event.repository.full_name}#${event.number}`;
  const runDir = join(config.runsBase, `${target.appName}-pr${event.number}`);

  console.log(`🧪 [${tag}] starting tryout for "${event.pull_request.title}" (kind=${target.kind})`);

  await rm(runDir, { recursive: true, force: true });
  await mkdir(join(runDir, 'shots'), { recursive: true });

  if (target.kind === 'docker') {
    if (target.dockerBuildWorkflow) {
      const sha = event.pull_request.merge_commit_sha;
      if (sha) {
        await waitForBuildWorkflow(target, sha, config.ghBin, tag, event.repository.full_name);
      } else {
        console.warn(`[${tag}] no merge_commit_sha on event; skipping build-workflow wait`);
      }
    }
    await refreshImage(target, tag);
  } else {
    const expected = event.pull_request.merge_commit_sha;
    if (!expected) {
      throw new Error('deployed tryout requires a merge_commit_sha on the event');
    }
    await waitForDeployedCommit(target, expected, tag);
  }
  await waitForHealthy(target, tag);

  const token = await ensureDemoToken(target, tag);
  const mcpConfigPath = await writeTryoutMcpConfig(runDir, target, token, config.mcpConfigFallback, tag);

  const prompt = buildPrompt(event, target, mcpConfigPath !== config.mcpConfigFallback);

  const timeoutDuration = (target.kind === 'docker' && target.timeoutDuration) || config.timeoutDuration;
  await runClaudeWithRetry(
    {
      cmd: config.timeoutBin,
      args: [
        timeoutDuration,
        config.claudeBin,
        '-p', prompt,
        '--allowedTools', buildAllowedTools(target),
        '--disallowedTools', DISALLOWED_TOOLS,
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
      ],
      cwd: runDir,
    },
    tag,
  );

  console.log(`✅ [${tag}] tryout complete`);
}
