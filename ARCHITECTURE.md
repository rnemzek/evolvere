# ARCHITECTURE.md — GridZilla ēvolvere System Architecture

## 1. Executive Summary & Domain Mission

GridZilla ēvolvere is a high-performance EV charging registry, spatial locator, and grid intelligence platform. It provides real-time geospatial visualization, station attribute search, and operational fleet analytics for alternative fuel infrastructure across North America.

The platform is designed with a privacy-first, offline-capable, dual-coordinate spatial engine prioritizing sub-second client map rendering, high data fidelity, and strict memory efficiency on mobile devices.

---

## 2. Core Architecture & Tech Stack


```

[ Upstream APIs / External Feeds ]
├── AFDC Registry (developer.nlr.gov)
├── OCPI Streams / Telemetry (In Roadmap)
└── Grid Outage Polygons (In Roadmap)
│
▼
[ Backend Ingest & Spatial Engine (Node.js / Express) ]
├── afdcIngest.js ──> Sync Engine (Live Fetch / Local Snapshot Fallback)
├── geocodeEngine.js ─> Dual-Coordinate Resolution & Precision Scoring
└── SQLite Database (stations.db v15 Schema)
│
▼
REST / Bounding Box Spatial API (`/api/v1/...`)
│
[ Frontend Web Application (Vite / React / Leaflet) ]
├── HTML5 Canvas Renderer (Mass Pin Marker Rasterization)
├── Leaflet Sticky Popup UI (StationCard Component)
└── Responsive Map / Dashboard Viewport Layers

```

### Core Technologies

* **Frontend:** React, Vite, Leaflet (Canvas Marker Renderer), CSS Modules.
* **Backend:** Node.js, Express REST API.
* **Database:** SQLite (`stations.db`) with custom spatial index optimization and dual-coordinate tracking.
* **Upstream Primary:** AFDC (Alternative Fuels Data Center) API via `developer.nlr.gov`.

---

## 3. Data Sources & Ingest Engine

### 3.1 Primary Upstream Registry Provider

* **Provider:** U.S. Department of Energy / NLR (National Laboratory of the Rockies).
* **Endpoint:** `https://developer.nlr.gov/api/alt-fuel-stations/v1.json`
* **Deprecated Domain Warning:** Legacy domain `developer.nrel.gov` was retired (May 2026). All active ingest logic strictly routes to `developer.nlr.gov`.
* **Fallback Boot Sequence:** In restricted sandboxes or offline environments, the ingest pipeline seeds from an authentic, immutable snapshot (`backend/data/afdc_snapshot.json`). Synthetic/mock coordinate generators are strictly prohibited.

### 3.2 Dynamic Telemetry & Protocol Roadmap

* **AFDC Registry:** Static metadata, physical locations, plug counts, access hours, and network operators.
* **OCPI / Dynamic Status (Roadmap / UOW-23):** Open Charge Point Interface feeds for live port availability (`AVAILABLE`, `CHARGING`, `FAULTED`).
* **Grid Outage Feeds (Roadmap / UOW-24):** Spatial overlay mapping utility blackout polygons against station bounding boxes.

---

## 4. Dual-Coordinate Spatial Schema & Pipeline

To guarantee 100% spatial precision without corrupting raw upstream data, `stations.db` enforces a dual-coordinate schema (v15):

| Field | Description | Source / Integrity |
| :--- | :--- | :--- |
| `afdc_latitude`, `afdc_longitude` | Immutable raw coordinates received directly from AFDC registry. | Upstream Source Truth |
| `afdc_geocode_status` | Source precision rating (e.g., GPS, 200-800). | Source Metadata |
| `geocoded_latitude`, `geocoded_longitude` | Coordinates derived from secondary interpolation (`geocodeEngine.js`). | Derived / Cross-Check |
| `latitude`, `longitude` | Active rendering coordinates used by Leaflet maps. | Runtime Promoted |
| `precision_score` | Hierarchical ranking: `NATIVE_GPS` > `ROOFTOP_INTERPOLATED` > `ZIP_CENTROID`. | Spatial Classification |

### Coordinate Resolution Logic

If AFDC provides high-precision source coordinates (GPS), they are written to `afdc_*` and immediately promoted to active `latitude`/`longitude` (`precision_score = NATIVE_GPS`). Secondary geocoding results are stored in `geocoded_*` as a cross-verification layer. Native GPS points are promoted over interpolated values to eliminate phantom spatial drift.

---

## 5. Frontend Architecture & Mobile Optimization

### 5.1 High-Density Map Rendering (Canvas Rasterization)

To support 83,000+ national station records without triggering Mobile Chrome Out-Of-Memory (OOM) crashes:

* **Canvas Rendering:** Standard map pins render through a shared HTML5 Canvas layer (`CircleMarkers`) rather than individual DOM elements.
* **Marker Capping:** Active viewport marker rendering is hard-capped (`STATION_MODE_CAP = 500`).
* **Zoom Clustering:** Marker clustering is enforced at zoom levels ≤ 13.

### 5.2 Responsive UI Views

* **Map View (`/`):** Full-bleed interactive viewport with region quick-nav buttons, search geocoder, layer toggles, and station selection inspector.
* **Dashboard View (`/dashboard`):** High-level fleet metrics, network distribution charts, and regional density breakdowns.
* **Financials View (`/financials`):** Infrastructure cost estimations and utilization models.

### 5.3 Mobile Interaction Patterns

**Sticky Station Popups:** Tapping a station marker opens a native Leaflet Popup (`StationCard`) displaying:
* Station Name & AFDC ID
* EV Network / Operator (e.g., Tesla, ChargePoint)
* Street Address, City, State, ZIP
* Connector types & max power output (e.g., `TESLA • 150 kW`, `J1772 • 6.5 kW`)
* Access Hours & Days

*Behavior:* Popups remain open until explicitly closed via the (X) button or when another marker is tapped.

---

## 6. Branding & Asset Guidelines

* **Product Name:** GridZilla ēvolvere
* **Icon Aesthetic:** Punk/skunkworks hand-drawn black imperfect brush stroke circle enclosing an electric yellow "GZ" monogram on a bold red canvas (`#D31212`).
* **Header Mounting:** Responsive inline mounting left of the title (28px desktop / 20px mobile).
* **Favicon Path:** `/app-icon.svg` / `/favicon-32x32.png`.

