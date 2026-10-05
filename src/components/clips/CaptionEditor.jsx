import { Check, Copy, RefreshCw } from 'lucide-react';
import { TextArea } from '../common/TextField.jsx';
import { CAPTION_POSITIONS, CAPTION_PRESETS } from '../../utils/constants.js';
import { Button } from '../common/Button.jsx';
import { useToast } from '../../hooks/useToast.js';

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
  presetId,
  onChangeText,
  onChangePreset,
  originalText = '',
  position,
  onChangePosition,
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
          className="grid grid-cols-3 gap-1.5 rounded-lg border border-line-strong bg-ink-900 p-1"
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
    </div>
  );
}
