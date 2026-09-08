/**
 * Self-hosted Webstudio publisher service.
 *
 * Receives publish requests from the builder app and either generates static
 * HTML files (SSG) or runs a Node server (SSR), served locally or shipped to a
 * remote host.
 *
 * A publish target has two orthogonal axes (POST /publish):
 *   renderMode — "ssg" (Vite prerender → static files in /var/publish/<domain>/)
 *              | "ssr" (React Router → docker build + docker run, one container
 *                per domain)
 *   host       — "local" (served by this publisher) | "cloudflare" (wrangler
 *                pages deploy) | "coolify" | "ssh"   (coolify/ssh: planned, 501)
 *
 * The legacy `buildMode` field is still accepted (upstream `webstudio` CLI, older
 * builder images): ssg → ssg/local, ssr → ssr/local, cloudflare → ssg/cloudflare.
 * See RENDER_HOSTS / normalizeTarget below.
 *
 * Site proxy (port PROXY_PORT, default 4001):
 *   Serves all published sites — SSR domains are proxied to their Docker container,
 *   SSG domains are served directly from /var/publish/<domain>/, and the local staging
 *   domain of a cloudflare-mode site is reverse-proxied to <cfProjectName>.pages.dev.
 *   The self-host stack should route *.PUBLISHER_HOST traffic to this port.
 *
 * Environment variables:
 *   TRPC_SERVER_API_TOKEN  — service token to authenticate with the builder app
 *   BUILDER_INTERNAL_URL   — internal Docker URL for the builder (default: http://app:3000)
 *   PORT                   — build API HTTP port (default: 4000)
 *   PROXY_PORT             — site proxy HTTP port (default: 4001)
 *   DOCKER_NETWORK         — Docker network shared with site containers (required for SSR mode)
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { exec } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, cp, rm, access, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";

const execAsync = promisify(exec);

const PORT = process.env.PORT ?? "4000";
const PROXY_PORT = process.env.PROXY_PORT ?? "4001";
const SERVICE_TOKEN = process.env.TRPC_SERVER_API_TOKEN ?? "";
const PUBLISHER_HOST = process.env.PUBLISHER_HOST ?? "";
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
// Production branch of every Pages project the publisher creates. Only the
// name matters — there is no git repository behind it — but creating and
// deploying have to agree, or the deployment is filed as a preview.
const CF_PRODUCTION_BRANCH = process.env.CLOUDFLARE_PRODUCTION_BRANCH ?? "main";
// URL interne Docker pour joindre le builder sans passer par Traefik/TLS
const BUILDER_INTERNAL_URL = process.env.BUILDER_INTERNAL_URL ?? "http://app:3000";
const PUBLISH_DIR = "/var/publish";
const WORK_DIR = "/var/work";
// When set, the publisher writes a per-domain Traefik dynamic config file so
// Traefik can request a Let's Encrypt certificate for each custom domain.
// Mount /data/coolify/proxy/dynamic into the container and set this to that path.
const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR ?? "";
// Docker network shared between the publisher and site containers.
// Auto-detected at startup from the publisher container's own networks.
// Override with DOCKER_NETWORK env var if auto-detection picks the wrong one.
let DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? "";
// Own container name — resolved at startup via docker inspect.
// Used in Traefik configs instead of IP (stable across container restarts).
let OWN_CONTAINER_NAME = "";

const log = (msg) => console.info(`[publisher] ${msg}`);
const logErr = (msg) => console.error(`[publisher] ${msg}`);

// ─── Docker container management ─────────────────────────────────────────────

/**
 * Stop a running Docker container and remove its proxy routing entries.
 * Called on mode switches away from docker (→ ssg, → cloudflare, → ssh).
 */
const stopDockerForDomain = async (domain, containerName, publishDomain, customDomains) => {
  log(`Stopping Docker container ${containerName} for ${domain}`);
  try { await execAsync(`docker stop ${containerName}`); } catch {}
  try { await execAsync(`docker rm ${containerName}`); } catch {}
  dockerHostContainer.delete(publishDomain);
  for (const cd of customDomains) dockerHostContainer.delete(cd);
};

/**
 * On publisher startup, read state.json files and restore what each published
 * site needs: Docker containers are started, Cloudflare staging routes are
 * re-registered. SSG and SSH sites need nothing (files on disk / a remote host).
 */
const restoreTargets = async () => {
  let entries;
  try {
    entries = await readdir(WORK_DIR, { withFileTypes: true });
  } catch {
    return; // WORK_DIR empty or not yet created
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const domain = entry.name;
    const stateFile = join(WORK_DIR, domain, "state.json");
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));

      if (state.mode === "docker") {
        const { port, containerName, publishDomain, customDomains = [] } = state;

        // Ensure the container is running — restart it if stopped
        let isRunning = false;
        try {
          const { stdout } = await execAsync(
            `docker inspect --format='{{.State.Running}}' ${containerName}`
          );
          isRunning = stdout.trim() === "'true'" || stdout.trim() === "true";
        } catch { /* container doesn't exist */ }

        if (!isRunning) {
          try {
            await execAsync(`docker start ${containerName}`);
            log(`Restarted Docker container ${containerName} for ${domain}`);
          } catch (err) {
            logErr(`Failed to restart Docker container ${containerName} for ${domain}: ${err.message}`);
            continue;
          }
        }

        dockerHostContainer.set(publishDomain, containerName);
        for (const cd of customDomains) dockerHostContainer.set(cd, containerName);

        log(`Restored Docker container ${containerName} for ${domain}`);

      } else if (state.mode === "cloudflare") {
        // Nothing to start — Cloudflare Pages runs the site. Only the local
        // staging domain is registered: a custom domain's DNS points straight
        // at Cloudflare and never reaches this proxy.
        cfProjectHost.set(state.publishDomain, state.cfProjectName);
        log(`Restored Cloudflare Pages routing for ${domain} → ${state.cfProjectName}.pages.dev`);
      }
    } catch {
      // No state.json or invalid JSON — skip
    }
  }
};

// ─── SSG proxy: static file serving ─────────────────────────────────────────

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

const getMimeType = (filePath) =>
  MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";

/**
 * Try to serve a static file from /var/publish/<host>/<urlPath>.
 * Falls back to <urlPath>.html then <urlPath>/index.html.
 * Returns true if a file was served, false if nothing matched (caller sends 404).
 */
