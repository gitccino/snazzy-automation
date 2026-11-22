import { z } from 'zod';

export function isAlbumDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '9999-12-31'
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}
const date = z.string().refine(isAlbumDate).nullable();
const sharedUrl = z.string().max(1000).refine(value => {
  try {
    const u = new URL(value);
    return u.href === value && u.protocol === 'https:' && u.hostname === 'www.icloud.com' && !u.port && !u.username && !u.password
      && u.pathname === '/sharedalbum/' && !u.search && /^#[A-Za-z0-9_-]+$/.test(u.hash);
  } catch { return false; }
});
const albumSchema = z.strictObject({
  sourceAlbumId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  url: sharedUrl.nullable(), startDate: date, endDate: date,
}).refine(a => (a.startDate === null && a.endDate === null)
  || (a.startDate !== null && a.endDate !== null && a.startDate <= a.endDate));
export const albumRegistrySchema = z.array(albumSchema).max(200).refine(albums => {
  if (new Set(albums.map(a=>a.sourceAlbumId)).size !== albums.length) return false;
  // Every increase in inclusive overlap occurs on a start date.
  return albums.every(a => !a.startDate || albums.filter(b => b.startDate && b.endDate && b.startDate <= a.startDate! && b.endDate >= a.startDate!).length <= 2);
});
export type Album = z.infer<typeof albumSchema>;
export type AlbumLookup = {status:'found'; basis:'source'|'date'; albums:Album[]} | {status:'unknown'|'unavailable'};

export function resolveAlbum(registry: Album[], sourceAlbumIds: string[] | null, uploadDate: string | null): AlbumLookup {
  if (sourceAlbumIds !== null) {
    if (sourceAlbumIds.length !== 1) return {status:'unknown'};
    const album = registry.find(a=>a.sourceAlbumId === sourceAlbumIds[0]);
    return album ? {status:'found',basis:'source',albums:[album]} : {status:'unknown'};
  }
  if (!uploadDate || !isAlbumDate(uploadDate)) return {status:'unknown'};
  const albums = registry.filter(a=>a.startDate && a.endDate && a.startDate <= uploadDate && a.endDate >= uploadDate);
  return albums.length > 0 && albums.length <= 2 ? {status:'found',basis:'date',albums} : {status:'unknown'};
}
