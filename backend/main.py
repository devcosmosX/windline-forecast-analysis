from __future__ import annotations

import os
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from math import sqrt
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

API_BASE = "https://data.elexon.co.uk/bmrs/api/v1/datasets"
# Assignment asks for purchase decisions made during January 2026.
# The decision date is therefore Jan 1–31, while the delivery intervals
# evaluated are Jan 2–Feb 1 (the day after each decision date).
DECISION_START = date(2026, 1, 1)
DECISION_END = date(2026, 1, 31)
DELIVERY_START = DECISION_START + timedelta(days=1)
DELIVERY_END = DECISION_END + timedelta(days=1)
# Explicit MVP assumption: use the latest forecast published by 10:50 UTC
# on the day before delivery. Keep this assumption visible in the UI/README.
DECISION_CUTOFF = time(10, 50)

session = requests.Session()
retry = Retry(
    total=4,
    connect=4,
    read=4,
    backoff_factor=0.5,
    status_forcelist=(429, 500, 502, 503, 504),
    allowed_methods=frozenset(["GET"]),
    respect_retry_after_header=True,
)
session.mount("https://", HTTPAdapter(max_retries=retry))

app = FastAPI(title="UK Wind Forecast Accuracy API", version="1.0.0")
cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "WINDLINE_CORS_ORIGINS",
        "http://localhost:5174,http://127.0.0.1:5174,https://windline-forecast-analysis.vercel.app",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


def parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def rows_from_response(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        data = payload.get("data", [])
        if isinstance(data, list):
            return [row for row in data if isinstance(row, dict)]
    return []


def fetch_rows(dataset: str, params: dict[str, str]) -> list[dict[str, Any]]:
    url = f"{API_BASE}/{dataset}"
    response = session.get(url, params={**params, "format": "json"}, timeout=45)
    response.raise_for_status()
    return rows_from_response(response.json())


def iter_dates(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def fetch_actual_wind() -> list[dict[str, Any]]:
    actuals: dict[str, dict[str, Any]] = {}
    # Query one settlement date at a time to avoid API range-limit surprises.
    for day in iter_dates(DELIVERY_START, DELIVERY_END):
        rows = fetch_rows(
            "FUELHH",
            {"settlementDateFrom": day.isoformat(), "settlementDateTo": day.isoformat()},
        )
        for row in rows:
            if row.get("fuelType") != "WIND":
                continue
            start = parse_datetime(row.get("startTime"))
            if not start or start.date() < DELIVERY_START or start.date() > DELIVERY_END:
                continue
            try:
                generation = float(row["generation"])
            except (KeyError, TypeError, ValueError):
                continue
            actuals[start.isoformat()] = {
                "startTime": start.isoformat(),
                "actualMW": generation,
            }
    return list(actuals.values())


def fetch_wind_forecasts() -> list[dict[str, Any]]:
    forecasts: dict[tuple[str, str], dict[str, Any]] = {}
    # Include 31 Dec as a fallback for the first decision day in January.
    # Only forecasts published by the decision cutoff are eligible for scoring.
    publication_start = DECISION_START - timedelta(days=1)
    for publish_day in iter_dates(publication_start, DECISION_END):
        next_day = publish_day + timedelta(days=1)
        rows = fetch_rows(
            "WINDFOR",
            {
                "publishDateTimeFrom": f"{publish_day.isoformat()}T00:00:00Z",
                "publishDateTimeTo": f"{next_day.isoformat()}T00:00:00Z",
            },
        )
        for row in rows:
            published = parse_datetime(row.get("publishTime"))
            start = parse_datetime(row.get("startTime"))
            if not published or not start:
                continue
            # Some endpoints use an inclusive end boundary. Filter explicitly
            # so an exact midnight record is not accidentally assigned twice.
            if published.date() != publish_day:
                continue
            try:
                generation = float(row["generation"])
            except (KeyError, TypeError, ValueError):
                continue
            key = (start.isoformat(), published.isoformat())
            forecasts[key] = {
                "startTime": start.isoformat(),
                "publishTime": published.isoformat(),
                "forecastMW": generation,
            }
    return list(forecasts.values())


@lru_cache(maxsize=1)
def build_analysis() -> dict[str, Any]:
    try:
        actuals = fetch_actual_wind()
        forecasts = fetch_wind_forecasts()
    except requests.RequestException as exc:
        raise RuntimeError(f"Unable to retrieve data from the Elexon API: {exc}") from exc

    by_start: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for forecast in forecasts:
        by_start[forecast["startTime"]].append(forecast)

    rows_out: list[dict[str, Any]] = []
    errors: list[float] = []
    squared_errors: list[float] = []
    absolute_errors: list[float] = []
    all_actual_count = len(actuals)

    for actual in sorted(actuals, key=lambda row: row["startTime"]):
        start_dt = parse_datetime(actual["startTime"])
        if not start_dt:
            continue
        decision_date = start_dt.date() - timedelta(days=1)
        cutoff = datetime.combine(decision_date, DECISION_CUTOFF, tzinfo=timezone.utc)
        eligible = []
        for forecast in by_start.get(actual["startTime"], []):
            published = parse_datetime(forecast["publishTime"])
            if published and published <= cutoff:
                eligible.append((published, forecast))
        selected = max(eligible, key=lambda item: item[0])[1] if eligible else None

        actual_mw = actual["actualMW"]
        forecast_mw = selected["forecastMW"] if selected else None
        publish_time = selected["publishTime"] if selected else None
        error_mw = (forecast_mw - actual_mw) if forecast_mw is not None else None
        if error_mw is not None:
            errors.append(error_mw)
            absolute_errors.append(abs(error_mw))
            squared_errors.append(error_mw * error_mw)

        rows_out.append(
            {
                "startTime": actual["startTime"],
                "deliveryDate": start_dt.date().isoformat(),
                "decisionDate": decision_date.isoformat(),
                "forecastPublishTime": publish_time,
                "forecastMW": forecast_mw,
                "actualMW": actual_mw,
                "errorMW": error_mw,
                "absErrorMW": abs(error_mw) if error_mw is not None else None,
            }
        )

    matched = len(errors)
    mae = sum(absolute_errors) / matched if matched else None
    rmse = sqrt(sum(squared_errors) / matched) if matched else None
    bias = sum(errors) / matched if matched else None

    return {
        "title": "UK Wind Forecast Accuracy",
        "decisionPeriod": {
            "from": DECISION_START.isoformat(),
            "to": DECISION_END.isoformat(),
        },
        "deliveryPeriod": {
            "from": DELIVERY_START.isoformat(),
            "to": DELIVERY_END.isoformat(),
        },
        "decisionCutoff": "10:50 UTC on the day before delivery (MVP assumption)",
        "metrics": {
            "maeMW": round(mae, 2) if mae is not None else None,
            "rmseMW": round(rmse, 2) if rmse is not None else None,
            "biasMW": round(bias, 2) if bias is not None else None,
            "matchedIntervals": matched,
            "actualIntervals": all_actual_count,
            "coveragePct": round((matched / all_actual_count) * 100, 2) if all_actual_count else 0,
        },
        "data": rows_out,
        "sources": {
            "actuals": "Elexon BMRS FUELHH (fuelType=WIND)",
            "forecasts": "Elexon BMRS WINDFOR",
        },
        "notes": [
            "A January decision is compared with next-day delivery intervals, so delivery dates run from 2026-01-02 through 2026-02-01.",
            "For each delivery interval, the selected forecast is the latest matching startTime published at or before the configured decision cutoff.",
            "Bias is forecast minus actual: positive values mean over-forecasting; negative values mean under-forecasting.",
            "This dataset does not include consumer demand, so the app does not calculate a definitive electricity procurement requirement.",
        ],
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "uk-wind-forecast-api"}


@app.get("/api/analysis")
def analysis():
    try:
        return build_analysis()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/refresh")
def refresh():
    """Clear the in-process cache and rebuild on the next /api/analysis request."""
    build_analysis.cache_clear()
    return {"status": "cache_cleared", "message": "Call GET /api/analysis to reload data."}
