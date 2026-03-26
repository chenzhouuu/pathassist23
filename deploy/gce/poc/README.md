# PathAssist POC — Google Cloud Setup

Single-brand (Algopath) deployment on a GCE spot VM.
Cost: ~$18/month when used only for demos.

---

## Files in This Folder

| File | What it does |
|------|-------------|
| `gcp-poc-setup.sh` | **Run once** — creates GCP VM, installs Docker, deploys app |
| `poc-start.sh` | **Run before demo** — starts VM + Docker containers |
| `poc-stop.sh` | **Run after demo** — stops VM to save cost |
| `docker-compose.poc.yml` | Lightweight docker-compose (4 CPU / 16GB, single brand) |
| `nginx-poc.conf` | Nginx routing — `/api/*` → Girder, `/*` → UI |

---

## Prerequisites (one-time)

### 1. Install gcloud CLI
```bash
# Windows WSL
curl -O https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz
tar -xf google-cloud-cli-linux-x86_64.tar.gz
./google-cloud-sdk/install.sh
source ~/.bashrc
```

### 2. Login and create project
```bash
gcloud auth login

# Create project (do once)
gcloud projects create pathassist-poc-2026 --name="PathAssist POC"
gcloud config set project pathassist-poc-2026

# Enable billing
# → Go to: console.cloud.google.com/billing
# → Link a billing account to pathassist-poc-2026
```

---

## First-Time Setup

Run once to create everything:

```bash
chmod +x deploy/gce/poc/gcp-poc-setup.sh
./deploy/gce/poc/gcp-poc-setup.sh
```

This will:
1. Reserve a static IP address
2. Open firewall ports (80, 22)
3. Create a spot VM (`e2-standard-4` — 4 vCPU / 16GB)
4. Install Docker on the VM
5. Upload `docker-compose.poc.yml` + `nginx-poc.conf`
6. Clone the repo and build the Algopath UI
7. Start all Docker containers

Takes about **10 minutes** total.

At the end you will see:
```
========================================
  POC IS READY
========================================

  PathAssist:   http://<IP>/
  Girder API:   http://<IP>/api/v1/
  Keycloak:     http://<IP>:8081/
```

---

## Daily Demo Workflow

### Before the demo
```bash
./deploy/gce/poc/poc-start.sh
```
- Starts the stopped VM
- Starts Docker containers
- Waits until Girder is healthy (~2 min)
- Prints the URL when ready

### After the demo
```bash
./deploy/gce/poc/poc-stop.sh
```
- Stops the VM
- Cost drops to ~$10/month (disk only)

---

## Upload Slides to the POC

After setup, upload slides via Girder:

```bash
# Get the IP
POC_IP=$(gcloud compute addresses describe pathassist-poc-ip \
  --region=us-east1 --format='value(address)')

# Open Girder admin
open http://$POC_IP/api/v1/
# Login: admin / admin
# Upload slides via Collections → your folder
```

Or copy from EC2 assetstore directly:
```bash
# From EC2 to GCE (large files — run from inside GCE VM)
gcloud compute ssh pathassist-poc --zone=us-east1-b -- "
  scp -r ubuntu@54.224.61.23:/opt/digital_slide_archive/devops/ver5/assetstore/ \
    /opt/digital_slide_archive/devops/ver5/assetstore/
"
```

---

## Deploy a New UI Build to POC

After code changes, redeploy only the UI:

```bash
POC_IP=$(gcloud compute addresses describe pathassist-poc-ip \
  --region=us-east1 --format='value(address)')

# Build locally
VITE_APP_NAME='Algopath' \
VITE_LOGO_SRC='/alogopath-logo.png' \
VITE_APP_TAGLINE='Digital Pathology POC' \
npm run build

# Copy dist to GCE
gcloud compute scp dist/ \
  pathassist-poc:/opt/pathassist-poc/dist \
  --zone=us-east1-b \
  --recurse

# The container auto-serves the updated dist (no restart needed)
```

---

## Tear Down (Delete Everything)

When the POC is complete, delete all GCP resources:

```bash
gcloud compute instances delete pathassist-poc --zone=us-east1-b
gcloud compute disks delete pathassist-poc --zone=us-east1-b 2>/dev/null || true
gcloud compute addresses delete pathassist-poc-ip --region=us-east1
gcloud compute firewall-rules delete pathassist-poc-http pathassist-poc-ssh
```

---

## Troubleshooting

### VM was stopped by Google (spot reclaim)
```bash
./deploy/gce/poc/poc-start.sh   # just restart it
```

### Containers not starting
```bash
gcloud compute ssh pathassist-poc --zone=us-east1-b -- "
  cd /opt/digital_slide_archive/devops/ver5
  docker compose logs --tail=50
"
```

### Girder taking too long to start
```bash
# Girder takes 1-3 min on first boot (runs provisioning)
# Check logs:
gcloud compute ssh pathassist-poc --zone=us-east1-b -- "
  cd /opt/digital_slide_archive/devops/ver5
  docker compose logs -f girder
"
```

### SSH into VM
```bash
gcloud compute ssh pathassist-poc --zone=us-east1-b
```
