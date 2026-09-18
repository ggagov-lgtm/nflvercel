import pandas as pd
import numpy as np


PBP_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "pbp/play_by_play_{season}.parquet"
)


def load_pbp(season: int) -> pd.DataFrame:
    df = pd.read_parquet(PBP_URL.format(season=season))

    if "season_type" in df.columns:
        df = df[df["season_type"] == "REG"].copy()

    return df


def safe_mean(series):
    s = pd.to_numeric(series, errors="coerce")
    if s.notna().sum() == 0:
        return np.nan
    return float(s.mean())


def safe_rate(series):
    s = pd.to_numeric(series, errors="coerce")
    if s.notna().sum() == 0:
        return np.nan
    return float(s.fillna(0).mean())


def offense_metrics(df: pd.DataFrame) -> pd.DataFrame:
    plays = df[df["posteam"].notna()].copy()

    rows = []

    for team, g in plays.groupby("posteam"):

        passes = g[g["pass"] == 1]
        rushes = g[g["rush"] == 1]

        third = g[
            (g["third_down_converted"] == 1)
            | (g["third_down_failed"] == 1)
        ]

        fourth = g[
            (g["fourth_down_converted"] == 1)
            | (g["fourth_down_failed"] == 1)
        ]

        rz = g[g["yardline_100"] <= 20]

        explosives = g[
            ((g["pass"] == 1) & (g["yards_gained"] >= 20))
            | ((g["rush"] == 1) & (g["yards_gained"] >= 10))
        ]

        fg = g[g["field_goal_attempt"] == 1]

        rows.append({
            "team": team,

            "off_plays": len(g),
            "off_epa_per_play": safe_mean(g["epa"]),
            "off_success_rate": safe_rate(g["success"]),
            "off_yards_per_play": safe_mean(g["yards_gained"]),

            "off_pass_epa": safe_mean(passes["epa"]),
            "off_pass_success": safe_rate(passes["success"]),
            "off_pass_yards": safe_mean(passes["passing_yards"]),
            "off_cpoe": safe_mean(passes["cpoe"]),
            "off_air_yards": safe_mean(passes["air_yards"]),
            "off_yac": safe_mean(passes["yards_after_catch"]),

            "off_rush_epa": safe_mean(rushes["epa"]),
            "off_rush_success": safe_rate(rushes["success"]),
            "off_rush_yards": safe_mean(rushes["rushing_yards"]),

            "off_sack_rate": safe_rate(passes["sack"]),
            "off_qb_hit_rate": safe_rate(passes["qb_hit"]),

            "off_interception_rate": safe_rate(passes["interception"]),
            "off_fumble_rate": safe_rate(g["fumble"]),
            "off_fumble_lost_rate": safe_rate(g["fumble_lost"]),

            "off_td_rate": safe_rate(g["touchdown"]),
            "off_pass_td_rate": safe_rate(passes["pass_touchdown"]),
            "off_rush_td_rate": safe_rate(rushes["rush_touchdown"]),

            "off_explosive_rate": (
                len(explosives) / len(g)
                if len(g) else np.nan
            ),

            "off_third_down_rate": (
                float(third["third_down_converted"].sum()) / len(third)
                if len(third) else np.nan
            ),

            "off_fourth_down_rate": (
                float(fourth["fourth_down_converted"].sum()) / len(fourth)
                if len(fourth) else np.nan
            ),

            "off_redzone_epa": safe_mean(rz["epa"]),
            "off_redzone_success": safe_rate(rz["success"]),
            "off_redzone_td_rate": safe_rate(rz["touchdown"]),

            "off_first_down_rate": safe_rate(g["first_down"]),

            "off_penalty_rate": safe_rate(g["penalty"]),
            "off_penalty_yards": safe_mean(g["penalty_yards"]),

            "off_fg_attempt_rate": safe_rate(g["field_goal_attempt"]),
            "off_fg_make_rate": (
                float((fg["field_goal_result"] == "made").mean())
                if len(fg) else np.nan
            ),

            "off_drive_score_rate": safe_rate(g["drive_ended_with_score"]),
            "off_drive_inside20_rate": safe_rate(g["drive_inside20"]),

            "off_avg_drive_plays": safe_mean(g["drive_play_count"]),
            "off_avg_drive_first_downs": safe_mean(g["drive_first_downs"]),
            "off_avg_drive_penalty_yards": safe_mean(g["drive_yards_penalized"]),
        })

    return pd.DataFrame(rows).set_index("team")


