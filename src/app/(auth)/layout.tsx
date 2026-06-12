import Link from "next/link";
import { Logo } from "@/components/logo";

/**
 * (auth) group layout (issue #49) — minimal night chrome around the themed
 * Clerk card: brand top-left escaping back to the landing, aurora glow, no
 * nav/footer noise.
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="aurora grain relative flex min-h-screen flex-col overflow-hidden bg-night text-flash">
      <header className="relative z-10 px-5 py-5 sm:px-8">
        <Link href="/" className="inline-flex text-flash">
          <Logo markClassName="size-8" />
        </Link>
      </header>
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
