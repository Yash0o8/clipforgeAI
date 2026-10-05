/**
 * Underlined tab bar following the ARIA tabs pattern.
 *
 * Roving arrow-key navigation, which is what screen-reader users expect from
 * tabs. The editor uses this below the `xl` breakpoint to swap panes.
 *
 * @param {object} props
 * @param {Array<{id: string, label: React.ReactNode, icon?: React.ReactNode, badge?: React.ReactNode}>} props.tabs
 * @param {string} props.activeId
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.label]  Accessible name for the tab list.
 */
export function Tabs({ tabs, activeId, onChange, label = 'Sections', className = '' }) {
  const move = (direction) => {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    onChange(next.id);
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChange(tabs[0].id);
    } else if (event.key === 'End') {
      event.preventDefault();
      onChange(tabs[tabs.length - 1].id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`scrollbar-thin flex gap-1 overflow-x-auto border-b border-line ${className}`}
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`relative inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-400 ${
              selected
                ? 'border-brand-500 text-primary'
                : 'border-transparent text-secondary hover:border-line-strong hover:text-primary'
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}

/** Panel paired with `Tabs`. Renders nothing unless it is the active tab. */
export function TabPanel({ id, activeId, children, className = '' }) {
  if (id !== activeId) return null;
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      tabIndex={0}
      className={`focus-visible:outline-none ${className}`}
    >
      {children}
    </div>
  );
}
