from datetime import datetime, timezone
import requests

BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"

# Stadiums where outside weather should not directly affect play.
INDOOR_VENUES = {
    "Mercedes-Benz Stadium",
    "AT&T Stadium",
    "State Farm Stadium",
    "SoFi Stadium",
    "U.S. Bank Stadium",
    "Ford Field",
    "Lucas Oil Stadium",
    "Caesars Superdome",
    "Allegiant Stadium",
    "NRG Stadium",
    "Reliant Stadium",
}

# Retractable-roof venues.
# We conservatively treat them as weather-protected unless
# reliable roof-open information becomes available.
RETRACTABLE_VENUES = {
    "AT&T Stadium",
    "State Farm Stadium",
    "Lucas Oil Stadium",
    "NRG Stadium",
    "Reliant Stadium",
    "Mercedes-Benz Stadium",
}


def _parse_dt(value):
    if not value:
        return None

    return datetime.fromisoformat(
        value.replace("Z", "+00:00")
    )


def get_summary(event_id):
    r = requests.get(
        f"{BASE}/summary",
        params={"event": str(event_id)},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def get_scoreboard(year, week):
    r = requests.get(
        f"{BASE}/scoreboard",
        params={
            "dates": str(year),
            "week": int(week),
            "seasontype": 2,
        },
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def get_team_previous_game(team, year, week):
    """
    Find the team's most recent game before target week.
    Used to calculate rest days.

    Searches current season first, then prior season if needed.
    """

    candidates = []

    for w in range(max(1, week - 4), week):

        data = get_scoreboard(year, w)

        for event in data.get("events", []):

            competition = event["competitions"][0]

            teams = [
                x["team"].get("abbreviation")
                for x in competition["competitors"]
            ]

            if team in teams:
                candidates.append(event)

    if not candidates:
        return None

    candidates.sort(
        key=lambda x: x.get("date", "")
    )

    return candidates[-1]


def calculate_rest_days(
    team,
    year,
    week,
    kickoff,
):
    previous = get_team_previous_game(
        team,
        year,
        week,
    )

    if not previous:
        return 7.0

    prev_dt = _parse_dt(previous.get("date"))

    if not prev_dt:
        return 7.0

    days = (
        kickoff - prev_dt
    ).total_seconds() / 86400.0

    return float(days)


def weather_features(summary):
    game_info = summary.get("gameInfo", {})
    venue = game_info.get("venue", {})
    weather = game_info.get("weather", {})

    venue_name = venue.get("fullName", "")

    indoor = (
        venue_name in INDOOR_VENUES
        or venue_name in RETRACTABLE_VENUES
    )

    temperature = weather.get("temperature")
    gust = weather.get("gust")
    precipitation = weather.get("precipitation")

    temperature = (
        float(temperature)
        if temperature is not None
        else 70.0
    )

    gust = (
        float(gust)
        if gust is not None
        else 0.0
    )

    precipitation = (
        float(precipitation)
        if precipitation is not None
        else 0.0
    )

    # Outside weather should not affect an indoor game.
    effective_gust = 0.0 if indoor else gust
    effective_precip = 0.0 if indoor else precipitation

    # Compact severity indicators.
    cold = max(0.0, 40.0 - temperature) if not indoor else 0.0
    heat = max(0.0, temperature - 85.0) if not indoor else 0.0
    wind = max(0.0, effective_gust - 15.0)

    return {
        "venue_indoor": float(indoor),
        "venue_grass": float(bool(venue.get("grass", False))),
        "temperature": temperature,
        "wind_gust": effective_gust,
        "precipitation_probability": effective_precip,
        "weather_cold_severity": cold,
        "weather_heat_severity": heat,
        "weather_wind_severity": wind,
        "weather_precip_severity":
            effective_precip / 100.0,
    }


def build_game_context_features(
    event_id,
    season,
    week,
    kickoff,
    home_team,
    away_team,
):
    """
    Production context features available before kickoff.
    """

    if isinstance(kickoff, str):
        kickoff = _parse_dt(kickoff)

    summary = get_summary(event_id)

    features = weather_features(summary)

    home_rest = calculate_rest_days(
        home_team,
        season,
        week,
        kickoff,
    )

    away_rest = calculate_rest_days(
        away_team,
        season,
        week,
        kickoff,
    )

    features.update({
        "home_rest_days": home_rest,
        "away_rest_days": away_rest,

        "diff_rest_days":
            home_rest - away_rest,

        "home_short_week":
            float(home_rest < 6.5),

        "away_short_week":
            float(away_rest < 6.5),

        "home_extra_rest":
            float(home_rest > 8.5),

        "away_extra_rest":
            float(away_rest > 8.5),

        "diff_short_week":
            float(home_rest < 6.5)
            - float(away_rest < 6.5),
    })

    return features
