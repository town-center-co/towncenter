import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import Script from "next/script";

import { Toaster } from "@/components/ui/sonner";
import { THEME_SCRIPT, DEFAULT_THEME } from "@/components/ui/theme";

import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

// The product's DEFAULT typeface: body text, labels, tags and every number.
// Being monospaced it makes `tnum` redundant, but the `.tnum` rule in
// globals.css stays as cover for the day a typeface token changes.
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--typeface-mono",
  display: "swap",
});

// Titles, sentences and verbatim facts. The italic is loaded: the system uses
// it for everything that is SAID rather than measured.
const serif = Source_Serif_4({
  subsets: ["latin"],
  weight: "variable",
  style: ["normal", "italic"],
  variable: "--typeface-serif",
  display: "swap",
});

/**
 * The absolute origin social images are resolved against.
 *
 * It CANNOT be a constant. Every instance of an AGPL, self-hostable product
 * lives on its own domain, and `opengraph-image.png` is served as a relative
 * path: without an origin Next resolves it against `http://localhost:3000`,
 * warns once at build time, and ships an `og:image` no crawler can fetch. The
 * card then renders as a bare link — the failure is silent everywhere except
 * in a preview debugger.
 *
 * Hence `APP_URL`, set once per deployment to the origin the instance is
 * actually served from. Left unset it falls back to localhost, which is right
 * in development and wrong everywhere else.
 */
function socialOrigin(): URL {
  return new URL(process.env.APP_URL ?? "http://localhost:3000");
}

const DESCRIPTION = "Neighbourhood shop prospecting, street by street.";

export const metadata: Metadata = {
  metadataBase: socialOrigin(),
  title: "Towncenter",
  description: DESCRIPTION,
  // No `images` key on either block: `app/opengraph-image.png` is a file
  // convention, and Next fills both from it. Naming an image here would
  // OVERRIDE the file and pin a path that the build hashes.
  openGraph: {
    type: "website",
    siteName: "Towncenter",
    title: "Towncenter",
    description: DESCRIPTION,
  },
  // `resolveTwitter()` returns null when this block is absent — the card type
  // is never inferred from the presence of an Open Graph image. Without it X
  // falls back to a small square thumbnail and the 1200x630 image is wasted.
  twitter: {
    card: "summary_large_image",
    title: "Towncenter",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  // the tool is used in the street, on a phone: zoom stays possible, so
  // maximumScale is not set and must not be
  width: "device-width",
  initialScale: 1,
  // This is the light fallback used before the system preference is resolved.
  themeColor: "#edeff2",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();

  return (
    // `data-theme` is an ASCII key: `dark` / `light`. Light is the server fallback.
    <html
      lang={locale}
      data-theme={DEFAULT_THEME}
      className={`${mono.variable} ${serif.variable}`}
      // The script below fixes `data-theme` before paint, so the server-rendered
      // attribute and the one React sees can differ. Without this exemption
      // React rewrites the attribute and the flash comes back on every load.
      suppressHydrationWarning
    >
      <head>
        {/* Resolves the saved or system theme BEFORE first paint. */}
        <Script
          id="theme-script"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
      </head>
      {/* Two slow halos, above the paper gradient and UNDER all content, so the
          glass has something to refract. aria-hidden: this is light, not
          information. */}
      <body>
        <div className="rigging" aria-hidden="true">
          <i className="rigging__l1" />
          <i className="rigging__l2" />
        </div>
        <NextIntlClientProvider>
          {children}
          <Toaster position="bottom-right" />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
