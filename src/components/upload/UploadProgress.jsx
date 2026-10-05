import { useEffect, useRef, useState } from 'react';
import { HardDrive, X } from 'lucide-react';
import { ProgressBar } from '../common/ProgressBar.jsx';
import { IconButton } from '../common/Button.jsx';
import { formatBytes, formatEta } from '../../utils/formatDuration.js';

/** What the transfer is doing, as reported by the upload service. */
const PHASE_LABEL = {
  session: 'Opening upload session',
  transferring: 'Uploading parts',
  finalising: 'Assembling file on the server',
  done: 'Transfer complete',
};

/**
 * Upload progress panel: filename, throughput, transfer bar and a cancel action.
 *
 * Throughput and ETA come from the elapsed time this component has been mounted
 * and the bytes the service has confirmed, so both reflect the real transfer.
 * The bar holds at 100% during `finalising` because assembling the parts on the
 * server is not byte-observable from here.
 */
export function UploadProgress({
  file,
  progress,
  phase = 'transferring',
  onCancel,
  className = '',
}) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAtRef = useRef(0);

  useEffect(() => {
    // Set inside the effect: `Date.now()` during render is impure.
    startedAtRef.current = Date.now();
    const timer = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const uploadedBytes = file ? (file.size * progress) / 100 : 0;
  const rateBytesPerSec = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
  const etaSec = rateBytesPerSec > 0 ? (file.size - uploadedBytes) / rateBytesPerSec : 0;

  let statusLine;
  if (phase === 'finalising') {
    statusLine = PHASE_LABEL.finalising;
  } else if (phase === 'done') {
    statusLine = PHASE_LABEL.done;
  } else if (rateBytesPerSec > 0) {
    statusLine = `${formatEta(etaSec)} remaining`;
  } else {
    statusLine = PHASE_LABEL[phase] ?? PHASE_LABEL.transferring;
  }

  return (
    <div className={`panel p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-brand-500/25 bg-brand-500/10 text-brand-400">
          <HardDrive aria-hidden className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-medium text-primary" title={file?.name}>
                {file?.name}
              </p>
              <p className="tabular mt-0.5 text-[11.5px] text-faint">
                <span className="text-secondary">{formatBytes(uploadedBytes)}</span>
                {' of '}
                {formatBytes(file?.size ?? 0)}
                {rateBytesPerSec > 0 && <> · {formatBytes(rateBytesPerSec)}/s</>}
              </p>
            </div>

            {onCancel && (
              <IconButton label="Cancel upload" size="xs" onClick={onCancel}>
                <X className="size-3.5" />
              </IconButton>
            )}
          </div>

          <ProgressBar
            value={progress}
            label="Upload progress"
            className="mt-3"
            showValue
          />

          <p className="tabular mt-2 text-[11px] text-faint">{statusLine}</p>
        </div>
      </div>
    </div>
  );
}