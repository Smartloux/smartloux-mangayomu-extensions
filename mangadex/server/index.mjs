/**
 * MangaDex source extension.
 * API docs: https://api.mangadex.org/docs/
 *
 * The extension never imports a global fetch directly. Callers inject a
 * SourceFetch so the same code runs in a browser (global fetch) and on a
 * Node server (undici or node-fetch).
 */

const API_BASE = "https://api.mangadex.org";
const CDN = "https://uploads.mangadex.org";

// Matches MangaDex's official extension: the CDN offers original, .512.jpg,
// and .256.jpg cover variants. The low variant keeps direct browser loading
// reliable when a browse page requests many covers.
export const MANGADEX_COVER_SUFFIX = ".256.jpg";

// MangaDex answers browser-like user agents with a redirect to its edge
// challenge, which a server-side fetch cannot solve. Identify the app instead;
// the host proxy keeps its browser default for sources that need one.
const IMAGE_USER_AGENT = "MangaYomu/1.0.1 (+https://github.com/mangayomu/mangayomu-app)";

export const MANGADEX_LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "it", label: "Italiano", flag: "🇮🇹" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "pt-br", label: "Português (Brasil)", flag: "🇧🇷" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
  { code: "pl", label: "Polski", flag: "🇵🇱" },
  { code: "ru", label: "Русский", flag: "🇷🇺" },
  { code: "uk", label: "Українська", flag: "🇺🇦" },
  { code: "tr", label: "Türkçe", flag: "🇹🇷" },
  { code: "id", label: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳" },
  { code: "th", label: "ไทย", flag: "🇹🇭" },
  { code: "ko", label: "한국어", flag: "🇰🇷" },
  { code: "ja", label: "日本語", flag: "🇯🇵" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "zh-hk", label: "繁體中文", flag: "🇭🇰" },
];

const DEFAULT_BLOCKED_GROUPS = [
  "5fed0576-8b94-4f9a-b6a7-08eecd69800d",
  "06a9fecb-b608-4f19-b93c-7caab06b7f44",
  "8d8ecf83-8d42-4f8c-add8-60963f9f28d9",
  "caa63201-4a17-4b7f-95ff-ed884a2b7e60",
  "319c1b10-cbd0-4f55-a46e-c4ee17e65139",
  "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
];

