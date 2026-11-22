import { expect, it } from 'vitest';
import { renderCommandReply } from '../../src/line/reply-renderer';
it('preserves text warnings and source quotes in a single bundle', () => {
  expect(renderCommandReply({kind:'text',text:'hello',recoveryWarning:'warning'},'https://app.test')).toEqual([{type:'text',text:'warning\nhello'}]);
  expect(renderCommandReply({kind:'quoted-text',text:'source',quoteToken:'quote'},'https://app.test')).toEqual([{type:'text',text:'source',quoteToken:'quote'}]);
});
it('preserves long confirmation details losslessly with its actions', () => {
  const details = 'x'.repeat(5001);
  const result = renderCommandReply({kind:'buttons',text:details,approveData:'yes',rejectData:'no'},'https://app.test');
  expect(result.slice(0,-1)).toEqual([{type:'text',text:'x'.repeat(5000)},{type:'text',text:'x'}]);
  expect(result.at(-1)).toMatchObject({type:'template',template:{actions:[{data:'yes'},{data:'no'}]}});
});

import baselineReplies from '../fixtures/line-reply-bundles.json';
import type { CommandReply } from '../../src/line/soldout';
it.each(baselineReplies)('matches expected message objects: $name',({reply,expected})=>{
 expect(renderCommandReply(reply as CommandReply,'https://original-worker.test')).toEqual(expected);
});
