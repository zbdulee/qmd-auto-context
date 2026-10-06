"""A one-card completion cannot consume another card's source delta."""
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, 'core')
import wiki_topical as topical
import wiki_topical_backend as backend
import wiki_topical_experiment as experiment
import wiki_topical_publish as publisher
import wiki_topical_reconcile as reconcile

with tempfile.TemporaryDirectory(prefix='qmd-two-card-batch-') as name:
    root=Path(name).resolve()
    (root/topical.MARKER).write_text('synthetic only\n')
    sources=root/'sources';sources.mkdir()
    def card(card_id, source):
        quote=(sources/source).read_text().strip()
        revision=topical.source_snapshot(root,'sources/'+source,{})[0]
        return {'cardId':card_id,'title':card_id,'category':'world-rule',
            'details':'','claims':[{'claimId':'fact','statement':quote,
            'state':'rule','timeScope':'chapter-1','condition':'','evidence':[{
                'sourcePath':'sources/'+source,'sourceRevisionSha256':revision['sha256'],
                'startLine':1,'endLine':1,'quoteAnchor':quote,
                'quoteSha256':topical.digest(quote.encode())}]}]}
    def staged(card_id, source):
        result=backend.stage_generation_response(root,{'schema':topical.SCHEMA,
            'cards':[card(card_id,source)]})
        return result['generationId'],experiment.load_staged_card(root,result['generationId'],card_id)
    (sources/'a.md').write_text('Amber dawn.\n')
    (sources/'b.md').write_text('Silver dusk.\n')
    _gid_a,old_a=staged('amber','a.md')
    _gid_b,old_b=staged('silver','b.md')
    reconcile.reconcile(root,['sources'],[old_a,old_b],
        trusted_card_ids=['amber','silver'])
    (sources/'a.md').write_text('Amber noon.\n')
    (sources/'b.md').write_text('Silver midnight.\n')
    batch=reconcile.start_batch(root,['sources'],[old_a,old_b],
        trusted_card_ids=['amber','silver'])['batch']
    new_gid_a,new_a=staged('amber','a.md')
    previous=(publisher._attested,publisher.publish,publisher.sync)
    publisher._attested=lambda *args: {'status':'backend_pass'}
    publisher.publish=lambda *args: {'status':'published_verified'}
    publisher.sync=lambda *args,**kwargs: {'status':'ready'}
    try:
        first=reconcile.finish_backend_batch(root,['sources'],batch['batchId'],
            new_gid_a,[new_a],old_card_id='amber',settled_paths=['sources/a.md'])
        state=reconcile._read(root)
        assert first['pending']==1 and set(state['queue'])=={'sources/b.md'}
        assert set(state['projection'])=={'amber','silver'}
        assert state['projection']['amber']['state']=='eligible_existing_attestation'
        assert state['projection']['silver']['state']=='excluded_stale'
        second_batch=reconcile.start_batch(root,['sources'],[new_a,old_b],
            trusted_card_ids=['amber','silver'])['batch']
        new_gid_b,new_b=staged('silver','b.md')
        second=reconcile.finish_backend_batch(root,['sources'],second_batch['batchId'],
            new_gid_b,[new_b],old_card_id='silver',settled_paths=['sources/b.md'])
        state=reconcile._read(root)
        assert second['pending']==0 and not state['queue']
        assert set(state['projection'])=={'amber','silver'}
        assert all(row['state']=='eligible_existing_attestation'
                   for row in state['projection'].values())
    finally:
        publisher._attested,publisher.publish,publisher.sync=previous
    print(json.dumps({'otherCardQueuePreserved':True,'twoCardSettlement':True,
                      'externalCalls':0}))
