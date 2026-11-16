import { notFound } from "next/navigation";
import { PerfHarness } from "@/components/dev/PerfHarness";

// Test-only route for the rendering budget e2e test; it does not exist outside mock mode.
export default async function PerfHarnessPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  if (process.env.NEXT_PUBLIC_USE_MOCK !== "true") notFound();
  const { mode } = await searchParams;
  return <PerfHarness mode={mode === "scene" ? "scene" : "xray"} />;
}
