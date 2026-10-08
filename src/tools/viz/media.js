// show_media — Momo materializes an image / doc preview inside her
// hologram. Images from Drive, screenshots, Gmail attachments, Stripe
// receipts, quick sketches — anything the user asked to see, Momo
// projects in the hologram column instead of answering with "here's a
// link".
//
// We accept a narrow allowlist of sources rather than arbitrary URLs —
// this keeps the projection in the same trust envelope as the rest of
// the iframe shell (the browser will still sandbox the media projectable,
// but we shouldn't even invite a random URL through the front door).
// The future connector tools (gmail.js, drive.js) write the actual bytes
// to the store and pass `media_ref` here; they never give the model a
// URL to paste.

import * as projectables from '../../store/projectables.js';

const MAX_CAPTION_LEN = 140;

// Allowed media types. Images only for now; PDFs + doc thumbnails land
// when the connectors arrive.
const VALID_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

export const definition = {
  type: 'function',
  name: 'show_media',
  description:
    'Project an image or document preview inside the hologram — for example a receipt the user asked to see, a screenshot from their shop, a thumbnail from an inbound email. Pass a media_ref returned by a connector tool (future: get_email_attachment, get_drive_file, etc.) plus a short caption Momo can narrate. Never pass raw URLs — the projection must come from a tool-produced ref against the server-side store.',
  parameters: {
    type: 'object',
    properties: {
      media_ref: {
        type: 'string',
        description: 'Reference id returned by a connector tool that wrote the bytes into the store. Required.',
      },
      caption: {
        type: 'string',
        description: `Short caption shown under the media (≤${MAX_CAPTION_LEN} chars). omo should also narrate what the media shows in one cute sentence.`,
      },
      size: {
        type: 'string',
        enum: ['wide', 'square', 'stat'],
        description: "Card footprint. wide = lanscape-native (default for receipts, screenshots); square = logos / avatars; stat = tiny thumbnail.",
      },
    },
    required: ['media_ref'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const media_ref = String(args?.media_ref || '').trim();
  if (!media_ref) return { error: 'media_ref is required' };

  const source = projectables.get(media_ref);
  if (!source) return { error: `media_ref "${media_ref}" not found or expired` };

  // We accept either a media-kind projectable (pre-assembled by a
  // connector tool) OR a raw bytes record in the unified store. Both
  // paths land in the same payload shape for the client.
  if (source.kind !== 'media') {
    return { error: `media_ref points to a ${source.kind}, not a media blob` };
  }
  const { mediaType, dataUrl, filename } = source.payload || {};
  if (!mediaType || !VALID_MEDIA_TYPES.has(mediaType)) {
    return { error: `unsupported or missing mediaType: ${mediaType}` };
  }
  if (!dataUrl) return { error: 'media payload missing dataUrl' };

  const caption = String(args?.caption || '').trim().slice(0, MAX_CAPTION_LEN);
  const size = ['wide', 'square', 'stat'].includes(args?.size) ? args.size : 'wide';

  // Stash a NEW projectable for the mounted preview — keeps the original
  // media_ref in the store (so the model can show the same file twice
  // with different captions) while giving the client a fresh id for
  // lifecycle tracking.
  const projectable_id = projectables.put('media', {
    meta: { caption, size, mediaType, filename: filename || null },
    payload: { mediaType, dataUrl, filename: filename || null },
  });

  return {
    projectable_id,
    kind: 'media',
    caption,
    size,
    mediaType,
    filename: filename || null,
    // dataUrl travels in the tool response so the client can mount
    // immediately without a second server round-trip. When media payloads
    // grow (full-resolution attachments, doc pages) we'll add a
    // /media/:id endpoint and drop this; until then connector tools only
    // ship thumbnails so inline is fine.
    dataUrl,
    note: 'Media is projecting on stage. Narrate what it shows in one short cute sentence.',
  };
}
