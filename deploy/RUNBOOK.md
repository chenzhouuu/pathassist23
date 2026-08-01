# PathAssist Infrastructure Runbook

> This document covers all deployment, infrastructure, and operational procedures.
> Keep this updated when anything changes.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [EC2 Server](#2-ec2-server)
3. [Domain & Nginx Routing](#3-domain--nginx-routing)
4. [Docker Services](#4-docker-services)
5. [Deploy UI (Day-to-Day)](#5-deploy-ui-day-to-day)
6. [Deploy Girder / Backend](#6-deploy-girder--backend)
7. [Uploading Slide Images](#7-uploading-slide-images)
8. [Backups](#8-backups)
9. [Disaster Recovery](#9-disaster-recovery)
10. [AWS Cost Optimization](#10-aws-cost-optimization)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. System Overview

```
Browser
  │
  ▼
EC2 (54.224.61.23)  ← Histamics2.0, m6a.2xlarge target
  │
  ├── nginx:80          Routes by domain → correct UI container
  │     ├── /api/*  →  girder:8080      (stays inside Docker network)
  │     └── /*      →  pathassist-*:3000
  │
  ├── girder:8080       DSA v5 backend (REST API, tile server)
  │     ├── mongodb:27017   Girder database (users, folders, annotations)
  │     ├── memcached:11211 Tile cache (4GB, in-memory)
  │     └── rabbitmq:5672   Job queue for CLI tasks
  │
  └── worker            Celery worker (runs Slicer CLI Docker jobs)

S3 (algopathp-pathssist-health)   ← ALL slide images (OME-TIFF), never lost
S3 (pathassist-backups)           ← Weekly MongoDB + config backups
GitHub (pathassist23 repo)        ← All source code, branch: keycloak-integration
```

---

## 2. EC2 Server

| Property | Value |
|----------|-------|
| Instance | Histamics2.0 |
| Current IP | 54.224.61.23 *(changes on stop/start — get fresh IP each time)* |
| Instance ID | i-04e4878afcd65a5a1 |
| Type | c6i.2xlarge (target: m6a.2xlarge Reserved) |
| Region | us-east-1 |
| Key | `~/.ssh/histamics20.pem` |
| OS | Ubuntu 22.04 |
| Root disk | 200GB gp3 |

### SSH to EC2
```bash
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23
```

### Get current EC2 IP (if it changed after restart)
```bash
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" \
  --query "Reservations[*].Instances[*].{ID:InstanceId,IP:PublicIpAddress,Name:Tags[?Key=='Name']|[0].Value}" \
  --output table --region us-east-1
```

### Key directories on EC2

| Path | Purpose |
|------|---------|
| `/opt/digital_slide_archive/devops/ver5/` | Docker Compose working directory |
| `/opt/digital_slide_archive/devops/ver5/db/` | MongoDB data files (409MB, CRITICAL) |
| `/opt/digital_slide_archive/devops/ver5/logs/` | Girder logs |
| `/opt/digital_slide_archive/dsa5.Dockerfile` | Girder Docker image definition |
| `/opt/pathassist23/` | UI source code (git clone of pathassist23 repo) |
| `/opt/pathassist-mda/dist/` | MDA built UI files |
| `/opt/pathassist-algopath/dist/` | Algopath built UI files |
| `/opt/pathassist-lymphoma/dist/` | Impart DX built UI files |
| `/mnt/dsa-cache/` | FUSE disk cache for S3 slide bytes |

---

## 3. Domain & Nginx Routing

All domains point to EC2 IP via Route 53 (wildcard `*.pathassist.health`).

| Domain | Container | Brand | Notes |
|--------|-----------|-------|-------|
| `mda.dev.pathassist.health` | `pathassist-mda` | MDA | Dev environment |
| `mda.pathassist.health` | `pathassist-mda` | MDA | Production |
| `algopath.dev.pathassist.health` | `pathassist-algopath` | Algopath | Dev |
| `algopath.pathassist.health` | `pathassist-algopath` | Algopath | Production |
| `lymphoma.dev.pathassist.health` | `pathassist-lymphoma` | Impart DX | Dev |
| `impart.dev.pathassist.health` | `pathassist-lymphoma` | Impart DX | Dev alias |
| `impart.pathassist.health` | `pathassist-lymphoma` | Impart DX | Production |
| `23.pathassist.health` | `pathassist-lymphoma` | Impart DX | Legacy, keep for now |

**Nginx config location:**
- Local (git): `deploy/nginx-multi.conf`
- On EC2: `/opt/digital_slide_archive/devops/ver5/nginx-multi.conf`

**Nginx rule:** Every domain routes `/api/*` → `girder:8080` (internal Docker network — never goes to internet). All other paths go to the UI container.

### Update nginx config
```bash
# Edit locally
code deploy/nginx-multi.conf

# Copy to EC2 and reload
scp -i ~/.ssh/histamics20.pem deploy/nginx-multi.conf \
  ubuntu@54.224.61.23:/opt/digital_slide_archive/devops/ver5/nginx-multi.conf

ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 \
  "cd /opt/digital_slide_archive/devops/ver5 && docker compose restart nginx-proxy"
```

---

## 4. Docker Services

All services defined in:
`/opt/digital_slide_archive/devops/ver5/docker-compose.yml`

### Service summary

| Service | Image | Port | Resources |
|---------|-------|------|-----------|
| `girder` | Built from `dsa5.Dockerfile` | 8080 | 4 CPU, 7GB RAM |
| `mongodb` | `mongo:latest` | 27017 (internal) | 3GB RAM |
| `memcached` | `memcached` | 11211 (internal) | 4GB RAM |
| `rabbitmq` | `rabbitmq` | 5672 (internal) | - |
| `worker` | Same as girder | - | 6 CPU, 3GB RAM |
| `pathassist-mda` | `node:20-alpine` | 3000 (internal) | - |
| `pathassist-algopath` | `node:20-alpine` | 3000 (internal) | - |
| `pathassist-lymphoma` | `node:20-alpine` | 3000 (internal) | - |
| `nginx-proxy` | `nginx:alpine` | **80 (public)** | - |

### Common Docker commands (run from EC2)
```bash
cd /opt/digital_slide_archive/devops/ver5

# Status of all containers
docker compose ps

# View logs of a service
docker compose logs girder --tail 50 -f
docker compose logs pathassist-lymphoma --tail 30

# Restart a single service
docker compose restart girder
docker compose restart nginx-proxy

# Restart all services
docker compose restart

# Stop everything
docker compose down

# Start everything
docker compose up -d
```

### Girder environment settings (important)
Set in `docker-compose.yml` under `girder → environment`:

```yaml
LARGE_IMAGE_CACHE_BACKEND: memcached
LARGE_IMAGE_CACHE_TILESOURCE_MAXIMUM: 100  # open slide handles in memory
DSA_GIRDER_MOUNT_OPTIONS: "-o diskcache,diskcache_size_limit=53687091200"  # 50GB FUSE cache
```

MongoDB settings (stored in DB, restored with MongoDB backup):
```
large_image.cache_backend = memcached
large_image.cache_memcached_url = memcached:11211
large_image.cache_tilesource_maximum = 100
```

---

## 5. Deploy UI (Day-to-Day)

This is the most common task — deploying new UI code to EC2.

### One-command deploy (from local machine)
```bash
# Deploy Impart DX (lymphoma) — most common
./deploy/deploy-ui.sh

# Deploy MDA brand
./deploy/deploy-ui.sh mda

# Deploy Algopath brand
./deploy/deploy-ui.sh algopath

# Deploy ALL 3 brands at once
./deploy/deploy-ui.sh all
```

### What the script does (4 steps automatically)
1. `git pull` on EC2 at `/opt/pathassist23`
2. `npm run build` with correct brand env vars
3. `cp -r dist/* /opt/pathassist-<brand>/dist/`
4. `docker compose restart pathassist-<brand>`

### Brand environment variables

| Brand | VITE_APP_NAME | VITE_LOGO_SRC | VITE_APP_TAGLINE |
|-------|---------------|---------------|------------------|
| lymphoma (Impart DX) | `Impart DX` | `/impart-dx-logo.png` | `Digital Pathology Platform` |
| mda | `MDA PathAssist` | `/mda-logo.png` | `Digital Pathology Platform` |
| algopath | `Algopath` | `/alogopath-logo.png` | `Digital Pathology Platform` |

### Manual deploy steps (if script fails)
```bash
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23

# On EC2:
cd /opt/pathassist23
git pull

# Build Impart DX
VITE_APP_NAME="Impart DX" VITE_LOGO_SRC="/impart-dx-logo.png" \
  VITE_APP_TAGLINE="Digital Pathology Platform" npm run build

# Copy to target folder
cp -r dist/. /opt/pathassist-lymphoma/dist/

# Restart container
cd /opt/digital_slide_archive/devops/ver5
docker compose restart pathassist-lymphoma
```

### Push local changes before deploy
```bash
# Commit and push from local first
git add -A
git commit -m "your message"
git push origin keycloak-integration

# Then run deploy script (it will git pull the latest)
./deploy/deploy-ui.sh
```

---

## 6. Deploy Girder / Backend

Only needed when you change `dsa5.Dockerfile`, Python packages, or Girder plugins.
**Warning: takes 20-30 minutes to rebuild.**

### When to rebuild Girder image
- Changed `dsa5.Dockerfile`
- Added new Python packages (like `pymemcache`)
- Updated Girder or large_image version

### Rebuild steps
```bash
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23

cd /opt/digital_slide_archive/devops/ver5

# Copy latest Dockerfile from git repo (if changed locally)
# scp -i ~/.ssh/histamics20.pem deploy/dsa5.Dockerfile ubuntu@EC2_IP:/opt/digital_slide_archive/dsa5.Dockerfile

# The build context is /opt/digital_slide_archive (the DSA checkout), NOT this repo, so anything
# dsa5.Dockerfile COPYs has to be put there first. Two things are:
#   deploy/keycloak_oauth_provider.py  → /opt/digital_slide_archive/deploy/keycloak_oauth_provider.py
#   services/girder_pathassist/        → /opt/digital_slide_archive/girder_pathassist/
# scp -i ~/.ssh/histamics20.pem -r services/girder_pathassist \
#     ubuntu@EC2_IP:/opt/digital_slide_archive/girder_pathassist

# Build (takes 20-30 min)
docker compose build girder

# Restart girder with new image
docker compose up -d girder

# Verify it started
docker compose ps
curl -s http://localhost/api/v1/system/version
```

### Iterating on the PathAssist plugin without a 20-minute rebuild

The plugin is a pure-Python package, so a rebuild only earns you persistence. To change it and see
the result in ~30 seconds — the loop used to develop it against the local stack:

```bash
docker cp services/girder_pathassist dsa-girder-1:/opt/girder_pathassist
docker exec -u root dsa-girder-1 /opt/venv/bin/pip install --no-cache-dir -e /opt/girder_pathassist
docker restart dsa-girder-1        # entry points are only scanned at startup

# After the first install, a code-only change needs just the file and the restart:
docker cp services/girder_pathassist/src/girder_pathassist/rest.py \
    dsa-girder-1:/opt/girder_pathassist/src/girder_pathassist/rest.py
docker restart dsa-girder-1

# Confirm the route is mounted (401 = there and authenticated; 404 = not loaded)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
    -d '{}' http://localhost:9080/api/v1/pathassist/run
```

This lives in the container's writable layer, so it survives `docker restart` and dies with
`docker compose up -d --force-recreate girder`. Rebuild the image for anything meant to persist.

### Update docker-compose.yml
```bash
# Edit locally
code deploy/docker-compose.yml

# Copy to EC2
scp -i ~/.ssh/histamics20.pem deploy/docker-compose.yml \
  ubuntu@54.224.61.23:/opt/digital_slide_archive/devops/ver5/docker-compose.yml

# Apply changes
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 \
  "cd /opt/digital_slide_archive/devops/ver5 && docker compose up -d"
```

---

## 7. Uploading Slide Images

Slides live on S3 (`algopathp-pathssist-health`) and are accessed by Girder via the S3 assetstore.

### Upload from NAS (Pramana scanner cluster)
```bash
# Script: scripts/upload_and_import.sh
# Extracts OME-TIFF from ZIP → uploads to S3 → imports into Girder

GIRDER_TOKEN=xxxxx ./scripts/upload_and_import.sh "PatientName" "FolderName_20260312"
```

Script does:
1. Finds ZIP at `/mnt/clusterNas/dicom_data/<FolderName>/<FolderName>.zip`
2. Extracts OME-TIFF files
3. Uploads to `s3://algopathp-pathssist-health/<PatientName>/`
4. Creates patient folder in Girder collection (`694f13b58f7f83d2b00dd62a`)
5. Triggers Girder assetstore import (assetstore ID: `69a0ae0ca28f3a7fc0173829`)

### Check S3 slide buckets
```bash
# List all slide buckets
aws s3 ls s3://algopathp-pathssist-health/ --human-readable --summarize

# List specific patient folder
aws s3 ls s3://algopathp-pathssist-health/PatientName/ --human-readable
```

### Storage classes for S3 buckets

| Bucket | Storage | Purpose |
|--------|---------|---------|
| `algopathp-pathssist-health` | Standard | Active slides (currently being used) |
| `tcga-brca` | Glacier IR | Research archive |
| `laion-2b` | Glacier IR | Research archive |
| `deidentify-bucket` | Glacier IR | De-identified data |
| `stanford-pathassist-dicom` | Glacier IR | Archive |
| `pathassist-backups` | Standard IA | Weekly backups (60-day expiry) |

---

## 8. Backups

### Weekly automated backup
Runs every **Sunday at 2:00 AM** via cron on EC2.

```bash
# Script: deploy/backup-weekly.sh
# On EC2 at: /opt/digital_slide_archive/deploy/backup-weekly.sh

# Run manually anytime
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 \
  "/opt/digital_slide_archive/deploy/backup-weekly.sh"

# Check backup logs
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 \
  "tail -50 /var/log/pathassist-backup.log"
```

### What gets backed up

| Data | Backup Location | Retention |
|------|----------------|-----------|
| MongoDB (girder DB) | `s3://pathassist-backups/mongodb/YYYY-WNN/` | 60 days |
| Config files (compose, nginx, girder.cfg) | `s3://pathassist-backups/configs/YYYY-WNN/` | 60 days |
| dsa5.Dockerfile | `s3://pathassist-backups/configs/YYYY-WNN/` | 60 days |
| EBS snapshot (full disk) | AWS Snapshots | 4 weeks |

### What does NOT need backup (already safe)
| Data | Why |
|------|-----|
| Slide images | On S3 `algopathp-pathssist-health` |
| UI code | In GitHub |
| Docker images | Rebuilt from `dsa5.Dockerfile` (in git) |
| memcached | Ephemeral tile cache, auto-rebuilds |

### Check existing backups
```bash
# List MongoDB backups
aws s3 ls s3://pathassist-backups/mongodb/ --recursive --human-readable

# List EBS snapshots
aws ec2 describe-snapshots --owner-ids self \
  --filters "Name=tag:Project,Values=PathAssist" \
  --query "Snapshots[*].{ID:SnapshotId,Date:StartTime,Size:VolumeSize,Desc:Description}" \
  --output table --region us-east-1
```

---

## 9. Disaster Recovery

See [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md) for full step-by-step guide.

### Quick reference — restore from scratch

```bash
# 1. Launch new EC2 (Ubuntu 22.04, 200GB gp3, m6a.2xlarge)
# 2. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu && newgrp docker
sudo apt-get install -y docker-compose-plugin

# 3. Clone repo
git clone https://github.com/tkantheti/pathassist23.git /opt/pathassist23
cd /opt/pathassist23 && git checkout keycloak-integration

# 4. Restore configs from S3
mkdir -p /opt/digital_slide_archive/devops/ver5
cd /opt/digital_slide_archive/devops/ver5
WEEK=$(date -u +%Y-W%V)
aws s3 cp s3://pathassist-backups/configs/${WEEK}/ . --recursive
tar -xzf configs_*.tar.gz && rm configs_*.tar.gz

# 5. Restore MongoDB
aws s3 cp s3://pathassist-backups/mongodb/${WEEK}/ /tmp/ --recursive
tar -xzf /tmp/mongodb_girder_*.tar.gz -C /tmp/
docker compose up -d mongodb && sleep 15
docker cp /tmp/dump ver5-mongodb-1:/tmp/restore
docker exec ver5-mongodb-1 mongorestore --db girder /tmp/restore/girder --drop

# 6. Rebuild Girder image and start all services
export DSA_USER=$(id -u):$(id -g)
echo "DSA_USER=${DSA_USER}" > .env
docker compose build girder   # takes ~30 min
docker compose up -d

# 7. Deploy UI builds
cd /opt/pathassist23
mkdir -p /opt/pathassist-mda/dist /opt/pathassist-algopath/dist /opt/pathassist-lymphoma/dist
# Run local: ./deploy/deploy-ui.sh all
```

---

## 10. AWS Cost Optimization

### Current monthly cost target: ~$175/mo

| Resource | Cost | Notes |
|----------|------|-------|
| EC2 m6a.2xlarge RI (1yr no-upfront) | ~$120/mo | Buy Reserved Instance |
| EBS 200GB gp3 | ~$16/mo | Main disk |
| S3 Standard (active slides) | ~$5/mo | algopathp-pathssist-health |
| S3 Glacier IR (archives) | ~$10/mo | tcga-brca, laion-2b, etc |
| S3 Standard IA (backups) | ~$1/mo | pathassist-backups |
| Data transfer | ~$5/mo | Outbound |

### Actions completed
- [x] Deleted old EBS snapshots (saved ~$5/mo)
- [x] Released idle Elastic IP (saved $3.65/mo)
- [x] Reduced ALB to 2 AZs (saved ~$14/mo)
- [x] Deleted WorkSpaces (saved $26/mo)
- [x] Moved tcga-brca, laion-2b, deidentify-bucket, stanford-pathassist-dicom to Glacier IR (saved ~$43/mo)

### Actions pending
- [ ] Buy m6a.2xlarge Reserved Instance (1yr no-upfront: $0.167/hr = ~$120/mo)
- [ ] Convert EBS volumes gp2 → gp3: `vol-01a8ccd543cddef29` (8GB), `vol-001c866dc0fedf88d` (200GB)
- [ ] Move `rfh-pathassist-data` (390GB) to Glacier IR (saves ~$7/mo)
- [ ] Move `stanford-pathassist-images` (312GB) to Glacier IR (saves ~$6/mo)

### Convert gp2 → gp3 (no downtime)
```bash
# Run from local
aws ec2 modify-volume --volume-id vol-001c866dc0fedf88d --volume-type gp3 --region us-east-1
aws ec2 modify-volume --volume-id vol-01a8ccd543cddef29 --volume-type gp3 --region us-east-1
```

---

## 11. Troubleshooting

### Tiles not loading / blurry images
```bash
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23

# Check memcached is working
docker exec ver5-girder-1 python3 -c "
import pymemcache.client.base as m
c = m.Client(('memcached', 11211))
c.set('test', 'ok')
print('memcached:', c.get('test'))
"

# Check memcached stats
echo "stats" | nc memcached 11211 | grep -E "get_hits|curr_items|limit_maxbytes"
# get_hits should increase as slides are viewed

# Check Girder logs for tile errors
docker compose logs girder --tail 100 | grep -i "error\|tile\|cache"
```

### API calls going to wrong URL (external instead of internal)
```bash
# Should return girder version via nginx internal routing
curl -s http://localhost/api/v1/system/version

# Check nginx is routing /api/ to girder internally
docker exec nginx-multi-proxy nginx -t
```

### Container not starting
```bash
cd /opt/digital_slide_archive/devops/ver5
docker compose ps          # check status
docker compose logs <service> --tail 50    # check errors
docker compose up -d <service>             # start specific service
```

### MongoDB connection issues
```bash
# Check MongoDB is running
docker compose ps mongodb

# Test connection from girder container
docker exec ver5-girder-1 python3 -c "
import pymongo
c = pymongo.MongoClient('mongodb://mongodb:27017/')
print('MongoDB:', c.server_info()['version'])
"
```

### UI showing old version after deploy
```bash
# Hard refresh browser: Ctrl+Shift+R
# Or check container is actually running new files:
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 \
  "ls -la /opt/pathassist-lymphoma/dist/"
```

### Check all containers running
```bash
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 \
  "cd /opt/digital_slide_archive/devops/ver5 && docker compose ps"
```

### EC2 disk full
```bash
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 "df -h"

# Find large files
du -sh /opt/digital_slide_archive/devops/ver5/logs/*
du -sh /mnt/dsa-cache/

# Clean Docker unused images/layers
docker system prune -f
```

---

## Files in This Repo (deploy/)

| File | Purpose |
|------|---------|
| `deploy-ui.sh` | **Deploy UI** to EC2 (run from local) |
| `backup-weekly.sh` | Weekly backup script (runs on EC2 via cron) |
| `DISASTER-RECOVERY.md` | Full EC2 rebuild guide |
| `RUNBOOK.md` | This file — all procedures |
| `nginx-multi.conf` | Nginx routing config (copy to EC2 when changed) |
| `dsa5.Dockerfile` | Girder Docker image definition |
| `02-deploy.sh` | Deploy UI to CloudFront S3 bucket (alternative) |

| Script | Purpose |
|--------|---------|
| `scripts/upload_and_import.sh` | Upload OME-TIFF from NAS → S3 → Girder |
