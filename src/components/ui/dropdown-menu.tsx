"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

/**
 * Minimal dropdown-menu primitive, hand-rolled instead of pulled from
 * @radix-ui/react-dropdown-menu (not a dependency of this repo — see
 * package.json; adding it just for one toolbar kebab menu wasn't worth a new
 * runtime dep). Mirrors the shadcn dropdown-menu API surface (Root/Trigger/
 * Content/Item/Label/Separator) so call sites read the same way, but
 * open/close state, outside-click + Escape dismissal, roving-tabindex arrow
 * navigation, and focus return to the trigger are all implemented here on
 * top of existing primitives (@radix-ui/react-slot for `asChild`, same as
 * Button).
 */

interface DropdownMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerNode: HTMLElement | null;
  setTriggerNode: (node: HTMLElement | null) => void;
}

const DropdownMenuContext =
  React.createContext<DropdownMenuContextValue | null>(null);

function useDropdownMenuContext(component: string) {
  const ctx = React.useContext(DropdownMenuContext);
  if (!ctx) {
    throw new Error(`${component} must be used within <DropdownMenu>`);
  }
  return ctx;
}

function DropdownMenu({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [openState, setOpenState] = React.useState(defaultOpen);
  const open = openProp ?? openState;
  const [triggerNode, setTriggerNode] = React.useState<HTMLElement | null>(
    null
  );

  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  return (
    <DropdownMenuContext.Provider
      value={{ open, setOpen, triggerNode, setTriggerNode }}
    >
      <div className="relative inline-flex" data-slot="dropdown-menu">
        {children}
      </div>
    </DropdownMenuContext.Provider>
  );
}

function DropdownMenuTrigger({
  asChild = false,
  onClick,
  onKeyDown,
  children,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const { open, setOpen, setTriggerNode } = useDropdownMenuContext(
    "DropdownMenuTrigger"
  );
  const Comp = asChild ? Slot : "button";
  const triggerRef = React.useCallback(
    (node: HTMLElement | null) => setTriggerNode(node),
    [setTriggerNode]
  );

  return (
    <Comp
      data-slot="dropdown-menu-trigger"
      ref={triggerRef}
      type={asChild ? undefined : "button"}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(event: React.MouseEvent<HTMLElement>) => {
        onClick?.(event as React.MouseEvent<HTMLButtonElement>);
        if (event.defaultPrevented) return;
        setOpen(!open);
      }}
      onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
        onKeyDown?.(event as React.KeyboardEvent<HTMLButtonElement>);
        if (event.defaultPrevented) return;
        if (
          event.key === "ArrowDown" ||
          event.key === "Enter" ||
          event.key === " "
        ) {
          event.preventDefault();
          setOpen(true);
        }
      }}
      {...props}
    >
      {children}
    </Comp>
  );
}

function DropdownMenuContent({
  align = "end",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  const { open, setOpen, triggerNode } = useDropdownMenuContext(
    "DropdownMenuContent"
  );
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Dismiss on outside click, Escape (returns focus to the trigger), or
  // focus moving outside the menu (e.g. Tab past the last item).
  React.useEffect(() => {
    if (!open) return;
    function isOutside(target: Node) {
      return (
        !contentRef.current?.contains(target) && !triggerNode?.contains(target)
      );
    }
    function handlePointerDown(event: MouseEvent) {
      if (isOutside(event.target as Node)) setOpen(false);
    }
    function handleFocusIn(event: FocusEvent) {
      if (isOutside(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerNode?.focus();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, setOpen, triggerNode]);

  // Focus the first enabled item when the menu opens.
  React.useEffect(() => {
    if (!open) return;
    const first = contentRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])'
    );
    first?.focus();
  }, [open]);

  const menuItems = () =>
    Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      ) ?? []
    );

  const handleContentKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(currentIndex + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  if (!open) return null;

  return (
    <div
      ref={contentRef}
      data-slot="dropdown-menu-content"
      role="menu"
      aria-orientation="vertical"
      onKeyDown={handleContentKeyDown}
      className={cn(
        "bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 absolute top-full z-50 mt-1.5 min-w-[14rem] origin-top-right rounded-md border p-1 shadow-md",
        align === "end" ? "right-0" : "left-0",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function DropdownMenuItem({
  className,
  disabled,
  onSelect,
  onClick,
  onKeyDown,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const { setOpen, triggerNode } = useDropdownMenuContext("DropdownMenuItem");

  const activate = () => {
    if (disabled) return;
    onSelect?.();
    setOpen(false);
    triggerNode?.focus();
  };

  return (
    <div
      data-slot="dropdown-menu-item"
      role="menuitem"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        activate();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
      {...props}
    >
      {children}
    </div>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dropdown-menu-label"
      className={cn(
        "text-muted-foreground px-2 py-1.5 text-xs font-medium",
        className
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dropdown-menu-separator"
      role="separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
