import os
import argparse
import datetime as dt
import warnings

import numpy as np
import pandas as pd

from sklearn.ensemble import ExtraTreesRegressor
from sklearn.impute import SimpleImputer
from supabase import create_client

from src.espn import scoreboard, parse_games, odds
from src.features import load_pbp
from src.matchup import build_matchup_features
from src.training import build_pregame_metrics
from src.qb_features import (
    identify_starters,
    qb_stat_line,
    league_qb_baseline,
    shrink_stats,
    QB_METRICS,
)
from src.injuries import build_game_injury_features
from src.game_context import build_game_context_features
from src.production_model import (
    run_production_game,
    MODEL_VERSION,
    SIMULATIONS,
)


TRAINING_DATA = "python/data/training_2022_2025.parquet"
FOOTBALL_WEIGHT = 0.10
TOP_FEATURES = 100

# ESPN and nflverse use different abbreviations for a few teams.
# Keep ESPN codes for display/database; use these aliases only for
# nflverse-derived football and QB features.
NFLVERSE_TEAM_MAP = {
    "WSH": "WAS",
    "LAR": "LA",
}


def nflverse_team(team: str) -> str:
    return NFLVERSE_TEAM_MAP.get(team, team)

warnings.filterwarnings(
    "ignore",
    message="DataFrame is highly fragmented",
)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def create_db():
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SECRET_KEY"],
    )


def log_health(db, service, status, message, dry_run):
    if dry_run:
        return

    try:
        db.table("system_health").insert({
            "service": service,
            "status": status,
            "message": str(message)[:500],
        }).execute()
    except Exception as e:
        print(f"WARNING: Could not write system_health: {e}")


def get_market(event_id):
    """
    ESPN odds adapter.

    ESPN spread is expressed from the HOME team's conventional
    sportsbook perspective:
        -5.5 = home favored by 5.5

    Our internal convention:
        +5.5 = expected HOME margin of +5.5

    Therefore:
        internal market_margin = -ESPN spread
    """

    try:
        data = odds(event_id)
        items = data.get("items") or []

        if not items:
            return None, "No sportsbook odds returned"

        x = items[0]

        espn_spread = x.get("spread")
        total = x.get("overUnder")

        if espn_spread is None:
            return None, "Missing spread"

        if total is None:
            return None, "Missing total"

        market = {
            "provider":
                x.get("provider", {}).get("name")
                or "Unknown",

            # Preserve original source value.
            "spread":
                float(espn_spread),

            # Normalized modeling convention.
            "market_margin":
                -float(espn_spread),

            "total":
                float(total),

            "home_ml":
                (x.get("homeTeamOdds") or {})
                .get("moneyLine"),

            "away_ml":
                (x.get("awayTeamOdds") or {})
                .get("moneyLine"),

            "captured_at":
                utc_now(),
        }

        return market, None

    except Exception as e:
        return None, f"ESPN odds error: {e}"


def prediction_exists(db, season, week, event_id):
    response = (
        db.table("predictions")
        .select("id,event_id,locked_at")
        .eq("season", season)
        .eq("week", week)
        .eq("event_id", event_id)
        .limit(1)
        .execute()
    )

    return bool(response.data)


def latest_starter_map(current_df, target_week):
    """
    Production-safe QB starter estimate.

    Uses each team's most recent observed starting QB BEFORE
    the target week.

    This avoids using any target-game information.
    """

    before = current_df[
        current_df["week"] < target_week
    ].copy()

    starters = identify_starters(before)

    if starters.empty:
        return {}

    starters = starters.sort_values(
        ["week", "game_id"]
    )

    latest = (
        starters.groupby("posteam", as_index=False)
        .tail(1)
    )

    return {
        row["posteam"]: {
            "qb_id": row["starter_qb_id"],
            "qb_name": row["starter_qb_name"],
        }
        for _, row in latest.iterrows()
    }


