"""
NFL prediction settlement.

Responsibilities:
- Read final NFL scores from ESPN.
- Settle locked ML, spread and total predictions.
- Determine the model's highest-confidence pick.
- Calculate score, margin and total errors.
- Support dry-run validation before database writes.

IMPORTANT:
Settlement always uses the sportsbook market stored with the
original locked prediction. It never uses current/post-game odds.
"""

import math


def _number(value):
    """Return float or None."""
    try:
        if value is None:
            return None
        value = float(value)
        if math.isnan(value):
            return None
        return value
    except (TypeError, ValueError):
        return None


def parse_final_games(games):
    """
    Convert parsed ESPN games into final-result records.

    Only games whose status indicates completion are returned.
    """

    results = []

    for game in games:

        status = (
            game.get("status")
            or game.get("status_name")
            or ""
        )

        status_text = str(status).lower()

        completed = (
            game.get("completed") is True
            or "final" in status_text
            or "post" in status_text
        )

        if not completed:
            continue

        home = game.get("home") or {}
        away = game.get("away") or {}

        home_score = _number(home.get("score"))
        away_score = _number(away.get("score"))

        if home_score is None or away_score is None:
            continue

        results.append({
            "event_id": str(game["event_id"]),
            "home_score": int(home_score),
            "away_score": int(away_score),
            "status": "final",
        })

    return results


def settle_prediction(prediction, result):
    """
    Settle one locked prediction.

    Internal convention:
        actual_margin = home_score - away_score
        market_margin = expected home margin

    Spread:
        actual_margin > market_margin -> HOME covers
        actual_margin < market_margin -> AWAY covers

    Total:
        actual_total > market_total -> OVER
        actual_total < market_total -> UNDER
    """

    market = prediction.get("market") or {}
    model = prediction.get("model") or {}

    home_score = float(result["home_score"])
    away_score = float(result["away_score"])

    actual_margin = home_score - away_score
    actual_total = home_score + away_score

    market_margin = _number(
        market.get("market_margin")
    )

    market_total = _number(
        market.get("total")
    )

    pred_home = _number(
        model.get("pred_home")
    )

    pred_away = _number(
        model.get("pred_away")
    )

    home_win_prob = _number(
        model.get("home_win_prob")
    )

    home_cover_prob = _number(
        model.get("home_cover_prob")
    )

    over_prob = _number(
        model.get("over_prob")
    )

    # ---------------------------------------------------------
    # Moneyline
    # ---------------------------------------------------------

    if home_score > away_score:
        actual_winner = "HOME"
    elif away_score > home_score:
        actual_winner = "AWAY"
    else:
        actual_winner = "PUSH"

    if home_win_prob is None:
        ml_result = None
        ml_confidence = None
    else:
        model_ml_side = (
            "HOME"
            if home_win_prob >= 0.5
            else "AWAY"
        )

        ml_confidence = max(
            home_win_prob,
            1.0 - home_win_prob,
        )

        if actual_winner == "PUSH":
            ml_result = "PUSH"
        else:
            ml_result = (
                "WIN"
                if model_ml_side == actual_winner
                else "LOSS"
            )

    # ---------------------------------------------------------
    # Spread
    # ---------------------------------------------------------

    if (
        market_margin is None
        or home_cover_prob is None
    ):
        spread_result = None
        spread_confidence = None

    else:

        spread_delta = (
            actual_margin - market_margin
        )

        if abs(spread_delta) < 1e-9:
            actual_spread_side = "PUSH"
        elif spread_delta > 0:
            actual_spread_side = "HOME"
        else:
            actual_spread_side = "AWAY"

        model_spread_side = (
            "HOME"
            if home_cover_prob >= 0.5
            else "AWAY"
        )

        spread_confidence = max(
            home_cover_prob,
            1.0 - home_cover_prob,
        )

        if actual_spread_side == "PUSH":
            spread_result = "PUSH"
        else:
            spread_result = (
                "WIN"
                if (
                    model_spread_side
                    == actual_spread_side
                )
                else "LOSS"
            )

    # ---------------------------------------------------------
    # Total
    # ---------------------------------------------------------

    if (
        market_total is None
        or over_prob is None
    ):
        total_result = None
        total_confidence = None

    else:

        total_delta = (
            actual_total - market_total
        )

        if abs(total_delta) < 1e-9:
            actual_total_side = "PUSH"
        elif total_delta > 0:
            actual_total_side = "OVER"
        else:
            actual_total_side = "UNDER"

        model_total_side = (
            "OVER"
            if over_prob >= 0.5
            else "UNDER"
        )

        total_confidence = max(
            over_prob,
            1.0 - over_prob,
        )

        if actual_total_side == "PUSH":
            total_result = "PUSH"
        else:
            total_result = (
                "WIN"
                if (
                    model_total_side
                    == actual_total_side
                )
                else "LOSS"
            )

    # ---------------------------------------------------------
    # Highest-confidence pick
    # ---------------------------------------------------------

    candidates = []

    if ml_confidence is not None:
        candidates.append(
            ("ML", ml_confidence, ml_result)
        )

    if spread_confidence is not None:
        candidates.append(
            (
                "SPREAD",
                spread_confidence,
                spread_result,
            )
        )

    if total_confidence is not None:
        candidates.append(
            (
                "TOTAL",
                total_confidence,
                total_result,
            )
        )

    if candidates:
        top_pick = max(
            candidates,
            key=lambda x: x[1],
        )

        top_pick_type = top_pick[0]
        top_pick_confidence = top_pick[1]
        top_pick_result = top_pick[2]

    else:
        top_pick_type = None
        top_pick_confidence = None
        top_pick_result = None

    # ---------------------------------------------------------
    # Prediction errors
    # ---------------------------------------------------------

    if pred_home is not None and pred_away is not None:

        predicted_margin = (
            pred_home - pred_away
        )

        predicted_total = (
            pred_home + pred_away
        )

        home_score_error = abs(
            pred_home - home_score
        )

        away_score_error = abs(
            pred_away - away_score
        )

        score_mae = (
            home_score_error
            + away_score_error
        ) / 2.0

        margin_error = abs(
            predicted_margin
            - actual_margin
        )

        total_error = abs(
            predicted_total
            - actual_total
        )

    else:

        predicted_margin = None
        predicted_total = None
        score_mae = None
        margin_error = None
        total_error = None

    return {
        "prediction_id":
            prediction.get("id"),

        "event_id":
            prediction.get("event_id"),

        "ml_result":
            ml_result,

        "spread_result":
            spread_result,

        "total_result":
            total_result,

        "top_pick_result":
            top_pick_result,

        "top_pick_type":
            top_pick_type,

        "top_pick_confidence":
            top_pick_confidence,

        "actual_home_score":
            int(home_score),

        "actual_away_score":
            int(away_score),

        "actual_margin":
            actual_margin,

        "actual_total":
            actual_total,

        "predicted_margin":
            predicted_margin,

        "predicted_total":
            predicted_total,

        "score_mae":
            score_mae,

        "margin_error":
            margin_error,

        "total_error":
            total_error,
    }