const tryServeStaticFile = async (req, res, host) => {
  const urlPath = req.url.split("?")[0];
  const baseDir = join(PUBLISH_DIR, host);
  const candidates = [
    join(baseDir, urlPath),
    join(baseDir, urlPath + ".html"),
    join(baseDir, urlPath, "index.html"),
  ];

  for (const filePath of candidates) {
    try {
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      const mime = getMimeType(filePath);
      const isImmutable = urlPath.includes("/_assets/") || urlPath.includes("/assets/");
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": s.size,
        "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      createReadStream(filePath).pipe(res);
      return true;
    } catch {
      // file not found — try next candidate
    }
  }
  return false;
};

// ─── Build pipeline helpers ───────────────────────────────────────────────────

/** Serialize publish jobs per domain to avoid concurrent builds. */
const projectQueues = new Map();

const getProjectQueue = (domain) => {
  const existing = projectQueues.get(domain);
  if (existing) return existing;
  const q = { current: Promise.resolve() };
  projectQueues.set(domain, q);
  return q;
};

/**
 * Fetch build data from the builder app via tRPC and extract project domain + custom domains.
 */
const getProjectBuildInfo = async (buildId) => {
  const input = encodeURIComponent(JSON.stringify({ buildId }));
  const url = new URL(`/trpc/build.loadProjectBundleByBuildId?input=${input}`, BUILDER_INTERNAL_URL);
  const response = await fetch(url.href, {
    headers: { Authorization: SERVICE_TOKEN },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch build ${buildId}: ${text.slice(0, 500)}`);
  }
  const wrapper = await response.json();
  const data = wrapper?.result?.data;
  if (!data?.projectDomain) {
    throw new Error(`Build ${buildId} has no projectDomain`);
  }
  return {
    projectDomain: data.projectDomain,
    customDomains: Array.isArray(data.customDomains) ? data.customDomains : [],
  };
};

/**
 * Notify the builder app of the final publish status for a build.
 * Called after the build completes (PUBLISHED) or fails (FAILED).
 */
const notifyBuildStatus = async (buildId, publishStatus) => {
  const url = new URL("/trpc/build.updatePublishStatus", BUILDER_INTERNAL_URL);
  try {
    const response = await fetch(url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: SERVICE_TOKEN,
      },
      body: JSON.stringify({ buildId, publishStatus }),
    });
    if (!response.ok) {
      const text = await response.text();
      logErr(`notifyBuildStatus(${buildId}, ${publishStatus}) failed: ${text.slice(0, 200)}`);
    } else {
      log(`notifyBuildStatus(${buildId}, ${publishStatus}) OK`);
    }
  } catch (err) {
    logErr(`notifyBuildStatus(${buildId}, ${publishStatus}) error: ${err.message}`);
  }
};

/**
 * Get this container's own proxy URL for use in Traefik file-provider service definitions.
 * Uses the Docker container name (resolved at startup) so the URL stays valid across
 * container restarts — container names are stable, IPs are not.
 * Falls back to IP detection if the container name could not be resolved.
 */
const getOwnProxyUrl = () => {
  if (OWN_CONTAINER_NAME) {
    return `http://${OWN_CONTAINER_NAME}:${PROXY_PORT}`;
  }
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        return `http://${iface.address}:${PROXY_PORT}`;
      }
    }
  }
  return `http://127.0.0.1:${PROXY_PORT}`;
};

/**
 * Write a Traefik dynamic config file for a custom domain so Traefik requests
 * a Let's Encrypt certificate for it automatically (file provider with watch=true).
 * No-op if TRAEFIK_DYNAMIC_DIR is not set or the domain has no dot (staging slug).
 *
 * The service is defined inline (direct IP) rather than referencing ws-publisher-svc@docker
 * because Traefik v3 file-provider routers cannot reliably resolve cross-provider services.
 */
const writeTraefikRouteForDomain = async (domain) => {
  if (!TRAEFIK_DYNAMIC_DIR || !domain.includes(".")) return;
  const safeName = domain.replace(/[^a-z0-9]/gi, "-");
  const svcName = `ws-publisher-${safeName}`;
  const proxyUrl = getOwnProxyUrl();
  const config = `# Auto-generated by Webstudio publisher — do not edit manually.
# Traefik will request a Let's Encrypt certificate for: ${domain}
http:
  routers:
    ws-custom-${safeName}-https:
      entryPoints:
        - https
      service: ${svcName}
      rule: Host(\`${domain}\`)
      tls:
        certResolver: letsencrypt
      priority: 10
    ws-custom-${safeName}-http:
      entryPoints:
        - http
      service: ${svcName}
      rule: Host(\`${domain}\`)
      priority: 10
  services:
    ${svcName}:
      loadBalancer:
        servers:
          - url: ${proxyUrl}
`;
  const configPath = join(TRAEFIK_DYNAMIC_DIR, `${domain}.yaml`);
  await writeFile(configPath, config, "utf8");
  log(`Wrote Traefik route config for ${domain}`);
};

/**
 * Check if a path exists.
 */
const pathExists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Patch generated +data.ts files so vike prerender gets a valid origin.
 *
 * During prerender (build time), pageContext.headers is empty → host="" →
 * url.origin becomes "https://url" (invalid) → loadResources fails silently →
 * no HTML files are generated.
 *
 * We replace the host-detection block with one that falls back to
 * WEBSTUDIO_PRERENDER_ORIGIN (set to BUILDER_INTERNAL_URL when running vite build).
 */
const PRERENDER_PATCH_FROM = [
  `  const host = headers.get("x-forwarded-host") || headers.get("host") || "";`,
  `  url.host = host;`,
  `  url.protocol = "https";`,
].join("\n");

const PRERENDER_PATCH_TO = [
  `  const host = headers.get("x-forwarded-host") || headers.get("host") || "";`,
  `  const prerenderOrigin = process.env.WEBSTUDIO_PRERENDER_ORIGIN;`,
  `  if (host) { url.host = host; url.protocol = "https:"; }`,
  `  else if (prerenderOrigin) { const o = new URL(prerenderOrigin); url.host = o.host; url.protocol = o.protocol; }`,
  `  else { url.protocol = "https:"; }`,
].join("\n");

const patchDataFilesForPrerender = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await patchDataFilesForPrerender(fullPath);
    } else if (entry.name === "+data.ts") {
      const content = await readFile(fullPath, "utf8");
      const patched = content.replace(PRERENDER_PATCH_FROM, PRERENDER_PATCH_TO);
      if (patched !== content) {
        await writeFile(fullPath, patched, "utf8");
        log(`  Patched prerender origin in ${fullPath}`);
      }
    }
  }
};

