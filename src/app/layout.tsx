import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getUserId } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SnapList",
  description: "Photo of a used item → a priced, ready-to-post listing.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Auth state drives the shell (X-2): signed-in users get the persistent nav
  // everywhere; signed-out visitors get a logo-only header. getUserId() reads
  // cookies first, keeping secret-less builds prerender-safe (issue #41).
  const userId = await getUserId();

  // Dev-only: the screenshot preview harness (src/app/dev/preview) needs the
  // signed-in chrome without a running auth stack. Never true in production.
  const previewSignedIn =
    process.env.NODE_ENV !== "production" &&
    process.env.PREVIEW_SIGNED_IN === "1";

  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full">
          <AppShell signedIn={userId != null || previewSignedIn}>
            {children}
          </AppShell>
        </body>
      </html>
    </ClerkProvider>
  );
}
