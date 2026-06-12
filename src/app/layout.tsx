import type { Metadata } from "next";
import { Geist, Geist_Mono, Schibsted_Grotesk } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
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
    default: "SnapList — photo to priced listing",
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
        variables: {
          colorPrimary: "#6d4aff",
          colorPrimaryForeground: "#ffffff",
          colorBackground: "#ffffff",
          colorForeground: "#131e3a",
          colorMutedForeground: "#5f6b88",
          colorInput: "#ffffff",
          colorInputForeground: "#131e3a",
          colorBorder: "#dfe4ee",
          colorRing: "#6d4aff",
          borderRadius: "0.5rem",
          fontFamily: "var(--font-geist-sans), ui-sans-serif, sans-serif",
        },
        elements: {
          cardBox: {
            boxShadow:
              "0 13px 27px -5px rgba(19,30,58,0.18), 0 8px 16px -8px rgba(19,30,58,0.22)",
          },
          socialButtonsBlockButton: {
            background: "#ffffff",
            border: "1px solid #dfe4ee",
          },
          footer: { background: "#f4f6fb" },
        },
      }}
    >
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} ${schibsted.variable} h-full antialiased`}
      >
        <body className="min-h-full">{children}</body>
      </html>
    </ClerkProvider>
  );
}
