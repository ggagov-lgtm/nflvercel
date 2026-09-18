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
from src.training import (
    build_pregame_metrics,
    build_current_season_training,
)
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

from src.settlement import settle_week


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


def recent_team_games(team, season, week, limit=3):
    """Return compact, strictly pre-target-week results for analyst context."""
    rows = []
    for w in range(max(1, week - 4), week):
        try:
            data = scoreboard(season, w)
        except Exception:
            continue
        for event in data.get("events", []):
            comps = event.get("competitions") or []
            if not comps:
                continue
            comp = comps[0]
            competitors = comp.get("competitors") or []
            mine = next((x for x in competitors if (x.get("team") or {}).get("abbreviation") == team), None)
            opp = next((x for x in competitors if x is not mine), None)
            if not mine or not opp:
                continue
            try:
                team_score = int(mine.get("score") or 0)
                opp_score = int(opp.get("score") or 0)
            except (TypeError, ValueError):
                continue
            rows.append({
                "week": w,
                "opponent": (opp.get("team") or {}).get("abbreviation"),
                "home_away": "home" if mine.get("homeAway") == "home" else "away",
                "team_score": team_score,
                "opponent_score": opp_score,
                "result": "W" if team_score > opp_score else "L" if team_score < opp_score else "T",
            })
    return rows[-limit:]


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


