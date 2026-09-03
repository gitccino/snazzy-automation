// ponytail: placeholder Worker entry-point so the Vitest pool can boot.
// Task 15 replaces this with the real cron + /upload router.
export default {
  async fetch(): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },
};
