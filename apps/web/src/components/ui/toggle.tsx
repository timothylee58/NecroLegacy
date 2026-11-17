"use client";
import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cn } from "@/lib/utils";

const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root>
>(({ className, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-10 items-center justify-center gap-2 rounded border border-border px-3 text-sm font-semibold transition-colors hover:border-foreground/40 data-[state=on]:border-tallow data-[state=on]:bg-tallow/10 data-[state=on]:text-tallow aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Toggle.displayName = "Toggle";

export { Toggle };
