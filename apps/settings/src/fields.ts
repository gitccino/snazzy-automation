import type {
  SettingsSection,
  StoredSettings,
} from "../../../src/settings/schema";
export type Field = {
  key: keyof StoredSettings;
  label: string;
  description: string;
  section: SettingsSection;
};
export const sections: Record<SettingsSection, string> = {
  connections: "Connections",
  line: "LINE groups",
  import: "Import",
  documents: "Documents",
  advanced: "Advanced",
};
export const fields: Field[] = [
  {
    key: "AIRTABLE_BASE_ID",
    label: "Airtable base",
    description:
      "The single active inventory base. Changing it does not move existing products.",
    section: "connections",
  },
  {
    key: "AIRTABLE_PRODUCTS_TABLE_ID",
    label: "Products table",
    description: "The table containing product inventory.",
    section: "connections",
  },
  {
    key: "AIRTABLE_PUBLICATION_RUNS_TABLE_ID",
    label: "Publication runs table",
    description: "The table containing document publication runs.",
    section: "connections",
  },
  {
    key: "GOOGLE_DRIVE_FOLDER_ID",
    label: "Google Drive folder",
    description:
      "The My Drive folder for generated documents and the template.",
    section: "connections",
  },
  {
    key: "GOOGLE_TEMPLATE_DOC_ID",
    label: "Google Docs template",
    description: "A Google document with the supported publication markers.",
    section: "connections",
  },
  {
    key: "LINE_ALLOWED_GROUP_IDS",
    label: "Allowed LINE groups",
    description:
      "All groups share the same inventory. Replies return only to the requesting group.",
    section: "line",
  },
  {
    key: "SOLDOUT_CONFIRMATION_ENABLED",
    label: "Confirm sold-out changes",
    description: "Ask for confirmation before changing a product to sold out.",
    section: "line",
  },
  {
    key: "FIRST_IMPORT_CUTOFF_DATE",
    label: "Photo cutoff",
    description:
      "Bangkok date and time. Every import excludes photos older than this cutoff. Changing it changes photo eligibility.",
    section: "import",
  },
  {
    key: "IMPORT_RETRY_LIMIT",
    label: "Import attempts",
    description: "Applies to each durable import step.",
    section: "import",
  },
  {
    key: "CLAUDE_MODEL",
    label: "Claude model",
    description: "Model ID for new AI captions. Access is checked when captioning is enabled. Update estimated token rates in Advanced when switching models.",
    section: "documents",
  },
  {
    key: "AI_CAPTIONS_ENABLED",
    label: "AI auto-captioning",
    description:
      "Generate captions with Claude when publishing documents. Enabling checks the existing credential.",
    section: "documents",
  },
  {
    key: "PUBLICATION_RETRY_LIMIT",
    label: "Document attempts",
    description: "Applies to each durable publication step.",
    section: "documents",
  },
  {
    key: "CLAUDE_REQUEST_INPUT_TOKEN_LIMIT",
    label: "Caption input token limit",
    description:
      "Positive integer up to 150,000. Used only when captions are enabled.",
    section: "advanced",
  },
  {
    key: "MONTHLY_BUDGET_THB",
    label: "Monthly budget estimate (THB)",
    description:
      "A reporting threshold. No scheduled alerts or spending enforcement.",
    section: "advanced",
  },
  {
    key: "USD_TO_THB_RATE",
    label: "USD to THB exchange rate",
    description: "Used for cost estimates.",
    section: "advanced",
  },
  {
    key: "CLAUDE_INPUT_PRICE_USD_PER_MTOK",
    label: "Claude input rate (USD / million tokens)",
    description:
      "Estimated provider rate; this does not change provider pricing.",
    section: "advanced",
  },
  {
    key: "CLAUDE_OUTPUT_PRICE_USD_PER_MTOK",
    label: "Claude output rate (USD / million tokens)",
    description: "Estimated provider rate.",
    section: "advanced",
  },
  {
    key: "R2_PRICE_USD_PER_GB_MONTH",
    label: "Storage rate (USD / GB-month)",
    description: "Estimated R2 storage rate.",
    section: "advanced",
  },
];
export function toBangkok(value: string | null): string {
  return value
    ? new Date(Date.parse(value) + 7 * 3600000).toISOString().slice(0, 16)
    : "";
}
export function fromBangkok(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("Enter a valid Bangkok date and time.");
  const date = new Date(value + "+07:00");
  if (
    !Number.isFinite(date.getTime()) ||
    toBangkok(date.toISOString()) !== value
  )
    throw new Error("Enter a valid calendar date.");
  return date.toISOString();
}

// Approved model aliases: https://platform.claude.com/docs/en/models/overview
export const claudeModels = [
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Haiku" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", group: "Haiku" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "Sonnet" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Sonnet" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Sonnet" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", group: "Sonnet" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", group: "Opus" },
  { value: "claude-opus-5", label: "Claude Opus 5", group: "Opus" },
  { value: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Opus" },
  { value: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Opus" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6", group: "Opus" },
  { value: "claude-opus-4-5", label: "Claude Opus 4.5", group: "Opus" },
];
