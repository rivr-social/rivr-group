"use client"

import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Receipt } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { getPrimaryListingImage } from "@/lib/listing-images"
import { formatMarketplaceListingTypeLabel } from "@/lib/listing-types"

interface ReceiptCardProps {
  receiptId: string
  listingId: string
  title: string
  description: string
  price: string
  images: string[]
  type: string
  category?: string
  location?: string
  purchaseDate: string
  status: string
  seller: {
    id: string
    name: string
    username: string | null
    image: string | null
  } | null
}

export function ReceiptCard({
  receiptId,
  listingId,
  title,
  description,
  price,
  images,
  type,
  location,
  purchaseDate,
  status,
  seller,
}: ReceiptCardProps) {
  const router = useRouter()

  const statusColor = status === "completed" ? "default"
    : status === "refunded" ? "destructive"
    : "secondary"

  const handleClick = () => {
    router.push(`/marketplace/${listingId}/receipt/${receiptId}`)
  }

  return (
    <Card className="overflow-hidden cursor-pointer hover:shadow-md transition-shadow" onClick={handleClick}>
      <div className="relative h-48 w-full">
        {images.length > 0 ? (
          <Image src={getPrimaryListingImage({ images })} alt={title} fill className="object-cover" />
        ) : (
          <div className="h-full w-full bg-muted flex items-center justify-center">
            <p className="text-muted-foreground">No image</p>
          </div>
        )}
        <Badge className="absolute top-2 left-2 bg-green-600 hover:bg-green-700">
          <Receipt className="h-3 w-3 mr-1" />
          Receipt
        </Badge>
        <Badge
          className="absolute top-2 right-2"
          variant={type === "product" ? "default" : "secondary"}
        >
          {formatMarketplaceListingTypeLabel(type)}
        </Badge>
      </div>

      <CardContent className="p-4">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-semibold text-lg line-clamp-1">{title}</h3>
            <p className="text-xl font-bold">{price}</p>
          </div>
          <Badge variant={statusColor}>
            {status === "refund_requested" ? "Refund Pending" : status.charAt(0).toUpperCase() + status.slice(1)}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground mt-1">
          Purchased {new Date(purchaseDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </p>

        <p className="text-muted-foreground text-sm mt-2 line-clamp-2">{description}</p>

        {seller && (
          <div className="flex items-center mt-3 text-sm text-muted-foreground">
            <Link
              href={`/profile/${seller.username || seller.id}`}
              className="flex items-center"
              onClick={(e) => e.stopPropagation()}
            >
              <Avatar className="h-6 w-6 mr-2">
                <AvatarImage src={seller.image || "/placeholder.svg"} alt={seller.name} />
                <AvatarFallback className="text-xs">{seller.name.charAt(0)}</AvatarFallback>
              </Avatar>
              <span>{seller.name}</span>
            </Link>
            {location && (
              <>
                <span className="mx-2">&bull;</span>
                <span>{location}</span>
              </>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="p-4 pt-0">
        <Button variant="outline" size="sm" className="w-full" onClick={(e) => { e.stopPropagation(); handleClick(); }}>
          <Receipt className="h-4 w-4 mr-2" />
          View Receipt
        </Button>
      </CardFooter>
    </Card>
  )
}