def summarize_settlements(settlements):
    """Calculate weekly aggregate performance."""

    def count(field, value):
        return sum(
            1
            for x in settlements
            if x.get(field) == value
        )

    def accuracy(field):
        wins = count(field, "WIN")
        losses = count(field, "LOSS")

        decisions = wins + losses

        if decisions == 0:
            return None

        return wins / decisions

    def mean(field):
        values = [
            float(x[field])
            for x in settlements
            if x.get(field) is not None
        ]

        if not values:
            return None

        return sum(values) / len(values)

    return {
        "games": len(settlements),

        "ml_wins":
            count("ml_result", "WIN"),

        "ml_losses":
            count("ml_result", "LOSS"),

        "spread_wins":
            count("spread_result", "WIN"),

        "spread_losses":
            count("spread_result", "LOSS"),

        "spread_pushes":
            count("spread_result", "PUSH"),

        "total_wins":
            count("total_result", "WIN"),

        "total_losses":
            count("total_result", "LOSS"),

        "total_pushes":
            count("total_result", "PUSH"),

        "top_pick_wins":
            count("top_pick_result", "WIN"),

        "top_pick_losses":
            count("top_pick_result", "LOSS"),

        "top_pick_pushes":
            count("top_pick_result", "PUSH"),

        "ml_accuracy":
            accuracy("ml_result"),

        "spread_accuracy":
            accuracy("spread_result"),

        "total_accuracy":
            accuracy("total_result"),

        "top_pick_accuracy":
            accuracy("top_pick_result"),

        "score_mae":
            mean("score_mae"),

        "margin_mae":
            mean("margin_error"),

        "total_mae":
            mean("total_error"),
    }


