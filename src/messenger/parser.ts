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
    body.matchAll(
      /แมสเลย(?:ค่า)?|วันนี้|พรุ่งนี้|(?<![\p{L}\p{N}])แมส(?=\s+\d{1,2}[.:]\d{2}(?!\S))/gu,
    ),
  );
  if (
    schedules.length > 1 ||
    (schedules.length > 0 && /^\s*\d{1,2}[.:]\d{2}(?!\S)/.test(body))
  )
    return invalid;
  const schedule = schedules[0];
  const scheduleText = schedule ? body.slice(schedule.index) : body.trimStart();
  // Read one time from the schedule line, never from pasted contact/address lines.
  if (
    !schedule?.[0].startsWith("แมสเลย") &&
    Array.from(
      scheduleText
        .split(/\r?\n/, 1)[0]!
        .matchAll(/(?<!\S)\d{1,2}[.:]\d{2}(?!\S)/g),
    ).length !== 1
  )
    return invalid;
  if (schedule?.[0].startsWith("แมสเลย"))
    return {
      ok: true,
      command: {
        type: "mess-register",
        productId: ids[0]![0],
        scheduledAt: new Date(eventTimestamp).toISOString(),
        scheduleType: "Immediate",
      },
    };
  const time = /^(?:(วันนี้|พรุ่งนี้|แมส)\s+)?(\d{1,2})[.:](\d{2})(?!\S)/.exec(
    scheduleText,
  );
  if (!time || Number(time[2]) > 23 || Number(time[3]) > 59) return invalid;
  const day = time[1] === "พรุ่งนี้" ? shiftDay(today, 1) : today;
  return {
    ok: true,
    command: {
      type: "mess-register",
      productId: ids[0]![0],
      scheduledAt: new Date(
        `${day}T${time[2]!.padStart(2, "0")}:${time[3]}:00+07:00`,
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
