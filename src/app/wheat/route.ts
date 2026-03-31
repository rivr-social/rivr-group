import { NextResponse } from "next/server"

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect width="128" height="128" rx="32" fill="#1a1206"/>
  <path d="M64 22v84" stroke="#fbbf24" stroke-width="6" stroke-linecap="round"/>
  <path d="M64 40c-10-1-18-9-18-19 10 1 18 9 18 19Zm0 0c10-1 18-9 18-19-10 1-18 9-18 19Zm0 18c-10-1-18-9-18-19 10 1 18 9 18 19Zm0 0c10-1 18-9 18-19-10 1-18 9-18 19Zm0 18c-10-1-18-9-18-19 10 1 18 9 18 19Zm0 0c10-1 18-9 18-19-10 1-18 9-18 19Z" fill="#fde68a"/>
</svg>
`.trim()

export function GET() {
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
