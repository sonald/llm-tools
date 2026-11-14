// SwiftUI .truncationMode(.middle): the head ellipsizes, the tail keeps its end visible.
export function MiddleTruncated({ text, className = '' }: { text: string; className?: string }) {
  const half = Math.ceil(text.length / 2)
  return (
    <span className={`middle-truncated ${className}`} title={text}>
      <span className="middle-head">{text.slice(0, half)}</span>
      <span className="middle-tail" dir="rtl"><bdi dir="ltr">{text.slice(half)}</bdi></span>
    </span>
  )
}
