"use client"

/**
 * Augmented Reality view that overlays Three.js GLB models on a live camera feed,
 * positioning them at real-world GPS coordinates using device orientation sensors.
 *
 * Used in: map page AR tab.
 * Key props: `items` — same MapItem[] used by the Cesium map, `onBack` — return to map view.
 *
 * Sensor stack:
 * - Camera: getUserMedia({ video: { facingMode: "environment" } })
 * - Orientation: DeviceOrientationEvent (alpha/beta/gamma → Three.js camera rotation)
 * - GPS: navigator.geolocation.watchPosition (user lat/lng → object placement offsets)
 *
 * Coordinate conversion: lat/lng deltas → meters via equirectangular approximation,
 * then placed in Three.js world space at (eastMeters, 0, -northMeters).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import type { MapItem } from "@/components/modules/map"
import { cn } from "@/lib/utils"

/* ── Constants ── */

/** Meters per degree of latitude (approximate) */
const METERS_PER_DEG_LAT = 111_320

/** Maximum render distance in meters — items beyond this are culled */
const MAX_RENDER_DISTANCE_M = 2_000

/** Scale factor for GLB models in the AR scene */
const MODEL_SCALE = 5

/** Height offset (meters) above ground for placed models */
const MODEL_HEIGHT_OFFSET = 2

/** Default sphere radius for items without a GLB model */
const FALLBACK_SPHERE_RADIUS = 1.5

/* ── Types ── */

type ARPermissionState = "pending" | "requesting" | "granted" | "denied"

interface UserPosition {
  lat: number
  lng: number
  accuracy: number
  heading: number | null
}

interface DeviceOrientation {
  alpha: number // compass heading (0–360)
  beta: number  // front-back tilt (-180–180)
  gamma: number // left-right tilt (-90–90)
}

interface ARViewProps {
  items: MapItem[]
  onBack: () => void
}

/* ── Helpers ── */

/**
 * Converts the lat/lng difference between a map item and the user into
 * Three.js world-space coordinates (east = +x, north = -z).
 */
function geoToScenePosition(
  itemLat: number,
  itemLng: number,
  userLat: number,
  userLng: number,
): THREE.Vector3 {
  const latDiff = (itemLat - userLat) * METERS_PER_DEG_LAT
  const lngDiff =
    (itemLng - userLng) *
    METERS_PER_DEG_LAT *
    Math.cos(userLat * (Math.PI / 180))
  return new THREE.Vector3(lngDiff, MODEL_HEIGHT_OFFSET, -latDiff)
}

/**
 * Converts device orientation angles to a Three.js Euler rotation.
 * Uses the ZXY order which matches the way mobile devices report orientation.
 */
function orientationToEuler(
  alpha: number,
  beta: number,
  gamma: number,
): THREE.Euler {
  const alphaRad = THREE.MathUtils.degToRad(alpha)
  const betaRad = THREE.MathUtils.degToRad(beta)
  const gammaRad = THREE.MathUtils.degToRad(gamma)

  // Build quaternion from device orientation (ZXY convention)
  const quaternion = new THREE.Quaternion()
  const euler = new THREE.Euler(betaRad, alphaRad, -gammaRad, "ZXY")
  quaternion.setFromEuler(euler)

  // Apply screen orientation correction (assume portrait)
  const screenCorrection = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    -window.orientation
      ? THREE.MathUtils.degToRad(Number(window.orientation))
      : 0,
  )
  quaternion.multiply(screenCorrection)

  // Camera looks down -Z by default; rotate 90deg around X to align with "looking forward"
  const worldCorrection = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -Math.PI / 2,
  )
  quaternion.multiply(worldCorrection)

  return new THREE.Euler().setFromQuaternion(quaternion)
}

/**
 * Compass rose direction label from a heading in degrees.
 */
function headingToCardinal(heading: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  const index = Math.round(heading / 45) % 8
  return directions[index]
}

