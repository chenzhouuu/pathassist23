# PathAssist UI — Development Changelog

> Recent development cycle covering Viewport Captures, EC2 Server Setup, and the removal of the
> browser-side AI layer.
> All changes are on branch `keycloak-integration`.

---

## Table of Contents

1. [Browser-side AI — removed](#1-browser-side-ai--removed)
2. [Viewport Captures → Girder](#2-viewport-captures--girder)
3. [Multi-Brand Deployment Architecture](#3-multi-brand-deployment-architecture)
4. [EC2 Server Setup & Infrastructure](#4-ec2-server-setup--infrastructure)
5. [Keycloak SSO Integration](#5-keycloak-sso-integration)
6. [Performance Tuning — Girder & OME-TIFF](#6-performance-tuning--girder--ome-tiff)
7. [Environment Variables Reference](#7-environment-variables-reference)
8. [Deployment Runbook](#8-deployment-runbook)

---

## 1. Browser-side AI — removed

Ki67 IHC scoring and two tumour-composition grids used to run **in the browser**: the page fetched a
region from Girder, posted the pixels to Anthropic or Google using each vendor's JavaScript SDK, and
showed the returned JSON in an **AI** tab. Both models were presented under one brand name, *Pragna*.
All of it was removed on 2026-08-03 (`{HASH}`).

> **Why.** The API key had to reach the browser as a `VITE_*` variable, which Vite inlines into the
> bundle — shipping the feature meant publishing the key to anyone who could load the page. The
> results were held in one browser's `localStorage`, capped at 20 and not keyed by slide, so a second
> reader saw nothing and the reader who ran it saw the previous slide's cards on the next slide. Both
> "Locate ROI" buttons passed image-pixel coordinates to OpenSeadragon's `fitBounds()`, which takes
> viewport coordinates, so neither jumped to the right place. And the single-ROI path put no cap on
> the region it fetched, so a large box produced a PNG too big for the request to succeed.

What replaced it: analyses are submitted from the **Analysis** catalog, run as Girder jobs, and land
as artifacts that the **Workspace** reads and the **Runs** list tracks — server-side credentials,
results that outlive the browser, and numbers attached to the slide they came from.

Deleted: `src/api/claudeApi.js`, `src/api/geminiApi.js`, `src/api/wsiAnalysis.js`,
`src/components/panels/AIPanel.jsx`, `WsiResultCard.jsx`, `WsiAnalyzingCard.jsx`, the four
`Analyze …` entries in `ContextMenu.jsx`, and the `@anthropic-ai/sdk` / `@google/generative-ai`
dependencies. `VITE_ANTHROPIC_API_KEY` and `VITE_GEMINI_API_KEY` are read by nothing.

Full account of what it did, what it got wrong, and what rebuilding it would take:
**`docs/ai-panel-technical-report.md`**.

---

## 2. Viewport Captures → Girder

### Overview

The toolbar's **Camera Save to Server** button uploads the current viewport as a full-resolution PNG to a **Captures** subfolder in the same Girder folder as the slide.

### Region Coordinate Extraction

The region is recorded in **image pixel coordinates** (full-resolution slide space), not screen pixels, and travels with the upload as file metadata:

```js
const b = osd.viewport.getBounds(true);
const tl = osd.viewport.viewportToImageCoordinates(b.x, b.y);
const br = osd.viewport.viewportToImageCoordinates(b.x + b.width, b.y + b.height);
region = {
  x: Math.max(0, Math.round(tl.x)),
  y: Math.max(0, Math.round(tl.y)),
  width:  Math.round(br.x - tl.x),
  height: Math.round(br.y - tl.y),
};
```

### Where it lands

```
<slide folder>/
  └── Captures/
        └── SlideName__capture__2026-03-15T10-23-00.png
```

Metadata saved with the upload: `sourceItemId`, `sourceItemName`, `sourceFolderId`, `capturedAt`, `capturedBy`, `region` (JSON string).

> A **Panels** tab used to collect these captures in `localStorage` and submit them to Pragna as a batch Ki67 run. It was removed on 2026-08-02 (`1c6844a`): the batch fetched every region at 512 px however large the capture was, so its counts could not mean anything. Single-ROI and whole-slide Ki67 outlived it by a day and then went too — see §1. The camera button itself is unaffected.

---

## 3. Multi-Brand Deployment Architecture

### Overview

A single EC2 instance serves **three brands** from the same codebase. Each brand gets its own Nginx virtual host, its own `dist/` folder, and is rebuilt with brand-specific Vite environment variables.

### Brands

| Brand | Domain | Container | Folder |
|-------|--------|-----------|--------|
| **Impart DX** (lymphoma) | `impart.pathassist.health` | `pathassist-lymphoma` | `/opt/pathassist-lymphoma` |
| **MDA PathAssist** | `mda.pathassist.health` | `pathassist-mda` | `/opt/pathassist-mda` |
| **Algopath** | `algopath.pathassist.health` | `pathassist-algopath` | `/opt/pathassist-algopath` |

Dev domains (`.dev.pathassist.health`) also exist for each brand.

### Build-time Branding Variables

Each brand is built by injecting shell environment variables before `npm run build`:

```bash
VITE_APP_NAME='MDA PathAssist' \
VITE_LOGO_SRC='/mda-logo.png' \
VITE_APP_TAGLINE='Digital Pathology Platform' \
npm run build
```

**Important:** The EC2 `.env.local` must NOT contain `VITE_APP_NAME` or `VITE_LOGO_SRC`. Vite gives `.env.local` higher priority than shell env vars, which would cause all brands to show the same branding.

### Deploy Script

```bash
# Deploy a single brand
./deploy/deploy-ui.sh mda

# Deploy all brands
./deploy/deploy-ui.sh all
```

The script (`deploy/deploy-ui.sh`):
1. `git pull` on EC2
2. Builds with brand env vars
3. `rm -rf $TARGET/dist/*` then copies new dist (prevents stale hashed chunks)
4. `docker compose restart <container>`

### Nginx Routing

`deploy/nginx-multi.conf` routes by hostname:
- `/api/*` → Girder (`:8080`) — shared by all brands
- `/` → brand-specific UI container (`:3000`)

All brands share the same **Girder** backend, same **Keycloak** auth, same **MongoDB** database.

---

## 4. EC2 Server Setup & Infrastructure

### Server

- **Provider:** AWS EC2
- **IP:** `54.224.61.23`
- **SSH:** `ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23`
- **CPU:** 8 cores
- **RAM:** 15.34 GiB

### Docker Compose Services

All services run under `/opt/digital_slide_archive/devops/ver5/docker-compose.yml`.

| Service | Image | CPUs | Memory | Purpose |
|---------|-------|------|--------|---------|
| `girder` | `dsarchive/dsa_common_5` | 6.0 | 10g | WSI tile server (Girder + large_image) |
| `worker` | `dsarchive/dsa_common_5` | 2.0 | 3g | Celery async task worker |
| `mongodb` | `mongo:latest` | — | 3g | Database (WiredTiger 2GB cache) |
| `memcached` | `memcached` | — | 2g | Tile cache (`-m 2048`) |
| `rabbitmq` | `rabbitmq:latest` | — | — | Celery broker |
| `keycloak` | `quay.io/keycloak/keycloak:24.0` | — | 1g | SSO / identity provider |
| `postgres-keycloak` | `postgres:15-alpine` | — | — | Keycloak's database |
| `pathassist-lymphoma` | `node:20-alpine` | — | — | Impart DX UI (serve dist) |
| `pathassist-mda` | `node:20-alpine` | — | — | MDA UI (serve dist) |
| `pathassist-algopath` | `node:20-alpine` | — | — | Algopath UI (serve dist) |
| `nginx-multi-proxy` | `nginx:alpine` | — | — | Reverse proxy (port 80) |

### Girder Configuration

Girder runs under gunicorn with **6 workers**:

```bash
gunicorn --timeout 0 girder.wsgi:app --bind=0.0.0.0:8080 --workers=6 --preload
```

Key environment variables in docker-compose:

```yaml
LARGE_IMAGE_CACHE_BACKEND: memcached
LARGE_IMAGE_CACHE_TILESOURCE_MAXIMUM: 100    # keep 100 slides open in memory
LARGE_IMAGE_SOURCE_TIFF_CONCURRENCY: 4       # max concurrent tile decoders per slide
LARGE_IMAGE_SOURCE_PYVIPS_ENABLED: true      # faster than openslide for OME-TIFF
GIRDER_SERVER_MODE: production
GIRDER_SETTING_CORE_CACHE_ENABLED: true
```

### Disk Layout

```
/opt/pathassist23/          ← git repo (source of truth)
/opt/pathassist-lymphoma/   ← Impart DX built dist
/opt/pathassist-mda/        ← MDA built dist
/opt/pathassist-algopath/   ← Algopath built dist
/opt/digital_slide_archive/ ← DSA (Girder) docker-compose + config
  └── devops/ver5/
        ├── docker-compose.yml
        ├── nginx-multi.conf
        ├── girder.cfg
        ├── start_girder.sh
        ├── start_worker.sh
        ├── assetstore/        ← uploaded slide files
        ├── db/                ← MongoDB data
        └── logs/              ← Girder logs
/mnt/dsa-cache/             ← large_image tile cache (FUSE diskcache, 50GB)
```

### Common Admin Commands

```bash
# SSH into EC2
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23

# View all container status
cd /opt/digital_slide_archive/devops/ver5
docker compose ps

# View Girder logs
docker compose logs -f girder

# Restart a specific service
docker compose restart girder

# Monitor resource usage
docker stats

# Full redeploy of all brands
./deploy/deploy-ui.sh all   # run from local machine
```

---

## 5. Keycloak SSO Integration

### Overview

All three brands authenticate via **Keycloak 24** running at `auth.pathassist.health`. Users log in once and are recognized across brands.

### Setup

- **Admin URL:** `http://auth.pathassist.health/`
- **Admin user:** `admin`
- **Realm:** `pathassist` (shared across all brands)
- **Client:** `pathassist-girder` (handles Girder OAuth redirect)

### Realm vs Client Strategy

**One shared realm** (`pathassist`) for all brands — users and groups are defined once. Each brand does not need its own realm. The single `pathassist-girder` client handles all brands because they all share the same Girder backend.

If brands needed **completely separate user bases** (e.g., different hospitals with no shared users), each would get its own realm.

### Role-Based Access (Girder Groups)

User access to features is controlled by Girder group membership, defined in `src/store/index.js`:

```js
ROLE_MAP: {
  'projects-users':       ['lab-manager', 'pathologist'],
  'second-opinion-users': ['lab-manager', 'pathologist', 'fellow', 'second-opinion-reviewer', 'referring-physician'],
  'annotation-users':     ['lab-manager', 'pathologist', 'fellow', 'researcher', 'second-opinion-reviewer'],
  'import-users':         ['lab-manager', 'lab-technician'],
  'worklist-users':       ['lab-manager', 'pathologist', 'fellow', 'researcher', 'lab-technician'],
},
```

Girder site admins (`user.admin = true`) bypass all role checks.

### Resetting Keycloak Admin Password

If the admin password is lost, reset it via the PostgreSQL database:

```bash
# 1. Generate a new pbkdf2-sha512 hash (Python)
python3 - <<'EOF'
import hashlib, base64, os, json
salt = base64.b64encode(os.urandom(16)).decode()
iterations = 27500
dk = hashlib.pbkdf2_hmac('sha512', 'NewPassword123!'.encode(), salt.encode(), iterations)
h = base64.b64encode(dk).decode()
secret_data = json.dumps({"value": h, "salt": salt, "additionalParameters": {}}, separators=(',', ':'))
credential_data = json.dumps({"hashIterations": iterations, "algorithm": "pbkdf2-sha512", "additionalParameters": {}}, separators=(',', ':'))
print("secret_data:", secret_data)
print("credential_data:", credential_data)
EOF

# 2. Connect to Keycloak's PostgreSQL
docker exec -it keycloak-postgres psql -U keycloak -d keycloak

# 3. Find the credential ID for the admin user
SELECT c.id FROM credential c
JOIN user_entity u ON c.user_id = u.id
WHERE u.username = 'admin' AND c.type = 'password';

# 4. Update the password hash
UPDATE credential
SET secret_data = '{"value":"<hash>","salt":"<salt>","additionalParameters":{}}',
    credential_data = '{"hashIterations":27500,"algorithm":"pbkdf2-sha512","additionalParameters":{}}'
WHERE id = '<credential-id>';

# 5. Restart Keycloak to clear session cache
docker compose restart keycloak
```

**Note:** The JSON must use compact format (no spaces after `:` or `,`). Keycloak rejects pretty-printed JSON.

---

## 6. Performance Tuning — Girder & OME-TIFF

### Problem

When 2–3 users simultaneously open OME-TIFF slides, Girder CPU spikes to 400%. Root causes:
1. Girder was only allocated 4 CPUs — insufficient for concurrent tile decoding
2. OpenSlide has limited OME-TIFF support; falls back to libTIFF which is slower
3. Multiple concurrent users each trigger independent tile decoders for the same slide

### Solutions Applied

**1. CPU rebalancing (docker-compose.yml):**

| Service | Before | After |
|---------|--------|-------|
| Girder CPUs | 4.0 | **6.0** |
| Girder Memory | 7g | **10g** |
| Gunicorn workers | 4 | **6** |
| Worker CPUs | 6.0 | **2.0** (was unused) |

**2. Tile decoder concurrency cap:**

```yaml
LARGE_IMAGE_SOURCE_TIFF_CONCURRENCY: 4
```

Prevents N users from each spawning unlimited parallel TIFF decoders. With 6 CPUs and this cap, tile throughput stays consistent under concurrent load.

**3. pyvips tile source enabled:**

```yaml
LARGE_IMAGE_SOURCE_PYVIPS_ENABLED: true
```

pyvips is significantly faster than OpenSlide for pyramid TIFF and OME-TIFF formats. large_image will prefer it over openslide when both are available.

**4. Memcached tile cache:**

```yaml
LARGE_IMAGE_CACHE_BACKEND: memcached
command: -m 2048 --max-item-size 8M   # 2GB in-memory tile cache
```

Decoded tiles are cached in Memcached so subsequent requests for the same tile region don't re-decode.

### Further Optimization (if needed)

For very large OME-TIFF collections, convert files to **Cloud-Optimized GeoTIFF (COG)** or **pyramidal TIFF** format:

```bash
# Inside Girder container using large_image_converter
python -m large_image_converter input.ome.tiff output.tiff
```

COG/pyramidal TIFF tiles cache far more efficiently and reduce per-tile CPU cost by 60–80%.

---

## 7. Environment Variables Reference

### EC2 `.env.local` (`/opt/pathassist23/.env.local`)

Nothing is required here any more. `VITE_ANTHROPIC_API_KEY` and `VITE_GEMINI_API_KEY` used to live in
this file; they went with the AI tab on 2026-08-03 (§1) and are read by nothing. Delete them from any
`.env.local` you are carrying forward — a `VITE_*` key is inlined into the bundle, so it is readable
by anyone who loads the page. Model credentials belong to the server-side services.

**Do NOT add branding variables here.** Branding is injected as shell env vars at build time.

### Vite Build-time Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_APP_NAME` | Brand name shown in header/title | `MDA PathAssist` |
| `VITE_LOGO_SRC` | Path to logo in `public/` | `/mda-logo.png` |
| `VITE_APP_TAGLINE` | Subtitle under logo | `Digital Pathology Platform` |
| `VITE_GIRDER_API_URL` | Girder API base URL | `https://mda.pathassist.health/api/v1` |

### Priority Order (highest to lowest)

1. Shell environment variables (used during `npm run build`)
2. `.env.local` (local overrides — not committed to git)
3. `.env` (committed defaults)

---

## 8. Deployment Runbook

### Deploy a Single Brand

```bash
# From local machine
./deploy/deploy-ui.sh mda        # MDA PathAssist
./deploy/deploy-ui.sh algopath   # Algopath
./deploy/deploy-ui.sh lymphoma   # Impart DX (latest)
./deploy/deploy-ui.sh all        # All three brands
```

### Deploy Only the Lymphoma Build to All Impart Sites

The `lymphoma` brand serves both `impart.pathassist.health` and `lymphoma.dev.pathassist.health` from the same container. One build covers both.

### Verify Deployment

After deploying, check:
1. Open the brand's URL in an incognito window
2. Confirm the correct logo and app name appear
3. Confirm `/api/v1/system/version` returns 200 (Girder is up)
4. Log in with a test user
5. Open a slide and confirm tiles load

### Rollback

```bash
# SSH to EC2
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23

# Check git log
cd /opt/pathassist23 && git log --oneline -5

# Roll back to previous commit
git checkout <previous-commit-hash>
VITE_APP_NAME='MDA PathAssist' VITE_LOGO_SRC='/mda-logo.png' npm run build
rm -rf /opt/pathassist-mda/dist/* && cp -r dist/. /opt/pathassist-mda/dist/
cd /opt/digital_slide_archive/devops/ver5 && docker compose restart pathassist-mda
```

### Restart Services

```bash
cd /opt/digital_slide_archive/devops/ver5

# Restart everything
docker compose down && docker compose up -d

# Restart only Girder (most common)
docker compose restart girder

# Recreate Girder with new resource limits
docker compose up -d --force-recreate girder
```

---

*Last updated: 2026-03-15*
