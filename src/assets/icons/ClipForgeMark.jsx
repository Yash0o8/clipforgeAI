/**
 * ClipForge brand marks.
 *
 * Inline SVG rather than an imported asset file so the mark can inherit
 * `currentColor` and stay crisp at every size from a 16px favicon to a hero.
 */

/** Glyph only. Set `className` to control size. */
export function ClipForgeMark({ className = 'size-6', ...rest }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      <defs>
        <linearGradient id="cf-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="55%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.08" />
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7.25" stroke="url(#cf-mark)" strokeWidth="1.5" opacity="0.5" />
      <path d="M13.2 10.6c0-.7.75-1.15 1.35-.8l7.3 4.2c.55.32.55 1.1 0 1.42l-7.3 4.2c-.6.35-1.35-.1-1.35-.8z" fill="url(#cf-mark)" />
      <path d="M8.5 20.4 11.3 12l1.7 5.2 1.9-5.2 2.9 8.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <path d="M24.4 8.6v3.4M22.7 10.3h3.4" stroke="#c4b5fd" strokeWidth="1.3" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}

/** Mark plus wordmark. Links to the app root when wrapped in a `Link`. */
export function ClipForgeLogo({ className = '', showTagline = false }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <ClipForgeMark className="size-8 shrink-0 text-primary" />
      <span className="flex min-w-0 flex-col leading-none">
        <span className="text-[15px] font-bold tracking-tight text-primary">
          ClipForge<span className="text-brand-400"> AI</span>
        </span>
        {showTagline && (
          <span className="mt-1 text-[10.5px] font-medium tracking-wide text-faint uppercase">
            Long to short
          </span>
        )}
      </span>
    </span>
  );
}
