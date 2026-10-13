"""Settle immutable pregame JSON predictions against official ESPN final scores.
Never regenerate historical predictions or use post-game sportsbook lines.
"""
import json
from pathlib import Path
from src.espn import scoreboard, parse_games
from src.settlement import settle_prediction, summarize_settlements, parse_final_games

ROOT = Path("data")

def main():
    for file in sorted((ROOT / "predictions").glob("*-week-*.json")):
        doc = json.loads(file.read_text(encoding="utf-8"))
        season, week = int(doc["season"]), int(doc["week"])
        predictions = doc.get("predictions", [])
        if not predictions:
            continue
        try:
            games = parse_games(scoreboard(season, week))
            finals = {str(g["event_id"]): g for g in parse_final_games(games)}
        except Exception as exc:
            print(f"Skipping {season} week {week}: ESPN unavailable: {exc}")
            continue
        if not all(str(p["event_id"]) in finals for p in predictions):
            print(f"Week {week}: awaiting all predicted games to become final")
            continue
        settled = [settle_prediction(p, finals[str(p["event_id"])]) for p in predictions]
        summary = summarize_settlements(settled)
        summary.update({"season": season, "week": week})
        # Preserve previously migrated authoritative performance records.
        dest = ROOT / "performance" / f"{season}-week-{week}.json"
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
            print(f"Saved {dest}")
        results_file = ROOT / "results" / f"{season}-week-{week}.json"
        if not results_file.exists():
            results_file.parent.mkdir(parents=True, exist_ok=True)
            results_file.write_text(json.dumps({"season":season,"week":week,"settlements":settled},indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
