/**
 * Application-wide constants.
 *
 * Everything here is data, not behaviour, so pages and components can stay
 * presentational. Values that a real backend would own are marked so they
 * are easy to swap for API-driven data later.
 */

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

/** localStorage namespace. Bump the suffix to invalidate persisted state. */
export const STORAGE_KEY = 'clipforge.v1';

/* -------------------------------------------------------------------------- */
/*  Navigation                                                                 */
/* -------------------------------------------------------------------------- */

export const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', to: '/app/overview', icon: 'LayoutDashboard' },
  { id: 'projects', label: 'My Projects', to: '/app/projects', icon: 'FolderClosed' },
  { id: 'create', label: 'Create Clips', to: '/app/upload', icon: 'Sparkles' },
  { id: 'clips', label: 'Clips', to: '/app/clips', icon: 'Scissors' },
  { id: 'exports', label: 'Exports', to: '/app/exports', icon: 'Download' },
  { id: 'settings', label: 'Settings', to: '/app/settings', icon: 'Settings' },
];

/** Items shown in the compact bottom bar on small screens. */
export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((item) =>
  ['overview', 'create', 'clips', 'exports'].includes(item.id)
);

/* -------------------------------------------------------------------------- */
/*  Projects                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Backend vocabulary. A FastAPI + PostgreSQL implementation would store exactly
 * these values in a `status` enum column on the `projects` table.
 */
export const PROJECT_STATUS = {
  DRAFT: 'draft',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const PROJECT_STATUS_META = {
  [PROJECT_STATUS.DRAFT]: { label: 'Draft', tone: 'neutral' },
  [PROJECT_STATUS.UPLOADING]: { label: 'Uploading', tone: 'info' },
  [PROJECT_STATUS.PROCESSING]: { label: 'Processing', tone: 'brand' },
  [PROJECT_STATUS.READY]: { label: 'Ready', tone: 'success' },
  [PROJECT_STATUS.FAILED]: { label: 'Failed', tone: 'danger' },
  [PROJECT_STATUS.CANCELLED]: { label: 'Cancelled', tone: 'warning' },
};

/** Every status that counts as "finished, one way or another". */
export const TERMINAL_PROJECT_STATUSES = [
  PROJECT_STATUS.READY,
  PROJECT_STATUS.FAILED,
  PROJECT_STATUS.CANCELLED,
];

/* -------------------------------------------------------------------------- */
/*  Processing pipeline                                                        */
/* -------------------------------------------------------------------------- */

export const STAGE_KEYS = {
  UPLOAD: 'upload',
  AUDIO: 'audio',
  TRANSCRIPT: 'transcript',
  HIGHLIGHTS: 'highlights',
  PREPARE: 'prepare',
};

/**
 * The five visible pipeline stages.
 *
 * `weight` is the share of total simulated progress the stage consumes.
 * `tool` names the real backend component that would perform this step once
 * the FastAPI service is connected.
 */
export const PROCESSING_STAGES = [
  {
    key: STAGE_KEYS.UPLOAD,
    label: 'Uploading video',
    description: 'Streaming your source file to secure storage.',
    weight: 18,
    tool: 'Object storage (S3 / GCS)',
  },
  {
    key: STAGE_KEYS.AUDIO,
    label: 'Extracting audio',
    description: 'Normalising the audio track to 16 kHz mono WAV for transcription.',
    weight: 14,
    tool: 'FFmpeg',
  },
  {
    key: STAGE_KEYS.TRANSCRIPT,
    label: 'Generating transcript',
    description: 'Transcribing speech with word-level timings.',
    weight: 34,
    tool: 'Whisper',
  },
  {
    key: STAGE_KEYS.HIGHLIGHTS,
    label: 'Finding highlights',
    description: 'Scoring candidate moments for hook strength and shareability.',
    weight: 22,
    tool: 'Highlight-detection model',
  },
  {
    key: STAGE_KEYS.PREPARE,
    label: 'Preparing clips',
    description: 'Cutting segments and generating caption tracks.',
    weight: 12,
    tool: 'FFmpeg + caption renderer',
  },
];

export const STAGE_INDEX_BY_KEY = Object.fromEntries(
  PROCESSING_STAGES.map((stage, index) => [stage.key, index])
);

/**
 * Stage lookup by key, for pages that render a single stage's label.
 * Includes the terminal `done` / `failed` / `cancelled` keys that the
 * processing status can settle on rather than a real pipeline stage.
 */
export const PROCESSING_STAGE_META = {
  ...Object.fromEntries(PROCESSING_STAGES.map((stage) => [stage.key, stage])),
  done: { key: 'done', label: 'Complete', description: 'All clips have been generated.' },
  failed: { key: 'failed', label: 'Failed', description: 'Processing stopped before finishing.' },
  cancelled: { key: 'cancelled', label: 'Cancelled', description: 'Processing was stopped.' },
};

/* -------------------------------------------------------------------------- */
/*  Clips                                                                      */
/* -------------------------------------------------------------------------- */

export const CLIP_STATUS = {
  SUGGESTED: 'suggested',
  SELECTED: 'selected',
  EDITED: 'edited',
  EXPORTED: 'exported',
};

export const CLIP_STATUS_META = {
  [CLIP_STATUS.SUGGESTED]: { label: 'Suggested', tone: 'neutral' },
  [CLIP_STATUS.SELECTED]: { label: 'Selected', tone: 'brand' },
  [CLIP_STATUS.EDITED]: { label: 'Edited', tone: 'info' },
  [CLIP_STATUS.EXPORTED]: { label: 'Exported', tone: 'success' },
};

/** Filter tabs on the Clips page. */
export const CLIP_FILTERS = [
  { id: 'all', label: 'All clips' },
  { id: CLIP_STATUS.SELECTED, label: 'Selected' },
  { id: CLIP_STATUS.EDITED, label: 'Edited' },
  { id: CLIP_STATUS.EXPORTED, label: 'Exported' },
];

export const CLIP_SORTS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'duration', label: 'Duration' },
  { id: 'recent', label: 'Recently created' },
];

