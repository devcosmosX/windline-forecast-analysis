import asyncio
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from backend import main


class DatetimeParsingTests(unittest.TestCase):
    def test_normalizes_utc_suffix_and_offsets_to_utc(self):
        utc_value = main.parse_datetime("2026-01-02T11:00:00Z")
        offset_value = main.parse_datetime("2026-01-02T12:00:00+01:00")

        self.assertEqual(utc_value, datetime(2026, 1, 2, 11, tzinfo=timezone.utc))
        self.assertEqual(offset_value, utc_value)

    def test_treats_naive_datetime_as_utc(self):
        self.assertEqual(
            main.parse_datetime("2026-01-02T11:00:00"),
            datetime(2026, 1, 2, 11, tzinfo=timezone.utc),
        )


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        main.build_analysis.cache_clear()

    def tearDown(self):
        main.build_analysis.cache_clear()

    def test_selects_latest_forecast_at_cutoff_and_excludes_later_or_unmatched(self):
        actuals = [
            {"startTime": "2026-01-02T12:00:00+00:00", "actualMW": 100.0},
            {"startTime": "2026-01-02T12:30:00+00:00", "actualMW": 40.0},
        ]
        forecasts = [
            {
                "startTime": actuals[0]["startTime"],
                "publishTime": "2026-01-01T10:40:00+00:00",
                "forecastMW": 130.0,
            },
            {
                "startTime": actuals[0]["startTime"],
                "publishTime": "2026-01-01T10:50:00+00:00",
                "forecastMW": 150.0,
            },
            {
                "startTime": actuals[0]["startTime"],
                "publishTime": "2026-01-01T10:50:01+00:00",
                "forecastMW": 999.0,
            },
            {
                "startTime": actuals[1]["startTime"],
                "publishTime": "2026-01-01T10:50:01+00:00",
                "forecastMW": 999.0,
            },
        ]

        with (
            patch.object(main, "fetch_actual_wind", return_value=actuals),
            patch.object(main, "fetch_wind_forecasts", return_value=forecasts),
        ):
            analysis = main.build_analysis()

        self.assertEqual(analysis["data"][0]["forecastMW"], 150.0)
        self.assertEqual(
            analysis["data"][0]["forecastPublishTime"],
            "2026-01-01T10:50:00+00:00",
        )
        self.assertIsNone(analysis["data"][1]["forecastMW"])
        self.assertIsNone(analysis["data"][1]["errorMW"])
        self.assertEqual(
            analysis["metrics"],
            {
                "maeMW": 50.0,
                "rmseMW": 50.0,
                "biasMW": 50.0,
                "matchedIntervals": 1,
                "actualIntervals": 2,
                "coveragePct": 50.0,
            },
        )

    def test_empty_actuals_have_empty_metrics_without_division_error(self):
        with (
            patch.object(main, "fetch_actual_wind", return_value=[]),
            patch.object(main, "fetch_wind_forecasts", return_value=[]),
        ):
            analysis = main.build_analysis()

        self.assertEqual(
            analysis["metrics"],
            {
                "maeMW": None,
                "rmseMW": None,
                "biasMW": None,
                "matchedIntervals": 0,
                "actualIntervals": 0,
                "coveragePct": 0,
            },
        )

    def test_actual_retrieval_filters_fuel_type_and_malformed_rows(self):
        def mocked_elexon_response(dataset, params):
            if dataset == "FUELHH" and params["settlementDateFrom"] == "2026-01-02":
                return [
                    {
                        "fuelType": "WIND",
                        "startTime": "2026-01-02T00:00:00Z",
                        "generation": "12.5",
                    },
                    {
                        "fuelType": "SOLAR",
                        "startTime": "2026-01-02T00:00:00Z",
                        "generation": "99",
                    },
                    {
                        "fuelType": "WIND",
                        "startTime": "2026-01-02T00:30:00Z",
                        "generation": "invalid",
                    },
                ]
            return []

        with patch.object(main, "fetch_rows", side_effect=mocked_elexon_response):
            actuals = main.fetch_actual_wind()

        self.assertEqual(
            actuals,
            [{"startTime": "2026-01-02T00:00:00+00:00", "actualMW": 12.5}],
        )


class CorsTests(unittest.TestCase):
    def test_local_refresh_preflight_allows_post(self):
        async def request_preflight():
            messages = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message):
                messages.append(message)

            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": "OPTIONS",
                "scheme": "http",
                "path": "/api/refresh",
                "raw_path": b"/api/refresh",
                "query_string": b"",
                "headers": [
                    (b"origin", b"http://127.0.0.1:5174"),
                    (b"access-control-request-method", b"POST"),
                    (b"access-control-request-headers", b"content-type"),
                ],
                "client": ("127.0.0.1", 50000),
                "server": ("127.0.0.1", 8001),
            }
            await main.app(scope, receive, send)
            return messages

        messages = asyncio.run(request_preflight())
        response = next(message for message in messages if message["type"] == "http.response.start")
        headers = dict(response["headers"])

        self.assertEqual(response["status"], 200)
        self.assertEqual(headers[b"access-control-allow-origin"], b"http://127.0.0.1:5174")
        self.assertIn(b"POST", headers[b"access-control-allow-methods"])


if __name__ == "__main__":
    unittest.main()
