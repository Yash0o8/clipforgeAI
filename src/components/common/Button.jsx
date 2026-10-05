import { forwardRef } from 'react';
import { Loader } from 'lucide-react';

/* Variant -> classes. Kept flat so the scale stays consistent everywhere. */
const VARIANTS = {
  primary:
    'bg-brand-500 text-white shadow-[0_1px_0_rgba(255,255,255,0.12)_inset] hover:bg-brand-400 active:bg-brand-600 disabled:hover:bg-brand-500',
  secondary:
    'bg-ink-800 text-primary border border-line-strong hover:bg-ink-750 hover:border-line-hover active:bg-ink-800',
  ghost: 'bg-transparent text-secondary hover:bg-ink-800 hover:text-primary active:bg-ink-850',
  subtle: 'bg-brand-500/12 text-brand-400 border border-brand-500/25 hover:bg-brand-500/20 hover:text-brand-300',
  danger: 'bg-danger/12 text-danger border border-danger/30 hover:bg-danger/20 hover:text-danger/80',
  outline:
    'bg-transparent text-primary border border-line-strong hover:bg-ink-850 hover:border-brand-500/50',
};

const SIZES = {
  xs: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  sm: 'h-8.5 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11.5 px-5 text-[15px] gap-2 rounded-xl',
};

const BASE =
  'relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium ' +
  'transition-[background-color,border-color,color,transform,box-shadow] duration-150 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ' +
  'disabled:pointer-events-none disabled:opacity-45 active:translate-y-px';

/**
 * The single button primitive for the app.
 *
 * Polymorphic via `as`, which lets it render a react-router `Link` (or `a`)
 * while keeping identical styling and keyboard behaviour.
 *
 * @param {object} props
 * @param {'primary'|'secondary'|'ghost'|'subtle'|'danger'|'outline'} [props.variant]
 * @param {'xs'|'sm'|'md'|'lg'} [props.size]
 * @param {boolean} [props.loading]  Shows a spinner and blocks interaction.
 * @param {boolean} [props.iconOnly]  Square padding, for toolbar buttons.
 * @param {boolean} [props.fullWidth]
 * @param {React.ElementType} [props.as]  Element or component to render.
 */
export const Button = forwardRef(function Button(
  {
    as: Component = 'button',
    variant = 'primary',
    size = 'md',
    loading = false,
    iconOnly = false,
    fullWidth = false,
    className = '',
    children,
    disabled,
    type,
    ...rest
  },
  ref
) {
  const isNativeButton = Component === 'button';
  const resolvedType = isNativeButton ? (type ?? 'button') : undefined;

  const widthClass = iconOnly
    ? size === 'xs'
      ? 'w-7 px-0'
      : size === 'sm'
        ? 'w-8.5 px-0'
        : size === 'lg'
          ? 'w-11.5 px-0'
          : 'w-10 px-0'
    : '';

  return (
    <Component
      ref={ref}
      type={resolvedType}
      disabled={isNativeButton ? disabled || loading : undefined}
      aria-busy={loading || undefined}
      aria-disabled={!isNativeButton && (disabled || loading) ? true : undefined}
      className={`${BASE} ${VARIANTS[variant] ?? VARIANTS.primary} ${SIZES[size] ?? SIZES.md} ${widthClass} ${
        fullWidth ? 'w-full' : ''
      } ${className}`}
      {...rest}
    >
      {loading && <Loader aria-hidden className="size-3.5 shrink-0 animate-spin" />}
      {children}
    </Component>
  );
});

/**
 * Small square icon button with a required accessible name.
 * Separate from `Button` because it always needs `label` rather than children.
 */
export const IconButton = forwardRef(function IconButton(
  { label, size = 'md', variant = 'ghost', className = '', children, ...rest },
  ref
) {
  return (
    <Button
      ref={ref}
      as="button"
      type="button"
      aria-label={label}
      title={label}
      iconOnly
      variant={variant}
      size={size}
      className={className}
      {...rest}
    >
      {children}
    </Button>
  );
});
