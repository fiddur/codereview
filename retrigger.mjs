import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';

const [, , repo, numStr, action = 'synchronize'] = process.argv;
if (!repo || !numStr) {
  console.error('usage: node retrigger.mjs <owner/repo> <number> [action]');
  process.exit(1);
}
const number = Number(numStr);

// Pull the webhook secret from .env or the process env (same sources the server
// uses). The server skips verification when no secret is configured, so it's
// optional here — we only attach a signature when we actually have one.
const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
const secret = (
  env.match(/^GITHUB_WEBHOOK_SECRET=(.*)$/m)?.[1] ?? process.env.GITHUB_WEBHOOK_SECRET ?? ''
).trim();

const pr = JSON.parse(
  execFileSync('gh', ['api', `repos/${repo}/pulls/${number}`], { encoding: 'utf8' }),
);

const payload = {
  action,
  number,
  pull_request: {
    html_url: pr.html_url,
    title: pr.title,
    body: pr.body ?? null,
    draft: pr.draft,
    merged: pr.merged ?? false,
    merge_commit_sha: pr.merge_commit_sha ?? null,
    head: { sha: pr.head.sha, ref: pr.head.ref },
    base: { ref: pr.base.ref },
    user: { login: pr.user.login, type: pr.user.type },
  },
  repository: {
    full_name: pr.base.repo.full_name,
    clone_url: pr.base.repo.clone_url,
  },
};

const body = Buffer.from(JSON.stringify(payload));
const headers = {
  'content-type': 'application/json',
  'x-github-event': 'pull_request',
  'x-github-delivery': `synthetic-${Date.now()}`,
};
if (secret) {
  headers['x-hub-signature-256'] =
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// Node's http (unlike fetch) doesn't enforce the WHATWG "bad ports" blocklist,
// which includes 6666 — so we can actually reach the local server.
const { status, text } = await new Promise((resolve, reject) => {
  const req = request(
    { host: 'localhost', port: 6666, path: '/github', method: 'POST', headers },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    },
  );
  req.on('error', reject);
  req.end(body);
});
console.log(`🚀 ${repo}#${number} (${action}) @ ${pr.head.sha.slice(0, 7)} → ${status} ${text.trim()}`);
