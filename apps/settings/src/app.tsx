import { ProductNumber } from "./components/product-number";
import { ThemePicker } from "./components/theme-picker";
import React, { useEffect, useRef, useState } from "react";
import {
  normalizeGroupIds,
  type SettingsSection,
  type SettingsView,
  type StoredSettings,
} from "../../../src/settings/schema";
import { claudeModels, fields, fromBangkok, sections, toBangkok, type Field } from "./fields";
import {
  FloatingLabelInput,
  FloatingLabelSelect,
} from "./components/floating-label-input";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  SectionIcon,
} from "./components/ui";

type ApiResponse = {
  ok?: boolean;
  code?: string;
  value?: SettingsView;
  fieldErrors?: Record<string, string>;
};

const messages: Record<string, string> = {
  provider_unavailable: "Connection checks are unavailable. Try again later; local previews cannot check providers.",
  connection_validation_failed: "Could not verify the connection. Check the IDs and provider account access.",
  confirmation_required: "Review and confirm the Airtable change before saving.",
  unauthorized: "Sign in through Cloudflare Access to view or change settings.",
  settings_unavailable:
    "Settings are not initialized yet. Ask the owner to run the one-time settings setup.",
  revision_conflict:
    "Someone else saved newer settings. Reload settings to review the latest values before saving.",
  airtable_ack_required:
    "Confirm the Airtable connection change before saving.",
  airtable_validation_failed:
    "Could not verify the Airtable base or tables. Check the IDs and token access.",
  google_validation_failed:
    "Could not verify the Google Drive folder or Docs template. Check the IDs and account access.",
  line_validation_failed:
    "Could not verify the LINE channel token or group list.",
  claude_validation_failed:
    "Could not verify Claude captioning access. Keep captions off or check the API key.",
  invalid_cutoff: "Enter a valid Bangkok date and time.",
};

const sectionSubtitles: Record<SettingsSection, string> = {
  connections:
    "Choose where your inventory and documents live.",
  line: "Choose who can use your inventory commands.",
  import:
    "Control which photos are imported and how failures are handled.",
  documents:
    "Set up captions and attempts for your next catalog.",
  advanced:
    "Limits and rates for usage estimates.",
};

