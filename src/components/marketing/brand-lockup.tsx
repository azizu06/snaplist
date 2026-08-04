import Image from "next/image";

/** Shared SnapList mark and wordmark for the marketing shell. */
export function BrandLockup({ priority = false }: { priority?: boolean }) {
  return (
    <>
      <Image
        className="mkt-lockup__mark"
        src="/brand/scout-lockup.png"
        alt=""
        aria-hidden="true"
        width={443}
        height={388}
        priority={priority}
      />
      <span className="mkt-lockup__word">SnapList</span>
    </>
  );
}
