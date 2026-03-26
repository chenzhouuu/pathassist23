# GCE Deployment

Google Compute Engine deployment files for PathAssist.

## Folder Structure

```
deploy/gce/
├── README.md          ← you are here
└── poc/               ← POC (Proof of Concept) — single brand, spot VM, cheap
    ├── gcp-poc-setup.sh       Run ONCE to create VM + deploy everything
    ├── poc-start.sh           Run before every demo
    ├── poc-stop.sh            Run after every demo
    ├── docker-compose.poc.yml Lightweight docker-compose (1 brand, less RAM)
    └── nginx-poc.conf         Simple nginx config (single brand routing)
```

## Environments

| Folder | Purpose | Cost | When to use |
|--------|---------|------|-------------|
| `poc/` | Demo / Proof of Concept | ~$18/month | Showing to stakeholders |
| `prod/` *(future)* | Production | ~$230/month | Live hospital deployment |

## Quick Start — POC

```bash
# 1. One-time setup (creates VM, deploys app)
./deploy/gce/poc/gcp-poc-setup.sh

# 2. Before every demo — start the VM
./deploy/gce/poc/poc-start.sh

# 3. After every demo — stop the VM (save cost)
./deploy/gce/poc/poc-stop.sh
```

## Cost

| State | Cost/month |
|-------|-----------|
| VM running 24/7 (spot) | ~$46 |
| VM stopped (disk only) | ~$10 |
| Demo 5 days × 3 hrs (spot) | ~$18 |