export const CLIP_VIEWS = {
  GRID: 'grid',
  LIST: 'list',
};

/** Editor bounds. Short-form platforms reject anything outside this window. */
export const CLIP_LIMITS = {
  MIN_DURATION: 5,
  MAX_DURATION: 90,
  DEFAULT_DURATION: 38,
  /** Timeline scrubber resolution in seconds. */
  SNAP: 0.1,
};

/* -------------------------------------------------------------------------- */
/*  Aspect ratios                                                              */
/* -------------------------------------------------------------------------- */

export const ASPECT_RATIOS = [
  {
    id: '9:16',
    label: '9:16',
    name: 'Vertical',
    hint: 'Reels, Shorts, TikTok',
    value: 9 / 16,
    width: 1080,
    height: 1920,
  },
  {
    id: '1:1',
    label: '1:1',
    name: 'Square',
    hint: 'Feed posts',
    value: 1,
    width: 1080,
    height: 1080,
  },
  {
    id: '16:9',
    label: '16:9',
    name: 'Landscape',
    hint: 'YouTube, LinkedIn',
    value: 16 / 9,
    width: 1920,
    height: 1080,
  },
];

export const ASPECT_RATIO_MAP = Object.fromEntries(ASPECT_RATIOS.map((r) => [r.id, r]));

/* -------------------------------------------------------------------------- */
/*  Caption presets                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Caption styles.
 *
 * `size` is a fraction of the preview width, so captions stay proportional
 * whatever the aspect ratio. `position` maps to a vertical anchor.
 */
