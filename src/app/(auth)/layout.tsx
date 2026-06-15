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

      {/*
        Clerk draws the email input and social-button "border" as a box-shadow
        ring keyed to colorBorder at ~11% alpha — invisible on the white card
        and the dark input (owner). Clerk's styles inject into <head> at
        runtime and resist both the appearance API and high-specificity
        !important overrides placed in globals.css (also <head>, loaded
        earlier → it loses on source order). `outline` is the one edge
        property Clerk never sets; placed HERE in the body it sits later in
        document order than Clerk's <head> styles, so it wins. An inset
        offset makes it read as a real border that follows the rounded
        corners; focus swaps to the brand-violet ring.
      */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
.cl-formFieldInput{outline:1.5px solid var(--clerk-border-strong)!important;outline-offset:-1.5px!important;}
.cl-formFieldInput:focus,.cl-formFieldInput:focus-visible{outline:2px solid var(--clerk-primary)!important;outline-offset:-2px!important;}
.cl-socialButtonsBlockButton{outline:1.5px solid var(--clerk-border-strong)!important;outline-offset:-1.5px!important;}
/* Email-first order: the email/password form leads and "Continue with Google"
   drops below it (owner: the old social-top + full-width "or" row wasted space
   and read as two disjoint blocks). .cl-main is Clerk's flex column holding
   [socialButtonsRoot, dividerRow(hidden), form]; reorder its children directly
   since provider-level appearance.layout.socialButtonsPlacement is ignored in
   this Clerk version. Semantic .cl-* classes only (no volatile .cl-internal-*). */
.cl-main .cl-form{order:1!important;}
.cl-main .cl-socialButtonsRoot{order:2!important;margin-top:1rem!important;}`,
        }}
      />
    </div>
  );
}
