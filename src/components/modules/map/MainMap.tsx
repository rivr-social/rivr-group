"use client";

/**
 * Renders the primary interactive Cesium map used by map-driven discovery views.
 * Used in: map modules where markers, terrain, and optional 3D buildings are displayed.
 * Key props: `items` marker data, `center`/`zoom` viewport, `layerVisibility` layer toggles,
 * `onMarkerClick` marker interaction callback, and `onStyleLayersDiscovered` layer metadata callback.
 */
import React, { useEffect, useMemo, useRef } from "react";
import {
  ArcGisBaseMapType,
  ArcGisMapServerImageryProvider,
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  CesiumTerrainProvider,
  Color,
  ConstantPositionProperty,
  ConstantProperty,
  createWorldTerrainAsync,
  DistanceDisplayCondition,
  NearFarScalar,
  EllipsoidTerrainProvider,
  Entity,
  GeoJsonDataSource,
  HeadingPitchRange,
  HeightReference,
  HorizontalOrigin,
  ImageryLayer,
  Ion,
  IonWorldImageryStyle,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SingleTileImageryProvider,
  Transforms,
  createWorldImageryAsync,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

export interface GeoLocation {
  lat: number;
  lng: number;
}

export interface MapItem {
  id: string;
  geo: GeoLocation;
  name?: string;
  type?: string;
  modelUrl?: string;
}

export interface StyleLayerInfo {
  id: string;
  type: string;
  source?: string;
  sourceLayer?: string;
  minzoom?: number;
  maxzoom?: number;
  visibleByDefault: boolean;
}

export interface GeoJsonLayerConfig {
  id: string;
  url: string;
  visible: boolean;
  stroke: string;
  fill: string;
  strokeWidth: number;
  fillAlpha: number;
  showLabels: boolean;
  viewportAware?: boolean;
  minZoom?: number;
  labelMinSeparationDegrees?: number;
}

export interface MainMapProps {
  items: MapItem[];
  onMarkerClick?: (item: MapItem) => void;
  center?: [number, number];
  zoom?: number;
  className?: string;
  layerVisibility?: {
    basemap?: boolean;
    terrain?: boolean;
    events?: boolean;
    groups?: boolean;
    posts?: boolean;
    offerings?: boolean;
    labels?: boolean;
    buildings?: boolean;
  };
  styleLayerVisibility?: Record<string, boolean>;
  onStyleLayersDiscovered?: (layers: StyleLayerInfo[]) => void;
  geoJsonLayers?: GeoJsonLayerConfig[];
  orbitOnArrival?: boolean;
  onOrbitComplete?: () => void;
}

const DEFAULT_CENTER: [number, number] = [-105.2705, 40.015];
const DEFAULT_ZOOM = 10;
const DEFAULT_NATURAL_EARTH_URL = "/Cesium/Assets/Textures/NaturalEarthII/world.jpg";
const DEFAULT_STREETS_TILES_URL = "/api/map-style-tiles/{z}/{x}/{y}";
const CESIUM_ION_TOKEN = (process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "").trim();
const ION_BUILDINGS_ASSET_ID = 96188;
const TERRAIN_EXAGGERATION = Math.max(1, Math.min(6, Number(process.env.NEXT_PUBLIC_TERRAIN_EXAGGERATION ?? "3.4") || 3.4));

function normalizeRuntimeUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return "";
  if (value.startsWith("/")) return value;
  try {
    const parsed = new URL(value);
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (isLocalhost) return parsed.toString();
    if (parsed.hostname === "tile.openstreetmap.org") return parsed.toString();
  } catch {
    return "";
  }
  return "";
}

const CESIUM_TERRAIN_URL = normalizeRuntimeUrl(
  process.env.NEXT_PUBLIC_LOCAL_TERRAIN_URL ?? process.env.NEXT_PUBLIC_CESIUM_TERRAIN_URL ?? ""
);
const CESIUM_BUILDINGS_URL = normalizeRuntimeUrl(
  process.env.NEXT_PUBLIC_LOCAL_BUILDINGS_3DTILES_URL ?? process.env.NEXT_PUBLIC_CESIUM_BUILDINGS_URL ?? ""
);

function colorForType(type?: string): Color {
  switch (type) {
    case "event":
      return Color.fromCssColorString("#7c3aed");
    case "group":
      return Color.fromCssColorString("#3b82f6");
    case "post":
      return Color.fromCssColorString("#10b981");
    case "offering":
      return Color.fromCssColorString("#f59e0b");
    case "live":
      return Color.fromCssColorString("#ff3366");
    default:
      return Color.fromCssColorString("#3b82f6");
  }
}

/** Known GeoJSON property keys that hold a human-readable region name. */
const NAME_PROPERTY_KEYS = ["name", "US_L4NAME", "US_L3NAME", "NA_L2NAME", "NA_L1NAME", "NAME", "Name", "ECO_NAME", "BIOME_NAME", "REALM", "Bioregions", "HYBAS_ID"];

/** Extracts a region name from GeoJSON feature properties. */
function extractRegionName(properties: Record<string, unknown>): string | null {
  for (const key of NAME_PROPERTY_KEYS) {
    const val = properties[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

/** Computes a simple centroid from a flat ring of [lng, lat] coordinates. */
function ringCentroid(ring: number[][]): [number, number] {
  let lngSum = 0;
  let latSum = 0;
  for (const [lng, lat] of ring) {
    lngSum += lng;
    latSum += lat;
  }
  return [lngSum / ring.length, latSum / ring.length];
}

/** Computes a centroid for a Polygon or MultiPolygon geometry. */
function geometryCentroid(geometry: { type: string; coordinates: unknown }): [number, number] | null {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as number[][][];
    if (rings.length > 0) return ringCentroid(rings[0]);
  } else if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates as number[][][][];
    // Use the largest polygon (first ring) — typically the main landmass.
    let best: number[][] | null = null;
    let bestLen = 0;
    for (const poly of polygons) {
      if (poly[0] && poly[0].length > bestLen) {
        best = poly[0];
        bestLen = poly[0].length;
      }
    }
    if (best) return ringCentroid(best);
  }
  return null;
}

/** Distinct hues for coloring individual regions within a layer. */
const REGION_PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#06b6d4", "#84cc16",
  "#6366f1", "#e11d48", "#10b981", "#eab308", "#a855f7",
  "#d946ef", "#0ea5e9", "#65a30d", "#f43f5e", "#0891b2",
  "#7c3aed", "#059669",
];

