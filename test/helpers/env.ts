export interface TestEnv {
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  APP_CONFIG_JSON: string;
}

export function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    ICLOUD_SHARED_ALBUM_TOKEN: "TEST-TOKEN-ABC123",
    APP_CONFIG_JSON: JSON.stringify({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "A",
    }),
    ...overrides,
  };
}
