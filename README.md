# codereview

A small TypeScript HTTP server that listens to GitHub webhooks and fires off
automated **PR reviews** and post-merge **tryouts** by spawning
[Claude Code](https://claude.com/claude-code) processes.

> ⚠️ **Personal setup, not a generalized tool.** This runs on one machine for a
> couple of specific repositories. Paths (`/home/fiddur/src/codereview/...`),
> repo names, domains, and the tryout stacks are hardcoded in `src/server.ts`.
> It's published as a reference/example, not a drop-in product — expect to edit
> the config maps before it does anything useful for you.

## What it does

On each webhook the server dispatches to one of three pipelines:

- **Review** — for opened / synchronized / reopened / ready-for-review PRs.
  Fetches the PR into a detached [git worktree](https://git-scm.com/docs/git-worktree)
  off a shared bare clone, spawns Claude Code with a diff-anchored review prompt,
  and posts the result (`✅ Approved` / `🛑 Changes required` + inline comments)
  via `gh`. A new push aborts the in-flight review and restarts on the new SHA.
- **Tryout** (post-merge, `develop`) — pulls the freshly built Docker image,
  brings up a local stack, and has Claude Code exercise the merged feature
  against it (API + puppeteer), filing follow-up issues for anything broken.
- **Release tryout** (PRs into a release branch) — verifies a checklist from the
  PR body against a deployed preview environment, ticks the boxes it confirms,
  and gates the release with an approve / changes-required review. Incremental
  and resumable across interruptions.

Spawned Claude processes run with **all MCP servers disabled**
(`--mcp-config empty-mcp.json --strict-mcp-config`) except a local-only MCP
explicitly wired for the docker tryout — so a review/tryout can never reach
production.

## Usage-limit auto-recovery

Spawned Claude processes count against the account's usage cap. When a
review/tryout dies on the hard **session limit**, the server parses the reset
time from the failure output (`… resets 5pm (Europe/Stockholm)`), and re-fires
that exact piece of work just after the reset — no human in the loop. Because it
re-enters the normal scheduling path, a release tryout **resumes** from its
partial `.review.json` rather than restarting. Pending recoveries coalesce onto a
single timer; a fresh webhook for the same PR cancels its pending recovery so a
stale SHA is never re-fired. (`src/recovery.ts`; reset parsing in `src/run.ts`.)

`retrigger-stale.sh` remains as a manual belt-and-braces sweep — it re-fires any
open non-draft PR whose latest review is behind its head SHA.

## How a tryout works (the agent writes its own scripts)

The server doesn't ship a fixed test script per feature — it can't, because it
has no idea what an arbitrary merged PR is supposed to do. Instead it stands up
the environment and hands Claude Code a **prompt describing a verification
_method_**, then lets the agent author whatever scripts that particular change
needs, on the spot.

Concretely, for a docker tryout the server:

1. Waits for the PR's Docker image to finish building, `docker compose pull`s it,
   and brings the stack up on `localhost` (health-checked).
2. Refreshes a demo login (`tryout/01-signup.mjs` → `token.txt`) and writes a
   per-run MCP config pointing at the **local** container.
3. Spawns Claude Code in a **fresh per-run workspace** with a prompt that says,
   in effect: *"figure out what this PR claims, then prove it works."*

From there the agent works it out itself:

- Reads `gh pr view` / `gh pr diff` to learn what the change actually promises.
- **Writes its own verification scripts in its workspace** — `curl` + `jq`
  assertions for backend/API changes, or a small
  [puppeteer](https://pptr.dev/) script driving `/usr/bin/chromium` for UI
  changes, taking screenshots to `./shots/`.
- The committed `tryout/*.mjs` files are **reference examples, not a fixed
  suite** — past-run scripts kept around so the agent can crib the shape (the
  auth flow, puppeteer boilerplate, the `page.evaluate(() => ({ ... }))` trick
  for dumping JSON summaries). The prompt tells it to read them for the pattern
  and write fresh ones in its own cwd, never in the shared dir.
- **Reads its screenshots back** — the vision model catches visual regressions
  (dark-mode breakage, overlap, missing elements) that text assertions miss.
- Seeds data first (via the local MCP or the API) when the feature needs state.

The prompt holds it to a real evidence bar: a run only counts as verified if the
agent can (1) name the specific behavior the PR promised, (2) show an API call or
UI interaction that exercised it, and (3) quote the response or screenshot that
proves it happened — `"200 OK"` or `"page rendered"` alone is rejected. Anything
surprising becomes a `tryout-finding`-labelled follow-up issue, one per finding.

The **release tryout** is the same idea aimed at a deployed preview instead of a
local container, and structured around the checklist in the PR body: the agent
verifies each item, the server ticks the confirmed boxes back onto the PR, and
the whole thing is resumable so a mid-run interruption (e.g. a usage-limit reset)
picks up where it left off rather than restarting.

## Layout

| File | Role |
|------|------|
| `src/server.ts` | HTTP server, webhook dispatch, per-PR abort-on-new-SHA slots, per-repo tryout queue, the `TRYOUT_TARGETS` config map |
| `src/webhook.ts` | Payload types, signature verification, review/tryout gating |
| `src/review.ts` | Review prompt, `.review.json` parsing, posting (with inline-comment anchoring + summary fallback) |
| `src/release.ts` | Release-tryout pipeline, PR-body checklist parse/apply, resume support |
| `src/tryout.ts` | Docker/deployed tryout targets, build-workflow wait, per-run MCP config |
| `src/run.ts` | Child-process runner with abort + process-group kill, transient-API-failure retry, usage-limit reset-time parsing |
| `src/recovery.ts` | Coalescing scheduler that re-fires usage-limit-failed work just after the reset |
| `src/eventlog.ts` | Appends a line-per-event feed to `events.log` so sibling agents can `tail -F` instead of polling GitHub |
| `retrigger.mjs` | Re-fire a synthetic (signed) webhook for one PR |
| `retrigger-stale.sh` | Sweep open non-draft PRs and retrigger any whose latest review is behind head (e.g. after a session-limit blackout) |

## Setup

```bash
pnpm install
cp .env.example .env                            # fill in GITHUB_WEBHOOK_SECRET etc.
cp src/targets.example.ts src/targets.local.ts  # then edit: your repos + tryout stacks
pnpm start                                      # tsx --env-file=.env src/server.ts
```

`gh` and `claude` must be installed and authenticated. Point a GitHub webhook
(content type JSON or form-urlencoded) at `http://<host>:6666/github`.

Tryout targets (which repos get docker / release tryouts, and how) live in
`src/targets.local.ts`, which is gitignored — `src/targets.example.ts` documents
the shape. `retrigger-stale.sh` similarly reads its repo list from a gitignored
`repos.local` (one `owner/repo` per line).

### Environment

See `.env.example`. A deployed release tryout whose app uses Supabase for auth
additionally needs a service-role key (the **preview** project's, never
production) to mint magic-link logins for throwaway test users.

### Tryout stacks

The docker tryout uses `tryout/docker-compose.yml`, which is gitignored because
it holds local throwaway DB credentials. Copy the template:

```bash
cp tryout/docker-compose.example.yml tryout/docker-compose.yml
```

## Tests

```bash
pnpm check     # tsc --noEmit && node --test src/*.test.ts
```

## Notes

- Reviews work for any repo whose webhook reaches the server; **tryouts** need an
  app-specific stack and are enabled per-repo in `TRYOUT_TARGETS`.
- Spawned Claude processes count against the account's usage limits. When a limit
  is hit mid-run the affected review/tryout fails and is **auto-recovered** just
  after the reset (see *Usage-limit auto-recovery* above); `retrigger-stale.sh` is
  the manual fallback.
