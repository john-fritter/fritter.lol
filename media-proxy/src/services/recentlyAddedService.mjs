export function createRecentlyAddedService({ config, jellyfinClient, imageService }) {
  const { jellyfin } = config;

  async function getRecentlyAdded(limit = 10) {
    if (!jellyfin.configured) return { items: [], warning: 'jellyfin not configured' };

    let r = await jellyfinClient.request(`/Items?SortBy=DateCreated&SortOrder=Descending&Limit=${limit}&Recursive=true&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear,DateCreated&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&IncludeItemTypes=Movie,Episode`);
    let list = r.ok ? (r.json?.Items || []) : [];
    let source = 'jellyfin-global-items';

    if (!r.ok || !list.length) {
      const fallback = await jellyfinClient.request(`/Users/${jellyfin.userId}/Items/Latest?Limit=${limit}&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear,DateCreated&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`);
      if (!fallback.ok) return { items: [], warning: `jellyfin: ${fallback.error}` };
      list = fallback.json || [];
      source = 'jellyfin-user-latest-fallback';
    }

    const items = [];

    for (const item of list) {
      let title = item.Name || 'Unknown';
      let grandparent_title = null;

      if (item.Type === 'Episode') {
        grandparent_title = item.SeriesName;
        if (item.SeasonName && item.IndexNumber) {
          title = `${item.SeasonName} E${item.IndexNumber} - ${item.Name}`;
        }
      } else if (item.Type === 'Season') {
        grandparent_title = item.SeriesName;
        title = `${item.Name}`;
      }

      const addedAt = item.DateCreated ? new Date(item.DateCreated).getTime() : Date.now();
      const poster = imageService.posterFromJellyfinItem(item);

      console.log(`Jellyfin recently added item: ${title} (${item.Type || 'unknown type'}) - poster: ${poster ? 'yes' : 'no'}`);

      items.push({
        title,
        grandparent_title,
        year: item.ProductionYear || null,
        added_at: addedAt,
        media_type: item.Type?.toLowerCase() || '',
        poster
      });
    }

    items.sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
    return { items, source };
  }

  return { getRecentlyAdded };
}
