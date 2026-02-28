# PathAssist — Custom HistomicsUI

Custom whole-slide image (WSI) viewer built on **DSA v5 / Girder 5** for the
Lymphoma Pathology server at `https://lymphoma.dev.pathassist.health`.

Replicates the [cancer.digitalslidearchive.org](https://cancer.digitalslidearchive.org) experience
using the [HistomicsUI girder-5](https://github.com/DigitalSlideArchive/HistomicsUI/tree/girder-5) stack.

---

## 🚀 Quick Start

### Requirements
- Node.js 18+
- Access to `https://lymphoma.dev.pathassist.health` (Girder 5 server)

### Install & run

```bash
npm install
npm run dev
```

Open http://localhost:3000 — log in with your Girder credentials or paste a Girder API token.

### Build for production

```bash
npm run build
# Output: dist/
```

---

## 🗂 Project Structure

```
src/
├── api/
│   ├── client.js          # Axios client w/ Girder-Token interceptor
│   └── index.js           # All API methods (auth, collections, tiles, annotations, jobs)
├── components/
│   ├── layout/
│   │   ├── Header.jsx     # Top navigation bar + breadcrumb
│   │   └── LoginModal.jsx # Login (username/password + direct token)
│   ├── sidebar/
│   │   └── LeftSidebar.jsx  # Collection → Folder → Item tree
│   ├── viewer/
│   │   ├── ViewerPanel.jsx   # OpenSeadragon WSI viewer
│   │   ├── ViewerToolbar.jsx # Drawing + zoom tools
│   │   └── MagnificationBar.jsx # Mag selector (0.5×–40×)
│   ├── annotations/
│   │   └── AnnotationCanvas.jsx # Canvas overlay: draw + render annotations
│   └── panels/
│       ├── RightPanel.jsx    # Tab container (Metadata / Annotations / Analysis)
│       ├── MetadataPanel.jsx # Tile info, item metadata
│       ├── AnnotationsPanel.jsx # List, show/hide, delete annotations
│       └── AnalysisPanel.jsx # Docker tasks + job monitor
├── config/
│   └── girder.js          # Server URL + endpoint builders
├── store/
│   └── index.js           # Zustand global state
├── styles/
│   └── index.css          # DSA dark theme + Tailwind
├── App.jsx
└── main.jsx
```

---

## 🔐 Authentication

Two login methods are supported:

**Username/password:**
```
POST /api/v1/user/authentication
Authorization: Basic base64(user:pass)
```

**Direct Girder API token:**  
Click "Use API token instead" on the login screen and paste your token.

---

## 🌐 Girder 5 API Endpoints Used

| Purpose | Endpoint |
|---|---|
| Login | `GET /user/authentication` |
| Collections | `GET /collection` |
| Folders | `GET /folder?parentType=...&parentId=...` |
| Items (slides) | `GET /item?folderId=...` |
| Tile info | `GET /item/{id}/tiles` |
| DZI source | `GET /item/{id}/tiles/dzi` |
| Thumbnail | `GET /item/{id}/tiles/thumbnail` |
| Annotations | `GET /annotation?itemId=...` |
| Save annotation | `POST /annotation?itemId=...` |
| Delete annotation | `DELETE /annotation/{id}` |
| Docker tasks | `GET /slicer_cli_web/docker_image` |
| Jobs | `GET /job` |

---

## 🎨 Design

Dark theme matching CDSA (`#0d0e14` background, `#4da6ff` accent).  
Font: IBM Plex Sans + IBM Plex Mono.

---

## 🔧 Configuration

Edit `src/config/girder.js` to change the server URL:

```js
export const GIRDER_BASE = 'https://your-server.example.com/api/v1';
```

For development, the Vite proxy in `vite.config.js` forwards `/api` to your Girder server
to avoid CORS issues.

---

## 📦 Key Dependencies

| Package | Purpose |
|---|---|
| `openseadragon` | WSI tile viewer |
| `@tanstack/react-query` | Data fetching & caching |
| `zustand` | Global state management |
| `axios` | HTTP client w/ interceptors |
| `tailwindcss` | Utility CSS |
| `lucide-react` | Icons |

---

## References

- [DigitalSlideArchive/digital_slide_archive](https://github.com/DigitalSlideArchive/digital_slide_archive)
- [DigitalSlideArchive/HistomicsUI — girder-5 branch](https://github.com/DigitalSlideArchive/HistomicsUI/tree/girder-5)
- [Girder 5 documentation](https://girder.readthedocs.io)
- [large_image documentation](https://github.com/girder/large_image)
# pathassist23
# pathassist23
