import numpy as np
import pandas as pd


QB_METRICS = [
    "epa_per_dropback",
    "cpoe",
    "yards_per_dropback",
    "int_rate",
    "sack_rate",
    "qb_hit_rate",
    "td_rate",
]


def _safe_mean(series):
    x = pd.to_numeric(series, errors="coerce")
    return float(x.mean()) if x.notna().any() else np.nan


def _safe_rate(series):
    x = pd.to_numeric(series, errors="coerce").fillna(0)
    return float(x.mean()) if len(x) else np.nan


def identify_starters(df):
    """
    Identify the starting QB for each team-game using the
    first legitimate QB dropback.

    This is pregame-safe for historical modeling because it
    identifies who actually started, rather than selecting the
    QB who eventually accumulated the most game usage.
    """

    q = df[
        (df["qb_dropback"] == 1)
        & df["passer_player_id"].notna()
        & df["posteam"].notna()
    ].copy()

    if "qb_kneel" in q.columns:
        q = q[q["qb_kneel"].fillna(0) != 1]

    if "qb_spike" in q.columns:
        q = q[q["qb_spike"].fillna(0) != 1]

    sort_cols = ["game_id"]

    if "play_id" in q.columns:
        sort_cols.append("play_id")

    q = q.sort_values(sort_cols)

    starters = (
        q.groupby(
            ["game_id", "posteam"],
            as_index=False
        )
        .first()
    )

    return starters[
        [
            "game_id",
            "season",
            "week",
            "posteam",
            "passer_player_id",
            "passer_player_name",
        ]
    ].rename(
        columns={
            "passer_player_id": "starter_qb_id",
            "passer_player_name": "starter_qb_name",
        }
    )


def qb_stat_line(df):
    """
    Calculate QB statistics from a supplied set of plays.
    The caller controls which historical plays are visible.
    """

    if df.empty:
        return {
            "epa_per_dropback": np.nan,
            "cpoe": np.nan,
            "yards_per_dropback": np.nan,
            "int_rate": np.nan,
            "sack_rate": np.nan,
            "qb_hit_rate": np.nan,
            "td_rate": np.nan,
            "dropbacks": 0.0,
        }

    q = df[
        (df["qb_dropback"] == 1)
        & df["passer_player_id"].notna()
    ].copy()

    if "qb_kneel" in q.columns:
        q = q[q["qb_kneel"].fillna(0) != 1]

    if "qb_spike" in q.columns:
        q = q[q["qb_spike"].fillna(0) != 1]

    n = len(q)

    if n == 0:
        return {
            "epa_per_dropback": np.nan,
            "cpoe": np.nan,
            "yards_per_dropback": np.nan,
            "int_rate": np.nan,
            "sack_rate": np.nan,
            "qb_hit_rate": np.nan,
            "td_rate": np.nan,
            "dropbacks": 0.0,
        }

    passing_yards = pd.to_numeric(
        q["passing_yards"],
        errors="coerce"
    ).fillna(0)

    interceptions = pd.to_numeric(
        q["interception"],
        errors="coerce"
    ).fillna(0)

    sacks = pd.to_numeric(
        q["sack"],
        errors="coerce"
    ).fillna(0)

    qb_hits = pd.to_numeric(
        q["qb_hit"],
        errors="coerce"
    ).fillna(0)

    touchdowns = pd.to_numeric(
        q["touchdown"],
        errors="coerce"
    ).fillna(0)

    return {
        "epa_per_dropback": _safe_mean(q["epa"]),
        "cpoe": _safe_mean(q["cpoe"]),
        "yards_per_dropback": float(passing_yards.sum() / n),
        "int_rate": float(interceptions.sum() / n),
        "sack_rate": float(sacks.sum() / n),
        "qb_hit_rate": float(qb_hits.sum() / n),
        "td_rate": float(touchdowns.sum() / n),
        "dropbacks": float(n),
    }


