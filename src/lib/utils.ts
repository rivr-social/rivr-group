/**
 * Shared UI utility helpers for formatting, display fallbacks, and chapter scoping.
 *
 * Purpose:
 * - Centralize common display transformations used by client components.
 * - Keep date/time formatting, class composition, and chapter lookup consistent.
 *
 * Key exports:
 * - `cn` for class name merging with Tailwind conflict resolution.
 * - Formatting helpers (`formatDate`, `formatTime`, `truncateText`, `getInitials`).
 * - Chapter helpers (`getChapter`, `getChapterName`, `filterByChapter`).
 *
 * Dependencies:
 * - `clsx` and `tailwind-merge` for class list normalization.
 * - `Chapter` type from `./types` for chapter lookups.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Chapter } from "./types";

/**
 * Merges conditional class inputs and resolves Tailwind utility conflicts.
 *
 * @param {...ClassValue[]} inputs - Class names, arrays, and conditional class objects.
 * @returns {string} A deduplicated Tailwind-safe class string.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * cn("p-2", isActive && "text-green-600", "p-4"); // "text-green-600 p-4"
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats a date-like value for US English date display.
 *
 * @param {Date | string} date - Date object or parseable date string.
 * @param {Intl.DateTimeFormatOptions} [options] - Optional formatter overrides.
 * @returns {string} Locale-formatted date text.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * formatDate("2026-02-23T10:00:00Z"); // "Feb 23, 2026" (locale-dependent)
 */
export function formatDate(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
  // Accept both Date and serialized API timestamps used across app state.
  const dateObj = typeof date === "string" ? new Date(date) : date;

  const defaultOptions: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };

  return dateObj.toLocaleDateString("en-US", options || defaultOptions);
}

/**
 * Formats a date-like value for US English time display.
 *
 * @param {Date | string} date - Date object or parseable date string.
 * @param {Intl.DateTimeFormatOptions} [options] - Optional formatter overrides.
 * @returns {string} Locale-formatted time text.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * formatTime("2026-02-23T22:15:00Z"); // "10:15 PM" (locale-dependent)
 */
export function formatTime(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
  // Keep parsing behavior aligned with formatDate to avoid inconsistent UI render paths.
  const dateObj = typeof date === "string" ? new Date(date) : date;

  const defaultOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };

  return dateObj.toLocaleTimeString("en-US", options || defaultOptions);
}

/**
 * Finds a chapter record by identifier.
 *
 * @param {string} chapterId - Canonical chapter identifier.
 * @param {Chapter[]} chapters - Chapter list to search. Defaults to `[]`.
 * @returns {Chapter | undefined} Matching chapter or `undefined` if not found.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * const chapter = getChapter("chesapeake", chapters);
 */
export function getChapter(chapterId: string, chapters: Chapter[] = []): Chapter | undefined {
  return chapters.find((chapter) => chapter.id === chapterId);
}

/**
 * Resolves a chapter name from an ID with a safe fallback.
 *
 * @param {string} chapterId - Canonical chapter identifier.
 * @param {Chapter[]} chapters - Chapter list to search. Defaults to `[]`.
 * @returns {string} Chapter name, or the original ID when no chapter is found.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * getChapterName("all", chapters); // "all" when not mapped
 */
export function getChapterName(chapterId: string, chapters: Chapter[] = []): string {
  const chapter = getChapter(chapterId, chapters);
  // Preserve the original identifier so callers always have a stable label.
  return chapter ? chapter.name : chapterId;
}

/**
 * Truncates text and appends an ellipsis when above a maximum length.
 *
 * @param {string} text - Input text.
 * @param {number} maxLength - Maximum character length before truncation.
 * @returns {string} Original text or truncated text with trailing `...`.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * truncateText("long body", 4); // "long..."
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

/**
 * Builds avatar initials from a person's display name.
 *
 * @param {string} name - Person or entity name.
 * @returns {string} Two-letter initials, or `??` when no input is provided.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * getInitials("Ada Lovelace"); // "AL"
 */
export function getInitials(name: string): string {
  if (!name) return "??";

  const parts = name.split(" ");
  if (parts.length === 1) return name.substring(0, 2).toUpperCase();

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Filters items using chapter tags and a selected chapter scope.
 *
 * @template T
 * @param {T[]} items - List of items containing `chapterTags`.
 * @param {string} selectedChapter - Chapter ID or `"all"` for no filtering.
 * @returns {T[]} Items that belong to the selected chapter.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * filterByChapter(posts, "all"); // returns full list
 */
export function filterByChapter<T extends { chapterTags: string[] }>(items: T[], selectedChapter: string): T[] {
  // "all" is a UI-level sentinel meaning "no chapter constraint".
  if (selectedChapter === "all") return items;
  return items.filter((item) => item.chapterTags.includes(selectedChapter));
}
