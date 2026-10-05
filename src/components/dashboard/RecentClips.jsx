import { Link } from 'react-router-dom';
import { Button } from '../common/Button.jsx';
import { Panel, PanelHeader, PanelBody } from '../common/Panel.jsx';
import { formatClock } from '../../utils/formatDuration.js';

/** Top-scoring clips, compact list. */
export function RecentClips({ clips = [] }) {
  if (clips.length === 0) {
    return (
      <Panel>
        <PanelHeader title="Top clips" subtitle="Generated from your finished projects." />
        <PanelBody>
          <p className="text-sm text-faint">No clips found yet. Process a project to see highlights.</p>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Top clips"
        subtitle="Ordered by hook strength."
        actions={
          <Button as={Link} to="/app/clips" size="xs" variant="ghost">
            View all
          </Button>
        }
      />
      <PanelBody className="divide-y divide-line">
        {clips.map((clip) => (
          <article key={clip.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <Link
                to={`/app/clips/${clip.id}/editor`}
                className="text-[13.5px] font-medium text-primary transition-colors hover:text-brand-300"
              >
                {clip.title}
              </Link>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                <span className="tabular">{formatClock(clip.startSec)} – {formatClock(clip.endSec)}</span>
                <span aria-hidden>·</span>
                <span className="font-medium text-success">{clip.score}% match</span>
              </div>
            </div>
            <Button as={Link} to={`/app/clips/${clip.id}/editor`} size="xs" variant="secondary">
              Edit
            </Button>
          </article>
        ))}
      </PanelBody>
    </Panel>
  );
}