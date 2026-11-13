import React, { useId } from "react";

export interface FloatingLabelInputProps {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "email" | "search" | "datetime-local";
  step?: string;
  min?: string | number;
  max?: string | number;
  disabled?: boolean;
  corner?: number;
  alwaysUp?: boolean;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  onPaste?: React.ClipboardEventHandler<HTMLInputElement>;
  trailing?: React.ReactNode;
  className?: string;
}

export function FloatingLabelInput({ id, label, value, onChange, type = "text", step, min, max, disabled, ariaDescribedBy, ariaInvalid, onKeyDown, onPaste, trailing, className = "" }: FloatingLabelInputProps) {
  const fallbackId = useId();
  return <div className={`input-wrap ${className}`}>
    <input id={id ?? fallbackId} aria-label={label} type={type} step={step} min={min} max={max}
      disabled={disabled} value={value} aria-describedby={ariaDescribedBy} aria-invalid={ariaInvalid}
      placeholder={type === "search" ? "Search settings…" : undefined}
      autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false}
      onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
    {trailing && <div className="input-trailing">{trailing}</div>}
  </div>;
}

export interface FloatingLabelSelectProps {
  id?: string;
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  options: Array<{ value: string | number; label: string; group?: string; disabled?: boolean }>;
  disabled?: boolean;
  corner?: number;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
}

export function FloatingLabelSelect({ id, label, value, onChange, options, disabled, ariaDescribedBy, ariaInvalid }: FloatingLabelSelectProps) {
  const fallbackId = useId();
  return <select id={id ?? fallbackId} aria-label={label} value={String(value)} disabled={disabled}
    aria-describedby={ariaDescribedBy} aria-invalid={ariaInvalid} onChange={e => onChange(e.target.value)}>
    {options.filter(option => !option.group).map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    {[...new Set(options.flatMap(option => option.group ? [option.group] : []))].map(group =>
      <optgroup key={group} label={group}>
        {options.filter(option => option.group === group).map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </optgroup>
    )}
  </select>;
}
