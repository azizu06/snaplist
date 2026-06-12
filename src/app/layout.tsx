import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk, Instrument_Serif } from "next/font/google";
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

// Darkroom identity (issue #49): Space Grotesk carries display type,
// Instrument Serif italic is the editorial accent ("photo" / "minutes").
const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-serif-accent",
  weight: "400",
  style: ["normal", "italic"],
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
          colorPrimary: "#e4ff4f",
          colorPrimaryForeground: "#101013",
          colorBackground: "#16161a",
          colorForeground: "#f4f4f2",
          colorMutedForeground: "#9b9ba4",
          colorInput: "#1d1d22",
          colorInputForeground: "#f4f4f2",
          colorBorder: "#2a2a31",
          colorRing: "#e4ff4f",
          borderRadius: "0.75rem",
          fontFamily: "var(--font-geist-sans), ui-sans-serif, sans-serif",
        },
        elements: {
          cardBox: { boxShadow: "0 0 0 1px #2a2a31, 0 24px 64px -16px rgba(0,0,0,.8)" },
          socialButtonsBlockButton: {
            background: "#1d1d22",
            border: "1px solid #2a2a31",
          },
          footer: { background: "#131316" },
        },
      }}
    >
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} ${instrumentSerif.variable} h-full antialiased`}
      >
        <body className="min-h-full">{children}</body>
      </html>
    </ClerkProvider>
  );
}
