import type {
  CreateDelivery,
  Delivery,
  DeliveryConnection,
} from "../../src/messenger/types";
export const connection: DeliveryConnection = {
  baseId: "app1",
  productsTableId: "tblProducts",
  deliveriesTableId: "tblMess",
};
export const input: CreateDelivery = {
  id: "delivery-1",
  productRecordId: "recProduct",
  productId: "A-2",
  scheduledAt: "2026-11-14T02:00:00.000Z",
  registeredAt: "2026-11-14T01:00:00.000Z",
  scheduleType: "Scheduled",
  responsibleUserId: "Ustaff",
  responsibleName: "เจ",
  sourceGroupId: "C1",
  sourceMessageId: "m1",
  sourceEventId: "e1",
  quoteToken: "private-quote",
};
export const delivery: Delivery = {
  ...input,
  recordId: "rec1",
  status: "Pending",
  completedAt: null,
  completedByUserId: null,
  completedByName: null,
};
export function record(d: Delivery = delivery) {
  return {
    id: d.recordId,
    fields: {
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
      "Source Quote Token": d.quoteToken,
      Status: d.status,
      ...(d.completedAt
        ? {
            "Completed At": d.completedAt,
            "Completed By User ID": d.completedByUserId,
            "Completed By Name": d.completedByName,
          }
        : {}),
    },
  };
}
