# DSA / Girder Stack — Upgrade Analysis & Plan

**Generated:** 2026-03-18
**Environment:** `impart.pathassist.health` (EC2, Docker Compose)
**Dockerfile:** `/opt/digital_slide_archive/dsa5.Dockerfile`

---

## 1. Currently Installed Versions

| Component | Branch / Source | Installed Version | Status |
|-----------|----------------|-------------------|--------|
| Base image | `girder/tox-and-node:latest` | Ubuntu 24.04, Python 3.11.11 | ⚠️ Unpinned `:latest` |
| **Girder** | `v4-integration` (girder/girder) | `5.0.0a6.dev6` | 🔴 256 commits behind |
| **large_image** | `girder-5` (girder/large_image) | `1.32.0a4.dev139` | 🔴 164 commits behind |
| **girder_large_image_annotation** | same repo as large_image | same version | 🔴 same |
| **HistomicsUI** | `girder-5` (DigitalSlideArchive/HistomicsUI) | `1.7.1.dev95` | 🟡 138 commits behind |
| **girder_assetstore** | `girder-5` (DigitalSlideArchive/girder_assetstore) | latest on branch | ✅ Current on branch |
| **slicer_cli_web** | bundled in girder monorepo | `0.0.0` | — |
| **gunicorn** | pip install (unpinned) | `23.0.0` | 🟡 Latest is 25.1.0 |
| **celery** | transitive dep | `5.4.0` | 🟡 Latest is 5.6.2 |
| **tini** | `v0.19.0` (pinned) | `v0.19.0` | ✅ Up to date |
| **Node.js** | `nvm install 22` | `v22.14.0` | ✅ LTS current |

---

## 2. Branch Naming Note

> The main `girder/girder` repository does **not** use a `girder-5` branch.
> It uses **`v4-integration`** for Girder 5 development (confusingly named).
> The `girder-5` branch name exists only on downstream repos:
> - `girder/large_image`
> - `DigitalSlideArchive/HistomicsUI`
> - `DigitalSlideArchive/girder_assetstore`
>
> These `girder-5` branches contain Girder-5-API patches and are **incompatible** with the stable
> PyPI releases of large_image/HistomicsUI (which target Girder 3.x).

---

## 3. Critical Bugs Fixed in Newer Versions

### 3.1 Girder — `5.0.0a6.dev6` → `v5.0.0a14` (256 commits behind)

| Severity | Bug | PR | Clinical Impact |
|----------|-----|----|-----------------|
| 🔴 CRITICAL | MongoDB 16MB job-log overflow | #3752 | Jobs permanently stuck — cannot be cleared or restarted |
| 🔴 CRITICAL | New Celery local queue worker required | #3647 / #3652 | Async operations (imports, analysis) silently fail |
| 🟡 HIGH | Non-root deployment serving broken | #3712 / #3721 | Static assets may 404 in certain container configs |
| 🟡 HIGH | `uvicorn reload=True` in prod mode | #3761 | NFS/EFS performance degradation on AWS (our setup) |
| 🟡 MEDIUM | Admin user role escalation edge case | #3689 | Permission bypass in specific workflow |
| 🟢 LOW | Various Keycloak OIDC token refresh fixes | multiple | Token expiry edge cases |

### 3.2 large_image — `1.32.0a4.dev139` → `v1.34.0` (164 commits behind)

| Severity | Bug | PR | Clinical Impact |
|----------|-----|----|-----------------|
| 🔴 CRITICAL | Annotation permission cache user-isolation bug | #1999 | **Users see wrong edit rights on other users' annotations** |
| 🔴 CRITICAL | Small-region tile read returns wrong pixel data | #2049 | **Silent corruption in ROI crops / Ki67 analysis** |
| 🔴 CRITICAL | Annotation copy permission bug | #2033 | Copied annotations inherit wrong user permissions |
| 🔴 CRITICAL | Folder tiles endpoint recursion crash | #1993 | Server crash on deep folder structures |
| 🟡 HIGH | Missing MongoDB index on annotation queries | #2005 | Slow queries on large annotation sets / slide opens slow |
| 🟡 HIGH | ICC colour profile enabled by default in ≥1.32 | config | Visual colour shift in rendered slides |
| 🟡 MEDIUM | Tile streaming memory leak on long sessions | #2011 | Container memory growth over time |
| 🟢 LOW | DICOM WSI metadata parsing improvements | #2041 | Better DICOM slide compatibility |

