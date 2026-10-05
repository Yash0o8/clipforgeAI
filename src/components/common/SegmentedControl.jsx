const SIZES = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-8.5 px-3 text-[13px]',
  lg: 'h-10 px-4 text-sm',
};

/**
 * Mutually exclusive option group rendered as a single pill.
 * Used for aspect ratio, view mode and short sort choices.
 *
 * @param {object} props
 * @param {Array<{value: string, label: React.ReactNode, title?: string}>} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {string} [props.label]  Accessible group name.
 * @param {'sm'|'md'|'lg'} [props.size]
 * @param {boolean} [props.fullWidth]
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  size = 'md',
  fullWidth = false,
  className = '',
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex items-center gap-0.5 rounded-lg border border-line-strong bg-ink-900 p-0.5 ${
        fullWidth ? 'w-full' : ''
      } ${className}`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-400 ${
              SIZES[size] ?? SIZES.md
            } ${
              selected
                ? 'bg-ink-750 text-primary shadow-[0_1px_2px_rgba(0,0,0,0.4)]'
                : 'text-secondary hover:bg-ink-850 hover:text-primary'
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
