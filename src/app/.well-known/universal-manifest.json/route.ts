import { NextResponse } from "next/server"
import { absoluteUrl } from "@/lib/structured-data"

export async function GET() {
  return NextResponse.json(
    {
      version: "0.1",
      context: "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld",
      schema: "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.json",
      endpoints: {
        person: absoluteUrl("/api/universal-manifest/person/{id}"),
        organization: absoluteUrl("/api/universal-manifest/organization/{id}"),
        project: absoluteUrl("/api/universal-manifest/project/{id}"),
        offer: absoluteUrl("/api/universal-manifest/offer/{id}"),
        event: absoluteUrl("/api/universal-manifest/event/{id}"),
        post: absoluteUrl("/api/universal-manifest/post/{id}"),
      },
    },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=300",
      },
    },
  )
}
