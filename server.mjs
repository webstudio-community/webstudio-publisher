// Self-hosted Webstudio publisher: builds sites published from the builder, then
// serves them (local SSG/SSR) or ships them to Cloudflare, SSH or Coolify.
// The HTTP API and environment variables are documented in the README.

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { exec } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, cp, rm, rename, access, readdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { join, extname, dirname, basename } from "node:path";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import { createHash } from "node:crypto";

const execAsync = promisify(exec);

const PORT = process.env.PORT ?? "4000";
const PROXY_PORT = process.env.PROXY_PORT ?? "4001";
// Across all domains, 0 = unlimited.
const MAX_CONCURRENT_PUBLISHES = Math.max(
  0,
  Number.parseInt(process.env.MAX_CONCURRENT_PUBLISHES ?? "0", 10) || 0
);
const SERVICE_TOKEN = process.env.TRPC_SERVER_API_TOKEN ?? "";
const PUBLISHER_HOST = process.env.PUBLISHER_HOST ?? "";
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
// Creating and deploying a Pages project must use the same branch, or the
// deployment is filed as a preview.
const CF_PRODUCTION_BRANCH = process.env.CLOUDFLARE_PRODUCTION_BRANCH ?? "main";
// Registry the coolify host pushes site images to, e.g. ghcr.io/my-org.
const REGISTRY_URL = process.env.REGISTRY_URL ?? "";
const REGISTRY_USER = process.env.REGISTRY_USER ?? "";
const REGISTRY_TOKEN = process.env.REGISTRY_TOKEN ?? "";
const BUILDER_INTERNAL_URL = process.env.BUILDER_INTERNAL_URL ?? "http://app:3000";
const PUBLISH_DIR = "/var/publish";
const WORK_DIR = "/var/work";
// The CLI comes from the builder's /npm/ registry, so it always matches the
// builder. npx checks dist-tags.latest on every run.
process.env.NPM_CONFIG_CACHE ??= join(WORK_DIR, ".npm-cache");
const WEBSTUDIO_CLI = `npx --yes --@webstudio-community:registry=${BUILDER_INTERNAL_URL.replace(/\/+$/, "")}/npm/ @webstudio-community/cli`;
// Watched by Traefik's file provider (e.g. /data/coolify/proxy/dynamic): one
// config per custom domain lets Traefik issue its certificate.
const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR ?? "";
// Auto-detected at startup unless set.
let DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? "";
// Used in Traefik configs instead of the IP, which changes on restart.
let OWN_CONTAINER_NAME = "";

const log = (msg) => console.info(`[publisher] ${msg}`);
const logErr = (msg) => console.error(`[publisher] ${msg}`);

const SECRETS = [
  [SERVICE_TOKEN, "<REDACTED_BUILDER_TOKEN>"],
  [CF_API_TOKEN, "<REDACTED_CF_TOKEN>"],
  [REGISTRY_TOKEN, "<REDACTED_REGISTRY_TOKEN>"],
].filter(([secret]) => secret);

const redactSecrets = (text) =>
  SECRETS.reduce((acc, [secret, mask]) => acc.replaceAll(secret, mask), String(text));

// Detects when the CLI's pinSiteDependencies changed the deps, to force npm install.
const computeDepsHash = (pkg) => {
  const deps = {
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
    overrides: pkg.overrides || {},
  };
  const hash = createHash("sha256");
  hash.update(JSON.stringify(deps, Object.keys(deps).sort()));
  return hash.digest("hex");
};

const shouldReinstallDeps = async (nodeModulesPath, pkg) => {
  const hashFile = join(nodeModulesPath, ".ws-deps-hash");
  const currentHash = computeDepsHash(pkg);
  try {
    const storedHash = await readFile(hashFile, "utf8");
    return storedHash.trim() !== currentHash;
  } catch {
    return true;
  }
};

const updateDepsHash = async (nodeModulesPath, pkg) => {
  const hashFile = join(nodeModulesPath, ".ws-deps-hash");
  const hash = computeDepsHash(pkg);
  await writeFile(hashFile, hash + "\n", "utf8");
};

const PUBLISH_LOG_RETENTION = Math.max(1, Number.parseInt(process.env.PUBLISH_LOG_RETENTION ?? "5", 10) || 5);

// Logs of running publishes. Finished ones go to /var/work/<domain>/logs/<buildId>.log.
const activeLogs = new Map(); // buildId → { domain, startedAt, lines, currentStage }

const recordLogLine = (buildId, stage, text) => {
  const existing = activeLogs.get(buildId);
  if (!existing) return;
  const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const redacted = redactSecrets(text);
  existing.lines.push(`[${timestamp}] [${stage}] ${redacted}`);
};

// Must match failedStage in webstudio-fork's
// packages/trpc-interface/src/shared/deployment-contract.ts.
const stageRules = [
  [/\bcli\b.*\bsync\b/, "sync"],
  [/\bcli\b.*\bbuild\b/, "project-build"],
  [/\bnpm (install|ci)\b/, "setup"],
  [/\bnpm run build\b|\bdocker (buildx )?build\b/, "application-build"],
  [/\bwrangler\b|\brsync\b|\bssh\b|\bscp\b|\bdocker (push|compose|run|rm|stop)\b|\bcurl\b/, "deploy"],
];

const knownStages = new Set([
  "setup",
  "sync",
  "project-build",
  "application-build",
  "worker-build",
  "assets",
  "deploy",
  "finalize",
]);

const stageForCommand = (cmd) =>
  stageRules.find(([pattern]) => pattern.test(cmd))?.[1];

// A failure reports the last stage that started.
const markStage = (buildId, cmd) => {
  const entry = activeLogs.get(buildId);
  const stage = stageForCommand(cmd);
  if (entry && stage) entry.currentStage = stage;
};

const startLogCapture = (buildId, domain) => {
  activeLogs.set(buildId, {
    domain,
    startedAt: new Date().toISOString(),
    lines: [],
    currentStage: undefined,
  });
};

const finishLogCapture = async (buildId, outcome, failedStage) => {
  const entry = activeLogs.get(buildId);
  if (!entry) return;

  const { domain, startedAt, lines } = entry;
  const completedAt = new Date().toISOString();

  try {
    const logsDir = join(WORK_DIR, domain, "logs");
    await mkdir(logsDir, { recursive: true });

    const logPath = join(logsDir, `${buildId}.log`);
    const logContent = lines.join("\n") + "\n";
    await writeFile(logPath, logContent, "utf8");

    const metaPath = join(logsDir, `${buildId}.json`);
    const metadata = {
      buildId,
      startedAt,
      completedAt,
      outcome,
      failedStage,
    };
    await writeFile(metaPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");

    log(`Persisted logs for ${buildId} (${domain}) — outcome: ${outcome}`);
  } catch (err) {
    logErr(`Failed to persist logs for ${buildId}: ${err.message}`);
  }

  activeLogs.delete(buildId);

  try {
    const logsDir = join(WORK_DIR, domain, "logs");
    const entries = await readdir(logsDir);
    const metaFiles = entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        name: name.slice(0, -5), // remove .json
        stat: null,
      }));

    const withMtime = await Promise.all(
      metaFiles.map(async (entry) => {
        try {
          const st = await stat(join(logsDir, entry.name + ".log"));
          return { ...entry, mtime: st.mtimeMs };
        } catch {
          return { ...entry, mtime: 0 };
        }
      })
    );

    withMtime.sort((a, b) => b.mtime - a.mtime);
    for (let i = PUBLISH_LOG_RETENTION; i < withMtime.length; i++) {
      const name = withMtime[i].name;
      try {
        await rm(join(logsDir, `${name}.log`));
        await rm(join(logsDir, `${name}.json`));
      } catch {}
    }
  } catch {}
};

