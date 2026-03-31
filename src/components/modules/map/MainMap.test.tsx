// @vitest-environment happy-dom
import React from "react";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";

// ---- Hoisted mock variables (must be hoisted so vi.mock factories can reference them) ----

const {
  mockViewerDestroy,
  mockEntitiesAdd,
  mockEntitiesRemoveAll,
  mockRequestRender,
  mockCameraFlyTo,
  mockScenePick,
  mockClickHandlerDestroy,
  mockSetInputAction,
  mockImageryLayersRemoveAll,
  mockImageryLayersAdd,
  mockPrimitivesContains,
  mockPrimitivesRemove,
  mockPrimitivesAdd,
  mockViewerInstance,
  mockClickHandlerInstance,
} = vi.hoisted(() => {
  const mockViewerDestroy = vi.fn();
  const mockViewerIsDestroyed = vi.fn().mockReturnValue(false);
  const mockEntitiesAdd = vi.fn();
  const mockEntitiesRemoveAll = vi.fn();
  const mockViewerResize = vi.fn();
  const mockRequestRender = vi.fn();
  const mockCameraFlyTo = vi.fn();
  const mockScenePick = vi.fn().mockReturnValue(null);
  const mockClickHandlerDestroy = vi.fn();
  const mockSetInputAction = vi.fn();
  const mockImageryLayersRemoveAll = vi.fn();
  const mockImageryLayersAdd = vi.fn();
  const mockImageryLayersGet = vi.fn().mockReturnValue({ show: true, alpha: 1 });
  const mockPrimitivesContains = vi.fn().mockReturnValue(false);
  const mockPrimitivesRemove = vi.fn();
  const mockPrimitivesAdd = vi.fn((value: unknown) => value);
  const mockPreRenderAddEventListener = vi.fn();
  const mockPreRenderRemoveEventListener = vi.fn();
  const mockDataSourcesAdd = vi.fn();
  const mockDataSourcesRemove = vi.fn();
  const mockCameraLookAtTransform = vi.fn();
  const mockCameraRotateRight = vi.fn();

  const mockViewerInstance = {
    destroy: mockViewerDestroy,
    isDestroyed: mockViewerIsDestroyed,
    entities: {
      add: mockEntitiesAdd,
      removeAll: mockEntitiesRemoveAll,
    },
    resize: mockViewerResize,
    scene: {
      requestRender: mockRequestRender,
      pick: mockScenePick,
      screenSpaceCameraController: {},
      fog: { enabled: true },
      skyBox: { show: true },
      skyAtmosphere: { show: true },
      sun: { show: true },
      moon: { show: true },
      backgroundColor: null,
      globe: {
        show: true,
        enableLighting: false,
        showGroundAtmosphere: false,
        baseColor: null,
        depthTestAgainstTerrain: false,
        maximumScreenSpaceError: 4,
        getHeight: vi.fn().mockReturnValue(0),
      },
      verticalExaggeration: 1,
      preRender: {
        addEventListener: mockPreRenderAddEventListener,
        removeEventListener: mockPreRenderRemoveEventListener,
      },
      primitives: {
        contains: mockPrimitivesContains,
        remove: mockPrimitivesRemove,
        add: mockPrimitivesAdd,
      },
    },
    camera: {
      heading: 0,
      pitch: 0,
      flyTo: mockCameraFlyTo,
      lookAtTransform: mockCameraLookAtTransform,
      rotateRight: mockCameraRotateRight,
      positionCartographic: { longitude: 0, latitude: 0, height: 1000 },
      positionWC: {},
    },
    canvas: document.createElement("canvas"),
    cesiumWidget: {
      creditContainer: document.createElement("div"),
    },
    imageryLayers: {
      removeAll: mockImageryLayersRemoveAll,
      add: mockImageryLayersAdd,
      addImageryProvider: mockImageryLayersAdd,
      get: mockImageryLayersGet,
    },
    terrainProvider: null,
    dataSources: {
      add: mockDataSourcesAdd,
      remove: mockDataSourcesRemove,
    },
  };

  const mockClickHandlerInstance = {
    destroy: mockClickHandlerDestroy,
    setInputAction: mockSetInputAction,
  };

  return {
    mockViewerDestroy,
    mockViewerIsDestroyed,
    mockEntitiesAdd,
    mockEntitiesRemoveAll,
    mockViewerResize,
    mockRequestRender,
    mockCameraFlyTo,
    mockScenePick,
    mockClickHandlerDestroy,
    mockSetInputAction,
    mockImageryLayersRemoveAll,
    mockImageryLayersAdd,
    mockImageryLayersGet,
    mockPrimitivesContains,
    mockPrimitivesRemove,
    mockPrimitivesAdd,
    mockViewerInstance,
    mockClickHandlerInstance,
  };
});

