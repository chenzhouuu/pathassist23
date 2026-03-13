# PathAssist — Feature Development Plan

**Last updated:** 2026-03-13
**Status:** In Progress
**Branch:** `feature/add-intermediate-page`

---

## 1. Vision

PathAssist is a multi-tenant digital pathology platform. Each organization (hospital, lab, research institute) is an isolated tenant. Within each org, role-based access controls what each user can see and do — from a patient viewing only their own slides, to a super admin managing all organizations.

---

## 2. Multi-Tenant Data Model

```
Girder
├── Collection: "MDA Anderson"           ← one per org
│   ├── Folder: "PAT-2024-001"          ← one per patient / research group
│   │   ├── slide_001.svs
│   │   ├── slide_002.svs
│   │   └── report.pdf
│   ├── Folder: "PAT-2024-002"
│   └── Folder: "RESEARCH-Lymphoma-Q1"
│
├── Collection: "Algopath Lab"
│   └── ...
│
└── Collection: "Johns Hopkins"
    └── ...
```

**Core rules:**
- 1 Collection = 1 Organization
- 1 Folder = 1 Patient / Case / Research Group
- Every slide/item belongs to exactly one org via its parent folder
- Girder ACLs enforce data isolation — a user from Org A cannot see Org B's data at the API level

---

## 3. Role Definitions

| Role | Girder Group | Who | Scope |
|------|-------------|-----|-------|
| `super-admin` | `admin=true` in Girder | Platform owner / Impart DX ops | All collections, all orgs |
| `lab-manager` | `{org}-admin` + `lab-manager` | Org administrator | All folders in their org collection |
| `pathologist` | `{org}-pathologist` + `pathologist` | Clinical pathologist | All folders in their org |
| `fellow` | `{org}-fellow` + `fellow` | Pathology fellow | All folders in their org |
| `researcher` | `{org}-researcher` + `researcher` | Research scientist | Assigned collections, read + annotate |
| `lab-technician` | `{org}-lab-tech` + `lab-technician` | Lab staff | Upload slides, manage folders in their org |
| `second-opinion-reviewer` | `second-opinion-reviewer` | External specialist | Only SO cases assigned to them |
| `referring-physician` | `{org}-referring` + `referring-physician` | External doctor | Only cases they submitted |
| `patient` | `patient` | Patient | Only their own folder (single folder ACL) |

### Feature Access Matrix

| Feature | super-admin | lab-manager | pathologist | fellow | researcher | lab-tech | so-reviewer | referring-physician | patient |
|---------|:-----------:|:-----------:|:-----------:|:------:|:----------:|:--------:|:-----------:|:-------------------:|:-------:|
| View all org images | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| View own images only | — | — | — | — | — | — | — | — | ✅ |
| Annotate slides | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Run AI analysis | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| Import / upload slides | ✅ | ✅ | — | — | — | ✅ | — | — | — |
| Create case / SO case | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| Submit SO case (referring) | — | — | — | — | — | — | — | ✅ | — |
| Review / complete SO case | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | — | — |
| Manage projects | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| View own submitted cases | — | — | — | — | — | — | — | ✅ | — |
| View own case status/report | — | — | — | — | — | — | — | — | ✅ |
| Manage org users | ✅ | ✅ | — | — | — | — | — | — | — |
| Create new org collection | ✅ | — | — | — | — | — | — | — | — |

---

## 4. Keycloak → Girder Group Mapping

Keycloak groups are structured per-org. On every SSO login, `_syncGirderGroups()` in `keycloak_oauth_provider.py` syncs the user into the correct Girder groups.

```
Keycloak Group Tree:
├── /mda/admin              → Girder: "mda-admin" + "lab-manager"
├── /mda/pathologist        → Girder: "mda-pathologist" + "pathologist"
├── /mda/fellow             → Girder: "mda-fellow" + "fellow"
├── /mda/lab-tech           → Girder: "mda-lab-tech" + "lab-technician"
├── /mda/referring          → Girder: "mda-referring" + "referring-physician"
├── /mda/patient            → Girder: "patient" (folder ACL set individually)
│
├── /algopath/admin         → Girder: "algopath-admin" + "lab-manager"
├── /algopath/pathologist   → Girder: "algopath-pathologist" + "pathologist"
└── ...
```

The feature groups (`lab-manager`, `pathologist`, etc.) are global — they drive UI feature access.
The org groups (`mda-admin`, `algopath-pathologist`, etc.) are org-scoped — they drive Girder data ACLs.

---

## 5. Girder ACL Setup Per Org

When a new org is onboarded, these ACLs are set on the org collection:

