import type { Metadata } from "next";

import enMessages from "@/messages/en.json";

import { FitPageContent } from "./FitPageContent";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return {
    title: enMessages.FitFunnel.metadataTitle,
    description: enMessages.FitFunnel.metadataDescription,
  };
}

export default function FitPage() {
  return <FitPageContent />;
}
