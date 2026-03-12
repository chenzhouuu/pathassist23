# PathAssist Disaster Recovery Guide

## What lives where — and why it matters

```
EC2 (Histamics2.0)  ← can die, MUST backup
├── MongoDB data     /opt/digital_slide_archive/devops/ver5/db/   ← 409MB, CRITICAL
├── Config files     /opt/digital_slide_archive/devops/ver5/       ← docker-compose, girder.cfg, etc
├── Assetstore index /opt/digital_slide_archive/devops/ver5/assetstore/  ← small symlinks to S3
└── UI builds        /opt/pathassist-mda, algopath, lymphoma/dist/ ← rebuildable from git

S3  ← never dies (AWS manages)
├── algopathp-pathssist-health/  ← ALL slide images (OME-TIFF, GBs of data)  SAFE
└── pathassist-backups/          ← weekly MongoDB + config backups            SAFE

Git (GitHub)  ← never dies
└── Histomics-UI repo            ← dsa5.Dockerfile, nginx config, scripts    SAFE
```

**Bottom line:** If EC2 dies, you only lose MongoDB (users, folders, permissions, annotations)
and config files. The slide images on S3 are always safe.

---

## Weekly Backup (run every Sunday)

```bash
# On EC2:
/opt/digital_slide_archive/deploy/backup-weekly.sh

# Or set up cron (run once):
echo "0 2 * * 0 /opt/digital_slide_archive/deploy/backup-weekly.sh >> /var/log/pathassist-backup.log 2>&1" | crontab -
```

**What gets backed up:**

| Item | Where | Size | Notes |
|------|-------|------|-------|
| MongoDB (girder DB) | S3 pathassist-backups/mongodb/ | ~400MB | Users, folders, permissions, annotations |
| docker-compose.yml | S3 pathassist-backups/configs/ | tiny | Service config |
| girder.cfg | S3 pathassist-backups/configs/ | tiny | Girder settings |
| nginx-multi.conf | S3 pathassist-backups/configs/ | tiny | Routing config |
| dsa5.Dockerfile | S3 pathassist-backups/configs/ | tiny | Also in git |
| EBS Snapshot | AWS Snapshots | ~200GB | Full disk, kept 4 weeks |

**What does NOT need backup (already safe):**

| Item | Why safe |
|------|----------|
| Slide images (OME-TIFF) | Already on S3 `algopathp-pathssist-health` |
| Docker images | Rebuilt from `dsa5.Dockerfile` (in git) |
| UI code | Rebuilt from git branch `keycloak-integration` |
| memcached tile cache | Ephemeral — auto-rebuilds as slides are viewed |

---

## Restore from Scratch (EC2 is dead)

### Step 1 — Launch new EC2

```bash
# Launch m6a.2xlarge, us-east-1, Ubuntu 22.04
# Attach 200GB gp3 root volume
# Security group: allow SSH (22), HTTP (80) from 0.0.0.0/0
# Key pair: histamics20
```

### Step 2 — Install Docker

```bash
ssh -i ~/.ssh/histamics20.pem ubuntu@<NEW_IP>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
newgrp docker
sudo apt-get install -y docker-compose-plugin
```

### Step 3 — Clone repo and restore configs

```bash
# Clone the codebase
git clone https://github.com/<your-org>/Histomics-UI.git /opt/Histomics-UI
cd /opt/Histomics-UI
git checkout keycloak-integration

# Copy configs to DSA directory
mkdir -p /opt/digital_slide_archive/devops/ver5
cd /opt/digital_slide_archive/devops/ver5

# Download latest backup from S3
WEEK=$(date -u +%Y-W%V)
aws s3 cp s3://pathassist-backups/configs/${WEEK}/ . --recursive
# Or list available backups:
# aws s3 ls s3://pathassist-backups/configs/
tar -xzf configs_*.tar.gz
rm configs_*.tar.gz
```

### Step 4 — Restore MongoDB

