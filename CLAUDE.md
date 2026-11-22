# CLAUDE.md — webstudio-publisher

Node.js service (ESM, no build step, no npm dependencies): the whole service is
`server.mjs`. API and environment variables: see README.

## Branches

Branch from `main`, open the PR against `main`.

## Publish targets: `renderMode` × `host`

| target | pipeline |
|---|---|
| `ssg:local` | `publishBuild`: vike prerender → `/var/publish/<host>/`, atomic swap |
| `ssr:local` | `publishBuildSsr`: one container per domain, blue/green switch |
| `ssg:cloudflare` | `publishBuildCloudflare`: `wrangler pages deploy` |
| `ssg:ssh` | `publishBuildSsh`: rsync to a remote server |
| `ssr:coolify` / `ssg:coolify` | image → `REGISTRY_URL` → Coolify deploy webhook |

- Request → pipeline mapping: `RENDER_HOSTS`, `normalizeTarget`, `availableTargets`.
- `/var/work/<domain>/state.json` stores the previous mode (`ssg`, `docker`,
  `cloudflare`, `ssh`, `coolify`) so the next publish can tear it down, and
  `restoreTargets()` restarts containers and Cloudflare staging routes on boot.
- Jobs run one at a time per domain (`projectQueues`), capped globally by
  `MAX_CONCURRENT_PUBLISHES`.
- The proxy (`PROXY_PORT`) serves every site: SSR → `<container>:3000`,
  Cloudflare staging → `<project>.pages.dev`, SSG → `/var/publish/<host>/`.

## Pitfalls

- **CLI**: run via `WEBSTUDIO_CLI` (npx from the builder's `/npm/` registry,
  `@webstudio-community/cli`). The upstream `webstudio` npm CLI is rejected by
  the fork's API. Never go back to `npm install -g webstudio`.
- **Generated sites install `@webstudio-is/*` from npm upstream**: a fork fix on
  those packages never reaches them. Patch inside the build (`patch-navlink.cjs`)
  or through the CLI template.
- `TARGET_VIKE` pins vike; don't change without testing a publish.
- `PINNED_ROLLUP` works around rollup 4.68.6 on musl; drop once fixed.
- `patchDataFilesForPrerender`: `pageContext.headers` is empty at prerender.
- Cloudflare: wrangler comes from the template's `node_modules`, the project is
  created explicitly (wrangler 4), and it is never deleted by the publisher.
- Coolify: no Coolify credentials, no polling; `isSafeWebhookUrl` blocks SSRF.
- Every logged command goes through `redactSecrets()`.

## CI

`ci.yml`: `node --check`, a real start + `GET /health`, hadolint, yamllint +
actionlint. A new required environment variable needs a value in the
"/health" step. The image build runs in `docker-publish.yml`, PRs included.

## Comments & commits

Match upstream Webstudio: comments are rare (<1 % of lines).

- No comment by default; a clear name beats a comment. Comment only a
  non-obvious *why*: external constraint, workaround, trap, required order.
  - ✅ `// Navigation can discard Chrome's body before the next DOM poll.`
  - ❌ `// Check if any custom domains are selected` (restates the code)
- One line, plain English, present tense; three lines at most.
- JSDoc only for a non-trivial exported API or `@deprecated`; no `@param` /
  `@returns` that repeat the signature.
- Never: our own issue/PR numbers, history ("now", "used to", "fix:"), section
  banners, emojis, French, step numbering that mirrors the code. An upstream
  issue link that tells when to drop a workaround is fine.
- Config files (YAML, `.env`, Dockerfile, nginx): one line for each non-obvious
  setting.
- Commits: `type(scope): summary`, imperative, lowercase, ≤ 72 chars, English,
  one `(#n)` at most. Body: why, in short prose.
- PRs: problem, cause, fix in 1–2 paragraphs; a `- [x]` checklist of the checks
  actually run; `Closes #n` / `Ref #n` last.
