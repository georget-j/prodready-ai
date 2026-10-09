import Link from "next/link";
import { NavAuthButton } from "@/components/nav-auth-button";

/**
 * Site nav. Server component, no Supabase round-trip — the user-specific
 * Dashboard / Sign-in button is rendered client-side by NavAuthButton
 * after hydration. Removing the server-side `getUser()` call shaved a
 * Supabase call off every page render.
 */
export function SiteNav() {
  return (
    <header className="border-b border-border">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="text-lg font-semibold">
          ProdReady AI
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href="/tracks"
            className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline-flex"
          >
            Tracks
          </Link>
          <Link
            href="/pricing"
            className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline-flex"
          >
            Pricing
          </Link>
          <Link href="/demo" className="rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800">Try demo</Link>
          <NavAuthButton />
        </div>
      </nav>
    </header>
  );
}

