import { NextResponse } from "next/server"

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect width="128" height="128" rx="32" fill="#1b120c"/>
  <path d="M71 17c5 17-8 24-8 35 0 7 5 13 13 13 12 0 19-12 17-25 13 12 20 26 20 40 0 22-19 39-43 39S27 102 27 80c0-21 12-37 31-53 2 11 9 18 17 18 9 0 15-8 15-18 0-4-1-7-3-10-3 0-8 0-16 0Z" fill="#f97316"/>
  <path d="M67 53c10 8 16 16 16 27 0 10-8 18-18 18s-18-8-18-18c0-8 5-15 12-22 1 6 5 9 9 9 6 0 10-5 10-11 0-1 0-2-1-3Z" fill="#fdba74"/>
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
