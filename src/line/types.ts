import { z } from "zod";

export type ParsedCommand =
  | { type: "help" }
  | { type: "search"; productId: string }
  | { type: "upload" }
  | { type: "docs"; publicationDate?: string }
  | { type: "soldout"; productId: string; soldPrice: number }
  | { type: "revert" };

export type ParseErrorCode =
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
  inventoryStatus: "In" | "Out";
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
export type PendingCommandStatus = "pending" | "applying" | "approved" | "rejected" | "expired";

export interface PendingLineCommand {
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
  type: "message";
  webhookEventId: string;
  replyToken: string;
  source: { type: "group"; groupId: string; userId: string };
  message: { type: "text"; id: string; text: string };
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
    message: z.object({ type: z.literal("text"), id: z.string().min(1), text: z.string() }),
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
