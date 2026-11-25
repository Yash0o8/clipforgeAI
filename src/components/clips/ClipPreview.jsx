import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Film, Pause, Play, Volume2, VolumeX } from 'lucide-react';
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
      const wordStart = cursor;
      const wordEnd = index === tokens.length - 1 ? end : Math.min(end, cursor + share);
      cursor = wordEnd;
      return { text: token, startSec: wordStart, endSec: Math.max(wordStart + 0.03, wordEnd) };
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
function CaptionOverlay({ clip, preset, captionText, caption, currentTime, frameWidth }) {
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
      : style.position === 'center' || style.position === 'divider'
        ? 'items-center'
        : 'items-end pb-[13%]';

  // Karaoke highlights whichever word the playhead is inside.
  const activeIndex = style.karaoke
    ? words.findIndex((word) => currentTime >= word.startSec && currentTime < word.endSec)
    : -1;

  const keywordSet = new Set(
    (clip?.keywords || clip?.meta?.keywords || [])
      .map((k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean)
  );
  const keywordHighlight = caption?.keywordHighlight ?? clip?.caption?.keywordHighlight ?? false;
  const highlightColor = caption?.highlightColor || style.highlight || '#fde68a';

  const renderHighlightedText = (text) =>
    text.split(/(\s+)/).map((part, i) => {
      if (!part.trim()) return <span key={i}>{part}</span>;
      const norm = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      const isKeyword = keywordHighlight && norm && keywordSet.has(norm);
      return (
        <span
          key={i}
          style={
            isKeyword
              ? {
                  color: highlightColor,
                  textShadow: `0 0 18px ${highlightColor}`,
                  display: 'inline-block',
                  transform: preset?.id === 'hormozi' ? 'scale(1.06)' : undefined,
                }
              : undefined
          }
        >
          {part}
        </span>
      );
    });

  const hormoziPop = preset?.id === 'hormozi';

  return (
    <div className={`pointer-events-none absolute inset-0 flex justify-center px-4 ${anchor}`}>
      {style.karaoke ? (
        <p className="inline max-w-full" style={shared}>
          {words.map((word, index) => {
            const active = index === activeIndex;
            const norm = word.text.toLowerCase().replace(/[^a-z0-9]/g, '');
            const isKeyword = keywordHighlight && norm && keywordSet.has(norm);
            const activeColor = style.highlight || highlightColor;
            return (
              <span
                key={`${word.text}-${index}`}
                className="transition-all duration-100"
                style={{
                  color: active ? activeColor : isKeyword ? highlightColor : style.color,
                  textShadow: active
                    ? `0 0 18px ${activeColor}, 0 2px 10px rgba(0,0,0,0.6)`
                    : isKeyword
                      ? `0 0 12px ${highlightColor}`
                      : shared.textShadow,
                  opacity: active || activeIndex === -1 ? 1 : 0.72,
                  display: 'inline-block',
                  transform: active && hormoziPop ? 'scale(1.08) translateY(-1px)' : 'scale(1)',
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
          {renderHighlightedText(captionText)}
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
  backgroundUrl = null,
  facecamUrl = null,
  renderMode = null,
  facecamEnabled = false,
  facecamBox = null,
  renderReady = false,
  className = '',
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const { width, height } = useElementSize(containerRef);
  const [muted, setMuted] = useState(false);
  const [showGuides, setShowGuides] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const aspectValue = clip?.aspectRatio === '1:1' ? 1 : clip?.aspectRatio === '16:9' ? 16 / 9 : 9 / 16;
  const mode = renderMode ?? clip?.renderMode ?? clip?.export?.renderMode ?? 'default';
  const isSplit = mode === 'split_screen' && !renderReady;
  const showFacecam = mode === 'gaming' && facecamEnabled && Boolean(facecamUrl) && !renderReady;
  const box = facecamBox ?? clip?.facecamBox ?? { x: 0.72, y: 0.04, w: 0.24, h: 0.24 };

  // Exact frame box: fit the ratio inside the measured container.
  const frameWidth = width > 0 ? Math.min(width, height * aspectValue) : 0;
  const frameHeight = frameWidth > 0 ? frameWidth / aspectValue : 0;

  const hasSource = Boolean(sourceUrl) && variant === 'player';
  const showPoster = !hasSource || mediaError;

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
  // once-per-mount preference. Autoplay starts muted to satisfy browser policy.
  const autoplayedRef = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasSource || !autoPlay || autoplayedRef.current) return;
    autoplayedRef.current = true;
    video.currentTime = Math.max(0, windowStart);
    video.muted = true;
    setMuted(true);
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
          {showPoster ? (
            <PosterFrame
              seed={clip?.posterSeed ?? 0}
              label={mediaError ? 'Preview unavailable' : (clip?.title ?? 'Clip')}
              sublabel={mediaError ? 'Source video could not be loaded' : sublabel}
              aspectValue={aspectValue}
            />
          ) : (
            <>
              {isSplit ? (
                <div className="absolute inset-0 grid grid-rows-2 bg-black">
                  <div className="relative overflow-hidden bg-black">
                    <video
                      key={`split-source-${retryKey}`}
                      ref={videoRef}
                      src={sourceUrl}
                      playsInline
                      preload="metadata"
                      muted={muted}
                      className="absolute inset-0 size-full cursor-pointer object-cover"
                      aria-label={`Preview of ${clip?.title ?? 'clip'}`}
                      onError={() => setMediaError(true)}
                      onLoadedData={() => setMediaError(false)}
                    />
                  </div>
                  <div className="relative overflow-hidden border-t border-white/10 bg-ink-950">
                    {backgroundUrl ? (
                      <video src={backgroundUrl} muted loop autoPlay playsInline preload="metadata" className="absolute inset-0 size-full object-cover" />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(124,58,237,0.22),_transparent_55%),linear-gradient(180deg,_rgba(20,20,32,0.95),_rgba(8,8,14,1))] text-[10px] text-white/45">
                        Select gameplay background
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <video
                    key={`source-${retryKey}`}
                    ref={videoRef}
                    src={sourceUrl}
                    playsInline
                    preload="metadata"
                    muted={muted}
                    className="absolute inset-0 size-full cursor-pointer object-contain"
                    aria-label={`Preview of ${clip?.title ?? 'clip'}`}
                    onError={() => setMediaError(true)}
                    onLoadedData={() => setMediaError(false)}
                  />
                  {showFacecam ? (
                    <video
                      src={facecamUrl}
                      muted
                      loop
                      autoPlay
                      playsInline
                      preload="metadata"
                      className="absolute z-10 rounded-md border border-white/20 object-cover shadow-lg"
                      style={{
                        left: `${box.x * 100}%`,
                        top: `${box.y * 100}%`,
                        width: `${box.w * 100}%`,
                        height: `${box.h * 100}%`,
                      }}
                    />
                  ) : null}
                </>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}
                className="absolute right-2 bottom-2 z-20 rounded-md bg-black/55 p-1.5 text-white/90 hover:bg-black/70"
                aria-label={muted ? 'Unmute preview' : 'Mute preview'}
                title={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? <VolumeX aria-hidden className="size-4" /> : <Volume2 aria-hidden className="size-4" />}
              </button>
            </>
          )}

          {showCaptions && frameWidth > 0 && !renderReady && (
            <CaptionOverlay
              clip={clip}
              preset={preset}
              caption={clip?.caption}
              captionText={captionText ?? clip?.caption?.text}
              currentTime={currentTime}
              frameWidth={frameWidth}
            />
          )}

          {/* Safe-area / composition guides, useful for social UI overlays. */}
          {showGuides && (
            <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
              <div className="absolute inset-x-[8%] inset-y-[10%] border border-dashed border-white/25" />
              <div className="absolute inset-x-[8%] bottom-[20%] border-t border-dashed border-white/20" />
              <div className="absolute inset-y-0 left-1/3 border-l border-white/10" />
              <div className="absolute inset-y-0 left-2/3 border-l border-white/10" />
              {isSplit && (
                <div className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-cyan-300/60" />
              )}
            </div>
          )}

          {(clip?.hookBanner || clip?.hook) &&
            !renderReady &&
            (currentTime - (clip?.startSec ?? 0)) >= 0 &&
            (currentTime - (clip?.startSec ?? 0)) <= 3 && (
              <div className="pointer-events-none absolute inset-x-0 top-[5%] z-20 flex justify-center px-4">
                <span className="rounded-md border border-white/10 bg-black/60 px-3 py-1.5 text-center text-[11px] font-extrabold tracking-[0.08em] text-white uppercase shadow-[0_4px_18px_rgba(0,0,0,0.5)] backdrop-blur-[1px]">
                  {clip.hookBanner || clip.hook}
                </span>
              </div>
            )}

          {/* Source chip: a finished render already has captions baked in. */}
          <span className="tabular absolute top-2 left-2 z-20 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-sm">
            {renderReady ? 'Rendered' : 'Preview'}
          </span>

          {/* Duration chip, bottom-left. */}
          {clip?.durationSec > 0 && (
            <span className="tabular absolute bottom-2 left-2 z-20 rounded bg-scrim/80 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur-sm">
              {formatClock(clip.durationSec)}
            </span>
          )}

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setShowGuides((value) => !value);
            }}
            aria-label={showGuides ? 'Hide composition guides' : 'Show composition guides'}
            title={showGuides ? 'Hide guides' : 'Guides'}
            className="absolute top-2 right-2 z-30 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/80 hover:bg-black/70"
          >
            {showGuides ? 'Guides on' : 'Guides'}
          </button>

          {hasSource && !mediaError && (
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
      {showPoster && variant === 'player' && (
        <div className="absolute right-2 bottom-1 flex items-center gap-2 text-[10px] text-white/45">
          <span className="flex items-center gap-1">
            <Captions aria-hidden className="size-3" />
            {mediaError ? 'Source unavailable — poster shown' : 'Preview unavailable'}
          </span>
          {mediaError && (
            <button
              type="button"
              onClick={() => {
                setMediaError(false);
                setRetryKey((value) => value + 1);
              }}
              className="rounded border border-white/20 px-1.5 py-0.5 font-medium text-white/70 transition-colors hover:border-white/40 hover:text-white"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
