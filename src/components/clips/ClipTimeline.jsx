import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLIP_LIMITS } from '../../utils/constants.js';
import { formatClock } from '../../utils/formatDuration.js';

/** Zoom levels: 1 = whole source, higher = tighter view around the playhead. */
const ZOOM_LEVELS = [1, 2, 4, 8, 16];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Draggable trim handles for a clip window.
 *
 * Pointer drag and keyboard (arrows / Home / End) both work, because a
 * frame-accurate trim is unusable with a mouse alone. Each handle is a
 * `role="slider"` with its own accessible value. Zoom keeps the playhead in
 * view without changing the underlying clip times, and optional snapping pulls
 * a handle to an analysis marker (spike/cut/SFX) for a meaningful trim point.
 */
export function ClipTimeline({
  startSec,
  endSec,
  sourceDuration,
  playheadSec,
  onChange,
  onScrub,
  markers = [],
  snapToMarkers = false,
  className = '',
}) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [zoomIndex, setZoomIndex] = useState(0);

  const zoom = ZOOM_LEVELS[zoomIndex];
  const viewSpan = sourceDuration > 0 ? sourceDuration / zoom : 1;
  const viewStart = useMemo(() => {
    if (sourceDuration <= 0) return 0;
    if (zoom === 1) return 0;
    const half = viewSpan / 2;
    return clamp((playheadSec ?? startSec) - half, 0, Math.max(0, sourceDuration - viewSpan));
  }, [zoom, viewSpan, sourceDuration, playheadSec, startSec]);
  const viewEnd = viewStart + viewSpan;

  const toPercent = useCallback(
    (seconds) => (viewSpan > 0 ? ((seconds - viewStart) / viewSpan) * 100 : 0),
    [viewSpan, viewStart]
  );

  /** Map a client X position into the visible time window. */
  const positionToSeconds = useCallback(
    (clientX, rect) => {
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return viewStart + ratio * viewSpan;
    },
    [viewStart, viewSpan]
  );

  /** Pull a value to a nearby marker when snapping is enabled. */
  const snap = useCallback(
    (seconds) => {
      if (!snapToMarkers || !markers.length) return seconds;
      let best = seconds;
      let bestDistance = viewSpan * 0.012; // ~1.2% of the visible window
      for (const marker of markers) {
        const t = Number(marker?.t);
        if (!Number.isFinite(t)) continue;
        const distance = Math.abs(t - seconds);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = t;
        }
      }
      return best;
    },
    [markers, snapToMarkers, viewSpan]
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
      onChange(dragging, snap(positionToSeconds(event.clientX, rect)));
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
  }, [dragging, onChange, positionToSeconds, snap]);

  /** Scrub the playhead when the empty part of the track is clicked. */
  const onTrackPointerDown = useCallback(
    (event) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      onScrub?.(positionToSeconds(event.clientX, rect));
    },
    [onScrub, positionToSeconds]
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
      onChange(edge, snap(clamp(next, 0, sourceDuration)));
    },
    [endSec, onChange, sourceDuration, startSec, snap]
  );

  const duration = endSec - startSec;
  const left = toPercent(startSec);
  const width = toPercent(duration);

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="tabular text-[11.5px] text-faint">
          Trim window{' '}
          <span className="font-medium text-secondary">
            {formatClock(startSec)} – {formatClock(endSec)}
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          <span className="tabular text-[11.5px] text-faint">
            <span className="font-medium text-secondary">{formatClock(duration)}</span> of{' '}
            {formatClock(sourceDuration)}
          </span>
          <button
            type="button"
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            disabled={zoomIndex === 0}
            aria-label="Zoom out timeline"
            className="rounded border border-line px-1.5 text-[11px] text-secondary hover:text-primary disabled:opacity-40"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setZoomIndex(0)}
            aria-label="Fit whole video"
            className="rounded border border-line px-1.5 text-[11px] text-secondary hover:text-primary"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            aria-label="Zoom in timeline"
            className="rounded border border-line px-1.5 text-[11px] text-secondary hover:text-primary disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        className="group relative h-12 cursor-pointer touch-none select-none rounded-md bg-ink-925"
      >
        {/* Ruler ticks, labelled at the visible window's start/end */}
        <div aria-hidden className="absolute inset-0 flex justify-between px-0">
          {Array.from({ length: 11 }, (_, index) => (
            <span
              key={index}
              className={`w-px ${index % 5 === 0 ? 'bg-line-strong' : 'bg-line'}`}
            />
          ))}
        </div>
        <span
          aria-hidden
          className="tabular pointer-events-none absolute bottom-0 left-1 text-[9px] text-faint"
        >
          {formatClock(viewStart)}
        </span>
        <span
          aria-hidden
          className="tabular pointer-events-none absolute right-1 bottom-0 text-[9px] text-faint"
        >
          {formatClock(viewEnd)}
        </span>

        {/* Analysis markers: spikes/cuts/dead-air help users see attractive areas */}
        {markers.map((m, i) => {
          const t = Number(m.t);
          if (!Number.isFinite(t) || t < viewStart - viewSpan || t > viewEnd + viewSpan) return null;
          const color =
            m.type === 'spike' ? 'bg-amber-400/80' :
            m.type === 'scene' ? 'bg-cyan-400/70' :
            m.type === 'sfx' ? 'bg-fuchsia-400/80' :
            m.type === 'dead' ? 'bg-rose-400/45' : 'bg-white/30';
          const w = m.type === 'dead' ? Math.max(0.4, toPercent(Number(m.end || t) - t)) : 0.2;
          return (
            <span
              key={`${m.type}-${i}-${t}`}
              aria-hidden
              title={m.label || m.type}
              className={`pointer-events-none absolute inset-y-1 rounded-sm ${color}`}
              style={{ left: `${toPercent(t)}%`, width: `${w}%`, minWidth: m.type === 'dead' ? undefined : 2 }}
            />
          );
        })}

        {/* Selected window */}
        <div
          className="absolute inset-y-1 rounded border border-brand-500/40 bg-brand-500/15"
          style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
        />

        {/* Playhead */}
        {playheadSec != null && playheadSec >= viewStart && playheadSec <= viewEnd && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-brand-300"
            style={{ left: `${toPercent(playheadSec)}%` }}
          />
        )}

        {['start', 'end'].map((edge) => {
          const value = edge === 'start' ? startSec : endSec;
          if (value < viewStart - viewSpan || value > viewEnd + viewSpan) return null;
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
        Drag the handles or focus them and use arrow keys. Hold Shift for 5-second steps. Zoom
        keeps the playhead in view.
      </p>
    </div>
  );
}