/* ── Component ── */

export default function ARView({ items, onBack }: ARViewProps) {
  /* refs */
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const modelsRef = useRef<Map<string, THREE.Object3D>>(new Map())
  const geoWatchRef = useRef<number | null>(null)
  const rafRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)

  /* state */
  const [cameraPermission, setCameraPermission] = useState<ARPermissionState>("pending")
  const [locationPermission, setLocationPermission] = useState<ARPermissionState>("pending")
  const [orientationAvailable, setOrientationAvailable] = useState(true)
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null)
  const [deviceOrientation, setDeviceOrientation] = useState<DeviceOrientation>({
    alpha: 0,
    beta: 0,
    gamma: 0,
  })
  const [selectedItem, setSelectedItem] = useState<MapItem | null>(null)
  const [isDesktop, setIsDesktop] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  /* ── Desktop detection ── */
  useEffect(() => {
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent,
      )
    setIsDesktop(!isMobile)
  }, [])

  /* ── Three.js scene setup ── */
  const initScene = useCallback(() => {
    if (!canvasRef.current) return

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      MAX_RENDER_DISTANCE_M * 2,
    )
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      alpha: true,
      antialias: true,
    })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    rendererRef.current = renderer

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.8)
    scene.add(ambient)

    const directional = new THREE.DirectionalLight(0xffffff, 1.2)
    directional.position.set(5, 10, 7)
    scene.add(directional)

    // Ground reference grid (subtle)
    const gridHelper = new THREE.GridHelper(100, 20, 0x00ff88, 0x004422)
    gridHelper.material.opacity = 0.15
    gridHelper.material.transparent = true
    scene.add(gridHelper)
  }, [])

  /* ── Camera stream ── */
  const startCamera = useCallback(async () => {
    setCameraPermission("requesting")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraPermission("granted")
    } catch {
      setCameraPermission("denied")
      setErrorMessage("Camera access is required for AR. Please allow camera permissions.")
    }
  }, [])

  /* ── GPS tracking ── */
  const startGeolocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationPermission("denied")
      setErrorMessage("Geolocation is not supported by this browser.")
      return
    }
    setLocationPermission("requesting")

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading: position.coords.heading,
        })
        setLocationPermission("granted")
      },
      (error) => {
        setLocationPermission("denied")
        switch (error.code) {
          case error.PERMISSION_DENIED:
            setErrorMessage("Location access denied. Please enable location services.")
            break
          case error.POSITION_UNAVAILABLE:
            setErrorMessage("Location information is unavailable.")
            break
          case error.TIMEOUT:
            setErrorMessage("Location request timed out.")
            break
          default:
            setErrorMessage("An unknown location error occurred.")
        }
      },
      { enableHighAccuracy: true, maximumAge: 1_000, timeout: 10_000 },
    )
    geoWatchRef.current = watchId
  }, [])

  /* ── Device orientation ── */
  const startOrientation = useCallback(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      setDeviceOrientation({
        alpha: event.alpha ?? 0,
        beta: event.beta ?? 0,
        gamma: event.gamma ?? 0,
      })
    }

    // iOS 13+ requires explicit permission request
    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">
    }
    if (typeof doe.requestPermission === "function") {
      doe.requestPermission().then((state) => {
        if (state === "granted") {
          window.addEventListener("deviceorientation", handleOrientation, true)
        } else {
          setOrientationAvailable(false)
        }
      }).catch(() => {
        setOrientationAvailable(false)
      })
    } else {
      window.addEventListener("deviceorientation", handleOrientation, true)
      // Detect if events actually fire
      const timeout = setTimeout(() => {
        setOrientationAvailable(false)
      }, 3_000)
      const onFirst = () => {
        clearTimeout(timeout)
        setOrientationAvailable(true)
        window.removeEventListener("deviceorientation", onFirst)
      }
      window.addEventListener("deviceorientation", onFirst)
    }

    return () => {
      window.removeEventListener("deviceorientation", handleOrientation, true)
    }
  }, [])

  /* ── Load GLB models for items ── */
  useEffect(() => {
    if (!sceneRef.current || !userPosition) return

    const scene = sceneRef.current
    const loader = new GLTFLoader()
    const currentModels = modelsRef.current

    for (const item of items) {
      if (!item.geo?.lat || !item.geo?.lng) continue

      const pos = geoToScenePosition(
        item.geo.lat,
        item.geo.lng,
        userPosition.lat,
        userPosition.lng,
      )

      // Skip items too far away
      const distance = pos.length()
      if (distance > MAX_RENDER_DISTANCE_M) {
        // Remove if it was previously loaded
        const existing = currentModels.get(item.id)
        if (existing) {
          scene.remove(existing)
          currentModels.delete(item.id)
        }
        continue
      }

      // Already loaded — just update position
      const existing = currentModels.get(item.id)
      if (existing) {
        existing.position.copy(pos)
        continue
      }

      if (item.modelUrl) {
        // Load GLB model
        loader.load(
          item.modelUrl,
          (gltf) => {
            const model = gltf.scene
            model.scale.setScalar(MODEL_SCALE)
            model.position.copy(pos)
            model.userData = { mapItem: item }
            scene.add(model)
            currentModels.set(item.id, model)
          },
          undefined,
          () => {
            // GLB load failed — add fallback sphere
            addFallbackMarker(scene, item, pos, currentModels)
          },
        )
      } else {
        // No model URL — add a colored sphere marker
        addFallbackMarker(scene, item, pos, currentModels)
      }
    }

    // Clean up items that are no longer in the list
    const itemIds = new Set(items.map((i) => i.id))
    for (const [id, obj] of currentModels) {
      if (!itemIds.has(id)) {
        scene.remove(obj)
        currentModels.delete(id)
      }
    }
  }, [items, userPosition])

  /* ── Render loop ── */
  useEffect(() => {
    if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return

    const renderer = rendererRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current

    let active = true

    const animate = () => {
      if (!active) return

      // Sync camera rotation to device orientation
      if (orientationAvailable) {
        const euler = orientationToEuler(
          deviceOrientation.alpha,
          deviceOrientation.beta,
          deviceOrientation.gamma,
        )
        camera.rotation.copy(euler)
      }

      // Slowly rotate fallback markers for visibility
      for (const obj of modelsRef.current.values()) {
        if (obj.userData.isFallback) {
          obj.rotation.y += 0.01
        }
      }

      renderer.render(scene, camera)
      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)

    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [deviceOrientation, orientationAvailable])

  /* ── Window resize handler ── */
  useEffect(() => {
    const handleResize = () => {
      if (!rendererRef.current || !cameraRef.current) return
      const w = window.innerWidth
      const h = window.innerHeight
      rendererRef.current.setSize(w, h)
      cameraRef.current.aspect = w / h
      cameraRef.current.updateProjectionMatrix()
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  /* ── Boot sequence ── */
  useEffect(() => {
    if (isDesktop) return

    initScene()
    startCamera()
    startGeolocation()
    const cleanupOrientation = startOrientation()

    return () => {
      // Cleanup camera stream
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop()
        }
      }
      // Cleanup geolocation watch
      if (geoWatchRef.current !== null) {
        navigator.geolocation.clearWatch(geoWatchRef.current)
      }
      // Cleanup renderer
      if (rendererRef.current) {
        rendererRef.current.dispose()
      }
      // Cleanup orientation
      cleanupOrientation?.()
      // Cancel animation frame
      cancelAnimationFrame(rafRef.current)
    }
  }, [isDesktop, initScene, startCamera, startGeolocation, startOrientation])

  /* ── Raycaster for tapping models ── */
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!cameraRef.current || !sceneRef.current) return

      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return

      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )

      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(mouse, cameraRef.current)

      const objects = Array.from(modelsRef.current.values())
      const intersects = raycaster.intersectObjects(objects, true)

      if (intersects.length > 0) {
        // Walk up to find the root object with mapItem userData
        let target: THREE.Object3D | null = intersects[0].object
        while (target && !target.userData.mapItem) {
          target = target.parent
        }
        if (target?.userData.mapItem) {
          setSelectedItem(target.userData.mapItem as MapItem)
        }
      } else {
        setSelectedItem(null)
      }
    },
    [],
  )

  /* ── Desktop fallback ── */
  if (isDesktop) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-zinc-900 text-white p-6 text-center">
        <div className="text-6xl mb-4">📱</div>
        <h2 className="text-xl font-semibold mb-2">AR Requires a Mobile Device</h2>
        <p className="text-zinc-400 max-w-md mb-6">
          The augmented reality view uses your device camera, GPS, and gyroscope to place
          community items in the real world. Open this page on a phone or tablet with a camera.
        </p>
        <button
          onClick={onBack}
          className="px-4 py-2 bg-white text-zinc-900 rounded-lg font-medium hover:bg-zinc-200 transition-colors"
        >
          Back to Map
        </button>
      </div>
    )
  }

  /* ── Permission / loading states ── */
  const isLoading =
    cameraPermission === "pending" ||
    cameraPermission === "requesting" ||
    locationPermission === "pending" ||
    locationPermission === "requesting"

  const hasError = cameraPermission === "denied" || locationPermission === "denied"

  if (hasError) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-zinc-900 text-white p-6 text-center">
        <div className="text-4xl mb-4">⚠️</div>
        <h2 className="text-lg font-semibold mb-2">Permission Required</h2>
        <p className="text-zinc-400 max-w-md mb-4">{errorMessage}</p>
        <div className="flex gap-3">
          <button
            onClick={onBack}
            className="px-4 py-2 bg-zinc-700 text-white rounded-lg font-medium hover:bg-zinc-600 transition-colors"
          >
            Back to Map
          </button>
          <button
            onClick={() => {
              setCameraPermission("pending")
              setLocationPermission("pending")
              setErrorMessage(null)
              startCamera()
              startGeolocation()
            }}
            className="px-4 py-2 bg-white text-zinc-900 rounded-lg font-medium hover:bg-zinc-200 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  /* ── Compass heading ── */
  const compassHeading = deviceOrientation.alpha
  const cardinalDirection = headingToCardinal(compassHeading)

  /* ── Nearby items count ── */
  const nearbyCount = userPosition
    ? items.filter((item) => {
        if (!item.geo?.lat || !item.geo?.lng) return false
        const pos = geoToScenePosition(
          item.geo.lat,
          item.geo.lng,
          userPosition.lat,
          userPosition.lng,
        )
        return pos.length() <= MAX_RENDER_DISTANCE_M
      }).length
    : 0

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-black">
      {/* Camera feed */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        playsInline
        muted
        autoPlay
      />

      {/* Three.js overlay canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        onClick={handleCanvasClick}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/80 text-white">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-white border-t-transparent mb-4" />
          <p className="text-sm text-zinc-300">
            {cameraPermission === "requesting"
              ? "Requesting camera access..."
              : locationPermission === "requesting"
                ? "Getting your location..."
                : "Initializing AR..."}
          </p>
        </div>
      )}

      {/* Top bar: back button + compass */}
      <div className="absolute top-3 left-3 right-3 z-20 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-3 py-2 bg-black/60 backdrop-blur-sm rounded-full text-white text-sm font-medium"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Map
        </button>

        {/* Compass */}
        <div className="flex items-center gap-2 px-3 py-2 bg-black/60 backdrop-blur-sm rounded-full text-white text-sm">
          <div
            className="h-5 w-5 relative"
            style={{ transform: `rotate(${-compassHeading}deg)` }}
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
              <path d="M12 2L16 10H8L12 2Z" fill="#ef4444" />
              <path d="M12 22L8 14H16L12 22Z" fill="#ffffff" />
            </svg>
          </div>
          <span className="font-mono text-xs w-8 text-center">
            {cardinalDirection}
          </span>
        </div>
      </div>

      {/* Bottom info bar */}
      <div className="absolute bottom-6 left-3 right-3 z-20">
        {/* Status indicators */}
        <div className="flex items-center justify-center gap-3 mb-3">
          <div
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-full text-xs",
              locationPermission === "granted"
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-zinc-700/60 text-zinc-400",
            )}
          >
            <div
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                locationPermission === "granted" ? "bg-emerald-400" : "bg-zinc-500",
              )}
            />
            GPS {userPosition ? `±${Math.round(userPosition.accuracy)}m` : "..."}
          </div>

          <div
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-full text-xs",
              orientationAvailable
                ? "bg-blue-500/20 text-blue-300"
                : "bg-zinc-700/60 text-zinc-400",
            )}
          >
            <div
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                orientationAvailable ? "bg-blue-400" : "bg-zinc-500",
              )}
            />
            {orientationAvailable ? "Gyro" : "No gyro"}
          </div>

          <div className="flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-purple-500/20 text-purple-300">
            <div className="h-1.5 w-1.5 rounded-full bg-purple-400" />
            {nearbyCount} nearby
          </div>
        </div>

        {/* Selected item card */}
        {selectedItem && (
          <div className="bg-black/70 backdrop-blur-md rounded-xl p-3 border border-white/10">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-medium text-sm">
                  {selectedItem.name || "Unknown"}
                </h3>
                <p className="text-zinc-400 text-xs mt-0.5">
                  {selectedItem.type
                    ? selectedItem.type.charAt(0).toUpperCase() + selectedItem.type.slice(1)
                    : "Item"}
                  {userPosition && selectedItem.geo
                    ? ` • ${Math.round(
                        geoToScenePosition(
                          selectedItem.geo.lat,
                          selectedItem.geo.lng,
                          userPosition.lat,
                          userPosition.lng,
                        ).length(),
                      )}m away`
                    : ""}
                </p>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                className="text-zinc-400 hover:text-white p-1"
                aria-label="Dismiss"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Orientation unavailable notice */}
      {!orientationAvailable && cameraPermission === "granted" && (
        <div className="absolute top-16 left-3 right-3 z-20 bg-amber-900/80 backdrop-blur-sm rounded-lg px-3 py-2 text-amber-200 text-xs text-center">
          Gyroscope not available — items shown at fixed positions relative to camera
        </div>
      )}
    </div>
  )
}

/* ── Internal helpers ── */

function addFallbackMarker(
  scene: THREE.Scene,
  item: MapItem,
  position: THREE.Vector3,
  models: Map<string, THREE.Object3D>,
) {
  const typeColors: Record<string, number> = {
    event: 0xf59e0b,
    group: 0x3b82f6,
    post: 0x10b981,
    offering: 0x8b5cf6,
  }
  const color = typeColors[item.type || ""] ?? 0xffffff

  const geometry = new THREE.SphereGeometry(FALLBACK_SPHERE_RADIUS, 16, 16)
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.85,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(position)
  mesh.userData = { mapItem: item, isFallback: true }

  // Add a pulsing ring around the sphere
  const ringGeometry = new THREE.RingGeometry(
    FALLBACK_SPHERE_RADIUS * 1.5,
    FALLBACK_SPHERE_RADIUS * 1.8,
    32,
  )
  const ringMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
  })
  const ring = new THREE.Mesh(ringGeometry, ringMaterial)
  ring.rotation.x = -Math.PI / 2
  mesh.add(ring)

  scene.add(mesh)
  models.set(item.id, mesh)
}
