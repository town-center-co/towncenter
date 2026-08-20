// The shared shell for sign-in and sign-up: the form in a reading column on the
// left, what lies behind the gate on the right.
//
// The right half is a DRAWN world map, not a real one. Real tiles carry a
// mandatory attribution on a screen that has nothing to show but atmosphere,
// they would pull `maplibre-gl` and its worker onto the most public route of
// the product, and a map that fails to load leaves a grey rectangle with no
// error at all. It also carries NO FIGURES: the blue dots are cities, and a
// screen with no session can measure nothing.

import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ThemeToggle } from "@/components/ui";
import type { Locale } from "@/lib/types";

import { WorldMap } from "./WorldMap";
import townCentre from "./towncenter.png";

import styles from "./gate.module.css";

export type GateProps = {
  /** The heading. Visible text. */
  title: string;
  /** The line under the heading. It explains, it does not decorate. */
  subtitle: string;
  /** The form itself. */
  children: React.ReactNode;
  /** The footer: the switch to the other screen. */
  toggle?: React.ReactNode;
  /** Signed-out funnel locale, before an account preference exists. */
  locale?: Locale;
};

export async function Gate({ title, subtitle, children, toggle, locale }: GateProps) {
  const t = locale
    ? await getTranslations({ locale, namespace: "Gate" })
    : await getTranslations("Gate");

  return (
    <main className={styles.frame}>
      <div className={styles.gate}>
        <div className={styles.column}>
          <div className={styles.top}>
            <Link href="/login" className={styles.brand} aria-label="Towncenter">
              <BrandMark />
              Towncenter
            </Link>
            <ThemeToggle />
          </div>

          <div className={styles.center}>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.subtitle}>{subtitle}</p>
            {children}
            {toggle ? <p className={styles.toggle}>{toggle}</p> : null}
          </div>

          <div className={styles.footerRule}>
            <span>{t("tagline")}</span>
          </div>
        </div>

        <div className={styles.plan} aria-hidden="true">
          <div className={styles.planFrame}>
            <WorldMap />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The town centre itself: the building the product is named after.
 *
 * It replaces the drawn glyph that stood here, and the swap carries a floor.
 * An inked isometric drawing reduced by a factor of fifty is a smudge — the
 * contact sheet put its limit at roughly 48px, below which the three roofs
 * merge into one blue mass. The mark is therefore sized in the STYLESHEET at
 * 44px and must not be shrunk back towards the 18px the glyph used to occupy:
 * at that size the product would be showing a stain where its name is.
 *
 * `priority` is deliberate. This is the largest element above the fold on the
 * most public route of the product, so it is the Largest Contentful Paint;
 * left to lazy-load it would be fetched after the fonts and push LCP out by a
 * round trip on the one screen a stranger sees first.
 *
 * The intrinsic size travels with the static import, so Next reserves the box
 * and nothing shifts when the file lands.
 */
function BrandMark() {
  return (
    <Image
      className={styles.brandMark}
      src={townCentre}
      alt=""
      priority
      placeholder="blur"
    />
  );
}
