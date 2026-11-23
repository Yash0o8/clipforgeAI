import { Check, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { TextArea, TextField } from '../common/TextField.jsx';
import { CAPTION_POSITIONS, CAPTION_PRESETS } from '../../utils/constants.js';
import { Button } from '../common/Button.jsx';
import { useToast } from '../../hooks/useToast.js';
import { formatClock } from '../../utils/formatDuration.js';

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
            onClick={() => {
              const start = Math.max(0, clipStartSec);
              const end = Math.min(clipEndSec || start + 2, start + 2);
              onChangeSegments?.([...(segments || []), { startSec: start, endSec: Math.max(start + 0.5, end), text: caption || 'New caption' }]);
            }}
          >
            <Plus aria-hidden className="size-3" /> Add
          </Button>
        </div>
        <p className="text-[11px] text-faint">Quick edit timed captions. Save and re-export to re-render without reanalysis.</p>
        <div className="space-y-2 max-h-56 overflow-auto pr-1">
          {(segments || []).map((seg, i) => (
            <div key={`${seg.startSec}-${i}`} className="rounded-md border border-line bg-ink-900/50 p-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <TextField label="Start" size="sm" value={String(seg.startSec ?? '')} onChange={(e) => {
                  const next = [...segments]; next[i] = { ...seg, startSec: Number(e.target.value) || 0 }; onChangeSegments?.(next);
                }} />
                <TextField label="End" size="sm" value={String(seg.endSec ?? '')} onChange={(e) => {
                  const next = [...segments]; next[i] = { ...seg, endSec: Number(e.target.value) || 0 }; onChangeSegments?.(next);
                }} />
              </div>
              <TextField label={`Text (${formatClock(seg.startSec || 0)})`} size="sm" value={seg.text ?? ''} onChange={(e) => {
                const next = [...segments]; next[i] = { ...seg, text: e.target.value }; onChangeSegments?.(next);
              }} />
              <div className="flex justify-end">
                <Button size="xs" variant="ghost" onClick={() => onChangeSegments?.(segments.filter((_, idx) => idx !== i))}>
                  <Trash2 aria-hidden className="size-3" /> Remove
                </Button>
              </div>
            </div>
          ))}
          {!segments?.length && <p className="text-[11px] text-faint">No manual segments. Transcript/caption text timing will be used.</p>}
        </div>
      </div>
    </div>
  );
}