export const CAPTION_PRESETS = [
  {
    id: 'clean',
    label: 'Clean',
    description: 'Sentence case on a soft plate. Safe and readable everywhere.',
    style: {
      position: 'lower',
      size: 0.052,
      weight: 600,
      transform: 'none',
      color: '#ffffff',
      highlight: '#c4b5fd',
      background: 'rgba(9, 9, 16, 0.62)',
      radius: 10,
      padding: '0.5em 0.85em',
      shadow: 'none',
      uppercase: false,
      karaoke: false,
    },
  },
  {
    id: 'bold',
    label: 'Bold',
    description: 'All-caps punch with a hard shadow for high-retention edits.',
    style: {
      position: 'center',
      size: 0.062,
      weight: 800,
      transform: 'uppercase',
      color: '#ffffff',
      highlight: '#fde68a',
      background: 'transparent',
      radius: 4,
      padding: '0.35em 0.5em',
      shadow: '0 3px 0 rgba(0,0,0,0.55), 0 0 22px rgba(0,0,0,0.5)',
      uppercase: true,
      karaoke: false,
    },
  },
  {
    id: 'karaoke',
    label: 'Karaoke',
    description: 'Word-by-word highlight driven by the playhead.',
    style: {
      position: 'lower',
      size: 0.056,
      weight: 700,
      transform: 'none',
      color: 'rgba(255,255,255,0.55)',
      highlight: '#ffffff',
      background: 'transparent',
      radius: 8,
      padding: '0.4em 0.6em',
      shadow: '0 2px 10px rgba(0,0,0,0.6)',
      uppercase: false,
      karaoke: true,
    },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Small and quiet. Lets the frame do the talking.',
    style: {
      position: 'lower',
      size: 0.038,
      weight: 500,
      transform: 'none',
      color: '#ffffff',
      highlight: '#ffffff',
      background: 'transparent',
      radius: 0,
      padding: '0.2em 0.1em',
      shadow: '0 1px 6px rgba(0,0,0,0.75)',
      uppercase: false,
      karaoke: false,
    },
  },
  {
    id: 'creator',
    label: 'Creator Style',
    description: 'Accent pill with a violet tint. Reads as intentional branding.',
    style: {
      position: 'center',
      size: 0.058,
      weight: 700,
      transform: 'none',
      color: '#ffffff',
      highlight: '#fde68a',
      background: 'linear-gradient(135deg, rgba(139,92,246,0.92), rgba(109,40,217,0.92))',
      radius: 999,
      padding: '0.55em 1.1em',
      shadow: '0 10px 30px -10px rgba(109,40,217,0.9)',
      uppercase: false,
      karaoke: false,
    },
  },
];

export const CAPTION_PRESET_MAP = Object.fromEntries(CAPTION_PRESETS.map((p) => [p.id, p]));

/** Vertical anchors for the caption overlay. */
export const CAPTION_POSITIONS = [
  { id: 'top', label: 'Top' },
  { id: 'center', label: 'Middle' },
  { id: 'lower', label: 'Bottom' },
];

/* -------------------------------------------------------------------------- */
/*  Exports                                                                    */
/* -------------------------------------------------------------------------- */

export const EXPORT_FORMATS = [
  { id: 'mp4', label: 'MP4 (H.264)', ext: 'mp4' },
  { id: 'webm', label: 'WebM (VP9)', ext: 'webm' },
];

/**
 * Export statuses.
 *
 * `pending_backend` is a real state: rendering an MP4 requires FFmpeg on the
 * server. Rather than pretend an export succeeded, it lands in this state and
 * the UI explains what is missing.
 */
export const EXPORT_STATUS = {
  QUEUED: 'queued',
  RENDERING: 'rendering',
  COMPLETE: 'complete',
  PENDING_BACKEND: 'pending_backend',
  FAILED: 'failed',
};

export const EXPORT_STATUS_META = {
  [EXPORT_STATUS.QUEUED]: { label: 'Queued', tone: 'neutral' },
  [EXPORT_STATUS.RENDERING]: { label: 'Rendering', tone: 'brand' },
  [EXPORT_STATUS.COMPLETE]: { label: 'Ready', tone: 'success' },
  [EXPORT_STATUS.PENDING_BACKEND]: { label: 'Needs backend', tone: 'warning' },
  [EXPORT_STATUS.FAILED]: { label: 'Failed', tone: 'danger' },
};

