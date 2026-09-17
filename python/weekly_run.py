import os,argparse,datetime as dt,requests
from supabase import create_client
from src.espn import scoreboard,parse_games,odds
from src.model import run_game
DB=create_client(os.environ['SUPABASE_URL'],os.environ['SUPABASE_SECRET_KEY'])
def market(eid):
 try:
  x=(odds(eid).get('items') or [])[0];return {'provider':x.get('provider',{}).get('name','ESPN'),'spread':x.get('spread'),'total':x.get('overUnder'),'home_ml':x.get('homeTeamOdds',{}).get('moneyLine'),'away_ml':x.get('awayTeamOdds',{}).get('moneyLine')}
 except Exception as e:
  DB.table('system_health').insert({'service':'ESPN Odds','status':'ERROR','message':str(e)[:500]}).execute();return {'provider':'N/A','spread':0.0,'total':44.0,'home_ml':None,'away_ml':None}
def run(season,week):
 games=parse_games(scoreboard(season,week));count=0
 DB.table('system_health').insert({'service':'ESPN Schedule','status':'OK','message':f'{len(games)} games retrieved'}).execute()
 for g in games:
  m=market(g['event_id']);x=run_game(m['home_ml'],m['away_ml'],m['spread'] or 0,m['total'] or 44,50000,seed=int(g['event_id'])%2147483647)
  row={'season':season,'week':week,'event_id':g['event_id'],'game':g,'market':m,'model':x,'model_version':'v1.0.0','locked_at':dt.datetime.now(dt.timezone.utc).isoformat()}
  DB.table('predictions').upsert(row,on_conflict='season,week,event_id').execute();count+=1
 DB.table('pipeline_runs').insert({'status':'OK','message':f'{count} games processed for {season} Week {week}'}).execute();print(row['model_version'],count)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--season',type=int,required=True);p.add_argument('--week',type=int,required=True);a=p.parse_args();run(a.season,a.week)
