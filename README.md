# webstudio-publisher

Self-hosted publisher service for [Webstudio](https://webstudio.is).

When a user clicks **Publish** in the Webstudio builder, this service:
1. Fetches build data from the builder via its REST API
2. Runs `webstudio sync` + `webstudio build --template ssg` to generate a static site
3. Runs `vite build` to produce static HTML files
4. Writes the output to `/var/publish/<domain>/` so Nginx can serve it

## Docker images

Images are published automatically on every push to `main` and on releases:

| Registry | Image |
|----------|-------|
| GitHub Container Registry | `ghcr.io/webstudio-community/webstudio-publisher:latest` |
| Docker Hub | `webstudio-community/webstudio-publisher:latest` |

## Usage

This service is meant to be used alongside the Webstudio builder. See
[webstudio-self-host](https://github.com/webstudio-community/webstudio-self-host)
for the full Docker Compose setup.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRPC_SERVER_API_TOKEN` | — | Service token to authenticate with the builder app |
| `BUILDER_INTERNAL_URL` | `http://app:3000` | Internal Docker URL for the builder (avoids Traefik/TLS) |
| `PUBLISHER_HOST` | — | Domain suffix for slug-based URLs (e.g. `example.com` → `myproject.example.com`) |
| `PORT` | `4000` | HTTP port |

## Building locally

```bash
docker build -t webstudio-publisher .
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/publish` | Trigger a publish. Body: `{ "buildId", "builderOrigin", "renderMode": "ssg" \| "ssr", "host": "local" \| "cloudflare" \| "ssh" }` (legacy `"buildMode": "ssg" \| "ssr" \| "cloudflare"` still accepted) |
| `POST` | `/targets/ssh-setup` | Configure the SSH target for a domain (`host: "ssh"`). Body: `{ "domain", "sshHost", "sshUser", "sshPath", "sshPort"?, "sshPrivateKey", "publicUrl"? }` |
| `POST` | `/unpublish` | Take a hostname down. Body: `{ "domain": "..." }` |
| `GET` | `/capabilities` | Publisher capabilities — `{ "cloudflare": bool, "coolify": bool, "ssh": bool, "targets": ["ssg:local", …] }` |
| `GET` | `/health` | Health check — returns `ok` |

### `host: "ssh"` — deploy an SSG site to a remote server

Configure the target once, then publish with `renderMode: "ssg"`, `host: "ssh"`:

```bash
# 1. generate a keypair and authorize it on the remote server
ssh-keygen -t ed25519 -f ./ws_deploy -N ''
ssh-copy-id -i ./ws_deploy.pub deploy@my-server

# 2. register the target with the publisher (once per site)
curl -X POST http://publisher:4000/targets/ssh-setup \
  -H 'content-type: application/json' \
  -d "{\"domain\":\"my-site\",\"sshHost\":\"my-server\",\"sshUser\":\"deploy\",\"sshPath\":\"/var/www/my-site\",\"sshPrivateKey\":\"$(awk '{printf "%s\\n", $0}' ./ws_deploy)\",\"publicUrl\":\"https://my-site.com\"}"
```

Each publish runs `rsync -az --delete` from the freshly built `dist/client/` to
`sshUser@sshHost:sshPath/`. TLS and web-server config on the remote host are the
user's responsibility; the publisher does not serve the site or manage its domain.
