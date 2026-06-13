import Link from "next/link";
import { Logo } from "@/components/logo";
import { ThemeIconToggle } from "@/components/theme-toggle";
import { LoginAurora } from "./login-aurora";

/**
 * (auth) group layout (issue #49, ui-r6-login pass) — the login screen now
 * speaks the landing hero's language: the same prism slab + photographic
 * grain, reshaped by the `.auth-hero` overrides (globals.css, ui-r6-login
 * block) into a calm top band that fades before mid-screen, with the WebGL
 * aurora layered on top (lazy, client-only, reduced-motion-gated). Chrome
 * stays minimal: brand top-left escaping home, theme toggle top-right.
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="auth-hero relative flex min-h-screen flex-col overflow-hidden bg-night text-flash">
      <div aria-hidden className="prism-gradient" />
      <div aria-hidden className="prism-grain" />
      <LoginAurora />
      <header className="relative z-10 flex items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/" className="inline-flex text-flash">
          <Logo markClassName="size-8" />
        </Link>
        <ThemeIconToggle className="border border-white/45 bg-white/70 backdrop-blur hover:bg-white dark:border-white/10 dark:bg-white/10 dark:hover:bg-white/15" />
      </header>
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
