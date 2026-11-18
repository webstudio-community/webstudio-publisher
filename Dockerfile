# The webstudio CLI is NOT baked into this image: the publisher runs it with
# `npx` from the builder's own /npm/ registry (@webstudio-community/cli), so it is
# always built from the same commit as the builder. See server.mjs (WEBSTUDIO_CLI).
FROM node:22-alpine

# wrangler is installed on-demand at first Cloudflare publish (saves ~150 MB for non-CF users)

# docker-cli — SSR (docker) mode, requires /var/run/docker.sock mounted at runtime
# rsync + openssh-client — ssh host: deploy SSG output to a remote server
# curl + jq — call the build API (e.g. /targets/ssh-setup) from `docker compose exec`
RUN apk add --no-cache docker-cli docker-cli-buildx rsync openssh-client curl jq

WORKDIR /app

COPY server.mjs /app/server.mjs

# Create mount point directories
RUN mkdir -p /var/publish /var/work

ENV PORT=4000
ENV PROXY_PORT=4001
EXPOSE 4000
EXPOSE 4001

CMD ["node", "/app/server.mjs"]
