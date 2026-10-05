import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '../components/common/Button.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Panel, PanelBody, PanelHeader } from '../components/common/Panel.jsx';
import { SUPPORTED_PLATFORMS } from '../utils/constants.js';

/** Landing page for unauthenticated visitors. */
export function LandingPage() {
  return (
    <div className="relative">
      {/* Hero */}
      <section className="mx-auto flex max-w-6xl flex-col items-center gap-8 px-4 pb-14 pt-10 text-center sm:px-6 sm:pt-14 lg:px-8">
        <Badge tone="brand" size="sm" dot>
          Local-first demo
        </Badge>
        <div className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight text-primary sm:text-4xl lg:text-5xl">
            Turn long videos into platform-ready clips with one flow.
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-secondary sm:text-xl">
            Upload once. Let ClipForge find hooks, trim them, caption them and export to the exact
            aspect ratio for each platform.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button as={Link} to="/app/upload" size="lg">
            <Sparkles aria-hidden className="size-4" />
            Upload a video
          </Button>
          <Button as={Link} to="/app/overview" size="lg" variant="secondary">
            View demo dashboard
          </Button>
        </div>
      </section>

      {/* Supported platforms */}
      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <Panel>
          <PanelHeader
            title="Built for every platform"
            subtitle="Presets keep your clips the right length and the right shape."
          />
          <PanelBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SUPPORTED_PLATFORMS.map((platform) => (
              <article key={platform.id} className="rounded-lg border border-line bg-ink-900/60 px-4 py-3">
                <p className="text-[13.5px] font-medium text-primary">{platform.name}</p>
                <p className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                  <span className="tabular">{platform.ratio}</span>
                  <span aria-hidden></span>
                  <span className="tabular">up to {platform.maxLength}s</span>
                </p>
              </article>
            ))}
          </PanelBody>
        </Panel>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-5 space-y-1.5">
          <h2 className="text-[17px] font-semibold text-primary">How it works</h2>
          <p className="text-sm text-secondary">Three steps from raw footage to a ready-to-post clip.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Panel>
            <PanelHeader title="1. Upload" />
            <PanelBody>
              <p className="text-[13px] leading-relaxed text-secondary">
                Drop an MP4, WebM or MOV. A local demo source is used if nothing is uploaded.
              </p>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="2. Process" />
            <PanelBody>
              <p className="text-[13px] leading-relaxed text-secondary">
                Transcribe, score and detect highlights. The simulated pipeline shows the stages.
              </p>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="3. Edit & export" />
            <PanelBody>
              <p className="text-[13px] leading-relaxed text-secondary">
                Trim, style captions, re-aspect and download SRT, TXT or JSON. MP4 needs a backend.
              </p>
            </PanelBody>
          </Panel>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-4xl px-4 py-12 text-center sm:px-6 lg:px-8">
        <div className="rounded-panel border border-line bg-ink-900/60 px-6 py-10 sm:px-10">
          <div className="space-y-3">
            <h2 className="text-2xl font-semibold text-primary sm:text-3xl">Start with your first clip</h2>
            <p className="text-lg text-secondary">
              No signup. Explore the full editor with seeded data or upload your own file.
            </p>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <Button as={Link} to="/app/upload">
              Upload video
              <ArrowRight aria-hidden className="size-4" />
            </Button>
            <Button as={Link} to="/app/overview" variant="secondary">
              See dashboard
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}













