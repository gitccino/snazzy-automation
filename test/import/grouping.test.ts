import { describe, expect, it } from "vitest";
import {
  computeGroupHash,
  groupByMarkers,
  type GroupingPhoto,
} from "../../src/import/grouping";

function photo(id: string, position: number, isMarker = false): GroupingPhoto {
  return { applePhotoId: id, position, isMarker, r2Key: `assets/${id}.jpg` };
}

describe("groupByMarkers", () => {
  it("splits photos into marker-to-marker groups, marker included in each group", () => {
    const photos = [
      photo("m1", 1, true),
      photo("p1", 2),
      photo("p2", 3),
      photo("m2", 4, true),
      photo("p3", 5),
      photo("p4", 6),
      photo("p5", 7),
    ];
    const result = groupByMarkers(photos);
    expect(result.orphanPhotos).toEqual([]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({ ordinal: 0, markerPhotoId: "m1" });
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual([
      "m1",
      "p1",
      "p2",
    ]);
    expect(result.groups[1]).toMatchObject({ ordinal: 1, markerPhotoId: "m2" });
    expect(result.groups[1]!.photos.map((p) => p.applePhotoId)).toEqual([
      "m2",
      "p3",
      "p4",
      "p5",
    ]);
  });

  it("the final group ends at the snapshot boundary, no trailing marker required", () => {
    const photos = [photo("m1", 1, true), photo("p1", 2), photo("p2", 3)];
    const result = groupByMarkers(photos);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual([
      "m1",
      "p1",
      "p2",
    ]);
  });

  it("photos before the first marker are reported as orphans, not a group", () => {
    const photos = [
      photo("stray1", 1),
      photo("stray2", 2),
      photo("m1", 3, true),
      photo("p1", 4),
    ];
    const result = groupByMarkers(photos);
    expect(result.orphanPhotos.map((p) => p.applePhotoId)).toEqual([
      "stray1",
      "stray2",
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.markerPhotoId).toBe("m1");
  });

  it("a snapshot with no marker at all is entirely orphaned", () => {
    const photos = [photo("stray1", 1), photo("stray2", 2)];
    const result = groupByMarkers(photos);
    expect(result.groups).toEqual([]);
    expect(result.orphanPhotos).toHaveLength(2);
  });

  it("sorts by position before grouping, independent of input array order", () => {
    const photos = [photo("p1", 2), photo("m1", 1, true)];
    const result = groupByMarkers(photos);
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual([
      "m1",
      "p1",
    ]);
  });

  it("back-to-back markers with no photos between them produce a single-photo group", () => {
    const photos = [photo("m1", 1, true), photo("m2", 2, true), photo("p1", 3)];
    const result = groupByMarkers(photos);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual(["m1"]);
    expect(result.groups[1]!.photos.map((p) => p.applePhotoId)).toEqual([
      "m2",
      "p1",
    ]);
  });
});

describe("computeGroupHash", () => {
  it("is deterministic for the same album and ordered photo IDs", async () => {
    const photos = [photo("m1", 1, true), photo("p1", 2)];
    const a = await computeGroupHash("album-1", photos);
    const b = await computeGroupHash("album-1", photos);
    expect(a).toBe(b);
  });

  it("differs when the album differs", async () => {
    const photos = [photo("m1", 1, true), photo("p1", 2)];
    const a = await computeGroupHash("album-1", photos);
    const b = await computeGroupHash("album-2", photos);
    expect(a).not.toBe(b);
  });

  it("differs when photo order differs", async () => {
    const a = await computeGroupHash("album-1", [
      photo("m1", 1, true),
      photo("p1", 2),
    ]);
    const b = await computeGroupHash("album-1", [
      photo("p1", 2),
      photo("m1", 1, true),
    ]);
    expect(a).not.toBe(b);
  });

  it("does not collide when delimiters appear in photo IDs", async () => {
    const a = await computeGroupHash("album-1", [
      photo("a,b", 1),
      photo("c", 2),
    ]);
    const b = await computeGroupHash("album-1", [
      photo("a", 1),
      photo("b,c", 2),
    ]);
    expect(a).not.toBe(b);
  });
});

it("closes product groups at ignore markers and resumes only at product markers", async () => {
  const input: GroupingPhoto[] = [photo("m1", 1, true), photo("p1", 2),
    { ...photo("ignore", 3), markerKind: "ignore_start", r2Key: null }, photo("extra", 4),
    photo("m2", 5, true), photo("p2", 6)];
  const result = groupByMarkers(input);
  expect(result.groups.map(g => g.photos.map(p => p.applePhotoId))).toEqual([["m1", "p1"], ["m2", "p2"]]);
  expect(result.ignoredPhotos.map(p => p.applePhotoId)).toEqual(["ignore", "extra"]);
  expect(result.orphanPhotos).toEqual([]);
  const legacyHash = await computeGroupHash("album", [photo("m1", 1, true), photo("p1", 2)]);
  expect(await computeGroupHash("album", result.groups[0]!.photos)).toBe(legacyHash);
});

it("ignores repeated markers and ordinary photos before any product in position order", () => {
  const input: GroupingPhoto[] = [photo("extra", 3),
    { ...photo("i2", 2), markerKind: "ignore_start", r2Key: null },
    { ...photo("i1", 1), markerKind: "ignore_start", r2Key: null }];
  const result = groupByMarkers(input);
  expect(result.groups).toEqual([]);
  expect(result.orphanPhotos).toEqual([]);
  expect(result.ignoredPhotos.map(p => p.applePhotoId)).toEqual(["i1", "i2", "extra"]);
});

it("preserves an empty product group when an ignore marker immediately closes it", () => {
  const result = groupByMarkers([photo("m1", 1, true), { ...photo("i1", 2), markerKind: "ignore_start" }]);
  expect(result.groups.map(g => g.photos.map(p => p.applePhotoId))).toEqual([["m1"]]);
});