/**
 * Nginx / the proxy serve from /var/publish/$host. Bare wstd slugs (no dot) are
 * qualified with PUBLISHER_HOST to match the full hostname; custom domains (with
 * a dot) are used as-is.
 */
const qualifyPublishDomain = (domain) =>
  !domain.includes(".") && PUBLISHER_HOST
    ? `${domain}.${PUBLISHER_HOST}`
    : domain;

/**
 * Walk a directory and rewrite every .html / .xml file through `transform`.
 * .xml is included because the sitemaps protocol requires absolute URLs under
 * the host serving the sitemap, so each domain's copy is rewritten like the HTML.
 */
const transformOutputFiles = async (dir, transform) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await transformOutputFiles(fullPath, transform);
    } else if (entry.name.endsWith(".html") || entry.name.endsWith(".xml")) {
      const content = await readFile(fullPath, "utf8");
      const fixed = transform(content);
      if (fixed !== content) {
        await writeFile(fullPath, fixed, "utf8");
        log(`  Updated URLs in ${fullPath}`);
      }
    }
  }
};

// ─── Docker mode: container routing ──────────────────────────────────────────

// hostname (publishDomain or customDomain) → Docker container name
// The proxy connects to <containerName>:3000 on DOCKER_NETWORK.
const dockerHostContainer = new Map();

// hostname (local staging domain only) → Cloudflare Pages project name.
// The proxy reverse-proxies to <cfProjectName>.pages.dev so the staging URL
// keeps working after a site moves to Cloudflare — a custom domain never
// goes through this map, its DNS points straight at Cloudflare.
const cfProjectHost = new Map();

// ─── Docker mode: site Dockerfile template ───────────────────────────────────

// Multi-stage Dockerfile written into each domain's workDir before `docker build`.
// Adapted from @m8jj's template for the react-router-docker webstudio template:
//   - npm layer cache via BuildKit cache mounts (requires DOCKER_BUILDKIT=1)
//   - prod-only deps in the final image (--omit=dev)
//   - build output: build/server/ + build/client/ (no public/ — included in build/client/)
const DOCKER_SITE_DOCKERFILE = `\
FROM node:22-alpine AS dependencies-env
COPY package.json /app/
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \\
    npm install --package-lock-only --legacy-peer-deps
RUN --mount=type=cache,target=/root/.npm \\
    npm ci --prefer-offline --omit=dev --legacy-peer-deps

FROM dependencies-env AS build-env
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \\
    npm ci --prefer-offline --legacy-peer-deps
COPY . /app/
RUN node /app/patch-navlink.cjs
RUN --mount=type=cache,target=/root/.npm \\
    npm run build

FROM node:22-alpine
COPY package.json /app/
COPY --from=dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
WORKDIR /app
CMD ["npm", "run", "start"]
`;

/**
 * Sanitize a domain into a valid Cloudflare Pages project name.
 * CF Pages project names must match [a-z0-9][a-z0-9-]*[a-z0-9] and be ≤ 58 chars.
 */
const toCfProjectName = (domain) =>
  domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);

// ─── Build pipelines ──────────────────────────────────────────────────────────

/**
 * Deploy to Cloudflare Pages for the given build.
 *
 * Workflow:
 *   1. webstudio sync
 *   2. webstudio build --template cloudflare
 *   3. npm install (first time, or when switching from another template)
 *   4. npm run build  (remix vite:build → build/client/)
 *   5. wrangler pages project create <cfProjectName>   (first time)
 *   6. wrangler pages deploy ./build/client --project-name <cfProjectName>
 *   7. attach any custom domains to the Pages project (Cloudflare API — wrangler
 *      has no CLI command for this)
 */
// The cloudflare template pins wrangler (^3.63.2) as a devDependency, so `npm
// install` in step 3 already gives every workDir its own pinned copy at
// node_modules/.bin/wrangler. Run that one instead of a global install: a
// global `npm install -g wrangler` always resolves to latest, which drifts
// out from under the template's pin the moment a new wrangler major ships —
// exactly what caused the wrangler 4 `pages project create` breakage below.
const wranglerBin = "./node_modules/.bin/wrangler";

/**
 * Create the Pages project unless it already exists.
 *
 * wrangler 3 created the project implicitly on the first `pages deploy`.
 * wrangler 4 removed that and hard-fails with `The Pages project "<name>"
 * does not exist`, so a first publish could never succeed.
 *
 * Creating up front is correct on both majors. A create against an existing
 * project exits non-zero, which is the normal path on every publish after the
 * first, so failures are logged and swallowed: if the create failed for a real
 * reason (bad token, wrong account) the deploy that follows fails with a
 * clearer message than anything we could produce here.
 */
const ensureCfPagesProject = async (cfProjectName, run) => {
  try {
    await run(
      `${wranglerBin} pages project create ${cfProjectName} --production-branch ${CF_PRODUCTION_BRANCH}`,
      {
        CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
      }
    );
    log(`Created Cloudflare Pages project "${cfProjectName}"`);
  } catch (err) {
    log(
      `Cloudflare Pages project "${cfProjectName}" was not created (it most likely already exists): ${err.message.split("\n")[0]}`
    );
  }
};

/**
 * Attach a custom domain to a Pages project via the Cloudflare API.
 *
 * wrangler has no CLI command for this (`wrangler pages project` is limited
 * to create/delete/list — see `--help`), so this is the only way to automate
 * it. Attaching only registers the domain on the Pages project; Cloudflare
 * still needs a DNS record (typically a CNAME to `<project>.pages.dev`)
 * pointing at it, which is the user's to create — same division of
 * responsibility as the Pages project itself never being deleted.
 *
 * Idempotent: attaching a domain that is already attached to this project
 * returns an error from the API, which is logged and swallowed so a
 * republish doesn't fail on it. A domain attached to a *different* Pages
 * project fails the same way and needs the user's attention, which the
 * logged error message provides.
 */
