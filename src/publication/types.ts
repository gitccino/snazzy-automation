export interface PublicationWorkflowParams {
  publicationRunId: string;
  trigger: "cron" | "line" | "admin";
}

export interface PublicationProduct {
  airtableRecordId: string;
  productId: string;
  orderedImageKeys: string[];
  brandName: string;
  modelName: string;
  conditionType: string;
  size: string;
  description: string;
  lineSquarePrice: number;
  igPrice: number;
}

export interface CaptionSet {
  productId: string;
  drafts: [string, string, string];
}

export interface PublicationResult {
  publicationRunId: string;
  googleDocId: string;
  googleDocUrl: string;
  productIds: string[];
}

export type PublicationRunStatus = "Draft" | "Ready" | "Generating" | "Generated" | "Failed";

export interface PublicationRun {
  airtableRunId: string;
  publicationDate: string;
  status: PublicationRunStatus;
  products: PublicationProduct[];
}
