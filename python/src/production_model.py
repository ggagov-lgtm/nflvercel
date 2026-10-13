import math
import numpy as np


MODEL_VERSION = "v2.1.0"
SIMULATIONS = 50000


def american_implied(odds):
    if odds is None:
        return None

    odds = float(odds)

    if odds < 0:
        return (-odds) / (-odds + 100.0)

    return 100.0 / (odds + 100.0)


def remove_vig(home_ml, away_ml):
    hp = american_implied(home_ml)
    ap = american_implied(away_ml)

    if hp is None or ap is None:
        return None, None

    total = hp + ap

    if total <= 0:
        return None, None

    return hp / total, ap / total


# Conservative pregame probability calibration. Sportsbook no-vig prices
# outperformed raw simulation win probabilities in our initial live audit.
# Fixed coefficients are deliberately NOT refit on a few weeks of results.
MARKET_MONEYLINE_WEIGHT = 0.75
TOTAL_FOOTBALL_WEIGHT = 0.05


def calibrate_moneyline_probabilities(result, home_ml, away_ml,
                                      market_weight=MARKET_MONEYLINE_WEIGHT):
    """
    Blend conditional (non-tie) simulation win probabilities toward no-vig odds.

    Preserve the simulator's tie mass; never turn a real push into a loss.
    Missing/incomplete moneyline prices leave model probabilities unchanged.
    """
    home = float(result["home_win_prob"])
    away = float(result["away_win_prob"])
    market_home, market_away = remove_vig(home_ml, away_ml)
    out = dict(result)
    out["raw_home_win_prob"] = home
    out["raw_away_win_prob"] = away
    out["moneyline_market_weight"] = 0.0
    non_tie = home + away
    if market_home is None or market_away is None or non_tie <= 0:
        return out
    market_weight = bounded(float(market_weight), 0.0, 1.0)
    conditional_home = home / non_tie
    calibrated_home = (
        (1.0 - market_weight) * conditional_home
        + market_weight * market_home
    )
    out["home_win_prob"] = non_tie * calibrated_home
    out["away_win_prob"] = non_tie * (1.0 - calibrated_home)
    out["moneyline_market_weight"] = market_weight
    return out


def moneyline_expected_profit(win_prob, loss_prob, odds, stake=10.0):
    """
    Expected net dollars at the *actual available price*, ties returning stake.

    This is an estimated expectation, not a guaranteed profit or a directive
    to place a bet. Do not impute missing moneyline odds.
    """
    if odds is None:
        return None
    try:
        price = float(odds)
    except (ValueError, TypeError):
        return None
    if not math.isfinite(price) or abs(price) < 100.0:
        return None
    winnings = (
        float(stake) * (price / 100.0)
        if price > 0
        else float(stake) * (100.0 / abs(price))
    )
    return float(win_prob) * winnings - float(loss_prob) * float(stake)


def bounded(value, low, high):
    return max(low, min(high, value))


def injury_adjustment(injury_features):
    """
    Small, bounded production-only adjustment.

    Positive result means home team is healthier / advantaged.

    Injury weights are NOT interpreted directly as NFL points.
    We convert the relative burden into a deliberately conservative
    score adjustment.
    """

    if not injury_features:
        return 0.0

    home_off = float(
        injury_features.get(
            "home_injury_offense_impact", 0
        )
    )

    away_off = float(
        injury_features.get(
            "away_injury_offense_impact", 0
        )
    )

    home_def = float(
        injury_features.get(
            "home_injury_defense_impact", 0
        )
    )

    away_def = float(
        injury_features.get(
            "away_injury_defense_impact", 0
        )
    )

    home_qb = float(
        injury_features.get(
            "home_injury_qb_impact", 0
        )
    )

    away_qb = float(
        injury_features.get(
            "away_injury_qb_impact", 0
        )
    )

    # Away injuries help home; home injuries hurt home.
    adjustment = (
        0.12 * (away_off - home_off)
        + 0.08 * (away_def - home_def)
        + 0.35 * (away_qb - home_qb)
    )

    return bounded(adjustment, -2.5, 2.5)