def production_qb_features(
    current_df,
    prior_df,
    week,
    home_team,
    away_team,
    starter_lookup,
):
    """
    Build the same 28 QB feature fields used in validation,
    but using a pregame starter estimate rather than target-game
    first-dropback information.
    """

    league_history = pd.concat(
        [
            prior_df,
            current_df[
                current_df["week"] < week
            ],
        ],
        ignore_index=True,
    )

    baseline = league_qb_baseline(
        league_history
    )

    features = {}
    metadata = {}

    def team_qb(team, prefix):

        starter = starter_lookup.get(team, {})

        qb_id = starter.get("qb_id")
        qb_name = starter.get("qb_name")

        current_history = current_df[
            (current_df["week"] < week)
            & (
                current_df["passer_player_id"]
                == qb_id
            )
        ]

        prior_history = prior_df[
            prior_df["passer_player_id"]
            == qb_id
        ]

        history = pd.concat(
            [prior_history, current_history],
            ignore_index=True,
        )

        raw = qb_stat_line(history)

        shrunk = shrink_stats(
            raw,
            baseline,
            prior_strength=100.0,
        )

        for metric in QB_METRICS:
            features[
                f"{prefix}_qb_{metric}"
            ] = shrunk[metric]

        features[
            f"{prefix}_qb_dropbacks"
        ] = np.log1p(
            shrunk["dropbacks"]
        )

        features[
            f"{prefix}_qb_sample_weight"
        ] = shrunk["sample_weight"]

        features[
            f"{prefix}_qb_has_history"
        ] = float(
            shrunk["dropbacks"] > 0
        )

        metadata[f"{prefix}_qb_id"] = qb_id
        metadata[f"{prefix}_qb_name"] = qb_name

    team_qb(home_team, "home")
    team_qb(away_team, "away")

    for metric in QB_METRICS:

        h = features[
            f"home_qb_{metric}"
        ]

        a = features[
            f"away_qb_{metric}"
        ]

        if pd.isna(h) or pd.isna(a):
            diff = 0.0
        else:
            diff = float(h - a)

        features[
            f"diff_qb_{metric}"
        ] = diff

    features["diff_qb_sample_weight"] = float(
        features["home_qb_sample_weight"]
        -
        features["away_qb_sample_weight"]
    )

    return features, metadata


