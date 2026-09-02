const BASE = "https://www.mangaworld.mx";
const MANGAWORLD_LANGUAGES = [{ code: "it", label: "Italiano", flag: "🇮🇹" }];

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  "Referer": BASE,
};

/**
 * MangaWorld source shared by browser and Node runtimes. Networking and HTML
 * parsing are injected so the source never assumes either environment.
 */
export function createMangaWorld(runtime) {
  async function fetchPage(url) {
    const response = await runtime.fetch(url, { headers: BROWSER_HEADERS });
    if (!response.ok) throw new Error(`MangaWorld request failed: ${response.status}`);
    return runtime.parseHtml(await response.text());
  }

  return {
    id: "mangaworld",
    name: "MangaWorld",
    lang: "it",
    defaultLanguage: "it",
    languages: MANGAWORLD_LANGUAGES,
    baseUrl: BASE,

    // Images on the MangaWorld CDN expect the site as Referer.
    getImageHeaders() {
      return BROWSER_HEADERS;
    },

    async getLatestManga(page = 1) {
      const document = await fetchPage(page > 1 ? `${BASE}/?page=${page}` : BASE);
      return parseMangaCards(document);
    },

    async searchManga(query, page = 1) {
      const url = new URL("/archive", BASE);
      url.searchParams.set("page", String(page));
      if (query) url.searchParams.set("keyword", query);
      return parseMangaCards(await fetchPage(url.toString()));
    },

    async getMangaDetail(id) {
      const document = await fetchPage(mangaUrl(id));
      const info = document.querySelector("div.comic-info");
      if (!info) throw new Error("MangaWorld manga not found");

      const alternativeTitles = Array.from(info.querySelectorAll(".meta-data .col-12"))
        .map((element) => element.textContent?.trim() || "")
        .find((text) => text.startsWith("Titoli alternativi:"));
      const statusText = info.querySelector('a[href*="/archive?status="]')?.textContent?.trim() || "";

      return {
        id: normalizeMangaId(id),
        title: info.querySelector("h1.name")?.textContent?.trim() || "Untitled",
        altTitle: alternativeTitles?.replace("Titoli alternativi:", "").trim() || null,
        description: document.querySelector("#noidungm")?.textContent?.trim() || null,
        coverUrl: absoluteUrl(info.querySelector(".thumb > img")?.getAttribute("src")),
        authors: uniqueText(info.querySelectorAll('a[href*="/archive?author="]')),
        genres: uniqueText(info.querySelectorAll(".meta-data a.badge")),
        themes: [],
        formats: [],
        contents: [],
        status: parseStatus(statusText),
        source: "mangaworld",
        availableLanguages: MANGAWORLD_LANGUAGES,
        displayLanguage: "it",
      };
    },

    async getChapters(mangaId) {
      const document = await fetchPage(mangaUrl(mangaId));
      return Array.from(document.querySelectorAll(".chapters-wrapper .chapter"))
        .map((element) => {
          const link = element.querySelector("a.chap");
          if (!link) return null;
          const href = absoluteUrl(link.getAttribute("href"));
          const id = chapterId(href);
          if (!id) return null;
          const title = element.querySelector("span.d-inline-block")?.textContent?.trim() || "";
          return {
            id,
            chapterNumber: parseChapterNumber(title),
            volume: null,
            title,
            lang: "it",
            pageCount: 0,
            createdAt: parseDate(element.querySelector(".chap-date")?.textContent?.trim() || ""),
          };
        })
        .filter(Boolean);
    },

    async getChapterPages(chapterId, mangaId) {
      if (!mangaId) throw new Error("MangaWorld requires the manga id to load a chapter");
      const url = `${mangaUrl(mangaId)}/read/${encodeURIComponent(chapterId)}/1?style=list`;
      const document = await fetchPage(url);
      return {
        urls: Array.from(document.querySelectorAll("div#page img.page-image"))
          .map((image) => absoluteUrl(image.getAttribute("src")))
          .filter(Boolean),
      };
    },
  };
}

function parseMangaCards(document) {
  return Array.from(document.querySelectorAll("div.comics-grid .entry"))
    .map((element) => {
      const link = element.querySelector("a.thumb") || element.querySelector("a");
      const id = normalizeMangaId(link?.getAttribute("href") || "");
      if (!id) return null;
      return {
        id,
        title: link?.getAttribute("title")?.trim() || element.querySelector("a.manga-title")?.textContent?.trim() || "Untitled",
        coverUrl: absoluteUrl(link?.querySelector("img")?.getAttribute("src")),
        source: "mangaworld",
      };
    })
    .filter(Boolean);
}

function mangaUrl(id) {
  return `${BASE}/manga/${normalizeMangaId(id)}`;
}

function normalizeMangaId(value) {
  const directId = value.match(/^(\d+\/[^/?]+)/);
  if (directId) return directId[1];
  try {
    const pathname = new URL(value, BASE).pathname;
    const match = pathname.match(/^\/manga\/(\d+\/[^/]+)/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function chapterId(value) {
  try {
    return new URL(value || "", BASE).pathname.match(/\/read\/([a-f0-9]+)/i)?.[1] || "";
  } catch {
    return "";
  }
}

function absoluteUrl(value) {
  if (!value) return null;
  try {
    return new URL(value, BASE).toString();
  } catch {
    return null;
  }
}

function uniqueText(elements) {
  return [...new Set(Array.from(elements).map((element) => element.textContent?.trim() || "").filter(Boolean))];
}

function parseChapterNumber(title) {
  const match = title.match(/capitolo\s*([0-9]+(?:\.[0-9]+)?)/i);
  return match ? Number(match[1]) : null;
}

function parseStatus(status) {
  switch (status.toLowerCase()) {
    case "in corso": return "ongoing";
    case "finito": return "completed";
    case "in pausa": return "hiatus";
    case "cancellato": return "cancelled";
    default: return "unknown";
  }
}

function parseDate(value) {
  const match = value.match(/(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i);
  if (!match) return null;
  const months = {
    gennaio: "01", febbraio: "02", marzo: "03", aprile: "04", maggio: "05", giugno: "06",
    luglio: "07", agosto: "08", settembre: "09", ottobre: "10", novembre: "11", dicembre: "12",
  };
  const month = months[match[2].toLowerCase()];
  return month ? `${match[3]}-${month}-${match[1].padStart(2, "0")}T00:00:00+00:00` : null;
}

// Package adapter: the runtime injects fetch and HTML parsing.
export default function createExtension(runtime) {
  return createMangaWorld(runtime);
}