def context_adjustment(context):
    """
    Conservative contextual adjustment to expected HOME margin.

    Rest differences can affect margin.

    Weather primarily affects TOTAL and is handled separately.
    """

    if not context:
        return 0.0

    rest_diff = float(
        context.get("diff_rest_days", 0)
    )

    short_diff = float(
        context.get("diff_short_week", 0)
    )

    adjustment = (
        0.08 * rest_diff
        - 0.20 * short_diff
    )

    return bounded(adjustment, -1.0, 1.0)


def weather_total_adjustment(context):
    """
    Conservative adjustment to expected game total.

    Negative values lower expected scoring.
    """

    if not context:
        return 0.0

    if float(context.get("venue_indoor", 0)) == 1:
        return 0.0

    wind = float(
        context.get("weather_wind_severity", 0)
    )

    precip = float(
        context.get("weather_precip_severity", 0)
    )

    cold = float(
        context.get("weather_cold_severity", 0)
    )

    heat = float(
        context.get("weather_heat_severity", 0)
    )

    adjustment = (
        -0.10 * wind
        -0.75 * precip
        -0.025 * cold
        -0.015 * heat
    )

    return bounded(adjustment, -3.0, 0.5)


def combine_predictions(
    market_margin,
    market_total,
    football_margin=None,
    football_total=None,
    football_weight=0.10,
    total_football_weight=TOTAL_FOOTBALL_WEIGHT,
):
    """
    Market remains the dominant anchor.

    football_weight is deliberately small because our rolling
    validation showed that sportsbook lines outperform the
    football-only model.

    IMPORTANT:
    market_margin MUST use our normalized convention:
        positive = home favored
        negative = away favored
    """

    market_margin = float(market_margin)
    market_total = float(market_total)

    if football_margin is None:
        margin = market_margin
    else:
        margin = (
            market_margin
            + football_weight
            * (
                float(football_margin)
                - market_margin
            )
        )

    if football_total is None:
        total = market_total
    else:
        total = (
            market_total
            + total_football_weight
            * (
                float(football_total)
                - market_total
            )
        )

    return margin, total


def simulate_game(
    expected_margin,
    expected_total,
    market_margin,
    market_total,
    home_ml=None,
    away_ml=None,
    simulations=SIMULATIONS,
    seed=42,
):
    """
    Monte Carlo simulation.

    Uses correlated team scoring uncertainty so game environment
    affects both teams while retaining independent scoring noise.
    """

    expected_margin = float(expected_margin)
    expected_total = float(expected_total)

    home_mean = (
        expected_total + expected_margin
    ) / 2.0

    away_mean = (
        expected_total - expected_margin
    ) / 2.0

    rng = np.random.default_rng(seed)

    environment = rng.normal(
        0.0,
        4.0,
        simulations,
    )

    home_noise = rng.normal(
        0.0,
        7.0,
        simulations,
    )

    away_noise = rng.normal(
        0.0,
        7.0,
        simulations,
    )

    home_scores = np.clip(
        np.rint(
            home_mean
            + environment
            + home_noise
        ),
        a_min=0,
        a_max=None,
    ).astype(int)

    away_scores = np.clip(
        np.rint(
            away_mean
            + environment
            + away_noise
        ),
        a_min=0,
        a_max=None,
    ).astype(int)

    sim_margin = (
        home_scores - away_scores
    )

    sim_total = (
        home_scores + away_scores
    )

    home_win = float(
        (sim_margin > 0).mean()
    )

    away_win = float(
        (sim_margin < 0).mean()
    )

    tie_prob = float(
        (sim_margin == 0).mean()
    )

    # Market margin convention:
    # positive = home favored.
    #
    # Home covers if:
    # actual home margin > market expected margin.
    home_cover = float(
        (
            sim_margin
            > float(market_margin)
        ).mean()
    )

    away_cover = float(
        (
            sim_margin
            < float(market_margin)
        ).mean()
    )

    spread_push = float(
        (
            sim_margin
            == float(market_margin)
        ).mean()
    )

    over = float(
        (
            sim_total
            > float(market_total)
        ).mean()
    )

    under = float(
        (
            sim_total
            < float(market_total)
        ).mean()
    )

    total_push = float(
        (
            sim_total
            == float(market_total)
        ).mean()
    )

    fair_home, fair_away = remove_vig(
        home_ml,
        away_ml,
    )

    return {
        "pred_home":
            float(home_scores.mean()),

        "pred_away":
            float(away_scores.mean()),

        "model_margin":
            float(sim_margin.mean()),

        "model_total":
            float(sim_total.mean()),

        "home_win_prob":
            home_win,

        "away_win_prob":
            away_win,

        "tie_prob":
            tie_prob,

        "home_cover_prob":
            home_cover,

        "away_cover_prob":
            away_cover,

        "spread_push_prob":
            spread_push,

        "over_prob":
            over,

        "under_prob":
            under,

        "total_push_prob":
            total_push,

        "market_fair_home_prob":
            fair_home,

        "market_fair_away_prob":
            fair_away,

        "simulations":
            int(simulations),
    }


