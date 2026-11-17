import type { SupportedLineEvent } from "../line/types";
import type { MessengerInput } from "./types";
const invalid: MessengerInput = {
  ok: false,
  code: "invalid_messenger_command",
};
export function bangkokDay(timestamp: number): string {
  return new Date(timestamp + 7 * 3600_000).toISOString().slice(0, 10);
}
export function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * 86400_000)
    .toISOString()
    .slice(0, 10);
}
export function validDay(day: string): boolean {
  const d = new Date(day + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day;
}
export function parseMessengerCommand(
  text: string,
  eventTimestamp: number,
): MessengerInput | null {
  text = text.trim();
  if (!/^\/mess(?:-overview)?(?:\s|$)/.test(text)) return null;
  if (
    !Number.isSafeInteger(eventTimestamp) ||
    eventTimestamp < 0 ||
    !Number.isFinite(new Date(eventTimestamp).getTime())
  )
    return invalid;
  const today = bangkokDay(eventTimestamp);
  if (/^\/mess-overview(?:\s|$)/.test(text)) {
    const m = /^\/mess-overview(?:\s+([1-9]\d*))?$/.exec(text);
    if (!m) return invalid;
    const page = Number(m[1] ?? 1);
    return Number.isSafeInteger(page)
      ? { ok: true, command: { type: "mess-overview", day: today, page } }
      : invalid;
  }
  const body = text.slice(5);
  const ids = Array.from(body.matchAll(/(?<![A-Za-z0-9])A-\S+/gi));
  if (
    ids.length !== 1 ||
    !/^A-[1-9]\d*$/.test(ids[0]![0]) ||
    !Number.isSafeInteger(Number(ids[0]![0].slice(2)))
  )
    return invalid;
  const schedules = Array.from(
    body.matchAll(/แมสเลย(?:ค่า)?|วันนี้|พรุ่งนี้/g),
  );
  if (schedules.length > 1) return invalid;
  // Match standalone times so full phone numbers and dotted fragments are not time candidates.
  const times = Array.from(
    body.matchAll(/(?<!\S)([0-9]{1,2})[.:]([0-9]{2})(?!\S)/g),
  );
  if (schedules[0]?.[0].startsWith("แมสเลย")) {
    if (times.length) return invalid;
    return {
      ok: true,
      command: {
        type: "mess-register",
        productId: ids[0]![0],
        scheduledAt: new Date(eventTimestamp).toISOString(),
        scheduleType: "Immediate",
      },
    };
  }
  if (times.length !== 1) return invalid;
  const time = times[0]!;
  if (Number(time[1]) > 23 || Number(time[2]) > 59) return invalid;
  const day = schedules[0]?.[0] === "พรุ่งนี้" ? shiftDay(today, 1) : today;
  return {
    ok: true,
    command: {
      type: "mess-register",
      productId: ids[0]![0],
      scheduledAt: new Date(
        `${day}T${time[1]!.padStart(2, "0")}:${time[2]}:00+07:00`,
      ).toISOString(),
      scheduleType: "Scheduled",
    },
  };
}
export function sanitizeMessengerEvent(
  event: SupportedLineEvent,
): SupportedLineEvent {
  if (event.type !== "message" || event.messenger) return event;
  const messenger = parseMessengerCommand(
    event.message.text,
    event.timestamp ?? NaN,
  );
  if (!messenger) return event;
  return {
    ...event,
    message: {
      ...event.message,
      text: event.message.text.trim().startsWith("/mess-overview")
        ? "/mess-overview"
        : "/mess",
    },
    messenger,
  };
}