def train_models(target_season: int, target_week: int):
    """
    Train the frozen v2 football/QB architecture.

    2022-2024 are used for feature ranking and model fitting.

    The 2025 season remains our confirmation season for v2.0.0.
    Current-season team/QB information is incorporated into
    production feature generation separately.
    """

    print("Loading historical training data...")

    df = pd.read_parquet(TRAINING_DATA)

    # Frozen historical base through 2025.
    train = df[
        df["season"].between(2022, 2025)
    ].copy()

    # Add completed target-season games strictly before
    # the week we are predicting.
    if target_season >= 2026 and target_week > 1:
        print(
            f"Building incremental {target_season} "
            f"training data before Week {target_week}..."
        )

        incremental = build_current_season_training(
            season=target_season,
            target_week=target_week,
        )

        if len(incremental):
            train = pd.concat(
                [train, incremental],
                ignore_index=True,
                sort=False,
            )

            print(
                f"Added {len(incremental)} "
                f"{target_season} training games"
            )

    print(
        f"Production training rows: {len(train)}"
    )

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

    # -----------------------------------------------------
    # Frozen v2.0.0 feature selection
    #
    # The validated v2.0.0 Top-100 football features were
    # selected using 2022-2024 only, with 2025 held out for
    # confirmation. Keep that feature-selection population
    # frozen even though model-fitting observations expand
    # every week with completed current-season games.
    # -----------------------------------------------------

    ranking_train = df[
        df["season"].between(2022, 2024)
    ].copy()

    football_cols = [
        c
        for c in ranking_train.columns
        if c not in exclude
        and pd.api.types.is_numeric_dtype(
            ranking_train[c]
        )
    ]

    rank_imputer = SimpleImputer(
        strategy="median"
    )

    X_rank = rank_imputer.fit_transform(
        ranking_train[
            football_cols
        ].astype(float)
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
        ranking_train["target_margin"],
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

    qb_end_season = max(
        2025,
        target_season,
    )

    pbp = {
        year: load_pbp(year)
        for year in range(2021, qb_end_season + 1)
    }

    from src.qb_features import (
        build_qb_features_for_game,
    )

    qb_rows = []

    training_seasons = sorted(
        int(x)
        for x in train["season"].dropna().unique()
    )

    for season in training_seasons:

        print(f"  QB training season {season}")

        current = pbp[season]
        prior = pbp[season - 1]

        # identify_starters() is used only to identify the
        # starter for each historical game. QB statistics
        # themselves remain pregame/leakage-safe.
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

    training_max_season = int(
        train["season"].max()
    )

    training_max_week = int(
        train.loc[
            train["season"] == training_max_season,
            "week",
        ].max()
    )

    return {
        "football_features": top100,
        "qb_features": qb_cols,
        "feature_cols": feature_cols,
        "imputer": model_imputer,
        "margin_model": margin_model,
        "total_model": total_model,
        "training_rows": int(len(train)),
        "training_through_season": training_max_season,
        "training_through_week": training_max_week,
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
    # Settle previous week's locked predictions BEFORE training
    # ---------------------------------------------------------

    settlement_result = None

    if week > 1:

        previous_week = week - 1

        print()
        print(
            f"Checking settlement for "
            f"{season} Week {previous_week}..."
        )

        previous_games = parse_games(
            scoreboard(
                season,
                previous_week,
            )
        )

        # -----------------------------------------------------
        # Previous-week finality gate
        #
        # Training must never include a partially completed
        # prior week, even when no official predictions existed
        # for that week and therefore nothing needs settlement.
        # -----------------------------------------------------

        incomplete_previous_games = [
            game
            for game in previous_games
            if not game.get("completed", False)
        ]

        if not previous_games or incomplete_previous_games:

            incomplete_names = ", ".join(
                f"{game['away']['abbr']} @ "
                f"{game['home']['abbr']}"
                for game in incomplete_previous_games
            )

            message = (
                f"Cannot generate {season} Week {week}: "
                f"{season} Week {previous_week} is not "
                f"fully final. "
                f"{len(incomplete_previous_games)} of "
                f"{len(previous_games)} games remain "
                f"incomplete: {incomplete_names}"
            )

            print()
            print(message)

            log_health(
                db,
                "Previous Week Finality",
                "ERROR",
                message,
                dry_run,
            )

            raise RuntimeError(message)

        print(
            f"Previous-week finality: PASS "
            f"({len(previous_games)}/{len(previous_games)} final)"
        )

        settlement_result = settle_week(
            db=db,
            season=season,
            week=previous_week,
            games=previous_games,
            dry_run=dry_run,
        )

        settlement_status = (
            settlement_result.get("status")
        )

        print(
            f"Previous-week settlement status: "
            f"{settlement_status}"
        )

        # If predictions exist but one or more games are not final,
        # stop the pipeline. Never train/generate the next official
        # prediction set from an incompletely settled prior week.
        if settlement_status == "INCOMPLETE":
            raise RuntimeError(
                f"Cannot generate {season} Week {week}: "
                f"{season} Week {previous_week} "
                f"contains locked predictions that are "
                f"not fully final."
            )

    else:

        print()
        print(
            "Week 1: no previous regular-season "
            "week to settle."
        )

    # ---------------------------------------------------------
    # Train frozen v2 architecture
    # ---------------------------------------------------------

    trained = train_models(
        target_season=season,
        target_week=week,
    )

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

    # ---------------------------------------------------------
    # Production market preflight
    #
    # Official weekly predictions must be complete. Validate
    # every sportsbook market before writing any prediction.
    # Cache successful markets so ESPN is not called twice.
    # ---------------------------------------------------------

    market_cache = {}

    if not dry_run:

        print()
        print("=" * 78)
        print("MARKET PREFLIGHT")
        print("=" * 78)

        missing_markets = []

        for game in games:

            event_id = game["event_id"]
            away = game["away"]["abbr"]
            home = game["home"]["abbr"]

            market, market_error = get_market(
                event_id
            )

            if market_error:

                missing_markets.append({
                    "event_id": event_id,
                    "game": f"{away} @ {home}",
                    "error": market_error,
                })

                print(
                    f"FAIL {away} @ {home}: "
                    f"{market_error}"
                )

            else:

                market_cache[event_id] = market

                print(
                    f"OK   {away} @ {home}"
                )

        if missing_markets:

            details = "; ".join(
                f'{x["game"]}: {x["error"]}'
                for x in missing_markets
            )

            message = (
                f"Production market preflight failed: "
                f"{len(missing_markets)} of "
                f"{len(games)} games missing "
                f"complete sportsbook markets. "
                f"ZERO new predictions written. "
                f"{details}"
            )

            print()
            print(message)

            db.table(
                "pipeline_runs"
            ).insert({
                "run_type": "WEEKLY_MODEL",
                "season": season,
                "week": week,
                "started_at": started_at,
                "completed_at": utc_now(),
                "status": "ERROR",
                "message": message,
                "model_version": MODEL_VERSION,
                "games_expected": len(games),
                "games_processed": 0,
                "errors": len(missing_markets),
                "warnings": 0,
            }).execute()

            log_health(
                db,
                "NFL Model",
                "ERROR",
                message,
                dry_run,
            )

            raise RuntimeError(message)

        print()
        print(
            f"MARKET PREFLIGHT PASS: "
            f"{len(market_cache)}/{len(games)}"
        )

    processed = 0
    skipped = 0
    errors = 0
    warnings_count = 0
    pending_rows = []

    # ---------------------------------------------------------
    # Official-week prediction state preflight
    #
    # Production weeks are immutable complete sets:
    #
    #   0 existing   -> create the complete week
    #   all existing -> clean idempotent rerun
    #   partial      -> integrity error; never fill piecemeal
    # ---------------------------------------------------------

    if not dry_run:

        schedule_event_ids = {
            str(game["event_id"])
            for game in games
        }

        existing_response = (
            db.table("predictions")
            .select("event_id,locked_at")
            .eq("season", season)
            .eq("week", week)
            .execute()
        )

        existing_rows = (
            existing_response.data or []
        )

        existing_event_ids = {
            str(row["event_id"])
            for row in existing_rows
        }

        if existing_event_ids:

            if (
                len(existing_event_ids) == len(games)
                and existing_event_ids
                == schedule_event_ids
            ):

                skipped = len(games)

                message = (
                    f"{season} Week {week} already has "
                    f"a complete locked prediction set "
                    f"({skipped}/{len(games)} games). "
                    f"Idempotent rerun: no predictions "
                    f"were changed."
                )

                print()
                print(message)

                db.table(
                    "pipeline_runs"
                ).insert({
                    "run_type": "WEEKLY_MODEL",
                    "season": season,
                    "week": week,
                    "started_at": started_at,
                    "completed_at": utc_now(),
                    "status": "OK",
                    "message": message,
                    "model_version": MODEL_VERSION,
                    "games_expected": len(games),
                    "games_processed": 0,
                    "errors": 0,
                    "warnings": 0,
                }).execute()

                log_health(
                    db,
                    "NFL Model",
                    "OK",
                    message,
                    dry_run,
                )

                print()
                print("=" * 78)
                print("WEEK ALREADY COMPLETE - NO CHANGES")
                print("=" * 78)

                return

            message = (
                f"Prediction integrity error for "
                f"{season} Week {week}: database contains "
                f"{len(existing_event_ids)} prediction(s), "
                f"but the official schedule contains "
                f"{len(schedule_event_ids)} games. "
                f"Partial or mismatched prediction sets "
                f"cannot be extended automatically."
            )

            print()
            print(message)

            db.table(
                "pipeline_runs"
            ).insert({
                "run_type": "WEEKLY_MODEL",
                "season": season,
                "week": week,
                "started_at": started_at,
                "completed_at": utc_now(),
                "status": "ERROR",
                "message": message,
                "model_version": MODEL_VERSION,
                "games_expected": len(games),
                "games_processed": 0,
                "errors": 1,
                "warnings": 0,
            }).execute()

            log_health(
                db,
                "NFL Model",
                "ERROR",
                message,
                dry_run,
            )

            raise RuntimeError(message)

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

        # -----------------------------------------------------
        # Market
        # -----------------------------------------------------

        if dry_run:

            market, market_error = get_market(
                event_id
            )

            if market_error:
                warnings_count += 1
                print(
                    f"MARKET WARNING: {market_error}"
                )
                continue

        else:

            # Already validated during production preflight.
            market = market_cache[event_id]
            market_error = None

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
        # Narrative evidence is frozen with the prediction. It is
        # display/audit metadata only and does not alter model inputs.
        result["analysis_context"] = {
            "home_team": home,
            "away_team": away,
            "home_recent_games": recent_team_games(home, season, week),
            "away_recent_games": recent_team_games(away, season, week),
            "home_qb": qb_meta.get("home_qb_name"),
            "away_qb": qb_meta.get("away_qb_name"),
            "injuries": injury_players,
            "weather": {
                "indoor": bool(context_features.get("venue_indoor", 0)),
                "temperature": context_features.get("temperature"),
                "wind_gust": context_features.get("wind_gust"),
                "precipitation_probability": context_features.get("precipitation_probability"),
            },
            "rest": {
                "home_days": context_features.get("home_rest_days"),
                "away_days": context_features.get("away_rest_days"),
            },
        }

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

        # Record exactly what training information produced
        # this prediction. Stored inside model JSONB so historical
        # predictions remain fully auditable.
        result["training_rows"] = trained["training_rows"]
        result["training_through_season"] = (
            trained["training_through_season"]
        )
        result["training_through_week"] = (
            trained["training_through_week"]
        )
        result["training_cutoff"] = (
            f'{trained["training_through_season"]}-'
            f'W{trained["training_through_week"]}'
        )

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

        # Do not write individual predictions here.
        # Queue every successfully modeled game first.
        pending_rows.append(row)

        print(
            "MODELED - PENDING WEEKLY SAVE"
        )

    # ---------------------------------------------------------
    # Production completeness gate + weekly bulk save
    # ---------------------------------------------------------

    if not dry_run:

        expected_new = (
            len(games) - skipped
        )

        if (
            errors > 0
            or len(pending_rows) != expected_new
        ):

            message = (
                f"Prediction completeness gate failed: "
                f"{len(pending_rows)} of "
                f"{expected_new} required new predictions "
                f"modeled successfully. "
                f"ZERO queued predictions written."
            )

            print()
            print(message)

            db.table(
                "pipeline_runs"
            ).insert({
                "run_type": "WEEKLY_MODEL",
                "season": season,
                "week": week,
                "started_at": started_at,
                "completed_at": utc_now(),
                "status": "ERROR",
                "message": message,
                "model_version": MODEL_VERSION,
                "games_expected": len(games),
                "games_processed": 0,
                "errors": max(
                    errors,
                    expected_new - len(pending_rows),
                ),
                "warnings": warnings_count,
            }).execute()

            log_health(
                db,
                "NFL Model",
                "ERROR",
                message,
                dry_run,
            )

            raise RuntimeError(message)

        if pending_rows:

            try:

                response = db.rpc(
                    "save_weekly_predictions",
                    {
                        "p_season": season,
                        "p_week": week,
                        "p_expected_games": len(games),
                        "p_predictions": pending_rows,
                    },
                ).execute()

                processed = len(
                    pending_rows
                )

                print()
                print(
                    f"BULK SAVED + LOCKED: "
                    f"{processed} predictions"
                )

            except Exception as e:

                errors += 1

                message = (
                    f"Weekly prediction bulk save failed: "
                    f"{e}"
                )

                print()
                print(message)

                raise RuntimeError(
                    message
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
