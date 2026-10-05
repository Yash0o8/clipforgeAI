import { useCallback, useEffect, useRef, useState } from 'react';
import { readVideoMetadata, validateVideoFiles } from '../utils/fileValidation.js';
import { uploadVideo } from '../services/uploadService.js';

/**
 * Upload flow state machine.
 *
 *   idle  -> selected  -> uploading -> uploaded
 *                 \-> error (validation or transfer)
 *
 * Owns the `blob:` object URL for the selected file and revokes it on replace
 * and unmount, which is what keeps long editing sessions from leaking memory.
 *
 * The transfer is real: `uploadVideo` opens a multipart session, pushes parts
 * over XHR and finalises it. The returned `uploadId` is what
 * `projectService.createProject` needs to attach the source.
 */
export function useVideoUpload() {
  const [file, setFile] = useState(null);
  const [objectUrl, setObjectUrl] = useState(null);
  const [metadata, setMetadata] = useState({ durationSec: null, width: null, height: null });
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('session');
  const [error, setError] = useState(null);
  const [isReading, setIsReading] = useState(false);

  const objectUrlRef = useRef(null);
  const abortRef = useRef(null);

  /** Drop the current object URL so the browser can reclaim the blob. */
  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setObjectUrl(null);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseObjectUrl();
    setFile(null);
    setMetadata({ durationSec: null, width: null, height: null });
    setResults([]);
    setStatus('idle');
    setProgress(0);
    setPhase('session');
    setError(null);
    setIsReading(false);
  }, [releaseObjectUrl]);

  // Revoke on unmount so navigating away mid-upload does not leak the blob.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  /**
   * Validate a drop / file-picker selection and adopt the first valid file.
   * Returns the validation results so the caller can surface per-file errors.
   */
  const selectFiles = useCallback(
    async (fileList) => {
      const validation = validateVideoFiles(fileList);
      setResults(validation);

      const accepted = validation.find((result) => result.valid);
      if (!accepted) {
        releaseObjectUrl();
        setFile(null);
        setMetadata({ durationSec: null, width: null, height: null });
        setStatus('error');
        setProgress(0);
        return validation;
      }

      const chosen = accepted.file;
      releaseObjectUrl();
      const url = URL.createObjectURL(chosen);
      objectUrlRef.current = url;

      setFile(chosen);
      setObjectUrl(url);
      setStatus('selected');
      setProgress(0);
      setPhase('session');
      setError(null);
      setIsReading(true);

      const details = await readVideoMetadata(chosen);
      // Guard against a stale read landing after the user picked another file.
      if (objectUrlRef.current === url) {
        setMetadata(details);
        setIsReading(false);
      }

      return validation;
    },
    [releaseObjectUrl]
  );

  /**
   * Transfer the file to the API.
   *
   * @returns {Promise<{ok: boolean, uploadId?: string, cancelled?: boolean, error?: Error}>}
   *   `uploadId` is the handle `POST /projects` needs to attach the source.
   */
  const startUpload = useCallback(async () => {
    if (!file) throw new Error('No file selected.');

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('uploading');
    setProgress(0);

    try {
      const result = await uploadVideo(file, {
        signal: controller.signal,
        onProgress: ({ phase, percent }) => {
          setProgress(percent);
          setPhase(phase);
        },
      });

      setStatus('uploaded');
      setProgress(100);
      return { ok: true, uploadId: result.uploadId, asset: result.asset };
    } catch (error) {
      if (controller.signal.aborted) {
        setStatus('selected');
        setProgress(0);
        return { ok: false, cancelled: true };
      }
      setStatus('error');
      setError(error);
      return { ok: false, error };
    } finally {
      abortRef.current = null;
    }
  }, [file]);

  /** Abort an in-flight transfer, returning to the selected state. */
  const cancelUpload = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus((current) => (current === 'uploading' ? 'selected' : current));
    setProgress(0);
  }, []);

  const errors = results.filter((result) => !result.valid && result.error).map((result) => result.error);

  return {
    file,
    objectUrl,
    metadata,
    results,
    errors,
    status,
    progress,
    /** Sub-step of the transfer: 'session' | 'transferring' | 'finalising' | 'done'. */
    phase,
    /** Transfer failure, kept so the UI can render the API's message. */
    error,
    isReading,
    isBusy: status === 'uploading',
    hasFile: Boolean(file),
    selectFiles,
    startUpload,
    cancelUpload,
    reset,
  };
}
