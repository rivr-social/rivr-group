/**
 * @fileoverview VisibilityScopeSelector - Multi-section scope picker for event visibility.
 *
 * Allows selecting locales, groups, and users to control who can see an event.
 * Groups and users are fetched based on the selected locales. Follows the
 * Popover + Command + Badge pattern from TagSelector.
 */
"use client"

import type React from "react"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { X, Eye } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { SearchableMultiSelect } from "@/components/searchable-select"
import { fetchGroups, fetchGroupsByLocaleIds, fetchPeople, fetchPeopleByLocaleIds, searchAgentsByName } from "@/app/actions/graph"

export interface VisibilityScopeState {
  localeIds: string[]
  groupIds: string[]
  userIds: string[]
}

interface VisibilityScopeSelectorProps {
  value: VisibilityScopeState
  onChange: (scope: VisibilityScopeState) => void
  locales: Array<{ id: string; name: string; basinId?: string }>
}

const DEBOUNCE_MS = 300

export function VisibilityScopeSelector({
  value,
  onChange,
  locales,
}: VisibilityScopeSelectorProps) {
  const normalizedLocaleIds = useMemo(
    () => value.localeIds.filter((localeId) => localeId && localeId !== "all"),
    [value.localeIds]
  )

  // Fetched data
  const [availableGroups, setAvailableGroups] = useState<
    Array<{ id: string; name: string; pathIds?: string[]; metadata?: Record<string, unknown> }>
  >([])
  const [availableUsers, setAvailableUsers] = useState<
    Array<{ id: string; name: string; pathIds?: string[]; metadata?: Record<string, unknown> }>
  >([])

  // Loading states
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [usersLoading, setUsersLoading] = useState(false)

  // Track which locale IDs each group/user was fetched for (for pruning)
  const groupLocaleMapRef = useRef<Map<string, Set<string>>>(new Map())
  const userLocaleMapRef = useRef<Map<string, Set<string>>>(new Map())

  // Derive locale associations from pathIds/chapterTags
  const deriveLocaleSet = useCallback(
    (agent: { pathIds?: string[]; metadata?: Record<string, unknown> }): Set<string> => {
      const localeSet = new Set<string>()
      const selectedSet = new Set(normalizedLocaleIds)
      const paths = agent.pathIds ?? []
      const chapterTags = Array.isArray(agent.metadata?.chapterTags)
        ? (agent.metadata.chapterTags as string[])
        : []
      for (const id of [...paths, ...chapterTags]) {
        if (selectedSet.has(id)) localeSet.add(id)
      }
      // If no specific match found, associate with all selected locales
      if (localeSet.size === 0) {
        normalizedLocaleIds.forEach((id) => localeSet.add(id))
      }
      return localeSet
    },
    [normalizedLocaleIds],
  )

  // Fetch groups when selected locales change
  useEffect(() => {
    let cancelled = false
    async function loadGroups() {
      setGroupsLoading(true)
      try {
        const groups = normalizedLocaleIds.length > 0
          ? await fetchGroupsByLocaleIds(normalizedLocaleIds)
          : await fetchGroups()
        if (cancelled) return
        const newMap = new Map<string, Set<string>>()
        for (const group of groups) {
          newMap.set(group.id, deriveLocaleSet(group))
        }
        groupLocaleMapRef.current = newMap
        setAvailableGroups(groups)
      } finally {
        if (!cancelled) setGroupsLoading(false)
      }
    }
    loadGroups()
    return () => {
      cancelled = true
    }
  }, [normalizedLocaleIds, deriveLocaleSet])

  // Fetch users with debounced search
  const userSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchUsers = useCallback(
    (query: string) => {
      if (userSearchTimerRef.current) {
        clearTimeout(userSearchTimerRef.current)
      }

      userSearchTimerRef.current = setTimeout(async () => {
        setUsersLoading(true)
        try {
          const people = normalizedLocaleIds.length > 0
            ? await fetchPeopleByLocaleIds(normalizedLocaleIds, query)
            : query && query.trim().length > 0
              ? await searchAgentsByName(query, 100)
              : await fetchPeople(50)
          const newMap = new Map<string, Set<string>>()
          for (const person of people) {
            newMap.set(person.id, deriveLocaleSet(person))
          }
          userLocaleMapRef.current = newMap
          setAvailableUsers(people)
        } finally {
          setUsersLoading(false)
        }
      }, DEBOUNCE_MS)
    },
    [normalizedLocaleIds, deriveLocaleSet],
  )

  // Trigger user fetch when locales change
  useEffect(() => {
    fetchUsers("")
    return () => {
      if (userSearchTimerRef.current) {
        clearTimeout(userSearchTimerRef.current)
      }
    }
  }, [fetchUsers])

  // Prune groups/users when locales change
  useEffect(() => {
    const selectedLocaleSet = new Set(normalizedLocaleIds)

    const validGroupIds = value.groupIds.filter((gid) => {
      const locales = groupLocaleMapRef.current.get(gid)
      if (!locales) return false
      return [...locales].some((lid) => selectedLocaleSet.has(lid))
    })

    const validUserIds = value.userIds.filter((uid) => {
      const locales = userLocaleMapRef.current.get(uid)
      if (!locales) return false
      return [...locales].some((lid) => selectedLocaleSet.has(lid))
    })

    const groupsPruned = validGroupIds.length !== value.groupIds.length
    const usersPruned = validUserIds.length !== value.userIds.length

    if (groupsPruned || usersPruned) {
      onChange({
        ...value,
        groupIds: validGroupIds,
        userIds: validUserIds,
      })
    }
  }, [normalizedLocaleIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // Remove helpers
  const removeLocale = (localeId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onChange({
      ...value,
      localeIds: value.localeIds.filter((id) => id !== localeId),
    })
  }

  const removeGroup = (groupId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onChange({
      ...value,
      groupIds: value.groupIds.filter((id) => id !== groupId),
    })
  }

  const removeUser = (userId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onChange({
      ...value,
      userIds: value.userIds.filter((id) => id !== userId),
    })
  }

  // Name lookup helpers
  const getLocaleName = (id: string) => {
    const locale = locales.find((l) => l.id === id)
    return locale ? locale.name : id
  }

  const getGroupName = (id: string) => {
    const group = availableGroups.find((g) => g.id === id)
    return group ? group.name : id
  }

  const getUserName = (id: string) => {
    const user = availableUsers.find((u) => u.id === id)
    return user ? user.name : id
  }

  const isEmpty =
    value.localeIds.length === 0 &&
    value.groupIds.length === 0 &&
    value.userIds.length === 0

  const localeOptions = useMemo(
    () =>
      locales.map((locale) => ({
        value: locale.id,
        label: locale.name,
        description: undefined,
        keywords: [locale.id, locale.name, locale.basinId ?? ""],
      })),
    [locales],
  )

  const groupOptions = useMemo(
    () =>
      availableGroups.map((group) => ({
        value: group.id,
        label: group.name,
        description:
          typeof group.metadata?.groupType === "string"
            ? `${String(group.metadata.groupType).charAt(0).toUpperCase()}${String(group.metadata.groupType).slice(1)} group`
            : undefined,
        keywords: [group.id, group.name, String(group.metadata?.groupType ?? "")],
      })),
    [availableGroups],
  )

  const userOptions = useMemo(
    () =>
      availableUsers.map((user) => ({
        value: user.id,
        label: user.name,
        description:
          typeof user.metadata?.username === "string" ? `@${String(user.metadata.username)}` : undefined,
        keywords: [user.id, user.name, String(user.metadata?.username ?? "")],
      })),
    [availableUsers],
  )

  return (
    <div className="rounded-lg border p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 text-sm font-medium">
        <Eye className="h-4 w-4 text-muted-foreground" />
        <span>Visibility Scope (Optional)</span>
      </div>

      {isEmpty && (
        <p className="text-sm text-muted-foreground">
          Public — visible to everyone
        </p>
      )}

      {/* Locales Section */}
      <ScopeSection label="Locales">
        <div className="space-y-2">
          {value.localeIds.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {value.localeIds.map((id) => (
                <Badge key={id} variant="secondary" className="inline-flex items-center gap-1">
                  {getLocaleName(id)}
                  <button
                    onClick={(e) => removeLocale(id, e)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                    <span className="sr-only">Remove</span>
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}
          <SearchableMultiSelect
            value={value.localeIds}
            onChange={(localeIds) => onChange({ ...value, localeIds })}
            options={localeOptions}
            placeholder="Select locales..."
            searchPlaceholder="Search locales..."
            emptyLabel="No locales found."
          />
        </div>
      </ScopeSection>

      {/* Groups Section */}
      <ScopeSection label="Groups">
        <div className="space-y-2">
          {value.groupIds.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {value.groupIds.map((id) => (
                <Badge key={id} variant="secondary" className="inline-flex items-center gap-1">
                  {getGroupName(id)}
                  <button
                    onClick={(e) => removeGroup(id, e)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                    <span className="sr-only">Remove</span>
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}

          <SearchableMultiSelect
            value={value.groupIds}
            onChange={(groupIds) => onChange({ ...value, groupIds })}
            options={groupOptions}
            placeholder={groupsLoading ? "Loading groups..." : "Select groups..."}
            searchPlaceholder="Search groups..."
            emptyLabel={groupsLoading ? "Loading groups..." : "No groups found."}
            disabled={groupsLoading}
          />
        </div>
      </ScopeSection>

      {/* Users Section */}
      <ScopeSection label="Users">
        <div className="space-y-2">
          {value.userIds.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {value.userIds.map((id) => (
                <Badge key={id} variant="secondary" className="inline-flex items-center gap-1">
                  {getUserName(id)}
                  <button
                    onClick={(e) => removeUser(id, e)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                    <span className="sr-only">Remove</span>
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}

          <SearchableMultiSelect
            value={value.userIds}
            onChange={(userIds) => onChange({ ...value, userIds })}
            options={userOptions}
            placeholder={usersLoading ? "Loading people..." : "Select people..."}
            searchPlaceholder="Search people..."
            emptyLabel={usersLoading ? "Loading people..." : "No people found."}
            disabled={usersLoading}
          />
        </div>
      </ScopeSection>
    </div>
  )
}

/** Small label wrapper for each scope section */
function ScopeSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}
