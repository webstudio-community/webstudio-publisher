# CLAUDE.md — webstudio-publisher

Service Node.js (ESM, no build step) qui publie les sites lors d'une publication, avec support multi-destinations.

## Fichier principal

`server.mjs` — tout le service tient dans ce fichier unique. Pas de dépendances npm locales.

## Modes de publication

Le champ `buildMode` dans le body du `POST /publish` détermine la destination (défaut: `"ssg"`).

### `ssg` — Nginx local (défaut)

```
POST /publish { buildId, builderOrigin, buildMode: "ssg" }
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template ssg
  → patch des +data.ts (fix prerender origin)
  → npm install (si node_modules absent ou vike version changée)
  → WEBSTUDIO_PRERENDER_ORIGIN=... npx vite build
  → cp dist/client → /var/publish/<domain>/
```

### `cloudflare` — Cloudflare Pages

```
POST /publish { buildId, builderOrigin, buildMode: "cloudflare" }
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template cloudflare
  → npm install (si node_modules absent)
  → npm run build  (remix vite:build → build/client/)
  → wrangler pages deploy ./build/client --project-name <domain-sanitisé>
```

Requiert `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`. Le projet CF Pages est créé automatiquement par wrangler s'il n'existe pas.

Les jobs sont sérialisés **par domaine** via une queue de promesses (`projectQueues`).

## Variables d'environnement

| Variable | Rôle |
|----------|------|
| `TRPC_SERVER_API_TOKEN` | Token d'auth pour l'API du builder |
| `BUILDER_INTERNAL_URL` | URL interne Docker du builder (défaut: `http://app:3000`) |
| `PUBLISHER_HOST` | Suffixe de domaine pour les slugs sans point |
| `TRAEFIK_DYNAMIC_DIR` | Si défini, écrit les configs Traefik pour les domaines custom |
| `PORT` | Port HTTP (défaut: 4000) |
| `CLOUDFLARE_API_TOKEN` | Token Wrangler pour deploy CF Pages (mode `cloudflare`) |
| `CLOUDFLARE_ACCOUNT_ID` | ID compte Cloudflare (mode `cloudflare`) |

## Points d'attention

- `BUILDER_INTERNAL_URL` évite de passer par Traefik/TLS depuis le container
- Le patch `patchDataFilesForPrerender` corrige un bug vike où `pageContext.headers` est vide au build time
- vike est épinglé à `TARGET_VIKE` (constante dans le code) — ne pas changer sans tester
- Les custom domains (contenant un `.`) reçoivent une config Traefik auto-générée pour Let's Encrypt
- Le nom de projet CF Pages est dérivé du domain (sanitisé en `[a-z0-9-]+`, max 58 chars)

## Docker

```bash
docker build -t webstudio-publisher .
# Image publiée sur : ghcr.io/webstudio-community/webstudio-publisher
```
