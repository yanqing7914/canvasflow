# Route Geometry Handoff

`navigation.plan-route` fixture results expose optional `summary`, `waypoints`,
and `polyline` fields for a static route sketch. All points are fictional and
must not be presented as real navigation or GIS data.

Frontend acceptance:

- Direct, charging, avoid-highway, and ring-road routes use distinct summaries
  and polylines.
- A renderer may normalize all fixture points into its own view box; it must not
  call a real map SDK for the competition fallback path.
- `waypoints` provide labeled markers. `polyline` provides the ordered sketch.
- Existing clients may ignore these optional fields without breaking the
  `navigation-summary` component.

Canonical variants:

| Route ID | Visible distinction |
| --- | --- |
| `route-airport-001` | Direct to Hongqiao T2 |
| `route-airport-via-charge-001` | Includes `station-hongqiao-01` |
| `route-airport-avoid-hw-001` | Surface-road alternative |
| `route-airport-bypass-001` | Includes `via-ring-road-01` |

The contract and fixture-provider tests remain the source of truth until the UI
chooses to render the sketch.
