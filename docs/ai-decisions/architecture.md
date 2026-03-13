---
name: Platform Architecture Decisions
type: project
---

# PathAssist / Impart DX — Architecture Decisions

## Stack
- **Frontend**: React + Vite + Tailwind, served via `npx serve dist`
- **Backend**: Girder DSA v5 (Python, MongoDB)
- **Auth**: Keycloak 24.0 (SSO/OIDC), PostgreSQL-backed
- **Infra**: AWS EC2, nginx reverse proxy, Docker Compose
- **Tile serving**: DSA large-image (S3 + local assetstore)

## Multi-Brand White-Label
One backend, multiple branded frontends. Each brand is a separate Vite build
with different `VITE_*` env vars:

| Brand | Domain | Logo env var |
|-------|--------|-------------|
| Impart DX | impart.pathassist.health | `/impart-dx-logo.png` |
| Algopath | algopath.pathassist.health | `/alogopath-logo.png` |
| MDA | mda.pathassist.health | `/mda-logo.png` |

Branding config lives in `src/config/branding.js`.

## User & Group Model
Girder groups map to roles:

| Group | Access |
|-------|--------|
| `individual` | READ on AlgopathImages collection — default for all self-registered users |
| `pathologist` | READ + annotate |
| `lab-admin` | Full collection admin |
| `referring-doctor` | READ only on shared cases |

Groups auto-assigned on SSO login via Keycloak group mapper →
`deploy/keycloak_oauth_provider.py` `_syncGirderGroups()`.

## Keycloak SSO Flow
1. User clicks "Sign in with SSO" in LoginModal
2. Redirected to `auth.pathassist.health/realms/pathassist/...`
3. Keycloak authenticates (email/password or Google OAuth2)
4. Callback to `https://impart.pathassist.health/api/v1/oauth/keycloak/callback`
5. Girder creates/updates user, syncs groups, returns token
6. Frontend stores token in Zustand store

## Keycloak Theme
Custom login page at `deploy/keycloak-theme/pathassist/`.
- Inherits layout from `parent=keycloak` (only overrides colors/branding)
- Pink gradient background matching Impart DX brand (`#fce4ec → #f8bbd0`)
- Accent color: `#e91e63`
- Mounted into container: `./keycloak-theme/pathassist:/opt/keycloak/themes/pathassist:ro`
- Activated via: `KC_SPI_THEME_DEFAULT: pathassist` + realm `loginTheme` setting

## nginx Routing (EC2)
nginx at port 80, routes by hostname:
- `impart.pathassist.health` → Girder API (8080) + pathassist-ui (3000)
- `algopath.pathassist.health` → pathassist-algopath container
- `mda.pathassist.health` → pathassist-mda container
- `auth.pathassist.health` → Keycloak (8080) + `X-Forwarded-Proto: https`

ALB (AWS) handles HTTPS termination with `*.pathassist.health` wildcard cert.

## Key Files
- `deploy/docker-compose.yml` — all services (actual live one at `/opt/digital_slide_archive/devops/ver5/`)
- `deploy/keycloak_oauth_provider.py` — drop into girder container at `/opt/girder/plugins/oauth/girder_oauth/providers/keycloak.py`
- `deploy/nginx-multi.conf` — multi-brand nginx config
- `src/config/branding.js` — logo/name/tagline driven by VITE env vars
- `src/components/layout/LoginModal.jsx` — SSO button + login form
