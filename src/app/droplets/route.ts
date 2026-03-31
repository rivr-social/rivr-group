import { NextResponse } from "next/server"

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect width="128" height="128" rx="32" fill="#091521"/>
  <path d="M64 18c16 20 30 36 30 56 0 18-13 32-30 32S34 92 34 74c0-20 14-36 30-56Z" fill="#38bdf8"/>
  <path d="M52 76c0 7 5 13 12 13 6 0 11-4 12-10 1-4 4-6 8-5-1 13-12 23-25 23-14 0-25-11-25-25 0-4 1-8 2-12 4 1 6 4 6 8 0 4 0 5 0 8Z" fill="#bae6fd"/>
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
