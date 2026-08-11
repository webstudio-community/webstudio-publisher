# CLAUDE.md — webstudio-publisher

Service Node.js (ESM, no build step) qui publie les sites lors d'une publication, avec support multi-destinations.

## Branches

- Branche principale : `main`
- Toutes les branches de fix/feature partent de `main` et ouvrent une PR vers `main`.

## Fichier principal

`server.mjs` — tout le service tient dans ce fichier unique. Pas de dépendances npm locales.

## Modes de publication

Le champ `buildMode` dans le body du `POST /publish` détermine la destination (défaut: `"ssg"`).

### `ssr` — Container Docker par domaine

```
POST /publish { buildId, builderOrigin, buildMode: "ssr" }
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template docker
  → écriture de DOCKER_SITE_DOCKERFILE dans workDir/Dockerfile
  → DOCKER_BUILDKIT=1 docker build -t <ws-domain> .   ← une seule fois
  → docker stop/rm <container> ; docker run -p PORT:3000 -d --restart=unless-stopped
  → docker image prune -f
  → state.json { mode: "docker", port, imageName, containerName, publishDomain, customDomains }
  → tous les hostnames (publishDomain + customDomains) enregistrés dans ssrHostPort
```

**Infra requise** : monter `/var/run/docker.sock` dans le container publisher.
Un warning est loggé au démarrage si le socket n'est pas accessible.

**Ports** : range `DOCKER_PORT_BASE+1…` (défaut 6001+).
Un seul container par domaine — tous les custom domains sont proxiés vers le même port.

**Optimisations** (`DOCKER_SITE_DOCKERFILE`) :
- Build multi-stage : prod deps uniquement dans l'image finale
- Cache mounts BuildKit sur `/root/.npm` → pas de re-download entre les republications

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
  → arrêt du mode précédent (container docker / process ssr) + purge de /var/publish/<hostname>
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template cloudflare
  → npm install (si node_modules absent OU appartient à un autre template)
  → npm run build  (remix vite:build → build/client/)
  → wrangler pages project create <domain-sanitisé> --production-branch main   ← si absent
  → wrangler pages deploy ./build/client --project-name <domain-sanitisé> --branch main
  → state.json { mode: "cloudflare", cfProjectName, publishDomain, customDomains }
```

Requiert `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`.

**Le projet CF Pages n'est PAS créé automatiquement par le deploy.** wrangler 3 le
faisait ; wrangler 4 a supprimé ce comportement et échoue avec `The Pages project
"<name>" does not exist`. Le template épingle `wrangler@^3.63.2` en devDependency mais
`ensureWrangler` installe le dernier wrangler en global, et c'est celui-là qui tourne —
donc en pratique on est toujours sur le comportement wrangler 4. D'où le
`pages project create` explicite, qui est correct sur les deux majeures.

`--branch` est explicite parce que `workDir` n'est pas un dépôt git : sans lui wrangler
ne peut pas déduire qu'il s'agit de la branche de production et le déploiement part en
preview au lieu de `<project>.pages.dev`.

Le projet Pages n'est jamais supprimé par le publisher — ni sur changement de mode, ni
sur unpublish. C'est un appel destructeur dans le compte Cloudflare de l'utilisateur ;
le site reste joignable sur `<project>.pages.dev` et doit être retiré à la main.

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
| `DOCKER_PORT_BASE` | Base des ports containers Docker (défaut: 6000 → premiers sites sur 6001, 6002…) |
| `CLOUDFLARE_API_TOKEN` | Token Wrangler pour deploy CF Pages (mode `cloudflare`) |
| `CLOUDFLARE_ACCOUNT_ID` | ID compte Cloudflare (mode `cloudflare`) |
| `CLOUDFLARE_PRODUCTION_BRANCH` | Branche de production des projets Pages créés (défaut: `main`) |

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

### CLI webstudio ↔ lockstep avec le builder (IMPORTANT)

Le handshake `webstudio sync` est verrouillé par un **hash de contrat de bundle** +
la surface des routes tRPC, tous deux dérivés du schéma du **fork**. Le CLI publié
sur npm (`webstudio@latest`) est buildé depuis le schéma **upstream** → rejeté par
l'API du fork (`apiCompatibilityError`).

→ Le `Dockerfile` **build donc le CLI depuis le fork** (stage `cli-build`), au commit
passé via `--build-arg WEBSTUDIO_REF`. Le CI (`docker-publish.yml`) lit le label
`org.opencontainers.image.revision` de `ghcr.io/webstudio-community/builder:latest`
et l'utilise comme ref → le CLI du publisher est toujours au **même commit que le
builder déployé**. Ne jamais revenir à `npm install -g webstudio@latest`.

### Version des packages `@webstudio-is/*` stampée (`WEBSTUDIO_SDK_VERSION`)

Buildé depuis les sources, le CLI garde le placeholder `0.0.0-webstudio-version`.
Les sites générés déclareraient alors `@webstudio-is/*@0.0.0-webstudio-version` →
`npm install` échoue (`ETARGET`, version inexistante sur npm).

→ Le stage `cli-build` **remplace** ce placeholder par une vraie version publiée
dans tous les `package.json` (même étape que `release.yml` du fork), avant install.
Par défaut = `npm view webstudio@latest version` (résolu à chaque build d'image),
surchargeable via `--build-arg WEBSTUDIO_SDK_VERSION=x.y.z`. N'affecte PAS la compat
sync/build (celle-ci dépend du schéma, pas de la chaîne de version) — fixe seulement
quel **SDK runtime** publié les sites générés téléchargent. Deux axes distincts :
le CLI suit le commit du builder, le SDK runtime suit la dernière version npm.
