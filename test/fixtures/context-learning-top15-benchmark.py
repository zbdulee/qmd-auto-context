"""Comparable bounded synthetic policy benchmark, NOT QMD/Laya runtime timing."""
import json,sys,time,statistics
sys.path.insert(0,'core')
from context_learning.pool import expand
from context_learning.selection_metrics import evaluate_selection

def benchmark():
 hits=[dict(file='docs/'+str(i)+'.md',score=1/(i+1)) for i in range(30)]
 reference=[h['file'] for h in hits];necessary=[reference[i] for i in (0,10,13,20)]
 result={'kind':'synthetic-policy-only','qmd_runtime':'not-measured','laya_runtime':'not-measured','reference_scope':'same-30-candidate-fixture','iterations':100,'final_budget':3,'modes':{}}
 for k in (8,15):
  times=[];ids=[]
  for _ in range(100):
   start=time.perf_counter()
   phases,verdict=expand([dict(name='primary',results=hits[:8],wiki_scoped=False,returned_count=30,unbounded_results=hits)],top_k=k,retrieve=lambda p,n:None,prepare=lambda h:None,hard_verdict=lambda h,s:'eligible',fresh_verdict=lambda h,s:'eligible',cutoff=lambda p:0,is_wiki=lambda h:False)
   ids=[h['file'] for p in phases for h in p['results'] if verdict(h,False)=='eligible']
   times.append((time.perf_counter()-start)*1000)
  # Oracle ordering only makes retrieval opportunity visible; it is NOT a Laya prediction.
  oracle_kept=([i for i in ids if i in necessary]+[i for i in ids if i not in necessary])[:3]
  result['modes'][str(k)]={'candidate_count':len(ids),'policy_ms_p50':round(statistics.median(times),4),'policy_ms_p95':round(sorted(times)[94],4),'oracle_selection_only':True,'metrics':evaluate_selection(reference_ids=reference,necessary_ids=necessary,pool_ids=ids,final_ids=oracle_kept,fallback=False)}
 return result
if __name__=='__main__':print(json.dumps(benchmark(),ensure_ascii=False,indent=2))