### 3.3 HistomicsUI — `1.7.1.dev95` → `v1.8.0` (138 commits behind)

| Severity | Bug | PR | Clinical Impact |
|----------|-----|----|-----------------|
| 🟡 HIGH | Annotation model listener rebinding bug | #514 | Stale listeners cause ghost/duplicate annotations on screen |
| 🟡 HIGH | Unnecessary annotation refresh for ALL items | #506 | Performance degradation on large collections |
| 🟡 MEDIUM | Line-cut tool non-functional | #519 | Annotation editing tool broken |
| 🟢 LOW | Keyboard shortcut conflicts in viewer | #522 | Minor UX annoyance |

---

## 4. Risk Assessment

| Risk | Detail |
|------|--------|
| No stable Girder 5 release exists | Entire stack is alpha — no "safe stable target", only newer pre-release snapshots |
| large_image / HistomicsUI stable PyPI releases target Girder 3.x | Cannot `pip install` from PyPI — must use `girder-5` branches |
| Base image `:latest` unpinned | Future rebuild could silently pull different Ubuntu/Python |
| No commit pins in Dockerfile | Every rebuild pulls current branch tip — non-reproducible |
| ICC colour profile change in large_image ≥1.32 | Enabled sRGB adjustment by default — visual shift in slides |

---

## 5. Phased Upgrade Plan

### Pre-requisites (do before anything)

```bash
# 1. Snapshot EC2 instance (AWS Console → EC2 → Actions → Create Image)
# 2. Save current container state
docker commit ver5-girder-1 dsa-backup-$(date +%Y%m%d)

# 3. Record current commit hashes for rollback
docker exec ver5-girder-1 bash -c "
  python -c '
import girder; print(\"girder:\", girder.__version__)
import large_image; print(\"large_image:\", large_image.__version__)
import histomicsui; print(\"histomicsui:\", histomicsui.__version__)
  '
  git -C /girder       rev-parse HEAD
  git -C /large_image  rev-parse HEAD
  git -C /HistomicsUI  rev-parse HEAD
"
```

---

### Phase 1 — Low Risk: Pin base image + upgrade gunicorn

**Files:** `dsa5.Dockerfile`
**Risk:** Low — no Girder/DSA API changes. Gunicorn 23→25 is backward-compatible.
**Downtime:** ~5 min (container restart only)

```dockerfile
# Pin base image (get digest with: docker inspect girder/tox-and-node:latest --format '{{.Id}}')
FROM girder/tox-and-node@sha256:<current-digest>

# Pin gunicorn
RUN pip install --no-cache-dir gunicorn==25.1.0
```

**Test after:** `curl https://impart.pathassist.health/api/v1/system/version` → returns JSON

---

### Phase 2 — Medium Risk: Update Girder to v5.0.0a14

**Files:** `dsa5.Dockerfile`
**Risk:** Medium — Girder internal API changes between a6 and a14.
**Downtime:** ~15 min (rebuild + restart)

```dockerfile
# Before:
RUN git clone -b v4-integration https://github.com/girder/girder

# After (pin to latest alpha tag, shallow clone for speed):
RUN git clone --depth 1 --branch v5.0.0a14 https://github.com/girder/girder
```

**Also required — add Celery local queue worker** (new in a14, fixes silent async failures):
```yaml
# docker-compose.yml — add new service alongside existing celery worker
  celery-local:
    image: dsa:latest
    command: celery -A girder.plugins.jobs.celery_app worker -Q local --loglevel=info
```

