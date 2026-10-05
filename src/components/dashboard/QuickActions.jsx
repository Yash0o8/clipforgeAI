import { Link } from 'react-router-dom';
import { Download, Sparkles, Upload } from 'lucide-react';
import { Button } from '../common/Button.jsx';
import { Panel, PanelHeader, PanelBody } from '../common/Panel.jsx';

/** Primary actions. */
export function QuickActions() {
  return (
    <Panel>
      <PanelHeader title="Quick actions" />
      <PanelBody className="flex flex-col gap-2">
        <Button as={Link} to="/app/upload" fullWidth variant="secondary">
          <Upload aria-hidden className="size-4" />
          Upload video
        </Button>
        <Button as={Link} to="/app/clips" fullWidth variant="secondary">
          <Sparkles aria-hidden className="size-4" />
          Browse clips
        </Button>
        <Button as={Link} to="/app/exports" fullWidth variant="secondary">
          <Download aria-hidden className="size-4" />
          View exports
        </Button>
      </PanelBody>
    </Panel>
  );
}