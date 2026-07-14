import Image from "next/image";

/**
 * Theme- and viewport-aware still from the same real dev-preview capture set
 * used by Remotion. This is the loading, error, and reduced-motion fallback,
 * so those paths never fall back to a fabricated parallel interface.
 */
export function RealUiCapturePoster({
  shot,
  label,
}: {
  shot: string;
  label: string;
}) {
  const capture = (formFactor: "desktop" | "mobile", theme: "light" | "dark") =>
    `/demo/captures/${formFactor}/${theme}/${shot}.png`;

  return (
    <div className="absolute inset-0" role="img" aria-label={label}>
      <Image
        fill
        unoptimized
        src={capture("mobile", "light")}
        alt=""
        sizes="(max-width: 767px) 100vw, 1px"
        className="object-cover md:hidden dark:hidden"
      />
      <Image
        fill
        unoptimized
        src={capture("mobile", "dark")}
        alt=""
        sizes="(max-width: 767px) 100vw, 1px"
        className="hidden object-cover dark:block dark:md:hidden"
      />
      <Image
        fill
        unoptimized
        src={capture("desktop", "light")}
        alt=""
        sizes="(min-width: 768px) 75vw, 1px"
        className="hidden object-cover md:block dark:md:hidden"
      />
      <Image
        fill
        unoptimized
        src={capture("desktop", "dark")}
        alt=""
        sizes="(min-width: 768px) 75vw, 1px"
        className="hidden object-cover dark:md:block"
      />
    </div>
  );
}
