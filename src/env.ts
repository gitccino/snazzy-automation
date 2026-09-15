export type { Clock } from "./shared/time";
export type IdGenerator = { next(): string };
export type Fetcher = typeof fetch;

export interface Env {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  IMPORT_WORKFLOW: Workflow<{ importRunId: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin" }>;
  AIRTABLE_TOKEN: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  ASSET_URL_SIGNING_SECRET: string;
  ADMIN_ROUTE_TOKEN: string;
  APP_CONFIG_JSON: string;
}
