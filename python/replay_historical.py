"""Run v2.2+ NFL forecasts against historical weeks, preserving true provenance.

Never overwrites official locked predictions or their performance tables.
ESPN final scores are used ONLY in a separate grading pass after forecasts.
Data observed later (e.g. VegasInsider) is labeled historical reference
rather than asserted to be an at-kickoff sportsbook quote.
"""
from __future__ import annotations

import datetime as dt
import functools
import json
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd

import weekly_run as production
import src.features as features
import src.training as training
from src.espn import scoreboard, parse_games
from src.recent_form import completed_games, recent_form_for_matchup
from src.matchup import build_matchup_features
from src.production_model import run_production_game, MODEL_VERSION
from src.training import build_pregame_metrics

REPO = Path(__file__).resolve().parents[1]
SEASON = 2026
TARGET_WEEKS = (2, 3)
SIMULATIONS = 50000


def load(name):
    return json.loads((REPO / name).read_text(encoding="utf-8"))


@functools.lru_cache(maxsize=8)
def cached_pbp(season):
    """Cache once across the two model trainings, avoiding repeated downloads."""
    return features.load_pbp(season)


production.load_pbp = cached_pbp
training.load_pbp = cached_pbp


def market_for(source, vegas_lookup):
    g = source["game"]
    home, away = g["home"]["abbr"], g["away"]["abbr"]
    original = source["market"]
    vegas = vegas_lookup.get(frozenset((home, away)))
    week2 = bool(source.get("display_only"))
    if not week2:
        return {
            "market_margin": float(original["market_margin"]),
            "total": float(original["total"]),
            "home_ml": original.get("home_ml"),
            "away_ml": original.get("away_ml"),
            "spread_source": "archived_pregame_model",
            "total_source": "archived_pregame_model",
            "moneyline_source": "archived_pregame_model",
        }
    # Week 2 original preview contains the spread & total, but not ML prices.
    # VegasInsider moneylines are retrieved postgame: a reference, not an
    # empirically proven price available at the original prediction instant.
    h_ml = a_ml = None
    if vegas:
        h_ml = vegas["team_1_moneyline"] if vegas["team_1"] == home else vegas["team_2_moneyline"]
        a_ml = vegas["team_1_moneyline"] if vegas["team_1"] == away else vegas["team_2_moneyline"]
    return {
        "market_margin": -float(original["spread"]),
        "total": float(original["total"]),
        "home_ml": h_ml,
        "away_ml": a_ml,
        "spread_source": "2026_week2_preview_saved_september",
        "total_source": "2026_week2_preview_saved_september",
        "moneyline_source": "vegasinsider_postgame_reference_not_locked",
    }


def matchup_prediction(p, trained, metrics, current_pbp, prior_pbp, starters,
                       prior_games, vegas_lookup, kickoff):
    game = p["game"]
    home, away = game["home"]["abbr"], game["away"]["abbr"]
    model_home = production.nflverse_team(home)
    model_away = production.nflverse_team(away)
    market = market_for(p, vegas_lookup)

    football = build_matchup_features(model_home, model_away, metrics, market=None)
    qb_features, qb_meta = production.production_qb_features(
        current_df=current_pbp,
        prior_df=prior_pbp,
        week=p["week"],
        home_team=model_home,
        away_team=model_away,
        starter_lookup=starters,
    )
    model_features = {**football, **qb_features}
    vector = pd.DataFrame([
        {name: model_features.get(name, np.nan) for name in trained["feature_cols"]}
    ])
    clean = trained["imputer"].transform(vector.astype(float))
    fm = float(trained["margin_model"].predict(clean)[0])
    ft = float(trained["total_model"].predict(clean)[0])

    # Reuse frozen pregame inputs for Week 3. Week 2 preview has only
    # aggregate adjustments, so the missing underlying inputs stay missing.
    prev = p["model"]
    injury = (prev.get("injuries") or {}).get("features") or {}
    context = prev.get("context") or {}
    recent = recent_form_for_matchup(home, away, prior_games)

    predicted = run_production_game(
        market_margin=market["market_margin"],
        market_total=market["total"],
        home_ml=market["home_ml"],
        away_ml=market["away_ml"],
        football_margin=fm,
        football_total=ft,
        injury_features=injury,
        context_features=context,
        recent_form_features=recent,
        simulations=SIMULATIONS,
        seed=int(p["event_id"]) % 2147483647,
    )
    date = dt.datetime.fromisoformat(kickoff.replace("Z", "+00:00"))
    originally_recorded = p.get("prediction_run_at") or p.get("locked_at")
    source_time = None
    if originally_recorded:
        source_time = dt.datetime.fromisoformat(originally_recorded.replace("Z", "+00:00"))
    # A replay created today is NEVER labeled as being locked in 2026.
    return {
        "season": SEASON,
        "week": p["week"],
        "event_id": str(p["event_id"]),
        "matchup": f"{away} @ {home}",
        "kickoff": kickoff,
        "reference_source_created_at": originally_recorded,
        "reference_existed_before_kickoff": bool(source_time and source_time < date),
        "reference_source": "2026-week2-preview" if p.get("display_only") else "archived_original_locked_week3",
        "market": market,
        "model": {
            **predicted,
            "football_margin": fm,
            "football_total": ft,
            "historical_qb_reference": qb_meta,
            "source_injury_features_available": bool(injury),
            "source_context_features_available": bool(context),
            "training_cutoff": f"{trained['training_through_season']}-W{trained['training_through_week']}",
            "training_rows": trained["training_rows"],
        },
    }


