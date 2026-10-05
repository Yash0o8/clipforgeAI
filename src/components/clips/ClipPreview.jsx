import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Film, Pause, Play } from 'lucide-react';
import { CAPTION_PRESET_MAP } from '../../utils/constants.js';
import { formatClock } from '../../utils/formatDuration.js';

/**
 * Observe an element's content box.
 * Used to size the preview frame exactly, so the aspect-ratio box is always a
 * true match of the chosen ratio without letterboxing artefacts.
 */
function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((current) =>
        // Sub-pixel churn from scrollbars would otherwise re-render constantly.
        Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1
          ? current
          : { width, height }
      );
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

/**
 * Word timings for the caption overlay.
 *
 * When the caption text still matches a transcript segment, its real word-level
 * timings are reused, which is what makes the Karaoke preset accurate. Once the
 * user edits the caption the timings no longer apply, so words are spread
 * evenly across the clip instead.
 */
function useCaptionWords(clip, captionText) {
  return useMemo(() => {
    const start = clip?.startSec ?? 0;
    const end = clip?.endSec ?? start;
    const text = (captionText ?? '').trim();

    if (!text) return [];

    const match = clip?.transcript?.find((segment) => segment.text === text);
    if (match?.words?.length) return match.words;

    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || 1;
    const span = Math.max(0.4, end - start);
    let cursor = start;

    return tokens.map((token, index) => {
      const share = (token.length / totalChars) * span;
      const word = { text: token, startSec: cursor, endSec: cursor + share };
      cursor += share;
      return index === tokens.length - 1 ? { ...word, endSec: end } : word;
    });
  }, [clip?.startSec, clip?.endSec, clip?.transcript, captionText]);
}

/** Deterministic hue per clip, so posters stay recognisable across reloads. */
function posterHues(seed = 0) {
  const hue = 250 + (seed % 90); // violet -> indigo -> blue
  return {
    from: `hsl(${hue} 55% 16%)`,
    via: `hsl(${(hue + 18) % 360} 48% 11%)`,
    to: 'hsl(250 45% 7%)',
    accent: `hsl(${hue} 85% 72%)`,
  };
}

/** Decorative frame used when no real media can be shown. */
function PosterFrame({ seed, label, sublabel, aspectValue }) {
  const hues = posterHues(seed);

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        aspectRatio: aspectValue,
        backgroundImage: `linear-gradient(150deg, ${hues.from} 0%, ${hues.via} 52%, ${hues.to} 100%)`,
      }}
    >
      {/* Diagonal accent stripe keeps flat gradients from looking empty. */}
      <div
        aria-hidden
        className="absolute -inset-x-1/4 -top-1/4 h-3/4 rotate-[-18deg] opacity-30 blur-2xl"
        style={{ background: `radial-gradient(closest-side, ${hues.accent}, transparent)` }}
      />
      <div aria-hidden className="absolute inset-0 bg-grid opacity-40" />

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
        <Film aria-hidden className="size-5 text-white/35" />
        <p className="line-clamp-2 text-[11.5px] leading-snug font-medium text-white/75">{label}</p>
        {sublabel && <p className="tabular text-[10px] text-white/40">{sublabel}</p>}
      </div>
    </div>
  );
}

/**
 * Caption overlay rendered inside the preview frame.
 * Renders nothing when the caption text is empty.
 */
