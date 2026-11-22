# webstudio-publisher

Self-hosted publisher for [Webstudio](https://webstudio.is). When a user clicks
**Publish** in the builder, it builds the site and serves it locally (SSG or SSR)
or ships it to Cloudflare Pages, a server over SSH, or a remote Coolify.

It runs alongside the builder: see
[webstudio-self-host](https://github.com/webstudio-community/webstudio-self-host)
for the full Docker Compose setup.

Image: `ghcr.io/webstudio-community/webstudio-publisher:latest` (built on every
push to `main` and on releases).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRPC_SERVER_API_TOKEN` | — | Service token shared with the builder |
| `BUILDER_INTERNAL_URL` | `http://app:3000` | Internal URL of the builder (avoids Traefik/TLS) |
| `PUBLISHER_HOST` | — | Domain suffix for slug URLs (`example.com` → `myproject.example.com`) |
| `PORT` | `4000` | Build API port |
| `PROXY_PORT` | `4001` | Site proxy port: route `*.PUBLISHER_HOST` here |
| `DOCKER_NETWORK` | auto-detected | Network shared with SSR site containers |
| `TRAEFIK_DYNAMIC_DIR` | — | Traefik file-provider directory; enables Let's Encrypt for custom domains |
| `MAX_CONCURRENT_PUBLISHES` | `0` (unlimited) | Publishes running at once; extra ones queue. Use `1` on small machines |
| `CONTAINER_READY_TIMEOUT_MS` | `60000` | SSR: wait for a new container before keeping the previous one online |
| `PUBLISH_LOG_RETENTION` | `5` | Publish logs kept per domain |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | — | Enable `host: "cloudflare"` |
| `CLOUDFLARE_PRODUCTION_BRANCH` | `main` | Production branch of created Pages projects |
| `REGISTRY_URL` | — | Registry for `host: "coolify"` images (e.g. `ghcr.io/my-org`) |
| `REGISTRY_USER` / `REGISTRY_TOKEN` | — | Registry write credentials, if private |

SSR mode needs `/var/run/docker.sock` mounted.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/publish` | Body: `{ buildId, builderOrigin, renderMode: "ssg" \| "ssr", host: "local" \| "cloudflare" \| "ssh" \| "coolify" }`, plus `coolifyWebhookUrl` / `coolifyWebhookToken?` for Coolify. Legacy `buildMode` still accepted. Returns `{ success, logHandle }` |
| `GET` | `/logs/<buildId>` | Publish status and log (`?includeLog=true&cursor=…`, base64url chunks). Bearer token required |
| `POST` | `/targets/ssh-setup` | Body: `{ domain, sshHost, sshUser, sshPath, sshPort?, sshPrivateKey, publicUrl? }` |
| `POST` | `/unpublish` | Body: `{ domain }` |
| `GET` | `/capabilities` | `{ cloudflare, coolify, ssh, targets: ["ssg:local", …] }` |
| `GET` | `/health` | Returns `ok` |

### `host: "ssh"`

Register the target once per site, then publish with `renderMode: "ssg"`:

```bash
ssh-keygen -t ed25519 -f ./ws_deploy -N ''
ssh-copy-id -i ./ws_deploy.pub deploy@my-server

curl -X POST http://publisher:4000/targets/ssh-setup \
  -H 'content-type: application/json' \
  -d "{\"domain\":\"my-site\",\"sshHost\":\"my-server\",\"sshUser\":\"deploy\",\"sshPath\":\"/var/www/my-site\",\"sshPrivateKey\":\"$(awk '{printf "%s\\n", $0}' ./ws_deploy)\",\"publicUrl\":\"https://my-site.com\"}"
```

Each publish runs `rsync -az --delete dist/client/ sshUser@sshHost:sshPath/`.
TLS and the web server on the remote host are up to you.

### `host: "coolify"`

Set `REGISTRY_URL` on the publisher. On the target Coolify, create a **Docker
Image** app pulling `${REGISTRY_URL}/ws-<project-slug>` (port `3000` for SSR,
`80` for SSG) and pass its deploy webhook URL with each publish.

Each publish pushes `:latest` and `:<buildId>`, then calls the webhook. A `2xx`
means the deploy is queued; the publisher never polls Coolify. Unpublishing
leaves the Coolify app and the images in place.

### SSR sites

- Form submissions are allowed from the site's hostnames only
  (`allowedActionOrigins`). A custom domain added after a publish accepts forms
  after the next publish.
- Sites install `@webstudio-is/sdk-components-react-router` from npm, so the
  build patches it (`patch-navlink.cjs`): a `/#section` link is active only on
  that anchor. Nothing is written if the pattern is not found.
