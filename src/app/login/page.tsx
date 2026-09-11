import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { authEnabled, isValidSession, SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { Card } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

/**
 * Sign-in.
 *
 * The form posts to a server action rather than an API route so the password is never in a URL,
 * never in browser history and never in a server access log.
 */
async function signIn(formData: FormData) {
  "use server";

  const password = process.env.APP_PASSWORD;
  const submitted = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!authEnabled(password) || submitted !== password) {
    // Only ever a redirect back with a flag. Saying whether the password was close, or how long
    // it should be, tells an attacker more than it helps you.
    redirect(`/login?error=1${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, await sessionToken(password as string), {
    httpOnly: true,
    sameSite: "lax",
    // Only over HTTPS in production. Left off in development so it works over plain localhost.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });

  // Relative paths only. An absolute URL here would turn the login form into an open redirect.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  // Nothing to sign in to if no password is configured, and nothing to do if already signed in.
  if (!authEnabled()) redirect("/");
  const store = await cookies();
  if (await isValidSession(store.get(SESSION_COOKIE)?.value)) redirect(params.next ?? "/");

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-sm items-center">
      <Card className="w-full">
        <h1 className="text-sm font-medium text-fg">
          Poly<span className="text-accent">Alpha</span>
        </h1>
        <p className="mt-1 text-2xs leading-4 text-muted">
          This instance is private. Enter the password to continue.
        </p>

        <form action={signIn} className="mt-4 space-y-3">
          <input type="hidden" name="next" value={params.next ?? "/"} />
          <input
            name="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            className="w-full rounded border border-line bg-elevated px-3 py-2 text-sm text-fg outline-none focus:border-accent/50"
            placeholder="Password"
          />
          {params.error ? (
            <p className="text-2xs text-negative">That password is not right.</p>
          ) : null}
          <button
            type="submit"
            className="w-full rounded border border-accent/40 bg-accent/10 px-3 py-2 text-2xs font-medium uppercase tracking-caps text-accent transition-colors hover:border-accent/60 hover:bg-accent/20"
          >
            Sign in
          </button>
        </form>

        <p className="mt-4 border-t border-line pt-3 text-2xs leading-4 text-dim">
          PolyAlpha holds no wallet, no key and no Polymarket credential, so this password protects
          your betting record rather than your money. Over plain HTTP it is sent in the clear — put
          a tunnel in front of the app if it is reachable from the open internet. DEPLOY.md covers
          two free ways to do that.
        </p>
      </Card>
    </div>
  );
}
