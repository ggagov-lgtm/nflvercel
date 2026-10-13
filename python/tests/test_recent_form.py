"""Leakage and numerical unit tests for last-five scoring and opponent graph."""
import unittest

from src.recent_form import (
    adjustment_from_form,
    completed_games,
    opponent_ratings,
    recent_form_for_matchup,
)


def event(event_id, week, home, away, hs, aws, completed=True):
    return {
        "id": str(event_id),
        "status": {"type": {"completed": completed}},
        "competitions": [{
            "competitors": [
                {"homeAway": "home", "team": {"abbreviation": home}, "score": str(hs)},
                {"homeAway": "away", "team": {"abbreviation": away}, "score": str(aws)},
            ]
        }],
    }


class RecentFormTests(unittest.TestCase):
    def test_only_completed_earlier_weeks_enter_the_model(self):
        past = event(1, 1, "A", "B", 31, 27)
        future = event(2, 5, "A", "C", 99, 0)
        upcoming = event(3, 2, "B", "C", 0, 0, completed=False)
        pages = [
            (1, {"events": [past, past]}),
            (2, {"events": [upcoming]}),
            (5, {"events": [future]}),
        ]
        games = completed_games(pages, target_week=5)
        self.assertEqual(len(games), 1)
        self.assertEqual(games[0]["home_score"], 31)
        self.assertEqual(recent_form_for_matchup("A", "C", games)["recent_margin"], None)

    def test_one_point_transitive_chain_is_not_a_big_edge(self):
        pages = [
            (1, {"events": [event(1, 1, "A", "B", 24, 23)]}),
            (2, {"events": [event(2, 2, "B", "C", 20, 19)]}),
        ]
        games = completed_games(pages, target_week=3)
        rating = opponent_ratings(games)
        self.assertLess(abs(rating["A"] - rating["C"]), 1.0)
        form = recent_form_for_matchup("A", "C", games)
        adjustments = adjustment_from_form(form, market_margin=0, market_total=46)
        self.assertLess(abs(adjustments["graph_margin_adjustment"]), 0.5)

    def test_large_margin_chain_rewards_strength_but_shrinks_blowouts(self):
        pages = [
            (1, {"events": [event(1, 1, "A", "B", 42, 14)]}),
            (2, {"events": [event(2, 2, "B", "C", 35, 7)]}),
        ]
        games = completed_games(pages, 3)
        rating = opponent_ratings(games)
        self.assertGreater(rating["A"], rating["C"])
        # Ratings do not blindly imply the sum of both blowout margins.
        self.assertLess(rating["A"] - rating["C"], 56)
        form = recent_form_for_matchup("A", "C", games)
        self.assertLessEqual(
            abs(adjustment_from_form(form, 0, 44)["graph_margin_adjustment"]), 0.75
        )

    def test_recent_scoring_weights_and_caps(self):
        pages = [
            (1, {"events": [event(1, 1, "A", "B", 40, 10), event(2, 1, "C", "D", 14, 27)]}),
            (2, {"events": [event(3, 2, "A", "C", 31, 14), event(4, 2, "B", "D", 7, 24)]}),
            (3, {"events": [event(5, 3, "A", "D", 36, 7), event(6, 3, "C", "B", 10, 33)]}),
        ]
        games = completed_games(pages, target_week=4)
        form = recent_form_for_matchup("A", "B", games)
        self.assertEqual(form["home_recent"]["games"], 3)
        self.assertEqual(form["home_recent"]["last3_scored"], (40 + 31 + 36) / 3)
        adj = adjustment_from_form(form, 0, 45)
        self.assertLessEqual(abs(adj["recent_margin_adjustment"]), 1.25)
        self.assertLessEqual(abs(adj["recent_total_adjustment"]), 2.0)
        self.assertLessEqual(abs(adj["graph_margin_adjustment"]), 0.75)

    def test_missing_history_is_neutral(self):
        f = recent_form_for_matchup("A", "B", [])
        vals = adjustment_from_form(f, 3.5, 45.5)
        self.assertEqual(set(vals.values()), {0.0})


if __name__ == "__main__":
    unittest.main()
