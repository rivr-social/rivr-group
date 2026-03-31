/**
 * @fileoverview ProfileCalendar - Calendar view for a user's upcoming events.
 *
 * Shown on the user profile page. Displays a month calendar with event indicators
 * and a sidebar of upcoming events for the selected date.
 */
"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChevronLeft, ChevronRight, Calendar, Clock, MapPin, ExternalLink, Briefcase, PartyPopper, Wrench } from "lucide-react"
import type { JobShift } from "@/types/domain"
import Link from "next/link"
import { Event, MarketplaceListing } from "@/lib/types"

// Common interface for calendar items
interface CalendarItem {
  id: string
  title: string
  date: Date
  type: 'shift' | 'event' | 'service'
  priority?: string
  color: string
  link: string
  time?: string
  location?: string
}

interface ProfileCalendarProps {
  userShifts: JobShift[]
  userEvents?: Event[]
  userServices?: MarketplaceListing[]
  currentUserId: string
}

// Helper functions for calendar items - Updated color coding
const getTypeColor = (type: 'shift' | 'event' | 'service', _priority?: string) => {
  switch (type) {
    case 'shift': 
      return 'bg-green-500' // Jobs = green
    case 'service':
      return 'bg-yellow-500' // Trips = yellow  
    case 'event':
      return 'bg-red-500' // Bookings = red
    default: 
      return 'bg-gray-500'
  }
}

const formatTime = (dateString: string) => {
  return new Date(dateString).toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true 
  })
}