def league_qb_baseline(df):
    """
    League baseline used for small-sample shrinkage.
    """

    return qb_stat_line(df)


def shrink_stats(
    player_stats,
    baseline,
    prior_strength=100.0,
):
    """
    Bayesian-style sample shrinkage.

    Example:
      QB with 20 dropbacks -> heavily shrunk
      QB with 500 dropbacks -> mostly his own performance
    """

    n = float(player_stats.get("dropbacks", 0) or 0)

    weight = n / (n + prior_strength)

    out = {}

    for metric in QB_METRICS:

        player = player_stats.get(metric, np.nan)
        base = baseline.get(metric, np.nan)

        if pd.isna(player):
            value = base
        elif pd.isna(base):
            value = player
        else:
            value = (
                weight * float(player)
                + (1.0 - weight) * float(base)
            )

        out[metric] = value

    out["dropbacks"] = n
    out["sample_weight"] = weight

    return out


def build_qb_features_for_game(
    current_df,
    prior_df,
    season,
    week,
    home_team,
    away_team,
    starter_map,
    prior_strength=100.0,
):
    """
    Build leakage-safe QB features for one historical game.

    Current-season QB statistics:
        weeks strictly BEFORE target week

    Prior-season QB statistics:
        full prior season

    Starter identity:
        derived from target game's first legitimate dropback

    The starter identity is used only to determine which QB
    was expected to start that historical game. Target-game
    performance is NEVER included in the feature values.
    """

    game_key_candidates = starter_map[
        (starter_map["season"] == season)
        & (starter_map["week"] == week)
    ]

    features = {}

    league_history = pd.concat(
        [
            prior_df,
            current_df[current_df["week"] < week],
        ],
        ignore_index=True,
    )

    baseline = league_qb_baseline(league_history)

    def team_qb(team, prefix):

        row = game_key_candidates[
            game_key_candidates["posteam"] == team
        ]

        if row.empty:
            qb_id = None
            qb_name = None
        else:
            qb_id = row.iloc[0]["starter_qb_id"]
            qb_name = row.iloc[0]["starter_qb_name"]

        current_history = current_df[
            (current_df["week"] < week)
            & (
                current_df["passer_player_id"]
                == qb_id
            )
        ]

        prior_history = prior_df[
            prior_df["passer_player_id"] == qb_id
        ]

        history = pd.concat(
            [prior_history, current_history],
            ignore_index=True,
        )

        raw = qb_stat_line(history)

        shrunk = shrink_stats(
            raw,
            baseline,
            prior_strength=prior_strength,
        )

        for metric in QB_METRICS:
            features[
                f"{prefix}_qb_{metric}"
            ] = shrunk[metric]

        features[
            f"{prefix}_qb_dropbacks"
        ] = np.log1p(shrunk["dropbacks"])

        features[
            f"{prefix}_qb_sample_weight"
        ] = shrunk["sample_weight"]

        features[
            f"{prefix}_qb_has_history"
        ] = float(shrunk["dropbacks"] > 0)

        return qb_id, qb_name, shrunk

    home_id, home_name, home_stats = team_qb(
        home_team,
        "home",
    )

    away_id, away_name, away_stats = team_qb(
        away_team,
        "away",
    )

    for metric in QB_METRICS:
        h = features[f"home_qb_{metric}"]
        a = features[f"away_qb_{metric}"]

        if pd.isna(h) or pd.isna(a):
            features[f"diff_qb_{metric}"] = 0.0
        else:
            features[f"diff_qb_{metric}"] = float(h - a)

    features["diff_qb_sample_weight"] = float(
        features["home_qb_sample_weight"]
        - features["away_qb_sample_weight"]
    )

    metadata = {
        "home_qb_id": home_id,
        "home_qb_name": home_name,
        "away_qb_id": away_id,
        "away_qb_name": away_name,
    }

    return features, metadata
