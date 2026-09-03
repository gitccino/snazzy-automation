export const WEBSTREAM_FIXTURE = {
  photos: [
    {
      photoGuid: "AAAA-1111",
      dateCreated: "2026-08-31T09:00:00Z",
      batchDateCreated: "2026-08-31T09:00:00Z",
      derivatives: {
        "2048": { checksum: "chk-aaaa-2048", fileSize: "204800" },
      },
    },
    {
      photoGuid: "BBBB-2222",
      dateCreated: "2026-08-31T09:01:00Z",
      batchDateCreated: "2026-08-31T09:01:00Z",
      derivatives: {
        "2048": { checksum: "chk-bbbb-2048", fileSize: "199000" },
      },
    },
  ],
};

export const WEBASSETURLS_FIXTURE = {
  items: {
    "chk-aaaa-2048": { url_location: "cvws.icloud-content.com", url_path: "/A/aaaa?o=1&v=1&x=1&s=1&a=1&k=1&e=1" },
    "chk-bbbb-2048": { url_location: "cvws.icloud-content.com", url_path: "/B/bbbb?o=1&v=1&x=1&s=1&a=1&k=1&e=1" },
  },
};
