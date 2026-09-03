export interface SourcePhoto {
  sourceAlbumId: string;
  applePhotoId: string;
  position: number;
  captureAt: string | null;
  derivativeUrl: string;
  mediaType: "image/jpeg";
}

export interface AlbumSnapshot {
  sourceAlbumId: string;
  fetchedAt: string;
  photos: SourcePhoto[];
}

export type ImageSource = {
  getSnapshot(): Promise<AlbumSnapshot>;
  download(photo: SourcePhoto): Promise<Response>;
};