```bash
# Download latest MongoDB backup
aws s3 cp s3://pathassist-backups/mongodb/${WEEK}/ /tmp/ --recursive
cd /tmp
tar -xzf mongodb_girder_*.tar.gz

# Start MongoDB first
docker compose up -d mongodb
sleep 10

# Restore
docker cp dump ver5-mongodb-1:/tmp/mongodump_restore
docker exec ver5-mongodb-1 mongorestore --db girder /tmp/mongodump_restore/girder --drop
docker exec ver5-mongodb-1 rm -rf /tmp/mongodump_restore
rm -rf /tmp/dump /tmp/mongodb_girder_*.tar.gz
```

### Step 5 — Rebuild Docker image and start all services

```bash
cd /opt/digital_slide_archive/devops/ver5

# Set DSA_USER
export DSA_USER=$(id -u):$(id -g)
echo "DSA_USER=${DSA_USER}" > .env

# Build the Girder image (takes 20-30 min)
docker compose build girder

# Start everything
docker compose up -d

# Check status
docker compose ps
curl -s http://localhost/api/v1/system/version | python3 -m json.tool
```

### Step 6 — Rebuild UI builds

```bash
cd /mnt/c/Users/tkantheti/github/Histomics-UI   # or wherever checked out
git checkout keycloak-integration

# Build each brand
VITE_APP_NAME="Impart DX" VITE_LOGO_SRC="/impart-dx-logo.png" \
  VITE_APP_TAGLINE="Digital Pathology Platform" npm run build
rsync -av dist/ ubuntu@<NEW_IP>:/opt/pathassist-lymphoma/dist/

# Repeat for mda, algopath brands
```

### Step 7 — Verify everything works

```bash
# Check all containers running
docker compose ps

# Check API
curl http://localhost/api/v1/system/version

# Check memcached connection
docker exec ver5-girder-1 python3 -c "
import pymemcache.client.base as m
c = m.Client(('memcached', 11211))
c.set('test', 'ok')
print('memcached:', c.get('test'))
"

# Open a slide in the browser and verify tiles load
```

---

## Alternative: Restore from EBS Snapshot (faster)

If you have a recent EBS snapshot, you can skip steps 3-6:

```bash
# 1. Create volume from snapshot
aws ec2 create-volume \
    --snapshot-id snap-XXXXXXXXXX \
    --availability-zone us-east-1a \
    --volume-type gp3 \
    --size 200

# 2. Attach to new EC2 as /dev/sda1 (root) before launch
#    OR attach as /dev/sdf and mount to /opt on running instance

# 3. If attaching as extra volume:
sudo mount /dev/xvdf /mnt/restore
sudo rsync -av /mnt/restore/opt/digital_slide_archive/ /opt/digital_slide_archive/
sudo umount /mnt/restore
```

---

## First-time: Create backup S3 bucket

```bash
aws s3 mb s3://pathassist-backups --region us-east-1

# Enable versioning for extra safety
aws s3api put-bucket-versioning \
    --bucket pathassist-backups \
    --versioning-configuration Status=Enabled

# Set lifecycle: delete objects older than 60 days
aws s3api put-bucket-lifecycle-configuration \
    --bucket pathassist-backups \
    --lifecycle-configuration '{
        "Rules": [{
            "ID": "delete-old-backups",
            "Status": "Enabled",
            "Filter": {"Prefix": ""},
            "Expiration": {"Days": 60}
        }]
    }'

echo "Backup bucket ready: s3://pathassist-backups"
```

---

## Changes made to EC2 (not in original DSA repo)

These are tracked in git branch `keycloak-integration`:

| File | Change | Why |
|------|--------|-----|
| `deploy/dsa5.Dockerfile` | Added `RUN pip install pymemcache` | memcached tile cache |
| `deploy/nginx-multi.conf` | Added `upstream girder_upstream` + `/api/` location blocks | API stays inside Docker network |
| `deploy/docker-compose.yml` | `memcached: -m 4096 --max-item-size 8M` | Larger tile cache |
| `src/config/girder.js` | `VITE_GIRDER_BASE || '/api/v1'` | Relative URL uses nginx |
| `scripts/upload_and_import.sh` | New script | Upload OME-TIFF from NAS → S3 → Girder |

MongoDB settings changed (stored in DB, not files):
```
large_image.cache_backend = memcached
large_image.cache_memcached_url = memcached:11211
large_image.cache_tilesource_maximum = 100
```
These are restored automatically when you restore MongoDB from backup.
