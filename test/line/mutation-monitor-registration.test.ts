import {expect,it,vi} from 'vitest';
import {mutationFixture} from '../helpers/line-mutation';
import {registerMutationFollowup} from '../../src/line/mutation-recovery';
import {sequentialIdGenerator} from '../helpers/fakes';

it('reuses an active monitor, rearms a completed monitor, and fences its old completion', async()=>{
  const {pending,mutations}=await mutationFixture();
  let terminal=false;
  const create=vi.fn(async()=>{terminal=false;});
  const deps={mutationRepo:mutations,ids:sequentialIdGenerator('monitor'),now:()=>0,status:async()=>terminal?'terminal' as const:'active' as const,create};
  const params={pendingToken:pending.token,productId:pending.productId};
  await registerMutationFollowup(params,deps);
  const old=(await mutations.context(pending.token))!.monitor_workflow_id!;
  await registerMutationFollowup(params,deps);
  expect((await mutations.context(pending.token))!.monitor_workflow_id).toBe(old);
  terminal=true;
  await registerMutationFollowup(params,deps);
  expect((await mutations.context(pending.token))!.monitor_workflow_id).not.toBe(old);
  await mutations.markMonitoring(pending.token,'ended',old);
  expect((await mutations.context(pending.token))!.monitoring_state).toBe('registered');
  expect(create).toHaveBeenCalledTimes(3);
});

it('keeps registration identity after create fails so retry can safely create the same monitor',async()=>{
  const {pending,mutations}=await mutationFixture();
  const create=vi.fn().mockRejectedValueOnce(Error('outage')).mockResolvedValue(undefined);
  const deps={mutationRepo:mutations,ids:sequentialIdGenerator('monitor'),now:()=>0,status:async()=>create.mock.calls.length > 1 ? 'active' as const : 'unknown' as const,create};
  const params={pendingToken:pending.token,productId:pending.productId};
  await expect(registerMutationFollowup(params,deps)).rejects.toThrow('outage');
  const id=(await mutations.context(pending.token))!.monitor_workflow_id;
  await registerMutationFollowup(params,deps);
  expect(create.mock.calls.map(call=>call[0])).toEqual([id,id]);
});

it('does not release recovery when createBatch skips an ended monitor whose status is unavailable',async()=>{
  const {pending,mutations}=await mutationFixture();
  await mutations.setMonitor(pending.token,null,'retained-ended-monitor');
  await expect(registerMutationFollowup({pendingToken:pending.token,productId:pending.productId},{
    mutationRepo:mutations,ids:sequentialIdGenerator('monitor'),now:()=>0,status:async()=>'unknown',create:async()=>{},
  })).rejects.toThrow('Cannot verify live monitor');
});
