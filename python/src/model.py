import math, numpy as np

def american_implied(odds):
    if odds is None: return None
    odds=float(odds)
    return (-odds)/(-odds+100) if odds<0 else 100/(odds+100)

def run_game(home_ml=None, away_ml=None, spread=0.0, total=44.0, sims=50000, seed=42):
    # Market-anchored baseline. Upgrade point for historical feature-trained model.
    hp=american_implied(home_ml); ap=american_implied(away_ml)
    if hp and ap:
        s=hp+ap; hp/=s
    else:
        hp=1/(1+math.exp(-(-float(spread or 0))/6.5))
    margin=-float(spread or 0)
    total=float(total or 44.0)
    home_mu=(total+margin)/2; away_mu=(total-margin)/2
    rng=np.random.default_rng(seed)
    # correlated scoring environment + team residuals
    env=rng.normal(0,4.0,sims)
    hs=np.maximum(0,np.rint(home_mu+env+rng.normal(0,7.0,sims))).astype(int)
    aws=np.maximum(0,np.rint(away_mu+env+rng.normal(0,7.0,sims))).astype(int)
    ties=hs==aws
    if ties.any(): hs[ties]+=rng.binomial(1,.5,ties.sum()); aws[ties]+=1-(hs[ties]>aws[ties])
    margins=hs-aws; totals=hs+aws
    return {'home_win_prob':float((margins>0).mean()),'pred_home':float(hs.mean()),'pred_away':float(aws.mean()),'model_margin':float(margins.mean()),'model_total':float(totals.mean()),'home_cover_prob':float((margins+float(spread or 0)>0).mean()),'over_prob':float((totals>total).mean()),'sims':sims}
