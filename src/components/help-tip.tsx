"use client";

import * as React from "react";
import { CircleHelp } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A small "?" affordance that reveals a short explanation on hover/focus —
 * for labels and actions a new colleague wouldn't immediately understand.
 * The trigger is a real <button>, so it's reachable by Tab and opens the
 * tooltip on focus (not just mouse hover), per Radix Tooltip's built-in
 * keyboard behavior. Content renders in a portal, so it's never clipped by
 * a scrolling/overflow-hidden ancestor.
 */
export function HelpTip({
  children,
  example,
  subject,
  className,
  side = "top",
}: {
  /** Short explanation paragraph (2-3 sentences max). */
  children: React.ReactNode;
  /** Optional example line, rendered distinctly under the explanation. */
  example?: React.ReactNode;
  /**
   * What the tip explains, for the accessible name ("More info about X") —
   * without it every trigger reads as an identical "More info" to
   * screen-reader users tabbing through a form.
   */
  subject?: string;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:text-foreground inline-flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            className
          )}
          aria-label={subject ? `More info about ${subject}` : "More info"}
        >
          <CircleHelp className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[300px] text-left">
        <p>{children}</p>
        {example ? (
          <p className="text-primary-foreground/75 mt-1">{example}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
