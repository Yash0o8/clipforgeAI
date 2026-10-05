/**
 * Switch-style boolean control.
 *
 * Uses a real `<button role="switch">` so it is reachable by keyboard and
 * reports its state to assistive technology without extra wiring.
 */
export function Toggle({ checked, onChange, label, description, disabled = false, id, className = '' }) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      {label && (
        <div className="min-w-0">
          <label htmlFor={id} className="block cursor-pointer text-[13px] font-medium text-primary">
            {label}
          </label>
          {description && (
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-faint">{description}</p>
          )}
        </div>
      )}

      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label && !id ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full border transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? 'border-brand-500/60 bg-brand-500' : 'border-line-strong bg-ink-750'
        }`}
      >
        <span
          className={`inline-block size-4 rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

/** Checkbox with a label, for settings lists that read as a checklist. */
export function Checkbox({ checked, onChange, label, description, disabled = false, id, className = '' }) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-2.5 ${disabled ? 'cursor-not-allowed opacity-55' : ''} ${className}`}
    >
      <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer size-4 cursor-pointer appearance-none rounded border border-line-strong bg-ink-925 transition-colors checked:border-brand-500 checked:bg-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
        />
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="pointer-events-none absolute size-3 scale-0 text-white transition-transform peer-checked:scale-100"
        >
          <path
            d="M2.5 6.2 4.8 8.5 9.5 3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-primary">{label}</span>
        {description && <span className="mt-0.5 block text-[11.5px] text-faint">{description}</span>}
      </span>
    </label>
  );
}
