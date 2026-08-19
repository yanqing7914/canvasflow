/** The idle vehicle is a local, logo-free raster asset; navigation state stays in the map/Agent layers. */
export function IdleVehicleVisual({ muted = false }: { muted?: boolean }) {
  return (
    <div className={`idle-vehicle-visual${muted ? ' idle-vehicle-visual--muted' : ''}`} aria-hidden="true">
      <span className="idle-vehicle-visual__reflection" data-testid="idle-vehicle-reflection" />
      <span className="idle-vehicle-visual__ground" data-testid="idle-vehicle-ground" />
      <img
        src="/car/idle-car-ev.png"
        alt=""
        width={1617}
        height={676}
        draggable={false}
      />
    </div>
  )
}
