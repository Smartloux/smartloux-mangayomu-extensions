import assert from "node:assert/strict";
import { createMangaDex } from "../server/index.mjs";

let now = 1_000;
let fetchCalls = 0;
let resolveFetch;
const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
const chapterResponse = () => new Response(JSON.stringify({
  baseUrl: "https://uploads.mangadex.org",
  chapter: { hash: "hash", data: ["001.jpg"] },
}), { status: 200 });
const extension = createMangaDex(() => {
  fetchCalls++;
  return pendingFetch.then(chapterResponse);
}, { now: () => now, chapterPagesCacheMs: 60_000 });

const first = extension.getChapterPages("chapter-1");
const duplicate = extension.getChapterPages("chapter-1");
assert.equal(fetchCalls, 1, "concurrent reads of one chapter share the AtHome request");
resolveFetch();
const [firstPages, duplicatePages] = await Promise.all([first, duplicate]);
assert.equal(firstPages.urls[0], "https://uploads.mangadex.org/data/hash/001.jpg");
assert.equal(duplicatePages, firstPages, "concurrent callers receive the shared result");

await extension.getChapterPages("chapter-1");
assert.equal(fetchCalls, 1, "a recent chapter result is reused instead of re-requesting AtHome");

now += 60_001;
const refreshed = extension.getChapterPages("chapter-1");
assert.equal(fetchCalls, 2, "expired chapter results may be refreshed");
// The mock's first fulfilled promise remains a valid result for the refresh.
await refreshed;

const rateLimited = createMangaDex(async () => new Response("slow down", {
  status: 429,
  headers: { "x-ratelimit-retry-after": "2000" },
}));
await assert.rejects(
  () => rateLimited.getChapterPages("chapter-2"),
  (error) => error.status === 429 && error.retryAfter === "2000",
  "rate-limit errors retain upstream status and retry metadata"
);

// Cover URL normalization never appends a variant suffix twice.
const { mangaDexCoverUrl } = await import("../server/index.mjs");
assert.equal(
  mangaDexCoverUrl("https://uploads.mangadex.org/covers/uuid/cover.jpg"),
  "https://uploads.mangadex.org/covers/uuid/cover.jpg.256.jpg",
  "plain covers gain the low-res suffix once"
);
assert.equal(
  mangaDexCoverUrl("https://uploads.mangadex.org/covers/uuid/cover.jpg.512.jpg"),
  "https://uploads.mangadex.org/covers/uuid/cover.jpg.512.jpg",
  "existing 512 variant is never double-suffixed"
);
assert.equal(
  mangaDexCoverUrl("https://uploads.mangadex.org/covers/uuid/cover.jpg.256.jpg"),
  "https://uploads.mangadex.org/covers/uuid/cover.jpg.256.jpg",
  "existing 256 variant is never double-suffixed"
);

// The source exposes the image request capability the server proxy uses.
const headers = extension.getImageHeaders();
assert.equal(headers.Referer, "https://mangadex.org/", "source declares its CDN Referer");

let cappedCalls = 0;
const capped = createMangaDex(async () => {
  cappedCalls++;
  return chapterResponse();
}, { chapterPagesCacheLimit: 1 });
await capped.getChapterPages("chapter-a");
await capped.getChapterPages("chapter-b");
await capped.getChapterPages("chapter-a");
assert.equal(cappedCalls, 3, "the chapter cache evicts old entries instead of growing without bound");

console.log("PASS chapter pages: request deduplication, bounded TTL cache, and rate-limit metadata");
