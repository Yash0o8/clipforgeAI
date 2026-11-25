import { useId, useState } from 'react';
import { Check, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { TextArea, TextField } from '../common/TextField.jsx';
import { CAPTION_POSITIONS, CAPTION_PRESETS } from '../../utils/constants.js';
import { Button } from '../common/Button.jsx';
import { useToast } from '../../hooks/useToast.js';
import { formatClock } from '../../utils/formatDuration.js';

const SEGMENT_STEP = 0.01;
const MIN_SEGMENT_GAP = 0.01;
const ADD_SEGMENT_GAP = 0.5;

function toFiniteNumber(value) {
  if (value === '' || value === null || value === undefined) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function roundSeconds(value) {
  return Math.round(value * 100) / 100;
}

function segmentProblem(segment) {
  const start = toFiniteNumber(segment?.startSec);
  const end = toFiniteNumber(segment?.endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 'Enter a valid start and end time.';
  }
  if (start < 0) return 'Start must be at least 0 and before End.';
  if (end <= start) return 'End must be after Start.';
  return null;
}

/** Colour swatch + label, matching the on-frame caption treatment. */
function PresetSwatch({ style }) {
  return (
    <span
      aria-hidden
      className="flex h-9 w-full items-center justify-center rounded-md border border-line-strong bg-ink-925 px-2"
    >
      <span
        className="line-clamp-1 text-center"
        style={{
          fontSize: Math.max(8, style.size * 62),
          fontWeight: style.weight,
          textTransform: style.transform,
          color: style.color,
          background: style.background === 'transparent' ? undefined : style.background,
          borderRadius: style.radius ? style.radius / 2 : 0,
          padding: style.background === 'transparent' ? 0 : '0.15em 0.5em',
          lineHeight: 1.1,
        }}
      >
        Caption
      </span>
    </span>
  );
}

/**
 * Caption text, preset and placement controls.
 *
 * The selected preset is rendered as a live swatch so the choice can be made
 * visually, and "Reset" restores the AI-generated caption.
 */
export function CaptionEditor({
  caption,
  captionSettings,
  presetId,
  onChangeText,
  onChangePreset,
  onChangeCaption,
  originalText = '',
  position,
  onChangePosition,
  segments = [],
  onChangeSegments,
  clipStartSec = 0,
  clipEndSec = 0,
  disabled = false,
}) {
  const toast = useToast();
  const preset = CAPTION_PRESETS.find((item) => item.id === presetId) ?? CAPTION_PRESETS[0];
  const isDirty = caption !== originalText;
  const hintIdBase = useId();
  const [invalidEntry, setInvalidEntry] = useState(null);

  const commitSegment = (index, patch, message) => {
    setInvalidEntry(message ? { index, message } : null);
    onChangeSegments?.(
      (Array.isArray(segments) ? segments : []).map((segment, i) =>
        i === index ? { ...segment, ...patch } : segment
      )
    );
  };

  const rejectEntry = (index, message) => setInvalidEntry({ index, message });

  const handleStartChange = (index, segment, rawValue) => {
    const start = toFiniteNumber(rawValue);
    const end = toFiniteNumber(segment?.endSec);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= 0) {
      rejectEntry(index, 'Start must be at least 0 and before End.');
      return;
    }
    const clamped = roundSeconds(Math.max(0, Math.min(start, end - MIN_SEGMENT_GAP)));
    const message =
      clamped === roundSeconds(start)
        ? undefined
        : 'Start was adjusted to stay at least 0 and before End.';
    commitSegment(index, { startSec: clamped }, message);
  };

  const handleEndChange = (index, segment, rawValue) => {
    const start = toFiniteNumber(segment?.startSec);
    const end = toFiniteNumber(rawValue);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end)) {
      rejectEntry(index, 'End must be after Start.');
      return;
    }
    const clamped = roundSeconds(Math.max(start + MIN_SEGMENT_GAP, end));
    const message =
      clamped === roundSeconds(end) ? undefined : 'End was adjusted to stay after Start.';
    commitSegment(index, { endSec: clamped }, message);
  };

  const addSegment = () => {
    const clipStart = toFiniteNumber(clipStartSec);
    const start = Number.isFinite(clipStart) ? Math.max(0, clipStart) : 0;
    const clipEnd = toFiniteNumber(clipEndSec);
    const candidate =
      Number.isFinite(clipEnd) && clipEnd > 0 ? Math.min(clipEnd, start + 2) : start + 2;
    const end = Math.max(start + ADD_SEGMENT_GAP, candidate);
    setInvalidEntry(null);
    onChangeSegments?.([
      ...(segments || []),
      {
        startSec: roundSeconds(start),
        endSec: roundSeconds(end),
        text: caption || 'New caption',
      },
    ]);
  };

  const copyCaption = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      toast.success('Caption copied to clipboard');
    } catch {
      // Clipboard API needs a secure context and can be blocked outright.
      toast.warning('Could not access the clipboard', {
        body: 'Select the caption text and copy it manually.',
      });
    }
  };

  return (
    <div className="space-y-5">
      <TextArea
        label="Caption text"
        rows={4}
        value={caption}
        onChange={(event) => onChangeText(event.target.value)}
        disabled={disabled}
        maxLength={180}
        hint="Keep it to one or two lines. Long captions are cut off on mobile."
        placeholder="Write the caption that appears on the clip"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="secondary"
          onClick={copyCaption}
          disabled={disabled || !caption.trim()}
        >
          <Copy aria-hidden className="size-3" />
          Copy
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onChangeText(originalText)}
          disabled={disabled || !isDirty || !originalText}
        >
          <RefreshCw aria-hidden className="size-3" />
          Reset to original
        </Button>
        <label className="ml-auto flex items-center gap-2 text-[12px] text-secondary">
          <input
            type="checkbox"
            checked={Boolean(captionSettings?.keywordHighlight)}
            onChange={(e) => onChangeCaption?.({ keywordHighlight: e.target.checked })}
            disabled={disabled}
          />
          Keyword highlight
        </label>
      </div>

      <fieldset disabled={disabled}>
        <legend className="mb-2.5 text-[12px] font-semibold tracking-wide text-secondary uppercase">
          Caption style
        </legend>

        <div className="grid grid-cols-2 gap-2">
          {CAPTION_PRESETS.map((item) => {
            const selected = item.id === presetId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onChangePreset(item.id)}
                aria-pressed={selected}
                className={`flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ${
                  selected
                    ? 'border-brand-500/60 bg-brand-500/[0.08]'
                    : 'border-line-strong bg-ink-900 hover:border-line-hover'
                }`}
              >
                <PresetSwatch style={item.style} />
                <span className="flex items-center justify-between gap-1">
                  <span
                    className={`text-[11.5px] font-medium ${selected ? 'text-primary' : 'text-secondary'}`}
                  >
                    {item.label}
                  </span>
                  {selected && <Check aria-hidden className="size-3 text-brand-400" />}
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-faint">{preset.description}</p>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="mb-2 text-[12px] font-semibold tracking-wide text-secondary uppercase">
          Vertical position
        </legend>
        <div
          role="radiogroup"
          aria-label="Caption vertical position"
          className="grid grid-cols-2 gap-1.5 rounded-lg border border-line-strong bg-ink-900 p-1 sm:grid-cols-4"
        >
          {CAPTION_POSITIONS.map((option) => {
            const selected = option.id === position;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChangePosition?.(option.id)}
                className={`rounded-md py-1.5 text-[12px] font-medium transition-colors ${
                  selected ? 'bg-ink-750 text-primary' : 'text-secondary hover:text-primary'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-semibold tracking-wide text-secondary uppercase">Caption segments</p>
          <Button
            size="xs"
            variant="secondary"
            disabled={disabled}
            onClick={addSegment}
          >
            <Plus aria-hidden className="size-3" /> Add
          </Button>
        </div>
        <p className="text-[11px] text-faint">Quick edit timed captions. Save and re-export to re-render without reanalysis.</p>
        <div className="space-y-2 max-h-56 overflow-auto pr-1">
          {(segments || []).map((seg, i) => {
            const problem =
              invalidEntry?.index === i ? invalidEntry.message : segmentProblem(seg);
            const hintId = `${hintIdBase}-segment-${i}-range`;
            const start = toFiniteNumber(seg.startSec);
            const endMin = Number.isFinite(start)
              ? roundSeconds(Math.max(0, start + MIN_SEGMENT_GAP))
              : MIN_SEGMENT_GAP;
            return (
              <div key={`segment-${i}`} className="rounded-md border border-line bg-ink-900/50 p-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <TextField
                    label="Start"
                    type="number"
                    min={0}
                    step={SEGMENT_STEP}
                    value={String(seg.startSec ?? '')}
                    onChange={(event) => handleStartChange(i, seg, event.target.value)}
                    aria-invalid={Boolean(problem) || undefined}
                    aria-describedby={problem ? hintId : undefined}
                  />
                  <TextField
                    label="End"
                    type="number"
                    min={endMin}
                    step={SEGMENT_STEP}
                    value={String(seg.endSec ?? '')}
                    onChange={(event) => handleEndChange(i, seg, event.target.value)}
                    aria-invalid={Boolean(problem) || undefined}
                    aria-describedby={problem ? hintId : undefined}
                  />
                </div>
                {problem && (
                  <p id={hintId} aria-live="polite" className="text-[11.5px] leading-relaxed text-danger">
                    {problem}
                  </p>
                )}
                <TextField
                  label={`Text (${formatClock(seg.startSec || 0)})`}
                  value={seg.text ?? ''}
                  onChange={(event) => commitSegment(i, { text: event.target.value })}
                />
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setInvalidEntry(null);
                      onChangeSegments?.((segments || []).filter((_, idx) => idx !== i));
                    }}
                  >
                    <Trash2 aria-hidden className="size-3" /> Remove
                  </Button>
                </div>
              </div>
            );
          })}
          {!segments?.length && <p className="text-[11px] text-faint">No manual segments. Transcript/caption text timing will be used.</p>}
        </div>
      </div>
    </div>
  );
}
