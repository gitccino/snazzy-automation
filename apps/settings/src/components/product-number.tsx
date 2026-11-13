import React, { useEffect, useRef, useState } from "react";
import { Button } from "./ui";

export function ProductNumber({ current, revision, onSaved, onReload, onDirty }: {
  current: number | null;
  revision: number;
  onSaved: (value: number) => void;
  onReload: () => void;
  onDirty: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(String(current ?? ""));
  const previousCurrent = useRef(current);
  useEffect(() => {
    setDraft(value => value === String(previousCurrent.current ?? "") ? String(current ?? "") : value);
    previousCurrent.current = current;
  }, [current]);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== String(current ?? "");
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const number = Number(draft);
  const valid = current !== null && draft.trim() !== "" && Number.isSafeInteger(number) && number >= current && number < Number.MAX_SAFE_INTEGER;
  async function save() {
    if (!valid || busy) return;
    setBusy(true); setMessage(""); setConflict(false);
    try {
      const response = await fetch("/api/settings/next-product-number", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, expectedNextValue: current, nextValue: number }),
      });
      const body = await response.json() as { ok?: boolean; code?: string; fieldErrors?: Record<string, string>; value?: { nextProductNumber: number } };
      if (!response.ok || !body.ok || !body.value) {
        setFailed(true);
        const stale = body.code === "sequence_conflict" || body.code === "revision_conflict";
        setConflict(stale);
        setMessage(stale ? "The counter or settings changed. Reload settings before trying again." : body.fieldErrors?.nextProductNumber ?? "Could not verify and save the number. Check the Airtable connection and try again.");
        return;
      }
      setDraft(String(body.value.nextProductNumber));
      onSaved(body.value.nextProductNumber);
      setFailed(false); setMessage(`Saved. The next product will use A-${body.value.nextProductNumber}.`);
    } catch { setFailed(true); setMessage("Could not save. Check your connection and try again; your edit is still here."); }
    finally { setBusy(false); }
  }
  return <section className="numbering-section" aria-labelledby="numbering-title">
    <h2 id="numbering-title">Product numbering</h2>
    <p className="field-help">Changes apply to future products. Existing product IDs stay the same.</p>
    <div className="field">
      <div className="field-meta"><label className="field-title" htmlFor="next-product-number">Next product number</label>
        <p className="field-help" id="next-product-number-help">Must be greater than every A- number in Airtable and cannot go below the current counter. Numbers skipped by increasing it cannot be reclaimed here.</p></div>
      <div className="control"><div className="input-wrap"><input id="next-product-number" type="number" min={current ?? 1} max={Number.MAX_SAFE_INTEGER - 1} step="1" value={draft} disabled={current === null || busy}
        aria-describedby="next-product-number-help" aria-invalid={dirty && !valid}
        onChange={event => { setDraft(event.target.value); setMessage(""); setConflict(false); }} /></div>
        <p className="field-help">{current === null ? "The product sequence is not initialized. Contact the owner." : `Current counter: A-${current}`}</p>
      </div>
    </div>
    {dirty && <div className="footer-actions"><Button variant="primary" disabled={!valid || busy || conflict} onClick={() => void save()}>{busy ? "Checking & saving…" : "Save next number"}</Button>
      <Button disabled={busy} onClick={() => { setDraft(String(current ?? "")); setMessage(""); setConflict(false); }}>Discard number change</Button></div>}
    {message && <p role="status" className={failed ? "error field-error" : "number-saved"}>{message}</p>}
    {conflict && <Button onClick={onReload}>Reload settings</Button>}
  </section>;
}
