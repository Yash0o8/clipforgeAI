/**
 * Surface primitives.
 *
 * `Panel` replaces the ad-hoc "rounded border + bg" divs that would otherwise
 * repeat in every screen, which is what keeps the dashboard visually consistent.
 */
export function Panel({ as: Component = 'section', className = '', raised = false, children, ...rest }) {
  return (
    <Component className={`${raised ? 'panel-raised' : 'panel'} ${className}`} {...rest}>
      {children}
    </Component>
  );
}

/**
 * Panel header with an optional title, subtitle, badge row and action slot.
 * Separating this from the body means every panel's title block aligns to the
 * same grid without repeating padding utilities.
 */
export function PanelHeader({ title, subtitle, actions, children, className = '' }) {
  return (
    <header className={`flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-5 ${className}`}>
      <div className="min-w-0 flex-1">
        {title && <h2 className="text-sm font-semibold text-primary">{title}</h2>}
        {subtitle && <p className="mt-0.5 text-[12.5px] leading-relaxed text-secondary">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PanelBody({ className = '', children, ...rest }) {
  return (
    <div className={`px-4 pb-4 sm:px-5 sm:pb-5 ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Section heading used outside panels, e.g. above the editor panes. */
export function SectionTitle({ title, subtitle, actions, className = '' }) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-primary">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Key/value row used in metadata panels. */
export function MetaRow({ label, value, className = '' }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${className}`}>
      <dt className="shrink-0 text-[12px] text-faint">{label}</dt>
      <dd className="tabular min-w-0 truncate text-right text-[12.5px] font-medium text-primary">{value}</dd>
    </div>
  );
}