function CaptionOverlay({ clip, preset, captionText, currentTime, frameWidth }) {
  const words = useCaptionWords(clip, captionText);
  const style = preset?.style ?? CAPTION_PRESET_MAP.clean.style;

  if (!captionText?.trim()) return null;

  const fontSize = Math.max(9, style.size * frameWidth);
  const shared = {
    fontSize,
    fontWeight: style.weight,
    lineHeight: 1.18,
    textAlign: 'center',
    textTransform: style.transform,
    color: style.color,
    background: style.background,
    borderRadius: style.radius,
    padding: style.padding,
    textShadow: style.shadow === 'none' ? undefined : style.shadow,
  };

  const anchor =
    style.position === 'top'
      ? 'items-start pt-[12%]'
      : style.position === 'center'
        ? 'items-center'
        : 'items-end pb-[13%]';

  // Karaoke highlights whichever word the playhead is inside.
  const activeIndex = style.karaoke
    ? words.findIndex((word) => currentTime >= word.startSec && currentTime < word.endSec)
    : -1;

  return (
    <div className={`pointer-events-none absolute inset-0 flex justify-center px-4 ${anchor}`}>
      {style.karaoke ? (
        <p className="inline max-w-full" style={shared}>
          {words.map((word, index) => {
            const active = index === activeIndex;
            return (
              <span
                key={`${word.text}-${index}`}
                className="transition-colors duration-100"
                style={{
                  color: active ? style.highlight : style.color,
                  textShadow: active ? `0 0 16px ${style.highlight}` : shared.textShadow,
                  opacity: active || activeIndex === -1 ? 1 : 0.75,
                }}
              >
                {word.text}
                {index < words.length - 1 ? ' ' : ''}
              </span>
            );
          })}
        </p>
      ) : (
        <p className="inline max-w-full" style={shared}>
          {captionText}
        </p>
      )}
    </div>
  );
}

/**
 * Clip preview surface.
 *
 * Renders a real `<video>` when the source file is available in this browser
 * (i.e. the user uploaded it during this session), and an honest poster
 * placeholder otherwise — never a fabricated still.
 *
 * @param {object} props
 * @param {object} props.clip
 * @param {string|null} [props.sourceUrl]  `blob:` URL of the local file.
 * @param {string} [props.variant]          'player' | 'poster'
 * @param {number} [props.currentTime]      Playhead, seconds.
 * @param {boolean} [props.isPlaying]
 * @param {() => void} [props.onTogglePlay]            Transport button.
 * @param {(playing: boolean) => void} [props.onPlayingChange]  Reports real playback state.
 * @param {(seconds: number) => void} [props.onTimeUpdate]  Reports the playhead.
 * @param {number} [props.seekTo]         Seek target; applied when it changes.
 * @param {object} [props.preset]         Caption preset from constants.
 * @param {string} [props.captionText]
 * @param {boolean} [props.showCaptions]
 * @param {boolean} [props.autoPlay]   Start muted playback on mount.
 * @param {number} [props.timeBase]   Media-time offset of the loaded file.
 */