export function createMangaDex(fetchFn, options = {}) {
  const coverSuffix = options.coverSuffix || MANGADEX_COVER_SUFFIX;
  const chapterPagesCacheMs = options.chapterPagesCacheMs || 60_000;
  const chapterPagesCacheLimit = Math.max(1, Number(options.chapterPagesCacheLimit) || 128);
  const now = options.now || (() => Date.now());
  const chapterPagesCache = new Map();
  const chapterPagesRequests = new Map();

  function cacheChapterPages(chapterId, pages) {
    const cachedAt = now();
    for (const [id, entry] of chapterPagesCache) {
      if (cachedAt - entry.createdAt >= chapterPagesCacheMs) chapterPagesCache.delete(id);
    }
    chapterPagesCache.delete(chapterId);
    while (chapterPagesCache.size >= chapterPagesCacheLimit) {
      chapterPagesCache.delete(chapterPagesCache.keys().next().value);
    }
    chapterPagesCache.set(chapterId, { createdAt: cachedAt, pages });
  }
  async function readJson(url) {
    const response = await fetchFn(url);
    if (!response.ok) {
      const error = new Error(`MangaDex request failed: ${response.status}`);
      error.status = response.status;
      error.retryAfter = response.headers.get("x-ratelimit-retry-after") || response.headers.get("retry-after");
      throw error;
    }
    return response.json();
  }

  return {
    id: "mangadex",
    name: "MangaDex",
    lang: "en",
    defaultLanguage: "en",
    languages: MANGADEX_LANGUAGES,
    baseUrl: "https://mangadex.org",

    // Cover and page images on the MangaDex CDN expect the site as Referer.
    getImageHeaders() {
      return { Referer: "https://mangadex.org/", "User-Agent": IMAGE_USER_AGENT };
    },

    async getLatestManga(page = 1, requestOptions = {}) {
      const offset = (page - 1) * 100;
      const languages = resolveLanguages(requestOptions, options);
      const chapterUrl = [
        `${API_BASE}/chapter?limit=100&offset=${offset}`,
        ...languageParams("translatedLanguage[]", languages),
        "order[publishAt]=desc",
        "includeFutureUpdates=0",
        "contentRating[]=safe",
        "contentRating[]=suggestive",
        "includeFuturePublishAt=0",
        "includeEmptyPages=0",
        "excludedGroups[]=" + DEFAULT_BLOCKED_GROUPS.join("&excludedGroups[]="),
      ].join("&");
      const data1 = await readJson(chapterUrl);

      const mangaIds = [];
      const seen = {};
      for (const ch of data1.data) {
        for (const rel of ch.relationships) {
          if (rel.type === "manga" && !seen[rel.id]) {
            seen[rel.id] = true;
            mangaIds.push(rel.id);
          }
        }
      }
      if (mangaIds.length === 0) return [];

      const idsParam = mangaIds.map((id) => "ids[]=" + id).join("&");
      const mangaUrl = [
        `${API_BASE}/manga?limit=${mangaIds.length}`,
        "includes[]=cover_art",
        "contentRating[]=safe",
        "contentRating[]=suggestive",
        ...languageParams("availableTranslatedLanguage[]", languages),
        idsParam,
      ].join("&");
      const data2 = await readJson(mangaUrl);

      const mangaMap = {};
      for (const m of data2.data) mangaMap[m.id] = m;

      return mangaIds.map((id) => mangaMap[id]).filter(Boolean).map((manga) => extractThumbnail(manga, coverSuffix, languages));
    },

    async searchManga(query, page = 1, requestOptions = {}) {
      const offset = (page - 1) * 20;
      const languages = resolveLanguages(requestOptions, options);
      const url = [
        `${API_BASE}/manga?limit=20&offset=${offset}`,
        `title=${encodeURIComponent(query)}`,
        "includes[]=cover_art",
        "contentRating[]=safe",
        "contentRating[]=suggestive",
        ...languageParams("availableTranslatedLanguage[]", languages),
      ].join("&");
      const data = await readJson(url);
      return data.data.map((manga) => extractThumbnail(manga, coverSuffix, languages));
    },

    async getMangaDetail(id, requestOptions = {}) {
      const url = [
        `${API_BASE}/manga/${id}?`,
        "includes[]=cover_art",
        "includes[]=author",
        "includes[]=artist",
        "includes[]=tag",
      ].join("&");
      const data = await readJson(url);
      return extractDetail(data.data, coverSuffix, resolveLanguages(requestOptions, options));
    },

    async getChapters(mangaId, requestOptions = {}) {
      const chapters = [];
      let offset = 0;
      let total = 1;
      const languages = resolveLanguages(requestOptions, options);
      while (offset < total) {
        const url = [
          `${API_BASE}/manga/${mangaId}/feed?limit=100&offset=${offset}`,
          "order[chapter]=desc",
          ...languageParams("translatedLanguage[]", languages),
          "contentRating[]=safe",
          "contentRating[]=suggestive",
          "includes[]=scanlation_group",
        ].join("&");
        const data = await readJson(url);
        total = data.total;
        for (const ch of data.data) chapters.push(extractChapter(ch));
        offset += 100;
      }
      return chapters;
    },

    async getChapterPages(chapterId) {
      const cached = chapterPagesCache.get(chapterId);
      if (cached && now() - cached.createdAt < chapterPagesCacheMs) {
        // Refresh insertion order so the bounded map evicts least-recently-used chapters.
        chapterPagesCache.delete(chapterId);
        chapterPagesCache.set(chapterId, cached);
        return cached.pages;
      }
      if (cached) chapterPagesCache.delete(chapterId);
      if (chapterPagesRequests.has(chapterId)) return chapterPagesRequests.get(chapterId);

      const request = readJson(`${API_BASE}/at-home/server/${chapterId}`).then((data) => {
        const pages = {
          urls: data.chapter.data.map((filename) => `${data.baseUrl}/data/${data.chapter.hash}/${filename}`),
        };
        cacheChapterPages(chapterId, pages);
        return pages;
      });
      chapterPagesRequests.set(chapterId, request);
      try {
        return await request;
      } finally {
        chapterPagesRequests.delete(chapterId);
      }
    },
  };
}

// --- Helpers ---

function findRelationship(rel, type) {
  for (const r of rel || []) {
    if (r.type === type) return r;
  }
  return null;
}

function extractCoverFileName(rel) {
  const cover = findRelationship(rel, "cover_art");
  if (!cover) return null;
  const attrs = cover.attributes;
  return attrs ? attrs.fileName || null : null;
}

export function mangaDexCoverUrl(url, coverSuffix = MANGADEX_COVER_SUFFIX) {
  try {
    const parsed = new URL(url);
    const hasVariant = /(\.256\.jpg|\.512\.jpg)$/.test(parsed.pathname);
    if (parsed.hostname !== "uploads.mangadex.org" || !parsed.pathname.startsWith("/covers/") || !coverSuffix || hasVariant) {
      return url;
    }
    parsed.pathname += coverSuffix;
    return parsed.toString();
  } catch {
    return url;
  }
}

