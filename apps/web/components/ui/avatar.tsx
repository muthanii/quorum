"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

import { cn } from "@/lib/utils";

interface AvatarProps extends React.ComponentProps<typeof AvatarPrimitive.Root> {
  /**
   * Identity-color ring (colorForUser). Rendered as a box-shadow so the same
   * color that marks this user's cursor and votes also marks their avatar.
   * Color is never the only signal — always pair with a name or initials.
   */
  ringColor?: string;
}

function Avatar({ className, ringColor, style, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)}
      style={
        ringColor
          ? {
              boxShadow: `0 0 0 2px var(--background), 0 0 0 4px ${ringColor}`,
              ...style,
            }
          : style
      }
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-raised text-xs font-medium text-muted uppercase",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };
