import type { Metadata } from "next";

import { NavSidebar } from "@/components/nav-sidebar";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Crisp Archive",
    template: "%s · Crisp Archive",
  },
  description:
    "Internal archive of Crisp.chat support conversations with RAG search.",
};

/**
 * Runs before paint: applies the persisted (or system) theme so there is no
 * flash of the wrong theme and no hydration mismatch on themed elements.
 */
const themeInitScript = `(function () {
  try {
    var theme = localStorage.getItem("theme");
    var dark =
      theme === "dark" ||
      (theme !== "light" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-background text-foreground min-h-screen text-sm antialiased">
        <NavSidebar />
        <main className="pl-56 max-sm:pl-14">{children}</main>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
