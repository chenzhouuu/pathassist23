# SSH / SCP / Deployment Commands Reference

> **DO NOT COMMIT secrets or passwords. This file is for command patterns only.**
> Keep this file updated as new servers/commands are added.

---

## SSH Keys

| Key File | Server / Purpose |
|---|---|
| `~/.ssh/histamics20.pem` | AWS EC2 — main pathassist server (`54.224.61.23`) |
| `~/.ssh/dcpenn` | DCPenn on-prem server (`192.168.191.109`) |
| `~/.ssh/avmc` | AVMC on-prem (`192.168.8.80`, `192.168.192.10`) |
| `~/.ssh/pramana_box` | Pramana box (`adminspin@10.226.101.30`) |
| `omeroserver.pem` | OMERO EC2 (`ec2-54-225-22-117`) |

---

## AWS EC2 — Pathassist (54.224.61.23)

```bash
# Connect
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23
ssh -i ~/.ssh/histamics20.pem ubuntu@ec2-54-224-61-23.compute-1.amazonaws.com

# Connect (skip host key check — useful for new instances)
ssh -i ~/.ssh/histamics20.pem -o StrictHostKeyChecking=no ubuntu@54.224.61.23

# Docker / Girder
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'docker ps'
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'cd /opt/digital_slide_archive/devops/ver5 && docker compose ps'
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'cd /opt/digital_slide_archive/devops/ver5 && docker compose restart girder'
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'cd /opt/digital_slide_archive/devops/ver5 && docker compose restart girder && sleep 12 && curl -s "http://localhost:8080/api/v1/oauth/keycloak?redirect=http://impart.pathassist.health/"'

# Read config files inside Girder container
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'docker exec ver5-girder-1 cat /opt/girder/plugins/oauth/girder_oauth/settings.py'
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'docker exec ver5-girder-1 cat /opt/girder/plugins/oauth/girder_oauth/providers/__init__.py'
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'docker exec ver5-girder-1 cat /opt/girder/plugins/oauth/girder_oauth/providers/cilogon.py'
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 'docker exec ver5-girder-1 cat /opt/girder/plugins/oauth/girder_oauth/providers/google.py'

# Read deployment configs
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 "cat /opt/digital_slide_archive/devops/ver5/provision.yaml"
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 "cat /opt/girder/plugins/oauth/girder_oauth/providers/cilogon.py"
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 "cat /opt/girder/plugins/oauth/girder_oauth/providers/google.py && echo '===' && cat /opt/girder/plugins/oauth/girder_oauth/providers/base.py | head -80"

# Docker images
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 "docker images dsarchive/dsa_common_5 --format '{{.Repository}}:{{.Tag}} — {{.Size}}'"

# Find files
ssh -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23 "find / -name 'start_girder.sh' -o -name 'girder.cfg' 2>/dev/null | grep -v proc | head -10"

# Download files from EC2
scp -i ~/.ssh/histamics20.pem ubuntu@54.224.61.23:/tmp/macro.jpg ~/Downloads/macro.jpg

# Upload docker-compose to EC2
scp -i histamics20.pem ~/Downloads/docker-compose.yml ubuntu@ec2-54-224-61-23.compute-1.amazonaws.com:/opt/digital_slide_archive/devops/ver5/

# Upload UI component to EC2
scp -i ../../Downloads/histamics20.pem src/components/annotations/NucleiDetectionModal.jsx ec2-user@54.224.61.23:/opt/pathassist23/src/components/annotations/NucleiDetectionModal.jsx
```

---

## AWS EC2 — Other Instances

```bash
# Older/alternate EC2 instances
ssh -i "histamics20.pem" ubuntu@ec2-18-234-118-165.compute-1.amazonaws.com
ssh -i ~/.ssh/histamics20.pem ubuntu@ec2-100-53-46-208.compute-1.amazonaws.com

# OMERO server
ssh -i "omeroserver.pem" admin@ec2-54-225-22-117.compute-1.amazonaws.com

# Other user
ssh -p 20022 chen@54.85.79.107
```

