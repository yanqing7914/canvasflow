/**
 * A locally bundled, realistic EV render with a transparent background. The
 * PNG is the runtime asset; the SVG source lives next to it in the repo for
 * provenance and regeneration. It is atmosphere only: navigation and task
 * state continue to come from the map and Agent layers.
 */
export function IdleVehicleVisual({ muted = false }: { muted?: boolean }) {
  return (
    <div className={`idle-vehicle-visual${muted ? ' idle-vehicle-visual--muted' : ''}`} aria-hidden="true">
      <img
        src="/car/idle-car.png"
        alt=""
        width={2000}
        height={900}
        draggable={false}
      />
    </div>
  )
}