// ---- Cesium mocks ----

vi.mock("cesium", () => {
  const mockColor = {
    withAlpha: vi.fn().mockReturnThis(),
    WHITE: { withAlpha: vi.fn().mockReturnValue({}) },
  };

  const Color = Object.assign(
    vi.fn().mockReturnValue(mockColor),
    {
      WHITE: mockColor.WHITE,
      fromCssColorString: vi.fn().mockReturnValue(mockColor),
    }
  );

  const Cartesian3 = Object.assign(
    vi.fn(function (x?: number, y?: number, z?: number) {
      return { x: x || 0, y: y || 0, z: z || 0 };
    }),
    {
      fromDegrees: vi.fn(function (lng: number, lat: number, height?: number) {
        return { x: lng, y: lat, z: height || 0 };
      }),
    }
  );

  const Cartesian2 = vi.fn(function (x?: number, y?: number) {
    return { x: x || 0, y: y || 0 };
  });

  const Entity = vi.fn(function () {
    return { id: "" };
  });

  const ScreenSpaceEventHandler = vi.fn(function () {
    return mockClickHandlerInstance;
  });

  const ScreenSpaceEventType = {
    LEFT_CLICK: 0,
    LEFT_DOUBLE_CLICK: 1,
    LEFT_DOWN: 2,
    LEFT_UP: 3,
    MIDDLE_CLICK: 4,
    MIDDLE_DOWN: 4,
    MOUSE_MOVE: 5,
    RIGHT_CLICK: 6,
    RIGHT_DOWN: 6,
    WHEEL: 7,
  };

  const HeightReference = {
    NONE: 0,
    CLAMP_TO_GROUND: 1,
    RELATIVE_TO_GROUND: 2,
  };

  const VerticalOrigin = {
    CENTER: 0,
    BOTTOM: 1,
    BASELINE: 2,
    TOP: -1,
  };

  const HorizontalOrigin = {
    CENTER: 0,
    LEFT: 1,
    RIGHT: -1,
  };

  const LabelStyle = {
    FILL: 0,
    OUTLINE: 1,
    FILL_AND_OUTLINE: 2,
  };

  const Ion = {
    defaultAccessToken: "",
  };

  const IonWorldImageryStyle = {
    AERIAL_WITH_LABELS: "AERIAL_WITH_LABELS",
  };

  const Viewer = vi.fn(function () {
    return mockViewerInstance;
  });

  const EllipsoidTerrainProvider = vi.fn(function () {
    return {};
  });

  const CesiumTerrainProvider = Object.assign(
    vi.fn(function () { return {}; }),
    {
      fromUrl: vi.fn().mockRejectedValue(new Error("no terrain URL")),
    }
  );

  const SingleTileImageryProvider = vi.fn(function () {
    return {};
  });

  const mockUrlProvider = {
    errorEvent: {
      addEventListener: vi.fn(),
    },
  };
  const UrlTemplateImageryProvider = vi.fn(function () {
    return mockUrlProvider;
  });

  const MapboxStyleImageryProvider = vi.fn(function () {
    return mockUrlProvider;
  });

  const ImageryLayer = vi.fn(function () {
    return { show: true, alpha: 1 };
  });

  const Cesium3DTileset = Object.assign(
    vi.fn(function () { return { show: true, isDestroyed: () => false }; }),
    {
      fromUrl: vi.fn().mockRejectedValue(new Error("no buildings URL")),
      fromIonAssetId: vi.fn().mockRejectedValue(new Error("no ion buildings")),
    }
  );

  const buildModuleUrl = vi.fn(function (path: string) { return `/Cesium/${path}`; });

  const defined = vi.fn(function (value: unknown) { return value !== undefined && value !== null; });

  const ConstantPositionProperty = vi.fn(function (value: unknown) { return value; });
  const ConstantProperty = vi.fn(function (value: unknown) { return value; });
  const DistanceDisplayCondition = vi.fn(function () { return {}; });
  const NearFarScalar = vi.fn(function () { return {}; });
  const GeoJsonDataSource = Object.assign(
    vi.fn(function () {
      return { entities: { add: vi.fn() }, show: true };
    }),
    {
      load: vi.fn().mockResolvedValue({ entities: { values: [] }, show: true }),
    },
  );
  const HeadingPitchRange = vi.fn(function () { return {}; });
  const Matrix4 = { IDENTITY: {} };
  const Transforms = {
    eastNorthUpToFixedFrame: vi.fn().mockReturnValue({}),
  };
  const createWorldImageryAsync = vi.fn().mockRejectedValue(new Error("no imagery"));
  const createWorldTerrainAsync = vi.fn().mockRejectedValue(new Error("no terrain"));
  const ArcGisBaseMapType = { SATELLITE: "SATELLITE" };
  const ArcGisMapServerImageryProvider = {
    fromBasemapType: vi.fn().mockRejectedValue(new Error("no arcgis")),
  };
  const CesiumMath = {
    TWO_PI: Math.PI * 2,
  };

  return {
    __esModule: true,
    ArcGisBaseMapType,
    ArcGisMapServerImageryProvider,
    Viewer,
    Cartesian2,
    Cartesian3,
    Color,
    ConstantPositionProperty,
    ConstantProperty,
    createWorldImageryAsync,
    createWorldTerrainAsync,
    DistanceDisplayCondition,
    Entity,
    GeoJsonDataSource,
    HeadingPitchRange,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    HeightReference,
    VerticalOrigin,
    HorizontalOrigin,
    IonWorldImageryStyle,
    LabelStyle,
    Math: CesiumMath,
    Matrix4,
    NearFarScalar,
    Transforms,
    Ion,
    EllipsoidTerrainProvider,
    CesiumTerrainProvider,
    SingleTileImageryProvider,
    UrlTemplateImageryProvider,
    MapboxStyleImageryProvider,
    ImageryLayer,
    Cesium3DTileset,
    buildModuleUrl,
    defined,
  };
});