// Logs are returned base64url-encoded, in chunks.
const readPublishLog = async (buildId, domain, cursor) => {
  try {
    const logsDir = join(WORK_DIR, domain, "logs");
    const metaPath = join(logsDir, `${buildId}.json`);
    const logPath = join(logsDir, `${buildId}.log`);

    try {
      await access(metaPath);
    } catch {
      return { availability: "unavailable" };
    }

    const metaContent = await readFile(metaPath, "utf8");
    const meta = JSON.parse(metaContent);
    const { startedAt, completedAt, outcome, failedStage } = meta;

    const logContent = await readFile(logPath, "utf8");
    const logLines = logContent.trim().split("\n");

    const CHUNK_SIZE = 300_000; // bytes of base64url (≈ 225 KB of raw text)
    const encoded = Buffer.from(logContent).toString("base64url");
    const chunk = encoded.slice(cursor ?? 0, (cursor ?? 0) + CHUNK_SIZE);
    const complete = !chunk || (cursor ?? 0) + CHUNK_SIZE >= encoded.length;
    const nextCursor = complete ? undefined : (cursor ?? 0) + CHUNK_SIZE;

    return {
      availability: "available",
      outcome,
      logAvailability: "available",
      startedAt,
      completedAt,
      failedStage: knownStages.has(failedStage) ? failedStage : undefined,
      log: {
        encoding: "base64url",
        chunk,
        complete,
        nextCursor,
      },
    };
  } catch (err) {
    logErr(`Failed to read logs for ${buildId}: ${err.message}`);
    return { availability: "unavailable" };
  }
};

// Called when a site switches from docker to another mode.
const stopDockerForDomain = async (domain, containerName, publishDomain, customDomains) => {
  log(`Stopping Docker container ${containerName} for ${domain}`);
  try { await execAsync(`docker stop ${containerName}`); } catch {}
  try { await execAsync(`docker rm ${containerName}`); } catch {}
  dockerHostContainer.delete(publishDomain);
  for (const cd of customDomains) dockerHostContainer.delete(cd);
};

// Restores published sites on boot: restarts Docker containers and re-registers
// Cloudflare staging routes. SSG and SSH sites need nothing.
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
        // Staging domain only: custom domains point straight at Cloudflare.
        cfProjectHost.set(state.publishDomain, state.cfProjectName);
        log(`Restored Cloudflare Pages routing for ${domain} → ${state.cfProjectName}.pages.dev`);
      }
    } catch {
    }
  }
};

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

// Tries <path>, <path>.html, then <path>/index.html. Returns false on no match.
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
    }
  }
  return false;
};

// One publish at a time per domain.
const projectQueues = new Map();

// Excess jobs wait in FIFO order.
let activePublishes = 0;
const publishWaiters = [];

const acquirePublishSlot = async () => {
  if (MAX_CONCURRENT_PUBLISHES === 0) return;
  if (activePublishes >= MAX_CONCURRENT_PUBLISHES) {
    // The releasing job hands its slot over, so the count is unchanged.
    await new Promise((resolve) => publishWaiters.push(resolve));
    return;
  }
  activePublishes += 1;
};

const releasePublishSlot = () => {
  if (MAX_CONCURRENT_PUBLISHES === 0) return;
  const next = publishWaiters.shift();
  if (next) next();
  else activePublishes -= 1;
};

const getProjectQueue = (domain) => {
  const existing = projectQueues.get(domain);
  if (existing) return existing;
  const q = { current: Promise.resolve() };
  projectQueues.set(domain, q);
  return q;
};

