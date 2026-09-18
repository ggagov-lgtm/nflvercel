import requests

SUMMARY_URL = (
    "https://site.api.espn.com/apis/site/v2/"
    "sports/football/nfl/summary"
)

# Relative positional importance.
# These are adjustment weights, NOT point values.
POSITION_WEIGHTS = {
    "QB": 5.00,

    "LT": 2.00,
    "RT": 1.75,
    "OT": 1.75,
    "G": 1.25,
    "OG": 1.25,
    "C": 1.50,
    "OL": 1.25,

    "WR": 1.50,
    "TE": 1.25,
    "RB": 1.00,
    "FB": 0.50,

    "EDGE": 1.75,
    "DE": 1.50,
    "DT": 1.25,
    "NT": 1.00,
    "LB": 1.25,
    "OLB": 1.40,
    "ILB": 1.20,

    "CB": 1.50,
    "S": 1.25,
    "DB": 1.25,

    "K": 0.75,
    "P": 0.40,
    "LS": 0.20,
}

STATUS_WEIGHTS = {
    "out": 1.00,
    "doubtful": 0.75,
    "questionable": 0.35,
    "probable": 0.10,
}


def get_event_summary(event_id):
    r = requests.get(
        SUMMARY_URL,
        params={"event": str(event_id)},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def normalize_status(injury):
    status = str(
        injury.get("status")
        or injury.get("type", {}).get("description")
        or ""
    ).strip().lower()

    return status


def normalize_position(injury):
    return str(
        injury.get("athlete", {})
        .get("position", {})
        .get("abbreviation", "")
    ).strip().upper()


def parse_injuries(summary):
    """
    Convert ESPN event-summary injuries into clean player records.
    """

    records = []

    for team_block in summary.get("injuries", []):

        team = team_block.get("team", {})
        team_abbr = team.get("abbreviation")

        for injury in team_block.get("injuries", []):

            athlete = injury.get("athlete", {})
            details = injury.get("details", {})

            position = normalize_position(injury)
            status = normalize_status(injury)

            status_weight = STATUS_WEIGHTS.get(
                status,
                0.0,
            )

            position_weight = POSITION_WEIGHTS.get(
                position,
                0.75,
            )

            records.append({
                "team": team_abbr,
                "player_id": athlete.get("id"),
                "player": (
                    athlete.get("displayName")
                    or athlete.get("fullName")
                ),
                "position": position,
                "status": status,
                "injury_type": details.get("type"),
                "injury_location": details.get("location"),
                "return_date": details.get("returnDate"),
                "reported_at": injury.get("date"),
                "status_weight": status_weight,
                "position_weight": position_weight,
                "raw_impact": (
                    status_weight * position_weight
                ),
            })

    return records


def team_injury_features(records, team):
    """
    Aggregate injury report into compact team-level features.

    IMPORTANT:
    These values describe personnel availability.
    They are not directly interpreted as points.
    """

    players = [
        x for x in records
        if x["team"] == team
    ]

    def count_status(status):
        return sum(
            1 for x in players
            if x["status"] == status
        )

    out_players = [
        x for x in players
        if x["status"] == "out"
    ]

    questionable_players = [
        x for x in players
        if x["status"] == "questionable"
    ]

    doubtful_players = [
        x for x in players
        if x["status"] == "doubtful"
    ]

    total_impact = sum(
        x["raw_impact"]
        for x in players
    )

    offense_positions = {
        "QB", "RB", "FB", "WR", "TE",
        "LT", "RT", "OT", "G", "OG",
        "C", "OL",
    }

    defense_positions = {
        "EDGE", "DE", "DT", "NT",
        "LB", "OLB", "ILB",
        "CB", "S", "DB",
    }

    offense_impact = sum(
        x["raw_impact"]
        for x in players
        if x["position"] in offense_positions
    )

    defense_impact = sum(
        x["raw_impact"]
        for x in players
        if x["position"] in defense_positions
    )

    qb_impact = sum(
        x["raw_impact"]
        for x in players
        if x["position"] == "QB"
    )

    return {
        "injury_count": len(players),

        "injury_out_count":
            len(out_players),

        "injury_doubtful_count":
            len(doubtful_players),

        "injury_questionable_count":
            len(questionable_players),

        "injury_total_impact":
            float(total_impact),

        "injury_offense_impact":
            float(offense_impact),

        "injury_defense_impact":
            float(defense_impact),

        "injury_qb_impact":
            float(qb_impact),

        "injury_has_qb":
            float(qb_impact > 0),

        "injury_out_weight":
            float(sum(
                x["position_weight"]
                for x in out_players
            )),
    }


def build_game_injury_features(
    event_id,
    home_team,
    away_team,
):
    summary = get_event_summary(event_id)
    records = parse_injuries(summary)

    home = team_injury_features(
        records,
        home_team,
    )

    away = team_injury_features(
        records,
        away_team,
    )

    features = {}

    for key, value in home.items():
        features[f"home_{key}"] = value

    for key, value in away.items():
        features[f"away_{key}"] = value

    # Positive difference = home has MORE injury burden.
    for key in home:
        features[f"diff_{key}"] = (
            home[key] - away[key]
        )

    return features, records
