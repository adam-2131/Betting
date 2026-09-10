"use client";

/**
 * Route-level error boundary.
 *
 * Every page here is `force-dynamic` and queries Postgres directly, and the database is started
 * by hand in a separate terminal (`npm run db:local`). Forgetting that is by far the most likely
 * way this application breaks, so the boundary tries to recognise a connection failure and say so
 * rather than showing a stack trace and leaving the cause to be guessed at.
 */
import { useEffect } from "react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/primitives";

/** Prisma's connection failures are recognisable by code; the message text is a fallback. */
function looksLikeDatabaseDown(error: Error & { digest?: string }): boolean {
  const haystack = `${error.name} ${error.message}`.toLowerCase();
  return (
    haystack.includes("p1001") ||
    haystack.includes("p1000") ||
    haystack.includes("p1017") ||
    haystack.includes("can't reach database") ||
    haystack.includes("cannot reach database") ||
    haystack.includes("econnrefused") ||
    haystack.includes("connection terminated") ||
    haystack.includes("server has closed the connection")
  );
}

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[polyalpha] route error:", error);
  }, [error]);

  const databaseDown = looksLikeDatabaseDown(error);

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-8">
      <Card className="border-negative/30">
        <CardHeader
          title={databaseDown ? "The database is not reachable" : "This page failed to load"}
          subtitle={
            databaseDown
              ? "PolyAlpha reads every screen straight from Postgres, so nothing renders without it."
              : "Something threw while rendering. The details are below and in the terminal."
          }
        />

        {databaseDown ? (
          <div className="space-y-3 text-2xs leading-5 text-muted">
            <p>
              The local database runs as its own process and is not started by{" "}
              <code className="text-fg">npm run dev</code>. In a separate terminal:
            </p>
            <pre className="overflow-x-auto rounded border border-line bg-bg/60 p-2.5 font-mono text-2xs text-fg">
              npm run db:local
            </pre>
            <p>
              Leave that running, then reload this page. If it is already running, check that
              nothing else has taken port 5432 and that <code className="text-fg">DATABASE_URL</code>{" "}
              in <code className="text-fg">.env</code> still points at it.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-line bg-bg/60 p-2.5 font-mono text-2xs leading-4 text-negative">
              {error.message || "No message was attached to the error."}
            </pre>
            {error.digest ? (
              <p className="text-2xs text-dim">Digest {error.digest}</p>
            ) : null}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={reset}
            className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-2xs font-medium uppercase tracking-caps text-accent hover:bg-accent/20"
          >
            Try again
          </button>
          <Link
            href="/settings"
            className="rounded border border-line px-3 py-1.5 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
          >
            Settings
          </Link>
        </div>
      </Card>

      <p className="text-2xs leading-4 text-dim">
        Nothing was written and no trade was affected — PolyAlpha only ever reads. An error here
        means a screen could not be drawn, never that an action was half-completed.
      </p>
    </div>
  );
}
