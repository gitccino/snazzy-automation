export interface PublicationWorkflowParams {
  publicationRunId: string;
  trigger: "cron" | "line" | "admin";
  generation?: number;
}

export function publicationWorkflowId(runId: string, generation: number): string {
  return generation === 1 ? `publication-${runId}` : `publication-${runId}-v${generation}`;
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
