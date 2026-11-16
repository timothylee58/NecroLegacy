"use client";
import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const OpenContext = React.createContext(false);

function Sheet({ open, defaultOpen = false, onOpenChange, ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  const [inner, setInner] = React.useState(defaultOpen);
  const isOpen = open ?? inner;
  const handleChange = React.useCallback(
    (next: boolean) => {
      setInner(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  return (
    <OpenContext.Provider value={isOpen}>
      <SheetPrimitive.Root {...props} open={isOpen} onOpenChange={handleChange} />
    </OpenContext.Provider>
  );
}
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

type SheetContentProps = React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
  side?: "left" | "right";
  closeRef?: React.Ref<HTMLButtonElement>;
};

const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  ({ className, children, side = "right", closeRef, ...props }, ref) => {
    const open = React.useContext(OpenContext);
    const reduced = useReducedMotion();
    const transition = { duration: reduced ? 0 : 0.25, ease: "easeOut" as const };
    const offscreen = side === "right" ? "100%" : "-100%";
    return (
      <SheetPrimitive.Portal forceMount>
        <AnimatePresence>
          {open && (
            <SheetPrimitive.Overlay key="overlay" forceMount asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-black/70"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transition}
              />
            </SheetPrimitive.Overlay>
          )}
          {open && (
            <SheetPrimitive.Content key="content" ref={ref} forceMount asChild {...props}>
              <motion.div
                className={cn(
                  "fixed inset-y-0 z-50 w-3/4 max-w-sm overflow-y-auto border-border bg-popover p-6 text-popover-foreground",
                  side === "right" ? "right-0 border-l" : "left-0 border-r",
                  className,
                )}
                initial={{ x: offscreen }}
                animate={{ x: 0 }}
                exit={{ x: offscreen }}
                transition={transition}
              >
                {children}
                <SheetPrimitive.Close ref={closeRef} className="absolute right-4 top-4 rounded-md p-1" aria-label="Close">
                  <X className="h-4 w-4" aria-hidden="true" />
                </SheetPrimitive.Close>
              </motion.div>
            </SheetPrimitive.Content>
          )}
        </AnimatePresence>
      </SheetPrimitive.Portal>
    );
  },
);
SheetContent.displayName = "SheetContent";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} className={cn("text-lg font-semibold", className)} {...props} />
));
SheetTitle.displayName = "SheetTitle";
const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = "SheetDescription";
export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetTitle, SheetDescription };