vi.mock("cesium/Build/Cesium/Widgets/widgets.css", () => ({}));

// ---- Import mocked constructors for assertions ----

import { Viewer, Cartesian3, ScreenSpaceEventHandler, ScreenSpaceEventType } from "cesium";
import type { Mock } from "vitest";
import MainMap from "./MainMap";

function renderMainMap(props: React.ComponentProps<typeof MainMap>) {
  return render(React.createElement(MainMap, props));
}

describe("MainMap Component (CesiumJS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Initialization", () => {
    it("renders a map container div", () => {
      const { container } = renderMainMap({ items: [] });

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toBeTruthy();
      expect(wrapper.childElementCount).toBeGreaterThanOrEqual(1);

      const mapDiv = wrapper.children[0] as HTMLElement;
      expect(mapDiv).toBeTruthy();
      expect(mapDiv.getAttribute("style")).toContain("width: 100%");
      expect(mapDiv.getAttribute("style")).toContain("height: 100%");

      console.log("Map container div rendered with 100% width/height");
    });

    it("creates a Cesium Viewer targeting the container", () => {
      renderMainMap({ items: [] });

      expect(Viewer).toHaveBeenCalledTimes(1);
      const callArgs = (Viewer as unknown as Mock).mock.calls[0];
      // First argument is the container DOM element
      expect(callArgs[0]).toBeInstanceOf(HTMLElement);
      // Second argument is the options object
      expect(callArgs[1]).toHaveProperty("animation", false);
      expect(callArgs[1]).toHaveProperty("timeline", false);
      expect(callArgs[1]).toHaveProperty("geocoder", false);
      expect(callArgs[1]).toHaveProperty("baseLayer");

      console.log("Cesium Viewer instantiated with container element and options");
    });

    it("defaults to Boulder, CO center [-105.2705, 40.015]", () => {
      renderMainMap({ items: [] });

      expect(Cartesian3.fromDegrees).toHaveBeenCalled();
      const fromDegreesCalls = (Cartesian3.fromDegrees as Mock).mock.calls;
      // The camera.flyTo call in the init effect uses the default center
      const cameraCall = fromDegreesCalls.find(
        (call: number[]) => call[0] === -105.2705 && call[1] === 40.015
      );
      expect(cameraCall).toBeTruthy();

      console.log("Default center: [-105.2705, 40.015] passed to Cartesian3.fromDegrees");
    });

    it("accepts custom center and zoom props", () => {
      renderMainMap({ items: [], center: [-122.4194, 37.7749], zoom: 10 });

      const fromDegreesCalls = (Cartesian3.fromDegrees as Mock).mock.calls;
      const cameraCall = fromDegreesCalls.find(
        (call: number[]) => call[0] === -122.4194 && call[1] === 37.7749
      );
      expect(cameraCall).toBeTruthy();

      console.log("Custom center/zoom props passed through to Cartesian3.fromDegrees");
    });

    it("flies the camera to the initial position on mount", () => {
      renderMainMap({ items: [] });

      expect(mockCameraFlyTo).toHaveBeenCalled();
      const flyToArgs = mockCameraFlyTo.mock.calls[0][0];
      expect(flyToArgs).toHaveProperty("destination");
      expect(flyToArgs).toHaveProperty("duration");

      console.log("Camera flyTo called on mount with destination and duration");
    });

    it("applies className prop to container", () => {
      const { container } = renderMainMap({ items: [], className: "custom-map-class" });

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.className).toContain("custom-map-class");

      console.log("Custom className applied to wrapper");
    });

    it("uses default w-full h-full when no className given", () => {
      const { container } = renderMainMap({ items: [] });

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.className).toContain("w-full");
      expect(wrapper.className).toContain("h-full");

      console.log("Default w-full h-full className applied");
    });
  });

  describe("Entity Rendering", () => {
    const mockItems = [
      { id: "item-1", geo: { lat: 40.015, lng: -105.2705 }, name: "Event A", type: "event" },
      { id: "item-2", geo: { lat: 40.02, lng: -105.28 }, name: "Group B", type: "group" },
      { id: "item-3", geo: { lat: 40.01, lng: -105.26 }, name: "Place C", type: "place" },
    ];

    it("adds entities to the viewer for each item", () => {
      renderMainMap({ items: mockItems });

      expect(mockEntitiesAdd).toHaveBeenCalledTimes(mockItems.length);

      console.log(`${mockItems.length} entities added to the viewer`);
    });

    it("creates entities with correct ids matching item ids", () => {
      renderMainMap({ items: mockItems });

      const addedIds = mockEntitiesAdd.mock.calls.map(
        (call: Record<string, unknown>[]) => call[0].id
      );
      expect(addedIds).toContain("item-1");
      expect(addedIds).toContain("item-2");
      expect(addedIds).toContain("item-3");

      console.log("Entity ids match item ids: item-1, item-2, item-3");
    });

    it("positions entities using Cartesian3.fromDegrees with item coordinates", () => {
      renderMainMap({ items: mockItems });

      const fromDegreesCalls = (Cartesian3.fromDegrees as Mock).mock.calls;
      // Filter to entity position calls (height = 0) vs camera flyTo calls (height > 0)
      const entityPositionCalls = fromDegreesCalls.filter(
        (call: number[]) => call[2] === 0
      );

      expect(entityPositionCalls).toHaveLength(mockItems.length);

      // Verify each item's lng/lat was passed
      const coordPairs = entityPositionCalls.map((call: number[]) => [call[0], call[1]]);
      expect(coordPairs).toContainEqual([-105.2705, 40.015]);
      expect(coordPairs).toContainEqual([-105.28, 40.02]);
      expect(coordPairs).toContainEqual([-105.26, 40.01]);

      console.log("Cartesian3.fromDegrees called with correct lng/lat for each entity");
    });

    it("handles empty items array without errors", () => {
      expect(() => renderMainMap({ items: [] })).not.toThrow();

      // With no items, entities.removeAll is called but no add calls for items
      expect(mockEntitiesRemoveAll).toHaveBeenCalled();

      console.log("Empty items array handled gracefully");
    });

    it("clears previous entities when items change", () => {
      const { rerender } = renderMainMap({ items: mockItems });
      mockEntitiesRemoveAll.mockClear();
      mockEntitiesAdd.mockClear();

      rerender(React.createElement(MainMap, { items: [mockItems[0]] }));

      expect(mockEntitiesRemoveAll).toHaveBeenCalled();
      expect(mockEntitiesAdd).toHaveBeenCalledTimes(1);

      console.log("Previous entities cleared and new ones added on item update");
    });

    it("requests a scene render after updating entities", () => {
      mockRequestRender.mockClear();
      renderMainMap({ items: mockItems });

      expect(mockRequestRender).toHaveBeenCalled();

      console.log("scene.requestRender called after entity updates");
    });
  });

  describe("Event Handlers", () => {
    it("creates a ScreenSpaceEventHandler for click events", () => {
      renderMainMap({ items: [] });

      expect(ScreenSpaceEventHandler).toHaveBeenCalledTimes(2);

      console.log("ScreenSpaceEventHandler created for click handling");
    });

    it("registers a LEFT_CLICK input action", () => {
      renderMainMap({ items: [] });

      expect(mockSetInputAction).toHaveBeenCalled();
      const leftClickRegistration = mockSetInputAction.mock.calls.find(
        (call: unknown[]) => call[1] === ScreenSpaceEventType.LEFT_CLICK,
      );
      expect(leftClickRegistration).toBeTruthy();
      expect(typeof leftClickRegistration?.[0]).toBe("function");

      console.log("LEFT_CLICK input action registered on the handler");
    });

    it("accepts onMarkerClick callback prop without error", () => {
      const onMarkerClick = vi.fn();

      expect(() =>
        renderMainMap({ items: [], onMarkerClick })
      ).not.toThrow();

      console.log("onMarkerClick callback accepted as prop");
    });
  });

  describe("Cleanup", () => {
    it("destroys the Cesium Viewer on unmount", () => {
      const { unmount } = renderMainMap({ items: [] });

      unmount();

      expect(mockViewerDestroy).toHaveBeenCalledTimes(1);

      console.log("Viewer.destroy() called on unmount");
    });

    it("destroys the ScreenSpaceEventHandler on unmount", () => {
      const { unmount } = renderMainMap({ items: [] });

      unmount();

      expect(mockClickHandlerDestroy).toHaveBeenCalledTimes(2);

      console.log("ScreenSpaceEventHandler.destroy() called on unmount");
    });
  });

  describe("Component Interface", () => {
    it("is a valid React functional component", () => {
      expect(MainMap).toBeDefined();
      expect(typeof MainMap).toBe("function");

      console.log("MainMap is a valid React functional component");
    });

    it("does not require an Ion access token to render", () => {
      delete process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;

      expect(() => renderMainMap({ items: [] })).not.toThrow();

      console.log("No Cesium Ion token required to render");
    });
  });
});
