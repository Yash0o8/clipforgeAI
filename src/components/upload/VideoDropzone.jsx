import { useCallback, useId, useRef, useState } from 'react';
import { AlertCircle, FileVideo, UploadCloud } from 'lucide-react';
import { ACCEPT_ATTRIBUTE, ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES } from '../../utils/fileValidation.js';
import { formatBytes } from '../../utils/formatDuration.js';

/**
 * Drag-and-drop file input.
 *
 * Handles both the drop path and the keyboard/click path, and accepts multiple
 * files so the parent can report per-file validation errors rather than
 * silently ignoring a bad drop.
 */
export function VideoDropzone({ onFiles, errors = [], disabled = false, compact = false }) {
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  // Nested elements fire dragleave; count enters instead of toggling.
  const dragDepth = useRef(0);
  const hintId = useId();

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      if (disabled) return;
      if (event.dataTransfer?.files?.length) onFiles(event.dataTransfer.files);
    },
    [disabled, onFiles]
  );

  return (
    <div className="space-y-3">
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          if (!disabled) setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setIsDragging(false);
        }}
        onDrop={handleDrop}
        className={`relative flex flex-col items-center justify-center rounded-panel border-2 border-dashed text-center transition-colors duration-200 ${
          compact ? 'px-5 py-8' : 'px-6 py-14'
        } ${
          isDragging
            ? 'border-brand-500 bg-brand-500/[0.07]'
            : errors.length > 0
              ? 'border-danger/40 bg-danger/[0.04]'
              : 'border-line-strong bg-ink-900/40 hover:border-line-hover hover:bg-ink-900/70'
        } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          disabled={disabled}
          onChange={(event) => {
            if (event.target.files?.length) onFiles(event.target.files);
            // Reset so re-picking the same file fires `change` again.
            event.target.value = '';
          }}
          className="sr-only"
          id={`${hintId}-input`}
          aria-describedby={hintId}
        />

        <span
          className={`flex items-center justify-center rounded-xl border border-line-strong bg-ink-850 text-brand-400 transition-transform duration-200 ${
            compact ? 'size-10' : 'size-12'
          } ${isDragging ? 'scale-110' : ''}`}
        >
          {isDragging ? (
            <UploadCloud aria-hidden className="size-5" />
          ) : (
            <FileVideo aria-hidden className={compact ? 'size-4.5' : 'size-5.5'} />
          )}
        </span>

        <div className="mt-3.5 space-y-1.5">
          <p className={`font-semibold text-primary ${compact ? 'text-sm' : 'text-[15px]'}`}>
            {isDragging ? 'Drop to upload' : 'Drag a video here'}
          </p>
          <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-secondary">
            or{' '}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="font-semibold text-brand-300 underline decoration-brand-500/40 underline-offset-2 transition-colors hover:text-brand-200 hover:decoration-brand-400"
            >
              browse your files
            </button>
          </p>
        </div>

        <p id={hintId} className="mt-4 text-[11.5px] text-faint">
          {ACCEPTED_EXTENSIONS.map((ext) => ext.toUpperCase()).join(', ')} · up to{' '}
          {formatBytes(MAX_UPLOAD_BYTES)}
        </p>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="space-y-1.5">
          {errors.map((message) => (
            <li
              key={message}
              className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-danger"
            >
              <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>{message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
