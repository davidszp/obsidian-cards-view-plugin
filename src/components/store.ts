import {
  type App,
  type CachedMetadata,
  getAllTags,
  ItemView,
  MetadataCache,
  TFile,
} from "obsidian";
import { derived, get, writable } from "svelte/store";
import type { CardsViewSettings } from "../settings";
import generateFilter from "../search/search";

export enum Sort {
  Created = "ctime",
  Modified = "mtime",
}

/**
 * Core stores for obsidian data (set from main.ts)
 */
export const app = writable<App>();
export const view = writable<ItemView>();
export const appCache = writable<MetadataCache>();
export const files = writable<TFile[]>([]);

/**
 * User input stores
 */
export const settings = writable<CardsViewSettings>();
export const sort = writable<Sort>(Sort.Modified);
export const searchQuery = writable<string>("");
export const searchCaseSensitive = writable(false);

/**
 * Derived: sorted files with pinned files first
 */
const pinnedFiles = derived(settings, ($settings) => $settings?.pinnedFiles ?? []);
const sortedFiles = derived(
  [sort, files, pinnedFiles],
  ([$sort, $files, $pinnedFiles]) =>
    [...$files].sort(
      (a: TFile, b: TFile) =>
        (($pinnedFiles?.includes(b.path) ? 1 : 0) -
          ($pinnedFiles?.includes(a.path) ? 1 : 0)) ||
        b.stat[$sort] - a.stat[$sort],
    ),
  [] as TFile[],
);

/**
 * Derived: the complete search query (base + user input)
 */
const baseQuery = derived(settings, ($settings) => $settings?.baseQuery ?? "");
const fullQuery = derived(
  [baseQuery, searchQuery],
  ([$baseQuery, $searchQuery]) => {
    const base = $baseQuery?.trim() ?? "";
    const search = $searchQuery?.trim() ?? "";
    return base ? (search ? `${base} ${search}` : base) : search;
  },
);

// =============================================================================
// SEARCH STATE MACHINE
// =============================================================================

interface SearchState {
  // Which files match the current filter (null = no filter, show all)
  matchingFiles: Set<TFile> | null;
  // Progress 0-1, where 1 = complete
  progress: number;
  // Current search ID (for cancellation)
  searchId: number;
}

const searchState = writable<SearchState>({
  matchingFiles: null,
  progress: 1,
  searchId: 0,
});

// Cache: query+mtime -> match result
let filterCache: Map<string, boolean> = new Map();
let lastQueryForCache = "";

/**
 * Main search function - processes all files against the current filter
 */
