import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Link2, Sparkles } from 'lucide-react';
import { Button } from '../components/common/Button.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Panel, PanelBody, PanelHeader } from '../components/common/Panel.jsx';
import { TextField } from '../components/common/TextField.jsx';
import { useToast } from '../hooks/useToast.js';
import { startYoutubeDemo } from '../services/demoService.js';
import { FAQ_ITEMS, SUPPORTED_PLATFORMS } from '../utils/constants.js';

/**
 * Landing page. A visitor can paste a YouTube URL right here and get a free
 * demo clip before ever being asked to sign up — value first, account later.
 */
export function LandingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const onTryDemo = async (event) => {
    event.preventDefault();
    const url = youtubeUrl.trim();
    if (!url || busy) return;
    setBusy(true);
    setStatus('Starting your free demo…');
    try {
      const project = await startYoutubeDemo(url, { onStatus: setStatus });
      navigate(`/app/projects/${project.id}/processing`);
    } catch (cause) {
      setStatus('');
      toast.error('Demo could not start', { body: cause.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <a
          href="#main"
          className="skip-link rounded-lg bg-ink-850 px-3 py-2 text-sm text-primary focus-visible:outline-2 focus-visible:outline-brand-400"
        >
          Skip to content
        </a>
        <Link to="/" className="text-[15px] font-semibold tracking-tight text-primary">
          ClipForge
        </Link>
        <nav aria-label="Marketing" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-secondary">
          <a href="#how-it-works" className="transition-colors hover:text-brand-300">
            How it works
          </a>
          <a href="#faq" className="transition-colors hover:text-brand-300">
            FAQ
          </a>
          <Link to="/app/billing" className="transition-colors hover:text-brand-300">
            Plans &amp; credits
          </Link>
          <Button as={Link} to="/app/overview" size="xs" variant="secondary">
            Open app
          </Button>
        </nav>
      </header>

      <main id="main" tabIndex={-1} className="relative focus:outline-none">
        {/* Hero */}
        <section className="mx-auto flex max-w-6xl flex-col items-center gap-8 px-4 pb-14 pt-10 text-center sm:px-6 sm:pt-14 lg:px-8">
          <Badge tone="brand" size="sm" dot>
            Built for Indian gaming streamers &amp; Hindi podcasters
          </Badge>
          <div className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight text-primary sm:text-4xl lg:text-5xl">
              Turn long videos into platform-ready clips with one flow.
            </h1>
            <p className="mx-auto max-w-2xl text-lg text-secondary sm:text-xl">
              Paste a YouTube link or upload a stream. ClipForge finds the hook, cuts the dead air,
              adds Hinglish captions and stacks your story over a licensed gameplay loop — ready for
              Shorts, Reels and TikTok.
            </p>
          </div>

          <form
            onSubmit={onTryDemo}
            className="flex w-full max-w-xl flex-col gap-2 rounded-panel border border-line bg-ink-900/60 p-3 text-left sm:flex-row sm:items-end"
          >
            <div className="min-w-0 flex-1">
              <TextField
                label="Try a free demo — paste a YouTube link"
                value={youtubeUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                type="url"
              />
            </div>
            <Button type="submit" size="md" loading={busy} disabled={!youtubeUrl.trim()}>
              <Link2 aria-hidden className="size-4" />
              Generate a free clip
            </Button>
          </form>
          <p className="text-[11.5px] text-faint" aria-live="polite">
            {status || 'No signup. 30 processing minutes a month with a small watermark.'}
          </p>
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
                    <span className="tabular">up to {platform.maxLength}s</span>
                  </p>
                </article>
              ))}
            </PanelBody>
          </Panel>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-10 sm:px-6 lg:px-8">
          <div className="mb-5 space-y-1.5">
            <h2 className="text-[17px] font-semibold text-primary">How it works</h2>
            <p className="text-sm text-secondary">Three steps from raw footage to a ready-to-post clip.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Panel>
              <PanelHeader title="1. Upload" />
              <PanelBody>
                <p className="text-[13px] leading-relaxed text-secondary">
                  Drop an MP4, WebM or MOV. Uploads are chunked, so large files survive a flaky connection.
                </p>
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHeader title="2. Process" />
              <PanelBody>
                <p className="text-[13px] leading-relaxed text-secondary">
                  Transcribe, score and detect highlights from speech, audio spikes and visual cuts.
                  Progress is reported stage by stage as it runs.
                </p>
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHeader title="3. Edit & export" />
              <PanelBody>
                <p className="text-[13px] leading-relaxed text-secondary">
                  Trim, style captions, re-aspect and export MP4, or download SRT, TXT or JSON sidecars.
                </p>
              </PanelBody>
            </Panel>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-10 sm:px-6 lg:px-8">
          <Panel>
            <PanelHeader
              title="Frequently asked questions"
              subtitle="The details creators ask before they paste their first link."
            />
            <PanelBody className="space-y-2">
              {FAQ_ITEMS.map((item) => (
                <details key={item.q} className="rounded-lg border border-line bg-ink-900/60 px-4 py-3">
                  <summary className="cursor-pointer text-[13.5px] font-medium text-primary">
                    {item.q}
                  </summary>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-secondary">{item.a}</p>
                </details>
              ))}
            </PanelBody>
          </Panel>
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
            <div className="mt-6 flex justify-center">
              <Button as={Link} to="/app/upload" size="lg">
                <Sparkles aria-hidden className="size-4" />
                Upload a video
              </Button>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
