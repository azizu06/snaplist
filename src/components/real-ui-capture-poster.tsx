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
  const mobilePosition: Record<string, string> = {
    // Keep loading/reduced-motion posters composed exactly like the encoded
    // mobile clips. A generic center crop lands on the inbox thread's quiet
    // middle and makes the Answer step look blank before lazy video mount.
    "inbox-list": "50% 24%",
    "inbox-draft": "50% 88%",
    "inbox-sent": "50% 52%",
  };
  const backgroundPosition = mobilePosition[shot] ?? "50% 50%";

  return (
    <div className="absolute inset-0" role="img" aria-label={label}>
      {/* Backgrounds load even when a full-page screenshot includes an
          offscreen Guide step. The previous lazy Next/Image posters remained
          blank until their individual slots entered the viewport. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-cover md:hidden dark:hidden"
        style={{
          backgroundImage: `url(${capture("mobile", "light")})`,
          backgroundPosition,
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 hidden bg-cover dark:block dark:md:hidden"
        style={{
          backgroundImage: `url(${capture("mobile", "dark")})`,
          backgroundPosition,
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 hidden bg-cover bg-center md:block dark:md:hidden"
        style={{ backgroundImage: `url(${capture("desktop", "light")})` }}
      />
      <div
        aria-hidden
        className="absolute inset-0 hidden bg-cover bg-center dark:md:block"
        style={{ backgroundImage: `url(${capture("desktop", "dark")})` }}
      />
    </div>
  );
}