async function runSearch() {
  const $fullQuery = get(fullQuery);
  const $sortedFiles = get(sortedFiles);
  const $appCache = get(appCache);
  const $app = get(app);
  const $caseSensitive = get(searchCaseSensitive);

  // Get new search ID
  const currentState = get(searchState);
  const thisSearchId = currentState.searchId + 1;

  // Clear cache if query changed
  if ($fullQuery !== lastQueryForCache) {
    filterCache = new Map();
    lastQueryForCache = $fullQuery;
  }

  // No query = show all files
  if (!$fullQuery) {
    searchState.set({
      matchingFiles: null,
      progress: 1,
      searchId: thisSearchId,
    });
    return;
  }

  // Initialize: no files match yet, progress 0
  searchState.set({
    matchingFiles: new Set(),
    progress: 0,
    searchId: thisSearchId,
  });

  // Check if this search is still current
  const isStale = () => get(searchState).searchId !== thisSearchId;

  // Guard: app not ready
  if (!$app || !$appCache) {
    return;
  }

  // Generate filter function
  let filterFn: Awaited<ReturnType<typeof generateFilter>>;
  try {
    filterFn = generateFilter($fullQuery);
  } catch (e) {
    console.error("[CardsView] Error parsing query:", e);
    searchState.update((s) => ({ ...s, progress: 1 }));
    return;
  }

  const matches = new Set<TFile>();
  const cacheKey = (f: TFile) => f.path + "|" + f.stat.mtime;

  for (let i = 0; i < $sortedFiles.length; i++) {
    if (isStale()) return;

    const file = $sortedFiles[i];
    const key = cacheKey(file);

    // Check cache first
    const cached = filterCache.get(key);
    if (cached !== undefined) {
      if (cached) matches.add(file);
    } else {
      // Read file and evaluate filter
      let content = "";
      let tags: string[] = [];
      let frontmatter: Record<string, unknown> | undefined;

      try {
        content = await file.vault.cachedRead(file);
        const cache = $appCache.getFileCache(file);
        tags = (getAllTags(cache as CachedMetadata) || []).map((t) =>
          t.replace(/^#/, ""),
        );
        await $app.fileManager.processFrontMatter(file, (fm) => {
          frontmatter = fm;
        });
      } catch (e) {
        console.error("[CardsView] Error reading file:", file.path, e);
      }

      if (isStale()) return;

      let match = false;
      try {
        match = await filterFn({
          file,
          content,
          tags,
          frontmatter,
          caseSensitive: $caseSensitive,
        });
      } catch (e) {
        console.error("[CardsView] Error filtering file:", file.path, e);
      }

      filterCache.set(key, match);
      if (match) matches.add(file);
    }

    // Update progress periodically (every 20 files or at end)
    if (i % 20 === 0 || i === $sortedFiles.length - 1) {
      if (isStale()) return;
      searchState.update((s) => ({
        ...s,
        matchingFiles: new Set(matches),
        progress: (i + 1) / $sortedFiles.length,
      }));
    }
  }
}

// Debounce search to avoid rapid re-runs
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
function triggerSearch() {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    runSearch();
  }, 50);
}

// Subscribe to changes that should trigger a search
fullQuery.subscribe(triggerSearch);
files.subscribe(triggerSearch);
searchCaseSensitive.subscribe(triggerSearch);

// =============================================================================
// DISPLAY STATE
// =============================================================================

/**
 * Filtered files based on search state
 */
const filteredFiles = derived(
  [sortedFiles, searchState],
  ([$sortedFiles, $searchState]) => {
    if ($searchState.matchingFiles === null) {
      return $sortedFiles;
    }
    return $sortedFiles.filter((f) => $searchState.matchingFiles!.has(f));
  },
);

/**
 * Count of matching notes
 */
export const matchingNotesCount = derived(filteredFiles, ($filtered) => $filtered.length);

/**
 * Loading state (0-1 progress)
 */
export const searchResultLoadingState = derived(
  searchState,
  ($state) => $state.progress,
);

/**
 * Displayed files (for infinite scroll)
 */
export const displayedCount = writable(50);
export const displayedFiles = derived(
  [filteredFiles, displayedCount],
  ([$filtered, $count]) => $filtered.slice(0, $count),
);

/**
 * Increase displayed count (for infinite scroll)
 */
export function loadMore(count: number = 50) {
  displayedCount.update((c) => c + count);
}

/**
 * Reset displayed count when filter changes
 */
filteredFiles.subscribe(() => {
  displayedCount.set(50);
});

// =============================================================================
// SUMMARY CACHE (Foundation for Ollama feature)
// =============================================================================

export interface CardSummary {
  text: string;
  wordCount: number;
  generatedAt: number;
}

// In-memory cache of summaries (frontmatter is source of truth)
export const summaryCache = writable<Map<string, CardSummary>>(new Map());

/**
 * Get summary for a file from cache or frontmatter
 */
export function getSummary(file: TFile): CardSummary | null {
  const cache = get(summaryCache);
  return cache.get(file.path) ?? null;
}

/**
 * Store summary in cache (and optionally in frontmatter via separate function)
 */
export function cacheSummary(file: TFile, summary: CardSummary) {
  summaryCache.update((cache) => {
    cache.set(file.path, summary);
    return cache;
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  files,
  sort,
  searchQuery,
  searchCaseSensitive,
  displayedCount,
  displayedFiles,
  app,
  view,
  settings,
  appCache,
  loadMore,
};
