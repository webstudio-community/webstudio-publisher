FROM node:22-alpine

# Install only the webstudio CLI globally (pure JS, no native binaries — works on arm64/QEMU).
# vite is NOT installed globally: the workdir's npm install provides it, and npx vite picks it up.
RUN npm install -g webstudio@latest
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
