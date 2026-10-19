// Edge middleware: the security layer the old node:http server did inline.
//  - gates pages and API behind a valid session cookie (login page and the
//    login/logout/me endpoints and the token-authed calendar feed are open);
//  - refuses cross-site mutations (Origin host must match Host);
//  - sets a Content-Security-Policy and the other security headers.
//
// The CSP allows 'self' + 'unsafe-inline' scripts because Next injects inline
// bootstrap scripts; everything else is locked to 'self'. (A nonce-based policy
// would be stricter but Next 16 doesn't reliably stamp its scripts here.)
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession } from "./app/lib/session.ts";

function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname === "/api/logout" ||
    pathname === "/api/me" ||
    pathname.startsWith("/calendar/")
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method;
  const dev = process.env.NODE_ENV !== "production";

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `connect-src 'self'`,
    `font-src 'self'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
  ].join("; ");

  const secure = req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:";
  const harden = (res: NextResponse): NextResponse => {
    res.headers.set("content-security-policy", csp);
    res.headers.set("x-content-type-options", "nosniff");
    res.headers.set("referrer-policy", "no-referrer");
    if (secure) res.headers.set("strict-transport-security", "max-age=31536000");
    return res;
  };
  const json = (status: number, body: unknown) => harden(NextResponse.json(body, { status }));

  // Cross-site mutations are refused: our cookie is SameSite=Strict, and a
  // foreign Origin on a write is rejected outright.
  if (method !== "GET" && method !== "HEAD" && pathname.startsWith("/api/")) {
    const origin = req.headers.get("origin");
    if (origin) {
      let originHost: string | undefined;
      try { originHost = new URL(origin).host; } catch { originHost = undefined; }
      if (originHost !== req.headers.get("host")) return json(403, { error: "Cross-site request refused." });
    }
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;

  // Signed-in users never need the login page.
  if (pathname === "/login" && (await isValidSession(token))) {
    return harden(NextResponse.redirect(new URL("/", req.url)));
  }

  if (!isPublic(pathname) && !(await isValidSession(token))) {
    if (pathname.startsWith("/api/")) return json(401, { error: "Please log in." });
    return harden(NextResponse.redirect(new URL("/login", req.url)));
  }

  return harden(NextResponse.next());
}

export const config = {
  // Run on everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
