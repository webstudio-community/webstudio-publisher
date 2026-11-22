# The webstudio CLI is not installed here: it runs via npx from the builder's /npm/ registry.
FROM node:22-alpine

# docker-cli: SSR (needs /var/run/docker.sock). rsync + openssh-client: ssh host.
# curl + jq: call the build API from `docker compose exec`.
RUN apk add --no-cache docker-cli docker-cli-buildx rsync openssh-client curl jq

WORKDIR /app

COPY server.mjs /app/server.mjs

RUN mkdir -p /var/publish /var/work

ENV PORT=4000
ENV PROXY_PORT=4001
EXPOSE 4000
EXPOSE 4001

CMD ["node", "/app/server.mjs"]
