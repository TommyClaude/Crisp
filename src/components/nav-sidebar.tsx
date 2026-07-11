"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  FlaskConical,
  LayoutDashboard,
  Lightbulb,
  MessagesSquare,
  Package,
  Sparkles,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/suggestions", label: "Suggestions", icon: Lightbulb },
  { href: "/test-answer", label: "Test Answer", icon: FlaskConical },
  { href: "/crisp", label: "Crisp", icon: MessagesSquare },
  { href: "/rag", label: "RAG Search", icon: Sparkles },
  { href: "/brands", label: "Brands", icon: Building2 },
  { href: "/plugins", label: "Plugins & Docs", icon: Package },
] as const;

export function NavSidebar() {
  const pathname = usePathname();
  const [needsRebuild, setNeedsRebuild] = React.useState(false);

  // Silent, once-on-mount fetch: a failure just means no dot (never blocks
  // paint or logs). The /rag page + its API are the source of truth.
  React.useEffect(() => {
    let active = true;
    fetch("/api/rag/rebuild-advice", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { needsRebuild?: unknown } | null) => {
        if (active && data && typeof data.needsRebuild === "boolean") {
          setNeedsRebuild(data.needsRebuild);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return (
    <aside className="bg-card fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r max-sm:w-14">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4 max-sm:justify-center max-sm:px-0">
        <span className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
          <MessagesSquare className="size-4" />
        </span>
        <span className="truncate text-sm font-semibold tracking-tight max-sm:hidden">
          YayAssist
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          const showDot = href === "/rag" && needsRebuild;
          return (
            <Link
              key={href}
              href={href}
              title={showDot ? `${label} — rebuild recommended` : label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors max-sm:justify-center max-sm:px-0",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate max-sm:hidden">{label}</span>
              {showDot && (
                <span className="ml-auto size-2 shrink-0 rounded-full bg-amber-500 max-sm:absolute max-sm:top-1.5 max-sm:right-1.5 max-sm:ml-0">
                  <span className="sr-only">Rebuild recommended</span>
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 border-t p-2 max-sm:justify-center">
        <ThemeToggle />
      </div>
    </aside>
  );
}
