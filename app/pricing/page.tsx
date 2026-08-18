import { redirect } from "next/navigation";

// The grid editor moved to /settings, alongside the rest of the account's
// configuration. Kept as a redirect so old links and bookmarks still land
// somewhere useful.
export default function PricingPage() {
  redirect("/settings");
}
