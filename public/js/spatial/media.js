// Inline video (video pipeline phase 1): which saved links can play inside Aether, and how. Pure, so the page, the card
// faces and the tests share one answer. Phase 1 plays YouTube and Vimeo through their official embed players and direct
// video files through a plain <video>; every other link (TikTok, X, Facebook, Instagram, web pages) launches in a
// new tab.

const FILE_PATTERN = /\.(mp4|webm|m4v|mov)$/i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

const parseUrl = value => {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

// YouTube's ?t= and &start= come as seconds, "90s" or "1h2m3s"; embeds take whole seconds.
function startSeconds(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match) return 0;
  return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
}

// { kind: 'youtube' | 'vimeo', id, embedUrl } or { kind: 'file', src }, or null when the link is not playable inline.
export function parseMedia(value) {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = null;
    if (host === 'youtu.be') id = parts[0];
    else if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
    if (!id || !YOUTUBE_ID.test(id)) return null;
    const start = startSeconds(url.searchParams.get('t') || url.searchParams.get('start'));
    const embed = new URL('https://www.youtube-nocookie.com/embed/' + id);
    embed.searchParams.set('autoplay', '1');
    embed.searchParams.set('playsinline', '1');
    embed.searchParams.set('rel', '0');
    if (start) embed.searchParams.set('start', String(start));
    return { kind: 'youtube', id, embedUrl: embed.toString() };
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const index = host === 'player.vimeo.com' ? (parts[0] === 'video' ? 1 : -1) : parts.findIndex(part => /^\d+$/.test(part));
    const id = index >= 0 ? parts[index] : null;
    if (!id || !/^\d+$/.test(id)) return null;
    // Unlisted videos carry a privacy hash, either as the next path part or as ?h=.
    const hash = url.searchParams.get('h') || (host === 'vimeo.com' && /^[0-9a-f]{6,}$/i.test(parts[index + 1] || '') ? parts[index + 1] : null);
    const embed = new URL('https://player.vimeo.com/video/' + id);
    if (hash) embed.searchParams.set('h', hash);
    embed.searchParams.set('autoplay', '1');
    return { kind: 'vimeo', id, embedUrl: embed.toString() };
  }

  if (FILE_PATTERN.test(url.pathname)) return { kind: 'file', src: url.toString() };
  return null;
}

export const isPlayable = value => parseMedia(value) !== null;
