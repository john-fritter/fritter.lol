import { fetch } from '../lib/http.mjs';

export function createImageService(config) {
  const { jellyfin, timeoutMs } = config;

  function posterFromJellyfinItem(item) {
    if (!jellyfin.configured) return null;

    let jellyfinUrl = null;

    if (item.ImageTags?.Primary) {
      const imageId = item.ImageTags.Primary;
      jellyfinUrl = `${jellyfin.url}/Items/${item.Id}/Images/Primary?height=450&quality=96&tag=${imageId}`;
      console.log(`Building Jellyfin Primary poster URL for item ${item.Id}: ${item.Name}`);
    } else if (item.ImageTags?.Thumb) {
      const imageId = item.ImageTags.Thumb;
      jellyfinUrl = `${jellyfin.url}/Items/${item.Id}/Images/Thumb?height=300&quality=96&tag=${imageId}`;
      console.log(`Building Jellyfin Thumb poster URL for item ${item.Id}: ${item.Name}`);
    } else if (item.Type === 'Episode' && item.SeriesId) {
      jellyfinUrl = `${jellyfin.url}/Items/${item.SeriesId}/Images/Primary?height=450&quality=96`;
      console.log(`Building Jellyfin series poster URL for episode ${item.Id}: ${item.Name} (series: ${item.SeriesId})`);
    }

    if (jellyfinUrl) {
      return `/api/media/img?u=${encodeURIComponent(jellyfinUrl)}&auth=jellyfin`;
    }

    console.log(`No valid poster source found for Jellyfin item:`, item.Name || item.Id);
    return null;
  }

  function fallbackPrimaryPoster(itemId) {
    if (!jellyfin.configured || !itemId) return null;
    const fallbackUrl = `${jellyfin.url}/Items/${itemId}/Images/Primary?height=450&quality=96`;
    return `/api/media/img?u=${encodeURIComponent(fallbackUrl)}&auth=jellyfin`;
  }

  async function proxyImage(req, res) {
    try {
      const u = req.query.u;
      const auth = req.query.auth;
      if (!u) return res.status(400).json({ error: 'missing u' });

      // TODO(fritterflix): before this is treated as public/open-source safe,
      // restrict proxied image URLs to configured Jellyfin/media-stack hosts.
      // The current endpoint intentionally preserves existing behavior.
      console.log(`Image proxy request for: ${u} (auth: ${auth || 'none'})`);

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);

      const headers = {
        'User-Agent': 'media-proxy/1.0'
      };

      if (auth === 'jellyfin') {
        headers['Authorization'] = `MediaBrowser Token="${jellyfin.token}"`;
      }

      const r = await fetch(u, {
        signal: ac.signal,
        headers
      });

      clearTimeout(t);

      if (!r.ok) {
        console.error(`Image proxy error: ${r.status} ${r.statusText} for URL: ${u}`);
        return res.redirect('/placeholder-poster.jpg');
      }

      const contentType = r.headers.get('content-type') || 'image/jpeg';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=3600');

      r.body.pipe(res);
    } catch (e) {
      console.error(`Image proxy exception: ${e.message}`);
      res.redirect('/placeholder-poster.jpg');
    }
  }

  return {
    posterFromJellyfinItem,
    fallbackPrimaryPoster,
    proxyImage
  };
}
