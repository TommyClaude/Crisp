import { NextRequest, NextResponse } from "next/server";

/**
 * HTTP Basic Auth for the whole admin tool (pages + API).
 *
 * Credentials come from BASIC_AUTH_USER / BASIC_AUTH_PASSWORD. When they are
 * not configured the app only runs in development (with a console warning);
 * in production every request is rejected so the archive is never exposed
 * unauthenticated by accident.
 */

function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

function unauthorized(message = "Authentication required"): NextResponse {
  return new NextResponse(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Crisp Archive", charset="UTF-8"' },
  });
}

export function middleware(request: NextRequest): NextResponse {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[auth] BASIC_AUTH_USER/BASIC_AUTH_PASSWORD not set — running open (development only)."
      );
      return NextResponse.next();
    }
    return new NextResponse(
      "Server misconfigured: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are required in production.",
      { status: 503 }
    );
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized("Malformed credentials");
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return unauthorized("Malformed credentials");
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  const userOk = timingSafeEqual(user, expectedUser);
  const passwordOk = timingSafeEqual(password, expectedPassword);
  if (!userOk || !passwordOk) return unauthorized("Invalid credentials");

  return NextResponse.next();
}

export const config = {
  // Protect everything except Next.js internals and static assets
  // (icon.svg is the app favicon served from src/app/icon.svg).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
