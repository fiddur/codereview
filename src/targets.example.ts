import type { TryoutTarget } from './tryout.ts';

// Template for src/targets.local.ts (which is gitignored). Copy this file to
// src/targets.local.ts and replace the placeholders with your real repos, paths,
// domains and Docker / preview details.
//
// Reviews run for ANY repo whose webhook reaches the server; this map only
// enables the extra *tryout* pipelines, per repo.
export const TRYOUT_TARGETS: Record<string, TryoutTarget> = {
  // Post-merge DOCKER tryout: wait for the image build, bring up a local stack,
  // then have the agent exercise the merged feature against localhost.
  'you/aurboda': {
    kind: 'docker',
    appName: 'aurboda',
    sharedDir: '/path/to/codereview/tryout',
    dockerService: 'aurboda',
    healthUrl: 'http://localhost:8080/',
    signupScript: '01-signup.mjs',
    tokenFile: 'token.txt',
    // A local-only MCP server the tryout agent may use to read/seed state.
    mcp: { serverName: 'aurboda', url: 'http://localhost:8080/mcp' },
    dockerBuildWorkflow: 'Build and Push Docker Image',
  },
  // Release tryout against a DEPLOYED preview: when a PR targets releaseBranch,
  // wait for the preview to serve the PR's SHA, verify the PR-body checklist,
  // and gate the release with an approve / changes-required review.
  'you/your-deployed-app': {
    kind: 'deployed',
    appName: 'your-deployed-app',
    sharedDir: '/path/to/codereview/tryout/your-deployed-app',
    baseUrl: 'https://preview.example.com',
    versionEndpoint: 'https://preview.example.com/api/version',
    versionField: 'sha',            // field in the version endpoint holding the deployed commit
    versionPollAttempts: 90,        // 90 × 10s = 15 min ceiling on deploy wait
    versionPollIntervalMs: 10_000,
    healthUrl: 'https://preview.example.com/',
    signupScript: '01-signup.mjs',
    tokenFile: 'token.txt',
    tokenKind: 'magic-link-url',    // signup script writes a magic-link URL, not a bearer
    tryoutBranches: [],             // no post-merge tryouts; release-tryouts handle preview verification
    releaseBranch: 'prod',          // PRs into this branch trigger a release-tryout
  },
};
