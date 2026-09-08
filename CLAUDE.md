# CLAUDE.md — webstudio-publisher

Service Node.js (ESM, no build step) qui publie les sites lors d'une publication, avec support multi-destinations.

## Branches

- Branche principale : `main`
- Toutes les branches de fix/feature partent de `main` et ouvrent une PR vers `main`.

## Fichier principal

`server.mjs` — tout le service tient dans ce fichier unique. Pas de dépendances npm locales.

## Cibles de publication — `renderMode` × `host`

Une cible de publication = deux axes orthogonaux dans le body du `POST /publish` :

| `renderMode` | `host` | pipeline | statut |
|---|---|---|---|
| `ssg` | `local` | `publishBuild` — Vite prerender → `/var/publish/<host>/` | ✅ |
| `ssr` | `local` | `publishBuildSsr` — `docker build` + `docker run` par domaine | ✅ |
| `ssg` | `cloudflare` | `publishBuildCloudflare` — `wrangler pages deploy` | ✅ (si `CLOUDFLARE_*`) |
| `ssg` | `ssh` | rsync vers serveur distant | 🔜 `501` — self-host#7 |
| `ssr` | `coolify` | app Coolify distante | 🔜 `501` — self-host#23 |
| `ssg` | `coolify` | app Coolify distante (nginx) | 🔜 `501` — self-host#24 |

Le mapping request → pipeline vit dans `RENDER_HOSTS` / `normalizeTarget` / `availableTargets`
(section « Publish target » de `server.mjs`). En interne, `state.json.mode` vaut
`docker` (pour `ssr`) ou `cloudflare` — un site SSG local n'écrit pas de `state.json`.

**Champ `buildMode` hérité** — toujours accepté (CLI `webstudio` npm upstream, anciennes
images builder). Mapping : `ssg` → `ssg`/`local`, `ssr` → `ssr`/`local`,
`cloudflare` → `ssg`/`cloudflare`.

`GET /capabilities` renvoie `{ cloudflare, coolify, ssh, targets: ["ssg:local", …] }` —
`targets` = les paires réellement disponibles, que le builder utilise pour griser les autres.

### `ssr` — Container Docker par domaine

```
POST /publish { buildId, builderOrigin, buildMode: "ssr" }
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template docker
  → écriture de DOCKER_SITE_DOCKERFILE dans workDir/Dockerfile
  → DOCKER_BUILDKIT=1 docker build -t <ws-domain> .   ← une seule fois
  → docker stop/rm <container> ; docker run -p PORT:3000 -d --restart=unless-stopped
  → docker image prune -f
  → state.json { mode: "docker", imageName, containerName, publishDomain, customDomains }
  → tous les hostnames (publishDomain + customDomains) enregistrés dans dockerHostContainer
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
  → WEBSTUDIO_PRERENDER_ORIGIN=... WEBSTUDIO_SITEMAP_ORIGIN=... npx vite build
  → réécriture des URLs absolues (.html et .xml) vers l'origine publique
  → cp dist/client → /var/publish/<domain>/ (+ une copie par custom domain,
    réécrite vers l'origine de ce domaine)
```

### `cloudflare` — Cloudflare Pages

```
POST /publish { buildId, builderOrigin, buildMode: "cloudflare" }
  → arrêt du mode précédent (container docker) + purge de /var/publish/<hostname>
  → webstudio sync --buildId --origin --authToken
  → webstudio build --template cloudflare
  → npm install (si node_modules absent OU appartient à un autre template)
  → npm run build  (remix vite:build → build/client/)
  → ./node_modules/.bin/wrangler pages project create <domain-sanitisé> --production-branch main   ← si absent
  → ./node_modules/.bin/wrangler pages deploy ./build/client --project-name <domain-sanitisé> --branch main
  → rattachement de chaque customDomain au projet Pages (API Cloudflare)
  → state.json { mode: "cloudflare", cfProjectName, publishDomain, customDomains }
```

Requiert `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`.

**Le projet CF Pages n'est PAS créé automatiquement par le deploy.** wrangler 3 le
faisait ; wrangler 4 a supprimé ce comportement et échoue avec `The Pages project
"<name>" does not exist`. D'où le `pages project create` explicite, qui est correct sur
les deux majeures.

**wrangler tourne depuis le `node_modules` local, jamais en global.** Le template
épingle `wrangler@^3.63.2` en devDependency ; `npm install` (étape précédente) installe
donc déjà la bonne version dans `node_modules/.bin/wrangler` de chaque workDir. Un
`npm install -g wrangler` résout toujours la dernière version, qui dérive de l'épingle
du template dès qu'une nouvelle majeure sort — c'est exactement ce qui a cassé
`pages project create` avec wrangler 4.

`--branch` est explicite parce que `workDir` n'est pas un dépôt git : sans lui wrangler
ne peut pas déduire qu'il s'agit de la branche de production et le déploiement part en
preview au lieu de `<project>.pages.dev`.

**Les custom domains sont attachés via l'API Cloudflare, pas wrangler.** Le CLI n'a
aucune commande pour ça (`wrangler pages project` se limite à create/delete/list) — donc
`POST /accounts/:account_id/pages/projects/:project_name/domains` avec
`{ "name": "<domain>" }`, idempotent (une tentative sur un domaine déjà attaché échoue
proprement côté API, loggé et ignoré). Ça n'enregistre le domaine que côté Pages ;
l'enregistrement DNS (CNAME vers `<project>.pages.dev`) reste à la charge de
l'utilisateur.