export function ProfileCalendar({ userShifts, userEvents = [], userServices = [], currentUserId }: ProfileCalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [viewMode, setViewMode] = useState<'month' | 'week'>('month')

  // Get current month and year
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  // Get first day of the month and number of days
  const firstDayOfMonth = new Date(year, month, 1)
  const lastDayOfMonth = new Date(year, month + 1, 0)
  const daysInMonth = lastDayOfMonth.getDate()
  const startingDayOfWeek = firstDayOfMonth.getDay()

  // Convert shifts to calendar items
  const shiftItems: CalendarItem[] = userShifts
    .filter(shift => shift.assignees.includes(currentUserId) && shift.deadline)
    .map(shift => ({
      id: shift.id,
      title: shift.title,
      date: new Date(shift.deadline!),
      type: 'shift',
      priority: shift.priority,
      color: getTypeColor('shift'),
      link: `/jobs/${shift.id}`,
      time: formatTime(shift.deadline!),
      location: shift.location
    }))

  // Convert events to calendar items
  const eventItems: CalendarItem[] = userEvents
    .filter(event => event.timeframe?.start)
    .map(event => ({
      id: event.id,
      title: event.name,
      date: new Date(event.timeframe!.start),
      type: 'event',
      color: getTypeColor('event'),
      link: `/events/${event.id}`,
      time: formatTime(event.timeframe!.start),
      location: event.location?.name
    }))

  // Convert services to calendar items
  const serviceItems: CalendarItem[] = userServices
    .filter(service => service.type === 'service' && service.serviceDetails?.bookingDates?.length)
    .flatMap(service => 
      service.serviceDetails!.bookingDates.flatMap(booking => 
        booking.timeSlots.map(timeSlot => ({
          id: `${service.id}-${booking.date}-${timeSlot}`,
          title: service.title,
          date: new Date(`${booking.date} ${timeSlot}`),
          type: 'service',
          color: getTypeColor('service'),
          link: `/marketplace/${service.id}`,
          time: timeSlot,
          location: service.location
        }))
      )
    )

  // Combine all calendar items
  const allCalendarItems = [...shiftItems, ...eventItems, ...serviceItems]

  // Get items for current month
  const monthItems = allCalendarItems.filter(item => 
    item.date.getFullYear() === year && item.date.getMonth() === month
  )

  // Get items for selected date
  const selectedDateItems = selectedDate 
    ? allCalendarItems.filter(item => 
        item.date.toDateString() === selectedDate.toDateString()
      )
    : []

  // Generate calendar days
  const calendarDays = []
  
  // Add empty cells for days before the first day of the month
  for (let i = 0; i < startingDayOfWeek; i++) {
    calendarDays.push(null)
  }
  
  // Add days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day)
    const itemsForDay = monthItems.filter(item => 
      item.date.getDate() === day
    )
    calendarDays.push({ day, date, items: itemsForDay })
  }

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ]

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

  const navigateMonth = (direction: 'prev' | 'next') => {
    setCurrentDate(prev => {
      const newDate = new Date(prev)
      if (direction === 'prev') {
        newDate.setMonth(newDate.getMonth() - 1)
      } else {
        newDate.setMonth(newDate.getMonth() + 1)
      }
      return newDate
    })
    setSelectedDate(null)
  }

  // Get week start date (Sunday)
  const getWeekStart = (date: Date) => {
    const start = new Date(date)
    start.setDate(date.getDate() - date.getDay())
    return start
  }

  // Get week days
  const getWeekDays = () => {
    const weekStart = getWeekStart(currentDate)
    const days = []
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart)
      day.setDate(weekStart.getDate() + i)
      days.push(day)
    }
    return days
  }

  const weekDays = getWeekDays()
  const weekItems = allCalendarItems.filter(item => {
    const weekStart = getWeekStart(currentDate)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    return item.date >= weekStart && item.date <= weekEnd
  })

  const navigateWeek = (direction: 'prev' | 'next') => {
    setCurrentDate(prev => {
      const newDate = new Date(prev)
      if (direction === 'prev') {
        newDate.setDate(newDate.getDate() - 7)
      } else {
        newDate.setDate(newDate.getDate() + 7)
      }
      return newDate
    })
    setSelectedDate(null)
  }

  const formatWeekRange = () => {
    const weekStart = getWeekStart(currentDate)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    
    if (weekStart.getMonth() === weekEnd.getMonth()) {
      return `${monthNames[weekStart.getMonth()]} ${weekStart.getDate()}-${weekEnd.getDate()}, ${weekStart.getFullYear()}`
    } else {
      return `${monthNames[weekStart.getMonth()]} ${weekStart.getDate()} - ${monthNames[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekStart.getFullYear()}`
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Calendar */}
      <div className="lg:col-span-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between mb-4">
              <CardTitle className="flex items-center">
                <Calendar className="h-5 w-5 mr-2" />
                My Schedule
              </CardTitle>
              <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as 'month' | 'week')}>
                <TabsList>
                  <TabsTrigger value="month">Month</TabsTrigger>
                  <TabsTrigger value="week">Week</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => viewMode === 'month' ? navigateMonth('prev') : navigateWeek('prev')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="font-medium min-w-[200px] text-center">
                {viewMode === 'month' ? `${monthNames[month]} ${year}` : formatWeekRange()}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => viewMode === 'month' ? navigateMonth('next') : navigateWeek('next')}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {viewMode === 'month' ? (
              <>
                {/* Month View */}
                <div className="grid grid-cols-7 gap-1 mb-4">
                  {dayNames.map(dayName => (
                    <div key={dayName} className="p-2 text-center text-sm font-medium text-muted-foreground">
                      {dayName}
                    </div>
                  ))}
                </div>
                
                <div className="grid grid-cols-7 gap-1">
                  {calendarDays.map((dayData, index) => (
                    <div
                      key={index}
                      className={`
                        min-h-[80px] p-1 border rounded-lg cursor-pointer transition-colors
                        ${dayData ? 'hover:bg-muted/50' : ''}
                        ${selectedDate && dayData?.date.toDateString() === selectedDate.toDateString()
                          ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800'
                          : 'border-border'
                        }
                      `}
                      onClick={() => dayData && setSelectedDate(dayData.date)}
                    >
                      {dayData && (
                        <>
                          <div className="text-sm font-medium mb-1">
                            {dayData.day}
                          </div>
                          <div className="space-y-1">
                            {dayData.items.slice(0, 2).map(item => (
                              <Link key={item.id} href={item.link}>
                                <div
                                  className={`
                                    text-xs px-1 py-0.5 rounded text-white truncate hover:opacity-80 transition-opacity cursor-pointer
                                    ${item.color}
                                  `}
                                  title={`${item.title} - Click to view details`}
                                >
                                  {item.title.length > 12 
                                    ? `${item.title.substring(0, 12)}...` 
                                    : item.title
                                  }
                                </div>
                              </Link>
                            ))}
                            {dayData.items.length > 2 && (
                              <div 
                                className="text-xs text-muted-foreground cursor-pointer hover:text-foreground"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setSelectedDate(dayData.date)
                                }}
                                title="Click to see all items for this day"
                              >
                                +{dayData.items.length - 2} more
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                {/* Week View */}
                <div className="grid grid-cols-7 gap-2">
                  {weekDays.map((day, index) => {
                    const dayItems = weekItems.filter(item => 
                      item.date.toDateString() === day.toDateString()
                    )
                    const isToday = day.toDateString() === new Date().toDateString()
                    const isSelected = selectedDate?.toDateString() === day.toDateString()
                    
                    return (
                      <div key={index} className="border border-border rounded-lg">
                        <div
                          className={`
                            p-2 text-center border-b border-border cursor-pointer hover:bg-muted transition-colors
                            ${isToday ? 'bg-blue-100 dark:bg-blue-950/60 text-blue-900 dark:text-blue-200' : 'bg-muted/50'}
                            ${isSelected ? 'bg-blue-200 dark:bg-blue-900/50' : ''}
                          `}
                          onClick={() => setSelectedDate(day)}
                        >
                          <div className="text-xs font-medium">{dayNames[day.getDay()]}</div>
                          <div className={`text-lg font-bold ${isToday ? 'text-blue-900 dark:text-blue-200' : ''}`}>
                            {day.getDate()}
                          </div>
                        </div>
                        <div 
                          className={`
                            min-h-[200px] p-2 cursor-pointer transition-colors
                            ${isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-muted/50'}
                          `}
                          onClick={() => setSelectedDate(day)}
                        >
                          <div className="space-y-2">
                            {dayItems.map(item => (
                              <div
                                key={item.id}
                                className={`
                                  text-xs p-2 rounded text-white hover:opacity-80 transition-opacity cursor-pointer
                                  ${item.color}
                                `}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  window.location.href = item.link
                                }}
                              >
                                <div className="font-medium truncate" title={item.title}>
                                  {item.title.length > 20 ? `${item.title.substring(0, 20)}...` : item.title}
                                </div>
                                <div className="text-white/80 mt-1">
                                  {item.time || ''}
                                </div>
                                {item.location && (
                                  <div className="text-white/70 text-xs mt-1 flex items-center">
                                    <MapPin className="h-3 w-3 mr-1" /> {item.location}
                                  </div>
                                )}
                              </div>
                            ))}
                            {dayItems.length === 0 && (
                              <div className="text-xs text-muted-foreground text-center py-4">
                                No items
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            
            {/* Legend */}
            <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t">
              <span className="text-sm text-muted-foreground">Item Types:</span>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-red-500 rounded"></div>
                <span className="text-xs">Shift (High)</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-yellow-500 rounded"></div>
                <span className="text-xs">Shift (Medium)</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-green-500 rounded"></div>
                <span className="text-xs">Shift (Low)</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-purple-500 rounded"></div>
                <span className="text-xs">Event</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-blue-500 rounded"></div>
                <span className="text-xs">Service</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Selected Day Details */}
      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {selectedDate 
                ? `${selectedDate.toLocaleDateString([], { 
                    weekday: 'long', 
                    month: 'long', 
                    day: 'numeric' 
                  })}`
                : 'Select a Date'
              }
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedDate ? (
              selectedDateItems.length > 0 ? (
                <div className="space-y-4">
                  {selectedDateItems.map(item => (
                    <div key={item.id} className="border border-border rounded-lg p-3">
                      <div className="flex items-start justify-between mb-2">
                        <Link href={item.link}>
                          <h4 className="font-medium text-sm hover:text-blue-600 hover:underline cursor-pointer">
                            {item.title}
                          </h4>
                        </Link>
                        <Badge 
                          variant="secondary"
                          className={`
                            text-white text-xs
                            ${item.color}
                          `}
                        >
                          {item.type}
                        </Badge>
                      </div>
                      <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                        {item.time && (
                          <div className="flex items-center">
                            <Clock className="h-3.5 w-3.5 mr-1.5" />
                            {item.time}
                          </div>
                        )}
                        
                        {item.location && (
                          <div className="flex items-center">
                            <MapPin className="h-3.5 w-3.5 mr-1.5" />
                            {item.location}
                          </div>
                        )}
                        
                        <div className="flex items-center">
                          {item.type === 'shift' && <Briefcase className="h-3.5 w-3.5 mr-1.5" />}
                          {item.type === 'event' && <PartyPopper className="h-3.5 w-3.5 mr-1.5" />}
                          {item.type === 'service' && <Wrench className="h-3.5 w-3.5 mr-1.5" />}
                          {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-end mt-3 pt-2 border-t">
                        <Link href={item.link}>
                          <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
                            <ExternalLink className="h-3 w-3 mr-1" />
                            View Details
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No items scheduled for this day</p>
                </div>
              )
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Click on a date to see your scheduled items</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-lg">
              {viewMode === 'month' ? 'This Month' : 'This Week'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Total Items</span>
                <span className="font-medium">
                  {viewMode === 'month' ? monthItems.length : weekItems.length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Shifts</span>
                <span className="font-medium text-muted-foreground">
                  {(viewMode === 'month' ? monthItems : weekItems).filter(item => item.type === 'shift').length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Events</span>
                <span className="font-medium text-purple-600">
                  {(viewMode === 'month' ? monthItems : weekItems).filter(item => item.type === 'event').length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Services</span>
                <span className="font-medium text-blue-600">
                  {(viewMode === 'month' ? monthItems : weekItems).filter(item => item.type === 'service').length}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}