```
Collection "MDA Anderson" ACL:
  Group "mda-admin"       → Admin  (can manage collection + all folders)
  Group "mda-pathologist" → Write  (read slides + save annotations)
  Group "mda-fellow"      → Write
  Group "mda-lab-tech"    → Write  (create folders, upload files)
  Group "mda-researcher"  → Read
  Group "mda-referring"   → Read   (further filtered by submittedBy in UI)
  (patients: no collection-level access)

Per-patient folder ACL (added when patient is onboarded):
  Folder "PAT-2024-001":
    User "patient-jane-doe" → Read  (their folder only)
    (all org groups inherit from collection)
```

---

## 6. User Flows

### 6.1 Super Admin
```
Login → Dashboard (ALL collections visible)
  ├── Create new org collection → set up ACLs
  ├── Create org admin account in Keycloak (/org/admin)
  ├── Monitor all cases across all orgs
  └── Platform-level settings
```

### 6.2 Org Admin (Lab Manager)
```
Login → Dashboard (their org collection only)
  ├── All Images tab → see all patient folders in org
  ├── Cases / Second Opinion → see all cases in org
  ├── Create Case:
  │     Select folder → fill clinical info → assign pathologist → Submit
  ├── Manage Users:
  │     Invite pathologist / lab tech / referring physician
  │     Assign Keycloak group (/org/pathologist, etc.)
  └── Export reports
```

### 6.3 Pathologist
```
Login → Dashboard (org collection)
  ├── All Images → open any slide → full viewer
  │     Annotations panel (create, edit, delete)
  │     AI Analysis panel (nuclei detection, ROI, Slicer CLI jobs)
  ├── Second Opinion tab → cases assigned to them
  │     Open case → view slides + clinical info
  │     Write conclusion → mark "Completed"
  └── Projects tab → manage case collections
```

### 6.4 Lab Technician
```
Login → Worklist / Upload page
  ├── Upload slides:
  │     Select org collection → create/select folder (patient ID)
  │     Drag-drop SVS/TIFF/NDPI files → upload to Girder
  │     Slides auto-register large-image tiles
  ├── Basic worklist (list of folders/items in org)
  └── No annotation, no AI, no case creation
```

### 6.5 Referring Physician
```
Login → Referring Portal (simplified, no viewer)
  ├── "Submit New Case" button:
  │     Step 1: Patient Info (ID, age, sex, institution)
  │     Step 2: Clinical Details (site, urgency, history, IHC)
  │     Step 3: Select slides (from their org's uploaded folders)
  │             Attach original report PDF
  │     Submit → case created with status "Submitted"
  │             submittedBy: user._id stored in metadata
  └── "My Cases" table:
        Shows ONLY cases submitted by this user
        Columns: Case ID, Patient, Urgency, Status, Date, Report
        Download report button when status = "Completed"
```

### 6.6 Patient
```
Login → Patient Portal (minimal, clean)
  ├── "My Slides" section:
  │     Thumbnail grid of WSIs in their folder ONLY
  │     Click → read-only viewer (no toolbar, no annotation, no AI)
  ├── "My Case Status" (if linked to SO case):
  │     Shows: case ID, date submitted, current status
  └── "My Reports":
        Download PDF when available
        No access to any other patient's data
        (Girder ACL enforces this at API level — 403 if they try)
```

### 6.7 Second Opinion Reviewer
```
Login → Second Opinion page (filtered to assigned cases)
  ├── See cases assigned to them (or all SO cases, depending on config)
  ├── Open case → viewer with:
  │     Annotation tools (add findings)
  │     Clinical info panel (read the case context)
  └── Write conclusion → mark "Completed"
        (no AI panel, no project management)
```

---

## 7. Frontend Implementation Plan

### 7.1 Store Changes — `src/store/index.js`

**Updated ROLE_MAP:**
```js
ROLE_MAP: {
  'worklist-users':          ['lab-manager', 'pathologist', 'fellow', 'researcher', 'lab-technician'],
  'annotation-users':        ['lab-manager', 'pathologist', 'fellow', 'researcher', 'second-opinion-reviewer'],
  'ai-users':                ['lab-manager', 'pathologist', 'fellow', 'researcher'],
  'import-users':            ['lab-manager', 'lab-technician'],
  'case-create-users':       ['lab-manager', 'pathologist'],
  'projects-users':          ['lab-manager', 'pathologist'],
  'second-opinion-users':    ['lab-manager', 'pathologist', 'fellow', 'second-opinion-reviewer', 'referring-physician'],
  'referring-portal-users':  ['referring-physician'],
  'patient-portal-users':    ['patient'],
}
```

**New store fields:**
```js
activeOrgCollection: null,   // the org collection this user belongs to (set post-login)
setActiveOrgCollection: (col) => set({ activeOrgCollection: col }),
```

### 7.2 Smart Routing — `src/App.jsx`

```jsx
// After login, route based on role
if (!token) return <LoginModal />;
if (hasRole('patient-portal-users'))   return <PatientPortalPage />;
if (hasRole('referring-portal-users')) return <ReferringPortalPage />;
// all internal roles → page-based routing
if (currentPage === 'dashboard')       return <Dashboard />;
if (currentPage === 'second-opinion')  return <SecondOpinionPage />;
// ... etc
```

