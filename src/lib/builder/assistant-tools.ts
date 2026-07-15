/**
 * @fileoverview Workspace-jailed tool surface for the BUILDER ASSISTANT — the
 * agentic edit loop that lets the group/site assistant read, write, and
 * publish the site workspace from inside `/builder` ("edit and deploy from
 * right there in builder").
 *
 * Pure by construction: the factory closes over an in-memory copy of the
 * workspace file map; `publish` is an injected callback (the route binds it to
 * the owner-gated service publish). NO db/model imports — hermetically
 * unit-testable.
 *
 * Jail rules (every tool input passes {@link validateSitePath}):
 *   - relative, normalized paths only (no leading `/`, no `.`/`..` segments)
 *   - extension allowlist = the file types a generated site contains
 *   - per-file and whole-workspace size caps
 */
import type { NativeChatToolSpec } from "@/lib/ai/native-chat";
import type { SiteFiles } from "@/lib/builder/site-model";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_WORKSPACE_FILES = 60;
export const MAX_FILE_BYTES = 400_000;
export const MAX_WORKSPACE_BYTES = 2_000_000;

/** Extensions a generated static site may contain — the write allowlist. */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "html",
  "css",
  "js",
  "json",
  "svg",
  "txt",
  "xml",
]);

const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

/**
 * Validates a workspace-relative path: non-empty slash-separated segments that
 * never start with a dot (kills `.`/`..`/dotfiles), with an allowlisted
 * extension. Returns an error string, or null when the path is safe.
 */
export function validateSitePath(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "A file path is required.";
  if (path.length > 200) return "That path is too long.";
  if (path.startsWith("/") || path.includes("\\")) {
    return "Paths are workspace-relative (no leading slash or backslashes).";
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      return `Invalid path segment "${segment}" — segments must not start with a dot and may only contain letters, digits, dot, dash, underscore.`;
    }
  }
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!path.includes(".") || !ALLOWED_EXTENSIONS.has(ext)) {
    return `Only these file types are allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Toolset factory
// ---------------------------------------------------------------------------

export interface BuilderToolsetResult {
  tools: NativeChatToolSpec[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  /** The (possibly mutated) workspace after the loop. */
  getFiles: () => SiteFiles;
  /** Paths written/deleted during the loop, in call order (UI activity trail). */
  getChangedPaths: () => string[];
  /** True once publish_site ran successfully. */
  wasPublished: () => boolean;
}

/**
 * Builds the assistant's builder toolset over a WORKING COPY of `initialFiles`.
 *
 * @param initialFiles The workspace to edit (the route loads the live/base
 *   snapshot; the caller's original map is never mutated).
 * @param publish Owner-gated callback that persists the current working copy
 *   as the new published version. Injected so this module stays pure.
 */
export function makeBuilderToolset(
  initialFiles: SiteFiles,
  publish: (files: SiteFiles) => Promise<{ versionNumber: number }>,
): BuilderToolsetResult {
  const files: SiteFiles = { ...initialFiles };
  const changed: string[] = [];
  let published = false;

  const totalBytes = () =>
    Object.values(files).reduce((sum, body) => sum + Buffer.byteLength(body, "utf8"), 0);

  const tools: NativeChatToolSpec[] = [
    {
      name: "list_files",
      description:
        "List every file in the site workspace with its size in bytes. Call this first to see what exists.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "read_file",
      description: "Read a workspace file's full contents.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path, e.g. index.html" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a workspace file with the given full contents. Write the COMPLETE file — partial contents replace the whole file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "The complete new file contents." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_file",
      description: "Delete a workspace file. index.html cannot be deleted.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "publish_site",
      description:
        "Publish the CURRENT workspace as the new live site version. Only call this when the operator explicitly asked to publish/deploy.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "list_files":
        return Object.keys(files)
          .sort()
          .map((path) => ({ path, bytes: Buffer.byteLength(files[path], "utf8") }));

      case "read_file": {
        const pathError = validateSitePath(input.path);
        if (pathError) return { error: pathError };
        const body = files[input.path as string];
        return typeof body === "string" ? body : { error: "No such file." };
      }

      case "write_file": {
        const pathError = validateSitePath(input.path);
        if (pathError) return { error: pathError };
        const path = input.path as string;
        const content = input.content;
        if (typeof content !== "string") return { error: "content must be a string." };
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          return { error: `File too large (max ${MAX_FILE_BYTES} bytes).` };
        }
        const isNew = !(path in files);
        if (isNew && Object.keys(files).length >= MAX_WORKSPACE_FILES) {
          return { error: `Workspace is at the ${MAX_WORKSPACE_FILES}-file limit.` };
        }
        const nextTotal =
          totalBytes() -
          (isNew ? 0 : Buffer.byteLength(files[path], "utf8")) +
          Buffer.byteLength(content, "utf8");
        if (nextTotal > MAX_WORKSPACE_BYTES) {
          return { error: `Workspace would exceed ${MAX_WORKSPACE_BYTES} bytes.` };
        }
        files[path] = content;
        changed.push(path);
        return { ok: true, path, bytes: Buffer.byteLength(content, "utf8") };
      }

      case "delete_file": {
        const pathError = validateSitePath(input.path);
        if (pathError) return { error: pathError };
        const path = input.path as string;
        if (path === "index.html") return { error: "index.html cannot be deleted." };
        if (!(path in files)) return { error: "No such file." };
        delete files[path];
        changed.push(path);
        return { ok: true, deleted: path };
      }

      case "publish_site": {
        if (Object.keys(files).length === 0) {
          return { error: "Nothing to publish — the workspace is empty." };
        }
        const result = await publish({ ...files });
        published = true;
        return { ok: true, versionNumber: result.versionNumber };
      }

      default:
        return { error: `Unknown tool "${name}".` };
    }
  }

  return {
    tools,
    executeTool,
    getFiles: () => ({ ...files }),
    getChangedPaths: () => [...changed],
    wasPublished: () => published,
  };
}
