import { Loader as LoaderIcon } from 'lucide-react';

/**
 * Indeterminate spinner. `label` becomes both the accessible name and the
 * visually-hidden text, so a spinner is never announced as "image".
 */
export function Loader({ size = 'md', label = 'Loading', className = '' }) {
  const sizes = { xs: 'size-3', sm: 'size-4', md: 'size-5', lg: 'size-7', xl: 'size-9' };
  return (
    <span role="status" className={`inline-flex items-center ${className}`}>
      <LoaderIcon aria-hidden className={`${sizes[size] ?? sizes.md} animate-spin text-brand-400`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Three-dot pulse, for inline "thinking" states such as stage descriptions.
 */
export function DotsLoader({ label = 'Working', className = '' }) {
  return (
    <span role="status" className={`inline-flex items-center gap-1 ${className}`}>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 animate-pulse rounded-full bg-brand-400"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Full-surface loading state for route-level suspense or empty results.
 */
export function LoaderBlock({ label = 'Loading', hint, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 py-20 ${className}`}>
      <Loader size="xl" label={label} />
      <p className="text-sm font-medium text-secondary">{label}</p>
      {hint && <p className="max-w-xs text-center text-xs text-faint">{hint}</p>}
    </div>
  );
}

/**
 * Shimmering placeholder block.
 * `w`/`h` accept any Tailwind size class so layouts do not shift on load.
 */
export function Skeleton({ w = 'w-full', h = 'h-4', className = '', rounded = 'rounded-md' }) {
  return <div aria-hidden className={`skeleton ${w} ${h} ${rounded} ${className}`} />;
}

/** Common skeleton shapes, so pages stay consistent without magic strings. */
export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          w={index === lines - 1 ? 'w-2/3' : 'w-full'}
          h="h-3"
          className={index === lines - 1 ? '' : 'opacity-90'}
        />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="panel overflow-hidden">
      <Skeleton h="h-40" rounded="rounded-none" />
      <div className="space-y-2.5 p-4">
        <Skeleton w="w-3/4" h="h-4" />
        <SkeletonText lines={2} />
      </div>
    </div>
  );
}