const getProjectBuildInfo = async (buildId) => {
  const input = encodeURIComponent(JSON.stringify({ buildId }));
  const url = new URL(`/trpc/build.loadProjectBundleByBuildId?input=${input}`, BUILDER_INTERNAL_URL);
  const response = await fetch(url.href, {
    headers: { Authorization: SERVICE_TOKEN },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch build ${buildId}: ${redactSecrets(text.slice(0, 500))}`);
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
      logErr(`notifyBuildStatus(${buildId}, ${publishStatus}) failed: ${redactSecrets(text.slice(0, 200))}`);
    } else {
      log(`notifyBuildStatus(${buildId}, ${publishStatus}) OK`);
    }
  } catch (err) {
    logErr(`notifyBuildStatus(${buildId}, ${publishStatus}) error: ${redactSecrets(err.message)}`);
  }
};

// The container name survives restarts, unlike the IP.
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

// Lets Traefik request a Let's Encrypt certificate for the custom domain.
// The service is inlined: Traefik v3 file-provider routers cannot reliably
// resolve services from the docker provider.
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

const removeTraefikRouteForDomain = async (domain) => {
  if (!TRAEFIK_DYNAMIC_DIR || !domain.includes(".")) return;
  await rm(join(TRAEFIK_DYNAMIC_DIR, `${domain}.yaml`), { force: true });
};

const pathExists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// During prerender pageContext.headers is empty, so url.origin is invalid and
// loadResources fails silently: no HTML is generated. Fall back to
// WEBSTUDIO_PRERENDER_ORIGIN.
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

// Bare wstd slugs are qualified with PUBLISHER_HOST; custom domains are used as-is.
const qualifyPublishDomain = (domain) =>
  !domain.includes(".") && PUBLISHER_HOST
    ? `${domain}.${PUBLISHER_HOST}`
    : domain;

// .xml too: sitemaps require absolute URLs on the serving host.
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

// hostname → container name, reached at <container>:3000 on DOCKER_NETWORK.
const dockerHostContainer = new Map();

// Staging hostname → Pages project, proxied to <project>.pages.dev.
// Custom domains never reach this proxy.
const cfProjectHost = new Map();

// rollup 4.68.6 (rollup/rollup#6669) fails with "Code is nested too deeply" on
// musl, which every site build uses (node:22-alpine). Remove once fixed upstream.
const PINNED_ROLLUP = "4.68.5";

// Must run before any npm install. In the Docker build it also busts the cached
// `npm install --package-lock-only` layer.
const pinSiteDependencies = async (workDir) => {
  const packageJsonPath = join(workDir, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (pkg.overrides?.rollup === PINNED_ROLLUP) return false;
  pkg.overrides = { ...pkg.overrides, rollup: PINNED_ROLLUP };
  await writeFile(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  log(`  Pinned rollup to ${PINNED_ROLLUP} (overrides) in package.json`);
  return true;
};

// Based on @m8jj's react-router-docker template (BuildKit npm cache, prod-only deps).
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
# The SSR server imports @webstudio-is/* from these runtime node_modules (not
# bundled), so patch them too — otherwise the server-rendered HTML keeps the bug.
COPY patch-navlink.cjs /app/
RUN node /app/patch-navlink.cjs
# ipx serves optimized images for any host — baked in so a Coolify-hosted app
# needs no manual env var (the local SSR pipeline also passes it via -e).
ENV IPX_HTTP_ALLOW_ALL_DOMAINS=true
EXPOSE 3000
CMD ["npm", "run", "start"]
`;

// Pages project names: [a-z0-9][a-z0-9-]*[a-z0-9], at most 58 chars.
const toCfProjectName = (domain) =>
  domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);

// Use the wrangler pinned by the cloudflare template: a global install tracks
// latest and breaks when a new major ships.
const wranglerBin = "./node_modules/.bin/wrangler";

// wrangler 4 no longer creates the project on first deploy. Creating an existing
// project fails, the normal case after the first publish, so errors are
// swallowed: a real failure resurfaces in the deploy.
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

// wrangler has no command for this; the user still creates the DNS record.
// Errors are swallowed so republishing with an attached domain succeeds.
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

  const run = async (cmd, extraEnv = {}, stage = "build") => {
    const redactedCmd = redactSecrets(cmd);
    log(`  $ ${redactedCmd}`);
    recordLogLine(buildId, stage, `$ ${redactedCmd}`);
    markStage(buildId, cmd);
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      });
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
    } catch (err) {
      const stdout = err.stdout || "";
      const stderr = err.stderr || "";
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
      throw err;
    }
  };

  // Otherwise a previously local site keeps being served here in parallel.
  const stateFile = join(workDir, "state.json");
  try {
    const prevState = JSON.parse(await readFile(stateFile, "utf8"));
    if (prevState.mode === "docker") {
      await stopDockerForDomain(domain, prevState.containerName, prevState.publishDomain, prevState.customDomains ?? []);
      log(`Stopped Docker container for ${domain} (switching to Cloudflare)`);
    }
  } catch { /* no state.json — brand-new domain */ }

  // A stale /var/publish copy would otherwise be served in parallel.
  for (const hostname of [publishDomain, ...customDomains]) {
    await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
  }

  log(`Syncing build data for ${domain}...`);
  await run(
    `${WEBSTUDIO_CLI} sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=$WS_BUILDER_TOKEN`,
    { WS_BUILDER_TOKEN: SERVICE_TOKEN }
  );

  log(`Generating Cloudflare code for ${domain}...`);
  await run(`${WEBSTUDIO_CLI} build --template cloudflare`);

  // node_modules alone isn't enough: another template may have left it.
  // @remix-run/cloudflare-pages is unique to this template.
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
    await pinSiteDependencies(workDir);
    log(`Installing dependencies for ${domain}...`);
    await run(`npm install`);
    const packageJsonPath = join(workDir, "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    await updateDepsHash(nodeModulesPath, pkg);
  } else {
    try {
      const packageJsonPath = join(workDir, "package.json");
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (await shouldReinstallDeps(nodeModulesPath, pkg)) {
        log(`  Dependencies changed — reinstalling`);
        await rm(nodeModulesPath, { recursive: true, force: true });
        await run(`npm install`);
        await updateDepsHash(nodeModulesPath, pkg);
      }
    } catch (err) {
      logErr(`Error checking dependencies for ${domain}: ${err.message}`);
    }
  }

  log(`Building Cloudflare bundle for ${domain}...`);
  await run(`npm run build`);

  const cfProjectName = toCfProjectName(domain);
  await ensureCfPagesProject(cfProjectName, run);
  log(`Deploying ${domain} to Cloudflare Pages project "${cfProjectName}"...`);
  // workDir is not a git repo, so wrangler can't infer the production branch.
  await run(
    `${wranglerBin} pages deploy ./build/client --project-name ${cfProjectName} --branch ${CF_PRODUCTION_BRANCH}`,
    {
      CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    }
  );

  for (const customDomain of customDomains) {
    await ensureCfPagesDomain(cfProjectName, customDomain);
  }

  // Pages needs no local process, but the proxy, unpublish and delete look the
  // site up here, and the staging domain is proxied to <project>.pages.dev.
  cfProjectHost.set(publishDomain, cfProjectName);
  await writeFile(
    stateFile,
    JSON.stringify({ mode: "cloudflare", cfProjectName, publishDomain, customDomains }, null, 2) + "\n",
    "utf8"
  );

  log(`Successfully deployed ${domain} to Cloudflare Pages`);
};

// Shared by every SSG pipeline. Rewrites the internal origin in og:url and
// sitemaps to publicOrigin and makes og:image absolute. Returns the dist dir.
const buildSsgOutput = async ({ buildId, domain, workDir, publicOrigin }) => {
  const run = async (cmd, extraEnv = {}, stage = "build") => {
    const redactedCmd = redactSecrets(cmd);
    log(`  $ ${redactedCmd}`);
    recordLogLine(buildId, stage, `$ ${redactedCmd}`);
    markStage(buildId, cmd);
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      });
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
    } catch (err) {
      const stdout = err.stdout || "";
      const stderr = err.stderr || "";
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
      throw err;
    }
  };

  log(`Syncing build data for ${domain}...`);
  await run(
    `${WEBSTUDIO_CLI} sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=$WS_BUILDER_TOKEN`,
    { WS_BUILDER_TOKEN: SERVICE_TOKEN }
  );

  // Renamed or deleted pages would leave broken imports.
  log(`Generating SSG code for ${domain}...`);
  await rm(join(workDir, "pages"), { recursive: true, force: true });
  await rm(join(workDir, "app"), { recursive: true, force: true });
  await run(`${WEBSTUDIO_CLI} build --template ssg`);

  // Pin vike to the version the SSG template targets.
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
  // sdk-components-react's exports map changes between CLI versions: a stale
  // node_modules causes "Missing specifier" errors.
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

  log(`Patching generated data files for prerender...`);
  const pagesDir = join(workDir, "pages");
  if (await pathExists(pagesDir)) {
    await patchDataFilesForPrerender(pagesDir);
  }

  if (needsInstall) {
    await pinSiteDependencies(workDir);
    log(`Installing dependencies for ${domain}...`);
    await run(`npm install`);
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    await updateDepsHash(nodeModulesPath, pkg);
  } else {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (await shouldReinstallDeps(nodeModulesPath, pkg)) {
        log(`  Dependencies changed — reinstalling`);
        await rm(nodeModulesPath, { recursive: true, force: true });
        await pinSiteDependencies(workDir);
        await run(`npm install`);
        await updateDepsHash(nodeModulesPath, pkg);
      }
    } catch (err) {
      logErr(`Error checking dependencies for ${domain}: ${err.message}`);
    }
  }

  log(`Building static site for ${domain}...`);
  // The internal origin is rewritten to each public origin below.
  await run(
    `WEBSTUDIO_PRERENDER_ORIGIN=${BUILDER_INTERNAL_URL} WEBSTUDIO_SITEMAP_ORIGIN=${BUILDER_INTERNAL_URL} npm run build`
  );

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

  log(`Fixing absolute URLs in generated output...`);
  await transformOutputFiles(distDir, (html) => {
    let out = html.replaceAll(BUILDER_INTERNAL_URL, publicOrigin);
    out = out.replace(/(property="og:image"\s+content=")(\/[^"]*)/g, (_, prefix, path) => `${prefix}${publicOrigin}${path}`);
    out = out.replace(/(name="twitter:image"\s+content=")(\/[^"]*)/g, (_, prefix, path) => `${prefix}${publicOrigin}${path}`);
    return out;
  });

  return distDir;
};

