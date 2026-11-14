import { z } from "zod";
import type { Fetcher } from "../shared/http";
import { OperationalError } from "../shared/errors";
import { shiftDay } from "./parser";
import type {
  Completion,
  CreateDelivery,
  Delivery,
  DeliveryConnection,
} from "./types";

const text = z.string().min(1);
const fieldsSchema = z
  .object({
    "Delivery ID": text,
    Product: z.array(text).length(1),
    "Product ID": text.regex(/^A-[1-9]\d*$/),
    "Scheduled At": z.iso.datetime({ offset: true }),
    "Registered At": z.iso.datetime({ offset: true }),
    "Schedule Type": z.enum(["Immediate", "Scheduled"]),
    "Responsible User ID": text,
    "Responsible Name": text,
    "Source Group ID": text,
    "Source Message ID": text,
    "Source Event ID": text,
    "Source Quote Token": text.nullish(),
    Status: z.enum(["Pending", "Done"]),
    "Completed At": z.iso.datetime({ offset: true }).nullish(),
    "Completed By User ID": text.nullish(),
    "Completed By Name": text.nullish(),
  })
  .superRefine((f, ctx) => {
    if (!Number.isSafeInteger(Number(f["Product ID"].slice(2))))
      ctx.addIssue({ code: "custom", message: "Invalid product ID" });
  });
const rowSchema = z.object({
  id: text,
  fields: z.record(z.string(), z.unknown()),
});
const pageSchema = z.object({
  records: z.array(rowSchema),
  offset: text.optional(),
});
function parseDelivery(value: unknown): Delivery {
  const row = rowSchema.parse(value),
    f = fieldsSchema.parse(row.fields);
  return {
    id: f["Delivery ID"],
    recordId: row.id,
    productRecordId: f.Product[0]!,
    productId: f["Product ID"],
    scheduledAt: new Date(f["Scheduled At"]).toISOString(),
    registeredAt: new Date(f["Registered At"]).toISOString(),
    scheduleType: f["Schedule Type"],
    responsibleUserId: f["Responsible User ID"],
    responsibleName: f["Responsible Name"],
    sourceGroupId: f["Source Group ID"],
    sourceMessageId: f["Source Message ID"],
    sourceEventId: f["Source Event ID"],
    quoteToken: f["Source Quote Token"] ?? null,
    status: f.Status,
    completedAt: f["Completed At"]
      ? new Date(f["Completed At"]).toISOString()
      : null,
    completedByUserId: f["Completed By User ID"] ?? null,
    completedByName: f["Completed By Name"] ?? null,
  };
}
// Formula values are not URL escaping: escape Airtable's quoted string syntax first.
const literal = (value: string) =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const dayFilter = (day: string) =>
  `AND({Scheduled At}>=DATETIME_PARSE(${literal(day + "T00:00:00+07:00")}),{Scheduled At}<DATETIME_PARSE(${literal(shiftDay(day, 1) + "T00:00:00+07:00")}))`;
export function createMessengerAirtable(config: {
  connection: DeliveryConnection;
  token: string;
  fetch: Fetcher;
}) {
  const base = `https://api.airtable.com/v0/${encodeURIComponent(config.connection.baseId)}`;
  const table = config.connection.deliveriesTableId;
  async function request(
    tableId: string,
    suffix: string,
    init?: RequestInit,
  ): Promise<unknown> {
    try {
      const response = await config.fetch(
        `${base}/${encodeURIComponent(tableId)}${suffix}`,
        {
          ...init,
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
          },
        },
      );
      if (response.status === 404 && !init) return null;
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new OperationalError(
        "messenger_airtable_failed",
        "Airtable messenger request failed",
        true,
      );
    }
  }
  async function rows(tableId: string, formula: string) {
    const result: z.infer<typeof rowSchema>[] = [];
    const seen = new Set<string>();
    let offset: string | undefined;
    do {
      const query = new URLSearchParams({ filterByFormula: formula });
      if (offset) query.set("offset", offset);
      const page = pageSchema.parse(await request(tableId, "?" + query));
      result.push(...page.records);
      offset = page.offset;
      if (offset && seen.has(offset))
        throw new Error("Repeated Airtable offset");
      if (offset) seen.add(offset);
    } while (offset);
    return result;
  }
  async function unique(formula: string): Promise<Delivery | null> {
    const found = await rows(table, formula);
    if (found.length > 1) throw new Error("Duplicate messenger delivery");
    return found.length ? parseDelivery(found[0]) : null;
  }
  return {
    async findProduct(productId: string) {
      const found = await rows(
        config.connection.productsTableId,
        `{Product ID}=${literal(productId)}`,
      );
      if (found.length > 1) throw new Error("Duplicate product ID");
      return found[0] ? { recordId: found[0].id } : null;
    },
    findBySourceEvent(eventId: string) {
      return unique(`{Source Event ID}=${literal(eventId)}`);
    },
    findDuplicate(groupId: string, day: string, productId: string) {
      return unique(
        `AND({Source Group ID}=${literal(groupId)},{Product ID}=${literal(productId)},${dayFilter(day)})`,
      );
    },
    async get(recordId: string) {
      const raw = await request(table, "/" + encodeURIComponent(recordId));
      return raw === null ? null : parseDelivery(raw);
    },
    async list(groupId: string, day: string) {
      const found = (
        await rows(
          table,
          `AND({Source Group ID}=${literal(groupId)},${dayFilter(day)})`,
        )
      ).map(parseDelivery);
      if (
        new Set(found.map((d) => d.id)).size !== found.length ||
        new Set(found.map((d) => d.productId)).size !== found.length
      )
        throw new Error("Duplicate messenger delivery");
      return found;
    },
    async create(d: CreateDelivery) {
      const fields = {
        "Delivery ID": d.id,
        Product: [d.productRecordId],
        "Product ID": d.productId,
        "Scheduled At": d.scheduledAt,
        "Registered At": d.registeredAt,
        "Schedule Type": d.scheduleType,
        "Responsible User ID": d.responsibleUserId,
        "Responsible Name": d.responsibleName,
        "Source Group ID": d.sourceGroupId,
        "Source Message ID": d.sourceMessageId,
        "Source Event ID": d.sourceEventId,
        ...(d.quoteToken ? { "Source Quote Token": d.quoteToken } : {}),
        Status: "Pending",
      };
      return parseDelivery(
        await request(table, "", {
          method: "POST",
          body: JSON.stringify({ fields }),
        }),
      );
    },
    async complete(recordId: string, c: Completion) {
      return parseDelivery(
        await request(table, "/" + encodeURIComponent(recordId), {
          method: "PATCH",
          body: JSON.stringify({
            fields: {
              Status: "Done",
              "Completed At": c.at,
              "Completed By User ID": c.userId,
              "Completed By Name": c.name,
            },
          }),
        }),
      );
    },
  };
}