const ensureCfPagesDomain = async (cfProjectName, domain) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${cfProjectName}/domains`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: domain }),
    }
  );
  const result = await response.json();
  if (result.success) {
    log(`Attached custom domain "${domain}" to Cloudflare Pages project "${cfProjectName}"`);
  } else {
    const message = result.errors?.[0]?.message ?? response.statusText;
    log(`Custom domain "${domain}" was not attached to "${cfProjectName}" (it most likely already is): ${message}`);
  }
};

const publishBuildCloudflare = async ({ buildId }) => {
  log(`Starting Cloudflare publish for build ${buildId}`);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);
  if (customDomains.length > 0) {
    log(`Custom domains: ${customDomains.join(", ")}`);
  }

  // Only used to find what a previous publish left behind locally.
  const publishDomain = qualifyPublishDomain(domain);

  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });

  const run = async (cmd, extraEnv = {}) => {
    log(`  $ ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    if (stdout) log(`  stdout: ${stdout.trim()}`);
    if (stderr) log(`  stderr: ${stderr.trim()}`);
  };

  // Handle mode transitions → cloudflare. Without this a site that was
  // previously served locally stays served locally, in parallel with the Pages
  // deployment and diverging from it on every later publish.
  const stateFile = join(workDir, "state.json");
  try {
    const prevState = JSON.parse(await readFile(stateFile, "utf8"));
    if (prevState.mode === "docker") {
      await stopDockerForDomain(domain, prevState.containerName, prevState.publishDomain, prevState.customDomains ?? []);
      log(`Stopped Docker container for ${domain} (switching to Cloudflare)`);
    }
  } catch { /* no state.json — new domain, or previously SSG */ }

  // SSG leaves no state.json, so clear static output unconditionally rather
  // than on a detected transition.
  for (const hostname of [publishDomain, ...customDomains]) {
    await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
  }

  // 1. Sync build data
  log(`Syncing build data for ${domain}...`);
  await run(
    `webstudio sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=${SERVICE_TOKEN}`
  );

  // 2. Generate Cloudflare project code
  log(`Generating Cloudflare code for ${domain}...`);
  await run(`webstudio build --template cloudflare`);

  // 3. Install npm dependencies (first publish, or after a template switch).
  //
  // Testing only for the directory is not enough: an earlier ssg or docker
  // publish in the same workDir leaves a node_modules for a different
  // template, and the build then fails on missing remix binaries. Same marker
  // approach publishBuild uses for vike — @remix-run/cloudflare-pages is
  // unique to this template, so its absence means the tree belongs to another.
  const nodeModulesPath = join(workDir, "node_modules");
  let needsInstall = !(await pathExists(nodeModulesPath));
  if (!needsInstall) {
    try {
      await readFile(
        join(nodeModulesPath, "@remix-run/cloudflare-pages", "package.json"),
        "utf8"
      );
    } catch {
      log(`  node_modules belongs to another template — reinstalling`);
      await rm(nodeModulesPath, { recursive: true, force: true });
      needsInstall = true;
    }
  }
  if (needsInstall) {
    log(`Installing dependencies for ${domain}...`);
    await run(`npm install`);
  }

  // 4. Build with Remix/Vite
  log(`Building Cloudflare bundle for ${domain}...`);
  await run(`npm run build`);

  // 5. Deploy to Cloudflare Pages
  const cfProjectName = toCfProjectName(domain);
  await ensureCfPagesProject(cfProjectName, run);
  log(`Deploying ${domain} to Cloudflare Pages project "${cfProjectName}"...`);
  // --branch is explicit because workDir is not a git repository: left to
  // infer, wrangler cannot tell this is the production branch and the build
  // lands on a preview URL instead of <project>.pages.dev.
  await run(
    `${wranglerBin} pages deploy ./build/client --project-name ${cfProjectName} --branch ${CF_PRODUCTION_BRANCH}`,
    {
      CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    }
  );

  // 6. Attach custom domains to the Pages project. wrangler's CLI has no
  // command for this (only `pages project create/delete/list`), so it goes
  // through the Cloudflare API directly. Each domain still needs its own DNS
  // record pointing at the project — this only registers it on the Pages
  // side — and a domain already attached (republish) is left alone.
  for (const customDomain of customDomains) {
    await ensureCfPagesDomain(cfProjectName, customDomain);
  }

  // 7. Persist state and register the staging domain with the proxy, so
  // `<publishDomain>` reverse-proxies to `<cfProjectName>.pages.dev` instead
  // of 404ing — Pages itself needs no local process, but unpublish, delete,
  // and the proxy all look the site up by hostname here.
  cfProjectHost.set(publishDomain, cfProjectName);
  await writeFile(
    stateFile,
    JSON.stringify({ mode: "cloudflare", cfProjectName, publishDomain, customDomains }, null, 2) + "\n",
    "utf8"
  );

  log(`Successfully deployed ${domain} to Cloudflare Pages`);
};

/**
 * Sync the build and produce the static SSG output in workDir/dist/client/.
 *
 * Shared by the local SSG pipeline (publishBuild) and any pipeline that ships
 * the same static output elsewhere: both need the exact same sync → generate →
 * vite build, they only differ in what they do with the resulting directory.
 *
 * Absolute URLs in the output are rewritten from the Docker-internal origin to
 * `publicOrigin` (og:url, sitemap <loc>; og:image / twitter:image are made
 * absolute). Returns the dist dir.
 */
