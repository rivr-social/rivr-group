export type BookingDate = {
  date: string
  timeSlots: string[]
}

export type BookingSelection = {
  date: string
  slot: string
}

export function getBookingDatesFromMetadata(metadata: Record<string, unknown>): BookingDate[] {
  const raw = metadata.bookingDates
  if (!Array.isArray(raw)) return []

  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null
      const record = entry as Record<string, unknown>
      const date = typeof record.date === "string" ? record.date : ""
      const timeSlots = Array.isArray(record.timeSlots)
        ? Array.from(
            new Set(
              record.timeSlots.filter(
                (slot): slot is string => typeof slot === "string" && slot.trim().length > 0,
              ),
            ),
          ).sort((left, right) => left.localeCompare(right))
        : []

      if (!date || timeSlots.length === 0) return null
      return { date, timeSlots }
    })
    .filter((entry): entry is BookingDate => entry !== null)
}

export function hasBookableSchedule(metadata: Record<string, unknown>): boolean {
  return getBookingDatesFromMetadata(metadata).length > 0
}

export function isBookingSlotAvailable(
  metadata: Record<string, unknown>,
  selection: BookingSelection | null | undefined,
): boolean {
  if (!selection) return !hasBookableSchedule(metadata)

  return getBookingDatesFromMetadata(metadata).some(
    (booking) => booking.date === selection.date && booking.timeSlots.includes(selection.slot),
  )
}

export function consumeBookingSlot(
  metadata: Record<string, unknown>,
  selection: BookingSelection | null | undefined,
): Record<string, unknown> {
  if (!selection) return metadata

  const bookingDates = getBookingDatesFromMetadata(metadata)
  if (bookingDates.length === 0) return metadata

  const updatedBookingDates = bookingDates
    .map((booking) => {
      if (booking.date !== selection.date) return booking
      return {
        ...booking,
        timeSlots: booking.timeSlots.filter((slot) => slot !== selection.slot),
      }
    })
    .filter((booking) => booking.timeSlots.length > 0)

  return {
    ...metadata,
    bookingDates: updatedBookingDates,
  }
}