def run_production_game(
    *,
    market_margin,
    market_total,
    home_ml=None,
    away_ml=None,
    football_margin=None,
    football_total=None,
    injury_features=None,
    context_features=None,
    football_weight=0.10,
    total_football_weight=TOTAL_FOOTBALL_WEIGHT,
    simulations=SIMULATIONS,
    seed=42,
):
    """
    Complete NFL Quant Model v2 production calculation.

    Flow:
        sportsbook anchor
        -> football-model correction
        -> injury adjustment
        -> rest/context adjustment
        -> weather total adjustment
        -> Monte Carlo
    """

    base_margin, base_total = combine_predictions(
        market_margin=market_margin,
        market_total=market_total,
        football_margin=football_margin,
        football_total=football_total,
        football_weight=football_weight,
        total_football_weight=total_football_weight,
    )

    inj_adj = injury_adjustment(
        injury_features
    )

    ctx_adj = context_adjustment(
        context_features
    )

    weather_adj = weather_total_adjustment(
        context_features
    )

    expected_margin = (
        base_margin
        + inj_adj
        + ctx_adj
    )

    expected_total = (
        base_total
        + weather_adj
    )

    result = simulate_game(
        expected_margin=expected_margin,
        expected_total=expected_total,
        market_margin=market_margin,
        market_total=market_total,
        home_ml=home_ml,
        away_ml=away_ml,
        simulations=simulations,
        seed=seed,
    )

    result = calibrate_moneyline_probabilities(result, home_ml, away_ml)
    result["home_ml_expected_profit_10"] = moneyline_expected_profit(
        result["home_win_prob"], result["away_win_prob"], home_ml
    )
    result["away_ml_expected_profit_10"] = moneyline_expected_profit(
        result["away_win_prob"], result["home_win_prob"], away_ml
    )
    available_edges = [
        (side, ev)
        for side, ev in (
            ("home", result["home_ml_expected_profit_10"]),
            ("away", result["away_ml_expected_profit_10"]),
        )
        if ev is not None and ev > 0
    ]
    # A legitimate "no positive edge" outcome avoids forcing a moneyline bet.
    result["moneyline_value_side"] = (
        max(available_edges, key=lambda row: row[1])[0]
        if available_edges else None
    )

    result.update({
        "model_version":
            MODEL_VERSION,

        "football_weight":
            float(football_weight),

        "total_football_weight":
            float(total_football_weight),

        "market_margin":
            float(market_margin),

        "market_total":
            float(market_total),

        "football_margin":
            (
                None
                if football_margin is None
                else float(football_margin)
            ),

        "football_total":
            (
                None
                if football_total is None
                else float(football_total)
            ),

        "base_margin":
            float(base_margin),

        "base_total":
            float(base_total),

        "injury_margin_adjustment":
            float(inj_adj),

        "context_margin_adjustment":
            float(ctx_adj),

        "weather_total_adjustment":
            float(weather_adj),

        "expected_margin":
            float(expected_margin),

        "expected_total":
            float(expected_total),
    })

    return result
