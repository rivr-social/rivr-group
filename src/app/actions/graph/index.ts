// helpers (internal utilities are not re-exported; only used by sibling modules)

// agents
export {
  fetchAgent,
  fetchPublicAgentById,
  fetchAgentByUsername,
  fetchPeople,
  fetchGroups,
  fetchAgentChildren,
  searchAgentsByName,
  searchAgentsByType,
  fetchAgentsNearby,
  fetchAllAgents,
  fetchAgentsByIds,
} from "./agents";

// feeds
export {
  fetchHomeFeed,
  fetchExploreFeed,
  fetchAgentFeed,
  fetchScopedHomeFeed,
} from "./feeds";

// profiles
export {
  fetchProfileData,
  fetchUserPosts,
  fetchUserEvents,
  fetchUserGroups,
  fetchReactionCountsForUser,
  fetchUserConnections,
} from "./profiles";
export type { ReactionCountsMap } from "./profiles";

// resources
export {
  fetchResourcesByOwner,
  fetchPublicResources,
  fetchAllResources,
  fetchMarketplaceListings,
  fetchMarketplaceListingById,
  fetchPostDetail,
  fetchEventDetail,
} from "./resources";

// places
export {
  fetchBasins,
  fetchLocales,
  fetchChapters,
  fetchGroupsByLocaleIds,
  fetchPeopleByLocaleIds,
} from "./places";

// groups
export {
  fetchGroupDetail,
  fetchGroupMemberList,
  fetchPeopleMemberList,
  fetchGroupRelationships,
  fetchGroupBadges,
} from "./groups";
export type { SerializedGroupRelationship, MemberInfo } from "./types";

// content
export {
  fetchUserBadges,
  fetchVouchersForGroup,
  fetchVoucherClaims,
  fetchMySavedListingIds,
  fetchMyReceipts,
  fetchEvents,
  fetchPlaces,
  fetchProjects,
} from "./content";

// search
export {
  semanticSearch,
  searchInScope,
  queryLedgerEntries,
} from "./search";
export type { SemanticSearchResult, LedgerQueryFilter, LedgerQueryResult } from "./types";

// composer
export {
  fetchAgentsForComposer,
  fetchResourcesForComposer,
} from "./composer";
