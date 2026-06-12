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
          colorPrimary: "#635bff",
          colorPrimaryForeground: "#ffffff",
          colorBackground: "#ffffff",
          colorForeground: "#0a2540",
          colorMutedForeground: "#6b7c93",
          colorInput: "#ffffff",
          colorInputForeground: "#0a2540",
          colorBorder: "#e6ebf1",
          colorRing: "#635bff",
          borderRadius: "0.5rem",
          fontFamily: "var(--font-geist-sans), ui-sans-serif, sans-serif",
        },
        elements: {
          cardBox: {
            boxShadow:
              "0 13px 27px -5px rgba(50,50,93,0.25), 0 8px 16px -8px rgba(0,0,0,0.3)",
          },
          socialButtonsBlockButton: {
            background: "#ffffff",
            border: "1px solid #e6ebf1",
          },
          footer: { background: "#f6f9fc" },
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
