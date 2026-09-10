/**
 * Route-level loading state.
 *
 * Shown while a server component waits on its queries. Some screens aggregate across a hundred
 * thousand activity rows, so this is a real wait rather than a formality. Skeletons match the
 * card-and-table layout of the pages they stand in for, to avoid the jolt of the page changing
 * shape as it arrives.
 */
function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-line/60 ${className}`} />;
}

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded border border-line bg-panel/40 p-3.5">
            <Shimmer className="h-2 w-20" />
            <Shimmer className="mt-2.5 h-6 w-14" />
            <Shimmer className="mt-2 h-2 w-28" />
          </div>
        ))}
      </section>

      <Shimmer className="h-3 w-40" />

      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded border border-line bg-panel/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <Shimmer className="h-3 w-3/4" />
                <Shimmer className="h-2 w-1/3" />
              </div>
              <Shimmer className="h-9 w-9 shrink-0 rounded" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((__, j) => (
                <div key={j} className="space-y-1.5">
                  <Shimmer className="h-2 w-14" />
                  <Shimmer className="h-3 w-10" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