def grade(prediction, final):
    # Outcomes are intentionally joined AFTER prediction is complete.
    if not final or not final.get("completed"):
        return None
    hs = float(final["home"]["score"])
    aws = float(final["away"]["score"])
    m = prediction["market"]
    x = prediction["model"]
    diff, total = hs - aws, hs + aws
    home_win = x["home_win_prob"] >= x["away_win_prob"]
    home_cover = x["home_cover_prob"] >= x["away_cover_prob"]
    over = x["over_prob"] >= x["under_prob"]
    return {
        "home_score": hs,
        "away_score": aws,
        "actual_home_margin": diff,
        "actual_total": total,
        "moneyline_correct": diff != 0 and ((diff > 0) == home_win),
        "spread_result": "PUSH" if diff == m["market_margin"] else
            ("WIN" if (diff > m["market_margin"]) == home_cover else "LOSS"),
        "total_result": "PUSH" if total == m["total"] else
            ("WIN" if (total > m["total"]) == over else "LOSS"),
    }


def replay_week(week):
    print(f"Starting independent {MODEL_VERSION} historical replay for Week {week}",flush=True)
    target = (load("data/week2-preview.json")["games"] if week == 2
              else load("data/predictions/2026-week-3.json")["predictions"])
    assert len(target) == 16, f"Missing original reference games for Week {week}"
    vegas = load(f"data/historical_odds/2026-week-{week}.json")["games"]
    vegas_lookup = {frozenset((g["team_1"],g["team_2"])):g for g in vegas}

    # Before any finalized target-week games are observed, obtain earlier
    # scoreboards only. These are the sole source of opponent-graph inputs.
    prior_payloads = [(w,scoreboard(SEASON,w)) for w in range(1,week)]
    prior_games = completed_games(prior_payloads,week)
    trained = production.train_models(target_season=SEASON,target_week=week)
    current = cached_pbp(SEASON)
    previous = cached_pbp(SEASON-1)
    metrics = build_pregame_metrics(current_df=current,prior_df=previous,week=week)
    starters = production.latest_starter_map(current,week)

    # The target schedule supplies kickoff timestamps, not target results.
    # We intentionally read final scores only AFTER creating all forecasts.
    schedule = parse_games(scoreboard(SEASON,week))
    scheduled = {str(g["event_id"]):g for g in schedule}
    outputs = []
    for p in target:
        eid = str(p["event_id"])
        fixture=scheduled.get(eid)
        if not fixture:
            raise ValueError(f"No ESPN schedule event {eid} for {week}")
        if fixture["home"]["abbr"] != p["game"]["home"]["abbr"] or fixture["away"]["abbr"] != p["game"]["away"]["abbr"]:
            raise ValueError(f"Mismatch in stored matchup for {eid}")
        row=matchup_prediction(p,trained,metrics,current,previous,starters,prior_games,vegas_lookup,fixture["date"])
        outputs.append(row)
        print(f"  {row['matchup']}: {row['model']['pred_away']:.1f}–{row['model']['pred_home']:.1f}",flush=True)
    if len(outputs)!=16:
        raise RuntimeError("Incomplete model replay; nothing will be written")

    # Grade for retrospective analysis only; never relabel as actual picks.
    for entry in outputs:
        entry["evaluation_after_games"] = grade(entry,scheduled[str(entry["event_id"])])

    result={
        "season":SEASON,
        "week":week,
        "kind":"historical_model_replay_not_original_pregame_predictions",
        "model_version":MODEL_VERSION,
        "replayed_at":dt.datetime.now(dt.timezone.utc).isoformat(),
        "training_cutoff":f"{trained['training_through_season']}-W{trained['training_through_week']}",
        "source_note":(
            "This dataset is a retrospective replay of the current model. It was NOT issued as original Week "
            f"{week} pregame predictions. Weeks 2's moneyline odds were sourced after the games "
            "and may differ from available pre-kickoff odds. Week 2 injury and weather feature vectors "
            "weren't archived. Do not merge into official predictions or cumulative betting P/L."
        ),
        "predictions":outputs,
    }
    target_path=REPO/"data"/"backtests"/f"2026-week-{week}-model-replay.json"
    target_path.parent.mkdir(parents=True,exist_ok=True)
    target_path.write_text(json.dumps(result,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    print(f"Generated historical replay file {target_path}: {len(outputs)} games",flush=True)


if __name__=="__main__":
    for week in TARGET_WEEKS:
        replay_week(week)
