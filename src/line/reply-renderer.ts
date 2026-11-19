import { alreadyOutCard, saleSuccessCard } from './search-card';
import { confirmationCard, revertSuccessCard } from './confirmation-card';
import type { CommandReply } from './soldout';
import type { LineButton } from './client';
import type { LineReplyMessage } from './reply-types';
import { OperationalError } from '../shared/errors';

function addRecoveryWarning(
  contents: Record<string, unknown>,
  warning?: string,
): Record<string, unknown> {
  if (!warning) return contents;
  const body = contents.body as Record<string, unknown> | undefined;
  if (!body || !Array.isArray(body.contents)) return contents;
  return {
    ...contents,
    body: {
      ...body,
      contents: [
        ...body.contents,
        {
          type: "text",
          text: warning,
          size: "xs",
          color: "#FF3344",
          wrap: true,
          margin: "md",
        },
      ],
    },
  };
}

export function renderButtons(altText: string, text: string, buttons: LineButton[]): LineReplyMessage[] {
  const details: LineReplyMessage[] = [];
  const longText = text.length > 160;
  if (longText) for (let offset = 0; offset < text.length;) {
    const chunk = text.slice(offset, offset + 5000).replace(/[\uD800-\uDBFF]$/, '');
    if (details.length === 4 || !chunk.length) throw new OperationalError('line_confirmation_too_long', 'Confirmation exceeds LINE reply capacity', false);
    details.push({ type: 'text', text: chunk }); offset += chunk.length;
  }
  return [...details, { type:'template', altText: altText.slice(0,400).replace(/[\uD800-\uDBFF]$/, ''), template: {
    type:'buttons', text: longText ? 'โปรดตรวจสอบรายละเอียดด้านบน แล้วเลือกยืนยันหรือยกเลิก' : text,
    actions:buttons.map(button=>({type:'postback',label:button.label,data:button.data,displayText:button.label})),
  } }];
}
export function renderCommandReply(reply: CommandReply, publicBaseUrl: string): LineReplyMessage[] {
  const flex = (text:string, contents:Record<string,unknown>):LineReplyMessage[] => [{type:'flex',altText:text.slice(0,1500).replace(/[\uD800-\uDBFF]$/, ''),contents:addRecoveryWarning(contents,reply.recoveryWarning)}];
  if (reply.kind === 'quoted-text') return [{type:'text',text:reply.text,quoteToken:reply.quoteToken}];
  if (reply.kind === 'flex') return flex(reply.text,reply.contents);
  if (reply.kind === 'text') {
    if (reply.alreadyOut) { const card=alreadyOutCard(reply.alreadyOut,publicBaseUrl); return flex(card.text,card.contents); }
    if (reply.revertSuccess) return flex(reply.text,revertSuccessCard(publicBaseUrl));
    if (reply.saleSuccess) { const {productId,soldPrice,product}=reply.saleSuccess; const card=saleSuccessCard(productId,soldPrice,publicBaseUrl,product); return flex(card.text,card.contents); }
    return [{type:'text',text:reply.recoveryWarning ? `${reply.recoveryWarning}\n${reply.text}` : reply.text}];
  }
  if (reply.text.length <= 2000) return flex(reply.text,confirmationCard(reply,publicBaseUrl));
  return renderButtons(reply.text,reply.recoveryWarning ? `${reply.recoveryWarning}\n${reply.text}` : reply.text,[{label:'ยืนยัน',data:reply.approveData},{label:'ยกเลิก',data:reply.rejectData}]);
}
