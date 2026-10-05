const TONES = {
  brand: 'bg-brand-500',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-ink-500',
};

const SIZES = { xs: 'h-1', sm: 'h-1.5', md: 'h-2', lg: 'h-2.5' };

/**
 * Determinate progress bar.
 *
 * @param {object} props
 * @param {number} [props.value]        0–100. Omit for indeterminate.
 * @param {'brand'|'success'|'warning'|'danger'|'info'|'neutral'} [props.tone]
 * @param {'xs'|'sm'|'md'|'lg'} [props.size]
 * @param {boolean} [props.indeterminate]
 * @param {string} [props.label]        Accessible name.
 * @param {boolean} [props.showValue]   Render the percentage at the end.
 */
export function ProgressBar({
  value = 0,
  tone = 'brand',
  size = 'sm',
  indeterminate = false,
  label = 'Progress',
  showValue = false,
  className = '',
}) {
  const clamped = Math.min(100, Math.max(0, Number(value) || 0));

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
        aria-valuetext={indeterminate ? 'Working' : `${Math.round(clamped)}%`}
        className={`relative w-full overflow-hidden rounded-full bg-ink-750 ${SIZES[size] ?? SIZES.sm}`}
      >
        {indeterminate ? (
          <div
            className={`absolute inset-y-0 w-1/3 rounded-full ${TONES[tone] ?? TONES.brand} animate-[shimmer_1.4s_linear_infinite]`}
            style={{ backgroundImage: 'linear-gradient(90deg,transparent,currentColor,transparent)' }}
          />
        ) : (
          <div
            className={`h-full rounded-full transition-[width] duration-300 ease-out ${
              TONES[tone] ?? TONES.brand
            }`}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>

      {showValue && !indeterminate && (
        <span className="tabular shrink-0 text-xs font-medium text-secondary">
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  );
}

/**
 * Slim progress bar for dense list rows, where a full ProgressBar would be noisy.
 * Shows the percentage inline on the right.
 */
export function InlineProgress({ value, className = '' }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <ProgressBar value={value} size="xs" className="flex-1" />
      <span className="tabular w-9 shrink-0 text-right text-[11px] font-medium text-secondary">
        {Math.round(value)}%
      </span>
    </div>
  );
}