**Test sequence:**
1. Build test image: `docker build -f dsa5.Dockerfile -t dsa-test:phase2 .`
2. Start on different port: `docker run -d --name dsa-test -p 8090:8080 dsa-test:phase2`
3. Verify: admin login, collection browse, tile viewing, SSO callback
4. If healthy → update docker-compose.yml image tag → `docker compose up -d girder`

---

### Phase 3 — High Risk: Update large_image + HistomicsUI

**Files:** `dsa5.Dockerfile`, `devops/ver5/girder.cfg`
**Risk:** High — girder-5 branch diverges from master; may conflict with Phase 2 Girder.
**Downtime:** ~20 min (rebuild + functional test)

```dockerfile
# Add --depth 1 for faster clones; optionally pin to a known-good commit hash
RUN git clone --depth 1 --branch girder-5 https://github.com/girder/large_image
RUN git clone --depth 1 --branch girder-5 https://github.com/DigitalSlideArchive/HistomicsUI
```

**ICC colour profile warning** — add to `girder.cfg` before upgrading to preserve slide fidelity:
```ini
[large_image]
icc_correction = false
```

**Clinical test sequence (do not skip):**
1. Open known slides → visually compare colour rendering against current
2. Test Ki67 analysis end-to-end: draw ROI → check result is not corrupted
3. Test annotation save/load on same slide as two different users
4. Test import from S3 prefix → verify files appear
5. Test tile creation for a fresh `.svs` upload
6. Check `docker stats` — memory should be < 2GB at idle after 30 min

---

### Phase 4 — Future: Wait for Girder 5.0.0 stable

Once `girder/girder` tags a stable `v5.0.0`:
```dockerfile
# Replace all git clone blocks with simple pip installs (reproducible + pinnable)
RUN pip install girder==5.0.0 large-image[memcached] histomicsui slicer-cli-web
```

Monitor: https://github.com/girder/girder/releases

---

## 6. Upgrade Priority Summary

| Priority | Component | Action | Phase |
|----------|-----------|--------|-------|
| 🔴 Do now | Base image tag | Pin to digest | 1 |
| 🔴 Do now | gunicorn | Pin to 25.1.0 | 1 |
| 🟡 Soon | Girder | Update to `v5.0.0a14` tag | 2 |
| 🟡 Soon | Add Celery local queue worker | New docker-compose service | 2 |
| 🟡 Soon | large_image | Pull latest `girder-5` branch tip | 3 |
| 🟡 Soon | HistomicsUI | Pull latest `girder-5` branch tip | 3 |
| 🟢 Low | celery | Auto-upgrades with requirements refresh | 3 |
| 🟢 Low | tini | Already at latest | — |
| 🟢 Low | Node.js | Already at LTS current | — |
| ⏳ Later | All pip installs | Switch to PyPI after Girder 5.0.0 stable | 4 |

---

## 7. Verification Checklist (after each phase)

- [ ] `curl https://impart.pathassist.health/api/v1/system/version` → returns JSON
- [ ] SSO login (mda.admin / MDA@Pass2024!) → Dashboard loads
- [ ] Click a collection → folders/items appear
- [ ] Open a WSI slide → tiles render correctly, colour matches previous
- [ ] Right-click slide → Analyze Ki67 → draw ROI → result appears (not corrupted)
- [ ] Import Slides modal → assetstore shows → import runs to completion
- [ ] Create annotation as user A → login as user B → verify user B cannot edit
- [ ] `docker stats ver5-girder-1` → CPU < 10%, memory < 2GB at idle

---

## 8. Files to Modify

| File | Location | Change |
|------|----------|--------|
| `dsa5.Dockerfile` | EC2: `/opt/digital_slide_archive/` | Pin base image, upgrade gunicorn, add `--depth 1` to clones |
| `docker-compose.yml` | EC2: `/opt/digital_slide_archive/devops/ver5/` | Add `celery-local` service (Phase 2) |
| `girder.cfg` | EC2: `/opt/digital_slide_archive/devops/ver5/` | Add `[large_image] icc_correction = false` (before Phase 3) |

---

*Report generated from live container inspection + upstream GitHub changelog analysis.*
*Next step: Execute Phase 1 on EC2 server when ready.*