// Copies to a hidden staging dir next to destDir, then swaps with renames.
// Dot-prefixed names can't match a request Host.
const publishDirAtomically = async (srcDir, destDir, prepare) => {
  const parent = dirname(destDir);
  const suffix = Date.now().toString(36);
  const stagingDir = join(parent, `.${basename(destDir)}.new-${suffix}`);
  const oldDir = join(parent, `.${basename(destDir)}.old-${suffix}`);
  await cp(srcDir, stagingDir, { recursive: true });
  try {
    if (prepare) await prepare(stagingDir);
    try {
      await rename(destDir, oldDir);
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // first publish — nothing to move aside
    }
    await rename(stagingDir, destDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
  await rm(oldDir, { recursive: true, force: true });
};

// One directory per hostname: the staging domain and each verified custom domain.
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

  const stateFile = join(workDir, "state.json");
  try {
    const prevState = JSON.parse(await readFile(stateFile, "utf8"));
    if (prevState.mode === "docker") {
      await stopDockerForDomain(domain, prevState.containerName, prevState.publishDomain, prevState.customDomains ?? []);
      await rm(stateFile, { force: true });
    } else if (prevState.mode === "cloudflare") {
      // The Pages project is left alone (destructive call into the user's account)
      // and stays reachable at <project>.pages.dev.
      cfProjectHost.delete(prevState.publishDomain);
      log(`${domain} was on Cloudflare Pages — project "${prevState.cfProjectName}" left in place and still live`);
      await rm(stateFile, { force: true });
    }
  } catch {
  }

  const publicOrigin = `https://${publishDomain}`;
  const distDir = await buildSsgOutput({ buildId, domain, workDir, publicOrigin });

  const destDir = join(PUBLISH_DIR, publishDomain);
  log(`Publishing ${domain} to ${destDir}...`);
  await publishDirAtomically(distDir, destDir);

  for (const customDomain of customDomains) {
    const customDestDir = join(PUBLISH_DIR, customDomain);
    log(`Publishing custom domain ${customDomain} to ${customDestDir}...`);
    await publishDirAtomically(distDir, customDestDir, async (stagingDir) => {
      log(`  Rewriting absolute URLs to https://${customDomain}...`);
      await transformOutputFiles(stagingDir, (html) => html.replaceAll(publicOrigin, `https://${customDomain}`));
    });
    await writeTraefikRouteForDomain(customDomain);
  }

  // Lets a later Docker or SSH publish know these static files exist.
  await writeFile(
    stateFile,
    JSON.stringify({ mode: "ssg", publishDomain, customDomains }, null, 2) + "\n",
    "utf8"
  );

  log(`Successfully published ${domain}`);
};

const readSshTarget = async (workDir) => {
  try {
    return JSON.parse(await readFile(join(workDir, "target.json"), "utf8"));
  } catch {
    return undefined;
  }
};

// The publisher does not serve the site: TLS and routing on the remote server
// are the user's.
const publishBuildSsh = async ({ buildId }) => {
  log(`Starting SSH publish for build ${buildId}`);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);
  if (customDomains.length > 0) {
    log(`Custom domains: ${customDomains.join(", ")}`);
  }

  const publishDomain = qualifyPublishDomain(domain);
  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });

  const target = await readSshTarget(workDir);
  if (target === undefined) {
    throw new Error(
      `No SSH target configured for "${domain}". Configure one first:\n` +
        `  curl -X POST <publisher>/targets/ssh-setup -H 'content-type: application/json' \\\n` +
        `    -d '{"domain":"${domain}","sshHost":"…","sshUser":"…","sshPath":"…","sshPrivateKey":"…"}'`
    );
  }
  const { sshHost, sshUser, sshPath, sshPort = 22, publicUrl } = target;

  // The site moves away: stop serving it here.
  const stateFile = join(workDir, "state.json");
  let prevState;
  try {
    prevState = JSON.parse(await readFile(stateFile, "utf8"));
  } catch { /* no state.json — new domain, or previously SSG */ }
  if (prevState?.mode === "docker") {
    await stopDockerForDomain(domain, prevState.containerName, prevState.publishDomain, prevState.customDomains ?? []);
  } else if (prevState?.mode === "cloudflare") {
    cfProjectHost.delete(prevState.publishDomain);
    log(`${domain} was on Cloudflare Pages — project "${prevState.cfProjectName}" left in place and still live`);
  }
  for (const hostname of [publishDomain, ...customDomains]) {
    await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
    await removeTraefikRouteForDomain(hostname);
  }

  // publicUrl, else the first custom domain, else the wstd hostname.
  const publicOrigin =
    publicUrl ||
    (customDomains.length > 0
      ? `https://${customDomains[0]}`
      : `https://${publishDomain}`);

  const distDir = await buildSsgOutput({ buildId, domain, workDir, publicOrigin });

  // accept-new pins the host key on first contact.
  const keyPath = join(workDir, "ssh_key");
  const knownHostsPath = join(workDir, "known_hosts");
  const sshCmd = `ssh -p ${sshPort} -i ${keyPath} -o UserKnownHostsFile=${knownHostsPath} -o StrictHostKeyChecking=accept-new`;
  const rsyncCmd = `rsync -az --delete -e "${sshCmd}" ${distDir}/ ${sshUser}@${sshHost}:${sshPath}/`;
  log(`Deploying ${domain} to ${sshUser}@${sshHost}:${sshPath} ...`);
  log(`  $ ${rsyncCmd}`);
  const { stdout, stderr } = await execAsync(rsyncCmd, { cwd: workDir, maxBuffer: 10 * 1024 * 1024 });
  if (stdout) log(`  stdout: ${stdout.trim()}`);
  if (stderr) log(`  stderr: ${stderr.trim()}`);

  await writeFile(
    stateFile,
    JSON.stringify(
      { mode: "ssh", publishDomain, customDomains, sshHost, sshPath, publicUrl: publicOrigin },
      null,
      2
    ) + "\n",
    "utf8"
  );

  log(`Successfully published ${domain} to ${sshHost}`);
};

// ws- prefix so short slugs can't shadow system images.
const toDockerName = (domain) =>
  "ws-" +
  domain
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");

