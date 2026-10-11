import type { ChangeEvent, ReactNode } from 'react';

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One settings block: title and explanation on the left, controls on the right (stacked on phones). */
export function SettingsSection({ id, title, description, tone, children }: {
  id: string;
  title: string;
  description?: string;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <section
      className={`settings-section${tone === 'danger' ? ' settings-section--danger' : ''}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="settings-section__intro">
        <h2 id={`${id}-title`}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-field">
      <label className="form-label" htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

export function UnitField({ id, label, hint, unit, value, onChange, step }: {
  id: string;
  label: string;
  hint: string;
  unit: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  step?: number;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="input-affix">
        <input
          id={id}
          type="number"
          inputMode={step && step < 1 ? 'decimal' : 'numeric'}
          className="input"
          value={value}
          onChange={onChange}
          min={0}
          step={step}
          aria-describedby={`${id}-unit ${id}-hint`}
        />
        <span className="input-affix__suffix" id={`${id}-unit`}>{unit}</span>
      </div>
    </Field>
  );
}

export function ActionRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="settings-action-row">
      <div className="settings-action-row__text">
        <div className="settings-action-row__title">{title}</div>
        <p className="field-hint">{description}</p>
      </div>
      {children}
    </div>
  );
}
