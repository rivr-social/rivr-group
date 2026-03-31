import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RIVR",
    short_name: "RIVR",
    description: "RIVR network and social coordination platform",
    start_url: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#0f172a",
    icons: [
      {
        src: "/rivr-emoji.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
  };
}
