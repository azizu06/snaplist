import { PreviewCaptureController } from "./preview-capture-controller";

/**
 * Dev-preview-only capture boundary. The pages beneath this layout already
 * render the shipped SnapList views with fixtures; this adds deterministic
 * theme/focus controls for the media capture script and hides development-only
 * overlays that are not part of the product UI.
 */
export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-demo-preview>
      <style>{`
        body:has([data-demo-preview]) #clerk-components,
        body:has([data-demo-preview]) [data-nextjs-dev-overlay] {
          display: none !important;
        }
        html[data-demo-capture-active] [data-preview-controls] {
          display: none !important;
        }
      `}</style>
      <PreviewCaptureController />
      {children}
    </div>
  );
}
