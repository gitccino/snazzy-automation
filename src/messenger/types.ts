export type MessengerCommand =
  | {
      type: "mess-register";
      productId: string;
      scheduledAt: string;
      scheduleType: "Immediate" | "Scheduled";
    }
  | { type: "mess-overview"; day: string; page: number };
export type MessengerInput =
  | { ok: true; command: MessengerCommand }
  | { ok: false; code: "invalid_messenger_command" };
export type DeliveryConnection = {
  baseId: string;
  productsTableId: string;
  deliveriesTableId: string;
};
export interface Delivery {
  id: string;
  recordId: string;
  productRecordId: string;
  productId: string;
  scheduledAt: string;
  registeredAt: string;
  scheduleType: "Immediate" | "Scheduled";
  responsibleUserId: string;
  responsibleName: string;
  sourceGroupId: string;
  sourceMessageId: string;
  sourceEventId: string;
  quoteToken: string | null;
  status: "Pending" | "Done";
  completedAt: string | null;
  completedByUserId: string | null;
  completedByName: string | null;
}
export type CreateDelivery = Omit<
  Delivery,
  | "recordId"
  | "status"
  | "completedAt"
  | "completedByUserId"
  | "completedByName"
>;
export type Completion = { at: string; userId: string; name: string };
export type MessengerAction = { kind: "complete" | "quote"; token: string };
export type ActionBinding = {
  completionCycle?: string | null;
  token: string;
  kind: "complete" | "quote";
  deliveryId: string;
  recordId: string;
  groupId: string;
  day: string;
  page: number;
  connection: DeliveryConnection;
};
export type Overview = {
  day: string;
  page: number;
  total: number;
  done: number;
  items: Delivery[];
  actions: Record<string, { quote: string; complete: string | null }>;
};
export type MessengerResult =
  | { kind: "overview"; overview: Overview }
  | { kind: "text"; text: string }
  | { kind: "quote"; text: string; quoteToken: string };
export type RegistrationIntent = {
  id: string;
  phase: "prepared" | "dispatched" | "observed";
  recordId: string | null;
  delivery: CreateDelivery;
  connection: DeliveryConnection;
  day: string;
};
export type CompletionIntent = {
  previousObservedIntentId?: string | null;
  id: string;
  phase: "prepared" | "dispatched" | "observed";
  recordId: string;
  deliveryId: string;
  groupId: string;
  connection: DeliveryConnection;
  completion: Completion;
};
export interface MessengerDeps {
  connection: DeliveryConnection;
  airtable: ReturnType<typeof import("./airtable").createMessengerAirtable>;
  repo: ReturnType<typeof import("./repository").createMessengerRepository>;
  clock: import("../shared/time").Clock;
  ids: import("../shared/ids").IdGenerator;
  profile(groupId: string, userId: string): Promise<{ displayName: string }>;
  currentPolicy(): Promise<{
    allowedGroupIds: string[];
    completionUserIds: string[];
    connection: DeliveryConnection | null;
  }>;
}
