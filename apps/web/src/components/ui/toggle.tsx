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
      "inline-flex h-10 items-center justify-center rounded-md border border-border px-3 text-sm font-medium hover:bg-accent data-[state=on]:bg-accent data-[state=on]:underline disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Toggle.displayName = "Toggle";

export { Toggle };