// React Router rejects actions whose Origin differs from request.url. Behind the
// TLS proxy the container only sees http, so every https form submit is refused.
// Only the site's own hostnames are allowed, keeping the CSRF check on.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const buildReactRouterConfig = (hostnames) => {
  const allowed = [];
  for (const hostname of hostnames) {
    const normalized = String(hostname).trim().toLowerCase();
    if (HOSTNAME_RE.test(normalized) === false) {
      logErr(`Skipping invalid hostname in allowedActionOrigins: ${hostname}`);
      continue;
    }
    if (allowed.includes(normalized) === false) {
      allowed.push(normalized);
    }
  }
  return `export default {\n  allowedActionOrigins: ${JSON.stringify(allowed)},\n};\n`;
};

// Shared by the local SSR pipeline (docker run) and Coolify (docker push).
const buildDockerImage = async ({
  buildId,
  domain,
  workDir,
  imageTag,
  hostnames = [],
}) => {
  const run = async (cmd, extraEnv = {}, stage = "build") => {
    const redactedCmd = redactSecrets(cmd);
    log(`  $ ${redactedCmd}`);
    recordLogLine(buildId, stage, `$ ${redactedCmd}`);
    markStage(buildId, cmd);
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      });
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
    } catch (err) {
      const stdout = err.stdout || "";
      const stderr = err.stderr || "";
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
      throw err;
    }
  };

  // A previous ssg:coolify .dockerignore would exclude files COPY needs.
  await rm(join(workDir, ".dockerignore"), { force: true });

  log(`Syncing build data for ${domain}...`);
  await run(
    `${WEBSTUDIO_CLI} sync --buildId=${buildId} --origin=${BUILDER_INTERNAL_URL} --authToken=$WS_BUILDER_TOKEN`,
    { WS_BUILDER_TOKEN: SERVICE_TOKEN }
  );

  log(`Generating Docker code for ${domain}...`);
  await run(`${WEBSTUDIO_CLI} build --template docker`);

  // The template serves images from ./public, absent from the final image.
  // The disk cache keeps processed images across restarts.
  const imageRoutePath = join(workDir, "app/routes/[_image].$.ts");
  try {
    let imageRouteCode = await readFile(imageRoutePath, "utf8");
    imageRouteCode = imageRouteCode.replace(
      /ipxFSStorage\(\{[^}]*dir:\s*["']\.\/public["'][^}]*\}\)/g,
      'ipxFSStorage({ dir: "./build/client" })'
    );
    imageRouteCode = imageRouteCode.replace(
      /import\s*\{([^}]*)\}\s*from\s*["']ipx["']/,
      (_, imports) =>
        imports.includes("ipxFSCache")
          ? `import {${imports}} from "ipx"`
          : `import {${imports.replace(/,?\s*$/, "")},\n  ipxFSCache,\n} from "ipx"`
    );
    imageRouteCode = imageRouteCode.replace(
      /(storage:\s*ipxFSStorage\([^)]+\))(\s*\})/,
      (_, storage, closing) =>
        `${storage}, cache: ipxFSCache({ dir: "/var/cache/ipx" })${closing}`
    );
    await writeFile(imageRoutePath, imageRouteCode, "utf8");
    log(`Patched [_image].$.ts for ${domain}`);
  } catch { /* file absent in older CLI versions — skip */ }

  // SSR marks every /#section link aria-current="page". Patch link-utils.js
  // (components 0.314.0+) and components.js (older).
  await writeFile(join(workDir, "patch-navlink.cjs"), `
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const files = [
  "./node_modules/@webstudio-is/sdk/lib/link-utils.js",
  "./node_modules/@webstudio-is/sdk-components-react-router/lib/components.js"
];
let patched_any = false;
for (const p of files) {
  if (!existsSync(p)) { continue; }
  let c = readFileSync(p, "utf8");
  const marker = "ws-navlink-anchor-patch";
  if (c.includes(marker)) {
    console.log(\`NavLink patch: \${p}: already applied\`);
    continue;
  }

  let patched = c.replace(
    /\\(currentUrl\\.hash === "" \\|\\| targetUrl\\.hash === "" \\|\\| currentUrl\\.hash === targetUrl\\.hash\\)/g,
    "/* " + marker + " */ (targetUrl.hash === \\\"\\\" || currentUrl.hash === targetUrl.hash)"
  );

  // Before 0.314.0
  if (patched === c) {
    patched = c.replace(
      /href\\.startsWith\\("\\/"\\) && href\\.startsWith\\(assetBaseUrl\\) === false(?! && href\\.startsWith\\("\\\/#"\\))/g,
      'href.startsWith("/") && href.startsWith(assetBaseUrl) === false && href.startsWith("/#") === false /* ' + marker + ' */'
    );
  }

  if (patched !== c) {
    writeFileSync(p, patched);
    console.log(\`NavLink patch: \${p}: applied\`);
    patched_any = true;
  } else {
    console.log(\`NavLink patch: \${p}: pattern not found\`);
  }
}
if (!patched_any) {
  console.warn("⚠️ NavLink patch: no patterns found in link-utils.js or components.js — NavLink active state may be broken");
  process.exit(0);
}
`);

  await writeFile(
    join(workDir, "react-router.config.ts"),
    buildReactRouterConfig(hostnames),
    "utf8"
  );
  log(`Wrote react-router.config.ts for ${domain}`);

  await pinSiteDependencies(workDir);

  await writeFile(join(workDir, "Dockerfile"), DOCKER_SITE_DOCKERFILE, "utf8");
  log(`Wrote Dockerfile for ${domain}`);

  log(`Building Docker image ${imageTag}...`);
  await run(`docker build -t ${imageTag} .`, { DOCKER_BUILDKIT: "1" });
};

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

  const run = async (cmd, extraEnv = {}, stage = "build") => {
    const redactedCmd = redactSecrets(cmd);
    log(`  $ ${redactedCmd}`);
    recordLogLine(buildId, stage, `$ ${redactedCmd}`);
    markStage(buildId, cmd);
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      });
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
    } catch (err) {
      const stdout = err.stdout || "";
      const stderr = err.stderr || "";
      if (stdout) {
        const trimmedOut = redactSecrets(stdout.trim());
        log(`  stdout: ${trimmedOut}`);
        recordLogLine(buildId, stage, trimmedOut);
      }
      if (stderr) {
        const trimmedErr = redactSecrets(stderr.trim());
        log(`  stderr: ${trimmedErr}`);
        recordLogLine(buildId, stage, trimmedErr);
      }
      throw err;
    }
  };

  const stateFile = join(workDir, "state.json");
  // Keeps serving until the new container answers.
  let previousContainer;
  try {
    const prevState = JSON.parse(await readFile(stateFile, "utf8"));
    if (prevState.mode === "docker") {
      previousContainer = prevState.containerName;
    }
    if (prevState.mode === "ssg") {
      for (const h of [prevState.publishDomain ?? publishDomain, ...(prevState.customDomains ?? [])]) {
        await rm(join(PUBLISH_DIR, h), { recursive: true, force: true });
      }
      log(`Removed stale SSG output for ${domain}`);
    } else if (prevState.mode === "cloudflare") {
      // The Pages project is the user's to delete; drop the staging route to Cloudflare.
      cfProjectHost.delete(prevState.publishDomain);
      log(`${domain} was on Cloudflare Pages — project "${prevState.cfProjectName}" left in place and still live`);
    }
    // The old container is stopped below, once the new one is up.
  } catch { /* no state.json — new domain */ }

  const imageName = toDockerName(domain);
  await buildDockerImage({
    buildId,
    domain,
    workDir,
    imageTag: imageName,
    hostnames: [publishDomain, ...customDomains],
  });

  // Blue/green: the old container serves until the new one answers.
  // --init: npm as PID 1 ignores SIGTERM, so docker stop would wait 10 s.
  const containerName = `${imageName}-${Date.now().toString(36)}`;
  log(`Deploying container ${containerName}...`);
  await run(
    `docker run -d --init --restart=unless-stopped --network=${DOCKER_NETWORK} --name ${containerName} -v ${imageName}-ipx-cache:/var/cache/ipx -e IPX_HTTP_ALLOW_ALL_DOMAINS=true ${imageName}`
  );

  try {
    await waitForContainerReady(containerName);
  } catch (err) {
    // The previous container keeps serving the site.
    try { await run(`docker logs --tail 50 ${containerName}`); } catch {}
    try { await run(`docker rm -f ${containerName}`); } catch {}
    throw err;
  }

  await writeFile(
    join(workDir, "state.json"),
    JSON.stringify({ mode: "docker", imageName, containerName, publishDomain, customDomains }, null, 2) + "\n",
    "utf8"
  );

  // Map updates are synchronous, so the switch is atomic.
  const allHostnames = [publishDomain, ...customDomains];
  for (const hostname of allHostnames) {
    dockerHostContainer.set(hostname, containerName);
  }
  // Custom domains removed since the last publish (Traefik routes are kept).
  for (const [hostname, container] of dockerHostContainer) {
    if (container === previousContainer) dockerHostContainer.delete(hostname);
  }
  for (const hostname of allHostnames) {
    await writeTraefikRouteForDomain(hostname);
  }

  // Let in-flight requests drain.
  if (previousContainer !== undefined && previousContainer !== containerName) {
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_DRAIN_MS));
    try { await run(`docker stop ${previousContainer}`); } catch {}
    try { await run(`docker rm ${previousContainer}`); } catch {}
  }

  try { await run(`docker image prune -f`); } catch {}

  log(`Successfully published Docker site ${domain} (container ${containerName})`);
};

