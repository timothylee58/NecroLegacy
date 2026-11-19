import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PerfHarnessRoute } from "@/components/dev/PerfHarnessRoute";

// Test-only route for the rendering budget e2e test; it does not exist outside mock mode.
export default function PerfHarnessPage() {
  if (process.env.NEXT_PUBLIC_USE_MOCK !== "true") notFound();
  return (
    <Suspense fallback={null}>
      <PerfHarnessRoute />
    </Suspense>
  );
}
