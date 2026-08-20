import { redirect } from "next/navigation";

export default async function PricingPage(props: PageProps<"/pricing">) {
  const params = await props.searchParams;
  const from = Array.isArray(params.from) ? params.from[0] : params.from;
  redirect(from === "onboarding" ? "/settings?from=onboarding" : "/settings");
}
