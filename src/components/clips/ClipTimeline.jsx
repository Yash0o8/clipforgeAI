import { useCallback, useEffect, useRef, useState } from 'react';
import { CLIP_LIMITS } from '../../utils/constants.js';
import { formatClock } from '../../utils/formatDuration.js';

/** Convert a client X position into seconds within the source timeline. */
function positionToSeconds(clientX, rect, sourceDuration) {
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return ratio * sourceDuration;
}

/**
 * Draggable trim handles for a clip window.
 *
 * Pointer drag and keyboard (arrows / Home / End) both work, because a
 * frame-accurate trim is unusable with a mouse alone. Each handle is a
 * `role="slider"` with its own accessible value.
 */
export function ClipTimeline({
  startSec,
  endSec,
  sourceDuration,
  playheadSec,
  onChange,
  onScrub,
  className = '',
}) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(null);

  const toPercent = useCallback(
    (seconds) => (sourceDuration > 0 ? (seconds / sourceDuration) * 100 : 0),
    [sourceDuration]
  );

  /* --- Pointer dragging ------------------------------------------------- */

  const startDrag = useCallback(
    (edge) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDragging(edge);
      trackRef.current?.setPointerCapture?.(event.pointerId);
    },
    []
  );

  useEffect(() => {
    if (!dragging) return undefined;

    const onPointerMove = (event) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      onChange(dragging, positionToSeconds(event.clientX, rect, sourceDuration));
    };

    const onPointerUp = () => setDragging(null);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [dragging, onChange, sourceDuration]);

  /** Scrub the playhead when the empty part of the track is clicked. */
  const onTrackPointerDown = useCallback(
    (event) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      onScrub?.(positionToSeconds(event.clientX, rect, sourceDuration));
    },
    [onScrub, sourceDuration]
  );

  /* --- Keyboard --------------------------------------------------------- */

  /** Arrow keys nudge; Shift multiplies for coarse moves. */
  const onHandleKeyDown = useCallback(
    (edge) => (event) => {
      const step = event.shiftKey ? 5 : CLIP_LIMITS.SNAP;
      const current = edge === 'start' ? startSec : endSec;
      let next;

      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          next = current - step;
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          next = current + step;
          break;
        case 'Home':
          next = edge === 'start' ? 0 : startSec + CLIP_LIMITS.MIN_DURATION;
          break;
        case 'End':
          next = edge === 'start' ? endSec - CLIP_LIMITS.MIN_DURATION : sourceDuration;
          break;
        case 'PageDown':
          next = current - 15;
          break;
        case 'PageUp':
          next = current + 15;
          break;
        default:
          return;
      }

      event.preventDefault();
      onChange(edge, next);
    },
    [endSec, onChange, sourceDuration, startSec]
  );

  const duration = endSec - startSec;
  const left = toPercent(startSec);
  const width = toPercent(duration);

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="tabular text-[11.5px] text-faint">
          Trim window{' '}
          <span className="font-medium text-secondary">
            {formatClock(startSec)} – {formatClock(endSec)}
          </span>
        </p>
        <p className="tabular text-[11.5px] text-faint">
          <span className="font-medium text-secondary">{formatClock(duration)}</span> of{' '}
          {formatClock(sourceDuration)}
        </p>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        className="group relative h-11 cursor-pointer touch-none select-none rounded-md bg-ink-925"
      >
        {/* Ruler ticks */}
        <div aria-hidden className="absolute inset-0 flex justify-between px-0">
          {Array.from({ length: 11 }, (_, index) => (
            <span
              key={index}
              className={`w-px ${index % 5 === 0 ? 'bg-line-strong' : 'bg-line'}`}
            />
          ))}
        </div>

        {/* Selected window */}
        <div
          className="absolute inset-y-1 rounded border border-brand-500/40 bg-brand-500/15"
          style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
        />

        {/* Playhead */}
        {playheadSec != null && playheadSec >= startSec && playheadSec <= endSec && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-brand-300"
            style={{ left: `${toPercent(playheadSec)}%` }}
          />
        )}

        {['start', 'end'].map((edge) => {
          const value = edge === 'start' ? startSec : endSec;
          return (
            <button
              key={edge}
              type="button"
              role="slider"
              aria-label={edge === 'start' ? 'Clip start time' : 'Clip end time'}
              aria-valuemin={0}
              aria-valuemax={Math.round(sourceDuration)}
              aria-valuenow={Number(value.toFixed(1))}
              aria-valuetext={formatClock(value)}
              tabIndex={0}
              onPointerDown={startDrag(edge)}
              onKeyDown={onHandleKeyDown(edge)}
              className={`absolute inset-y-0 z-10 flex w-3.5 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ${
                dragging === edge
                  ? 'border-brand-300 bg-brand-300'
                  : 'border-brand-400/70 bg-brand-500 hover:border-brand-300'
              }`}
              style={{ left: `${toPercent(value)}%` }}
            >
              <span aria-hidden className="h-3.5 w-0.5 rounded-full bg-white/80" />
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] text-faint">
        Drag the handles or focus them and use arrow keys. Hold Shift for 5-second steps.
      </p>
    </div>
  );
}
