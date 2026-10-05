import { useId } from 'react';

const CONTROL_BASE =
  'w-full rounded-lg border bg-ink-925 px-3 text-sm text-primary placeholder:text-faint ' +
  'transition-[border-color,box-shadow] duration-150 ' +
  'focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 ' +
  'disabled:cursor-not-allowed disabled:opacity-55';

function borderClass(error, disabled) {
  if (error) return 'border-danger/50';
  if (disabled) return 'border-line';
  return 'border-line-strong hover:border-line-hover';
}

/**
 * Labelled text input with hint and error wiring.
 *
 * `aria-invalid` and `aria-describedby` are set from the `hint` / `error` props,
 * so validation state is announced rather than only shown in red.
 */
export function TextField({
  label,
  hint,
  error,
  id,
  type = 'text',
  value,
  onChange,
  placeholder,
  disabled = false,
  required = false,
  min,
  max,
  step,
  maxLength,
  autoFocus = false,
  leading,
  trailing,
  className = '',
  inputClassName = '',
  ...rest
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  const control = (
    <input
      id={fieldId}
      type={type}
      value={value ?? ''}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      min={min}
      max={max}
      step={step}
      maxLength={maxLength}
      autoFocus={autoFocus}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy || undefined}
      aria-required={required || undefined}
      className={`${CONTROL_BASE} ${borderClass(Boolean(error), disabled)} h-10 ${
        leading ? 'pl-9' : ''
      } ${trailing ? 'pr-9' : ''} ${inputClassName}`}
      {...rest}
    />
  );

  return (
    <div className={`space-y-1.5 ${className}`}>
      {(label || maxLength) && (
        <div className="flex items-baseline justify-between gap-2">
          {label && (
            <label htmlFor={fieldId} className="text-[13px] font-medium text-secondary">
              {label}
              {required && (
                <span className="ml-0.5 text-danger" aria-hidden="true">
                  *
                </span>
              )}
            </label>
          )}
          {maxLength && (
            <span className="tabular text-[11px] text-faint">
              {String(value ?? '').length}/{maxLength}
            </span>
          )}
        </div>
      )}

      <div className="relative">
        {leading && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
            {leading}
          </span>
        )}
        {control}
        {trailing && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-faint">{trailing}</span>
        )}
      </div>

      {hint && !error && (
        <p id={hintId} className="text-[11.5px] leading-relaxed text-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[11.5px] font-medium leading-relaxed text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Multi-line variant of `TextField`, used for captions and bios. */
export function TextArea({ label, hint, error, rows = 4, id, className = '', ...rest }) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && (
        <label htmlFor={fieldId} className="block text-[13px] font-medium text-secondary">
          {label}
        </label>
      )}
      <textarea
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${CONTROL_BASE} ${borderClass(Boolean(error), false)} resize-y leading-relaxed scrollbar-thin ${rest.maxLength ? '' : 'pb-2'}`}
        {...rest}
      />
      {hint && !error && (
        <p id={hintId} className="text-[11.5px] leading-relaxed text-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[11.5px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
