"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BadgeEuro,
  Building2,
  CalendarCheck2,
  Check,
  CheckCircle2,
  Clock3,
  Crosshair,
  Euro,
  Gauge,
  MapPinned,
  Search,
  Target,
  TrendingUp,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import townCentre from "@/components/gate/towncenter.png";
import { Button, ThemeToggle } from "@/components/ui";

import styles from "./fit.module.css";

type Branch = "starting" | "established";
type Screen =
  | "intro"
  | "question"
  | "analysis"
  | "result"
  | "goal"
  | "rhythm"
  | "plan"
  | "paywall"
  | "mismatch";
type MismatchReason = "outside" | "notReady";
type PreQuestionKey =
  | "stage"
  | "service"
  | "audience"
  | "location"
  | "startingReadiness"
  | "startingBlocker"
  | "establishedSource"
  | "establishedBottleneck";

type FitFunnelProps = {
  initialStep?: string;
  price: number;
  harvestedTargets: number;
  enrichments: number;
  siteAudits: number;
  areaKm2: number;
  zoneAreaKm2: number;
};

type ChoiceItem = { key: string; Icon: LucideIcon };
type PreQuestion = {
  key: PreQuestionKey;
  Icon: LucideIcon;
  options: readonly ChoiceItem[];
};

const PRE_QUESTIONS: Record<PreQuestionKey, PreQuestion> = {
  stage: {
    key: "stage",
    Icon: Gauge,
    options: [
      { key: "preparing", Icon: CalendarCheck2 },
      { key: "firstClients", Icon: Target },
      { key: "established", Icon: TrendingUp },
    ],
  },
  service: {
    key: "service",
    Icon: Building2,
    options: [
      { key: "websites", Icon: Building2 },
      { key: "redesigns", Icon: Gauge },
      { key: "maintenance", Icon: CalendarCheck2 },
      { key: "broader", Icon: WalletCards },
      { key: "undecided", Icon: Search },
    ],
  },
  audience: {
    key: "audience",
    Icon: Target,
    options: [
      { key: "shops", Icon: MapPinned },
      { key: "professionals", Icon: Building2 },
      { key: "trades", Icon: Gauge },
      { key: "companies", Icon: Target },
      { key: "exploring", Icon: Search },
    ],
  },
  location: {
    key: "location",
    Icon: MapPinned,
    options: [
      { key: "france", Icon: MapPinned },
      { key: "mixed", Icon: Crosshair },
      { key: "outside", Icon: ArrowRight },
    ],
  },
  startingReadiness: {
    key: "startingReadiness",
    Icon: CheckCircle2,
    options: [
      { key: "independent", Icon: CheckCircle2 },
      { key: "support", Icon: CalendarCheck2 },
      { key: "practice", Icon: Gauge },
      { key: "unclear", Icon: Search },
    ],
  },
  startingBlocker: {
    key: "startingBlocker",
    Icon: Target,
    options: [
      { key: "prospects", Icon: Search },
      { key: "message", Icon: ArrowRight },
      { key: "pricing", Icon: BadgeEuro },
      { key: "confidence", Icon: CheckCircle2 },
      { key: "routine", Icon: Clock3 },
    ],
  },
  establishedSource: {
    key: "establishedSource",
    Icon: Crosshair,
    options: [
      { key: "referrals", Icon: CheckCircle2 },
      { key: "inbound", Icon: ArrowRight },
      { key: "maps", Icon: MapPinned },
      { key: "manual", Icon: Search },
      { key: "mixed", Icon: Crosshair },
    ],
  },
  establishedBottleneck: {
    key: "establishedBottleneck",
    Icon: Gauge,
    options: [
      { key: "enough", Icon: TrendingUp },
      { key: "quality", Icon: Target },
      { key: "start", Icon: MapPinned },
      { key: "data", Icon: Search },
      { key: "consistency", Icon: Clock3 },
    ],
  },
};

const QUESTION_SEQUENCES: Record<Branch, readonly PreQuestionKey[]> = {
  starting: ["stage", "service", "audience", "location", "startingReadiness", "startingBlocker"],
  established: ["stage", "service", "audience", "location", "establishedSource", "establishedBottleneck"],
};

const STAGE_BRANCH: Record<string, Branch> = {
  preparing: "starting",
  firstClients: "starting",
  established: "established",
};

