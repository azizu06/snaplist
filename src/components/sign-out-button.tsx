"use client";

import { SignOutButton } from "@clerk/nextjs";

/**
 * Sign out via Clerk (issue #41 — replaces the POST /auth/signout route).
 * Client component because Clerk's sign-out clears the session browser-side.
 */
export function AppSignOutButton({
  className,
  children,
}: {
  className: string;
  children?: React.ReactNode;
}) {
  return (
    <SignOutButton redirectUrl="/login">
      <button type="button" className={className}>
        {children ?? "Sign out"}
      </button>
    </SignOutButton>
  );
}
