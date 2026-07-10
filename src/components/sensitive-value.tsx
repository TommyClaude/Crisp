"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { maskEmail, maskIp, maskPhone } from "@/lib/rag/redact";
import { cn } from "@/lib/utils";

const MASKERS = {
  email: maskEmail,
  phone: maskPhone,
  ip: maskIp,
} as const;

export type SensitiveValueKind = keyof typeof MASKERS;

/**
 * Displays a PII value (email / phone / IP) masked by default, with an
 * eye button to reveal the real value.
 */
export function SensitiveValue({
  value,
  kind,
  className,
}: {
  value: string;
  kind: SensitiveValueKind;
  className?: string;
}) {
  const [revealed, setRevealed] = React.useState(false);
  const display = revealed ? value : MASKERS[kind](value);

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 font-mono text-xs",
        className
      )}
    >
      <span className="truncate" title={revealed ? value : undefined}>
        {display}
      </span>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? `Hide ${kind}` : `Reveal ${kind}`}
        aria-pressed={revealed}
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded-sm p-0.5 transition-colors outline-none focus-visible:ring-[3px]"
      >
        {revealed ? (
          <EyeOff className="size-3.5" />
        ) : (
          <Eye className="size-3.5" />
        )}
      </button>
    </span>
  );
}
