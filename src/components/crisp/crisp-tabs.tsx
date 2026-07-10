"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/crisp/dashboard", label: "Dashboard" },
  { href: "/crisp/conversations", label: "Conversations" },
] as const;

/** Tab switcher for the Crisp section (dashboard ↔ conversations). */
export function CrispTabs() {
  const pathname = usePathname();

  return (
    <nav className="bg-muted text-muted-foreground inline-flex h-9 items-center rounded-lg p-1">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-7 items-center rounded-md px-3 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