/** Kinds of export artefact. Sidecars are real, generated in the browser. */
export const EXPORT_KIND = {
  VIDEO: 'video',
  SIDECAR: 'sidecar',
};

export const EXPORT_RESOLUTIONS = [
  { id: '1080x1920', label: '1080 x 1920', note: 'Full HD vertical' },
  { id: '1080x1080', label: '1080 x 1080', note: 'Full HD square' },
  { id: '1920x1080', label: '1920 x 1080', note: 'Full HD landscape' },
];

/* -------------------------------------------------------------------------- */
/*  Notifications                                                              */
/* -------------------------------------------------------------------------- */

export const NOTIFICATION_TONE = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'danger',
};

/* -------------------------------------------------------------------------- */
/*  Marketing                                                                  */
/* -------------------------------------------------------------------------- */

export const SUPPORTED_PLATFORMS = [
  { id: 'reels', name: 'Instagram Reels', ratio: '9:16', maxLength: 90 },
  { id: 'shorts', name: 'YouTube Shorts', ratio: '9:16', maxLength: 60 },
  { id: 'tiktok', name: 'TikTok', ratio: '9:16', maxLength: 180 },
  { id: 'youtube', name: 'YouTube', ratio: '16:9', maxLength: 600 },
  { id: 'linkedin', name: 'LinkedIn', ratio: '1:1', maxLength: 180 },
  { id: 'x', name: 'X / Twitter', ratio: '16:9', maxLength: 140 },
];

export const PRICING_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 19,
    tagline: 'For creators shipping their first clips.',
    cta: 'Start free trial',
    highlighted: false,
    features: [
      '60 processing minutes / month',
      'Up to 10 projects',
      '5 clips per project',
      '1080p exports with captions',
      'Instagram, TikTok & Shorts presets',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 49,
    tagline: 'For creators and podcasters on a weekly cadence.',
    cta: 'Start free trial',
    highlighted: true,
    features: [
      '300 processing minutes / month',
      'Unlimited projects',
      '25 clips per project',
      '4K exports + caption styles',
      'Karaoke captions & B-roll markers',
      'Bulk export & scheduling',
    ],
  },
  {
    id: 'agency',
    name: 'Agency',
    priceMonthly: 129,
    tagline: 'For teams managing many channels at once.',
    cta: 'Talk to us',
    highlighted: false,
    features: [
      '1,500 processing minutes / month',
      '10 seats included',
      'Unlimited clips per project',
      'Shared brand caption kits',
      'Priority render queue',
      'API access & webhooks',
    ],
  },
];

export const FAQ_ITEMS = [
  {
    q: 'How does ClipForge find the best moments?',
    a: 'ClipForge transcribes your audio with word-level timings, then scores candidate segments on hook strength, emotional peaks, question frequency and topic completeness. The highest scoring segments surface first as suggestions you can keep, edit or discard.',
  },
  {
    q: 'Which languages does it understand?',
    a: 'Whisper-based transcription covers 90+ languages. Captions are rendered per clip, and you can correct any transcript segment before exporting.',
  },
  {
    q: 'Do I keep full ownership of my clips?',
    a: 'Yes. You own the source footage and everything ClipForge produces from it. There is no claim on your content and no training on your uploads.',
  },
  {
    q: 'What aspect ratios can I export?',
    a: '9:16 for Reels, Shorts and TikTok, 1:1 for feed posts, and 16:9 for YouTube and LinkedIn. Every clip can be re-rendered at any ratio without re-cutting it.',
  },
  {
    q: 'Can I edit the captions?',
    a: 'Every caption track is editable, with five presets and full control over size, position, colour and highlighting. Changes re-render on the preview before you export.',
  },
  {
    q: 'What happens if processing fails?',
    a: 'Failed jobs keep their transcript and detected segments so you can retry without re-uploading. If a specific stage fails, the pipeline restarts from that stage.',
  },
];
