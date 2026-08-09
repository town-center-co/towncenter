import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Next 16 convention: this file replaces `middleware.ts`, and the exported
// function is `proxy`. do not recreate a `middleware.ts`.

const LOGIN_PATH = "/login";

// this runs on the Edge runtime: nothing touching the database can be imported
// here, so `/signup` guards itself and decides on its own side. The Mollie
// webhook carries no session; the route authenticates by fetching the id back.
const PUBLIC_ROUTES = new Set<string>([
  LOGIN_PATH,
  "/signup",
  "/api/mollie/webhook",
]);

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  const isPublic = PUBLIC_ROUTES.has(pathname);

  if (session || isPublic) {
    return NextResponse.next();
  }

  const loginUrl = new URL(LOGIN_PATH, request.url);
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", `${pathname}${search}`);
  }

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // the extension branch matches `[^/]*`, never `.*`: with `.*` the rule
    // would waive authentication for any path at any depth ending in one.
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|icon\\.svg|[^/]*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf|txt|map)$).*)",
  ],
};
