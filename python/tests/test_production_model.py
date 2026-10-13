"""Numerical regression tests for the production-only NFL prediction engine.

Run from repo root:
    PYTHONPATH=python python -m unittest discover -s python/tests -v
"""
import math
import unittest

from src.production_model import (
    MODEL_VERSION,
    TOTAL_FOOTBALL_WEIGHT,
    MARKET_MONEYLINE_WEIGHT,
    calibrate_moneyline_probabilities,
    moneyline_expected_profit,
    run_production_game,
)


class ProductionModelTests(unittest.TestCase):
    def test_model_version_and_conservative_weights(self):
        self.assertEqual(MODEL_VERSION, "v2.1.0")
        self.assertEqual(TOTAL_FOOTBALL_WEIGHT, 0.05)
        self.assertEqual(MARKET_MONEYLINE_WEIGHT, 0.75)

    def test_moneyline_calibration_preserves_regulation_tie_mass(self):
        result = {
            "home_win_prob": 0.70,
            "away_win_prob": 0.26,
            "tie_prob": 0.04,
        }
        new = calibrate_moneyline_probabilities(result, -150, +130)
        fair_home = (150 / 250) / (150 / 250 + 100 / 230)
        conditional_model = 0.70 / (0.70 + 0.26)
        conditional_new = conditional_model * 0.25 + fair_home * 0.75
        self.assertAlmostEqual(new["home_win_prob"], 0.96 * conditional_new)
        self.assertAlmostEqual(new["away_win_prob"], 0.96 * (1 - conditional_new))
        self.assertAlmostEqual(new["home_win_prob"] + new["away_win_prob"] + new["tie_prob"], 1.0)
        self.assertAlmostEqual(new["raw_home_win_prob"], 0.70)
        self.assertAlmostEqual(new["moneyline_market_weight"], 0.75)
        self.assertEqual(result["home_win_prob"], 0.70)  # don't mutate input

    def test_missing_moneyline_prices_do_not_invent_calibration(self):
        old = {"home_win_prob": 0.60, "away_win_prob": 0.36, "tie_prob": 0.04}
        new = calibrate_moneyline_probabilities(old, -160, None)
        self.assertEqual(new["home_win_prob"], old["home_win_prob"])
        self.assertEqual(new["away_win_prob"], old["away_win_prob"])
        self.assertEqual(new["moneyline_market_weight"], 0.0)

    def test_ev_uses_actual_price_and_no_missing_odds(self):
        self.assertAlmostEqual(moneyline_expected_profit(0.6, 0.4, -150), 0.0)
        self.assertAlmostEqual(moneyline_expected_profit(0.5, 0.5, +120), 1.0)
        self.assertAlmostEqual(moneyline_expected_profit(0.4, 0.6, -200), -4.0)
        self.assertIsNone(moneyline_expected_profit(0.9, 0.1, None))
        self.assertIsNone(moneyline_expected_profit(0.9, 0.1, 0))

    def test_run_production_preserves_market_anchored_football_margin(self):
        game = run_production_game(
            market_margin=3.0, market_total=44.5,
            home_ml=-145, away_ml=+125,
            football_margin=7.0, football_total=60.0,
            simulations=3000, seed=123,
        )
        self.assertEqual(game["model_version"], MODEL_VERSION)
        self.assertAlmostEqual(game["base_margin"], 3.4)
        self.assertAlmostEqual(game["base_total"], 45.275)
        self.assertAlmostEqual(game["expected_total"], 45.275)
        self.assertAlmostEqual(game["football_weight"], 0.10)
        self.assertAlmostEqual(game["total_football_weight"], 0.05)
        self.assertEqual(game["simulations"], 3000)
        self.assertAlmostEqual(
            game["home_win_prob"] + game["away_win_prob"] + game["tie_prob"], 1.0
        )
        self.assertTrue(math.isfinite(game["home_ml_expected_profit_10"]))
        self.assertTrue(math.isfinite(game["away_ml_expected_profit_10"]))
        self.assertIn(game["moneyline_value_side"], ("home", "away", None))


if __name__ == "__main__":
    unittest.main()
