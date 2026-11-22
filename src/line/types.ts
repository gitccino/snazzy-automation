import { parseLineCommand } from "./parser";
import type { MessengerInput } from "../messenger/types";
import { z } from "zod";
import type { OperationContext } from "../settings/schema";

export type ParsedCommand =
  | { type: "help" }
  | { type: "report"; reportDate?: string; page: number }
  | { type: "search"; productId: string }
  | { type: "upload" }
  | { type: "testupload"; caseNumber: number | null }
  | { type: "testsearch"; caseNumber: number | null }
  | { type: "testsoldout"; caseNumber: number | null }
  | { type: "testreport"; caseNumber: number | null; page: number }
  | { type: "testdocs"; caseNumber: number | null }
  | { type: "docs"; publicationDate?: string }
  | { type: "soldout"; productId: string; soldPrice: number }
  | { type: "revert" };

export type ParseErrorCode =
  | "invalid_report_command"
  | "unknown_command"
  | "missing_product_id"
  | "invalid_product_id"
  | "multiple_product_ids"
  | "missing_price"
  | "invalid_price"
  | "invalid_publication_date"
  | "multiple_prices";

export type ParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; code: ParseErrorCode };

export interface LineActor {
  userId: string;
  displayName: string;
  groupId: string;
}

export interface SaleValues {
  inventoryStatus: string;
  soldPrice: number | null;
  soldAt: string | null;
  soldBy: string | null;
}

export interface InventoryProduct extends SaleValues {
  recordId: string;
  productId: string;
  uploadDate: string | null;
  airtableUrl: string;
  imageUrl?: string | null;
  brandName?: string | null;
  modelName?: string | null;
}

export type PendingCommandKind = "soldout" | "revert";
export type PendingCommandStatus = "pending" | "applying" | "approved" | "rejected" | "expired" | "failed";

export interface PendingLineCommand {
  context?: OperationContext;
  token: string;
  sourceEventId: string;
  applyEventId: string | null;
  kind: PendingCommandKind;
  status: PendingCommandStatus;
  requesterUserId: string;
  groupId: string;
  productId: string;
  soldPrice: number | null;
  before: SaleValues;
  after: SaleValues;
  targetActionId: string | null;
  expiresAt: string;
}

export interface ReversibleLineAction {
  id: string;
  pendingToken: string;
  groupId: string;
  productId: string;
  kind: "soldout" | "revert";
  before: SaleValues;
  after: SaleValues;
  actor: string;
  correlationId: string;
  createdAt: string;
  revertedByActionId: string | null;
}

export interface LineTextEvent {
  timestamp?: number;
  messenger?: MessengerInput;
  type: "message";
  webhookEventId: string;
  replyToken: string;
  source: { type: "group"; groupId: string; userId: string };
  message: { type: "text"; id: string; text: string; quoteToken?: string };
}

export interface LinePostbackEvent {
  type: "postback";
  webhookEventId: string;
  replyToken: string;
  source: { type: "group"; groupId: string; userId: string };
  postback: { data: string };
}

export type SupportedLineEvent = LineTextEvent | LinePostbackEvent;

const GroupSourceSchema = z.object({
  type: z.literal("group"),
  groupId: z.string().min(1),
  userId: z.string().min(1),
});

const SupportedLineEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    webhookEventId: z.string().min(1),
    replyToken: z.string().min(1),
    source: GroupSourceSchema,
    timestamp: z.number().int().nonnegative().optional(),
    message: z.object({ type: z.literal("text"), id: z.string().min(1), text: z.string(), quoteToken: z.string().min(1).optional() }),
  }),
  z.object({
    type: z.literal("postback"),
    webhookEventId: z.string().min(1),
    replyToken: z.string().min(1),
    source: GroupSourceSchema,
    postback: z.object({ data: z.string().min(1) }),
  }),
]);

export function parseSupportedLineEvents(value: unknown): SupportedLineEvent[] {
  const body = z.object({ events: z.array(z.unknown()) }).parse(value);
  return body.events.flatMap((event) => {
    const parsed = SupportedLineEventSchema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface DailySaleProduct {
  productCost: number | null;
  recordId: string;
  productId: string;
  brandName: string | null;
  modelName: string | null;
  soldPrice: number;
  soldAt: string;
}

export type LineQueueTriggerEvent = {
  type:'queue-trigger'; webhookEventId:string; replyToken:string;
  source:{type:'group';groupId:string}; timestamp?:number;
};
export type LineIngressEvent = SupportedLineEvent | LineQueueTriggerEvent;
export function parseLineIngressEvents(value:unknown):LineIngressEvent[] {
  const body=z.object({events:z.array(z.unknown())}).parse(value);
  const messageSchema=z.object({type:z.literal('message'),webhookEventId:z.string().trim().min(1),replyToken:z.string().trim().min(1),timestamp:z.number().int().nonnegative().optional(),source:z.object({type:z.literal('group'),groupId:z.string().trim().min(1)}),message:z.object({type:z.enum(['text','image','video','audio','file','location','sticker'])})});
  return body.events.flatMap((raw):LineIngressEvent[]=>{
    const supported=SupportedLineEventSchema.safeParse(raw);
    if(supported.success && supported.data.replyToken.trim()) {
      const e=supported.data;
      if(e.type==='postback')return [e];
      const parsed=parseLineCommand(e.message.text);
      if(parsed.ok || parsed.code!=='unknown_command' || /^\/mess(?:-overview)?(?:\s|$)/.test(e.message.text.trim()))return [e];
    }
    const parsed=messageSchema.safeParse(raw);
    if(!parsed.success)return [];
    const e=parsed.data;
    return [{type:'queue-trigger',webhookEventId:e.webhookEventId,replyToken:e.replyToken,source:e.source,...(e.timestamp===undefined?{}:{timestamp:e.timestamp})}];
  });
}
