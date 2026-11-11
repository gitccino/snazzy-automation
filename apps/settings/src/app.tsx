import { useEffect, useRef, useState } from "react";
import {
  normalizeGroupIds,
  parseSaveSectionRequest,
  type SettingsSection,
  type SettingsView,
  type StoredSettings,
} from "../../../src/settings/schema";
import { fields, sections, fromBangkok, toBangkok, type Field } from "./fields";

type Draft = Record<keyof StoredSettings, unknown>;
const messages: Record<string, string> = {
  revision_conflict:
    "These settings changed elsewhere. Reload to review the latest values before saving.",
  confirmation_required:
    "Review and acknowledge the Airtable connection warning.",
  connection_validation_failed:
    "Connection validation failed. Check the IDs and provider access, then try again.",
  settings_unavailable:
    "Settings are unavailable. Ask the owner to check the configuration.",
  provider_unavailable:
    "Connection checks are unavailable. Local sample mode never contacts providers.",
  invalid_settings: "Check the entered values and try again.",
  internal_error: "The request failed. Your draft has been kept.",
};
async function request(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = (await res.json()) as {
    ok: boolean;
    code?: string;
    value: SettingsView;
  };
  if (!body.ok) throw new Error(body.code ?? "internal_error");
  return body.value;
}
export function App() {
  const [view, setView] = useState<SettingsView | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [section, setSection] = useState<SettingsSection>("connections"),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [statuses, setStatuses] = useState<
      Partial<Record<SettingsSection, string>>
    >({}),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [tests, setTests] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const statusRef = useRef<HTMLParagraphElement>(null);
  async function reload() {
    setBusy(true);
    try {
      const value = await request("/api/settings");
      setView(value);
      setDraft({ ...value.record.settings });
      setError("");
      setStatuses({});
      setAck(false);
      setTests({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
  const anyDirty = (Object.keys(sections) as SettingsSection[]).some(dirty);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (anyDirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [anyDirty]);
  function change(key: keyof StoredSettings, value: unknown) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setAck(false);
    setTests({});
    setStatuses({});
    setError("");
    setFieldErrors((v) => ({ ...v, [key]: "" }));
  }
  async function save(s: SettingsSection) {
    if (!view || !draft) return;
    setBusy(true);
    setError("");
    setFieldErrors({});
    try {
      const changes = Object.fromEntries(
        fields.filter((f) => f.section === s).map((f) => [f.key, draft[f.key]]),
      );
      const input = parseSaveSectionRequest({
        expectedRevision: view.record.revision,
        section: s,
        changes,
        acknowledgeAirtableChange: ack,
      });
      const next: SettingsView = await request(`/api/settings/sections/${s}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setView(next);
      setDraft((previous) => {
        const result = { ...previous! };
        for (const field of fields.filter((f) => f.section === s))
          result[field.key] = next.record.settings[field.key];
        return result;
      });
      setStatuses((v) => ({ ...v, [s]: "Saved changes" }));
      setAck(false);
    } catch (e) {
      if (e && typeof e === "object" && "issues" in e) {
        const issues = (
          e as { issues: { path: PropertyKey[]; message: string }[] }
        ).issues;
        setFieldErrors(
          Object.fromEntries(
            issues.map((issue) => [String(issue.path.at(-1)), issue.message]),
          ),
        );
      }
      const code = (e as Error).message;
      setError(messages[code] ? code : "invalid_settings");
    } finally {
      setBusy(false);
      statusRef.current?.focus();
    }
  }
  async function test(connection: "airtable" | "google" | "line") {
    if (!view || !draft) return;
    setTests((t) => ({ ...t, [connection]: "Checking…" }));
    try {
      const keys = fields.filter((f) =>
        connection === "line"
          ? f.key === "LINE_ALLOWED_GROUP_IDS"
          : f.key.startsWith(
              connection === "airtable" ? "AIRTABLE_" : "GOOGLE_",
            ),
      );
      await request("/api/settings/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: view.record.revision,
          connection,
          changes: Object.fromEntries(keys.map((f) => [f.key, draft[f.key]])),
        }),
      });
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
  const shown = (Object.keys(sections) as SettingsSection[]).filter((s) =>
    search ? matching.some((f) => f.section === s) : s === section,
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
    if (field.key === "LINE_ALLOWED_GROUP_IDS")
      return (
        <Groups
          value={value as string[]}
          onChange={(v) => change(field.key, v)}
        />
      );
    if (field.key === "FIRST_IMPORT_CUTOFF_DATE")
      return (
        <div>
          <input
            aria-label={field.label}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={!!fieldErrors[id]}
            type="datetime-local"
            value={toBangkok(value as string | null)}
            onChange={(e) => {
              try {
                change(field.key, fromBangkok(e.target.value));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
          <label className="check">
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
            No cutoff
          </label>
        </div>
      );
    if (field.key.endsWith("RETRY_LIMIT"))
      return (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={!!fieldErrors[id]}
          value={Number(value)}
          onChange={(e) => change(field.key, Number(e.target.value))}
        >
          <option value={0}>One attempt · no retries</option>
          <option value={5}>Six attempts · five retries</option>
        </select>
      );
    if (typeof value === "boolean")
      return (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={!!fieldErrors[id]}
          type="checkbox"
          role="switch"
          checked={value}
          onChange={(e) => change(field.key, e.target.checked)}
        />
      );
    const numeric = typeof view?.record.settings[field.key] === "number";
    return (
      <input
        id={id}
        aria-describedby={describedBy}
        aria-invalid={!!fieldErrors[id]}
        type={numeric ? "number" : "text"}
        step={numeric ? "any" : undefined}
        value={value as string | number}
        onChange={(e) =>
          change(
            field.key,
            numeric
              ? e.target.value === ""
                ? ""
                : Number(e.target.value)
              : e.target.value,
          )
        }
      />
    );
  }
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="mark">S</span>
          <strong>Snazzy</strong>
        </div>
        <p className="nav-caption">WORKSPACE SETTINGS</p>
        <nav aria-label="Settings sections">
          {(Object.entries(sections) as [SettingsSection, string][]).map(
            ([key, label]) => (
              <button
                key={key}
                aria-label={label}
                className={section === key && !search ? "active" : ""}
                onClick={() => {
                  setSection(key);
                  setSearch("");
                }}
              >
                {label}
                {dirty(key) && <span aria-label="Unsaved changes">•</span>}
              </button>
            ),
          )}
        </nav>
        <div className="sidebar-note">
          One inventory.
          <br />
          Settings for your daily workflow.
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h1>Settings</h1>
            <p>Manage connections and how your automation works.</p>
          </div>
          <a
            className="button secondary"
            href="/api/settings/export"
            download="snazzy-settings.json"
          >
            Export saved configuration
          </a>
        </header>
        {import.meta.env.DEV && (
          <div className="notice">
            Local sample · changes are disposable. No staging data or provider
            connections are used.
          </div>
        )}
        <div className="toolbar">
          <input
            aria-label="Search settings"
            placeholder="Find a setting or technical key…"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {view && <span>Revision {view.record.revision}</span>}
        </div>
        <p
          ref={statusRef}
          tabIndex={-1}
          role="status"
          className={error ? "error" : "status"}
        >
          {error
            ? (messages[error] ?? error)
            : Object.values(statuses).join(" · ")}
        </p>
        {error === "revision_conflict" && (
          <button
            onClick={() => {
              if (
                !anyDirty ||
                window.confirm(
                  "Reload settings and discard all unsaved changes?",
                )
              )
                void reload();
            }}
          >
            Reload settings
          </button>
        )}
        {!view && !error && <p>Loading settings…</p>}
        {!view && error && (
          <button onClick={() => void reload()}>Try again</button>
        )}
        {view && draft && shown.length === 0 && (
          <div className="empty">
            <h2>No settings found</h2>
            <p>Try “template”, “groups”, or a technical key.</p>
          </div>
        )}
        {view &&
          draft &&
          shown.map((s) => (
            <section key={s} aria-labelledby={s + "-title"}>
              <div className="section-heading">
                <h2 id={s + "-title"}>{sections[s]}</h2>
                {dirty(s) && <span className="badge">Unsaved changes</span>}
              </div>
              {matching
                .filter((f) => f.section === s)
                .map((field) => (
                  <div className="field" key={field.key}>
                    <div>
                      <label htmlFor={field.key}>{field.label}</label>
                      <p id={field.key + "-help"}>{field.description}</p>
                      <code>{field.key}</code>
                    </div>
                    <div className="control">
                      {control(field)}
                      {fieldErrors[field.key] && (
                        <p
                          id={field.key + "-error"}
                          role="alert"
                          className="error"
                        >
                          {fieldErrors[field.key]}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              {s === "connections" && changedAirtable && (
                <div className="warning">
                  <h3>Review the Airtable connection change</h3>
                  {fields
                    .filter(
                      (f) =>
                        f.key.startsWith("AIRTABLE_") &&
                        draft[f.key] !== view.record.settings[f.key],
                    )
                    .map((f) => (
                      <p key={f.key}>
                        <strong>{f.label}</strong>
                        <br />
                        <code>
                          {String(view.record.settings[f.key])}
                        </code> → <code>{String(draft[f.key])}</code>
                      </p>
                    ))}
                  <p>
                    Existing rows will not be moved or copied. Historical
                    references will not be rewritten. Imported products will not
                    be re-imported, and older inventory may become unreachable
                    through commands. Sequences and deduplication records stay
                    intact. Already accepted work retains its original
                    connection.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I understand these effects and want to use this connection.
                  </label>
                </div>
              )}
              {(s === "connections" || s === "line") && (
                <div className="connection-tests">
                  {(s === "line" ? ["line"] : ["airtable", "google"]).map(
                    (c) => (
                      <div key={c}>
                        <button
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
                        </button>
                        <span role="status">{tests[c] ?? "Not tested"}</span>
                      </div>
                    ),
                  )}
                </div>
              )}
              <footer>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !dirty(s) ||
                    (s === "connections" && changedAirtable && !ack)
                  }
                  onClick={() => void save(s)}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
                <button
                  disabled={busy || !dirty(s)}
                  onClick={() => {
                    setDraft((d) => {
                      const copy = { ...d! };
                      for (const f of fields.filter((f) => f.section === s))
                        copy[f.key] = view.record.settings[f.key];
                      return copy;
                    });
                    setError("");
                    setAck(false);
                    setTests({});
                  }}
                >
                  Discard
                </button>
                <span>{statuses[s]}</span>
              </footer>
            </section>
          ))}
        {view && (
          <section className="readonly">
            <h2>Managed by the owner</h2>
            <p>
              Credentials remain in secure Worker storage. Contact the owner to
              reconnect an account.
            </p>
            <dl>
              {Object.entries({
                Environment: view.deployment.environment,
                "Public asset URL": view.deployment.publicBaseUrl,
                "Google OAuth client ID": view.deployment.googleOAuthClientId,
                "Time zone": "Asia/Bangkok",
                "Product ID prefix": "A",
                "Initial product number":
                  view.record.settings.PRODUCT_ID_INITIAL_NUMBER,
                "Claude model": "claude-opus-5",
                Scheduling: "Disabled",
              }).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </main>
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
  const [entry, setEntry] = useState(""),
    [error, setError] = useState("");
  return (
    <div>
      <ul className="groups">
        {value.map((group) => (
          <li key={group}>
            <code>{group}</code>
            <button
              aria-label={`Remove ${group}`}
              disabled={value.length === 1}
              onClick={() => onChange(value.filter((item) => item !== group))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <label htmlFor="LINE_ALLOWED_GROUP_IDS">Add group IDs</label>
      <input
        id="LINE_ALLOWED_GROUP_IDS"
        value={entry}
        placeholder="Paste comma-separated group IDs"
        onChange={(e) => setEntry(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            try {
              onChange(
                normalizeGroupIds([...value, ...normalizeGroupIds(entry)]),
              );
              setEntry("");
              setError("");
            } catch {
              setError(
                "Enter non-empty group IDs separated by commas or new lines.",
              );
            }
          }
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (pasted.includes("\n") || pasted.includes(",")) {
            e.preventDefault();
            try {
              onChange(
                normalizeGroupIds([...value, ...normalizeGroupIds(pasted)]),
              );
              setEntry("");
              setError("");
            } catch {
              setError("Remove empty group IDs and paste again.");
            }
          }
        }}
      />
      <button
        onClick={() => {
          try {
            onChange(
              normalizeGroupIds([...value, ...normalizeGroupIds(entry)]),
            );
            setEntry("");
            setError("");
          } catch {
            setError("Enter at least one valid group ID.");
          }
        }}
      >
        Add groups
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
