/**
 * Global MDX component map for the `/docs` site.
 *
 * `@next/mdx` (App Router) resolves this file automatically: every `.md`/`.mdx`
 * route — the hand-authored wiki AND the machine-generated API reference —
 * renders through these components. That means generated pages can reference
 * `<AuthBadge>`, `<MethodBadge>`, `<Callout>` by name with NO per-file import,
 * and every markdown element gets consistent, theme-aware typography.
 *
 * Styling reuses the app's design tokens (hsl(var(--*)) from globals.css) so the
 * docs read as part of RIVR in both light and dark, not a bolted-on theme.
 */
import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const AUTH_BADGE_STYLES: Record<string, string> = {
  session: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  token: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  "peer-signature": "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  public: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
};

const AUTH_BADGE_LABELS: Record<string, string> = {
  session: "Session",
  token: "MCP Token",
  "peer-signature": "Peer Signature",
  public: "Public",
};

/**
 * Auth affordance badge — derived from a tool's `enabledFor` or a route's
 * public flag. Used inline in prose and in generated reference pages.
 */
export function AuthBadge({ mode }: { mode: string }) {
  const key = mode.toLowerCase();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        AUTH_BADGE_STYLES[key] ?? "bg-muted text-muted-foreground border-border",
      )}
    >
      {AUTH_BADGE_LABELS[key] ?? mode}
    </span>
  );
}

const METHOD_STYLES: Record<string, string> = {
  GET: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  POST: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  PUT: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  PATCH: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  DELETE: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
};

/** HTTP method chip for the REST reference. */
export function MethodBadge({ method }: { method: string }) {
  const key = method.toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs font-semibold",
        METHOD_STYLES[key] ?? "bg-muted text-muted-foreground border-border",
      )}
    >
      {key}
    </span>
  );
}

const CALLOUT_STYLES: Record<string, string> = {
  note: "border-sky-500/40 bg-sky-500/10",
  tip: "border-emerald-500/40 bg-emerald-500/10",
  warning: "border-amber-500/40 bg-amber-500/10",
  danger: "border-rose-500/40 bg-rose-500/10",
  todo: "border-violet-500/40 bg-violet-500/10",
};

/** Emphasis box for the wiki + prose reference sections. */
export function Callout({
  type = "note",
  title,
  children,
}: {
  type?: "note" | "tip" | "warning" | "danger" | "todo";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("my-4 rounded-lg border px-4 py-3 text-sm", CALLOUT_STYLES[type] ?? CALLOUT_STYLES.note)}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div className="[&>p]:my-1 text-foreground/90">{children}</div>
    </div>
  );
}

/**
 * Base HTML element overrides + the custom doc components. Passed to
 * `MDXProvider` implicitly by @next/mdx via this exported hook.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => (
      <h1 className="mt-2 mb-4 scroll-mt-24 text-3xl font-bold tracking-tight text-foreground">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-10 mb-3 scroll-mt-24 border-b border-border/60 pb-1.5 text-2xl font-semibold tracking-tight text-foreground">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-6 mb-2 scroll-mt-24 text-lg font-semibold text-foreground">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mt-4 mb-2 scroll-mt-24 text-base font-semibold text-foreground/90">{children}</h4>
    ),
    p: ({ children }) => <p className="my-3 leading-7 text-foreground/85">{children}</p>,
    ul: ({ children }) => <ul className="my-3 ml-6 list-disc space-y-1.5 text-foreground/85">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 ml-6 list-decimal space-y-1.5 text-foreground/85">{children}</ol>,
    li: ({ children }) => <li className="leading-7">{children}</li>,
    a: ({ href, children }) => {
      const target = href ?? "#";
      const isInternal = target.startsWith("/") || target.startsWith("#");
      if (isInternal) {
        return (
          <Link href={target} className="font-medium text-primary underline underline-offset-4 hover:opacity-80">
            {children}
          </Link>
        );
      }
      return (
        <a
          href={target}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
        >
          {children}
        </a>
      );
    },
    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-4 border-primary/40 bg-muted/40 py-1 pl-4 text-foreground/80 italic">
        {children}
      </blockquote>
    ),
    code: ({ children }) => (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>
    ),
    pre: ({ children }) => (
      <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-muted/60 p-4 text-sm [&>code]:bg-transparent [&>code]:p-0">
        {children}
      </pre>
    ),
    hr: () => <hr className="my-8 border-border/60" />,
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    th: ({ children }) => (
      <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border-b border-border/50 px-3 py-2 align-top text-foreground/85">{children}</td>
    ),
    AuthBadge,
    MethodBadge,
    Callout,
    ...components,
  };
}
