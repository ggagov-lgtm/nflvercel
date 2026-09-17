import requests
BASE='https://site.api.espn.com/apis/site/v2/sports/football/nfl'

def scoreboard(year=None, week=None):
    params={}
    if year: params['dates']=str(year)
    if week: params.update({'week':week,'seasontype':2})
    r=requests.get(f'{BASE}/scoreboard',params=params,timeout=20); r.raise_for_status(); return r.json()

def teams():
    r=requests.get(f'{BASE}/teams',timeout=20); r.raise_for_status(); return r.json()

def odds(event_id):
    url=f'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{event_id}/competitions/{event_id}/odds'
    r=requests.get(url,timeout=20); r.raise_for_status(); return r.json()

def parse_games(data):
    out=[]
    for e in data.get('events',[]):
        c=e['competitions'][0]; comps=c['competitors']; home=next(x for x in comps if x['homeAway']=='home'); away=next(x for x in comps if x['homeAway']=='away')
        def t(x):
            tm=x['team']; return {'name':tm.get('displayName'),'abbr':tm.get('abbreviation'),'logo':tm.get('logo'),'score':x.get('score')}
        out.append({'event_id':e['id'],'date':e['date'],'status':e['status']['type'].get('description'),'completed':e['status']['type'].get('completed',False),'home':t(home),'away':t(away)})
    return out
