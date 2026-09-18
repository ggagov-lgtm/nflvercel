import pandas as pd
import numpy as np

from src.features import load_pbp, build_team_metrics
from src.matchup import build_matchup_features


def get_games(df: pd.DataFrame) -> pd.DataFrame:
    """
    One row per completed regular-season game.
    """

    games = (
        df[
            [
                "game_id",
                "season",
                "week",
                "home_team",
                "away_team",
                "total_home_score",
                "total_away_score",
            ]
        ]
        .dropna(
            subset=[
                "game_id",
                "week",
                "home_team",
                "away_team",
            ]
        )
        .groupby(
            [
                "game_id",
                "season",
                "week",
                "home_team",
                "away_team",
            ],
            as_index=False,
        )
        .agg(
            home_score=("total_home_score", "max"),
            away_score=("total_away_score", "max"),
        )
    )

    games["home_score"] = pd.to_numeric(
        games["home_score"], errors="coerce"
    )

    games["away_score"] = pd.to_numeric(
        games["away_score"], errors="coerce"
    )

    games = games.dropna(
        subset=["home_score", "away_score"]
    )

    games["margin"] = (
        games["home_score"] - games["away_score"]
    )

    games["total"] = (
        games["home_score"] + games["away_score"]
    )

    return games.sort_values(
        ["season", "week", "game_id"]
    ).reset_index(drop=True)


def build_pregame_metrics(
    current_df: pd.DataFrame,
    prior_df: pd.DataFrame | None,
    week: int,
):
    """
    Construct team metrics using ONLY information available
    before the requested week's games.

    Current-season games:
        week < target week

    Prior season:
        full regular season

    Early season receives stronger prior-season shrinkage.
    """

    current_before = current_df[
        current_df["week"] < week
    ].copy()

    if len(current_before):
        current_metrics = build_team_metrics(
            current_before
        )
    else:
        current_metrics = pd.DataFrame()

    if prior_df is not None and len(prior_df):
        prior_metrics = build_team_metrics(prior_df)
    else:
        prior_metrics = pd.DataFrame()

    # Week-based prior shrinkage.
    #
    # Week 1 = previous season only.
    # Current season progressively receives more weight.
    current_weight = min(
        0.80,
        max(0.0, (week - 1) / 8.0),
    )

    prior_weight = 1.0 - current_weight

    teams = sorted(
        set(prior_metrics.index)
        | set(current_metrics.index)
    )

    columns = sorted(
        set(prior_metrics.columns)
        | set(current_metrics.columns)
    )

    result = pd.DataFrame(
        index=teams,
        columns=columns,
        dtype=float,
    )

    for team in teams:
        for col in columns:

            p = (
                prior_metrics.at[team, col]
                if team in prior_metrics.index
                and col in prior_metrics.columns
                else np.nan
            )

            c = (
                current_metrics.at[team, col]
                if team in current_metrics.index
                and col in current_metrics.columns
                else np.nan
            )

            if pd.notna(p) and pd.notna(c):
                result.at[team, col] = (
                    prior_weight * float(p)
                    + current_weight * float(c)
                )

            elif pd.notna(c):
                result.at[team, col] = float(c)

            elif pd.notna(p):
                result.at[team, col] = float(p)

    return result


def build_training_dataset(
    start_season=2022,
    end_season=2025,
):
    """
    Build leakage-safe historical NFL training rows.

    Each game's feature vector is generated using ONLY
    games that occurred before that game's week.
    """

    seasons = {}

    # Need previous season for the first requested season.
    for season in range(
        start_season - 1,
        end_season + 1,
    ):
        print(f"Loading {season}...")
        seasons[season] = load_pbp(season)

    rows = []

    for season in range(
        start_season,
        end_season + 1,
    ):

        print(f"\nBuilding season {season}...")

        current = seasons[season]
        prior = seasons.get(season - 1)

        games = get_games(current)

        for week in sorted(games["week"].unique()):

            week = int(week)

            metrics = build_pregame_metrics(
                current_df=current,
                prior_df=prior,
                week=week,
            )

            week_games = games[
                games["week"] == week
            ]

            print(
                f"  Week {week}: "
                f"{len(week_games)} games"
            )

            for _, game in week_games.iterrows():

                home = game["home_team"]
                away = game["away_team"]

                if (
                    home not in metrics.index
                    or away not in metrics.index
                ):
                    print(
                        "    SKIP:",
                        away,
                        "@",
                        home,
                        "missing metrics",
                    )
                    continue

                features = build_matchup_features(
                    home_team=home,
                    away_team=away,
                    team_metrics=metrics,
                    market=None,
                )

                row = {
                    "game_id": game["game_id"],
                    "season": int(game["season"]),
                    "week": week,
                    "home_team": home,
                    "away_team": away,
                    "target_home_score": float(
                        game["home_score"]
                    ),
                    "target_away_score": float(
                        game["away_score"]
                    ),
                    "target_margin": float(
                        game["margin"]
                    ),
                    "target_total": float(
                        game["total"]
                    ),
                }

                row.update(features)
                rows.append(row)

    return pd.DataFrame(rows)


def build_current_season_training(
    season: int,
    target_week: int,
):
    """
    Build leakage-safe training rows for completed games
    in the current season strictly before target_week.

    Example:
        season=2026, target_week=2
        -> returns Week 1 training rows only.
    """

    if target_week <= 1:
        return pd.DataFrame()

    current = load_pbp(season)
    prior = load_pbp(season - 1)

    games = get_games(current)

    games = games[
        games["week"] < target_week
    ].copy()

    rows = []

    for week in sorted(games["week"].unique()):

        week = int(week)

        metrics = build_pregame_metrics(
            current_df=current,
            prior_df=prior,
            week=week,
        )

        week_games = games[
            games["week"] == week
        ]

        print(
            f"  Current-season training "
            f"{season} Week {week}: "
            f"{len(week_games)} games"
        )

        for _, game in week_games.iterrows():

            home = game["home_team"]
            away = game["away_team"]

            if (
                home not in metrics.index
                or away not in metrics.index
            ):
                print(
                    "    SKIP:",
                    away,
                    "@",
                    home,
                    "missing metrics",
                )
                continue

            features = build_matchup_features(
                home_team=home,
                away_team=away,
                team_metrics=metrics,
                market=None,
            )

            row = {
                "game_id": game["game_id"],
                "season": int(game["season"]),
                "week": week,
                "home_team": home,
                "away_team": away,
                "target_home_score": float(
                    game["home_score"]
                ),
                "target_away_score": float(
                    game["away_score"]
                ),
                "target_margin": float(
                    game["margin"]
                ),
                "target_total": float(
                    game["total"]
                ),
            }

            row.update(features)
            rows.append(row)

    return pd.DataFrame(rows)
