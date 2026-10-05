import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { ClipEditor } from '../components/clips/ClipEditor.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';
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
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (cached || !clipId) return undefined;

    let active = true;
    const controller = new AbortController();

    getClip(clipId, { signal: controller.signal })
      .then((clip) => {
        if (active) addClip(clip);
      })
      .catch((error) => {
        // A 404 is a real answer; anything else is a network problem and is
        // reported by the app-level banner, so don't claim the clip is gone.
        if (active && error?.status === 404) setNotFound(true);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [clipId, cached, addClip]);

  if (notFound) {
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

  // Still fetching: render nothing rather than a wrong "not found" message.
  if (!cached) return null;

  return <ClipEditor key={clipId} clipId={clipId} />;
}