function coverUrl(mangaId, fileName, coverSuffix) {
  return fileName ? mangaDexCoverUrl(CDN + "/covers/" + mangaId + "/" + fileName, coverSuffix) : null;
}

function extractThumbnail(manga, coverSuffix, languages) {
  const attrs = manga.attributes;
  const title = resolveTitle(attrs, languages);
  const coverFile = extractCoverFileName(manga.relationships);
  return {
    id: manga.id,
    title,
    coverUrl: coverUrl(manga.id, coverFile, coverSuffix),
    source: "mangadex",
  };
}

function extractDetail(manga, coverSuffix, languages) {
  const attrs = manga.attributes;
  const availableLanguages = MANGADEX_LANGUAGES.filter((language) => (attrs.availableTranslatedLanguages || []).includes(language.code));
  const displayLanguage = resolveDetailLanguage(languages, availableLanguages);
  const authors = [];
  for (const r of manga.relationships || []) {
    if (r.type === "author" || r.type === "artist") {
      if (r.attributes && r.attributes.name) authors.push(r.attributes.name);
    }
  }
  const genres = [];
  const themes = [];
  const formats = [];
  const contents = [];
  for (const tag of attrs.tags || []) {
    const tagAttrs = tag.attributes;
    if (!tagAttrs || !tagAttrs.name || !tagAttrs.name.en) continue;
    const group = tagAttrs.group;
    const label = tagAttrs.name.en;
    if (group === "genre") genres.push(label);
    else if (group === "theme") themes.push(label);
    else if (group === "format") formats.push(label);
    else if (group === "content") contents.push(label);
  }
  return {
    id: manga.id,
    title: resolveTitle(attrs, languages),
    altTitle: resolveAltTitle(attrs, languages),
    description: resolveLocalizedText(attrs.description, languages),
    coverUrl: coverUrl(manga.id, extractCoverFileName(manga.relationships), coverSuffix),
    authors,
    genres,
    themes,
    formats,
    contents,
    status: attrs.status || "unknown",
    source: "mangadex",
    availableLanguages,
    displayLanguage,
  };
}

function extractChapter(ch) {
  const attrs = ch.attributes;
  return {
    id: ch.id,
    chapterNumber: attrs.chapter ? parseFloat(attrs.chapter) : null,
    volume: attrs.volume || null,
    title: attrs.title || "",
    lang: attrs.translatedLanguage || "en",
    pageCount: attrs.pages || 0,
    createdAt: attrs.createdAt || null,
  };
}

function resolveLanguages(requestOptions, extensionOptions) {
  let requested = requestOptions.languages;
  if (requested == null && extensionOptions && typeof extensionOptions.getLanguages === "function") {
    requested = extensionOptions.getLanguages();
  }
  if (requested == null && extensionOptions) requested = extensionOptions.languages;
  if (requested == null) requested = ["en"];
  const values = Array.isArray(requested) ? requested : [requested];
  const unique = [...new Set(values.filter((value) => typeof value === "string" && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(value)))];
  return unique.length > 0 ? unique.slice(0, 5) : ["en"];
}

function languageParams(key, languages) {
  return languages.map((language) => key + "=" + encodeURIComponent(language));
}

function resolveLocalizedText(values, languages) {
  if (!values || typeof values !== "object") return null;
  for (const language of languages || []) {
    if (values[language]) return String(values[language]);
  }
  if (values.en) return String(values.en);
  const fallback = Object.values(values)[0];
  return fallback ? String(fallback) : null;
}

function resolveTitle(attrs, languages) {
  return resolveLocalizedText(attrs.title, languages) || "Untitled";
}

function resolveDetailLanguage(languages, availableLanguages) {
  for (const language of languages) {
    if (availableLanguages.some((item) => item.code === language)) return language;
  }
  if (availableLanguages.some((item) => item.code === "en")) return "en";
  return availableLanguages.length > 0 ? availableLanguages[0].code : languages[0];
}

function resolveAltTitle(attrs, languages) {
  if (!attrs.altTitles || attrs.altTitles.length === 0) return null;
  for (const alternative of attrs.altTitles) {
    const value = resolveLocalizedText(alternative, languages);
    if (value) return value;
  }
  return null;
}
// Package adapter: the runtime injects the fetch capability.
export default function createExtension(runtime) {
  return createMangaDex(runtime.fetch);
}