export function ClipPreview({
  clip,
  sourceUrl,
  variant = 'player',
  currentTime = 0,
  isPlaying = false,
  onTogglePlay,
  onPlayingChange,
  onTimeUpdate,
  seekTo,
  preset,
  captionText,
  showCaptions = true,
  autoPlay = false,
  timeBase = 0,
  className = '',
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const { width, height } = useElementSize(containerRef);

  const aspectValue = clip?.aspectRatio === '1:1' ? 1 : clip?.aspectRatio === '16:9' ? 16 / 9 : 9 / 16;

  // Exact frame box: fit the ratio inside the measured container.
  const frameWidth = width > 0 ? Math.min(width, height * aspectValue) : 0;
  const frameHeight = frameWidth > 0 ? frameWidth / aspectValue : 0;

  const hasSource = Boolean(sourceUrl) && variant === 'player';

  /*
   * Media time vs. clip time.
   *
   * `clip.startSec`/`endSec` are positions in the *original* upload, so the
   * source media's clock and the clip's clock only agree when the whole upload
   * is loaded. A rendered file is already trimmed, so its timeline starts at 0
   * and every seek past the first second would fall off the end of the file.
   *
   * `timeBase` is that offset: 0 for the source upload, `clip.startSec` for a
   * render. Media time is clip time minus the base, and reports are converted
   * back so the transport, transcript and caption overlay keep sharing one
   * clock in source coordinates.
   */
  const windowStart = (clip?.startSec ?? 0) - timeBase;
  const windowEnd = (clip?.endSec ?? 0) - timeBase;
  const toMediaTime = useCallback((seconds) => seconds - timeBase, [timeBase]);

  /* --- Sync the element to the clip window and play/pause state ---------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasSource || !clip) return;

    // Keep playback inside the clip's window, in this file's own time.
    if (video.currentTime < windowStart || video.currentTime > windowEnd) {
      video.currentTime = Math.max(0, windowStart);
    }

    if (isPlaying) {
      // Autoplay can be refused by the browser; the paused state stays correct.
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [hasSource, isPlaying, clip, windowStart, windowEnd]);

  /* --- External seek, driven by the timeline scrubber -------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasSource || seekTo == null) return;
    video.currentTime = Math.max(0, toMediaTime(seekTo));
  }, [seekTo, hasSource, clip?.startSec, toMediaTime]);

  /* --- Autoplay on open --------------------------------------------------- */
  // The ref guards against re-announcing on every clip change: this is a
  // once-per-mount preference, not a reaction to props. Playback is muted, so
  // browsers allow it without a gesture.
  const autoplayedRef = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasSource || !autoPlay || autoplayedRef.current) return;
    autoplayedRef.current = true;
    video.currentTime = Math.max(0, windowStart);
    video.play().then(() => onPlayingChange?.(true)).catch(() => {});
  }, [hasSource, autoPlay, windowStart, onPlayingChange]);

  // Loop back to the clip start when the end is reached, and report the playhead.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasSource || !clip) return undefined;

    // Named distinctly from the `onTimeUpdate` prop to avoid self-recursion.
    const handleTimeUpdate = () => {
      if (video.currentTime >= windowEnd) {
        video.currentTime = Math.max(0, windowStart);
      }
      onTimeUpdate?.(video.currentTime + timeBase);
    };
    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => video.removeEventListener('timeupdate', handleTimeUpdate);
  }, [hasSource, clip, onTimeUpdate, windowStart, windowEnd, timeBase]);

  const sublabel =
    variant === 'poster'
      ? `${formatClock(clip?.startSec ?? 0)} – ${formatClock(clip?.endSec ?? 0)}`
      : null;

  return (
    <div ref={containerRef} className={`relative flex h-full w-full items-center justify-center ${className}`}>
      {frameWidth > 0 && (
        <div
          className="relative overflow-hidden rounded-lg bg-black shadow-[0_18px_50px_-24px_rgba(0,0,0,0.9)]"
          style={{ width: frameWidth, height: frameHeight }}
        >
          {hasSource ? (
            <video
              ref={videoRef}
              src={sourceUrl}
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 size-full cursor-pointer object-contain"
              aria-label={`Preview of ${clip?.title ?? 'clip'}`}
            />
          ) : (
            <PosterFrame
              seed={clip?.posterSeed ?? 0}
              label={clip?.title ?? 'Clip'}
              sublabel={sublabel}
              aspectValue={aspectValue}
            />
          )}

          {showCaptions && frameWidth > 0 && (
            <CaptionOverlay
              clip={clip}
              preset={preset}
              captionText={captionText ?? clip?.caption?.text}
              currentTime={currentTime}
              frameWidth={frameWidth}
            />
          )}

          {/* Duration chip, bottom-left. */}
          {clip?.durationSec > 0 && (
            <span className="tabular absolute bottom-2 left-2 rounded bg-scrim/80 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur-sm">
              {formatClock(clip.durationSec)}
            </span>
          )}

          {hasSource && (
            <button
              type="button"
              onClick={() => onTogglePlay?.()}
              aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
              className="absolute inset-0 flex items-center justify-center focus-visible:outline-2 focus-visible:outline-brand-400"
            >
              {!isPlaying && (
                <span className="flex size-12 items-center justify-center rounded-full bg-scrim/60 text-white backdrop-blur-sm transition-transform hover:scale-105">
                  <Play aria-hidden className="size-5 translate-x-0.5 fill-current" />
                </span>
              )}
              {isPlaying && (
                <span className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-scrim/60 text-white backdrop-blur-sm">
                  <Pause aria-hidden className="size-3.5 fill-current" />
                </span>
              )}
            </button>
          )}
        </div>
      )}

      {/* Explains why a poster is being shown rather than real footage. */}
      {!hasSource && variant === 'player' && (
        <p className="absolute right-2 bottom-1 flex items-center gap-1 text-[10px] text-white/35">
          <Captions aria-hidden className="size-3" />
          Preview unavailable
        </p>
      )}
    </div>
  );
}
