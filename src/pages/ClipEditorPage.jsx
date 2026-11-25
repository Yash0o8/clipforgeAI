import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { ClipEditor } from '../components/clips/ClipEditor.jsx';
import { EmptyState, ErrorState } from '../components/common/EmptyState.jsx';
import { LoaderBlock } from '../components/common/Loader.jsx';
import { Button } from '../components/common/Button.jsx';
import { useApp } from '../hooks/useApp.js';
import { getClip } from '../services/clipService.js';

/**
 * Page wrapper for the editor.
 *
 * Clips live in their own collection, so boot hydration only fills projects.
 * A deep link such as `/app/clips/{id}` — or a reload while the editor is open —
 * therefore arrives with an empty clip list. Fetch the single clip by id and let
 * it land in the shared store so the editor and every other selector agree.
 *
 * Passing `key` ensures the editor remounts with a fresh draft whenever the
 * clip changes, so `useClipEditor`'s initial state can't be stale.
 */
export function ClipEditorPage() {
  const { clipId } = useParams();
  const { clips, addClip } = useApp();

  const cached = clips.find((c) => c.id === clipId) ?? null;
  // Keep the failure alongside the id it belongs to so a route change never
  // shows another clip's error. State is only set from async callbacks.
  const [failure, setFailure] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (cached || !clipId) return undefined;

    let active = true;
    const controller = new AbortController();

    getClip(clipId, { signal: controller.signal })
      .then((clip) => {
        if (active) addClip(clip);
      })
      .catch((error) => {
        // A 404 is a real answer; anything else is a network problem, so show
        // a retry instead of claiming the clip is gone.
        if (active) {
          setFailure({
            clipId,
            kind: error?.status === 404 ? 'not-found' : 'network',
            message: error?.message,
          });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [clipId, cached, addClip, reloadKey]);

  const currentFailure = failure?.clipId === clipId ? failure : null;

  if (currentFailure?.kind === 'not-found') {
    return (
      <EmptyState
        title="Clip not found"
        description="It may have been deleted or moved."
        action={
          <Button as={Link} to="/app/clips" variant="secondary">
            <ArrowLeft aria-hidden className="size-4" />
            Back to clips
          </Button>
        }
      />
    );
  }

  // Still fetching: show a real loading state rather than a blank page or a
  // wrong "not found" message.
  if (!cached) {
    if (currentFailure?.kind === 'network') {
      return (
        <ErrorState
          title="Could not load clip"
          message={currentFailure.message ?? 'The API did not answer. Try again.'}
          onRetry={() => {
            setFailure(null);
            setReloadKey((key) => key + 1);
          }}
          retryLabel="Retry"
        />
      );
    }
    return <LoaderBlock label="Loading clip" hint="Fetching the editor draft for this clip." />;
  }

  return <ClipEditor key={clipId} clipId={clipId} />;
}