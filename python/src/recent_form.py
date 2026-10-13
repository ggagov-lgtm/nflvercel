"""Leakage-safe NFL recent-scoring and transitive-opponent form signals.

Build history from final games strictly before the target NFL week. These
signals are *bounded corrections* to the market/football forecast, never
winner mandates. No future results or current-week scoreboard may enter.
"""
import math
from collections import defaultdict

import numpy as np


# League-wide opponent-graph regularization: few games => small ratings.
GRAPH_RIDGE = 4.0
GRAPH_HOME_FIELD = 1.5
RECENT_MARGIN_WEIGHT = 0.08
RECENT_TOTAL_WEIGHT = 0.12
OPPONENT_GRAPH_WEIGHT = 0.06


def _finite(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _clip(value, limit):
    return max(-limit, min(limit, value))


def completed_games(scoreboard_pages, target_week):
    """Return canonical once-per-game scores only from completed prior weeks.

    scoreboard_pages: iterable of (week_number, ESPN-scoreboard-payload).
    No network calls happen here, so backtests can pass frozen snapshots.
    """
    unique = {}
    for source_week, payload in scoreboard_pages:
        if not 1 <= int(source_week) < int(target_week):
            continue
        for event in payload.get("events", []):
            status = event.get("status", {}).get("type", {})
            if status.get("completed") is not True:
                continue
            competitions = event.get("competitions") or []
            if not competitions:
                continue
            competitors = competitions[0].get("competitors") or []
            home = next((x for x in competitors if x.get("homeAway") == "home"), None)
            away = next((x for x in competitors if x.get("homeAway") == "away"), None)
            if not home or not away:
                continue
            hteam = (home.get("team") or {}).get("abbreviation")
            ateam = (away.get("team") or {}).get("abbreviation")
            hs, a_score = _finite(home.get("score")), _finite(away.get("score"))
            if not hteam or not ateam or hteam == ateam or hs is None or a_score is None:
                continue
            ident = str(event.get("id") or f"{source_week}-{ateam}-{hteam}")
            unique[ident] = {
                "week": int(source_week),
                "id": ident,
                "home": hteam,
                "away": ateam,
                "home_score": hs,
                "away_score": a_score,
            }
    return sorted(unique.values(), key=lambda g: (g["week"], g["id"]))


def recent_scores(team, games):
    """Last five complete games, newest first, using pregame data only."""
    rows = []
    for g in reversed(games):
        if team == g["home"]:
            rows.append((g["home_score"], g["away_score"]))
        elif team == g["away"]:
            rows.append((g["away_score"], g["home_score"]))
        if len(rows) == 5:
            break
    if not rows:
        return None
    # Most recent three games dominate, the fourth/fifth stabilize early noise.
    weights = (1.0, 0.80, 0.65, 0.35, 0.25)[:len(rows)]
    mass = sum(weights)
    return {
        "scored": sum(w * x[0] for w, x in zip(weights, rows)) / mass,
        "allowed": sum(w * x[1] for w, x in zip(weights, rows)) / mass,
        "last3_scored": sum(x[0] for x in rows[:3]) / min(3, len(rows)),
        "last3_allowed": sum(x[1] for x in rows[:3]) / min(3, len(rows)),
        "games": len(rows),
    }


def opponent_ratings(games):
    """Regularized least-squares team-strength graph from *score margins*.

    If A beats B by 1 and B beats C by 1, A tends to rate above C by a
    small amount. The differences are shrunk toward zero. No hard
    transitive 'A must beat C' rule exists, and large blowouts are capped.
    """
    if not games:
        return {}
    names = sorted({g["home"] for g in games} | {g["away"] for g in games})
    idx = {name: k for k, name in enumerate(names)}
    design = np.zeros((len(games), len(names)), dtype=float)
    responses = np.zeros(len(games))
    weights = np.zeros(len(games))
    latest = max(g["week"] for g in games)
    for i, g in enumerate(games):
        design[i, idx[g["home"]]] = 1.0
        design[i, idx[g["away"]]] = -1.0
        responses[i] = _clip(g["home_score"] - g["away_score"] - GRAPH_HOME_FIELD, 24.0)
        weights[i] = 0.90 ** (latest - g["week"])
    matrix = design.T @ (weights[:, None] * design)
    rhs = design.T @ (weights * responses)
    values = np.linalg.solve(matrix + GRAPH_RIDGE * np.eye(len(names)), rhs)
    return {name: float(values[idx[name]]) for name in names}


def recent_form_for_matchup(home, away, games):
    """Return pregame matchup scoring averages and opponent graph signal."""
    home_rows, away_rows = recent_scores(home, games), recent_scores(away, games)
    ratings = opponent_ratings(games)
    feature = {
        "home_recent": home_rows,
        "away_recent": away_rows,
        "home_graph_rating": ratings.get(home),
        "away_graph_rating": ratings.get(away),
        "completed_history_games": len(games),
    }
    if home_rows and away_rows:
        ho, hd = home_rows["scored"], home_rows["allowed"]
        ao, ad = away_rows["scored"], away_rows["allowed"]
        # An offense-only differential misses opposing defensive quality.
        balanced_margin = (ho + ad - ao - hd) / 2.0
        offensive_margin = ho - ao
        feature["recent_margin"] = 0.35 * offensive_margin + 0.65 * balanced_margin
        # Scoring consistency matters to totals, with allowed points still relevant.
        offensive_total = ho + ao
        balanced_total = (ho + ad + ao + hd) / 2.0
        feature["recent_total"] = 0.65 * offensive_total + 0.35 * balanced_total
        feature["sample_reliability"] = min(1.0, min(home_rows["games"], away_rows["games"]) / 3.0)
    else:
        feature["recent_margin"] = None
        feature["recent_total"] = None
        feature["sample_reliability"] = 0.0
    if home in ratings and away in ratings:
        feature["graph_expected_home_margin"] = (
            ratings[home] - ratings[away] + GRAPH_HOME_FIELD
        )
    else:
        feature["graph_expected_home_margin"] = None
    return feature


def adjustment_from_form(form, market_margin, market_total):
    """Small corrections with hard caps and an auditable explanation.

    Only data known before kickoff may enter form. Opponent graph is
    kept separate from recent scoring to avoid an arbitrary mandatory win.
    """
    if not form:
        return {"recent_margin_adjustment": 0.0,
                "recent_total_adjustment": 0.0,
                "graph_margin_adjustment": 0.0}
    reliability = float(form.get("sample_reliability") or 0)
    if form.get("recent_margin") is not None and reliability:
        margin = _clip(
            RECENT_MARGIN_WEIGHT * reliability *
            (float(form["recent_margin"]) - float(market_margin)),
            1.25,
        )
        total = _clip(
            RECENT_TOTAL_WEIGHT * reliability *
            (float(form["recent_total"]) - float(market_total)),
            2.0,
        )
    else:
        margin, total = 0.0, 0.0

    if form.get("graph_expected_home_margin") is not None:
        # Use previous games only, and require both teams to have data.
        graph = _clip(
            OPPONENT_GRAPH_WEIGHT * reliability *
            (float(form["graph_expected_home_margin"]) - float(market_margin)),
            0.75,
        )
    else:
        graph = 0.0
    return {
        "recent_margin_adjustment": margin,
        "recent_total_adjustment": total,
        "graph_margin_adjustment": graph,
    }
