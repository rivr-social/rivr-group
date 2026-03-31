import { describe, expect, it, vi } from "vitest"
import {
  absoluteUrl,
  buildOfferStructuredData,
  buildProfileStructuredData,
  buildProjectStructuredData,
} from "../structured-data"

describe("structured-data", () => {
  it("builds person JSON-LD for public profiles", () => {
    const data = buildProfileStructuredData(
      {
        id: "person-1",
        name: "Alex River",
        username: "alex",
        description: "Community builder",
        image: "/avatar.png",
        location: "Boulder, CO",
        chapterTags: ["boulder"],
        skills: ["coordination", "facilitation"],
        metadata: {
          website: "https://alex.example",
          socialLinks: {
            telegram: "https://t.me/alex",
          },
        },
      },
      { visibility: "public" },
    )

    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Person",
      url: absoluteUrl("/profile/alex"),
      name: "Alex River",
      sameAs: expect.arrayContaining(["https://alex.example", "https://t.me/alex"]),
      knowsAbout: ["coordination", "facilitation"],
    })
  })

  it("builds project JSON-LD with creator and scope tags", () => {
    const data = buildProjectStructuredData(
      {
        id: "project-1",
        name: "River Commons",
        description: "Watershed restoration",
        location: "Fort Collins",
        chapterTags: ["fort-collins"],
        tags: ["watershed", "restoration"],
        status: "active",
      },
      { visibility: "public", ownerName: "Jordan Lake" },
    )

    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Project",
      url: absoluteUrl("/projects/project-1"),
      creator: { "@type": "Person", name: "Jordan Lake" },
      additionalType: "active",
      keywords: "watershed, restoration",
    })
  })

  it("builds offer JSON-LD array for marketplace listings", () => {
    const entries = buildOfferStructuredData(
      {
        id: "offer-1",
        title: "Community Design Support",
        description: "Design session for local groups",
        price: "$45.00/hr",
        currency: "USD",
        type: "service",
        category: "design",
        location: "Denver",
        images: ["/listing.png"],
        seller: {
          id: "person-1",
          name: "Alex River",
          username: "alex",
        },
      },
      { visibility: "public" },
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Service",
      url: absoluteUrl("/marketplace/offer-1"),
      offers: {
        "@type": "Offer",
        priceCurrency: "USD",
        price: "45.00",
      },
    })
  })

  it("returns null/empty payloads when visibility is not search-publishable", () => {
    expect(
      buildProfileStructuredData(
        {
          id: "person-1",
          name: "Hidden User",
        },
        { visibility: "private" },
      ),
    ).toBeNull()

    expect(
      buildOfferStructuredData(
        {
          id: "offer-1",
          title: "Hidden Listing",
        },
        { visibility: "private" },
      ),
    ).toEqual([])
  })
})