def defense_metrics(df: pd.DataFrame) -> pd.DataFrame:
    plays = df[df["defteam"].notna()].copy()

    rows = []

    for team, g in plays.groupby("defteam"):

        passes = g[g["pass"] == 1]
        rushes = g[g["rush"] == 1]

        third = g[
            (g["third_down_converted"] == 1)
            | (g["third_down_failed"] == 1)
        ]

        fourth = g[
            (g["fourth_down_converted"] == 1)
            | (g["fourth_down_failed"] == 1)
        ]

        rz = g[g["yardline_100"] <= 20]

        explosives = g[
            ((g["pass"] == 1) & (g["yards_gained"] >= 20))
            | ((g["rush"] == 1) & (g["yards_gained"] >= 10))
        ]

        rows.append({
            "team": team,

            "def_plays": len(g),
            "def_epa_allowed": safe_mean(g["epa"]),
            "def_success_allowed": safe_rate(g["success"]),
            "def_yards_allowed": safe_mean(g["yards_gained"]),

            "def_pass_epa_allowed": safe_mean(passes["epa"]),
            "def_pass_success_allowed": safe_rate(passes["success"]),
            "def_pass_yards_allowed": safe_mean(passes["passing_yards"]),
            "def_cpoe_allowed": safe_mean(passes["cpoe"]),
            "def_air_yards_allowed": safe_mean(passes["air_yards"]),
            "def_yac_allowed": safe_mean(passes["yards_after_catch"]),

            "def_rush_epa_allowed": safe_mean(rushes["epa"]),
            "def_rush_success_allowed": safe_rate(rushes["success"]),
            "def_rush_yards_allowed": safe_mean(rushes["rushing_yards"]),

            "def_sack_rate": safe_rate(passes["sack"]),
            "def_qb_hit_rate": safe_rate(passes["qb_hit"]),

            "def_interception_rate": safe_rate(passes["interception"]),
            "def_fumble_forced_rate": safe_rate(g["fumble"]),
            "def_fumble_recovery_rate": safe_rate(g["fumble_lost"]),

            "def_td_allowed_rate": safe_rate(g["touchdown"]),
            "def_pass_td_allowed_rate": safe_rate(passes["pass_touchdown"]),
            "def_rush_td_allowed_rate": safe_rate(rushes["rush_touchdown"]),

            "def_explosive_allowed_rate": (
                len(explosives) / len(g)
                if len(g) else np.nan
            ),

            "def_third_down_allowed_rate": (
                float(third["third_down_converted"].sum()) / len(third)
                if len(third) else np.nan
            ),

            "def_fourth_down_allowed_rate": (
                float(fourth["fourth_down_converted"].sum()) / len(fourth)
                if len(fourth) else np.nan
            ),

            "def_redzone_epa_allowed": safe_mean(rz["epa"]),
            "def_redzone_success_allowed": safe_rate(rz["success"]),
            "def_redzone_td_allowed_rate": safe_rate(rz["touchdown"]),

            "def_first_down_allowed_rate": safe_rate(g["first_down"]),
        })

    return pd.DataFrame(rows).set_index("team")


def special_teams_metrics(df: pd.DataFrame) -> pd.DataFrame:
    rows = []

    teams = sorted(
        set(df["home_team"].dropna())
        | set(df["away_team"].dropna())
    )

    for team in teams:
        team_plays = df[
            (df["posteam"] == team)
            | (df["home_team"] == team)
            | (df["away_team"] == team)
        ].copy()

        punts = team_plays[
            (team_plays["posteam"] == team)
            & (team_plays["punt_attempt"] == 1)
        ]

        kickoffs = team_plays[
            (team_plays["posteam"] == team)
            & (team_plays["kickoff_attempt"] == 1)
        ]

        rows.append({
            "team": team,

            "st_punt_inside20_rate": (
                safe_rate(punts["punt_inside_twenty"])
                if len(punts) else np.nan
            ),

            "st_punt_block_rate": (
                safe_rate(punts["punt_blocked"])
                if len(punts) else np.nan
            ),

            "st_kickoff_inside20_rate": (
                safe_rate(kickoffs["kickoff_inside_twenty"])
                if len(kickoffs) else np.nan
            ),

            "st_kickoff_oob_rate": (
                safe_rate(kickoffs["kickoff_out_of_bounds"])
                if len(kickoffs) else np.nan
            ),
        })

    return pd.DataFrame(rows).set_index("team")


def build_team_metrics(df: pd.DataFrame) -> pd.DataFrame:
    offense = offense_metrics(df)
    defense = defense_metrics(df)
    special = special_teams_metrics(df)

    combined = offense.join(defense, how="outer")
    combined = combined.join(special, how="outer")

    return combined.sort_index()


def blend_seasons(
    prior: pd.DataFrame,
    current: pd.DataFrame,
    prior_weight: float = 0.80,
    current_weight: float = 0.20,
) -> pd.DataFrame:

    teams = sorted(set(prior.index) | set(current.index))
    columns = sorted(set(prior.columns) | set(current.columns))

    out = pd.DataFrame(index=teams, columns=columns, dtype=float)

    for team in teams:
        for col in columns:

            p = prior.at[team, col] if (
                team in prior.index and col in prior.columns
            ) else np.nan

            c = current.at[team, col] if (
                team in current.index and col in current.columns
            ) else np.nan

            if pd.notna(p) and pd.notna(c):
                out.at[team, col] = (
                    prior_weight * float(p)
                    + current_weight * float(c)
                )

            elif pd.notna(c):
                out.at[team, col] = float(c)

            elif pd.notna(p):
                out.at[team, col] = float(p)

            else:
                out.at[team, col] = np.nan

    return out


def build_week2_feature_table():
    pbp_2025 = load_pbp(2025)
    pbp_2026 = load_pbp(2026)

    # Only information available before Week 2.
    pbp_2026 = pbp_2026[pbp_2026["week"] < 2].copy()

    metrics_2025 = build_team_metrics(pbp_2025)
    metrics_2026 = build_team_metrics(pbp_2026)

    blended = blend_seasons(
        metrics_2025,
        metrics_2026,
        prior_weight=0.80,
        current_weight=0.20,
    )

    return {
        "prior_2025": metrics_2025,
        "current_2026": metrics_2026,
        "blended": blended,
    }