const POST_CHOICES: Record<Branch, { goals: readonly ChoiceItem[]; rhythms: readonly ChoiceItem[] }> = {
  starting: {
    goals: [
      { key: "territory", Icon: MapPinned },
      { key: "shortlist", Icon: Search },
      { key: "outreach", Icon: ArrowRight },
      { key: "conversation", Icon: CalendarCheck2 },
      { key: "client", Icon: CheckCircle2 },
    ],
    rhythms: [
      { key: "daily", Icon: Clock3 },
      { key: "weekly", Icon: CalendarCheck2 },
      { key: "twice", Icon: TrendingUp },
      { key: "recommend", Icon: Gauge },
    ],
  },
  established: {
    goals: [
      { key: "more", Icon: TrendingUp },
      { key: "better", Icon: Target },
      { key: "time", Icon: Clock3 },
      { key: "consistency", Icon: CalendarCheck2 },
    ],
    rhythms: [
      { key: "five", Icon: Target },
      { key: "ten", Icon: Crosshair },
      { key: "twenty", Icon: TrendingUp },
      { key: "thirty", Icon: Gauge },
    ],
  },
};

const SIGNUP_ROUTE = "/signup?from=fit&locale=en&next=%2Fbilling%3Ffrom%3Dfit" as Route;
const SIGNIN_ROUTE = "/login?from=fit&locale=en&next=%2Fbilling%3Ffrom%3Dfit" as Route;
const STORAGE_KEY = "towncenter:fit-funnel:v1";
const QUESTION_ROUTES: Record<PreQuestionKey, string> = {
  stage: "stage",
  service: "service",
  audience: "audience",
  location: "location",
  startingReadiness: "readiness",
  startingBlocker: "blocker",
  establishedSource: "source",
  establishedBottleneck: "bottleneck",
};
const ROUTE_QUESTIONS = Object.fromEntries(
  Object.entries(QUESTION_ROUTES).map(([question, route]) => [route, question]),
) as Record<string, PreQuestionKey>;
const ROUTED_SCREENS = new Set<Screen>(["analysis", "result", "goal", "rhythm", "plan", "paywall", "mismatch"]);

type StoredFunnel = {
  branch: Branch | null;
  answers: Partial<Record<PreQuestionKey, string>>;
  goal: string | null;
  rhythm: string | null;
  mismatchReason: MismatchReason;
};

function routeFor(screen: Screen, questionKey: PreQuestionKey = "stage") {
  if (screen === "intro") return "/fit";
  if (screen === "question") return `/fit/${QUESTION_ROUTES[questionKey]}`;
  return `/fit/${screen}`;
}

function stateForRoute(pathname: string, fallbackStep = "intro"): { screen: Screen; questionKey?: PreQuestionKey } {
  const route = pathname.split("/").filter(Boolean)[1] ?? fallbackStep;
  const routedQuestion = ROUTE_QUESTIONS[route];
  if (routedQuestion) return { screen: "question", questionKey: routedQuestion };
  if (ROUTED_SCREENS.has(route as Screen)) return { screen: route as Screen };
  return { screen: "intro" };
}

function readStoredFunnel(): StoredFunnel | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const stored = value as Partial<StoredFunnel>;
    const branch = stored.branch === "starting" || stored.branch === "established" ? stored.branch : null;
    const mismatchReason = stored.mismatchReason === "notReady" ? "notReady" : "outside";
    return {
      branch,
      answers: stored.answers && typeof stored.answers === "object" ? stored.answers : {},
      goal: typeof stored.goal === "string" ? stored.goal : null,
      rhythm: typeof stored.rhythm === "string" ? stored.rhythm : null,
      mismatchReason,
    };
  } catch {
    return null;
  }
}