def settle_week(
    db,
    season,
    week,
    games,
    dry_run=False,
):
    """
    Settle one week of locked predictions.

    Safe/idempotent behavior:
    - If no locked predictions exist, return without error.
    - Require every predicted game to be FINAL.
    - Never use post-game sportsbook odds.
    - Upsert game results and settlements.
    - Upsert weekly performance.
    """

    print()
    print("=" * 78)
    print(f"SETTLEMENT — {season} WEEK {week}")
    print("=" * 78)

    # ---------------------------------------------------------
    # Load the original locked predictions
    # ---------------------------------------------------------

    predictions = (
        db.table("predictions")
        .select(
            "id,season,week,event_id,"
            "game,market,model,model_version,"
            "prediction_run_at,locked_at"
        )
        .eq("season", season)
        .eq("week", week)
        .execute()
    ).data

    if not predictions:
        print(
            f"No locked predictions found for "
            f"{season} Week {week}."
        )
        print("Nothing to settle.")

        return {
            "status": "NO_PREDICTIONS",
            "season": season,
            "week": week,
            "games": 0,
        }

    print(
        f"Locked predictions: "
        f"{len(predictions)}"
    )

    # ---------------------------------------------------------
    # Find FINAL ESPN results
    # ---------------------------------------------------------

    finals = parse_final_games(games)

    final_lookup = {
        str(x["event_id"]): x
        for x in finals
    }

    missing = [
        str(p["event_id"])
        for p in predictions
        if str(p["event_id"])
        not in final_lookup
    ]

    if missing:
        print()
        print(
            "SETTLEMENT BLOCKED: "
            "not every predicted game is FINAL."
        )

        for event_id in missing:
            print(
                f"  Not final: {event_id}"
            )

        return {
            "status": "INCOMPLETE",
            "season": season,
            "week": week,
            "games": len(predictions),
            "final_games": (
                len(predictions)
                - len(missing)
            ),
            "missing_event_ids": missing,
        }

    print(
        f"Final results matched: "
        f"{len(predictions)}/"
        f"{len(predictions)}"
    )

    # ---------------------------------------------------------
    # Calculate every settlement BEFORE writing anything
    # ---------------------------------------------------------

    settlements = []

    for prediction in predictions:

        event_id = str(
            prediction["event_id"]
        )

        result = final_lookup[event_id]

        settled = settle_prediction(
            prediction,
            result,
        )

        settlements.append(settled)

        print(
            f"{event_id} | "
            f"ML {settled['ml_result']} | "
            f"Spread {settled['spread_result']} | "
            f"Total {settled['total_result']} | "
            f"Top {settled['top_pick_type']} "
            f"{settled['top_pick_result']}"
        )

    summary = summarize_settlements(
        settlements
    )

    print()
    print("Weekly performance:")
    print(summary)

    # ---------------------------------------------------------
    # Dry run ends here
    # ---------------------------------------------------------

    if dry_run:
        print()
        print(
            "DRY RUN — settlement calculated, "
            "zero database writes."
        )

        return {
            "status": "DRY_RUN",
            "season": season,
            "week": week,
            **summary,
        }

    # ---------------------------------------------------------
    # Store final game results
    # ---------------------------------------------------------

    from datetime import datetime, timezone

    now = datetime.now(
        timezone.utc
    ).isoformat()

    for prediction in predictions:

        event_id = str(
            prediction["event_id"]
        )

        result = final_lookup[event_id]

        game_result_row = {
            "event_id": event_id,
            "season": season,
            "week": week,
            "home_score":
                result["home_score"],
            "away_score":
                result["away_score"],
            "status": "final",
            "completed_at": now,
            "updated_at": now,
        }

        (
            db.table("game_results")
            .upsert(
                game_result_row,
                on_conflict="event_id",
            )
            .execute()
        )

    # ---------------------------------------------------------
    # Store prediction settlements
    # ---------------------------------------------------------

    for settled in settlements:

        settlement_row = {
            "prediction_id":
                settled["prediction_id"],

            "ml_result":
                settled["ml_result"],

            "spread_result":
                settled["spread_result"],

            "total_result":
                settled["total_result"],

            "top_pick_result":
                settled["top_pick_result"],

            "settled_at": now,
        }

        (
            db.table(
                "prediction_settlements"
            )
            .upsert(
                settlement_row,
                on_conflict="prediction_id",
            )
            .execute()
        )

    # ---------------------------------------------------------
    # Store weekly performance
    # ---------------------------------------------------------

    weekly_row = {
        "season": season,
        "week": week,

        "games":
            summary["games"],

        "ml_wins":
            summary["ml_wins"],

        "ml_losses":
            summary["ml_losses"],

        "spread_wins":
            summary["spread_wins"],

        "spread_losses":
            summary["spread_losses"],

        "spread_pushes":
            summary["spread_pushes"],

        "total_wins":
            summary["total_wins"],

        "total_losses":
            summary["total_losses"],

        "total_pushes":
            summary["total_pushes"],

        "top_pick_wins":
            summary["top_pick_wins"],

        "top_pick_losses":
            summary["top_pick_losses"],

        "top_pick_pushes":
            summary["top_pick_pushes"],

        "ml_accuracy":
            summary["ml_accuracy"],

        "spread_accuracy":
            summary["spread_accuracy"],

        "total_accuracy":
            summary["total_accuracy"],

        "top_pick_accuracy":
            summary["top_pick_accuracy"],

        "score_mae":
            summary["score_mae"],

        "margin_mae":
            summary["margin_mae"],

        "total_mae":
            summary["total_mae"],

        "updated_at": now,
    }

    (
        db.table(
            "model_performance_weekly"
        )
        .upsert(
            weekly_row,
            on_conflict="season,week",
        )
        .execute()
    )

    print()
    print(
        f"SETTLED + SAVED: "
        f"{season} Week {week}"
    )

    return {
        "status": "SETTLED",
        "season": season,
        "week": week,
        **summary,
    }