// Past this, the previous container stays online.
const CONTAINER_READY_TIMEOUT_MS =
  Number.parseInt(process.env.CONTAINER_READY_TIMEOUT_MS ?? "60000", 10) || 60000;
// Lets in-flight requests finish before stopping the old container.
const CONTAINER_DRAIN_MS = 5000;

const waitForContainerReady = async (containerName) => {
  const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    const status = await new Promise((resolve) => {
      const req = httpRequest(
        { hostname: containerName, port: 3000, path: "/", method: "GET", timeout: 5000 },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("timeout", () => req.destroy(new Error("request timeout")));
      req.on("error", (err) => {
        lastError = err.message;
        resolve(undefined);
      });
      req.end();
    });
    if (status !== undefined && status < 500) {
      log(`Container ${containerName} is ready (HTTP ${status})`);
      return;
    }
    if (status !== undefined) lastError = `HTTP ${status}`;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Container ${containerName} not ready after ${CONTAINER_READY_TIMEOUT_MS} ms (${lastError}) — previous version kept online`
  );
};

// The publisher POSTs from inside the compose network: an internal URL is SSRF.
const isSafeWebhookUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname;
  return (
    host !== "localhost" &&
    /^127\./.test(host) === false &&
    /^169\.254\./.test(host) === false &&
    /^10\./.test(host) === false &&
    /^192\.168\./.test(host) === false &&
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) === false &&
    host !== "0.0.0.0" &&
    host !== "::1"
  );
};

// The publisher owns no Coolify credentials: the site owner creates a Docker
// Image app on `${REGISTRY_URL}/ws-<slug>` and passes its deploy webhook per
// publish. A 2xx means the deploy is queued; Coolify is never polled.

const assertCoolifyPublishConfig = (coolifyWebhookUrl) => {
  if (!REGISTRY_URL) {
    throw new Error(
      "REGISTRY_URL is not set on the publisher — required for host: coolify. " +
        "Point it at a registry your Coolify can pull from (e.g. ghcr.io/my-org)."
    );
  }
  if (!coolifyWebhookUrl) {
    throw new Error(
      "No Coolify deploy webhook configured for this site. Paste the app's " +
        "deploy webhook URL in the Publish panel."
    );
  }
  if (isSafeWebhookUrl(coolifyWebhookUrl) === false) {
    throw new Error(
      `Invalid Coolify webhook URL "${coolifyWebhookUrl}" — must be an https URL to a public host.`
    );
  }
};

// Returns the previous state, if any.
const stopLocalServing = async ({ domain, stateFile, publishDomain, customDomains }) => {
  let prevState;
  try {
    prevState = JSON.parse(await readFile(stateFile, "utf8"));
  } catch { /* no state.json — new domain */ }
  if (prevState?.mode === "docker") {
    await stopDockerForDomain(domain, prevState.containerName, prevState.publishDomain, prevState.customDomains ?? []);
  } else if (prevState?.mode === "cloudflare") {
    cfProjectHost.delete(prevState.publishDomain);
    log(`${domain} was on Cloudflare Pages — project "${prevState.cfProjectName}" left in place and still live`);
  }
  for (const hostname of [publishDomain, ...customDomains]) {
    await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
    await removeTraefikRouteForDomain(hostname);
  }
  return prevState;
};

// Pushes :latest and an immutable :<buildId> tag, then calls the deploy webhook.
const deployImageToCoolify = async ({
  imageRepo,
  buildId,
  run,
  coolifyWebhookUrl,
  coolifyWebhookToken,
}) => {
  await run(`docker tag ${imageRepo}:latest ${imageRepo}:${buildId}`);

  if (REGISTRY_USER) {
    // Token via env so it never lands in the logged command or `ps`.
    await run(
      `echo "$WS_REGISTRY_TOKEN" | docker login ${REGISTRY_URL.split("/")[0]} -u ${REGISTRY_USER} --password-stdin`,
      { WS_REGISTRY_TOKEN: REGISTRY_TOKEN }
    );
  }
  log(`Pushing ${imageRepo} (:latest, :${buildId})...`);
  await run(`docker push ${imageRepo}:latest`);
  await run(`docker push ${imageRepo}:${buildId}`);
  try { await run(`docker image prune -f`); } catch {}

  log(`Triggering Coolify deploy webhook...`);
  const response = await fetch(coolifyWebhookUrl, {
    method: "POST",
    headers: coolifyWebhookToken
      ? { Authorization: `Bearer ${coolifyWebhookToken}` }
      : {},
  });
  if (response.ok === false) {
    const body = await response.text();
    throw new Error(
      `Coolify deploy webhook returned ${response.status}: ${body.slice(0, 300)}`
    );
  }
};

const runInWorkDir = (workDir, buildId) => async (cmd, extraEnv = {}) => {
  const redactedCmd = redactSecrets(cmd);
  log(`  $ ${redactedCmd}`);
  recordLogLine(buildId, "build", `$ ${redactedCmd}`);
  markStage(buildId, cmd);
  const record = ({ stdout, stderr }) => {
    for (const [label, output] of [["stdout", stdout], ["stderr", stderr]]) {
      if (!output) continue;
      const trimmed = redactSecrets(output.trim());
      log(`  ${label}: ${trimmed}`);
      recordLogLine(buildId, "build", trimmed);
    }
  };
  try {
    record(
      await execAsync(cmd, {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      })
    );
  } catch (err) {
    record({ stdout: err.stdout, stderr: err.stderr });
    throw err;
  }
};

const publishBuildCoolifySsr = async ({
  buildId,
  coolifyWebhookUrl,
  coolifyWebhookToken,
}) => {
  log(`Starting Coolify SSR publish for build ${buildId}`);
  assertCoolifyPublishConfig(coolifyWebhookUrl);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);

  const publishDomain = qualifyPublishDomain(domain);
  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });
  const run = runInWorkDir(workDir, buildId);
  const stateFile = join(workDir, "state.json");

  await stopLocalServing({ domain, stateFile, publishDomain, customDomains });

  const imageRepo = `${REGISTRY_URL}/${toDockerName(domain)}`;
  await buildDockerImage({
    buildId,
    domain,
    workDir,
    imageTag: `${imageRepo}:latest`,
    hostnames: [publishDomain, ...customDomains],
  });
  await deployImageToCoolify({
    imageRepo,
    buildId,
    run,
    coolifyWebhookUrl,
    coolifyWebhookToken,
  });

  await writeFile(
    stateFile,
    JSON.stringify(
      { mode: "coolify", renderMode: "ssr", imageRepo, webhookUrl: coolifyWebhookUrl, publishDomain, customDomains },
      null,
      2
    ) + "\n",
    "utf8"
  );

  log(`Successfully triggered Coolify deploy for ${domain} (${imageRepo}:latest)`);
};

const COOLIFY_SSG_NGINX_CONF = `\
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;

  location ~* ^/(_assets|assets)/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
  }

  location / {
    try_files $uri $uri.html $uri/index.html /index.html;
  }
}
`;

const COOLIFY_SSG_DOCKERFILE = `\
FROM nginx:alpine
COPY dist/client /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
`;

const publishBuildCoolifySsg = async ({
  buildId,
  coolifyWebhookUrl,
  coolifyWebhookToken,
}) => {
  log(`Starting Coolify SSG publish for build ${buildId}`);
  assertCoolifyPublishConfig(coolifyWebhookUrl);

  const { projectDomain: domain, customDomains } = await getProjectBuildInfo(buildId);
  log(`Project domain: ${domain}`);

  const publishDomain = qualifyPublishDomain(domain);
  const workDir = join(WORK_DIR, domain);
  await mkdir(workDir, { recursive: true });
  const run = runInWorkDir(workDir, buildId);
  const stateFile = join(workDir, "state.json");

  await stopLocalServing({ domain, stateFile, publishDomain, customDomains });

  // The first custom domain, else the wstd hostname.
  const publicOrigin =
    customDomains.length > 0
      ? `https://${customDomains[0]}`
      : `https://${publishDomain}`;
  await buildSsgOutput({ buildId, domain, workDir, publicOrigin });

  await writeFile(join(workDir, "nginx.conf"), COOLIFY_SSG_NGINX_CONF, "utf8");
  await writeFile(join(workDir, "Dockerfile"), COOLIFY_SSG_DOCKERFILE, "utf8");
  // The workDir holds the SSG toolchain's node_modules; nginx needs none of it.
  await writeFile(
    join(workDir, ".dockerignore"),
    "*\n!dist\n!nginx.conf\n",
    "utf8"
  );

  const imageRepo = `${REGISTRY_URL}/${toDockerName(domain)}`;
  log(`Building nginx image ${imageRepo}:latest...`);
  await run(`docker build -t ${imageRepo}:latest .`, { DOCKER_BUILDKIT: "1" });
  await deployImageToCoolify({
    imageRepo,
    buildId,
    run,
    coolifyWebhookUrl,
    coolifyWebhookToken,
  });

  await writeFile(
    stateFile,
    JSON.stringify(
      { mode: "coolify", renderMode: "ssg", imageRepo, webhookUrl: coolifyWebhookUrl, publishDomain, customDomains },
      null,
      2
    ) + "\n",
    "utf8"
  );

  log(`Successfully triggered Coolify deploy for ${domain} (${imageRepo}:latest)`);
};