function stablePaletteIndex(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash % REGION_PALETTE.length;
}

function centerDistanceDegrees(a: [number, number], b: [number, number]): number {
  const avgLatRadians = CesiumMath.toRadians((a[1] + b[1]) / 2);
  const lngScale = Math.max(0.2, Math.cos(avgLatRadians));
  const dx = (a[0] - b[0]) * lngScale;
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Extracts polygon/multipolygon boundaries as LineString features.
 * Cesium disables polygon outlines when using clampToGround, so rendering
 * boundaries as separate polylines is the only reliable way to show region
 * borders on the globe surface.
 */
function extractBorderLines(geojson: Record<string, unknown>): Record<string, unknown> {
  const features = (geojson as { features?: Array<{ type: string; properties: unknown; geometry: { type: string; coordinates: unknown } }> }).features;
  if (!features) return { type: "FeatureCollection", features: [] };
  const lines: Array<{ type: string; properties: unknown; geometry: { type: string; coordinates: unknown } }> = [];
  for (const feature of features) {
    const geom = feature.geometry;
    if (!geom) continue;
    if (geom.type === "Polygon") {
      const rings = geom.coordinates as number[][][];
      for (const ring of rings) {
        lines.push({ type: "Feature", properties: feature.properties, geometry: { type: "LineString", coordinates: ring } });
      }
    } else if (geom.type === "MultiPolygon") {
      const polygons = geom.coordinates as number[][][][];
      for (const polygon of polygons) {
        for (const ring of polygon) {
          lines.push({ type: "Feature", properties: feature.properties, geometry: { type: "LineString", coordinates: ring } });
        }
      }
    }
  }
  return { type: "FeatureCollection", features: lines };
}

function featureSpansGlobe(feature: { geometry?: { coordinates?: unknown } }): boolean {
  const xs: number[] = [];
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (node.length === 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      xs.push(node[0]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(feature.geometry?.coordinates);
  if (xs.length === 0) return false;
  const width = Math.max(...xs) - Math.min(...xs);
  return width >= 350;
}

function sanitizeBioregionGlobalGeoJson(geojson: Record<string, unknown>): Record<string, unknown> {
  const features = (geojson as {
    features?: Array<{ properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } }>;
  }).features;
  if (!features || features.length === 0) return geojson;

  const filtered = features.filter((feature) => {
    const code = String((feature.properties ?? {}).Bioregions ?? "");
    if (code.startsWith("OC") || code.startsWith("AN")) return false;
    if (featureSpansGlobe(feature)) return false;
    return true;
  });

  return { ...geojson, features: filtered };
}

function heightFromZoom(zoom: number): number {
  const clamped = Math.max(2, Math.min(16, zoom));
  return Math.max(1000, 28000000 / Math.pow(2, clamped - 2));
}

function zoomFromHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return DEFAULT_ZOOM;
  const raw = 2 + Math.log2(28000000 / height);
  return Math.max(2, Math.min(16, raw));
}

/**
 * Main Cesium map component.
 * @param {MainMapProps} props Component props for marker data, viewport configuration, layer visibility, and callbacks.
 */
/** Minimum camera height above terrain surface (meters) to prevent underground clipping. */
const MIN_CAMERA_TERRAIN_BUFFER = 50;

/** Full orbit duration in seconds. */
const ORBIT_DURATION_SECONDS = 8;

/** Orbit pitch angle below horizontal (radians). ~30° gives a good viewing angle. */
const ORBIT_PITCH = -Math.PI / 6;

const MainMap: React.FC<MainMapProps> = ({
  items,
  onMarkerClick,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  className,
  layerVisibility,
  onStyleLayersDiscovered,
  geoJsonLayers,
  orbitOnArrival,
  onOrbitComplete,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Holds long-lived Cesium objects so they persist across renders without triggering rerenders.
  const viewerRef = useRef<Viewer | null>(null);
  const clickHandlerRef = useRef<ScreenSpaceEventHandler | null>(null);
  const baseLayerRef = useRef<ReturnType<Viewer["imageryLayers"]["addImageryProvider"]> | null>(null);
  const streetsLayerRef = useRef<ReturnType<Viewer["imageryLayers"]["addImageryProvider"]> | null>(null);
  const terrainProviderRef = useRef<CesiumTerrainProvider | null>(null);
  const terrainLoadingRef = useRef<Promise<void> | null>(null);
  const buildingsRef = useRef<Cesium3DTileset | null>(null);
  const buildingsLoadingRef = useRef<Promise<void> | null>(null);
  const lastViewportRef = useRef<{ lng: number; lat: number; zoom: number } | null>(null);
  const itemsByIdRef = useRef<Map<string, MapItem>>(new Map());
  const onMarkerClickRef = useRef<typeof onMarkerClick>(onMarkerClick);
  const onStyleLayersDiscoveredRef = useRef<typeof onStyleLayersDiscovered>(onStyleLayersDiscovered);
  const geoJsonDataSourcesRef = useRef<Map<string, GeoJsonDataSource>>(new Map());
  const viewportLayerRequestKeysRef = useRef<Map<string, string>>(new Map());
  // Tracks which layer IDs should currently be visible — read by async load completions
  // to avoid the race condition where a layer finishes loading after the user toggled it off.
  const geoJsonVisibilityRef = useRef<Set<string>>(new Set());
  // Orbit animation state — ref so preRender listener can read latest without re-registering.
  const orbitListenerRef = useRef<(() => void) | null>(null);
  const orbitOnArrivalRef = useRef(orbitOnArrival);
  const onOrbitCompleteRef = useRef(onOrbitComplete);
  // Underground prevention listener — persistent across the viewer lifetime.
  const undergroundListenerRef = useRef<(() => void) | null>(null);

  // Memoize item lookup map for O(1) marker click resolution.
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  useEffect(() => {
    // Keep latest item lookup available to Cesium click handler.
    itemsByIdRef.current = itemsById;
  }, [itemsById]);

  useEffect(() => {
    // Keep latest callback reference without recreating Cesium event handlers.
    onMarkerClickRef.current = onMarkerClick;
  }, [onMarkerClick]);

  useEffect(() => {
    // Keep latest style-discovery callback reference for map initialization events.
    onStyleLayersDiscoveredRef.current = onStyleLayersDiscovered;
  }, [onStyleLayersDiscovered]);

  useEffect(() => {
    orbitOnArrivalRef.current = orbitOnArrival;
  }, [orbitOnArrival]);

  useEffect(() => {
    onOrbitCompleteRef.current = onOrbitComplete;
  }, [onOrbitComplete]);

  useEffect(() => {
    // Configure Cesium asset base path once on the client.
    if (typeof window !== "undefined") {
      (window as Window & { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = "/Cesium";
    }
    if (CESIUM_ION_TOKEN) {
      Ion.defaultAccessToken = CESIUM_ION_TOKEN;
    }
    // Create viewer once after mount when container is available.
    if (!containerRef.current || viewerRef.current) return;

    const streetsTilesUrl = normalizeRuntimeUrl(
      process.env.NEXT_PUBLIC_LOCAL_BASEMAP_URL ??
      process.env.NEXT_PUBLIC_STREETS_TILES_URL ??
      DEFAULT_STREETS_TILES_URL
    );

    const fallbackBaseLayer = new ImageryLayer(
      new SingleTileImageryProvider({
        url: DEFAULT_NATURAL_EARTH_URL,
        tileWidth: 512,
        tileHeight: 256,
      }),
      { alpha: 1 }
    );

    const viewer = new Viewer(containerRef.current, {
      baseLayer: fallbackBaseLayer,
      terrainProvider: new EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      baseLayerPicker: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      fullscreenButton: false,
      shouldAnimate: false,
      requestRenderMode: false,
    });
    (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none";

    if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
    viewer.scene.fog.enabled = false;
    if (viewer.scene.sun) viewer.scene.sun.show = false;
    if (viewer.scene.moon) viewer.scene.moon.show = false;
    viewer.scene.backgroundColor = Color.fromCssColorString("#08101d");
    viewer.scene.globe.show = true;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.globe.baseColor = Color.fromCssColorString("#08101d");

    baseLayerRef.current = viewer.imageryLayers.get(0) ?? fallbackBaseLayer;

    if (CESIUM_ION_TOKEN) {
      void createWorldImageryAsync({
        style: IonWorldImageryStyle.AERIAL_WITH_LABELS,
      })
        .then((provider) => {
          if (!viewerRef.current || viewerRef.current !== viewer || viewer.isDestroyed()) return;
          const ionLayer = viewer.imageryLayers.addImageryProvider(provider, 0);
          ionLayer.alpha = 1;
          if (baseLayerRef.current && baseLayerRef.current !== ionLayer) {
            baseLayerRef.current.show = false;
          }
          baseLayerRef.current = ionLayer;
          if (streetsLayerRef.current) {
            streetsLayerRef.current.show = false;
            streetsLayerRef.current.alpha = 0;
          }
          viewer.scene.requestRender();
        })
        .catch(() => {
          void ArcGisMapServerImageryProvider.fromBasemapType(ArcGisBaseMapType.SATELLITE)
            .then((provider) => {
              if (!viewerRef.current || viewerRef.current !== viewer || viewer.isDestroyed()) return;
              const satelliteLayer = viewer.imageryLayers.addImageryProvider(provider, 0);
              satelliteLayer.alpha = 1;
              if (baseLayerRef.current && baseLayerRef.current !== satelliteLayer) {
                baseLayerRef.current.show = false;
              }
              baseLayerRef.current = satelliteLayer;
              if (streetsLayerRef.current) {
                streetsLayerRef.current.alpha = 0.55;
              }
              viewer.scene.requestRender();
            })
            .catch(() => {
              // Keep local fallback if hosted satellite imagery is unavailable.
            });
        });
    } else {
      void ArcGisMapServerImageryProvider.fromBasemapType(ArcGisBaseMapType.SATELLITE)
        .then((provider) => {
          if (!viewerRef.current || viewerRef.current !== viewer || viewer.isDestroyed()) return;
          const satelliteLayer = viewer.imageryLayers.addImageryProvider(provider, 0);
          satelliteLayer.alpha = 1;
          if (baseLayerRef.current && baseLayerRef.current !== satelliteLayer) {
            baseLayerRef.current.show = false;
          }
          baseLayerRef.current = satelliteLayer;
          if (streetsLayerRef.current) {
            streetsLayerRef.current.alpha = 0.55;
          }
          viewer.scene.requestRender();
        })
        .catch(() => {
          // Keep local fallback if hosted satellite imagery is unavailable.
        });
    }

    if (streetsTilesUrl.length > 0 && !CESIUM_ION_TOKEN) {
      try {
        const provider = new UrlTemplateImageryProvider({
          url: streetsTilesUrl,
          minimumLevel: 0,
          maximumLevel: 19,
        });
        provider.errorEvent.addEventListener((error) => {
          error.retry = false;
        });
        const streetsLayer = viewer.imageryLayers.addImageryProvider(provider);
        streetsLayer.alpha = 1;
        streetsLayerRef.current = streetsLayer;
      } catch {
        streetsLayerRef.current = null;
      }
    }

    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.maximumScreenSpaceError = 2;
    viewer.scene.verticalExaggeration = TERRAIN_EXAGGERATION;
    viewer.terrainProvider = new EllipsoidTerrainProvider();

    // Handle map marker clicks by resolving picked entity id back to the source item.
    const clickHandler = new ScreenSpaceEventHandler(viewer.canvas);
    clickHandler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(movement.position);
      const idObj = picked && typeof picked === "object" && "id" in picked ? picked.id : null;
      if (!(idObj instanceof Entity)) return;
      const id = idObj.id;
      if (!id) return;
      const found = itemsByIdRef.current.get(id);
      if (found && onMarkerClickRef.current) onMarkerClickRef.current(found);
    }, ScreenSpaceEventType.LEFT_CLICK);

    clickHandlerRef.current = clickHandler;
    viewerRef.current = viewer;

    // --- Camera underground prevention (persistent preRender listener) ---
    const undergroundGuard = () => {
      if (viewer.isDestroyed()) return;
      const cam = viewer.camera;
      const carto = cam.positionCartographic;
      const terrainHeight = viewer.scene.globe.getHeight(carto);
      if (terrainHeight !== undefined) {
        const minHeight = terrainHeight + MIN_CAMERA_TERRAIN_BUFFER;
        if (carto.height < minHeight) {
          cam.setView({
            destination: Cartesian3.fromRadians(carto.longitude, carto.latitude, minHeight),
            orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
          });
        }
      }
    };
    viewer.scene.preRender.addEventListener(undergroundGuard);
    undergroundListenerRef.current = undergroundGuard;

    // Cancel any in-progress orbit when user interacts with the globe.
    const cancelOrbitOnInteraction = () => {
      if (orbitListenerRef.current && !viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(orbitListenerRef.current);
        orbitListenerRef.current = null;
        viewer.camera.lookAtTransform(Matrix4.IDENTITY);
      }
    };
    const interactionHandler = new ScreenSpaceEventHandler(viewer.canvas);
    interactionHandler.setInputAction(cancelOrbitOnInteraction, ScreenSpaceEventType.LEFT_DOWN);
    interactionHandler.setInputAction(cancelOrbitOnInteraction, ScreenSpaceEventType.RIGHT_DOWN);
    interactionHandler.setInputAction(cancelOrbitOnInteraction, ScreenSpaceEventType.MIDDLE_DOWN);
    interactionHandler.setInputAction(cancelOrbitOnInteraction, ScreenSpaceEventType.WHEEL);

    // Initial viewport animation on first mount.
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(center[0], center[1], heightFromZoom(zoom)),
      duration: 0.4,
    });

    const syncViewerSize = () => {
      if (!containerRef.current || !viewerRef.current || viewerRef.current.isDestroyed()) return;
      if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) return;
      viewerRef.current.resize();
      viewerRef.current.scene.requestRender();
    };

    const scheduleSyncViewerSize = () => {
      if (typeof window === "undefined") return;
      window.requestAnimationFrame(syncViewerSize);
    };

    const syncAfterLayoutSettles = () => {
      scheduleSyncViewerSize();
      if (typeof window === "undefined") return;
      window.requestAnimationFrame(() => {
        scheduleSyncViewerSize();
      });
    };

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncAfterLayoutSettles();
          })
        : null;

    resizeObserver?.observe(containerRef.current);
    resizeObserver?.observe(containerRef.current.parentElement ?? containerRef.current);
    syncAfterLayoutSettles();
    const delayedResizeIds =
      typeof window !== "undefined"
        ? [
            window.setTimeout(syncViewerSize, 120),
            window.setTimeout(syncViewerSize, 320),
            window.setTimeout(syncViewerSize, 800),
          ]
        : [];

    const handleWindowResize = () => {
      syncAfterLayoutSettles();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("resize", handleWindowResize);
      window.addEventListener("orientationchange", handleWindowResize);
      window.addEventListener("load", handleWindowResize, { once: true });
    }

    viewer.scene.requestRender();
    // Notify parent that this implementation does not expose style sublayers yet.
    onStyleLayersDiscoveredRef.current?.([]);

    return () => {
      // Destroy Cesium side effects to avoid leaks when unmounting.
      // Remove orbit listener if active.
      if (orbitListenerRef.current) {
        viewer.scene.preRender.removeEventListener(orbitListenerRef.current);
        orbitListenerRef.current = null;
      }
      // Remove underground guard.
      if (undergroundListenerRef.current) {
        viewer.scene.preRender.removeEventListener(undergroundListenerRef.current);
        undergroundListenerRef.current = null;
      }
      interactionHandler.destroy();
      clickHandlerRef.current?.destroy();
      clickHandlerRef.current = null;
      if (buildingsRef.current && !buildingsRef.current.isDestroyed() && viewer.scene.primitives.contains(buildingsRef.current)) {
        viewer.scene.primitives.remove(buildingsRef.current);
      }
      buildingsRef.current = null;
      resizeObserver?.disconnect();
      if (typeof window !== "undefined") {
        for (const timeoutId of delayedResizeIds) {
          window.clearTimeout(timeoutId);
        }
        window.removeEventListener("resize", handleWindowResize);
        window.removeEventListener("orientationchange", handleWindowResize);
      }
      // Remove all loaded GeoJSON data sources before destroying the viewer.
      for (const ds of geoJsonDataSourcesRef.current.values()) {
        viewer.dataSources.remove(ds, true);
      }
      geoJsonDataSourcesRef.current.clear();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // Stable fingerprint to prevent unnecessary entity rebuilds (prevents flashing)
  const itemFingerprint = useMemo(
    () => items.map((i) => i.id).sort().join(","),
    [items]
  );
  const lastItemFingerprint = useRef("");

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    // Only rebuild when the actual set of items changes, not on every render
    const fp = itemFingerprint + "|" + JSON.stringify(layerVisibility ?? {});
    if (lastItemFingerprint.current === fp) return;
    lastItemFingerprint.current = fp;

    // Rebuild marker entities
    viewer.entities.removeAll();

    // Spread co-located pins in a small circle to prevent z-fighting
    const coordCounts = new Map<string, number>();
    const coordOffsets = new Map<string, number>();
    for (const item of items) {
      const key = `${item.geo.lat.toFixed(4)},${item.geo.lng.toFixed(4)}`;
      coordCounts.set(key, (coordCounts.get(key) ?? 0) + 1);
    }

    for (const item of items) {
      // Offset co-located pins so they don't stack
      const coordKey = `${item.geo.lat.toFixed(4)},${item.geo.lng.toFixed(4)}`;
      const total = coordCounts.get(coordKey) ?? 1;
      const idx = coordOffsets.get(coordKey) ?? 0;
      coordOffsets.set(coordKey, idx + 1);
      let lat = item.geo.lat;
      let lng = item.geo.lng;
      if (total > 1) {
        const angle = (2 * Math.PI * idx) / total;
        const radius = 0.0008; // ~80m spread
        lat += Math.cos(angle) * radius;
        lng += Math.sin(angle) * radius;
      }

      const type = item.type || "group";
      // Type-specific visibility toggles control whether each marker is rendered.
      const typeEnabled =
        (type === "event" && layerVisibility?.events !== false) ||
        (type === "group" && layerVisibility?.groups !== false) ||
        (type === "post" && layerVisibility?.posts !== false) ||
        (type === "offering" && layerVisibility?.offerings !== false) ||
        (type !== "event" && type !== "group" && type !== "post" && type !== "offering");
      if (!typeEnabled) continue;

      const labelConfig = item.name && layerVisibility?.labels
        ? {
            text: item.name,
            font: "12px sans-serif",
            fillColor: Color.WHITE,
            showBackground: false,
            outlineWidth: 0,
            pixelOffset: new Cartesian2(0, -18),
            style: LabelStyle.FILL,
          }
        : undefined;

      if (item.modelUrl) {
        viewer.entities.add({
          id: item.id,
          position: Cartesian3.fromDegrees(lng, lat, 0),
          model: {
            uri: item.modelUrl,
            minimumPixelSize: 64,
            maximumScale: 200,
            heightReference: HeightReference.CLAMP_TO_GROUND,
          },
          label: labelConfig,
        });
      } else {
        viewer.entities.add({
          id: item.id,
          position: Cartesian3.fromDegrees(lng, lat, 0),
          point: {
            pixelSize: 14,
            color: colorForType(item.type),
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: labelConfig,
        });
      }
    }

    viewer.scene.requestRender();
  }, [items, layerVisibility]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (baseLayerRef.current) {
      baseLayerRef.current.show = layerVisibility?.basemap !== false;
      baseLayerRef.current.alpha = layerVisibility?.basemap !== false ? 1 : 0;
    }

    viewer.scene.requestRender();
  }, [layerVisibility]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const terrainEnabled = layerVisibility?.terrain !== false;
    const buildingsEnabled = layerVisibility?.buildings !== false;
    let cancelled = false;

    const canUseViewer = () =>
      !cancelled &&
      viewerRef.current === viewer &&
      !(typeof viewer.isDestroyed === "function" && viewer.isDestroyed());

    const ensureTerrain = async () => {
      // Reuse cached terrain provider when available to avoid repeated network work.
      if (terrainProviderRef.current) {
        if (!canUseViewer()) return;
        viewer.terrainProvider = terrainProviderRef.current;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.verticalExaggeration = TERRAIN_EXAGGERATION;
        viewer.scene.requestRender();
        return;
      }
      if (terrainLoadingRef.current) {
        await terrainLoadingRef.current;
        return;
      }
      terrainLoadingRef.current = (async () => {
        try {
          if (CESIUM_TERRAIN_URL) {
            terrainProviderRef.current = await CesiumTerrainProvider.fromUrl(CESIUM_TERRAIN_URL);
          } else if (CESIUM_ION_TOKEN) {
            terrainProviderRef.current = await createWorldTerrainAsync({
              requestWaterMask: true,
              requestVertexNormals: true,
            });
          } else {
            throw new Error("no terrain source configured");
          }
          if (terrainProviderRef.current && canUseViewer()) {
            viewer.terrainProvider = terrainProviderRef.current;
            viewer.scene.globe.depthTestAgainstTerrain = true;
            viewer.scene.verticalExaggeration = TERRAIN_EXAGGERATION;
          }
        } catch {
          if (!canUseViewer()) return;
          viewer.terrainProvider = new EllipsoidTerrainProvider();
          viewer.scene.globe.depthTestAgainstTerrain = false;
          viewer.scene.verticalExaggeration = 1;
        } finally {
          terrainLoadingRef.current = null;
          if (canUseViewer()) {
            viewer.scene.requestRender();
          }
        }
      })();
      await terrainLoadingRef.current;
    };

    const ensureBuildings = async () => {
      // Reuse cached 3D tileset instance if it already exists.
      if (buildingsRef.current && !buildingsRef.current.isDestroyed()) {
        if (!canUseViewer()) return;
        buildingsRef.current.show = true;
        if (!viewer.scene.primitives.contains(buildingsRef.current)) {
          viewer.scene.primitives.add(buildingsRef.current);
        }
        viewer.scene.requestRender();
        return;
      }
      if (buildingsLoadingRef.current) {
        await buildingsLoadingRef.current;
        return;
      }
      buildingsLoadingRef.current = (async () => {
        try {
          if (CESIUM_BUILDINGS_URL) {
            const tileset = await Cesium3DTileset.fromUrl(CESIUM_BUILDINGS_URL);
            if (!canUseViewer()) return;
            const addedTileset = viewer.scene.primitives.add(tileset);
            addedTileset.show = true;
            buildingsRef.current = addedTileset;
          } else if (CESIUM_ION_TOKEN) {
            const tileset = await Cesium3DTileset.fromIonAssetId(ION_BUILDINGS_ASSET_ID);
            if (!canUseViewer()) return;
            const addedTileset = viewer.scene.primitives.add(tileset);
            addedTileset.show = true;
            buildingsRef.current = addedTileset;
          } else {
            throw new Error("no buildings source configured");
          }
        } catch {
          // Do not fail map rendering if buildings are unavailable.
        } finally {
          buildingsLoadingRef.current = null;
          if (canUseViewer()) {
            viewer.scene.requestRender();
          }
        }
      })();
      await buildingsLoadingRef.current;
    };

    if (terrainEnabled) {
      void ensureTerrain();
    } else {
      viewer.terrainProvider = new EllipsoidTerrainProvider();
      viewer.scene.globe.depthTestAgainstTerrain = false;
      viewer.scene.verticalExaggeration = 1;
      viewer.scene.requestRender();
    }

    if (buildingsEnabled) {
      void ensureBuildings();
    } else if (buildingsRef.current && !buildingsRef.current.isDestroyed()) {
      buildingsRef.current.show = false;
      viewer.scene.requestRender();
    }

    return () => {
      cancelled = true;
    };
  }, [layerVisibility?.terrain, layerVisibility?.buildings]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const effectiveZoom = zoom || DEFAULT_ZOOM;
    const nextViewport = { lng: center[0], lat: center[1], zoom: effectiveZoom };
    const previous = lastViewportRef.current;
    // Skip camera animation when viewport inputs are effectively unchanged.
    if (
      previous &&
      Math.abs(previous.lng - nextViewport.lng) < 1e-6 &&
      Math.abs(previous.lat - nextViewport.lat) < 1e-6 &&
      Math.abs(previous.zoom - nextViewport.zoom) < 1e-3
    ) {
      return;
    }
    lastViewportRef.current = nextViewport;

    // Cancel any in-progress orbit before starting new flyTo.
    if (orbitListenerRef.current) {
      viewer.scene.preRender.removeEventListener(orbitListenerRef.current);
      orbitListenerRef.current = null;
      viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    }

    const shouldOrbit = orbitOnArrivalRef.current === true;
    const flyDuration = shouldOrbit ? 2.5 : 0.45;
    const cameraHeight = heightFromZoom(effectiveZoom);

    // Side effect: animate Cesium camera to externally controlled viewport.
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(center[0], center[1], cameraHeight),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: 0,
      },
      duration: flyDuration,
      pitchAdjustHeight: cameraHeight * 2,
      flyOverLongitude: undefined,
      flyOverLongitudeWeight: undefined,
      maximumHeight: undefined,
      easingFunction: undefined,
      complete: () => {
        if (!shouldOrbit) return;
        if (viewer.isDestroyed()) return;

        // Start orbit animation around the target point.
        const targetCenter = Cartesian3.fromDegrees(center[0], center[1], 0);
        const transform = Transforms.eastNorthUpToFixedFrame(targetCenter);
        viewer.camera.lookAtTransform(
          transform,
          new HeadingPitchRange(0, ORBIT_PITCH, cameraHeight)
        );

        let rotated = 0;
        let lastTime = Date.now();
        const orbitSpeed = CesiumMath.TWO_PI / ORBIT_DURATION_SECONDS;

        const orbitListener = () => {
          if (viewer.isDestroyed()) return;
          const now = Date.now();
          const dt = Math.min((now - lastTime) / 1000, 0.1); // cap dt to avoid jumps
          lastTime = now;
          const delta = orbitSpeed * dt;
          viewer.camera.rotateRight(delta);
          rotated += delta;

          if (rotated >= CesiumMath.TWO_PI) {
            // Orbit complete — clean up and restore normal camera.
            viewer.scene.preRender.removeEventListener(orbitListener);
            orbitListenerRef.current = null;
            viewer.camera.lookAtTransform(Matrix4.IDENTITY);
            onOrbitCompleteRef.current?.();
          }
        };

        orbitListenerRef.current = orbitListener;
        viewer.scene.preRender.addEventListener(orbitListener);
      },
    });
    viewer.scene.requestRender();
  }, [center, zoom]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !geoJsonLayers || geoJsonLayers.length === 0) return;

    // Update the visibility ref so async load completions see the latest toggle state.
    const visibleIds = new Set(geoJsonLayers.filter((l) => l.visible).map((l) => l.id));
    geoJsonVisibilityRef.current = visibleIds;

    const loadedMap = geoJsonDataSourcesRef.current;
    const getLayerDataSources = (layerId: string) => {
      const fillChunks: GeoJsonDataSource[] = [];
      for (let ci = 0; ; ci++) {
        const fillChunk = loadedMap.get(layerId + ":fill:" + ci);
        if (!fillChunk) break;
        fillChunks.push(fillChunk);
      }
      return {
        fillChunks,
        borders: loadedMap.get(layerId + ":borders") ?? null,
        labels: loadedMap.get(layerId + ":labels") ?? null,
      };
    };
    const removeLayerDataSources = (layerId: string) => {
      for (let ci = 0; ; ci++) {
        const fillChunk = loadedMap.get(layerId + ":fill:" + ci);
        if (!fillChunk) break;
        viewer.dataSources.remove(fillChunk, true);
        loadedMap.delete(layerId + ":fill:" + ci);
      }
      const borders = loadedMap.get(layerId + ":borders");
      if (borders) {
        viewer.dataSources.remove(borders, true);
        loadedMap.delete(layerId + ":borders");
      }
      const labels = loadedMap.get(layerId + ":labels");
      if (labels) {
        viewer.dataSources.remove(labels, true);
        loadedMap.delete(layerId + ":labels");
      }
      loadedMap.delete(layerId);
    };

    const addProcessedLayer = async (layer: GeoJsonLayerConfig, sourceGeoJson: Record<string, unknown>) => {
      const layerId = layer.id;
      delete sourceGeoJson.crs;
      const sanitizedGeoJson =
        layerId === "t-bioreg-g"
          ? sanitizeBioregionGlobalGeoJson(sourceGeoJson)
          : sourceGeoJson;
      if (!viewerRef.current || viewerRef.current.isDestroyed()) return;

      const rawFeatures = (sourceGeoJson as {
        features?: Array<{ properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }>
      }).features ?? [];
      const scopedFeatures = (sanitizedGeoJson as {
        features?: Array<{ properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }>
      }).features ?? rawFeatures;

      const explodedFeatures: Array<{ properties?: Record<string, unknown>; geometry: { type: string; coordinates: unknown }; type?: string }> = [];
      for (const feat of scopedFeatures) {
        if (!feat.geometry) continue;
        if (feat.geometry.type === "MultiPolygon") {
          const multiCoords = feat.geometry.coordinates as number[][][][];
          for (const polyCoords of multiCoords) {
            explodedFeatures.push({ ...feat, geometry: { type: "Polygon", coordinates: polyCoords } });
          }
        } else {
          explodedFeatures.push(feat);
        }
      }

      const FILL_CHUNK_SIZE = 100;
      const fillChunks: GeoJsonDataSource[] = [];
      for (let cStart = 0; cStart < explodedFeatures.length; cStart += FILL_CHUNK_SIZE) {
        const chunkFeats = explodedFeatures.slice(cStart, cStart + FILL_CHUNK_SIZE);
        try {
          const chunkDs = await GeoJsonDataSource.load(
            { type: "FeatureCollection", features: chunkFeats },
            { stroke: Color.TRANSPARENT, fill: Color.TRANSPARENT, strokeWidth: 0, clampToGround: true }
          );
          for (let j = 0; j < chunkDs.entities.values.length; j++) {
            const entity = chunkDs.entities.values[j];
            entity.label = undefined;
            if (entity.polygon) {
              const properties = chunkFeats[j]?.properties ?? {};
              const stableColorKey =
                extractRegionName(properties) ??
                (typeof properties.id === "string" ? properties.id : `${layerId}:${cStart + j}`);
              const baseColor = Color.fromCssColorString(
                REGION_PALETTE[stablePaletteIndex(stableColorKey)]
              );
              entity.polygon.material = baseColor.withAlpha(layer.fillAlpha) as unknown as typeof entity.polygon.material;
            }
          }
          fillChunks.push(chunkDs);
        } catch (err) {
          console.warn(`[MainMap] Fill chunk failed for "${layerId}" (features ${cStart}–${cStart + chunkFeats.length}):`, err);
        }
      }

      const borderDs = await GeoJsonDataSource.load(extractBorderLines(sanitizedGeoJson), {
        stroke: Color.fromCssColorString(layer.stroke),
        strokeWidth: layer.strokeWidth,
        fill: Color.TRANSPARENT,
        clampToGround: true,
      });
      for (const entity of borderDs.entities.values) {
        entity.label = undefined;
      }

      const labelDs = new GeoJsonDataSource(layerId + "-labels");
      const seenLabels = new Set<string>();
      const placedCenters: Array<[number, number]> = [];
      const minLabelSeparation = layer.labelMinSeparationDegrees ?? 0;
      for (const feat of scopedFeatures) {
        const props = feat.properties ?? {};
        const regionName = extractRegionName(props);
        if (!regionName || !feat.geometry) continue;
        if (seenLabels.has(regionName)) continue;
        seenLabels.add(regionName);
        const center = geometryCentroid(feat.geometry);
        if (!center) continue;
        if (
          minLabelSeparation > 0 &&
          placedCenters.some((existingCenter) => centerDistanceDegrees(existingCenter, center) < minLabelSeparation)
        ) {
          continue;
        }
        placedCenters.push(center);
        labelDs.entities.add(new Entity({
          position: new ConstantPositionProperty(Cartesian3.fromDegrees(center[0], center[1], 0)),
          label: {
            text: new ConstantProperty(regionName),
            font: new ConstantProperty("12px sans-serif"),
            fillColor: new ConstantProperty(Color.WHITE),
            style: new ConstantProperty(LabelStyle.FILL),
            outlineWidth: new ConstantProperty(0),
            showBackground: new ConstantProperty(false),
            horizontalOrigin: new ConstantProperty(HorizontalOrigin.CENTER),
            verticalOrigin: new ConstantProperty(VerticalOrigin.CENTER),
            heightReference: new ConstantProperty(HeightReference.CLAMP_TO_GROUND),
            disableDepthTestDistance: new ConstantProperty(Number.POSITIVE_INFINITY),
            scaleByDistance: new ConstantProperty(new NearFarScalar(500_000, 1.0, 8_000_000, 0.5)),
            distanceDisplayCondition: new ConstantProperty(
              new DistanceDisplayCondition(0, layerId === "overture-neighborhoods" ? 4_000_000 : 12_000_000)
            ),
          },
        }));
      }

      const shouldShow = geoJsonVisibilityRef.current.has(layerId);
      for (let ci = 0; ci < fillChunks.length; ci++) {
        fillChunks[ci].show = shouldShow;
        viewer.dataSources.add(fillChunks[ci]);
      }
      borderDs.show = shouldShow;
      labelDs.show = shouldShow && layer.showLabels;
      viewer.dataSources.add(borderDs);
      viewer.dataSources.add(labelDs);

      const previousSources = getLayerDataSources(layerId);
      removeLayerDataSources(layerId);
      loadedMap.set(layerId, new GeoJsonDataSource(layerId + "-sentinel"));
      for (let ci = 0; ci < fillChunks.length; ci++) {
        loadedMap.set(layerId + ":fill:" + ci, fillChunks[ci]);
      }
      loadedMap.set(layerId + ":borders", borderDs);
      loadedMap.set(layerId + ":labels", labelDs);

      for (const staleFillChunk of previousSources.fillChunks) {
        if (viewer.dataSources.contains(staleFillChunk)) {
          viewer.dataSources.remove(staleFillChunk, true);
        }
      }
      if (previousSources.borders && viewer.dataSources.contains(previousSources.borders)) {
        viewer.dataSources.remove(previousSources.borders, true);
      }
      if (previousSources.labels && viewer.dataSources.contains(previousSources.labels)) {
        viewer.dataSources.remove(previousSources.labels, true);
      }
      viewer.scene.requestRender();
    };

    const refreshViewportAwareLayers = () => {
      const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
      if (!(rect instanceof Rectangle)) return;

      const west = CesiumMath.toDegrees(rect.west);
      const south = CesiumMath.toDegrees(rect.south);
      const east = CesiumMath.toDegrees(rect.east);
      const north = CesiumMath.toDegrees(rect.north);
      const zoom = zoomFromHeight(viewer.camera.positionCartographic.height);

      for (const layer of geoJsonLayers.filter((candidate) => candidate.viewportAware)) {
        const layerId = layer.id;
        const shouldBeVisible = layer.visible && zoom >= (layer.minZoom ?? 0);

        if (!shouldBeVisible) {
          removeLayerDataSources(layerId);
          viewportLayerRequestKeysRef.current.delete(layerId);
          continue;
        }

        const requestKey = `${west.toFixed(3)}:${south.toFixed(3)}:${east.toFixed(3)}:${north.toFixed(3)}:${Math.floor(zoom)}`;
        if (viewportLayerRequestKeysRef.current.get(layerId) === requestKey) continue;
        viewportLayerRequestKeysRef.current.set(layerId, requestKey);

        const requestUrl = `${layer.url}?west=${encodeURIComponent(String(west))}&south=${encodeURIComponent(String(south))}&east=${encodeURIComponent(String(east))}&north=${encodeURIComponent(String(north))}&zoom=${encodeURIComponent(String(zoom))}`;
        void fetch(requestUrl)
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${requestUrl}`);
            return response.json();
          })
          .then(async (geojson: Record<string, unknown>) => {
            if (viewportLayerRequestKeysRef.current.get(layerId) !== requestKey) return;
            await addProcessedLayer(layer, geojson);
          })
          .catch((err) => {
            console.error(`[MainMap] Failed to load viewport GeoJSON layer "${layerId}":`, err);
          });
      }
    };

    refreshViewportAwareLayers();
    viewer.camera.moveEnd.addEventListener(refreshViewportAwareLayers);

    for (const layer of geoJsonLayers.filter((candidate) => !candidate.viewportAware)) {
      const existing = loadedMap.get(layer.id);

      if (existing) {
        // Toggle visibility for already-loaded data sources (fill chunks + borders + labels).
        for (let ci = 0; ; ci++) {
          const fillChunk = loadedMap.get(layer.id + ":fill:" + ci);
          if (!fillChunk) break;
          fillChunk.show = layer.visible;
        }
        const borders = loadedMap.get(layer.id + ":borders");
        if (borders) borders.show = layer.visible;
        const labels = loadedMap.get(layer.id + ":labels");
        if (labels) labels.show = layer.visible && layer.showLabels;
      } else if (layer.visible) {
        const layerId = layer.id;

        void fetch(layer.url)
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${layer.url}`);
            return response.json();
          })
          .then(async (geojson: Record<string, unknown>) => {
            await addProcessedLayer(layer, geojson);
          })
          .catch((err) => {
            console.error(`[MainMap] Failed to load GeoJSON layer "${layerId}":`, err);
          });
      }
    }

    // Hide data sources that are no longer in the active layer set.
    // Keys in loadedMap include suffixed variants (e.g. "eco-l1:borders", "eco-l1:labels"),
    // so strip the suffix before checking membership.
    const activeIds = new Set(geoJsonLayers.map((l) => l.id));
    for (const [id, ds] of loadedMap) {
      const baseId = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
      if (!activeIds.has(baseId)) {
        ds.show = false;
      }
    }

    viewer.scene.requestRender();

    return () => {
      viewer.camera.moveEnd.removeEventListener(refreshViewportAwareLayers);
    };
  }, [geoJsonLayers]);

  return React.createElement(
    "div",
    { className: className || "w-full h-full", style: { position: "relative" } },
    React.createElement("div", {
      ref: containerRef,
      style: { width: "100%", height: "100%" },
    }),
  );
};

export default MainMap;
