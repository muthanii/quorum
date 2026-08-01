import * as React from "react";

import { cn } from "@/lib/utils";

/** Keyboard-shortcut chip, e.g. <Kbd>⌘K</Kbd>. */
function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-control border bg-raised px-1 font-mono text-[11px] leading-none text-muted select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
