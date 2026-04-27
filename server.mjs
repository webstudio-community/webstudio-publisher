/**
 * Self-hosted Webstudio publisher service.
 *
 * Receives publish requests from the builder app and generates static HTML files
 * (SSG) or runs a Node SSR server (SSR) depending on buildMode.
 *
 * Build modes (POST /publish { buildId, builderOrigin, buildMode }):
 *   ssg        — Vite prerender → static files in /var/publish/<domain>/
 *   cloudflare — React Router build + wrangler pages deploy
 *   ssr        — React Router build → react-router-serve subprocess + proxy on PROXY_PORT
 *
 * SSR proxy (port PROXY_PORT, default 4001):
 *   Serves all published sites — SSR domains are proxied to their subprocess,
 *   SSG domains are served directly from /var/publish/<domain>/.
 *   The self-host stack should route *.PUBLISHER_HOST traffic to this port.
 *
 * Environment variables:
 *   TRPC_SERVER_API_TOKEN  — service token to authenticate with the builder app
 *   BUILDER_INTERNAL_URL   — internal Docker URL for the builder (default: http://app:3000)
 *   PORT                   — build API HTTP port (default: 4000)
 *   PROXY_PORT             — site proxy HTTP port (default: 4001)
 *   SSR_PORT_BASE          — base port for react-router-serve subprocesses (default: 5000)
 *                            ports 5001, 5002… are assigned per domain
 */