const buildSsgOutput = async ({ buildId, domain, workDir, publicOrigin }) => {
  const run = async (cmd) => {
    log(`  $ ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, { cwd: workDir, maxBuffer: 10 * 1024 * 1024 });
    if (stdout) log(`  stdout: ${stdout.trim()}`);
    if (stderr) log(`  stderr: ${stderr.trim()}`);
  };

  // 1. Sync build data (via URL interne Docker, pas besoin de passer par Traefik/TLS)
  log(`Syncing build data for ${domain}...`);
  await run(
    `webstudio sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=${SERVICE_TOKEN}`
  );

  // 2. Generate SSG project code (copies template + generates pages)
  // Clean stale generated files so renamed/deleted pages don't cause broken imports
  log(`Generating SSG code for ${domain}...`);
  await rm(join(workDir, "pages"), { recursive: true, force: true });
  await rm(join(workDir, "app"), { recursive: true, force: true });
  await run(`webstudio build --template ssg`);

  // 2b. Pin vike to the exact version the SSG template targets.
  const TARGET_VIKE = "0.4.229";
  const packageJsonPath = join(workDir, "package.json");
  const nodeModulesPath = join(workDir, "node_modules");

  let needsInstall = !(await pathExists(nodeModulesPath));
  if (!needsInstall) {
    try {
      const vikePkg = JSON.parse(
        await readFile(join(nodeModulesPath, "vike", "package.json"), "utf8")
      );
      if (vikePkg.version !== TARGET_VIKE) {
        log(`  vike ${vikePkg.version} installed but need ${TARGET_VIKE} — reinstalling`);
        await rm(nodeModulesPath, { recursive: true, force: true });
        needsInstall = true;
      }
    } catch {
      needsInstall = true;
    }
  }
  // Also reinstall when the @webstudio-is/* package versions changed (CLI upgrade).
  // The exports map of sdk-components-react changes between CLI versions; a stale
  // node_modules with an old version causes "Missing specifier" errors at build time.
  if (!needsInstall) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
      const declaredVersion = pkg.dependencies?.["@webstudio-is/sdk-components-react"];
      const installedPkg = JSON.parse(
        await readFile(join(nodeModulesPath, "@webstudio-is/sdk-components-react", "package.json"), "utf8")
      );
      if (declaredVersion && installedPkg.version !== declaredVersion) {
        log(`  @webstudio-is/sdk-components-react ${installedPkg.version} installed but need ${declaredVersion} — reinstalling`);
        await rm(nodeModulesPath, { recursive: true, force: true });
        needsInstall = true;
      }
    } catch {
      needsInstall = true;
    }
  }

  if (needsInstall) {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (pkg.dependencies?.vike) {
      pkg.dependencies.vike = TARGET_VIKE;
      await writeFile(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      log(`  Pinned vike to ${TARGET_VIKE} in package.json`);
    }
  }

  // 2c. Patch generated +data.ts files so vike prerender uses a valid origin
  log(`Patching generated data files for prerender...`);
  const pagesDir = join(workDir, "pages");
  if (await pathExists(pagesDir)) {
    await patchDataFilesForPrerender(pagesDir);
  }

  // 3. Install npm dependencies (first time, or after version pin change)
  if (needsInstall) {
    log(`Installing dependencies for ${domain}...`);
    await run(`npm install`);
  }

  // 4. Build static HTML with Vite + vike prerender
  log(`Building static site for ${domain}...`);
  // WEBSTUDIO_SITEMAP_ORIGIN makes the CLI emit sitemap.xml with absolute URLs.
  // The internal origin is used here and rewritten to the public one in 4b, and
  // again per custom domain in 5b, so every copy gets a spec-correct sitemap.
  await run(
    `WEBSTUDIO_PRERENDER_ORIGIN=${BUILDER_INTERNAL_URL} WEBSTUDIO_SITEMAP_ORIGIN=${BUILDER_INTERNAL_URL} npm run build`
  );

  // Check output
  const distDir = join(workDir, "dist", "client");
  const findHtmlFiles = async (dir) => {
    const found = [];
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) found.push(...(await findHtmlFiles(p)));
        else if (e.name.endsWith(".html")) found.push(p);
      }
    } catch { /* dir may not exist */ }
    return found;
  };
  const htmlFiles = await findHtmlFiles(distDir);
  if (htmlFiles.length === 0) {
    throw new Error(`Prerender produced no HTML files. Check vite build output for errors.`);
  }

  // 4b. Fix absolute URLs in generated output:
  //   - og:url leaks the Docker-internal origin (e.g. http://app:3000) → replace with publicOrigin
  //   - og:image / twitter:image are relative paths → make absolute for social scrapers
  //   - sitemap.xml <loc> entries carry the same internal origin
  log(`Fixing absolute URLs in generated output...`);
  await transformOutputFiles(distDir, (html) => {
    let out = html.replaceAll(BUILDER_INTERNAL_URL, publicOrigin);
    out = out.replace(/(property="og:image"\s+content=")(\/[^"]*)/g, (_, prefix, path) => `${prefix}${publicOrigin}${path}`);
    out = out.replace(/(name="twitter:image"\s+content=")(\/[^"]*)/g, (_, prefix, path) => `${prefix}${publicOrigin}${path}`);
    return out;
  });

  return distDir;
};

/**
 * Generate static files for the given build and write them to /var/publish/,
 * one directory per hostname (the staging domain + each verified custom domain).
 * A previous runtime (Docker container, Cloudflare route) is torn down first.
 */
const publishBuild = async ({ buildId }) => {
  log(`Starting SSG publish for build ${buildId}`);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);
  if (customDomains.length > 0) {
    log(`Custom domains: ${customDomains.join(", ")}`);
  }

  const publishDomain = qualifyPublishDomain(domain);
  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });

  // Handle mode transitions → ssg
  const stateFile = join(workDir, "state.json");
  try {
    const prevState = JSON.parse(await readFile(stateFile, "utf8"));
    if (prevState.mode === "docker") {
      await stopDockerForDomain(domain, prevState.containerName, prevState.publishDomain, prevState.customDomains ?? []);
      await rm(stateFile, { force: true });
    } else if (prevState.mode === "cloudflare") {
      // Deleting the Pages project is a destructive call into the user's
      // Cloudflare account, so it is left alone deliberately. Say so, because
      // the site stays reachable at <project>.pages.dev after this publish.
      // The staging domain, though, now serves this SSG build again — drop
      // its reverse-proxy route or it would keep going to the old Cloudflare
      // deployment instead of the fresh /var/publish output below.
      cfProjectHost.delete(prevState.publishDomain);
      log(`${domain} was on Cloudflare Pages — project "${prevState.cfProjectName}" left in place and still live`);
      await rm(stateFile, { force: true });
    }
  } catch {
    // No state.json or unknown mode — nothing to stop
  }

  const publicOrigin = `https://${publishDomain}`;
  const distDir = await buildSsgOutput({ buildId, domain, workDir, publicOrigin });

  // 5. Copy built files to the serve directory
  const destDir = join(PUBLISH_DIR, publishDomain);
  log(`Publishing ${domain} to ${destDir}...`);
  await rm(destDir, { recursive: true, force: true });
  await cp(distDir, destDir, { recursive: true });

  // 5b. Also copy to each verified custom domain directory, rewriting the origin
  // baked in above to the custom domain.
  for (const customDomain of customDomains) {
    const customDestDir = join(PUBLISH_DIR, customDomain);
    log(`Publishing custom domain ${customDomain} to ${customDestDir}...`);
    await rm(customDestDir, { recursive: true, force: true });
    await cp(distDir, customDestDir, { recursive: true });
    log(`  Rewriting absolute URLs to https://${customDomain}...`);
    await transformOutputFiles(customDestDir, (html) => html.replaceAll(publicOrigin, `https://${customDomain}`));
    await writeTraefikRouteForDomain(customDomain);
  }

  log(`Successfully published ${domain}`);
};

// ─── SSR build pipeline (Docker containers) ──────────────────────────────────

/**
 * Sanitize a domain slug into a valid Docker image/container name.
 * Docker names must match [a-z0-9][a-z0-9_.-]* — we use a ws- prefix so
 * short slugs like "my-site" become "ws-my-site" and can't shadow system images.
 */
const toDockerName = (domain) =>
  "ws-" +
  domain
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Publish an SSR site as an isolated Docker container.
 *
 * Workflow:
 *   1. webstudio sync
 *   2. webstudio build --template docker
 *   3. Write DOCKER_SITE_DOCKERFILE into workDir
 *   4. docker build -t <image> .   ← built ONCE, reused for all hostnames
 *   5. docker stop/rm old container + docker run new one
 *   6. docker image prune -f
 *   7. Persist state.json + register all hostnames in dockerHostContainer (proxy)
 */
const publishBuildSsr = async ({ buildId }) => {
  log(`Starting Docker publish for build ${buildId}`);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);
  if (customDomains.length > 0) {
    log(`Custom domains: ${customDomains.join(", ")}`);
  }

  const publishDomain = qualifyPublishDomain(domain);

  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });

  const run = async (cmd, extraEnv = {}) => {
    log(`  $ ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    if (stdout) log(`  stdout: ${stdout.trim()}`);
    if (stderr) log(`  stderr: ${stderr.trim()}`);
  };

  // Handle mode transitions → docker
  const stateFile = join(workDir, "state.json");
  try {
    const prevState = JSON.parse(await readFile(stateFile, "utf8"));
    if (prevState.mode === "ssg") {
      // Remove stale static files so the proxy stops serving them directly
      for (const h of [prevState.publishDomain ?? publishDomain, ...(prevState.customDomains ?? [])]) {
        await rm(join(PUBLISH_DIR, h), { recursive: true, force: true });
      }
      log(`Removed stale SSG output for ${domain}`);
    } else if (prevState.mode === "cloudflare") {
      // Same as the SSG path: the Pages project is the user's to delete. The
      // staging domain moves to this Docker container instead, so drop its
      // reverse-proxy route or it would keep going to Cloudflare.
      cfProjectHost.delete(prevState.publishDomain);
      log(`${domain} was on Cloudflare Pages — project "${prevState.cfProjectName}" left in place and still live`);
    }
    // mode: "docker" → old container is stopped in step 6 below
  } catch { /* no state.json — new domain */ }

  // 1. Sync build data
  log(`Syncing build data for ${domain}...`);
  await run(
    `webstudio sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=${SERVICE_TOKEN}`
  );

  // 2. Generate Docker project code (react-router-docker template)
  log(`Generating Docker code for ${domain}...`);
  await run(`webstudio build --template docker`);

  // 2b. Patch [_image].$.ts:
  //   - Fix storage root: template uses "./public" but Vite moves assets into
  //     build/client/ and public/ is absent from the final multi-stage image.
  //   - Add persistent disk cache: ipxFSCache({ dir: "/var/cache/ipx" }) so
  //     processed images survive container restarts (volume mounted in docker run).
  const imageRoutePath = join(workDir, "app/routes/[_image].$.ts");
  try {
    let imageRouteCode = await readFile(imageRoutePath, "utf8");
    // Fix storage root
    imageRouteCode = imageRouteCode.replace(
      /ipxFSStorage\(\{[^}]*dir:\s*["']\.\/public["'][^}]*\}\)/g,
      'ipxFSStorage({ dir: "./build/client" })'
    );
    // Add ipxFSCache to the import from "ipx"
    imageRouteCode = imageRouteCode.replace(
      /import\s*\{([^}]*)\}\s*from\s*["']ipx["']/,
      (_, imports) =>
        imports.includes("ipxFSCache")
          ? `import {${imports}} from "ipx"`
          : `import {${imports.replace(/,?\s*$/, "")},\n  ipxFSCache,\n} from "ipx"`
    );
    // Inject cache option into createIPX({ storage: ... })
    imageRouteCode = imageRouteCode.replace(
      /(storage:\s*ipxFSStorage\([^)]+\))(\s*\})/,
      (_, storage, closing) =>
        `${storage}, cache: ipxFSCache({ dir: "/var/cache/ipx" })${closing}`
    );
    await writeFile(imageRoutePath, imageRouteCode, "utf8");
    log(`Patched [_image].$.ts for ${domain}`);
  } catch { /* file absent in older CLI versions — skip */ }

  // 2c. Write NavLink patch script — run inside the Docker build after npm ci to fix
  // aria-current="page" being applied to all /#section links in SSR. The npm CLI
  // installs @webstudio-is/sdk-components-react-router from the upstream registry so
  // we patch its compiled lib/components.js before webpack compiles the site.
  await writeFile(join(workDir, "patch-navlink.cjs"), `
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const p = "./node_modules/@webstudio-is/sdk-components-react-router/lib/components.js";
if (!existsSync(p)) { console.log("NavLink patch: file not found, skipping"); process.exit(0); }
let c = readFileSync(p, "utf8");
const patched = c.replace(
  /href\\.startsWith\\("\\/"\\) && href\\.startsWith\\(assetBaseUrl\\) === false(?! && href\\.startsWith\\("\\\/#"\\))/g,
  'href.startsWith("/") && href.startsWith(assetBaseUrl) === false && href.startsWith("/#") === false'
);
if (patched !== c) {
  writeFileSync(p, patched);
  console.log("NavLink patch: applied");
} else {
  console.log("NavLink patch: pattern not found (already patched or upstream changed)");
}
`);

  // 3. Write optimized multi-stage Dockerfile (BuildKit cache mounts)
  await writeFile(join(workDir, "Dockerfile"), DOCKER_SITE_DOCKERFILE, "utf8");
  log(`Wrote Dockerfile for ${domain}`);

  // 4. Build image once — shared across all hostnames (@m8jj skip-build pattern)
  const imageName = toDockerName(domain);
  log(`Building Docker image ${imageName}...`);
  await run(`docker build -t ${imageName} .`, { DOCKER_BUILDKIT: "1" });

  // 5. Stop/remove old container + start fresh one on the shared Docker network
  const containerName = imageName;
  log(`Deploying container ${containerName}...`);
  try { await run(`docker stop ${containerName}`); } catch {}
  try { await run(`docker rm ${containerName}`); } catch {}
  await run(
    `docker run -d --restart=unless-stopped --network=${DOCKER_NETWORK} --name ${containerName} -v ${imageName}-ipx-cache:/var/cache/ipx -e IPX_HTTP_ALLOW_ALL_DOMAINS=true ${imageName}`
  );

  // 6. Prune dangling images from previous builds
  try { await run(`docker image prune -f`); } catch {}

  // 7. Persist state
  await writeFile(
    join(workDir, "state.json"),
    JSON.stringify({ mode: "docker", imageName, containerName, publishDomain, customDomains }, null, 2) + "\n",
    "utf8"
  );

  // 8. Register all hostnames → container name in the proxy (container:3000 on DOCKER_NETWORK)
  const allHostnames = [publishDomain, ...customDomains];
  for (const hostname of allHostnames) {
    dockerHostContainer.set(hostname, containerName);
    await writeTraefikRouteForDomain(hostname);
  }

  log(`Successfully published Docker site ${domain} (container ${containerName})`);
};

// ─── Site proxy (SSR + SSG) ───────────────────────────────────────────────────

/**
 * Unified HTTP proxy that serves all published Webstudio sites:
 *   - SSR domains       → reverse-proxied to their Docker container (:3000)
 *   - Cloudflare domains → the staging hostname is proxied to <project>.pages.dev
 *   - SSG domains       → served directly from /var/publish/<host>/
 *
 * The self-host stack should route *.PUBLISHER_HOST traffic here (PROXY_PORT).
 */
const proxyServer = createServer(async (req, res) => {
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(":")[0];

  // Docker SSR: proxy to container by name on DOCKER_NETWORK (port 3000)
  const dockerContainer = dockerHostContainer.get(host);
  if (dockerContainer !== undefined) {
    const proxyReq = httpRequest(
      {
        hostname: dockerContainer,
        port: 3000,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      }
    );
    proxyReq.on("error", (err) => {
      logErr(`Docker proxy error for ${host} → ${dockerContainer}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Docker proxy error");
      }
    });
    req.pipe(proxyReq, { end: true });
    return;
  }

  // Cloudflare Pages: reverse-proxy to <cfProjectName>.pages.dev so the local
  // staging domain keeps working after a site moves to Cloudflare, instead of
  // 404ing on the now-empty /var/publish/<host>/. Host is rewritten to the
  // pages.dev hostname — that's what Cloudflare routes on.
  const cfProjectName = cfProjectHost.get(host);
  if (cfProjectName !== undefined) {
    const pagesHost = `${cfProjectName}.pages.dev`;
    const proxyReq = httpsRequest(
      {
        hostname: pagesHost,
        port: 443,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: pagesHost },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      }
    );
    proxyReq.on("error", (err) => {
      logErr(`Cloudflare Pages proxy error for ${host} → ${pagesHost}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Cloudflare Pages proxy error");
      }
    });
    req.pipe(proxyReq, { end: true });
    return;
  }

  // SSG: serve static files from /var/publish/<host>/
  const served = await tryServeStaticFile(req, res, host);
  if (!served) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

// ─── Unpublish ────────────────────────────────────────────────────────────────

const removeTraefikRouteForDomain = async (domain) => {
  if (!TRAEFIK_DYNAMIC_DIR || !domain.includes(".")) return;
  await rm(join(TRAEFIK_DYNAMIC_DIR, `${domain}.yaml`), { force: true });
};

/**
 * Drop a single hostname from a site that still has other hostnames.
 * state.json is rewritten to list exactly the hostnames that remain live, so a
 * later restoreTargets() does not re-register the removed one.
 */
const removeHostname = async (stateFile, state, hostname, remaining) => {
  log(`Removing hostname ${hostname} (site keeps ${remaining.join(", ")})`);
  dockerHostContainer.delete(hostname);
  await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
  await removeTraefikRouteForDomain(hostname);
  const [publishDomain, ...customDomains] = remaining;
  await writeFile(
    stateFile,
    JSON.stringify({ ...state, publishDomain, customDomains }, null, 2) + "\n",
    "utf8"
  );
};

/**
 * Tear a site down completely: its runtime, every published copy, and the work
 * directory. Each docker step is best-effort so a missing container or volume
 * cannot stop the rest — what matters is that the site stops being served.
 */
const teardownSite = async (domain, state) => {
  const { mode, containerName, imageName, publishDomain, customDomains = [] } = state;
  const hostnames = [publishDomain, ...customDomains].filter(Boolean);
  log(`Tearing down ${domain} (mode ${mode ?? "ssg"})`);

  if (mode === "docker") {
    await stopDockerForDomain(domain, containerName, publishDomain, customDomains);
    if (imageName) {
      try { await execAsync(`docker rmi ${imageName}`); } catch {}
      try { await execAsync(`docker volume rm ${imageName}-ipx-cache`); } catch {}
    }
  } else if (mode === "cloudflare") {
    // Deleting someone's Cloudflare Pages project is a destructive call into
    // their account with different semantics from the local modes, so it is
    // deliberately left out here.
    log(`Cloudflare Pages project for ${domain} was NOT deleted — remove it from the Cloudflare dashboard`);
  }

  for (const hostname of hostnames) {
    dockerHostContainer.delete(hostname);
    await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
    await removeTraefikRouteForDomain(hostname);
  }

  // Last: while state.json exists, restoreTargets() restarts the site on
  // the next publisher boot, so removing it is what makes the teardown stick.
  await rm(join(WORK_DIR, domain), { recursive: true, force: true });
  log(`Tore down ${domain}`);
};

/**
 * Unpublish one hostname. Idempotent: unknown hostnames succeed as a no-op so
 * a retried or duplicated request cannot fail a project deletion.
 */
const unpublishHostname = async (hostname) => {
  let entries = [];
  try {
    entries = await readdir(WORK_DIR, { withFileTypes: true });
  } catch { /* nothing published yet */ }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const domain = entry.name;
    const stateFile = join(WORK_DIR, domain, "state.json");
    let state;
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
    } catch {
      continue;
    }
    const hostnames = [state.publishDomain, ...(state.customDomains ?? [])].filter(Boolean);
    if (hostnames.includes(hostname) === false) {
      continue;
    }
    const remaining = hostnames.filter((item) => item !== hostname);
    if (remaining.length > 0) {
      await removeHostname(stateFile, state, hostname, remaining);
      return { removed: true, teardown: false };
    }
    await teardownSite(domain, state);
    return { removed: true, teardown: true };
  }

  // No state.json claims this hostname. It can still have a published copy on
  // disk from an SSG publish whose work directory was removed, so clean that up.
  await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
  await removeTraefikRouteForDomain(hostname);
  log(`No site state found for ${hostname}, removed any leftover published files`);
  return { removed: false, teardown: false };
};

// ─── Publish target: renderMode × host ───────────────────────────────────────
//
// A publish target is two orthogonal axes — what to build (renderMode) and where
// it is served (host). This layer resolves an incoming /publish request to one
// pair and picks the pipeline. The pipeline bodies and the internal state.json
// `mode` field are unchanged; only the request → pipeline mapping lives here.

// Legacy `buildMode` wire value → { renderMode, host }. Still sent by the
// upstream `webstudio` npm CLI and by builder images predating the two-axis API.
const LEGACY_BUILD_MODE = {
  ssg: { renderMode: "ssg", host: "local" },
  ssr: { renderMode: "ssr", host: "local" },
  cloudflare: { renderMode: "ssg", host: "cloudflare" },
};

// `${renderMode}:${host}` → pipeline runner. `null` marks a planned target that
// is not implemented yet: it is answered with 501 (not 400) so the builder can
// tell "coming soon" apart from a bad request.
const RENDER_HOSTS = {
  "ssg:local": ({ buildId }) => publishBuild({ buildId }),
  "ssr:local": ({ buildId }) => publishBuildSsr({ buildId }),
  "ssg:cloudflare": ({ buildId }) => publishBuildCloudflare({ buildId }),
  "ssg:ssh": null, // webstudio-self-host#7
  "ssr:coolify": null, // webstudio-self-host#23
  "ssg:coolify": null, // webstudio-self-host#24
};

/**
 * Resolve a /publish body to a { renderMode, host } pair.
 * Prefers the explicit two-axis fields; falls back to the legacy `buildMode`.
 * Returns null when neither yields a known pair (caller answers 400).
 */
const normalizeTarget = (input) => {
  if (typeof input.renderMode === "string" || typeof input.host === "string") {
    return {
      renderMode: input.renderMode ?? "ssg",
      host: input.host ?? "local",
    };
  }
  return LEGACY_BUILD_MODE[input.buildMode ?? "ssg"] ?? null;
};

/**
 * The list of `${renderMode}:${host}` targets this publisher can actually run
 * right now, given its configuration. Consumed by GET /capabilities so the
 * builder can disable the targets it must not offer.
 */
const availableTargets = () => {
  const cloudflare = !!(CF_API_TOKEN && CF_ACCOUNT_ID);
  return Object.entries(RENDER_HOSTS)
    .filter(([key, runner]) => {
      if (runner === null) return false;
      if (key === "ssg:cloudflare") return cloudflare;
      return true;
    })
    .map(([key]) => key);
};

// ─── Build API server ─────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/publish") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }

      const { buildId, builderOrigin } = input;
      if (!buildId || !builderOrigin) {
        res.writeHead(400);
        res.end("Missing buildId or builderOrigin");
        return;
      }

      const target = normalizeTarget(input);
      if (target === null) {
        res.writeHead(400);
        res.end(`Unknown buildMode: ${input.buildMode}`);
        return;
      }

      const targetKey = `${target.renderMode}:${target.host}`;
      const runner = RENDER_HOSTS[targetKey];
      if (runner === undefined) {
        res.writeHead(400);
        res.end(`Unknown publish target: ${targetKey}`);
        return;
      }
      if (runner === null) {
        res.writeHead(501);
        res.end(`Publish target "${targetKey}" is not implemented yet`);
        return;
      }

      if (target.host === "cloudflare" && (!CF_API_TOKEN || !CF_ACCOUNT_ID)) {
        res.writeHead(400);
        res.end("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set for cloudflare builds");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));

      const tempDomainKey = `${builderOrigin}:${buildId}`;
      const q = getProjectQueue(tempDomainKey);

      q.current = q.current
        .then(() => runner({ buildId, builderOrigin }))
        .then(() => notifyBuildStatus(buildId, "PUBLISHED"))
        .catch((err) => {
          logErr(`Publish failed for build ${buildId}: ${err.message}`);
          notifyBuildStatus(buildId, "FAILED").catch((notifyErr) =>
            logErr(`Failed to notify FAILED status for ${buildId}: ${notifyErr.message}`)
          );
        });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/unpublish") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }
      const { domain } = input;
      if (!domain) {
        res.writeHead(400);
        res.end("Missing domain");
        return;
      }
      try {
        const result = await unpublishHostname(domain);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (error) {
        logErr(`Unpublish failed for ${domain}: ${error.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/capabilities") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        // `cloudflare` kept for builder images predating `targets`.
        cloudflare: !!(CF_API_TOKEN && CF_ACCOUNT_ID),
        coolify: false,
        ssh: false,
        // `${renderMode}:${host}` pairs this publisher can run right now.
        targets: availableTargets(),
      })
    );
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ─── Startup ──────────────────────────────────────────────────────────────────

// Check Docker socket + auto-detect DOCKER_NETWORK if not explicitly set
try {
  await execAsync("docker info");
} catch {
  logErr("Warning: Docker socket not accessible — the 'ssr' render mode will not work. Mount /var/run/docker.sock into this container.");
}

const ownHostname = process.env.HOSTNAME ?? "";

if (!DOCKER_NETWORK) {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${ownHostname}`
    );
    const networks = stdout.trim().replace(/'/g, "").split(/\s+/)
      .filter((n) => n && n !== "bridge" && n !== "host" && n !== "none");
    if (networks.length >= 1) {
      DOCKER_NETWORK = networks[0];
      log(`Auto-detected Docker network: ${DOCKER_NETWORK}${networks.length > 1 ? ` (others: ${networks.slice(1).join(", ")}) — set DOCKER_NETWORK to override` : ""}`);
    } else {
      logErr("Warning: could not detect a Docker network — SSR containers won't be reachable. Set DOCKER_NETWORK env var.");
    }
  } catch {
    logErr("Warning: DOCKER_NETWORK auto-detection failed — set DOCKER_NETWORK env var manually.");
  }
}

try {
  const { stdout } = await execAsync(
    `docker inspect --format '{{.Name}}' ${ownHostname}`
  );
  OWN_CONTAINER_NAME = stdout.trim().replace(/^\//, "");
  log(`Own container name: ${OWN_CONTAINER_NAME}`);
} catch {
  logErr("Warning: could not resolve own container name — Traefik configs will use IP (may break on container restart).");
}

await restoreTargets();

proxyServer.listen(PROXY_PORT, () => {
  log(`Site proxy listening on port ${PROXY_PORT}`);
});

server.listen(PORT, () => {
  log(`Publisher service listening on port ${PORT}`);
});