def train_models():
    """
    Train the frozen v2 football/QB architecture.

    2022-2024 are used for feature ranking and model fitting.

    The 2025 season remains our confirmation season for v2.0.0.
    Current-season team/QB information is incorporated into
    production feature generation separately.
    """

    print("Loading historical training data...")

    df = pd.read_parquet(TRAINING_DATA)

    train = df[
        df["season"].between(2022, 2024)
    ].copy()

    id_cols = {
        "game_id",
        "season",
        "week",
        "home_team",
        "away_team",
    }

    target_cols = {
        "target_home_score",
        "target_away_score",
        "target_margin",
        "target_total",
        "target_margin_residual",
        "target_total_residual",
    }

    exclude = (
        id_cols
        | target_cols
        | {
            "market_spread",
            "market_total",
        }
    )

    football_cols = [
        c
        for c in train.columns
        if c not in exclude
        and pd.api.types.is_numeric_dtype(
            train[c]
        )
    ]

    rank_imputer = SimpleImputer(
        strategy="median"
    )

    X_rank = rank_imputer.fit_transform(
        train[football_cols].astype(float)
    )

    ranker = ExtraTreesRegressor(
        n_estimators=750,
        min_samples_leaf=8,
        max_features=0.5,
        random_state=100,
        n_jobs=-1,
    )

    ranker.fit(
        X_rank,
        train["target_margin"],
    )

    ranking = pd.Series(
        ranker.feature_importances_,
        index=football_cols,
    ).sort_values(
        ascending=False
    )

    top100 = list(
        ranking.head(TOP_FEATURES).index
    )

    # -----------------------------------------------------
    # Historical QB features for 2022-2024
    # -----------------------------------------------------

    print("Building historical QB training features...")

    pbp = {
        year: load_pbp(year)
        for year in range(2021, 2025)
    }

    from src.qb_features import (
        build_qb_features_for_game,
    )

    qb_rows = []

    for season in range(2022, 2025):

        print(f"  QB training season {season}")

        current = pbp[season]
        prior = pbp[season - 1]

        starter_map = identify_starters(
            current
        )

        season_games = train[
            train["season"] == season
        ]

        for _, row in season_games.iterrows():

            qbf, _ = build_qb_features_for_game(
                current_df=current,
                prior_df=prior,
                season=int(row["season"]),
                week=int(row["week"]),
                home_team=row["home_team"],
                away_team=row["away_team"],
                starter_map=starter_map,
                prior_strength=100.0,
            )

            qb_rows.append({
                "game_id": row["game_id"],
                **qbf,
            })

    qb = pd.DataFrame(qb_rows)

    train = train.merge(
        qb,
        on="game_id",
        how="left",
        validate="one_to_one",
    )

    qb_cols = [
        c
        for c in qb.columns
        if c != "game_id"
    ]

    feature_cols = (
        top100 + qb_cols
    )

    model_imputer = SimpleImputer(
        strategy="median"
    )

    X = model_imputer.fit_transform(
        train[feature_cols].astype(float)
    )

    margin_model = ExtraTreesRegressor(
        n_estimators=750,
        min_samples_leaf=8,
        max_features=0.5,
        random_state=42,
        n_jobs=-1,
    )

    total_model = ExtraTreesRegressor(
        n_estimators=750,
        min_samples_leaf=8,
        max_features=0.5,
        random_state=43,
        n_jobs=-1,
    )

    margin_model.fit(
        X,
        train["target_margin"],
    )

    total_model.fit(
        X,
        train["target_total"],
    )

    print(
        f"Model ready: "
        f"{len(top100)} football + "
        f"{len(qb_cols)} QB features"
    )

    return {
        "football_features": top100,
        "qb_features": qb_cols,
        "feature_cols": feature_cols,
        "imputer": model_imputer,
        "margin_model": margin_model,
        "total_model": total_model,
    }