const proxyServer = createServer(async (req, res) => {
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(":")[0];

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

  // Host is rewritten to the pages.dev hostname, which Cloudflare routes on.
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

  const served = await tryServeStaticFile(req, res, host);
  if (!served) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

// state.json then lists only the remaining hostnames, so restoreTargets()
// won't re-register the removed one.
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

// Each docker step is best-effort so one failure can't stop the teardown.
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
    // The Pages project is the user's to delete.
    log(`Cloudflare Pages project for ${domain} was NOT deleted — remove it from the Cloudflare dashboard`);
  } else if (mode === "ssh") {
    // Remote files are left in place.
    log(`${domain} was published over SSH to ${state.sshHost ?? "a remote server"} — remote files were NOT removed`);
  } else if (mode === "coolify") {
    // The Coolify app and pushed images belong to the site's owner.
    log(`${domain} was published to a remote Coolify — delete the app there; images remain in ${state.imageRepo ?? "the registry"}`);
  }

  for (const hostname of hostnames) {
    dockerHostContainer.delete(hostname);
    await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
    await removeTraefikRouteForDomain(hostname);
  }

  // Last: while state.json exists, restoreTargets() revives the site on boot.
  await rm(join(WORK_DIR, domain), { recursive: true, force: true });
  log(`Tore down ${domain}`);
};

// Unknown hostnames succeed so a retried project deletion can't fail.
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

  // An SSG copy can outlive its work directory.
  await rm(join(PUBLISH_DIR, hostname), { recursive: true, force: true });
  await removeTraefikRouteForDomain(hostname);
  log(`No site state found for ${hostname}, removed any leftover published files`);
  return { removed: false, teardown: false };
};

// Still sent by the upstream CLI and older builder images.
const LEGACY_BUILD_MODE = {
  ssg: { renderMode: "ssg", host: "local" },
  ssr: { renderMode: "ssr", host: "local" },
  cloudflare: { renderMode: "ssg", host: "cloudflare" },
};

