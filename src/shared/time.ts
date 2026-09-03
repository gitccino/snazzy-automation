export type Clock = { now(): Date };

const BANGKOK_OFFSET_MINUTES = 7 * 60;

export function nowBangkokIso(clock: Clock): string {
  const utc = clock.now();
  const shifted = new Date(utc.getTime() + BANGKOK_OFFSET_MINUTES * 60_000);
  const iso = shifted.toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}+07:00`;
}

export function bangkokDateTimeThai(clock: Clock): string {
  const parts = new Intl.DateTimeFormat(
    "th-TH-u-ca-buddhist-nu-latn",
    {
      timeZone: "Asia/Bangkok",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  ).formatToParts(clock.now());
  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("day")} ${value("month")} ${value("year")} ${value("hour")}:${value("minute")}`;
}

export function expiryFromNow(minutes: number, clock: Clock): string {
  const utc = new Date(clock.now().getTime() + minutes * 60_000);
  return utc.toISOString();
}

export function isPast(iso: string, clock: Clock): boolean {
  return clock.now().getTime() > new Date(iso).getTime();
}
