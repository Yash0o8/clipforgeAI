import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { AlertTriangle, Upload as UploadIcon } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Button } from '../components/common/Button.jsx';
import { VideoDropzone } from '../components/upload/VideoDropzone.jsx';
import { UploadProgress } from '../components/upload/UploadProgress.jsx';
import { VideoMetadata } from '../components/upload/VideoMetadata.jsx';
import { useVideoUpload } from '../hooks/useVideoUpload.js';
import { useApp } from '../hooks/useApp.js';
import * as projectService from '../services/projectService.js';
import { NOTIFICATION_TONE } from '../utils/constants.js';

/**
 * Upload step.
 *
 * Owns the whole hand-off: transfer the bytes, create the project from the
 * uploaded source, kick off the pipeline, then navigate to the processing view.
 * Every one of those steps is a real API call, so a failure here is reported
 * with the server's message instead of being silently swallowed.
 */
export function UploadPage() {
  const navigate = useNavigate();
  const { replaceProject, notify } = useApp();

  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const upload = useVideoUpload();

  const onFiles = (fileList) => {
    setError(null);
    upload.selectFiles(fileList);
  };

  const onStart = async () => {
    const file = upload.file;
    if (!file) return;

    setError(null);
    setIsSubmitting(true);

    try {
      // 1. Push the bytes and get an upload handle back.
      const transfer = await upload.startUpload();
      if (!transfer.ok) {
        if (transfer.cancelled) {
          setError(null);
        } else {
          setError(transfer.error?.message ?? 'Upload failed. Try again.');
        }
        return;
      }

      // 2. Attach the uploaded source to a project. The server probes it, so
      //    duration and dimensions come back authoritative.
      const project = await projectService.createProject({
        uploadId: transfer.uploadId,
        title: file.name.replace(/\.[^/.]+$/, ''),
      });
      replaceProject(project);

      // 3. Start the pipeline before navigating, so the processing page finds a
      //    job already in flight rather than racing a second POST.
      await projectService.processProject(project.id);

      notify({
        title: 'Upload complete',
        body: `${project.title} is being transcribed.`,
        tone: NOTIFICATION_TONE.INFO,
      });

      navigate(`/app/upload/processing/${project.id}`);
    } catch (err) {
      setError(err.message || 'Upload failed. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onCancel = () => {
    upload.cancelUpload();
  };

  const onClear = () => {
    upload.reset();
    setError(null);
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[17px] font-semibold text-primary">Upload a video</h1>
        <p className="mt-0.5 text-sm text-secondary">
          Drag and drop a file, or pick one from your computer. YouTube URLs are coming soon.
        </p>
      </header>

      <Panel>
        <PanelHeader
          title="Select file"
          subtitle="MP4, WebM and MOV. Large files are transferred in parts, so a dropped connection does not restart the upload."
        />
        <PanelBody className="space-y-5">
          <VideoDropzone onFiles={onFiles} errors={upload.errors} disabled={upload.isBusy} />

          {upload.hasFile && (
            <div className="space-y-4">
              <VideoMetadata
                file={upload.file}
                metadata={upload.metadata}
                isReading={upload.isReading}
              />

              {upload.status === 'uploading' ? (
                <UploadProgress
                  file={upload.file}
                  progress={upload.progress}
                  phase={upload.phase}
                  onCancel={onCancel}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={onClear}>
                    Choose another file
                  </Button>
                  <Button size="sm" loading={isSubmitting} onClick={onStart}>
                    <UploadIcon aria-hidden className="size-4" />
                    Start processing
                  </Button>
                </div>
              )}
            </div>
          )}
        </PanelBody>
      </Panel>

      {(error || upload.error) && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/[0.07] px-4 py-3 text-[12.5px] text-danger">
          <AlertTriangle aria-hidden className="mt-px size-4 shrink-0" />
          <p>{error ?? upload.error?.message}</p>
        </div>
      )}
    </div>
  );
}