---

## DCPenn On-Prem (192.168.191.109)

```bash
# Connect
ssh -i ~/.ssh/dcpenn path01@192.168.191.109

# DSA setup
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "ls ~/dsa/"
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "mkdir -p ~/dsa/{assetstore,db,logs}"
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "cat ~/dsa/.env"
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "tail -20 ~/dsa/build.log"
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "ls ~/lymphoma-app/"

# Set DSA env vars
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 'UID_GID=$(id -u):$(id -g); echo "DSA_USER=$UID_GID" > ~/dsa/.env; echo "DSA_PORT=9080" >> ~/dsa/.env; cat ~/dsa/.env'

# Docker compose
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "cd ~/dsa && docker compose pull 2>&1 | tail -15"
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "cd ~/dsa && sudo -i -u path01 docker compose pull --quiet 2>&1 | tail -10"
ssh -i ~/.ssh/dcpenn path01@192.168.191.109 "ls ~/dsa/ && which docker-compose 2>/dev/null; docker compose version 2>/dev/null"

# Upload deploy files to DCPenn
scp -i ~/.ssh/dcpenn \
  /mnt/c/Users/tkantheti/github/Histomics-UI/deploy/docker-compose.yml \
  /mnt/c/Users/tkantheti/github/Histomics-UI/deploy/provision.yaml \
  /mnt/c/Users/tkantheti/github/Histomics-UI/deploy/nginx-multi.conf \
  path01@192.168.191.109:~/dsa/
```

---

## AVMC On-Prem (192.168.8.80 / 192.168.192.x)

```bash
ssh -i ~/.ssh/avmc path02@192.168.8.80
ssh -i ~/.ssh/avmc path02@192.168.192.10
ssh path02@192.168.192.106
ssh avmc@192.168.8.80
ssh algopath@192.168.8.80
```

---

## Pramana Box (10.226.101.30)

```bash
ssh -i ~/.ssh/pramana_box adminspin@10.226.101.30
ssh adminspin@10.226.101.30
```

---

## SSH Aliases (from ~/.ssh/config)

```bash
ssh dcpenn          # path01@192.168.191.109
ssh avmc-path       # avmc/path02 on AVMC
ssh avmc-pathassist
ssh aws-pathassist  # ubuntu@54.224.61.23
ssh pramana
```

---

## Girder API (curl)

```bash
# Authenticate
curl -s -u admin:password "https://gd.pathassist.health/api/v1/user/authentication" | jq

# Get current user
curl -s -H "Girder-Token: $GIRDER_TOKEN" "https://gd.pathassist.health/api/v1/user/me" | jq

# Create API key for PathAssistModel
curl -s -X POST \
  -H "Girder-Token: $GIRDER_TOKEN" \
  "https://gd.pathassist.health/api/v1/api_key?userId=$GIRDER_USER_ID&name=PathAssistModel&active=true" | jq

# Keycloak OAuth redirect test
curl -s "http://localhost:8080/api/v1/oauth/keycloak?redirect=http://impart.pathassist.health/"
```

---

## Key Setup Commands (one-time)

```bash
# Generate keys
ssh-keygen -t ed25519 -f ~/.ssh/dcpenn -C "dcpenn-ec2"
ssh-keygen -t ed25519 -f ~/.ssh/pramana_box -C "pramana_box_access"
ssh-keygen -t rsa -b 4096 -f ~/.ssh/avmc

# Copy public keys to servers
ssh-copy-id -i ~/.ssh/dcpenn.pub path01@192.168.191.109
ssh-copy-id -i ~/.ssh/avmc.pub path02@192.168.8.80
ssh-copy-id -i ~/.ssh/avmc.pub path02@192.168.192.10
ssh-copy-id -i ~/.ssh/pramana_box.pub adminspin@10.226.101.30
```
