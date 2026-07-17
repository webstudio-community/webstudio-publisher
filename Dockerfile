# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1 — Build the webstudio CLI from the fork, pinned to the builder's commit
# =============================================================================
# The publisher's CLI MUST match the deployed builder exactly: the sync/publish
# handshake is gated by a bundle-contract hash + tRPC route surface that are
# computed from the fork's schema. The upstream CLI on npm (`webstudio@latest`)
# is built from upstream's schema and is rejected by this fork's API
# ("apiCompatibilityError"). So we build the CLI from the fork itself.
#
# Runs on the NATIVE build arch ($BUILDPLATFORM) — never emulated. The CLI is
# pure JS (arch-independent), so building once and copying into every target
# image is both correct and fast (no pnpm-under-QEMU).
FROM --platform=$BUILDPLATFORM node:22 AS cli-build

# Commit (or branch/tag) of webstudio-fork to build the CLI from.
# The CI passes the exact revision of the deployed builder image so the CLI and
# the builder stay in lockstep. Defaults to `develop` (the branch builder:latest
# tracks) if no ref is provided.
ARG WEBSTUDIO_REF=develop
ARG WEBSTUDIO_REPO=https://github.com/webstudio-community/webstudio-fork.git

RUN corepack enable
WORKDIR /src

# Clone + checkout in a single layer so a new WEBSTUDIO_REF fully cache-busts the
# fetch (partial clone fetches the target commit's blobs on demand at checkout).
RUN git clone --filter=blob:none "$WEBSTUDIO_REPO" . \
 && git checkout "$WEBSTUDIO_REF"

# A from-source build leaves every package at the "0.0.0-webstudio-version"
# placeholder. Generated sites would then request @webstudio-is/*@0.0.0-webstudio-version
# from npm — which does not exist — and their `npm install` fails with ETARGET.
# Stamp a real, published version into every package.json, exactly like the fork's
# release.yml does. This does NOT affect sync/build compatibility (that is gated by
# the schema/code, not the version string); it only sets which published
# @webstudio-is/* packages the generated sites pull at publish time.
# Defaults to the latest published `webstudio` version if not provided.
ARG WEBSTUDIO_SDK_VERSION=
RUN SDK_VERSION="${WEBSTUDIO_SDK_VERSION:-$(npm view webstudio@latest version)}" \
 && echo "Stamping @webstudio-is/* version: $SDK_VERSION" \
 && npx --yes replace-in-files-cli \
      --string="0.0.0-webstudio-version" \
      --replacement="$SDK_VERSION" \
      "**/package.json"

# Reuse the pnpm store across builds; the install itself re-runs when the ref moves.
# --no-frozen-lockfile because the version stamp above edits the manifests.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile

# Build the CLI and all its workspace dependencies (@webstudio-is/*), then emit
# a self-contained, production-only deployable dir (bin.js + lib + templates +
# a fully-resolved node_modules). This mirrors `pnpm deploy` usage already in the
# fork's own CI.
RUN pnpm --filter="webstudio..." build \
 && pnpm --filter="webstudio..." dts \
 && pnpm --filter=webstudio deploy --prod /cli

# =============================================================================
# Stage 2 — Runtime
# =============================================================================
FROM node:22-alpine

# The fork-built CLI, version-locked to the builder. This replaces the previous
# `npm install -g webstudio@latest`, which pulled the incompatible upstream CLI.
COPY --from=cli-build /cli /opt/webstudio-cli
RUN chmod +x /opt/webstudio-cli/bin.js \
 && ln -s /opt/webstudio-cli/bin.js /usr/local/bin/webstudio \
 && ln -s /opt/webstudio-cli/bin.js /usr/local/bin/webstudio-cli
# wrangler is installed on-demand at first Cloudflare publish (saves ~150 MB for non-CF users)

# docker CLI for buildMode: "docker" — requires /var/run/docker.sock mounted at runtime
RUN apk add --no-cache docker-cli docker-cli-buildx

WORKDIR /app

COPY server.mjs /app/server.mjs

# Create mount point directories
RUN mkdir -p /var/publish /var/work

ENV PORT=4000
ENV PROXY_PORT=4001
EXPOSE 4000
EXPOSE 4001

CMD ["node", "/app/server.mjs"]
