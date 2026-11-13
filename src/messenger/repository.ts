import type {
  ActionBinding,
  Completion,
  CompletionIntent,
  CreateDelivery,
  DeliveryConnection,
  RegistrationIntent,
} from "./types";

type Row = {
  id: string;
  payload_json: string;
  phase: "prepared" | "dispatched" | "observed";
  record_id: string | null;
};
const connectionKey = (c: DeliveryConnection) => [
  c.baseId,
  c.productsTableId,
  c.deliveriesTableId,
];
const registrationKey = (
  c: DeliveryConnection,
  g: string,
  day: string,
  productId: string,
) => JSON.stringify(["register", ...connectionKey(c), g, day, productId]);
const sourceKey = (c: DeliveryConnection, eventId: string) =>
  JSON.stringify([...connectionKey(c), eventId]);
const completionKey = (c: DeliveryConnection, recordId: string) =>
  JSON.stringify(["complete", ...connectionKey(c), recordId]);
const registrationIntent = (row: Row): RegistrationIntent => ({
  ...JSON.parse(row.payload_json),
  id: row.id,
  phase: row.phase,
  recordId: row.record_id,
});
const completionIntent = (row: Row): CompletionIntent => ({
  ...JSON.parse(row.payload_json),
  id: row.id,
  phase: row.phase,
});
export function createMessengerRepository(db: D1Database) {
  async function claim(
    kind: "registration" | "completion",
    businessKey: string,
    sourceKey: string | null,
    payload: object,
  ) {
    const id = crypto.randomUUID();
    const inserted = await db
      .prepare(
        "INSERT OR IGNORE INTO messenger_write_intents (id,kind,business_key,source_key,payload_json) VALUES (?,?,?,?,?)",
      )
      .bind(id, kind, businessKey, sourceKey, JSON.stringify(payload))
      .run();
    const row = await db
      .prepare(
        "SELECT id,payload_json,phase,record_id FROM messenger_write_intents WHERE business_key=? OR (source_key IS NOT NULL AND source_key=?)",
      )
      .bind(businessKey, sourceKey)
      .first<Row>();
    if (!row) throw new Error("Messenger intent unavailable");
    return { created: inserted.meta.changes === 1, row };
  }
  return {
    async findRegistration(
      connection: DeliveryConnection,
      groupId: string,
      day: string,
      productId: string,
      eventId: string,
    ): Promise<RegistrationIntent | null> {
      const row = await db
        .prepare(
          "SELECT id,payload_json,phase,record_id FROM messenger_write_intents WHERE business_key=? OR source_key=?",
        )
        .bind(
          registrationKey(connection, groupId, day, productId),
          sourceKey(connection, eventId),
        )
        .first<Row>();
      return row ? registrationIntent(row) : null;
    },
    async findCompletion(
      connection: DeliveryConnection,
      recordId: string,
    ): Promise<CompletionIntent | null> {
      const row = await db
        .prepare(
          "SELECT id,payload_json,phase,record_id FROM messenger_write_intents WHERE business_key=?",
        )
        .bind(completionKey(connection, recordId))
        .first<Row>();
      return row ? completionIntent(row) : null;
    },
    async claimRegistration(input: {
      delivery: CreateDelivery;
      connection: DeliveryConnection;
      day: string;
    }) {
      const { delivery: d, connection: c, day } = input;
      const { created, row } = await claim(
        "registration",
        registrationKey(c, d.sourceGroupId, day, d.productId),
        sourceKey(c, d.sourceEventId),
        input,
      );
      const intent = registrationIntent(row);
      return { created, intent };
    },
    async claimCompletion(input: {
      deliveryId: string;
      recordId: string;
      groupId: string;
      connection: DeliveryConnection;
      completion: Completion;
    }) {
      const { created, row } = await claim(
        "completion",
        completionKey(input.connection, input.recordId),
        null,
        input,
      );
      const intent = completionIntent(row);
      return { created, intent };
    },
    async beginDispatch(id: string) {
      return (
        (
          await db
            .prepare(
              "UPDATE messenger_write_intents SET phase='dispatched' WHERE id=? AND phase='prepared'",
            )
            .bind(id)
            .run()
        ).meta.changes === 1
      );
    },
    async recordObserved(id: string, recordId: string) {
      await db
        .prepare(
          "UPDATE messenger_write_intents SET phase='observed',record_id=? WHERE id=? AND (record_id IS NULL OR record_id=?)",
        )
        .bind(recordId, id, recordId)
        .run();
    },
    async putAction(binding: ActionBinding) {
      await db
        .prepare(
          "INSERT INTO messenger_action_tokens (token,binding_json) VALUES (?,?)",
        )
        .bind(binding.token, JSON.stringify(binding))
        .run();
    },
    async getAction(token: string): Promise<ActionBinding | null> {
      const row = await db
        .prepare(
          "SELECT binding_json FROM messenger_action_tokens WHERE token=?",
        )
        .bind(token)
        .first<{ binding_json: string }>();
      return row ? JSON.parse(row.binding_json) : null;
    },
  };
}
