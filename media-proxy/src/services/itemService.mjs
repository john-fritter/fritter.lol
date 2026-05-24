import { normalizeMovie } from './libraryService.mjs';

const ITEM_FIELDS = [
  'BasicSyncInfo',
  'CanDelete',
  'CommunityRating',
  'CriticRating',
  'DateCreated',
  'Genres',
  'OfficialRating',
  'ProviderIds',
  'PrimaryImageAspectRatio',
  'ProductionYear',
  'RunTimeTicks'
].join(',');

export function createItemService({ config, jellyfinClient, imageService }) {
  const { jellyfin } = config;

  async function getItem(id) {
    if (!jellyfin.configured) return { status: 503, error: 'jellyfin not configured' };

    const params = new URLSearchParams({
      Fields: ITEM_FIELDS,
      ImageTypeLimit: '1',
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      EnableUserData: 'true'
    });

    const response = await jellyfinClient.request(
      `/Users/${encodeURIComponent(jellyfin.userId)}/Items/${encodeURIComponent(id)}?${params}`
    );

    if (!response.ok) return { status: 404, error: 'item not found' };

    const raw = response.json;
    if (!raw || raw.Type !== 'Movie') return { status: 404, error: 'item not found' };

    return { status: 200, item: normalizeMovie(raw, imageService) };
  }

  return { getItem };
}
