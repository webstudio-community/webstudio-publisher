# CLAUDE.md — webstudio-publisher

Service Node.js (ESM, no build step) qui publie les sites lors d'une publication, avec support multi-destinations.

## Fichier principal

`server.mjs` — tout le service tient dans ce fichier unique. Pas de dépendances npm locales.

## Modes de publication

Le champ `buildMode` dans le body du `POST /publish` détermine la destination (défaut: `"ssg"`).

### `ssg` — Nginx / proxy local (défaut)

```
POST /publish { buildId, builderOrigin, buildMode: "ssg" }
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template ssg
  → patch des +data.ts (fix prerender origin)
  → npm install (si node_modules absent ou vike version changée)
  → WEBSTUDIO_PRERENDER_ORIGIN=... npx vite build
  → cp dist/client → /var/publish/<domain>/
```

### `ssr` — Node SSR local

```
POST /publish { buildId, builderOrigin, buildMode: "ssr" }
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template docker
  → npm install (si node_modules absent, ou si switch depuis SSG)
  → npm run build  (react-router build → build/server/index.js)
  → react-router-serve ./build/server/index.js sur port dynamique (5001+)
  → état persisté dans /var/work/<domain>/state.json
```

Le subprocess SSR est accessible via le proxy sur `PROXY_PORT` (défaut 4001).
La stack self-host doit router `*.PUBLISHER_HOST` vers ce port (voir `webstudio-self-host`).

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

## Proxy de sites (port PROXY_PORT)

Le serveur proxy sur port 4001 sert tous les sites publiés :
- **SSR** : reverse-proxy vers le subprocess `react-router-serve` du domaine
- **SSG** : fichiers statiques servis directement depuis `/var/publish/<host>/`

## Persistance SSR

Chaque domaine SSR écrit `/var/work/<domain>/state.json` :
```json
{ "mode": "ssr", "port": 5001, "publishDomain": "mysite.wstd.work", "customDomains": [] }
```

Au démarrage du publisher, `restoreSsrProcesses()` relit tous les `state.json` et relance les subprocesses SSR.

Les ports sont alloués dynamiquement à partir de `SSR_PORT_BASE + 1` (défaut: 5001) et persistés dans `state.json` pour rester stables entre redémarrages.

## Variables d'environnement

| Variable | Rôle |
|----------|------|
| `TRPC_SERVER_API_TOKEN` | Token d'auth pour l'API du builder |
| `BUILDER_INTERNAL_URL` | URL interne Docker du builder (défaut: `http://app:3000`) |
| `PUBLISHER_HOST` | Suffixe de domaine pour les slugs sans point |
| `TRAEFIK_DYNAMIC_DIR` | Si défini, écrit les configs Traefik pour les domaines custom |
| `PORT` | Port de l'API build (défaut: 4000) |
| `PROXY_PORT` | Port du proxy de sites (défaut: 4001) |
| `SSR_PORT_BASE` | Base des ports subprocess SSR (défaut: 5000 → premiers sites sur 5001, 5002…) |
| `CLOUDFLARE_API_TOKEN` | Token Wrangler pour deploy CF Pages (mode `cloudflare`) |
| `CLOUDFLARE_ACCOUNT_ID` | ID compte Cloudflare (mode `cloudflare`) |

## Points d'attention

- `BUILDER_INTERNAL_URL` évite de passer par Traefik/TLS depuis le container
- Le patch `patchDataFilesForPrerender` corrige un bug vike où `pageContext.headers` est vide au build time
- vike est épinglé à `TARGET_VIKE` (constante dans le code) — ne pas changer sans tester
- Les custom domains (contenant un `.`) reçoivent une config Traefik auto-générée pour Let's Encrypt
- Le nom de projet CF Pages est dérivé du domain (sanitisé en `[a-z0-9-]+`, max 58 chars)
- Transition SSG→SSR : les `node_modules` sont forcément réinstallés (templates incompatibles)
- Transition SSR→SSG : le subprocess SSR est stoppé proprement avant le build SSG

## Docker

```bash
docker build -t webstudio-publisher .
# Image publiée sur : ghcr.io/webstudio-community/webstudio-publisher
```