// null: planned target, answered 501 so the builder can tell it from a bad request.
const RENDER_HOSTS = {
  "ssg:local": ({ buildId }) => publishBuild({ buildId }),
  "ssr:local": ({ buildId }) => publishBuildSsr({ buildId }),
  "ssg:cloudflare": ({ buildId }) => publishBuildCloudflare({ buildId }),
  "ssg:ssh": ({ buildId }) => publishBuildSsh({ buildId }),
  "ssr:coolify": ({ buildId, coolifyWebhookUrl, coolifyWebhookToken }) =>
    publishBuildCoolifySsr({ buildId, coolifyWebhookUrl, coolifyWebhookToken }),
  "ssg:coolify": ({ buildId, coolifyWebhookUrl, coolifyWebhookToken }) =>
    publishBuildCoolifySsg({ buildId, coolifyWebhookUrl, coolifyWebhookToken }),
};

// Prefers renderMode/host over the legacy buildMode. Returns null if unknown.
const normalizeTarget = (input) => {
  if (typeof input.renderMode === "string" || typeof input.host === "string") {
    return {
      renderMode: input.renderMode ?? "ssg",
      host: input.host ?? "local",
    };
  }
  return LEGACY_BUILD_MODE[input.buildMode ?? "ssg"] ?? null;
};

// Served by GET /capabilities so the builder hides targets it can't run.
const availableTargets = () => {
  const cloudflare = !!(CF_API_TOKEN && CF_ACCOUNT_ID);
  return Object.entries(RENDER_HOSTS)
    .filter(([key, runner]) => {
      if (runner === null) return false;
      if (key === "ssg:cloudflare") return cloudflare;
      if (key === "ssr:coolify" || key === "ssg:coolify") return !!REGISTRY_URL;
      return true;
    })
    .map(([key]) => key);
};

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

      if (target.host === "coolify" && !REGISTRY_URL) {
        res.writeHead(400);
        res.end("REGISTRY_URL must be set on the publisher for host: coolify");
        return;
      }
      if (target.host === "coolify" && !input.coolifyWebhookUrl) {
        res.writeHead(400);
        res.end("coolifyWebhookUrl is required for host: coolify");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, logHandle: buildId }));

      const tempDomainKey = `${builderOrigin}:${buildId}`;
      const q = getProjectQueue(tempDomainKey);

      q.current = q.current
        .then(async () => {
          const { projectDomain: domain } = await getProjectBuildInfo(buildId);
          startLogCapture(buildId, domain);

          await acquirePublishSlot();
          try {
            await runner({
              buildId,
              builderOrigin,
              coolifyWebhookUrl: input.coolifyWebhookUrl,
              coolifyWebhookToken: input.coolifyWebhookToken,
            });
            await finishLogCapture(buildId, "succeeded", null);
          } catch (err) {
            await finishLogCapture(
              buildId,
              "failed",
              activeLogs.get(buildId)?.currentStage
            );
            throw err;
          } finally {
            releasePublishSlot();
          }
        })
        .then(() => notifyBuildStatus(buildId, "PUBLISHED"))
        .catch((err) => {
          logErr(`Publish failed for build ${buildId}: ${redactSecrets(err.message)}`);
          notifyBuildStatus(buildId, "FAILED").catch((notifyErr) =>
            logErr(`Failed to notify FAILED status for ${buildId}: ${redactSecrets(notifyErr.message)}`)
          );
        });
    });
    return;
  }

  // Done once per site so the private key isn't sent on every publish.
  // Stores ssh_key (mode 600), target.json and known_hosts under /var/work/<domain>/.
  if (req.method === "POST" && req.url === "/targets/ssh-setup") {
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
      const { domain, sshHost, sshUser, sshPath, sshPort = 22, sshPrivateKey, publicUrl } = input;
      const missing = ["domain", "sshHost", "sshUser", "sshPath", "sshPrivateKey"].filter(
        (k) => !input[k]
      );
      if (missing.length > 0) {
        res.writeHead(400);
        res.end(`Missing field(s): ${missing.join(", ")}`);
        return;
      }
      // Interpolated into shell commands: constrain to safe shapes.
      const invalid =
        /^[A-Za-z0-9.\-:]+$/.test(sshHost) === false
          ? "sshHost"
          : /^[A-Za-z0-9._\-]+$/.test(sshUser) === false
            ? "sshUser"
            : /^[A-Za-z0-9._/\-]+$/.test(sshPath) === false
              ? "sshPath"
              : Number.isInteger(Number(sshPort)) === false ||
                  Number(sshPort) < 1 ||
                  Number(sshPort) > 65535
                ? "sshPort"
                : undefined;
      if (invalid !== undefined) {
        res.writeHead(400);
        res.end(`Invalid ${invalid}`);
        return;
      }
      if (publicUrl && /^https:\/\/[^\s"']+$/.test(publicUrl) === false) {
        res.writeHead(400);
        res.end("Invalid publicUrl (expected https://…)");
        return;
      }
      try {
        const workDir = join(WORK_DIR, domain);
        await mkdir(workDir, { recursive: true });

        const keyPath = join(workDir, "ssh_key");
        await writeFile(
          keyPath,
          sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n",
          "utf8"
        );
        await chmod(keyPath, 0o600);

        await writeFile(
          join(workDir, "target.json"),
          JSON.stringify(
            { sshHost, sshUser, sshPath, sshPort: Number(sshPort), publicUrl: publicUrl ?? null },
            null,
            2
          ) + "\n",
          "utf8"
        );

        // Pre-seed known_hosts so the first rsync does not have to trust blindly.
        try {
          const { stdout } = await execAsync(`ssh-keyscan -p ${sshPort} -H ${sshHost}`, {
            maxBuffer: 1024 * 1024,
          });
          if (stdout.trim()) {
            await writeFile(join(workDir, "known_hosts"), stdout, "utf8");
          }
        } catch {
          log(`ssh-keyscan failed for ${sshHost} — first publish will trust the host key on contact`);
        }

        log(`Configured SSH target for ${domain}: ${sshUser}@${sshHost}:${sshPath}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        logErr(`ssh-setup failed for ${input.domain}: ${error.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
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

  if (req.method === "GET" && req.url.startsWith("/logs/")) {
    const buildId = req.url.slice(6).split("?")[0];
    const query = new URLSearchParams(req.url.split("?")[1] ?? "");
    const cursor = query.get("cursor") ? Number.parseInt(query.get("cursor"), 10) : undefined;
    const includeLog = query.get("includeLog") === "true";

    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== SERVICE_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (!buildId || buildId.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing buildId" }));
      return;
    }

    const activeLog = activeLogs.get(buildId);
    if (activeLog) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ availability: "pending" }));
      return;
    }

    (async () => {
      try {
        const { projectDomain: domain } = await getProjectBuildInfo(buildId);
        const result = includeLog
          ? await readPublishLog(buildId, domain, cursor)
          : { availability: "available" }; // minimal response if not requesting log
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ availability: "unavailable" }));
      }
    })();
    return;
  }

  if (req.method === "GET" && req.url === "/capabilities") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        // `cloudflare` kept for builder images predating `targets`.
        cloudflare: !!(CF_API_TOKEN && CF_ACCOUNT_ID),
        coolify: !!REGISTRY_URL,
        ssh: true,
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
