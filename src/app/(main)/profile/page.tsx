import { Suspense } from "react";

import { redirectFederatedViewerHome } from "@/lib/federation/sovereign-viewer-redirect";

import ProfileClient from "./profile-client";
import ProfileLoading from "./loading";

/**
 * Server gate for the self-profile route.
 *
 * A federated viewer (canonical identity homed on another instance) is bounced
 * to their home `/profile` — their identity is authoritative there, not on this
 * local mirror. Local NextAuth users and the instance owner fall through to the
 * existing client profile. See {@link redirectFederatedViewerHome}.
 */
export default async function ProfilePage() {
  await redirectFederatedViewerHome("/profile");
  return (
    <Suspense fallback={<ProfileLoading />}>
      <ProfileClient />
    </Suspense>
  );
}
