# Map Module

Source-verified on 2026-05-20 against the colocated `MainMap.tsx`,
`MainMap.test.tsx`, and `index.ts`.

`MainMap` is a client-side CesiumJS globe component that imports the `cesium` package directly.

The component accepts marker/model `items`, optional `[lng, lat]` center,
optional zoom, marker/layer visibility controls, optional GeoJSON overlays,
optional marker click handling, and optional camera orbit completion handling.

Runtime map configuration is read from `NEXT_PUBLIC_LOCAL_BASEMAP_URL`,
`NEXT_PUBLIC_STREETS_TILES_URL`, `NEXT_PUBLIC_LOCAL_TERRAIN_URL`,
`NEXT_PUBLIC_CESIUM_TERRAIN_URL`, `NEXT_PUBLIC_LOCAL_BUILDINGS_3DTILES_URL`,
`NEXT_PUBLIC_CESIUM_BUILDINGS_URL`, `NEXT_PUBLIC_CESIUM_ION_TOKEN`, and
`NEXT_PUBLIC_TERRAIN_EXAGGERATION`. The default map center is Boulder,
Colorado: `[-105.2705, 40.015]`; default zoom is `10`.

Tests live in `MainMap.test.tsx` and mock Cesium viewer, entity, camera, and
event-handler behavior.

## Current Wiring Gap

The component defaults to `/api/map-style-tiles/{z}/{x}/{y}` when no basemap URL
is configured, and the group repo currently has map mirror/verify scripts.
Unlike `repos/global`, this repo does not currently contain
`src/app/api/map-style-tiles/[z]/[x]/[y]/route.ts`. A group deployment must
configure a valid basemap URL or add/proxy the tile route before relying on that
default path.
