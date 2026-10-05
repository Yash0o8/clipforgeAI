const TONES = {
  neutral: 'bg-ink-750 text-secondary border-line-strong',
  brand: 'bg-brand-500/12 text-brand-300 border-brand-500/25',
  success: 'bg-success/12 text-emerald-300 border-success/25',
  warning: 'bg-warning/12 text-amber-300 border-warning/25',
  danger: 'bg-danger/12 text-red-300 border-danger/25',
  info: 'bg-info/12 text-blue-300 border-info/25',
  outline: 'bg-transparent text-secondary border-line-strong',
};

const SIZES = {
  xs: 'h-5 px-1.5 text-[10px] gap-1 rounded',
  sm: 'h-6 px-2 text-[11px] gap-1.5 rounded-md',
  md: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
};

const DOT_TONES = {
  neutral: 'bg-faint',
  brand: 'bg-brand-400',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-red-400',
  info: 'bg-blue-400',
  outline: 'bg-faint',
};

/**
 * Compact status pill.
 *
 * @param {object} props
 * @param {'neutral'|'brand'|'success'|'warning'|'danger'|'info'|'outline'} [props.tone]
 * @param {'xs'|'sm'|'md'} [props.size]
 * @param {boolean} [props.dot]  Prepend a status dot.
 * @param {boolean} [props.pulse]  Animate the dot (for live statuses).
 */
export function Badge({ tone = 'neutral', size = 'sm', dot = false, pulse = false, className = '', children }) {
  return (
    <span
      className={`inline-flex items-center border font-medium whitespace-nowrap ${
        TONES[tone] ?? TONES.neutral
      } ${SIZES[size] ?? SIZES.sm} ${className}`}
    >
      {dot && (
        <span className="relative flex size-1.5 shrink-0">
          {pulse && (
            <span
              className={`absolute inline-flex size-full animate-ping rounded-full opacity-70 ${DOT_TONES[tone] ?? DOT_TONES.neutral}`}
            />
          )}
          <span className={`relative inline-flex size-1.5 rounded-full ${DOT_TONES[tone] ?? DOT_TONES.neutral}`} />
        </span>
      )}
      {children}
    </span>
  );
}

/**
 * Score chip used across clip cards. The colour band communicates quality at a
 * glance without having to read the number.
 */
export function ScoreBadge({ score, size = 'sm', className = '' }) {
  const tone = score >= 90 ? 'success' : score >= 75 ? 'brand' : score >= 60 ? 'info' : 'neutral';
  return (
    <Badge tone={tone} size={size} className={`tabular ${className}`} dot>
      {score}% match
    </Badge>
  );
}
