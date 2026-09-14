import type { SourcePhoto } from "../icloud/types";

export interface ImportWorkflowParams {
  importRunId: string;
  sourceAlbumId: string;
  trigger: "cron" | "line" | "admin";
}

export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";

export interface OrphanRange {
  firstApplePhotoId: string;
  lastApplePhotoId: string;
  count: number;
}

export interface ProductGroup {
  groupId: string;
  ordinal: number;
  sourceAlbumId: string;
  photos: SourcePhoto[];
}

export interface ImportRunResult {
  importRunId: string;
  succeededProductIds: string[];
  failedGroups: Array<{ groupId: string; productId: string | null; errorCode: string }>;
}
