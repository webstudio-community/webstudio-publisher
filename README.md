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
| `POST` | `/publish` | Trigger a publish. Body: `{ "buildId": "...", "builderOrigin": "..." }` |
| `GET` | `/health` | Health check — returns `ok` |