import { createServer, request as httpRequest } from "node:http";
import { exec, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, cp, rm, access, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";

const execAsync = promisify(exec);

const PORT = process.env.PORT ?? "4000";
const PROXY_PORT = process.env.PROXY_PORT ?? "4001";
const SSR_PORT_BASE = parseInt(process.env.SSR_PORT_BASE ?? "5000");
const SERVICE_TOKEN = process.env.TRPC_SERVER_API_TOKEN ?? "";
const PUBLISHER_HOST = process.env.PUBLISHER_HOST ?? "";
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
// URL interne Docker pour joindre le builder sans passer par Traefik/TLS
const BUILDER_INTERNAL_URL = process.env.BUILDER_INTERNAL_URL ?? "http://app:3000";
const PUBLISH_DIR = "/var/publish";
const WORK_DIR = "/var/work";
// Shared node_modules seed — all SSR domains use the same template = same deps.
// First domain installs via npm; subsequent domains clone via hardlinks (~instant).
const SSR_SEED_DIR = join(WORK_DIR, ".ssr-seed");
// When set, the publisher writes a per-domain Traefik dynamic config file so
// Traefik can request a Let's Encrypt certificate for each custom domain.
// Mount /data/coolify/proxy/dynamic into the container and set this to that path.
const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR ?? "";
// Base port for Docker site containers. Each domain gets PORT_BASE+n (6001, 6002…).
// Persisted in state.json so ports survive publisher restarts.
const DOCKER_PORT_BASE = parseInt(process.env.DOCKER_PORT_BASE ?? "6000");

const log = (msg) => console.info(`[publisher] ${msg}`);
const logErr = (msg) => console.error(`[publisher] ${msg}`);

// ─── SSR process management ──────────────────────────────────────────────────

// domain (project slug) → port number (persisted across restarts via state.json)
const ssrDomainPort = new Map();
// hostname (publishDomain or customDomain) → port number (for proxy routing)
const ssrHostPort = new Map();
// domain (project slug) → ChildProcess
const ssrProcesses = new Map();
// Next available port for a new SSR domain
let nextSsrPort = SSR_PORT_BASE + 1;

/**
 * Return the persistent port for an SSR domain, allocating a new one if needed.
 */
const allocateSsrPort = (domain) => {
  if (ssrDomainPort.has(domain)) return ssrDomainPort.get(domain);
  const port = nextSsrPort++;
  ssrDomainPort.set(domain, port);
  return port;
};

/**
 * Start (or restart on republish) the react-router-serve process for an SSR site.
 * If a process is already running for this domain, it is killed first — the old
 * process keeps serving during the rebuild so there is no downtime.
 */
const startSsrProcess = (domain, workDir, port) => {
  const existing = ssrProcesses.get(domain);
  if (existing) {
    log(`Stopping previous SSR process for ${domain}`);
    try { existing.kill("SIGTERM"); } catch {}
    ssrProcesses.delete(domain);
  }

  const child = spawn(
    "node",
    ["node_modules/.bin/react-router-serve", "build/server/index.js"],
    {
      cwd: workDir,
      env: { ...process.env, PORT: String(port) },
      stdio: "pipe",
    }
  );

  child.stdout.on("data", (d) => log(`[ssr:${domain}] ${d.toString().trim()}`));
  child.stderr.on("data", (d) => logErr(`[ssr:${domain}] ${d.toString().trim()}`));
  child.on("exit", (code, signal) => {
    log(`[ssr:${domain}] process exited (code=${code}, signal=${signal})`);
    ssrProcesses.delete(domain);
  });

  ssrProcesses.set(domain, child);
  return child;
};

/**
 * Stop a running SSR process and remove its proxy routing entries.
 * Called when a domain is republished in SSG mode (mode switch).
 */
const stopSsrForDomain = (domain, publishDomain, customDomains) => {
  const proc = ssrProcesses.get(domain);
  if (proc) {
    log(`Stopping SSR process for ${domain} (switching to SSG)`);
    try { proc.kill("SIGTERM"); } catch {}
    ssrProcesses.delete(domain);
  }
  ssrHostPort.delete(publishDomain);
  for (const cd of customDomains) ssrHostPort.delete(cd);
  ssrDomainPort.delete(domain);
};

/**
 * On publisher startup, read state.json files and restart any SSR processes.
 */
const restoreSsrProcesses = async () => {
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
      if (state.mode !== "ssr") continue;

      const { port, publishDomain, customDomains = [] } = state;
      const workDir = join(WORK_DIR, domain);
      const serverEntry = join(workDir, "build", "server", "index.js");

      if (!(await pathExists(serverEntry))) {
        log(`Skipping SSR restore for ${domain}: build/server/index.js not found`);
        continue;
      }

      // Reconstruct port mappings
      ssrDomainPort.set(domain, port);
      if (port >= nextSsrPort) nextSsrPort = port + 1;
      ssrHostPort.set(publishDomain, port);
      for (const cd of customDomains) ssrHostPort.set(cd, port);

      startSsrProcess(domain, workDir, port);
      log(`Restored SSR process for ${domain} (port ${port})`);
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
 * Fetch build data from the builder app and extract the project domain + custom domains.
 */
const getProjectBuildInfo = async (buildId) => {
  const url = new URL(`/rest/build/${buildId}`, BUILDER_INTERNAL_URL);
  const response = await fetch(url.href, {
    headers: { Authorization: SERVICE_TOKEN },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch build ${buildId}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  if (!data.projectDomain) {
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
  const url = new URL(`/rest/build/${buildId}/status`, BUILDER_INTERNAL_URL);
  try {
    const response = await fetch(url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: SERVICE_TOKEN,
      },
      body: JSON.stringify({ publishStatus }),
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
 * Cross-provider references (ws-publisher-svc@docker) don't work reliably in Traefik v3
 * file-provider configs, so we define the service inline with a direct IP+port URL.
 */
const getOwnProxyUrl = () => {
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

// ─── Docker mode: port management ────────────────────────────────────────────

// domain (project slug) → allocated host port
const dockerDomainPort = new Map();
let nextDockerPort = DOCKER_PORT_BASE + 1;

const allocateDockerPort = (domain) => {
  if (dockerDomainPort.has(domain)) return dockerDomainPort.get(domain);
  const port = nextDockerPort++;
  dockerDomainPort.set(domain, port);
  return port;
};

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
    npm install --package-lock-only
RUN --mount=type=cache,target=/root/.npm \\
    npm ci --prefer-offline --omit=dev

FROM dependencies-env AS build-env
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \\
    npm ci --prefer-offline
COPY . /app/
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
 *   3. npm install (first time)
 *   4. npm run build  (remix vite:build → build/client/)
 *   5. wrangler pages deploy ./build/client --project-name <cfProjectName>
 */
let wranglerInstalled = false;
const ensureWrangler = async () => {
  if (wranglerInstalled) return;
  try {
    await execAsync("wrangler --version");
    wranglerInstalled = true;
  } catch {
    log("Installing wrangler (first Cloudflare publish)...");
    await execAsync("npm install -g wrangler");
    wranglerInstalled = true;
  }
};

const publishBuildCloudflare = async ({ buildId }) => {
  log(`Starting Cloudflare publish for build ${buildId}`);
  await ensureWrangler();

  const { projectDomain: domain } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);

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

  // 1. Sync build data
  log(`Syncing build data for ${domain}...`);
  await run(
    `webstudio sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=${SERVICE_TOKEN}`
  );

  // 2. Generate Cloudflare project code
  log(`Generating Cloudflare code for ${domain}...`);
  await run(`webstudio build --template cloudflare`);

  // 3. Install npm dependencies (first publish only)
  const nodeModulesPath = join(workDir, "node_modules");
  if (!(await pathExists(nodeModulesPath))) {
    log(`Installing dependencies for ${domain}...`);
    await run(`npm install`);
  }

  // 4. Build with Remix/Vite
  log(`Building Cloudflare bundle for ${domain}...`);
  await run(`npm run build`);

  // 5. Deploy to Cloudflare Pages
  const cfProjectName = toCfProjectName(domain);
  log(`Deploying ${domain} to Cloudflare Pages project "${cfProjectName}"...`);
  await run(
    `wrangler pages deploy ./build/client --project-name ${cfProjectName}`,
    {
      CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    }
  );

  log(`Successfully deployed ${domain} to Cloudflare Pages`);
};

/**
 * Generate static files for the given build and write to /var/publish/<domain>/.
 * If the domain previously had an SSR process running, it is stopped first.
 */
const publishBuild = async ({ buildId, builderOrigin }) => {
  log(`Starting SSG publish for build ${buildId}`);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);
  if (customDomains.length > 0) {
    log(`Custom domains: ${customDomains.join(", ")}`);
  }

  // Nginx / proxy serves from /var/publish/$host — for wstd slugs (no dot), append
  // PUBLISHER_HOST to match the full hostname. Custom domains are used as-is.
  const publishDomain =
    !domain.includes(".") && PUBLISHER_HOST
      ? `${domain}.${PUBLISHER_HOST}`
      : domain;

  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });

  // Stop any running SSR process for this domain (mode switch SSR→SSG)
  const stateFile = join(workDir, "state.json");
  try {
    const prevState = JSON.parse(await readFile(stateFile, "utf8"));
    if (prevState.mode === "ssr") {
      stopSsrForDomain(domain, prevState.publishDomain, prevState.customDomains ?? []);
      await rm(stateFile, { force: true });
    }
  } catch {
    // No state.json or not SSR — nothing to stop
  }

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
  log(`Generating SSG code for ${domain}...`);
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
  await run(`WEBSTUDIO_PRERENDER_ORIGIN=${BUILDER_INTERNAL_URL} npm run build`);

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

  // 5. Copy built files to the serve directory
  const destDir = join(PUBLISH_DIR, publishDomain);
  log(`Publishing ${domain} to ${destDir}...`);
  await rm(destDir, { recursive: true, force: true });
  await cp(distDir, destDir, { recursive: true });

  // 5b. Also copy to each verified custom domain directory.
  for (const customDomain of customDomains) {
    const customDestDir = join(PUBLISH_DIR, customDomain);
    log(`Publishing custom domain ${customDomain} to ${customDestDir}...`);
    await rm(customDestDir, { recursive: true, force: true });
    await cp(distDir, customDestDir, { recursive: true });
    await writeTraefikRouteForDomain(customDomain);
  }

  log(`Successfully published ${domain}`);
};

/**
 * Build an SSR site using the react-router-docker template and start a
 * react-router-serve subprocess. The site is served via the proxy on PROXY_PORT.
 *
 * Workflow:
 *   1. webstudio sync
 *   2. webstudio build --template docker
 *   3. npm install (first time, or if switching from SSG)
 *   4. npm run build  (react-router build → build/server/index.js)
 *   5. start/restart react-router-serve on allocated port
 */
/**
 * Install SSR dependencies for a domain workDir.
 *
 * All SSR domains are scaffolded from the same react-router-docker template and
 * end up with an identical package.json. To avoid a full npm install for every
 * new domain we keep a seed at SSR_SEED_DIR:
 *   - First call: runs npm install, then hard-links node_modules into the seed.
 *   - Subsequent calls: clones the seed via cp -al (hardlinks — near-instant,
 *     no extra disk space, same /var/work volume so same filesystem).
 * The seed is invalidated when package.json changes (e.g. webstudio CLI update).
 */
const installSsrDeps = async (workDir, run) => {
  const nodeModulesPath = join(workDir, "node_modules");
  const seedNodeModules = join(SSR_SEED_DIR, "node_modules");
  const seedPkg = join(SSR_SEED_DIR, "package.json");
  const currentPkg = join(workDir, "package.json");

  let seedValid = false;
  if (await pathExists(seedNodeModules) && await pathExists(seedPkg)) {
    try {
      const [a, b] = await Promise.all([
        readFile(seedPkg, "utf8"),
        readFile(currentPkg, "utf8"),
      ]);
      seedValid = a === b;
    } catch { /* seed check failed — fall through to full install */ }
  }

  if (seedValid) {
    log(`Cloning deps from seed via hardlinks...`);
    await execAsync(`cp -al "${seedNodeModules}" "${nodeModulesPath}"`);
    return;
  }

  await run(`npm install`);

  // Save or refresh the seed
  log(`Saving deps seed for future installs...`);
  await mkdir(SSR_SEED_DIR, { recursive: true });
  if (await pathExists(seedNodeModules)) {
    await rm(seedNodeModules, { recursive: true, force: true });
  }
  await execAsync(`cp -al "${nodeModulesPath}" "${seedNodeModules}"`);
  await cp(currentPkg, seedPkg);
};

const publishBuildSsr = async ({ buildId }) => {
  log(`Starting SSR publish for build ${buildId}`);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);
  if (customDomains.length > 0) {
    log(`Custom domains: ${customDomains.join(", ")}`);
  }

  const publishDomain =
    !domain.includes(".") && PUBLISHER_HOST
      ? `${domain}.${PUBLISHER_HOST}`
      : domain;

  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });

  const run = async (cmd) => {
    log(`  $ ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout) log(`  stdout: ${stdout.trim()}`);
    if (stderr) log(`  stderr: ${stderr.trim()}`);
  };

  // 1. Sync build data
  log(`Syncing build data for ${domain}...`);
  await run(
    `webstudio sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=${SERVICE_TOKEN}`
  );

  // 2. Generate SSR code with Docker template (react-router-docker)
  log(`Generating SSR code for ${domain}...`);
  await run(`webstudio build --template docker`);

  // 3. Install dependencies.
  // Force a clean install when switching from SSG: vike/SSG deps are incompatible
  // with the react-router template, and the old dist/client dir signals a prior SSG build.
  const nodeModulesPath = join(workDir, "node_modules");
  const wasSsg = await pathExists(join(workDir, "dist", "client"));
  if (wasSsg) {
    log(`Detected previous SSG build — clearing node_modules for clean SSR install`);
    await rm(nodeModulesPath, { recursive: true, force: true });
    // Remove stale SSG static output so the proxy stops serving it
    const publishDestDir = join(PUBLISH_DIR, publishDomain);
    if (await pathExists(publishDestDir)) {
      await rm(publishDestDir, { recursive: true, force: true });
      log(`Removed stale SSG output at ${publishDestDir}`);
    }
  }

  if (!(await pathExists(nodeModulesPath))) {
    log(`Installing dependencies for ${domain}...`);
    await installSsrDeps(workDir, run);
  }

  // 4. Build
  log(`Building SSR bundle for ${domain}...`);
  await run(`npm run build`);

  const serverEntry = join(workDir, "build", "server", "index.js");
  if (!(await pathExists(serverEntry))) {
    throw new Error(`SSR build produced no server entry. Expected: ${serverEntry}`);
  }

  // 5. Allocate port + persist state so the process is restored on container restart
  const port = allocateSsrPort(domain);
  await writeFile(
    join(workDir, "state.json"),
    JSON.stringify({ mode: "ssr", port, publishDomain, customDomains }, null, 2) + "\n",
    "utf8"
  );

  // 6. Register host → port mappings for the proxy
  ssrHostPort.set(publishDomain, port);
  for (const cd of customDomains) {
    ssrHostPort.set(cd, port);
    await writeTraefikRouteForDomain(cd);
  }

  // 7. Start (or hot-swap) the SSR subprocess — old process keeps serving during build
  log(`Starting SSR process for ${domain} on port ${port}...`);
  startSsrProcess(domain, workDir, port);

  log(`Successfully published SSR site ${domain} (subprocess port ${port})`);
};

// ─── Site proxy (SSR + SSG) ───────────────────────────────────────────────────

/**
 * Unified HTTP proxy that serves all published Webstudio sites:
 *   - SSR domains  → reverse-proxied to their react-router-serve subprocess
 *   - SSG domains  → served directly from /var/publish/<host>/
 *
 * The self-host stack should route *.PUBLISHER_HOST traffic here (PROXY_PORT).
 */
const proxyServer = createServer(async (req, res) => {
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(":")[0];

  // SSR: proxy to the react-router-serve subprocess
  const ssrPort = ssrHostPort.get(host);
  if (ssrPort !== undefined) {
    const proxyReq = httpRequest(
      {
        hostname: "127.0.0.1",
        port: ssrPort,
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
      logErr(`SSR proxy error for ${host}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("SSR proxy error");
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

      const { buildId, builderOrigin, buildMode = "ssg" } = input;
      if (!buildId || !builderOrigin) {
        res.writeHead(400);
        res.end("Missing buildId or builderOrigin");
        return;
      }

      if (buildMode !== "ssg" && buildMode !== "cloudflare" && buildMode !== "ssr") {
        res.writeHead(400);
        res.end(`Unknown buildMode: ${buildMode}`);
        return;
      }

      if (buildMode === "cloudflare" && (!CF_API_TOKEN || !CF_ACCOUNT_ID)) {
        res.writeHead(400);
        res.end("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set for cloudflare builds");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));

      const tempDomainKey = `${builderOrigin}:${buildId}`;
      const q = getProjectQueue(tempDomainKey);
      const job =
        buildMode === "cloudflare"
          ? () => publishBuildCloudflare({ buildId })
          : buildMode === "ssr"
            ? () => publishBuildSsr({ buildId })
            : () => publishBuild({ buildId, builderOrigin });

      q.current = q.current
        .then(job)
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

  if (req.method === "GET" && req.url === "/capabilities") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cloudflare: !!(CF_API_TOKEN && CF_ACCOUNT_ID) }));
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

await restoreSsrProcesses();

proxyServer.listen(PROXY_PORT, () => {
  log(`Site proxy listening on port ${PROXY_PORT} (SSR + SSG)`);
});

server.listen(PORT, () => {
  log(`Publisher service listening on port ${PORT}`);
});
