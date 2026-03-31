import { ImageResponse } from "next/og";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "linear-gradient(135deg, #0f172a 0%, #1d4ed8 100%)",
          color: "white",
          fontSize: 72,
          fontWeight: 700,
          letterSpacing: -2,
        }}
      >
        <div>RIVR</div>
        <div style={{ fontSize: 34, fontWeight: 500, marginTop: 24 }}>
          Coordinate local value flows
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
