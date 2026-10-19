// The mark: an open book whose right page carries a highlighter stroke. Inline SVG, no request.
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 5.5c3-1.2 6-1 9 1v13c-3-2-6-2.2-9-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M21 5.5c-3-1.2-6-1-9 1v13c3-2 6-2.2 9-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14.2 10.2l4.6-1.2" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}
