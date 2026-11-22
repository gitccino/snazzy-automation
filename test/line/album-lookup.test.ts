import { expect, it } from 'vitest';
import { albumRegistrySchema, resolveAlbum } from '../../src/line/album-lookup';
const a = { sourceAlbumId: '32', name: 'Shared album 32', url: 'https://www.icloud.com/sharedalbum/#B123', startDate: '2026-01-10', endDate: '2026-06-11' };
const b = { sourceAlbumId: '33', name: 'Shared album 33', url: null, startDate: '2026-06-11', endDate: '2026-10-10' };
it('resolves inclusive date boundaries and two possible albums', () => {
  expect(resolveAlbum([a,b], null, '2026-06-11')).toEqual({status:'found', basis:'date', albums:[a,b]});
  expect(resolveAlbum([a,b], null, '2026-01-10')).toMatchObject({albums:[a]});
  expect(resolveAlbum([a,b], null, '2026-10-11')).toEqual({status:'unknown'});
});
it('prefers exact provenance and never guesses an unmapped or conflicting source', () => {
  expect(resolveAlbum([a,b], ['32'], '2026-09-01')).toMatchObject({basis:'source',albums:[a]});
  expect(resolveAlbum([a,b], ['missing'], '2026-02-01')).toEqual({status:'unknown'});
  expect(resolveAlbum([a,b], ['32','33'], '2026-02-01')).toEqual({status:'unknown'});
  expect(resolveAlbum([a,b], ['32'], null)).toMatchObject({basis:'source'});
});
it.each([null,'','2026-02-30','2026-2-01','2026-01-10T00:00:00Z'])('does not guess missing or invalid dates %s', date => {
  expect(resolveAlbum([a,b], null, date)).toEqual({status:'unknown'});
});
it('validates registry dates, unique sources, names, URLs and maximum overlap', () => {
  expect(albumRegistrySchema.parse([a,b])).toEqual([a,b]);
  for (const bad of [
    [{...a,startDate:'2026-02-30'}], [{...a,endDate:'2025-01-01'}], [{...a,startDate:null}],
    [a,a], [a,b,{...b,sourceAlbumId:'34'}], [{...a,name:''}],
    ...['javascript:alert(1)','https://www.icloud.com.evil/sharedalbum/#B123','https://user:pass@www.icloud.com/sharedalbum/#B123','http://www.icloud.com/sharedalbum/#B123'].map(url=>[{...a,url}]),
  ]) expect(albumRegistrySchema.safeParse(bad).success).toBe(false);
  expect(albumRegistrySchema.safeParse([{...a,startDate:null,endDate:null,url:null}]).success).toBe(true);
});

it('rejects album URLs above the application link length limit',()=>{
 const prefix='https://www.icloud.com/sharedalbum/#';
 expect(albumRegistrySchema.safeParse([{...a,url:prefix+'B'.repeat(1000-prefix.length)}]).success).toBe(true);
 expect(albumRegistrySchema.safeParse([{...a,url:prefix+'B'.repeat(1001-prefix.length)}]).success).toBe(false);
});

it('rejects raw whitespace that URL parsing would silently discard',()=>{
 for(const url of [' https://www.icloud.com/sharedalbum/#B123','https://www.icloud.com/sharedalbum/#B1\n23','https://www.icloud.com/sharedalbum/#B123\t']) {
  expect(albumRegistrySchema.safeParse([{...a,url}]).success).toBe(false);
 }
});

it('accepts the URL-safe token alphabet used by Photos sharing links',()=>{
 expect(albumRegistrySchema.safeParse([{...a,url:'https://www.icloud.com/sharedalbum/#D1zv3AbC_def-123'}]).success).toBe(true);
});
