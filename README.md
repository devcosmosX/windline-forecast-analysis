# Windline — UK Wind Forecast Accuracy

A focused full-stack MVP for the Full Stack SWE challenge. It displays national wind generation forecasts from Elexon BMRS, compares a forecast available at a configured day-ahead decision cutoff with actual wind generation, and reports error metrics.

> **AI-tool disclosure:** AI assistance was used to help draft and structure the implementation. The author should review, test, and understand the code before submission.

## Features

- React dashboard with forecast-versus-actual chart, a quantitative accuracy view, paginated interval table, and CSV export.
- Python FastAPI service fetching the Elexon BMRS `FUELHH` and `WINDFOR` datasets.
- MAE, RMSE, forecast bias, matched interval count, and coverage.
- Retry handling for transient API errors and an in-process cache to avoid re-fetching the month on every refresh.
- Dockerfiles and Docker Compose.

## Important analysis choices

- **Decision window:** 1–31 January 2026.
- **Delivery window:** 2 January–1 February 2026. This treats each decision date as a purchase decision for the following day's delivery. Please explain this interpretation in the video.
- **Forecast cutoff:** latest matching forecast published at or before **10:50 UTC on the day before delivery**. This is an explicit MVP assumption used to operationalize “available when the day-ahead decision is made”; confirm the exact workflow/cutoff with the client if available.
- **Forecast selection:** for each half-hour `startTime`, choose the matching forecast with the most recent `publishTime` that is not after the decision cutoff. A forecast published after the cutoff is not eligible.
- **Error sign:** `errorMW = forecastMW - actualMW`; positive bias means over-forecasting and negative bias means under-forecasting.
- **Scope limitation:** the brief specifies only national wind actuals and forecasts. It does not provide consumer demand or complete generation supply, so this app does **not** claim to calculate the exact amount of additional electricity that must be procured.

## Data endpoints

- Actuals: `https://data.elexon.co.uk/bmrs/api/v1/datasets/FUELHH` filtered to `fuelType=WIND` using `settlementDateFrom` / `settlementDateTo`.
- Forecasts: `https://data.elexon.co.uk/bmrs/api/v1/datasets/WINDFOR` queried by `publishDateTimeFrom` / `publishDateTimeTo`.
- API documentation: https://bmrs.elexon.co.uk/api-documentation/endpoint

Data retrieval uses daily API windows to reduce the risk of unsupported long query ranges. The first `/api/analysis` request can take a while because it loads historical records.

## Run locally without Docker

Prerequisites: Python 3.11+ and Node.js 20+.

### 1. Start the backend

From the repository root in PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --port 8001
```

Check `http://127.0.0.1:8001/api/health`. The development frontend is served at
`http://127.0.0.1:5174`; Vite proxies `/api` to the backend on port 8001. Both
ports are fixed (`strictPort` is enabled), so startup fails visibly rather than
silently choosing another port. The separate FixScan application on port 8000 is
not used by this local setup.

### 2. Start the frontend in another terminal

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5174`.

### 3. Run checks

From the repository root:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s backend -p "test_*.py" -v
cd frontend
npm test
npm run build
```

## Run with Docker

From the repository root:

```bash
docker compose up --build
```

Open `http://localhost:8080`. The frontend container's Nginx proxy forwards
`/api/*` to FastAPI on the Docker network. The backend listens on port 8000
inside Docker and is published on host port 8001; host port 8000 is left
untouched.

## API routes

- `GET /api/health` — service health check.
- `GET /api/analysis` — returns the matched interval data and summary metrics.
- `POST /api/refresh` — clears the in-process cache; call `GET /api/analysis` next to reload from Elexon.

## Directory structure

```text
backend/
  main.py              FastAPI app, Elexon retrieval, forecast selection, metrics
  test_main.py         Backend parsing, selection, metrics, and CORS tests
  requirements.txt     Backend dependencies
  Dockerfile           Backend image
frontend/
  src/App.jsx          React dashboard and its three in-app views
  src/App.test.jsx     Frontend navigation and interaction tests
  src/main.jsx         React entry point
  src/styles.css       Responsive dashboard styling
  src/view-styles.css  Styles for analysis, interval, and mobile navigation views
  vite.config.js       Local API proxy
  Dockerfile           Production frontend image
  nginx.conf           SPA serving and API reverse proxy
  package.json         Frontend dependencies and scripts
docker-compose.yml     Runs both services
Procfile               Web command for a Python-hosting platform
requirements.txt       Root Python dependencies
README.md              Setup, assumptions, and methodology
```

## Metric formulas

For each matched interval, let `e = forecastMW - actualMW`.

- `MAE = mean(abs(e))`
- `RMSE = sqrt(mean(e²))`
- `Bias = mean(e)`
- `Coverage = matched forecast intervals / actual intervals retrieved × 100`

The Accuracy analysis view reuses the backend's metrics and derives an absolute
error distribution from matched rows only. Its eight equal-width bins span zero
to the largest observed absolute error; unmatched rows are excluded, never
treated as zero. Positive interval error means over-forecasting; negative error
means under-forecasting. No missing forecasts are interpolated.

## Known limitations

- The 10:50 UTC cutoff is an explicit MVP assumption, not a confirmed buyer
  decision deadline.
- Coverage uses actual intervals returned by Elexon as its denominator; it is
  not a completeness check against an independently generated half-hour
  calendar.
- The live analysis currently has no selected forecast for any `:30` UTC
  interval. A direct `WINDFOR` query for 1 January publications and 2 January
  delivery returned hourly `startTime` records only, while `FUELHH` actuals
  include half-hour intervals. The app requires an exact normalized
  `startTime` match, so those intervals remain unavailable and are excluded
  from error metrics; no half-hour forecasts are inferred or interpolated.
- Data retrieval is sequential and the cache is in-process, so the initial
  analysis can be slow and separate backend workers can fetch the data
  independently.
- Local development and Docker use same-origin API proxies. For a deployment
  where a browser calls the backend directly from another origin, set
  `WINDLINE_CORS_ORIGINS` on the backend to the exact comma-separated frontend
  origins; wildcard origins are not enabled.

## Deployment notes

This repository is structured for local Docker use. For a hosted deployment,
configure a same-origin reverse proxy or set `VITE_API_URL` to the backend URL
and configure the backend's exact `WINDLINE_CORS_ORIGINS`. Test `/api/health`,
`/api/analysis`, and the frontend from a clean browser session.
The `Procfile` uses the hosting platform's assigned `PORT` (with an 8000
fallback for container-style hosting); it does not change the local development
or Docker host port mapping.

## Before submitting

- Run the app and verify returned dates and record counts.
- Check that the selected forecast's `publishTime` is never after the documented cutoff.
- Confirm whether the buyer's actual decision deadline is 10:50 UTC; the current implementation labels this as an assumption rather than a requirement stated verbatim in the brief.
- Keep the GitHub repo name anonymous as requested by the challenge.
- Record the <=10-minute video: a <=5-minute customer pitch followed by a <=5-minute technical walkthrough.