### 7.3 New Pages

| Page | File | Status |
|------|------|--------|
| Patient Portal | `src/components/patient/PatientPortalPage.jsx` | TODO |
| Referring Portal | `src/components/referring/ReferringPortalPage.jsx` | TODO |
| Org Admin Panel | `src/components/admin/OrgAdminPage.jsx` | TODO (later) |

### 7.4 Viewer Panel Gating — `src/components/ViewerApp.jsx`

```jsx
{hasRole('annotation-users') && <AnnotationsPanel />}
{hasRole('ai-users')         && <AnalysisPanel />}
{hasRole('import-users')     && <ImportButton />}
```

### 7.5 API Scoping

**`getSOCases` — scope by role:**
- `referring-physician`: filter results to `so.submittedBy === user._id`
- `second-opinion-reviewer`: filter to cases where `so.assignedTo === user._id` (or all)
- `lab-manager` / `pathologist`: see all in their org collection

**`getCollections` — scope by org:**
- `super-admin`: returns all collections
- All others: returns only collections their Girder groups have access to (Girder enforces this)

---

## 8. Backend / Girder Changes

### 8.1 `keycloak_oauth_provider.py` — group sync improvements

Current: syncs feature groups only
Needed: also sync org-scoped groups (`mda-admin`, `algopath-pathologist`, etc.)

```python
def _syncGirderGroups(self, info):
    user = info['user']
    kc_groups = info.get('groups', [])   # from Keycloak token claim

    for kc_group in kc_groups:
        # /mda/admin → ensure user is in Girder group "mda-admin"
        org_group_name = kc_group.strip('/').replace('/', '-')
        # ... create or find Girder group, add user
```

### 8.2 Patient folder ACL

When a patient user is onboarded:
1. Lab manager creates a folder for the patient
2. Stores patient's Girder user ID in folder metadata: `meta.pathassist.patientUserId`
3. Script/hook grants that user READ access on that folder

### 8.3 `provision.yaml` — org onboarding

Add a section for org setup — creates collection, sets ACLs, creates admin group automatically.

---

## 9. Org Onboarding Checklist

When adding a new hospital/lab/organization:

```
[ ] 1. Super admin creates Girder Collection: "Org Name"
[ ] 2. Create Keycloak groups: /org/admin, /org/pathologist, /org/lab-tech, /org/referring, /org/patient
[ ] 3. Set collection ACLs for org groups (script: deploy/scripts/setup-org-acl.sh)
[ ] 4. Create Org Admin account in Keycloak → assign /org/admin
[ ] 5. Org Admin logs in → Girder group sync runs → collection access confirmed
[ ] 6. Lab tech uploads first patient slides → creates first patient folder
[ ] 7. Org Admin creates first case → pathologist assigned → review begins
[ ] 8. Patient onboarded → Keycloak patient account created → folder ACL granted
```

---

## 10. Development Milestones

### Phase 1 — Role Infrastructure (current sprint)
- [ ] Update `ROLE_MAP` in store with all 7 roles
- [ ] Smart routing in `App.jsx` based on role
- [ ] Gate annotation/AI panels in viewer by role
- [ ] Scope `getSOCases` by `submittedBy` for referring physicians

### Phase 2 — Referring Physician Portal
- [ ] `ReferringPortalPage` — case submission form + my cases table
- [ ] `submittedBy` field added to case metadata on creation
- [ ] Email notification to org admin when case submitted (future)

### Phase 3 — Patient Portal
- [ ] `PatientPortalPage` — my slides grid + report download
- [ ] Read-only viewer mode (no annotation toolbar, no AI)
- [ ] Patient folder ACL workflow

### Phase 4 — Org Admin Panel
- [ ] `OrgAdminPage` — user list, invite user, assign role
- [ ] Girder group management via API
- [ ] Org-scoped collection stats (cases, slides, pending reviews)

### Phase 5 — Backend Hardening
- [ ] `keycloak_oauth_provider.py` — org-scoped group sync
- [ ] `provision.yaml` — automated org collection + ACL setup
- [ ] Patient folder ACL automation script
- [ ] Audit log: who accessed which slide

---

## 11. Open Questions

1. **Patient identification**: How is a patient matched to their Girder folder? By Keycloak username = folder name? Or metadata field?
2. **Report delivery**: When an SO case is "Completed", how does the report reach the referring physician / patient? Email? In-app download?
3. **Slide upload for referring physicians**: Do they upload slides themselves, or does the lab tech upload after receiving physical slides?
4. **Multi-org pathologist**: Can a pathologist belong to multiple orgs? (Keycloak supports multiple groups — `/mda/pathologist` AND `/algopath/pathologist`)
5. **SO reviewer assignment**: Is a case auto-assigned to a reviewer, or does the org admin manually assign?
