import numpy as np
import pandas as pd


def _value(row, name):
    value = row.get(name, np.nan)
    try:
        return float(value)
    except (TypeError, ValueError):
        return np.nan


def build_matchup_features(
    home_team: str,
    away_team: str,
    team_metrics: pd.DataFrame,
    market: dict | None = None,
):
    """
    Build a pregame matchup feature vector.

    Creates:
      1. Home team statistical features
      2. Away team statistical features
      3. Home-minus-away differences
      4. Offense-vs-defense interaction features
      5. Market context

    No postgame information is used.
    """

    if home_team not in team_metrics.index:
        raise ValueError(f"Missing team metrics for {home_team}")

    if away_team not in team_metrics.index:
        raise ValueError(f"Missing team metrics for {away_team}")

    home = team_metrics.loc[home_team]
    away = team_metrics.loc[away_team]

    features = {}

    # ---------------------------------------------------------
    # Raw team features
    # ---------------------------------------------------------

    for col in team_metrics.columns:
        features[f"home_{col}"] = _value(home, col)
        features[f"away_{col}"] = _value(away, col)

    # ---------------------------------------------------------
    # Same-stat team differences
    # ---------------------------------------------------------

    for col in team_metrics.columns:

        hv = _value(home, col)
        av = _value(away, col)

        if np.isfinite(hv) and np.isfinite(av):
            features[f"diff_{col}"] = hv - av
        else:
            features[f"diff_{col}"] = np.nan

    # ---------------------------------------------------------
    # Offense vs opposing defense interactions
    # ---------------------------------------------------------

    interactions = {
        "epa": ("off_epa_per_play", "def_epa_allowed"),
        "success": ("off_success_rate", "def_success_allowed"),
        "yards": ("off_yards_per_play", "def_yards_allowed"),

        "pass_epa": ("off_pass_epa", "def_pass_epa_allowed"),
        "pass_success": (
            "off_pass_success",
            "def_pass_success_allowed",
        ),
        "pass_yards": (
            "off_pass_yards",
            "def_pass_yards_allowed",
        ),
        "cpoe": ("off_cpoe", "def_cpoe_allowed"),
        "air_yards": (
            "off_air_yards",
            "def_air_yards_allowed",
        ),
        "yac": ("off_yac", "def_yac_allowed"),

        "rush_epa": (
            "off_rush_epa",
            "def_rush_epa_allowed",
        ),
        "rush_success": (
            "off_rush_success",
            "def_rush_success_allowed",
        ),
        "rush_yards": (
            "off_rush_yards",
            "def_rush_yards_allowed",
        ),

        "explosive": (
            "off_explosive_rate",
            "def_explosive_allowed_rate",
        ),

        "third_down": (
            "off_third_down_rate",
            "def_third_down_allowed_rate",
        ),

        "fourth_down": (
            "off_fourth_down_rate",
            "def_fourth_down_allowed_rate",
        ),

        "redzone_epa": (
            "off_redzone_epa",
            "def_redzone_epa_allowed",
        ),

        "redzone_success": (
            "off_redzone_success",
            "def_redzone_success_allowed",
        ),

        "redzone_td": (
            "off_redzone_td_rate",
            "def_redzone_td_allowed_rate",
        ),

        "td_rate": (
            "off_td_rate",
            "def_td_allowed_rate",
        ),

        "pass_td": (
            "off_pass_td_rate",
            "def_pass_td_allowed_rate",
        ),

        "rush_td": (
            "off_rush_td_rate",
            "def_rush_td_allowed_rate",
        ),

        "first_down": (
            "off_first_down_rate",
            "def_first_down_allowed_rate",
        ),
    }

    for name, (off_col, def_col) in interactions.items():

        home_off = _value(home, off_col)
        away_def = _value(away, def_col)

        away_off = _value(away, off_col)
        home_def = _value(home, def_col)

        # Higher offense metric and weaker opposing defense
        # increase the matchup value.
        features[f"home_matchup_{name}"] = (
            home_off + away_def
            if np.isfinite(home_off) and np.isfinite(away_def)
            else np.nan
        )

        features[f"away_matchup_{name}"] = (
            away_off + home_def
            if np.isfinite(away_off) and np.isfinite(home_def)
            else np.nan
        )

        h = features[f"home_matchup_{name}"]
        a = features[f"away_matchup_{name}"]

        features[f"matchup_diff_{name}"] = (
            h - a
            if np.isfinite(h) and np.isfinite(a)
            else np.nan
        )

    # ---------------------------------------------------------
    # Pressure interactions
    # ---------------------------------------------------------

    features["home_pressure_matchup"] = (
        _value(home, "off_sack_rate")
        + _value(away, "def_sack_rate")
    )

    features["away_pressure_matchup"] = (
        _value(away, "off_sack_rate")
        + _value(home, "def_sack_rate")
    )

    features["home_qb_hit_matchup"] = (
        _value(home, "off_qb_hit_rate")
        + _value(away, "def_qb_hit_rate")
    )

    features["away_qb_hit_matchup"] = (
        _value(away, "off_qb_hit_rate")
        + _value(home, "def_qb_hit_rate")
    )

    # ---------------------------------------------------------
    # Turnover interactions
    # ---------------------------------------------------------

    features["home_interception_matchup"] = (
        _value(home, "off_interception_rate")
        + _value(away, "def_interception_rate")
    )

    features["away_interception_matchup"] = (
        _value(away, "off_interception_rate")
        + _value(home, "def_interception_rate")
    )

    features["home_fumble_matchup"] = (
        _value(home, "off_fumble_lost_rate")
        + _value(away, "def_fumble_recovery_rate")
    )

    features["away_fumble_matchup"] = (
        _value(away, "off_fumble_lost_rate")
        + _value(home, "def_fumble_recovery_rate")
    )

    # ---------------------------------------------------------
    # Home-field indicator
    # ---------------------------------------------------------

    features["home_field"] = 1.0

    # ---------------------------------------------------------
    # Sportsbook market — context, not the entire model
    # ---------------------------------------------------------

    if market:

        for key in [
            "spread",
            "total",
            "home_ml",
            "away_ml",
        ]:
            value = market.get(key)

            try:
                features[f"market_{key}"] = (
                    float(value)
                    if value is not None
                    else np.nan
                )
            except (TypeError, ValueError):
                features[f"market_{key}"] = np.nan

    return features


def feature_vector(features: dict):
    """
    Convert feature dictionary into deterministic numeric arrays.
    """

    names = sorted(features.keys())

    values = np.array(
        [features[name] for name in names],
        dtype=float,
    )

    return names, values
