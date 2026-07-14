"use client";

import { useRef } from "react";
import { ACCEPT } from "./upload-draft-context";

export function PhotoInputActions({
  idPrefix,
  disabled,
  onSelect,
  className = "",
}: {
  idPrefix: string;
  disabled: boolean;
  onSelect: (files: FileList) => void;
  className?: string;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { files } = event.currentTarget;
    if (files && files.length > 0) onSelect(files);
    // Let sellers capture or choose the same file again after removal. This is
    // also safe when the native picker is canceled (files is empty/null).
    event.currentTarget.value = "";
  };

  const buttonClass =
    "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2 py-2.5 text-[13px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50 sm:gap-2 sm:px-3 sm:text-[14px]";

  return (
    <div className={`grid min-w-0 grid-cols-2 gap-2 ${className}`}>
      <input
        ref={cameraRef}
        id={`${idPrefix}-camera-input`}
        type="file"
        accept={ACCEPT}
        capture="environment"
        aria-hidden
        disabled={disabled}
        hidden
        onChange={handleChange}
      />
      <input
        ref={libraryRef}
        id={`${idPrefix}-library-input`}
        type="file"
        accept={ACCEPT}
        multiple
        aria-hidden
        disabled={disabled}
        hidden
        onChange={handleChange}
      />
      <button
        type="button"
        disabled={disabled}
        aria-controls={`${idPrefix}-camera-input`}
        onClick={() => cameraRef.current?.click()}
        className={buttonClass}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
        <span className="whitespace-nowrap">Take photo</span>
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-controls={`${idPrefix}-library-input`}
        onClick={() => libraryRef.current?.click()}
        className={buttonClass}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9" r="1.5" />
          <path d="m21 15-5-5L5 20" />
        </svg>
        <span className="whitespace-nowrap">Choose photos</span>
      </button>
    </div>
  );
}
