import type { Metadata } from "next";
import { notFound } from "next/navigation";

import enMessages from "@/messages/en.json";

import { FitPageContent } from "../FitPageContent";

const STEPS = [
  "stage",
  "service",
  "audience",
  "location",
  "readiness",
  "blocker",
  "source",
  "bottleneck",
  "analysis",
  "result",
  "goal",
  "rhythm",
  "plan",
  "paywall",
  "mismatch",
] as const;

export function generateStaticParams() {
  return STEPS.map((step) => ({ step }));
}

export function generateMetadata(): Metadata {
  return {
    title: enMessages.FitFunnel.metadataTitle,
    description: enMessages.FitFunnel.metadataDescription,
  };
}

export default async function FitStepPage({ params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  if (!(STEPS as readonly string[]).includes(step)) notFound();
  return <FitPageContent initialStep={step} />;
}
