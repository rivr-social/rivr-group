# Map Module

Interactive map visualization using Mapbox GL for displaying geographic data points.

## Component: MainMap

A client-side React component that renders an interactive Mapbox map with customizable markers.

### Features

- **Interactive Map**: Pan, zoom, and navigate a Mapbox dark theme map
- **Custom Markers**: Display location markers with glowing effect animations
- **Boulder, CO Default**: Initially centered on Boulder, Colorado
- **Responsive**: Full width and height layout
- **Error Handling**: Graceful fallback when Mapbox token is missing

### Props

```typescript
interface GeoLocation {
  lat: number;
  lng: number;
}

interface MapItem {
  id: string;
  geo: GeoLocation;
}

interface MainMapProps {
  items: MapItem[];
}
```

### Usage

```tsx
import { MainMap } from "@/components/modules/map";

const items = [
  { id: "location-1", geo: { lat: 40.015, lng: -105.2705 } },
  { id: "location-2", geo: { lat: 40.02, lng: -105.28 } },
];

export default function MapPage() {
  return (
    <div className="w-screen h-screen">
      <MainMap items={items} />
    </div>
  );
}
```

### Environment Variables

Required environment variable:

```bash
NEXT_PUBLIC_MAPBOX_TOKEN=your_mapbox_token_here
```

Get your Mapbox token from: https://account.mapbox.com/access-tokens/

### Initial Viewport

- **Longitude**: -105.2705
- **Latitude**: 40.015
- **Zoom**: 12
- **Location**: Boulder, Colorado

### Map Style

Uses Mapbox dark theme: `mapbox://styles/mapbox/dark-v11`

### Marker Styling

Markers feature a dual-layer glowing effect:
- **Outer glow**: Pulsing blue halo with blur effect
- **Inner dot**: Blue dot with white border and shadow

### Testing

Run the test suite:

```bash
npm test MainMap.test.tsx
```

The test suite covers:
- Initialization with correct viewport
- Map style configuration
- Environment token usage
- Error handling for missing tokens
- Marker rendering and positioning
- Glowing effect styling
- Edge cases (empty arrays, extreme coordinates)
- TypeScript interface compliance

### Dependencies

- `react-map-gl`: ^7.x
- `mapbox-gl`: ^2.x
- React 18+
- Next.js 13+ (for "use client" directive)

### File Structure

```
src/components/modules/map/
├── MainMap.tsx          # Main component
├── MainMap.test.tsx     # Test suite
├── index.ts             # Exports
└── README.md            # Documentation
```
