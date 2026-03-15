# PathAssist — Production Spot Migration

Replace on-demand EC2 with a spot instance. **Same data, same subdomains, same ALB.**
No DNS changes. No config changes. ~75% cost savings.

**Current cost:** ~$0.34/hr on-demand (c6i.2xlarge)
**Spot cost:**    ~$0.07/hr spot — saves ~$196/month

---

## Files

```
deploy/aws/spot/
├── migrate-to-spot.sh     Run ONCE — full migration with cutover
├── rollback.sh            Emergency rollback to old instance
├── spot-start.sh          Start after stop/preemption
├── spot-stop.sh           Planned maintenance stop
├── docker-compose.spot.yml  Exact copy of production compose
└── .spot-state            Auto-generated — stores all IDs
```

---

## Migration Steps

### 1. Run migration
```bash
chmod +x deploy/aws/spot/*.sh
./deploy/aws/spot/migrate-to-spot.sh
```

The script has two confirmation prompts:
- **First:** before starting (review what will happen)
- **Second:** before ALB cutover (last chance to abort)

Between the two prompts, the spot instance is running and healthy but NOT serving traffic. Production is still on the old instance.

### 2. Add GoDaddy CNAMEs (if not already done)
No changes needed — the spot instance uses the **same ALB target group** as production. All existing subdomains continue to work automatically.

---

## What the Migration Does

| Step | Action | Downtime |
|------|--------|----------|
| 1 | Snapshot prod EBS (live) | None |
| 2 | Launch spot EC2 | None |
| 3 | Create 210GB EBS from snapshot, attach | None |
| 4 | Mount data, build UI, start services | None |
| 5 | Health check new instance | None |
| 6 | Register spot with ALB | None |
| 7 | Deregister old prod from ALB | ~5-30 seconds |
| 8 | Stop old instance | None |

---

## Rollback

If anything goes wrong — run at any point:
```bash
./deploy/aws/spot/rollback.sh
```
This starts the old instance and swaps it back into the ALB in ~2 minutes.
Old instance is kept **stopped** (not terminated) for 7 days after migration.

---

## After Migration — Daily Operations

### If spot is preempted by AWS
AWS will stop the instance. You'll get a 2-minute warning via CloudWatch.
Recovery:
```bash
./deploy/aws/spot/spot-start.sh
```
Takes ~3 minutes to restore full service.

### Planned maintenance stop
```bash
./deploy/aws/spot/spot-stop.sh   # stops production — use with care
./deploy/aws/spot/spot-start.sh  # restores
```

### Deploy new UI code
Same as before — no changes to deploy workflow:
```bash
./deploy/deploy-ui.sh all
```

---

## Infrastructure

| Resource | Value |
|----------|-------|
| Instance type | c6i.2xlarge (8 vCPU / 16GB — same as prod) |
| Spot max price | $0.15/hr (on-demand: $0.34/hr) |
| Root EBS | 60GB gp3 (OS + Docker + UI) |
| Data EBS | 210GB gp3 (from prod snapshot — all slides + DB) |
| ALB target group | pathassist-nginx-80 (existing — unchanged) |
| Subdomains | All unchanged — no DNS edits |
| Spot type | Persistent (AWS restarts when capacity available) |
| Interruption | stop (data EBS preserved — NOT terminate) |

---

## Spot Interruption Handling

Configured as **persistent spot with stop behavior**:
- AWS sends 2-min warning before stopping
- Instance stops (EBS data preserved)
- Spot request stays active — AWS restarts when capacity available
- OR manually restart: `./spot-start.sh`

**To get CloudWatch alerts for interruption warnings:**
```bash
aws events put-rule \
  --name SpotInterruptionWarning \
  --event-pattern '{"source":["aws.ec2"],"detail-type":["EC2 Spot Instance Interruption Warning"]}' \
  --state ENABLED

# Add SNS notification target to the rule for email alerts
```

---

## Terminate Old Instance (after 7 days)

Once confident spot is stable:
```bash
source deploy/aws/spot/.spot-state
aws ec2 terminate-instances --instance-ids $PROD_INSTANCE_ID
aws ec2 delete-snapshot --snapshot-id $SNAPSHOT_ID
```
