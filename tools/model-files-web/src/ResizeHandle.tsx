// A pointer-drag splitter. `value` sizes the pane after the handle (grows as the pointer moves left or up);
// with `before` it sizes the pane before the handle instead.
export function ResizeHandle({ axis, value, min, max, before = false, onChange }: {
  axis: 'x' | 'y'
  before?: boolean
  value: number
  min: number
  max: number
  onChange(value: number): void
}) {
  return (
    <div className={`resize-handle resize-${axis}`} aria-hidden="true"
      onPointerDown={event => {
        event.preventDefault()
        const start = axis === 'y' ? event.clientY : event.clientX
        const handle = event.currentTarget
        handle.setPointerCapture(event.pointerId)
        const move = (next: PointerEvent) => {
          const delta = (axis === 'y' ? next.clientY : next.clientX) - start
          onChange(Math.min(Math.max(before ? value + delta : value - delta, min), max))
        }
        const end = () => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', end)
          handle.removeEventListener('pointercancel', end)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', end)
        handle.addEventListener('pointercancel', end)
      }} />
  )
}