def run(season, week, dry_run=False):

    started_at = utc_now()

    db = None

    if not dry_run:
        db = create_db()

    print("=" * 78)
    print("NFL QUANT MODEL")
    print(f"Season: {season}")
    print(f"Week: {week}")
    print(f"Model: {MODEL_VERSION}")
    print(f"Simulations/game: {SIMULATIONS:,}")
    print(
        "Mode:",
        "DRY RUN - ZERO DATABASE WRITES"
        if dry_run
        else "PRODUCTION",
    )
    print("=" * 78)

    # ---------------------------------------------------------
    # Schedule
    # ---------------------------------------------------------

    games = parse_games(
        scoreboard(season, week)
    )

    if not games:
        raise RuntimeError(
            f"No games for {season} Week {week}"
        )

    print(
        f"Schedule: {len(games)} games"
    )

    log_health(
        db,
        "ESPN Schedule",
        "OK",
        f"{len(games)} games retrieved",
        dry_run,
    )

    # ---------------------------------------------------------
    # Train frozen v2 architecture
    # ---------------------------------------------------------

    trained = train_models()

    # ---------------------------------------------------------
    # Current production feature state
    # ---------------------------------------------------------

    print("Loading production PBP...")

    prior_pbp = load_pbp(
        season - 1
    )

    current_pbp = load_pbp(
        season
    )

    team_metrics = build_pregame_metrics(
        current_df=current_pbp,
        prior_df=prior_pbp,
        week=week,
    )

    starter_lookup = latest_starter_map(
        current_pbp,
        week,
    )

    print()
    print("Production QB estimates:")

    for team in sorted(
        starter_lookup
    ):
        print(
            f"  {team:3} "
            f"{starter_lookup[team]['qb_name']}"
        )

    processed = 0
    skipped = 0
    errors = 0
    warnings_count = 0

    print()
    print("=" * 78)
    print("WEEKLY PREDICTIONS")
    print("=" * 78)

    # ---------------------------------------------------------
    # Games
    # ---------------------------------------------------------

    for game in games:

        event_id = game["event_id"]
        away = game["away"]["abbr"]
        home = game["home"]["abbr"]

        print()
        print("-" * 78)
        print(
            f"{away} @ {home} "
            f"[{event_id}]"
        )

        if not dry_run:

            try:
                if prediction_exists(
                    db,
                    season,
                    week,
                    event_id,
                ):
                    skipped += 1
                    warnings_count += 1

                    print(
                        "SKIPPED - prediction "
                        "already locked"
                    )

                    continue

            except Exception as e:
                errors += 1
                print(
                    "ERROR checking prediction:",
                    e,
                )
                continue

        # -----------------------------------------------------
        # Market
        # -----------------------------------------------------

        market, market_error = get_market(
            event_id
        )

        if market_error:
            errors += 1
            print(
                f"MARKET ERROR: {market_error}"
            )
            continue

        print(
            f"Market: {market['provider']} | "
            f"ESPN spread {market['spread']:+.1f} | "
            f"normalized home margin "
            f"{market['market_margin']:+.1f} | "
            f"total {market['total']:.1f}"
        )

        # -----------------------------------------------------
        # Football features
        # -----------------------------------------------------

        try:

            # Translate ESPN abbreviations to nflverse abbreviations
            # only for nflverse-derived model features.
            model_home = nflverse_team(home)
            model_away = nflverse_team(away)

            football = build_matchup_features(
                home_team=model_home,
                away_team=model_away,
                team_metrics=team_metrics,
                market=None,
            )

            qb_features, qb_meta = (
                production_qb_features(
                    current_df=current_pbp,
                    prior_df=prior_pbp,
                    week=week,
                    home_team=model_home,
                    away_team=model_away,
                    starter_lookup=starter_lookup,
                )
            )

            model_row = {
                **football,
                **qb_features,
            }

            vector = pd.DataFrame(
                [
                    {
                        col:
                            model_row.get(
                                col,
                                np.nan,
                            )
                        for col
                        in trained[
                            "feature_cols"
                        ]
                    }
                ]
            )

            X = trained[
                "imputer"
            ].transform(
                vector.astype(float)
            )

            football_margin = float(
                trained[
                    "margin_model"
                ].predict(X)[0]
            )

            football_total = float(
                trained[
                    "total_model"
                ].predict(X)[0]
            )

        except Exception as e:

            errors += 1

            print(
                f"FOOTBALL MODEL ERROR: {e}"
            )

            continue

        # -----------------------------------------------------
        # Injuries
        # -----------------------------------------------------

        try:

            injury_features, injury_players = (
                build_game_injury_features(
                    event_id=event_id,
                    home_team=home,
                    away_team=away,
                )
            )

        except Exception as e:

            warnings_count += 1

            injury_features = {}
            injury_players = []

            print(
                f"WARNING injury data: {e}"
            )

        # -----------------------------------------------------
        # Weather / rest
        # -----------------------------------------------------

        try:

            context_features = (
                build_game_context_features(
                    event_id=event_id,
                    season=season,
                    week=week,
                    kickoff=game["date"],
                    home_team=home,
                    away_team=away,
                )
            )

        except Exception as e:

            warnings_count += 1
            context_features = {}

            print(
                f"WARNING context data: {e}"
            )

        # -----------------------------------------------------
        # Production model + 50K simulations
        # -----------------------------------------------------

        try:

            result = run_production_game(
                market_margin=
                    market["market_margin"],

                market_total=
                    market["total"],

                home_ml=
                    market["home_ml"],

                away_ml=
                    market["away_ml"],

                football_margin=
                    football_margin,

                football_total=
                    football_total,

                injury_features=
                    injury_features,

                context_features=
                    context_features,

                football_weight=
                    FOOTBALL_WEIGHT,

                simulations=
                    SIMULATIONS,

                seed=
                    int(event_id)
                    % 2147483647,
            )

        except Exception as e:

            errors += 1

            print(
                f"PRODUCTION MODEL ERROR: {e}"
            )

            continue

        # Add useful audit information.
        result["qb"] = qb_meta
        result["injuries"] = {
            "features":
                injury_features,
            "players":
                injury_players,
        }
        result["context"] = (
            context_features
        )

        # -----------------------------------------------------
        # Display
        # -----------------------------------------------------

        print(
            f"QB: "
            f"{qb_meta.get('away_qb_name')} "
            f"vs "
            f"{qb_meta.get('home_qb_name')}"
        )

        print(
            f"Football model: "
            f"margin {football_margin:+.2f} | "
            f"total {football_total:.2f}"
        )

        print(
            f"Adjustments: "
            f"injury "
            f"{result['injury_margin_adjustment']:+.2f} | "
            f"context "
            f"{result['context_margin_adjustment']:+.2f} | "
            f"weather total "
            f"{result['weather_total_adjustment']:+.2f}"
        )

        print(
            f"PREDICTION: "
            f"{away} "
            f"{result['pred_away']:.1f} - "
            f"{home} "
            f"{result['pred_home']:.1f}"
        )

        print(
            f"Probabilities: "
            f"{home} win "
            f"{result['home_win_prob']:.1%} | "
            f"{home} cover "
            f"{result['home_cover_prob']:.1%} | "
            f"Over "
            f"{result['over_prob']:.1%}"
        )

        # -----------------------------------------------------
        # Save only in production mode
        # -----------------------------------------------------

        if dry_run:

            processed += 1
            print(
                "DRY RUN - NOT SAVED"
            )

            continue

        timestamp = utc_now()

        row = {
            "season": season,
            "week": week,
            "event_id": event_id,
            "game": game,
            "market": market,
            "model": result,
            "model_version":
                MODEL_VERSION,
            "prediction_run_at":
                timestamp,
            "locked_at":
                timestamp,
        }

        try:

            db.table(
                "predictions"
            ).insert(
                row
            ).execute()

            processed += 1

            print(
                "SAVED + LOCKED"
            )

        except Exception as e:

            errors += 1

            print(
                f"DATABASE ERROR: {e}"
            )

    # ---------------------------------------------------------
    # Summary
    # ---------------------------------------------------------

    expected_games = len(games)

    if (
        errors == 0
        and processed + skipped
        == expected_games
    ):
        status = "OK"

    elif processed > 0:
        status = "WARNING"

    else:
        status = "ERROR"

    message = (
        f"{processed} processed, "
        f"{skipped} existing/locked, "
        f"{errors} errors, "
        f"{warnings_count} warnings "
        f"out of {expected_games} games"
    )

    if not dry_run:

        db.table(
            "pipeline_runs"
        ).insert({
            "run_type":
                "WEEKLY_MODEL",

            "season":
                season,

            "week":
                week,

            "started_at":
                started_at,

            "completed_at":
                utc_now(),

            "status":
                status,

            "message":
                message,

            "model_version":
                MODEL_VERSION,

            "games_expected":
                expected_games,

            "games_processed":
                processed,

            "errors":
                errors,

            "warnings":
                warnings_count,
        }).execute()

        log_health(
            db,
            "NFL Model",
            status,
            message,
            dry_run,
        )

    print()
    print("=" * 78)
    print(
        "DRY RUN COMPLETE"
        if dry_run
        else "RUN COMPLETE"
    )
    print(message)
    print("=" * 78)

    if errors:
        raise RuntimeError(
            message
        )


if __name__ == "__main__":

    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--season",
        type=int,
        required=True,
    )

    parser.add_argument(
        "--week",
        type=int,
        required=True,
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Run entire model without "
            "writing anything to Supabase."
        ),
    )

    args = parser.parse_args()

    run(
        args.season,
        args.week,
        dry_run=args.dry_run,
    )