export function FitFunnel(props: FitFunnelProps) {
  const t = useTranslations("FitFunnel");
  const pathname = usePathname();
  const routedState = stateForRoute(pathname, props.initialStep);
  const screen = routedState.screen;
  const [branch, setBranch] = useState<Branch | null>(null);
  const questionKey = routedState.questionKey ?? "stage";
  const [answers, setAnswers] = useState<Partial<Record<PreQuestionKey, string>>>({});
  const [goal, setGoal] = useState<string | null>(null);
  const [rhythm, setRhythm] = useState<string | null>(null);
  const [mismatchReason, setMismatchReason] = useState<MismatchReason>("outside");
  const [confirmingAnswer, setConfirmingAnswer] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [analysisStep, setAnalysisStep] = useState(0);
  const [storageReady, setStorageReady] = useState(false);
  const answerTimer = useRef<number | null>(null);
  const transitionTimer = useRef<number | null>(null);

  const transition = useCallback((next: () => void) => {
    if (transitionTimer.current !== null) return;
    setLeaving(true);
    transitionTimer.current = window.setTimeout(() => {
      next();
      setLeaving(false);
      transitionTimer.current = null;
    }, 180);
  }, []);

  const navigate = useCallback((next: Screen, nextQuestion?: PreQuestionKey, replace = false) => {
    transition(() => {
      const resolvedQuestion = nextQuestion ?? questionKey;
      const method = replace ? "replaceState" : "pushState";
      window.history[method](null, "", routeFor(next, resolvedQuestion));
    });
  }, [questionKey, transition]);

  const go = useCallback((next: Screen) => navigate(next), [navigate]);

  useEffect(() => {
    return () => {
      if (answerTimer.current !== null) window.clearTimeout(answerTimer.current);
      if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = readStoredFunnel();
      if (stored) {
        const storedBranch = stored.branch ?? (stored.answers.stage ? STAGE_BRANCH[stored.answers.stage] : null);
        const availableGoals = storedBranch ? POST_CHOICES[storedBranch].goals.map(({ key }) => key) : [];
        const availableRhythms = storedBranch ? POST_CHOICES[storedBranch].rhythms.map(({ key }) => key) : [];
        setBranch(storedBranch);
        setAnswers(stored.answers);
        setGoal(stored.goal && availableGoals.includes(stored.goal) ? stored.goal : null);
        setRhythm(stored.rhythm && availableRhythms.includes(stored.rhythm) ? stored.rhythm : null);
        setMismatchReason(stored.mismatchReason);
      }
      setStorageReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    const stored: StoredFunnel = { branch, answers, goal, rhythm, mismatchReason };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }, [answers, branch, goal, mismatchReason, rhythm, storageReady]);

  useEffect(() => {
    if (screen !== "analysis") return;
    const timers = [
      window.setTimeout(() => setAnalysisStep(1), 320),
      window.setTimeout(() => setAnalysisStep(2), 760),
      window.setTimeout(() => setAnalysisStep(3), 1_200),
      window.setTimeout(() => go("result"), 1_720),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [go, screen]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [questionKey, screen]);

  const routedBranch = questionKey === "establishedSource" || questionKey === "establishedBottleneck"
    ? "established"
    : questionKey === "startingReadiness" || questionKey === "startingBlocker"
      ? "starting"
      : null;
  const activeBranch = routedBranch ?? branch ?? "starting";
  const sequence = QUESTION_SEQUENCES[activeBranch];
  const questionNumber = Math.max(1, sequence.indexOf(questionKey) + 1);
  const currentQuestion = PRE_QUESTIONS[questionKey];

  const answerQuestion = (value: string) => {
    if (answerTimer.current !== null || transitionTimer.current !== null) return;
    const nextBranch = questionKey === "stage" ? STAGE_BRANCH[value] : activeBranch;
    const nextSequence = QUESTION_SEQUENCES[nextBranch];
    const currentIndex = nextSequence.indexOf(questionKey);
    const outsideScope = questionKey === "location" && value === "outside";
    const notReady = questionKey === "startingReadiness" && (value === "practice" || value === "unclear");

    setAnswers((current) => ({ ...current, [questionKey]: value }));
    if (questionKey === "stage") {
      setGoal(null);
      setRhythm(null);
    }
    setConfirmingAnswer(true);
    answerTimer.current = window.setTimeout(() => {
      answerTimer.current = null;
      setConfirmingAnswer(false);
      setBranch(nextBranch);
      if (outsideScope || notReady) {
        setMismatchReason(outsideScope ? "outside" : "notReady");
        navigate("mismatch");
        return;
      }
      if (currentIndex === nextSequence.length - 1) {
        setAnalysisStep(0);
        navigate("analysis");
        return;
      }
      navigate("question", nextSequence[currentIndex + 1]);
    }, 340);
  };

  const goBack = () => {
    if (answerTimer.current !== null) return;
    if (screen === "question") {
      const currentIndex = sequence.indexOf(questionKey);
      if (currentIndex > 0) {
        navigate("question", sequence[currentIndex - 1]);
        return;
      }
      navigate("intro");
      return;
    }
    const previous: Partial<Record<Screen, Screen>> = {
      goal: "result",
      rhythm: "goal",
      plan: "rhythm",
      paywall: "plan",
      mismatch: "question",
    };
    const target = previous[screen];
    if (target) navigate(target);
  };

  const restart = () => {
    navigate("question", "stage");
  };

  const goalLabel = goal ? t(`post.${activeBranch}.goals.options.${goal}.label`) : "";
  const rhythmLabel = rhythm ? t(`post.${activeBranch}.rhythms.options.${rhythm}.label`) : "";
  const wideScreen = screen === "question" || screen === "goal" || screen === "rhythm" || screen === "paywall";

  return (
    <main className={styles.page} lang="en">
      <MapAtmosphere />
      <header className={styles.header}>
        <Link href="https://town-center.co" className={styles.brand}>
          <Image className={styles.brandMark} src={townCentre} alt="" priority placeholder="blur" />
          <span>Towncenter</span>
        </Link>
        <div className={styles.headerActions}>
          {screen === "question" ? (
            <span className={styles.progressText} aria-live="polite">
              {t("progress", { current: questionNumber, total: sequence.length })}
            </span>
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      {screen === "question" ? (
        <div className={styles.progressTrack} aria-hidden="true">
          <span style={{ transform: `scaleX(${questionNumber / sequence.length})` }} />
        </div>
      ) : null}

      <section className={styles.stage}>
        <div
          key={`${screen}-${questionKey}`}
          className={styles.screen}
          data-leaving={leaving ? "" : undefined}
          data-screen={screen}
          data-wide={wideScreen ? "" : undefined}
        >
          {screen !== "intro" && screen !== "analysis" && screen !== "result" ? (
            <button className={styles.back} type="button" onClick={goBack}>
              <ArrowLeft aria-hidden="true" />
              {t("back")}
            </button>
          ) : null}

          {screen === "intro" ? (
            <Intro onStart={() => navigate("question", "stage")} />
          ) : screen === "question" ? (
            <QuestionScreen
              question={currentQuestion}
              questionNumber={questionNumber}
              selected={answers[questionKey] ?? null}
              confirming={confirmingAnswer}
              onSelect={answerQuestion}
            />
          ) : screen === "analysis" ? (
            <Analysis branch={activeBranch} step={analysisStep} />
          ) : screen === "result" ? (
            <Result branch={activeBranch} onContinue={() => go("goal")} />
          ) : screen === "goal" ? (
            <ChoiceScreen
              namespace={`post.${activeBranch}.goals`}
              choices={POST_CHOICES[activeBranch].goals}
              selected={goal}
              onSelect={setGoal}
              onContinue={() => go("rhythm")}
            />
          ) : screen === "rhythm" ? (
            <ChoiceScreen
              namespace={`post.${activeBranch}.rhythms`}
              choices={POST_CHOICES[activeBranch].rhythms}
              selected={rhythm}
              onSelect={setRhythm}
              onContinue={() => go("plan")}
            />
          ) : screen === "plan" ? (
            <Plan branch={activeBranch} goal={goalLabel} rhythm={rhythmLabel} onContinue={() => go("paywall")} />
          ) : screen === "paywall" ? (
            <Paywall {...props} branch={activeBranch} />
          ) : (
            <Mismatch reason={mismatchReason} onRestart={restart} />
          )}
        </div>
      </section>

      <footer className={styles.footer}>
        <span>{t("footer")}</span>
        <Link href={SIGNIN_ROUTE}>{t("signIn")}</Link>
      </footer>
    </main>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  const t = useTranslations("FitFunnel");
  return (
    <div className={styles.intro}>
      <div className={styles.eyebrow}><Crosshair aria-hidden="true" />{t("intro.eyebrow")}</div>
      <h1>{t("intro.title")}</h1>
      <div className={styles.promiseRow}>
        <span><Clock3 aria-hidden="true" />{t("intro.time")}</span>
        <span><CheckCircle2 aria-hidden="true" />{t("intro.noAccount")}</span>
        <span><Euro aria-hidden="true" />{t("intro.priceUpfront")}</span>
      </div>
      <Button className={styles.primaryCta} variant="primary" onClick={onStart}>
        {t("intro.cta")}<ArrowRight aria-hidden="true" />
      </Button>
      <p className={styles.finePrint}>{t("intro.finePrint")}</p>
    </div>
  );
}

function QuestionScreen({ question, questionNumber, selected, confirming, onSelect }: {
  question: PreQuestion;
  questionNumber: number;
  selected: string | null;
  confirming: boolean;
  onSelect: (key: string) => void;
}) {
  const t = useTranslations("FitFunnel");
  const Icon = question.Icon;
  return (
    <div className={styles.question}>
      <div className={styles.questionIcon}><Icon aria-hidden="true" /><span>{String(questionNumber).padStart(2, "0")}</span></div>
      <p className={styles.kicker}>{t("pre.kicker")}</p>
      <h1>{t(`pre.${question.key}.title`)}</h1>
      <div
        className={`${styles.choiceGrid} ${styles.questionChoices}`}
        data-confirming={confirming ? "" : undefined}
        role="radiogroup"
        aria-label={t(`pre.${question.key}.title`)}
      >
        {question.options.map(({ key, Icon: OptionIcon }) => {
          const checked = selected === key;
          return (
            <button key={key} className={styles.choice} data-selected={checked ? "" : undefined} type="button" role="radio" aria-checked={checked} disabled={confirming} onClick={() => onSelect(key)}>
              <span className={styles.choiceIcon}><OptionIcon aria-hidden="true" /></span>
              <span className={styles.choiceCopy}>
                <strong>{t(`pre.${question.key}.options.${key}.label`)}</strong>
              </span>
              <span className={styles.radioMark}>{checked ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}</span>
            </button>
          );
        })}
      </div>
      <p className={styles.finePrint}>{t("pre.autoAdvance")}</p>
    </div>
  );
}

function Analysis({ branch, step }: { branch: Branch; step: number }) {
  const t = useTranslations("FitFunnel");
  const checks = ["market", "offer", "motion"] as const;
  return (
    <div className={styles.analysis} role="status" aria-live="polite">
      <div className={styles.scanner} aria-hidden="true">
        <div className={styles.scannerMap}><span className={styles.scanLine} /><i data-dot="one" /><i data-dot="two" /><i data-dot="three" /></div>
      </div>
      <p className={styles.kicker}>{t("analysis.kicker")}</p>
      <h1>{t("analysis.title")}</h1>
      <div className={styles.checkList}>
        {checks.map((key, index) => (
          <div key={key} className={styles.checkRow} data-ready={step > index ? "" : undefined}>
            <span className={styles.checkState}>{step > index ? <Check aria-hidden="true" /> : <i />}</span>
            <span>{t(`analysis.${branch}.${key}`)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Result({ branch, onContinue }: { branch: Branch; onContinue: () => void }) {
  const t = useTranslations("FitFunnel");
  const criteria = ["one", "two", "three"] as const;
  return (
    <div className={styles.result}>
      <div className={styles.fitSeal}><Check aria-hidden="true" /><span>{t(`result.${branch}.seal`)}</span></div>
      <p className={styles.kicker}>{t(`result.${branch}.kicker`)}</p>
      <h1>{t(`result.${branch}.title`)}</h1>
      <div className={styles.criteria}>
        {criteria.map((key) => <span key={key}><Check aria-hidden="true" />{t(`result.${branch}.criteria.${key}`)}</span>)}
      </div>
      <Button className={styles.primaryCta} variant="primary" onClick={onContinue}>
        {t(`result.${branch}.cta`)}<ArrowRight aria-hidden="true" />
      </Button>
    </div>
  );
}

function ChoiceScreen({ namespace, choices, selected, onSelect, onContinue }: {
  namespace: string;
  choices: readonly ChoiceItem[];
  selected: string | null;
  onSelect: (key: string) => void;
  onContinue: () => void;
}) {
  const t = useTranslations("FitFunnel");
  const title = t(`${namespace}.title`);
  return (
    <div className={styles.choices}>
      <p className={styles.kicker}>{t(`${namespace}.kicker`)}</p>
      <h1>{title}</h1>
      <div className={styles.choiceGrid} role="radiogroup" aria-label={title}>
        {choices.map(({ key, Icon }) => {
          const checked = selected === key;
          return (
            <button key={key} className={styles.choice} data-selected={checked ? "" : undefined} type="button" role="radio" aria-checked={checked} onClick={() => onSelect(key)}>
              <span className={styles.choiceIcon}><Icon aria-hidden="true" /></span>
              <span className={styles.choiceCopy}>
                <strong>{t(`${namespace}.options.${key}.label`)}</strong>
              </span>
              <span className={styles.radioMark}>{checked ? <Check aria-hidden="true" /> : null}</span>
            </button>
          );
        })}
      </div>
      <Button className={styles.choiceContinue} variant="primary" disabled={!selected} onClick={onContinue}>
        {t("continue")}<ArrowRight aria-hidden="true" />
      </Button>
    </div>
  );
}

function Plan({ branch, goal, rhythm, onContinue }: { branch: Branch; goal: string; rhythm: string; onContinue: () => void }) {
  const t = useTranslations("FitFunnel");
  return (
    <div className={styles.planCard}>
      <p className={styles.kicker}>{t(`plan.${branch}.kicker`)}</p>
      <h1>{t(`plan.${branch}.title`)}</h1>
      <div className={styles.planSummary}>
        <div><span>{t(`plan.${branch}.goalLabel`)}</span><strong>{goal}</strong></div>
        <div><span>{t(`plan.${branch}.rhythmLabel`)}</span><strong>{rhythm}</strong></div>
      </div>
      <ol className={styles.planSteps}>
        {(["one", "two", "three"] as const).map((key, index) => (
          <li key={key}><span>{String(index + 1).padStart(2, "0")}</span><strong>{t(`plan.${branch}.steps.${key}.title`)}</strong></li>
        ))}
      </ol>
      <Button className={styles.primaryCta} variant="primary" onClick={onContinue}>
        {t("plan.cta")}<ArrowRight aria-hidden="true" />
      </Button>
    </div>
  );
}

function Paywall({ branch, price, harvestedTargets, enrichments, siteAudits, areaKm2, zoneAreaKm2 }: FitFunnelProps & { branch: Branch }) {
  const t = useTranslations("FitFunnel");
  return (
    <div className={styles.paywall}>
      <div className={styles.paywallHead}>
        <div><p className={styles.kicker}>{t("paywall.kicker")}</p><h1>{t(`paywall.${branch}.title`)}</h1></div>
        <div className={styles.priceBadge}><span>€{price}</span><small>{t("paywall.perMonth")}</small></div>
      </div>
      <div className={styles.paywallBody}>
        <ul className={styles.featureList}>
          <li><Check aria-hidden="true" />{t("paywall.harvest", { count: harvestedTargets })}</li>
          <li><Check aria-hidden="true" />{t("paywall.enrich", { count: enrichments })}</li>
          <li><Check aria-hidden="true" />{t("paywall.audits", { count: siteAudits })}</li>
          <li><Check aria-hidden="true" />{t("paywall.area", { area: areaKm2, zone: zoneAreaKm2 })}</li>
        </ul>
        <div className={styles.chargeCard}>
          <div><span>{t("paywall.today")}</span><strong>€{price}</strong></div>
          <div><span>{t("paywall.then")}</span><strong>{t("paywall.monthly", { price })}</strong></div>
          <p>{t("paywall.cancel")}</p>
        </div>
      </div>
      <p className={styles.earlyPrice}><BadgeEuro aria-hidden="true" />{t("paywall.earlyPrice", { price })}</p>
      <Button asChild className={styles.paywallCta} variant="primary">
        <Link href={SIGNUP_ROUTE}>{t("paywall.cta", { price })}<ArrowRight aria-hidden="true" /></Link>
      </Button>
      <p className={styles.secureLine}><CheckCircle2 aria-hidden="true" />{t("paywall.accountNext")}</p>
    </div>
  );
}

function Mismatch({ reason, onRestart }: { reason: MismatchReason; onRestart: () => void }) {
  const t = useTranslations("FitFunnel");
  return (
    <div className={styles.mismatch}>
      <div className={styles.mismatchIcon}><MapPinned aria-hidden="true" /></div>
      <p className={styles.kicker}>{t(`mismatch.${reason}.kicker`)}</p>
      <h1>{t(`mismatch.${reason}.title`)}</h1>
      <div className={styles.mismatchActions}>
        <Button variant="secondary" onClick={onRestart}>{t("mismatch.restart")}</Button>
        <Button asChild variant="quiet"><Link href="https://town-center.co">{t("mismatch.site")}</Link></Button>
      </div>
    </div>
  );
}

function MapAtmosphere() {
  return (
    <div className={styles.atmosphere} aria-hidden="true">
      <div className={styles.gridLines} />
      <svg className={styles.route} viewBox="0 0 1440 900" preserveAspectRatio="none">
        <path d="M-80 720 C 180 520, 260 690, 470 500 S 790 220, 1030 390 S 1300 540, 1530 210" />
        <path className={styles.routePulse} d="M-80 720 C 180 520, 260 690, 470 500 S 790 220, 1030 390 S 1300 540, 1530 210" />
      </svg>
      <i className={styles.targetDot} data-position="one" />
      <i className={styles.targetDot} data-position="two" />
      <i className={styles.targetDot} data-position="three" />
    </div>
  );
}