Le projet Pages n'est jamais supprimé par le publisher — ni sur changement de mode, ni
sur unpublish. C'est un appel destructeur dans le compte Cloudflare de l'utilisateur ;
le site reste joignable sur `<project>.pages.dev` et doit être retiré à la main.

**Le domaine de staging local (`<slug>.wstdwork.morain.fr`) reste fonctionnel.** Pages
ne sert que sur `<project>.pages.dev` (+ les custom domains attachés) — sans rien de
plus, le domaine de staging que le builder affiche toujours comme "site publié" 404
puisque `/var/publish/<hostname>` est purgé à l'entrée en mode cloudflare. Le proxy
(port `PROXY_PORT`) reverse-proxy donc ce domaine vers `<cfProjectName>.pages.dev` via
la map `cfProjectHost` (hostname de staging → nom de projet), remplie à la publication
et restaurée au démarrage depuis `state.json`. Un custom domain n'y entre jamais : son
DNS pointe directement sur Cloudflare et ne repasse pas par le publisher.

Les jobs sont sérialisés **par domaine** via une queue de promesses (`projectQueues`).

## Proxy de sites (port PROXY_PORT)

Le serveur proxy sur port 4001 sert tous les sites publiés :
- **SSR** (`mode: "docker"`) : reverse-proxy vers le container Docker du domaine (`<container>:3000` sur `DOCKER_NETWORK`)
- **Cloudflare** (`mode: "cloudflare"`) : le hostname de staging est reverse-proxié vers `<project>.pages.dev`
- **SSG** : fichiers statiques servis directement depuis `/var/publish/<host>/`

## Persistance de l'état (`state.json`)

Un domaine servi par un runtime écrit `/var/work/<domain>/state.json` :
```json
{ "mode": "docker", "imageName": "ws-mysite", "containerName": "ws-mysite", "publishDomain": "mysite.wstd.work", "customDomains": [] }
```
`mode` ∈ `docker` | `cloudflare`. Un site SSG local n'écrit pas de `state.json` (les fichiers sur disque suffisent).

Au démarrage, `restoreTargets()` relit tous les `state.json` : les containers Docker sont (re)démarrés, les routes de staging Cloudflare ré-enregistrées. SSG n'a rien à restaurer.

## Variables d'environnement

| Variable | Rôle |
|----------|------|
| `TRPC_SERVER_API_TOKEN` | Token d'auth pour l'API du builder |
| `BUILDER_INTERNAL_URL` | URL interne Docker du builder (défaut: `http://app:3000`) |
| `PUBLISHER_HOST` | Suffixe de domaine pour les slugs sans point |
| `TRAEFIK_DYNAMIC_DIR` | Si défini, écrit les configs Traefik pour les domaines custom |
| `PORT` | Port de l'API build (défaut: 4000) |
| `PROXY_PORT` | Port du proxy de sites (défaut: 4001) |
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
- Transition SSR→SSG : le container Docker est stoppé/supprimé proprement avant le build SSG

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

**Tester une branche builder non mergée** : `docker-publish.yml` accepte trois inputs
de `workflow_dispatch` — `builder_ref` (branche/tag/commit du fork, court-circuite la
lecture du label), `image_tag` (optionnel, défaut `builder-<ref>`) et `nonce`
(optionnel, marqueur repris dans le `run-name` pour qu'un dispatcher automatique
retrouve le run). Une image ainsi
pinnée n'est **jamais** taguée `:latest`, même dispatchée depuis `main` : c'est le
rôle de la sortie `pinned` du step « Compute branch tag », car `github.ref` vaut
`refs/heads/main` sur un dispatch depuis `main` et suffirait sinon à écraser `:latest`.

Depuis le fork, **chaque PR interne déclenche ce dispatch automatiquement** (job
`publisher-test-image` de `docker-publish.yml` côté fork) : `builder_ref` = la branche
de la PR, `nonce` = `pr<N>-<run_id>-<attempt>`. Le fork attend la fin du build puis
poste/édite un commentaire unique dans la PR avec les deux refs d'images
(`builder:<branche>` + `webstudio-publisher:builder-<branche>`). À la fermeture de la
PR, le `docker-cleanup.yml` du fork dispatche celui d'ici (input `tag`) pour supprimer
l'image de test.

`builder_ref` est résolu en **SHA** via `git ls-remote` avant le build : le stage
`cli-build` cache `git checkout "$WEBSTUDIO_REF"` sur une couche keyée par la valeur
littérale de l'ARG, donc re-dispatcher la **même branche** après un nouveau commit
réutiliserait un checkout périmé si on passait le nom de branche tel quel.

```bash
gh workflow run docker-publish.yml --repo webstudio-community/webstudio-publisher \
  -f builder_ref=<branche-du-fork>
```

C'est indispensable dès qu'un sync upstream déplace le `bundleVersion` : le builder
rebasé et le CLI du publisher doivent être buildés depuis le **même** commit, sinon
`assertCliBundleVersion` rejette le publish (`Project bundle format is incompatible`).

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
