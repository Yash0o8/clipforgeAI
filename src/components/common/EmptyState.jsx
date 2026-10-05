/**
 * Empty / zero-state block.
 *
 * Every list screen in the app renders one of these rather than a blank
 * region, so the user is always told what to do next.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.icon]
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {React.ReactNode} [props.action]
 * @param {'sm'|'md'} [props.size]
 */
export function EmptyState({ icon, title, description, action, size = 'md', className = '' }) {
  const isCompact = size === 'sm';

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-panel border border-dashed border-line-strong bg-ink-900/40 text-center ${
        isCompact ? 'gap-2.5 px-5 py-9' : 'gap-3.5 px-6 py-16'
      } ${className}`}
    >
      {icon && (
        <span
          className={`flex items-center justify-center rounded-xl border border-line-strong bg-ink-850 text-brand-400 ${
            isCompact ? 'size-9' : 'size-12'
          }`}
        >
          {icon}
        </span>
      )}

      <div className="max-w-sm space-y-1.5">
        <h3 className={`font-semibold text-primary ${isCompact ? 'text-sm' : 'text-[15px]'}`}>{title}</h3>
        {description && (
          <p className={`text-secondary ${isCompact ? 'text-[13px]' : 'text-sm'} leading-relaxed`}>
            {description}
          </p>
        )}
      </div>

      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * Error state with a retry affordance.
 * Used for failed processing, load errors and rejected uploads.
 */
export function ErrorState({ title = 'Something went wrong', message, onRetry, retryLabel = 'Try again', className = '' }) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 rounded-panel border border-danger/25 bg-danger/[0.06] px-6 py-12 text-center ${className}`}
    >
      <span className="flex size-11 items-center justify-center rounded-xl border border-danger/30 bg-danger/10 text-danger">
        <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
          <path
            d="M12 8v5m0 3.5h.01M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <div className="max-w-md space-y-1.5">
        <h3 className="text-[15px] font-semibold text-primary">{title}</h3>
        {message && <p className="text-sm leading-relaxed text-secondary">{message}</p>}
      </div>

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 h-9 rounded-lg border border-line-strong bg-ink-800 px-4 text-[13px] font-medium text-primary transition-colors hover:bg-ink-750"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
