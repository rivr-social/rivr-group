import type { Metadata } from "next";

// All pages are dynamic — they depend on the database and user session.
export const dynamic = "force-dynamic";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { AuthGuard } from "@/components/auth-guard";
import { Toaster } from "sonner";
import { GlobalHeader } from "@/components/global-header";
import { PersonaBanner } from "@/components/persona-banner";
import { AppProvider } from "@/contexts/app-context";
import { UserProvider } from "@/contexts/user-context";
import { auth } from "@/auth";
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

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background">
        <SessionProvider session={session}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <UserProvider>
              <AppProvider>
                <GlobalHeader />
                <PersonaBanner />
                <AuthGuard>
                  <main className="pt-16 pb-16 md:pb-0">{children}</main>
                </AuthGuard>
                <Toaster />
              </AppProvider>
            </UserProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
