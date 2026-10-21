import type { WorkflowStep } from "cloudflare:workers";
import { expect, it, vi } from 'vitest';
import { runMutationFollowup } from '../../src/line/mutation-followup-workflow';

it('keeps all bounded checks after early unchanged results and does not warn on successful repair', async () => {
  let time = 0;
  const checked: number[] = [];
  const notify = vi.fn();
  const step = {
    do: async (_name: string, opts: unknown, fn?: () => unknown) => await (typeof opts === 'function' ? opts() : fn!()),
    sleepUntil: async (_name: string, date: Date) => {time = Math.max(time,date.getTime());},
  };
  await runMutationFollowup(step as unknown as WorkflowStep, {
    check:async()=>{checked.push(time);return {status:checked.length===3?'repaired':'unchanged'} as const;},
    notify, markEnded:vi.fn(), now:()=>time,
  });
  expect(checked).toEqual([30000,60000,300000]);
  expect(notify).not.toHaveBeenCalled();
});

it('records unresolved monitoring and attempts only one diagnostic notification', async () => {
  const calls: string[] = [];
  const step = {do:async (_n:string,o:unknown,f?:()=>unknown)=>await(typeof o==='function'?o():f!()),sleepUntil:vi.fn()};
  await runMutationFollowup(step as unknown as WorkflowStep, {check:async()=>({status:'busy'}),notify:async()=>{calls.push('notice');},
    markEnded:async state=>{calls.push(state);},now:()=>0});
  expect(calls).toEqual(['unresolved','notice']);
});

it('continues after an exhausted check failure and uses the original registration time', async () => {
  let currentTime=90000;
  let checks=0;
  const dates:number[]=[];
  const step={do:async (_n:string,o:unknown,f?:()=>unknown)=>await(typeof o==='function'?o():f!()),sleepUntil:async (_n:string,date:Date)=>{dates.push(date.getTime());currentTime=Math.max(currentTime,date.getTime());}};
  const markEnded=vi.fn();
  await runMutationFollowup(step as unknown as WorkflowStep,{
    registeredAt:0,now:()=>currentTime,check:async()=>{checks++;if(checks===1)throw Error('exhausted outage');return {status:'unchanged'};},
    notify:vi.fn(),markEnded,
  });
  expect(dates).toEqual([30000,60000,300000]);
  expect(checks).toBe(3);
  expect(markEnded).toHaveBeenCalledWith('ended');
});
