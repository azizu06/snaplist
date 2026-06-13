import type { Metadata } from "next";
import { Geist, Geist_Mono, Schibsted_Grotesk } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "next-themes";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Stripe-light identity (issue #49 round 3): Schibsted Grotesk is the
// Söhne-like display face (owner-picked); Stripe's look is neutral type +
// bold color, so the serif italic accent is retired.
const schibsted = Schibsted_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://snaplist.dev"),
  title: {
    default: "SnapList: photo to priced listing",
    template: "%s · SnapList",
  },
  description:
    "Snap a photo of something you want to sell. SnapList identifies it, researches a fair used price with cited sources, and writes ready-to-post listings.",
};

/**
 * Root layout is chrome-free (issue #49): the (marketing), (auth) and (app)
 * route groups each own their shell. Clerk components are themed here once —
 * dark Darkroom surfaces so the auth cards never read as a stock white modal.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      appearance={{
        // var() refs resolve in the browser, so the card follows the .dark
        // class live (values defined at the end of globals.css).
        variables: {
          colorPrimary: "var(--clerk-primary)",
          colorPrimaryForeground: "#ffffff",
          colorBackground: "var(--clerk-bg)",
          colorForeground: "var(--clerk-fg)",
          colorMutedForeground: "var(--clerk-muted)",
          colorInput: "var(--clerk-input-bg)",
          colorInputForeground: "var(--clerk-fg)",
          colorBorder: "var(--clerk-border)",
          colorRing: "var(--clerk-primary)",
          borderRadius: "0.5rem",
          fontFamily: "var(--font-geist-sans), ui-sans-serif, sans-serif",
        },
        elements: {
          // rounded-2xl card on the landing's floating-panel shadow — the
          // same surface idiom as the marketing cards (ui-r6-login pass).
          cardBox: {
            boxShadow: "var(--clerk-card-shadow)",
            borderRadius: "20px",
          },
          headerTitle: {
            fontFamily:
              "var(--font-display), var(--font-geist-sans), ui-sans-serif, sans-serif",
            letterSpacing: "-0.01em",
          },
          // Primary action matches the site's rounded-full CTAs.
          formButtonPrimary: { borderRadius: "9999px" },
          // The visible control "border" (input + Google button) is a Clerk
          // box-shadow ring keyed to colorBorder at ~11% alpha — invisible on
          // both themes. The appearance API can't override that ring, so it's
          // forced via .cl- class rules in globals.css (ui-r6-login-borders).
          socialButtonsBlockButton: {
            background: "var(--clerk-bg)",
          },
          footer: { background: "var(--clerk-footer-bg)" },
        },
      }}
    >
      {/* suppressHydrationWarning: next-themes mutates <html> class before
          hydration (its inline script kills the FOUC) — expected mismatch. */}
      <html
        lang="en"
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} ${schibsted.variable} h-full antialiased`}
      >
        <body className="min-h-full">
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            enableSystem
            disableTransitionOnChange
          >
            {children}
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
