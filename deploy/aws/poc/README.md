# PathAssist AWS POC — Spot Instance

Isolated spot EC2 instance for demos/POC — **does not touch production**.
Uses existing ALB with new `poc.*` subdomains.

**Cost:** ~$0.04/hr running (~$1.20/month stopped, EBS only)

---

## Folder Structure

```
deploy/aws/poc/
├── aws-poc-setup.sh       Run ONCE — creates spot EC2, EBS, ALB rules
├── poc-start.sh           Run BEFORE demo — starts instance + containers
├── poc-stop.sh            Run AFTER demo — stops instance (saves cost)
├── docker-compose.poc.yml Reduced-resource stack (m5.xlarge)
├── nginx-poc.conf         Routes poc.* subdomains
└── .poc-state             Auto-generated — stores instance ID, EBS, IP
```

---

## First-Time Setup

### Option A — Fresh (empty data, quick ~10 min)
```bash
chmod +x deploy/aws/poc/*.sh
./deploy/aws/poc/aws-poc-setup.sh
```

### Option B — Clone from production (~20 min, includes all slides + users)
```bash
./deploy/aws/poc/aws-poc-setup.sh --from-prod
```
This snapshots the production EBS (read-only, zero impact on prod) and creates
a new EBS from it for the spot instance.

---

## DNS — Add CNAMEs in GoDaddy

After setup, add these CNAMEs to `pathassist.health`:

| Name | Points To |
|------|-----------|
| `poc.impart` | `dsa-998249893.us-east-1.elb.amazonaws.com` |
| `poc.mda` | `dsa-998249893.us-east-1.elb.amazonaws.com` |
| `poc.algopath` | `dsa-998249893.us-east-1.elb.amazonaws.com` |
| `poc.auth` | `dsa-998249893.us-east-1.elb.amazonaws.com` |
| `poc.girder` | `dsa-998249893.us-east-1.elb.amazonaws.com` |

> Note: The ACM certificate must cover `*.pathassist.health` wildcard OR have
> SANs for each poc.* subdomain. Check in AWS Certificate Manager and add
> domains if needed.

---

## Daily Demo Workflow

### Before the demo
```bash
./deploy/aws/poc/poc-start.sh
```
- Starts stopped spot instance
- Re-registers with ALB target group
- Starts Docker containers
- Waits for Girder to be healthy
- Prints URLs when ready (~2 min)

### After the demo
```bash
./deploy/aws/poc/poc-stop.sh
```
- Gracefully stops Docker containers
- Stops EC2 instance
- EBS data preserved — cost drops to ~$1.20/month

---

## URLs

| App | URL |
|-----|-----|
| Impart DX | https://poc.impart.pathassist.health/ |
| MDA | https://poc.mda.pathassist.health/ |
| Algopath | https://poc.algopath.pathassist.health/ |
| Keycloak | https://poc.auth.pathassist.health/ |
| Girder Admin | https://poc.girder.pathassist.health/ |

Default credentials: `admin` / `password` (same as production provision.yaml)

---

## Infrastructure Details

| Resource | Value |
|----------|-------|
| Instance type | m5.xlarge (4 vCPU / 16GB) |
| Spot max price | $0.08/hr (on-demand: $0.192/hr) |
| Root EBS | 60GB gp3 (OS + Docker + UI builds) |
| Data EBS | 100GB gp3 fresh / 210GB from prod snapshot |
| Region / AZ | us-east-1 / us-east-1d |
| Security Group | sg-04161e9cbc358700c (same as prod) |
| ALB | dsa-998249893.us-east-1.elb.amazonaws.com |
| Target Group | pathassist-poc-nginx-80 (new, separate from prod) |

---

## Spot Instance Risk

Spot instances can be reclaimed by AWS with 2-minute warning.
- **Data is safe** — EBS data volume persists even if instance is terminated
- **Recovery**: `./poc-start.sh` restores everything in ~2 min
- If instance is terminated (not just stopped), AWS recreates it automatically
  (persistent spot request)

For zero-interruption demos, change instance type before demo:
```bash
# Switch to on-demand temporarily
aws ec2 modify-instance-attribute \
  --instance-id $(grep POC_INSTANCE_ID .poc-state | cut -d= -f2) \
  --no-ebs-optimized  # then stop/start with normal launch
```

---

## Tear Down

Delete all POC resources when done:

```bash
source deploy/aws/poc/.poc-state

# Terminate instance
aws ec2 terminate-instances --instance-ids $POC_INSTANCE_ID

# Delete data EBS (CAREFUL — deletes all POC data)
aws ec2 wait instance-terminated --instance-ids $POC_INSTANCE_ID
aws ec2 delete-volume --volume-id $POC_DATA_VOL_ID

# Remove ALB target group and rules
aws elbv2 describe-rules \
  --listener-arn arn:aws:elasticloadbalancing:us-east-1:039205283883:listener/app/dsa/84314737a7703d71/f43fa4c032b77088 \
  --query "Rules[?!IsDefault && Actions[0].TargetGroupArn=='$POC_TG_ARN'].RuleArn" \
  --output text | xargs -n1 aws elbv2 delete-rule --rule-arn

aws elbv2 delete-target-group --target-group-arn $POC_TG_ARN
```
