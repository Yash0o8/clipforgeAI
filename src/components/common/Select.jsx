import { useId } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Native select styled to match the rest of the app.
 *
 * A native control (rather than a custom listbox) keeps keyboard support,
 * screen-reader behaviour and mobile pickers correct for free.
 *
 * @param {object} props
 * @param {string} [props.label]
 * @param {string} [props.hint]
 * @param {Array<{value: string, label: string, disabled?: boolean}>} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 */
export function Select({
  label,
  hint,
  options,
  value,
  onChange,
  id,
  disabled = false,
  className = '',
  wrapperClassName = '',
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = `${fieldId}-hint`;

  return (
    <div className={`space-y-1.5 ${wrapperClassName}`}>
      {label && (
        <label htmlFor={fieldId} className="block text-[13px] font-medium text-secondary">
          {label}
        </label>
      )}

      <div className="relative">
        <select
          id={fieldId}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={hint ? hintId : undefined}
          className={`h-10 w-full cursor-pointer appearance-none rounded-lg border bg-ink-925 pl-3 pr-9 text-sm text-primary transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25 disabled:cursor-not-allowed disabled:opacity-55 ${
            disabled ? 'border-line' : 'border-line-strong hover:border-line-hover'
          } ${className}`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-faint"
        />
      </div>

      {hint && (
        <p id={hintId} className="text-[11.5px] leading-relaxed text-faint">
          {hint}
        </p>
      )}
    </div>
  );
}
