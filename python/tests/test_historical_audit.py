"""Small transparent regression audit over archived, pregame-locked NFL picks.

This is an in-sample sanity check, *not* proof of out-of-sample accuracy.
One retrospective manual Week 5 entry is explicitly excluded.
"""
import json
import unittest
from pathlib import Path

from src.production_model import calibrate_moneyline_probabilities, remove_vig

REPO_ROOT = Path(__file__).resolve().parents[2]


def historical_games():
    for week in (3, 4, 5):
        pred_path = REPO_ROOT / "data" / "predictions" / f"2026-week-{week}.json"
        final_path = REPO_ROOT / "data" / "results" / f"2026-week-{week}.json"
        preds = json.loads(pred_path.read_text(encoding="utf-8"))["predictions"]
        results = json.loads(final_path.read_text(encoding="utf-8"))["settlements"]
        final_by_id = {str(row["event_id"]): row for row in results}
        for p in preds:
            if (not p.get("locked_at")
                or p.get("backfill_status") == "retrospective_manual"
                or p.get("manual_entry", {}).get("retrospective")):
                continue
            final = final_by_id.get(str(p["event_id"]))
            if final is None or final.get("actual_margin") is None:
                continue
            yield p, final


class HistoricalAuditTests(unittest.TestCase):
    def test_pregame_2026_replay_and_calibration(self):
        games = list(historical_games())
        self.assertEqual(len(games), 46, "Check archived lock/settlement coverage")
        raw_errors, calibrated_errors, market_errors = [], [], []
        old_total_errors, new_total_errors = [], []
        for prediction, final in games:
            m = prediction["market"]
            x = prediction["model"]
            actual_home_win = float(final["actual_margin"]) > 0

            if float(final["actual_margin"]) != 0:
                h, a = float(x["home_win_prob"]), float(x["away_win_prob"])
                if h + a > 0:
                    raw_p = h / (h + a)
                    adjusted = calibrate_moneyline_probabilities(x, m.get("home_ml"), m.get("away_ml"))
                    new_p = adjusted["home_win_prob"] / (
                        adjusted["home_win_prob"] + adjusted["away_win_prob"]
                    )
                    mh, _ = remove_vig(m.get("home_ml"), m.get("away_ml"))
                    if mh is not None:
                        target = float(actual_home_win)
                        raw_errors.append((raw_p - target) ** 2)
                        calibrated_errors.append((new_p - target) ** 2)
                        market_errors.append((mh - target) ** 2)

            if x.get("football_total") is not None and m.get("total") is not None:
                target = float(final["actual_total"])
                old_total = float(x["expected_total"])
                old_total_errors.append(abs(old_total - target))
                new_total = (
                    float(m["total"])
                    + 0.05 * (float(x["football_total"]) - float(m["total"]))
                    + float(x.get("weather_total_adjustment", 0))
                )
                new_total_errors.append(abs(new_total - target))

        self.assertGreaterEqual(len(raw_errors), 40)
        raw_brier = sum(raw_errors) / len(raw_errors)
        new_brier = sum(calibrated_errors) / len(calibrated_errors)
        market_brier = sum(market_errors) / len(market_errors)
        old_mae = sum(old_total_errors) / len(old_total_errors)
        new_mae = sum(new_total_errors) / len(new_total_errors)
        print(
            f"Locked 2026 audit: n={len(games)}, conditional moneyline "
            f"Brier raw={raw_brier:.4f}, calibrated={new_brier:.4f}, "
            f"market={market_brier:.4f}; total MAE old={old_mae:.3f}, new={new_mae:.3f}"
        )
        self.assertLess(new_brier, raw_brier)
        self.assertLess(new_mae, old_mae)


if __name__ == "__main__":
    unittest.main()