export function App() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<StoredSettings | null>(null);
  const [section, setSection] = useState<SettingsSection>("connections");
  const [search, setSearch] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [openConnections, setOpenConnections] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [statuses, setStatuses] = useState<
    Partial<Record<SettingsSection, string>>
  >({});
  const [busy, setBusy] = useState(false);
  const [numberDirty, setNumberDirty] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [ack, setAck] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const statusRef = useRef<HTMLParagraphElement>(null);

  async function reload() {
    setError("");
    try {
      const res = await fetch("/api/settings");
      const body = (await res.json()) as ApiResponse;
      if (!res.ok || !body.ok || !body.value) {
        setError(body.code ?? "settings_unavailable");
        return;
      }
      setReloadGeneration(value => value + 1);
      setView(body.value);
      setDraft(body.value.record.settings);
      setAck(false);
      setFieldErrors({});
    } catch {
      setError("settings_unavailable");
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const dirty = (s: SettingsSection) =>
    !!view &&
    !!draft &&
    fields
      .filter((f) => f.section === s)
      .some(
        (f) =>
          JSON.stringify(draft[f.key]) !==
          JSON.stringify(view.record.settings[f.key]),
      );

  const anyDirty = numberDirty || (Object.keys(sections) as SettingsSection[]).some(dirty);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (anyDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  function change<K extends keyof StoredSettings>(
    key: K,
    value: StoredSettings[K],
  ) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    const editedSection = fields.find((f) => f.key === key)?.section;
    if (editedSection) {
      setStatuses((current) => ({ ...current, [editedSection]: "" }));
    }
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[String(key)];
      return next;
    });
    if (String(key).startsWith("AIRTABLE_")) {
      setAck(false);
      setTests((t) => ({ ...t, airtable: "Not tested" }));
    }
    if (String(key).startsWith("GOOGLE_")) {
      setTests((t) => ({ ...t, google: "Not tested" }));
    }
    if (key === "LINE_ALLOWED_GROUP_IDS") {
      setTests((t) => ({ ...t, line: "Not tested" }));
    }
  }

  async function save(s: SettingsSection) {
    if (!view || !draft) return;
    setBusy(true);
    setError("");
    setStatuses((current) => ({ ...current, [s]: "" }));
    setFieldErrors({});
    try {
      const changes = Object.fromEntries(
        fields
          .filter((f) => f.section === s)
          .map((f) => [f.key, draft[f.key]]),
      );
      const res = await fetch(`/api/settings/sections/${s}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: view.record.revision,
          section: s,
          changes,
          acknowledgeAirtableChange: ack || undefined,
        }),
      });
      const body = (await res.json()) as ApiResponse;
      if (!res.ok || !body.ok || !body.value) {
        setError(body.code ?? "invalid_settings");
        setFieldErrors(body.fieldErrors ?? {});
        statusRef.current?.focus();
        return;
      }
      const nextValue = body.value;
      setView(nextValue);
      setDraft((current) => {
        const next = { ...(current ?? nextValue.record.settings) };
        for (const f of fields.filter((field) => field.section === s)) {
          (next as Record<string, unknown>)[f.key] =
            nextValue.record.settings[f.key];
        }
        return next;
      });
      setAck(false);
      setStatuses((current) => ({
        ...current,
        [s]: `Saved · Revision ${nextValue.record.revision}`,
      }));
      statusRef.current?.focus();
    } catch {
      setError("Could not save. Check your connection and try again. Your changes are still here.");
    } finally {
      setBusy(false);
    }
  }

  async function test(connection: "airtable" | "google" | "line") {
    if (!draft || !view) return;
    setTests((t) => ({ ...t, [connection]: "Checking…" }));
    try {
      const res = await fetch("/api/settings/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: view.record.revision,
          connection,
          changes: Object.fromEntries(fields.filter(field =>
            connection === "line" ? field.key === "LINE_ALLOWED_GROUP_IDS" :
            field.key.startsWith(connection === "airtable" ? "AIRTABLE_" : "GOOGLE_")
          ).map(field => [field.key, draft[field.key]])),
        }),
      });
      const body = (await res.json()) as ApiResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.code ?? "connection_failed");
      }
      setTests((t) => ({ ...t, [connection]: "Passed · draft values only" }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [connection]:
          messages[(e as Error).message] ??
          "Failed. Check the IDs and provider access.",
      }));
    }
  }

  const matching = fields.filter((f) =>
    `${f.label} ${f.key} ${f.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  const numberingMatches = "next product number product numbering counter".includes(search.trim().toLowerCase());

  const shown = (Object.keys(sections) as SettingsSection[]).filter((s) =>
    search ? matching.some((f) => f.section === s) || (s === "import" && numberingMatches) : !showSystem && s === section,
  );

  const changedAirtable =
    !!view &&
    !!draft &&
    fields.some(
      (f) =>
        f.key.startsWith("AIRTABLE_") &&
        draft[f.key] !== view.record.settings[f.key],
    );

  function control(field: Field) {
    if (!draft) return null;
    const value = draft[field.key];
    const id = field.key;
    const describedBy =
      id + "-help" + (fieldErrors[id] ? " " + id + "-error" : "");

    if (field.key === "LINE_ALLOWED_GROUP_IDS") {
      return (
        <Groups
          value={value as string[]}
          onChange={(v) => change(field.key, v)}
        />
      );
    }

    if (field.key === "FIRST_IMPORT_CUTOFF_DATE") {
      return (
        <div className="cutoff-control">
          <FloatingLabelInput
            id={id}
            label={field.label}
            type="datetime-local"
            alwaysUp={true}
            ariaDescribedBy={describedBy}
            ariaInvalid={!!fieldErrors[id]}
            value={toBangkok(value as string | null)}
            onChange={(nextVal) => {
              try {
                change(field.key, fromBangkok(nextVal));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
          <label className="check cutoff-check">
            <input
              type="checkbox"
              checked={value === null}
              onChange={(e) =>
                change(
                  field.key,
                  e.target.checked ? null : new Date().toISOString(),
                )
              }
            />
            <span>No cutoff</span>
          </label>
        </div>
      );
    }

    if (field.key === "CLAUDE_MODEL") {
      const model = String(value);
      return (
        <FloatingLabelSelect
          id={id}
          label={field.label}
          ariaDescribedBy={describedBy}
          ariaInvalid={!!fieldErrors[id]}
          value={model}
          onChange={(nextVal) => change("CLAUDE_MODEL", nextVal)}
          options={claudeModels.some(option => option.value === model)
            ? claudeModels
            : [{ value: model, label: `Current: ${model}`, disabled: true }, ...claudeModels]}
        />
      );
    }

    if (field.key.endsWith("RETRY_LIMIT")) {
      return (
        <FloatingLabelSelect
          id={id}
          label={field.label}
          ariaDescribedBy={describedBy}
          ariaInvalid={!!fieldErrors[id]}
          value={Number(value)}
          onChange={(nextVal) => change(field.key, Number(nextVal))}
          options={[
            { value: 0, label: "One attempt · no retries" },
            { value: 5, label: "Six attempts · five retries" },
          ]}
        />
      );
    }

    if (typeof value === "boolean") {
      return (
        <div className="switch-control-row">
          <input
            className="toggle"
            type="checkbox"
            role="switch"
            id={id}
            checked={value}
            onChange={(e) => change(field.key, e.target.checked)}
            aria-describedby={describedBy}
            aria-invalid={!!fieldErrors[id]}
          />
          <span className="switch-state" data-on={value}>
            {value ? "Enabled" : "Disabled"}
          </span>
        </div>
      );
    }

    const numeric = typeof view?.record.settings[field.key] === "number";
    return (
      <FloatingLabelInput
        id={id}
        label={field.label}
        ariaDescribedBy={describedBy}
        ariaInvalid={!!fieldErrors[id]}
        type={numeric ? "number" : "text"}
        step={numeric ? "any" : undefined}
        value={String(value ?? "")}
        onChange={(nextVal) =>
          change(
            field.key,
            numeric
              ? nextVal === ""
                ? ("" as unknown as number)
                : Number(nextVal)
              : nextVal,
          )
        }
      />
    );
  }

  function renderField(field: Field) {
    return (
      <div className="field" key={field.key}>
        <div className="field-meta">
          <label className="field-title" htmlFor={field.key}>{field.label}</label>
          <p id={field.key + "-help"} className="field-help">{field.description}</p>
          <details className="technical-key"><summary>Technical key</summary><code>{field.key}</code></details>
        </div>
        <div className="control">
          {control(field)}
          {fieldErrors[field.key] && <p id={field.key + "-error"} role="alert" className="error field-error">{fieldErrors[field.key]}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="workspace-header">
        <a className="brand" href="/" aria-label="Snazzy settings home"><img src="/snazzybrandname-logo.jpg" alt="" /><strong>Snazzy</strong><span>Settings</span></a>
        <div className="header-tools">{view && <span className="environment">{import.meta.env.DEV ? "Local preview" : view.deployment.environment}</span>}<ThemePicker /></div>
      </header>
      <div className="workspace-body">
      <aside className="sidebar">
        <div className="toolbar-search">
          <FloatingLabelInput label="Search settings" type="search" value={search} onChange={value => { setSearch(value); setShowSystem(false); }}
            trailing={search ? <button className="search-clear" aria-label="Clear search" onClick={() => setSearch("")}>×</button> : undefined} />
        </div>
        <nav aria-label="Settings sections" className="sidebar-nav">
          {(Object.entries(sections) as [SettingsSection, string][]).map(([key, label]) => (
            <button key={key} type="button" aria-label={label} aria-current={section === key && !search && !showSystem ? "page" : undefined}
              className={section === key && !search && !showSystem ? "active" : ""}
              onClick={() => { setSection(key); setSearch(""); setShowSystem(false); }}>
              <SectionIcon section={key} /><span>{label}</span>
              {(dirty(key) || (key === "import" && numberDirty)) && <span className="dirty-dot" aria-label="Unsaved changes" />}
            </button>
          ))}
          <button type="button" aria-current={showSystem && !search ? "page" : undefined}
            className={showSystem && !search ? "active" : ""}
            onClick={() => { setShowSystem(true); setSearch(""); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v2"/></svg>
            <span>System details</span>
          </button>
        </nav>
      </aside>
      <main className="main-stage" id="settings-content">
        {import.meta.env.DEV && <p className="preview-note">Sample workspace. Changes here won’t affect your inventory.</p>}
        {search && <div className="search-heading"><h1>Search results</h1><p>{matching.length + (numberingMatches ? 1 : 0)} settings matching “{search}”</p></div>}
        <p
          ref={statusRef}
          tabIndex={-1}
          role="status"
          className={
            error
              ? "status-banner error"
              : Object.values(statuses).some(Boolean)
                ? "status-banner status is-visible"
                : "status-banner status"
          }
        >
          {error
            ? (messages[error] ?? error)
            : Object.values(statuses).filter(Boolean).join(" · ")}
        </p>

        {error === "revision_conflict" && (
          <div className="conflict-bar">
            <Button
              variant="primary"
              onClick={() => {
                if (
                  !anyDirty ||
                  window.confirm(
                    "Reload settings and discard all unsaved changes?",
                  )
                ) {
                  void reload();
                }
              }}
            >
              Reload settings
            </Button>
          </div>
        )}

        {!view && !error && (
          <Card className="loading-card">
            <p>Loading settings…</p>
          </Card>
        )}

        {!view && error && (
          <div className="retry-bar">
            <Button variant="primary" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        )}

        {view && draft && shown.length === 0 && !showSystem && (
          <Card className="empty">
            <h2>No settings found</h2>
            <p>Try “template”, “groups”, or a technical key.</p>
          </Card>
        )}

        {view &&
          draft &&
          shown.map((s) => (
            <Card key={s} aria-labelledby={s + "-title"}>
              <CardHeader className="section-heading">
                <div className="section-heading-main">
                  <div className="section-title-row">
                    <CardTitle id={s + "-title"}>{sections[s]}</CardTitle>
                  </div>
                  <CardDescription>{sectionSubtitles[s]}</CardDescription>
                </div>
                {dirty(s) && <Badge variant="dirty">Unsaved changes</Badge>}
              </CardHeader>

              <CardContent>
                {s === "connections" && !search ? (
                  <div className="provider-list">
                    {[
                      { id: "airtable", name: "Airtable", description: "Inventory base and product tables", prefix: "AIRTABLE_" },
                      { id: "google", name: "Google Drive & Docs", description: "Catalog folder and document template", prefix: "GOOGLE_" },
                    ].map((provider) => {
                      const expanded = openConnections.includes(provider.id);
                      const providerDirty = fields.some(f => f.key.startsWith(provider.prefix) && draft[f.key] !== view.record.settings[f.key]);
                      return <div className="provider" key={provider.id}>
                        <button className="provider-summary" aria-expanded={expanded} aria-controls={provider.id + "-fields"}
                          onClick={() => setOpenConnections(current => expanded ? current.filter(id => id !== provider.id) : [...current, provider.id])}>
                          <span className="provider-mark" aria-hidden="true">{provider.id === "airtable" ? <svg viewBox="0 0 24 24" fill="none"><path d="m12 3 9 5-9 5-9-5 9-5Z" fill="currentColor"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5" stroke="currentColor" strokeWidth="1.5"/></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5M10 16h5"/></svg>}</span>
                          <span className="provider-copy"><strong>{provider.name}</strong><span>{provider.description}</span></span>
                          {providerDirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
                          <svg className="chevron" data-open={expanded} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
                        </button>
                        {expanded && <div id={provider.id + "-fields"} className="provider-fields">{matching.filter(f => f.key.startsWith(provider.prefix)).map(renderField)}</div>}
                      </div>;
                    })}
                  </div>
                ) : matching.filter(f => f.section === s).map(renderField)}

                {s === "connections" && changedAirtable && (
                  <div className="warning">
                    <div className="warning-header">
                      <span className="warning-badge">IMPACT REVIEW</span>
                      <h3>Review the Airtable connection change</h3>
                    </div>
                    <div className="warning-diffs">
                      {fields
                        .filter(
                          (f) =>
                            f.key.startsWith("AIRTABLE_") &&
                            draft[f.key] !== view.record.settings[f.key],
                        )
                        .map((f) => (
                          <p key={f.key} className="warning-diff-item">
                            <strong>{f.label}</strong>
                            <span>
                              <code>{String(view.record.settings[f.key])}</code>{" "}
                              → <code>{String(draft[f.key])}</code>
                            </span>
                          </p>
                        ))}
                    </div>
                    <p className="warning-copy">
                      Existing rows will not be moved or copied. Historical
                      references will not be rewritten. Imported products will
                      not be re-imported, and older inventory may become
                      unreachable through commands. Sequences and deduplication
                      records stay intact. Already accepted work retains its
                      original connection.
                    </p>
                    <label className="check warning-ack">
                      <input
                        type="checkbox"
                        checked={ack}
                        onChange={(e) => setAck(e.target.checked)}
                      />
                      <span>
                        I understand these effects and want to use this
                        connection.
                      </span>
                    </label>
                  </div>
                )}

                {(s === "connections" || s === "line") && (
                  <details className="connection-tests"><summary>Check connections</summary><p className="field-help">Tests use your current values without saving them.</p>
                    {(s === "line" ? ["line"] : ["airtable", "google"]).map(
                      (c) => {
                        const statusText = tests[c] ?? "Not tested";
                        const isPassed = statusText.startsWith("Passed");
                        const isFailed = statusText.startsWith("Failed") || statusText.startsWith("Could not");
                        return (
                          <div key={c} className="connection-test-item">
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy || tests[c] === "Checking…"}
                              onClick={() =>
                                void test(c as "airtable" | "google" | "line")
                              }
                            >
                              Test{" "}
                              {c === "line"
                                ? "LINE"
                                : c === "google"
                                  ? "Google"
                                  : "Airtable"}{" "}
                              connection
                            </Button>
                            <span
                              role="status"
                              className="test-status-pill"
                              data-state={
                                isPassed
                                  ? "ok"
                                  : isFailed
                                    ? "error"
                                    : "neutral"
                              }
                            >
                              {statusText}
                            </span>
                          </div>
                        );
                      },
                    )}
                  </details>
                )}
              </CardContent>

              {dirty(s) && <CardFooter>
                <div className="footer-actions">
                  <Button
                    variant="primary"
                    className="primary"
                    disabled={
                      busy ||
                      !dirty(s) ||
                      (s === "connections" && changedAirtable && !ack)
                    }
                    onClick={() => void save(s)}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !dirty(s)}
                    onClick={() => {
                      setDraft((d) => {
                        const copy = { ...d! };
                        for (const f of fields.filter(
                          (f) => f.section === s,
                        )) {
                          (copy as Record<string, unknown>)[f.key] =
                            view.record.settings[f.key];
                        }
                        return copy;
                      });
                      setError("");
                      setAck(false);
                      setTests({});
                    }}
                  >
                    Discard
                  </Button>
                </div>
                {statuses[s] && (
                  <span className="section-saved-text">{statuses[s]}</span>
                )}
              </CardFooter>}
            </Card>
          ))}

        {view && <div hidden={showSystem || (search ? !numberingMatches : section !== "import")}>
          <ProductNumber key={reloadGeneration} current={view.nextProductNumber} revision={view.record.revision}
            onDirty={setNumberDirty}
            onSaved={value => setView(current => current ? { ...current, nextProductNumber: value } : current)}
            onReload={() => { if (!anyDirty || window.confirm("Reload settings and discard all unsaved changes?")) void reload(); }} />
        </div>}

        {view && showSystem && (
          <section className="system-details" aria-labelledby="system-title">
            <h1 id="system-title" className="ui-card-title">System details</h1>
            <p className="ui-card-description">Managed by the owner.</p>
            <CardHeader className="readonly-header">
              <div>

                <CardDescription>
                  Credentials remain in secure Worker storage. Contact the owner
                  to reconnect an account.
                </CardDescription>
              </div>

            </CardHeader>
            <dl className="readonly-grid">
              {Object.entries({
                Environment: view.deployment.environment,
                "Public asset URL": view.deployment.publicBaseUrl,
                "Google OAuth client ID": view.deployment.googleOAuthClientId,
                "Time zone": "Asia/Bangkok",
                "Product ID prefix": "A",
                "Initial product number":
                  view.record.settings.PRODUCT_ID_INITIAL_NUMBER,
                Scheduling: "Disabled",
              }).map(([key, value]) => (
                <div key={key} className="readonly-cell">
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
            <div className="system-footer"><span>Saved revision {view.record.revision}</span><a href="/api/settings/export" download="snazzy-settings.json">Export saved settings</a></div>
          </section>
        )}
      </main>
      </div>
    </div>
  );
}

function Groups({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [entry, setEntry] = useState("");
  const [error, setError] = useState("");

  const commitEntry = (raw: string, emptyMessage: string) => {
    try {
      onChange(normalizeGroupIds([...value, ...normalizeGroupIds(raw)]));
      setEntry("");
      setError("");
    } catch {
      setError(emptyMessage);
    }
  };

  return (
    <div className="groups-manager">
      <ul className="groups">
        {value.map((group) => (
          <li key={group} className="group-chip">
            <span className="group-chip-id">
              <span className="group-dot" aria-hidden="true" />
              <code>{group}</code>
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${group}`}
              disabled={value.length === 1}
              onClick={() => onChange(value.filter((item) => item !== group))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>

      <div className="groups-add-row">
        <div className="groups-input-col">
          <FloatingLabelInput
            id="LINE_ALLOWED_GROUP_IDS"
            label="Add group IDs"
            value={entry}
            onChange={setEntry}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEntry(
                  entry,
                  "Enter non-empty group IDs separated by commas or new lines.",
                );
              }
            }}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              if (pasted.includes("\n") || pasted.includes(",")) {
                e.preventDefault();
                commitEntry(
                  pasted,
                  "Remove empty group IDs and paste again.",
                );
              }
            }}
          />
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            commitEntry(entry, "Enter at least one valid group ID.")
          }
        >
          Add groups
        </Button>
      </div>

      {error && (
        <p role="alert" className="error field-error">
          {error}
        </p>
      )}
    </div>
  );
}
