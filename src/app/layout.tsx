import type { Metadata } from "next";

// All pages are dynamic — they depend on the database and user session.
export const dynamic = "force-dynamic";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { AuthGuard } from "@/components/auth-guard";
import { Toaster } from "@/components/ui/toaster";
import { GlobalHeader } from "@/components/global-header";
import { PersonaBanner } from "@/components/persona-banner";
import { AppProvider } from "@/contexts/app-context";
import { UserProvider } from "@/contexts/user-context";
import { RemoteViewerProvider } from "@/contexts/remote-viewer-context";
import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { GroupAssistantBubble } from "@/components/group-assistant-bubble";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  title: "RIVR",
  description: "Social coordination platform for communities",
  icons: {
    icon: '/rivr-emoji.png',
    shortcut: '/rivr-emoji.png',
    apple: '/rivr-emoji.png',
  }
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

  // The admin assistant bubble is rendered app-wide, but only for the primary
  // group's owner/admins. The chat route re-checks the tier server-side; this
  // gate just avoids showing the launcher to members/visitors/anonymous.
  const primaryAgentId = getInstanceConfig().primaryAgentId;
  const viewerId = session?.user?.id ?? null;
  const showAssistantBubble = Boolean(
    viewerId && primaryAgentId && (await isGroupAdmin(viewerId, primaryAgentId)),
  );

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background">
        <SessionProvider session={session}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <RemoteViewerProvider>
              <UserProvider>
                <AppProvider>
                  <GlobalHeader />
                  <PersonaBanner />
                  <AuthGuard>
                    <main className="pt-16 pb-16 md:pb-0">{children}</main>
                  </AuthGuard>
                  <Toaster />
                  {showAssistantBubble && primaryAgentId ? (
                    <GroupAssistantBubble groupId={primaryAgentId} />
                  ) : null}
                </AppProvider>
              </UserProvider>
            </RemoteViewerProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
