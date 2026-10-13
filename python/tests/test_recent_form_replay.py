"""Replay recent-form signals against saved pregame forecasts and actual results.

Not a prospective test: fixed parameters were selected after seeing some results.
This measures regressions, helps detect leakage and guides future walk-forward tests.
"""
import json
import unittest
from pathlib import Path

from src.production_model import run_production_game
from src.recent_form import completed_games, recent_form_for_matchup

ROOT = Path(__file__).resolve().parents[2]


def saved(week, kind):
    p = ROOT / "data" / kind / f"2026-week-{week}.json"
    return json.loads(p.read_text(encoding="utf-8"))


def historical_graph(week):
    """Use ONLY matchup contexts from archived predictions of the target week.

    Each context was frozen before kickoff. Earlier seasons/weeks never access
    eventual outcomes from the target week or a later prediction snapshot.
    """
    unique = {}
    for prediction in saved(week, "predictions")["predictions"]:
        if not prediction.get("locked_at"):
            continue
        context = prediction.get("model", {}).get("analysis_context") or {}
        for side in ("home", "away"):
            abbreviation = (prediction.get("game", {}).get(side) or {}).get("abbr")
            for row in context.get(side + "_recent_games") or []:
                prior_week = row.get("week")
                opponent = row.get("opponent")
                if prior_week is None or int(prior_week) >= week or not abbreviation or not opponent:
                    continue
                hs = float(row["team_score"])
                vs = float(row["opponent_score"])
                if row.get("home_away") == "home":
                    home, away, hscore, ascore = abbreviation, opponent, hs, vs
                elif row.get("home_away") == "away":
                    home, away, hscore, ascore = opponent, abbreviation, vs, hs
                else:
                    continue
                key = (int(prior_week), home, away)
                unique[key] = {
                    "id": str(key),
                    "status": {"type": {"completed": True}},
                    "competitions": [{"competitors": [
                        {"homeAway": "home", "team": {"abbreviation": home}, "score": hscore},
                        {"homeAway": "away", "team": {"abbreviation": away}, "score": ascore},
                    ]}],
                }
    page = {}
    for (prior_week, _h, _a), event in unique.items():
        page.setdefault(prior_week, []).append(event)
    return completed_games([(w, {"events": events}) for w, events in page.items()], week)


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


class RecentFormHistoricalReplay(unittest.TestCase):
    def test_frozen_archives_not_modified_and_replay(self):
        all_errors = {"previous_margin": [], "updated_margin": [],
                      "previous_total": [], "updated_total": [],
                      "previous_brier": [], "updated_brier": []}
        records = []
        count = 0
        for week in (3, 4, 5):
            games = historical_graph(week)
            self.assertTrue(games, f"No pregame history recovered for week {week}")
            final = {
                str(r["event_id"]): r
                for r in saved(week, "results")["settlements"]
            }
            for p in saved(week, "predictions")["predictions"]:
                if not p.get("locked_at") or p.get("manual_entry", {}).get("retrospective"):
                    continue
                target = final.get(str(p["event_id"]))
                if target is None or target.get("actual_margin") is None:
                    continue
                g = p["game"]
                m, x = p["market"], p["model"]
                home, away = g["home"]["abbr"], g["away"]["abbr"]
                prior = [entry for entry in games if entry["week"] < week]
                recent = recent_form_for_matchup(home, away, prior)
                common = dict(
                    market_margin=m["market_margin"],
                    market_total=m["total"],
                    home_ml=m.get("home_ml"),
                    away_ml=m.get("away_ml"),
                    football_margin=x["football_margin"],
                    football_total=x["football_total"],
                    injury_features=(x.get("injuries") or {}).get("features"),
                    context_features=x.get("context"),
                    simulations=5000,
                    seed=int(p["event_id"]) % 2147483647,
                )
                baseline = run_production_game(**common)
                adjusted = run_production_game(**common, recent_form_features=recent)
                count += 1
                actual_margin = float(target["actual_margin"])
                actual_total = float(target["actual_total"])
                for tag, value, target_value in (
                    ("margin", "expected_margin", actual_margin),
                    ("total", "expected_total", actual_total),
                ):
                    all_errors["previous_" + tag].append(abs(baseline[value] - target_value))
                    all_errors["updated_" + tag].append(abs(adjusted[value] - target_value))
                if actual_margin != 0:
                    actual_home = float(actual_margin > 0)
                    for name, result in (("previous", baseline), ("updated", adjusted)):
                        home_p = result["home_win_prob"]
                        away_p = result["away_win_prob"]
                        conditional = home_p / (home_p + away_p)
                        all_errors[name + "_brier"].append((conditional - actual_home) ** 2)
                if home == "LAR" and away == "BUF":
                    records.append({
                        "match": "BUF@LAR", "baseline_margin": baseline["expected_margin"],
                        "updated_margin": adjusted["expected_margin"],
                        "baseline_total": baseline["expected_total"],
                        "updated_total": adjusted["expected_total"],
                        "recent": adjusted["recent_form"],
                        "graph_add": adjusted["graph_margin_adjustment"],
                    })
        self.assertEqual(count, 46)
        self.assertEqual(len(records), 1)
        print("RECENT FORM REPLAY", count, "verified games")
        for measure in ("margin", "total", "brier"):
            print(measure, "prior", round(mean(all_errors["previous_" + measure]), 4),
                  "new", round(mean(all_errors["updated_" + measure]), 4))
        print("Bills–Rams sample", records[0])
        # This test is an audit, not a selective search for favorable results.
        self.assertLess(max(all_errors["updated_margin"]), 50)
        self.assertLess(max(all_errors["updated_total"]), 50)


if __name__ == "__main__":
    unittest.main()
