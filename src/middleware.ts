/**
 * Password gate, applied before any page renders.
 *
 * Middleware rather than a check inside each page, because a check inside each page is a check
 * someone forgets to add to the next one. Here a new route is protected by existing.
 *
 * With no APP_PASSWORD set this does nothing at all, which keeps local use frictionless — the
 * gate only matters once the app is reachable from somewhere you do not control.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, isValidSession, SESSION_COOKIE } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();

  const { pathname, search } = request.nextUrl;

  // The login page itself, and the cron endpoint, which carries its own bearer token and is
  // called by a scheduler that has no cookie to present.
  if (pathname === "/login" || pathname.startsWith("/api/cron")) return NextResponse.next();

  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  // Carry the destination so signing in lands where you were going.
  login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own assets. Listing exclusions rather than inclusions means a new
  // route is covered by default instead of being quietly public until someone notices.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
