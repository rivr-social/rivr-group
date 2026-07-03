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

/**
 * Decides the page background BEFORE first paint, so the final background is
 * the only one the user ever sees (no solid-color → water-jpg → crystalline
 * swap chain, no wasted jpg download on crystalline lanes).
 *
 * - On crystalline-enabled lanes (the global runtimes; plus the
 *   NEXT_PUBLIC_TESTA_BG=crystalline local-dev override, inlined at build
 *   time) it sets `body.crystalline-bg`, which shows the static CSS gradient
 *   layer and hides the water photo. On this sovereign instance the hostname
 *   never matches, so the water photo is the final background.
 * - It preloads the theme-correct water jpg so the photo lands with first
 *   paint instead of popping in later. The `theme` localStorage key + system
 *   fallback mirrors next-themes.
 *
 * Runs as the first child of <body> — synchronously during parse, before the
 * browser paints anything.
 */
const CRYSTALLINE_BOOT_SCRIPT = `(function(){try{var on=${
  process.env.NEXT_PUBLIC_TESTA_BG === "crystalline"
}||{"a.rivr.social":1,"app.rivr.social":1,"beta.rivr.social":1,"dev.rivr.social":1}[location.hostname]===1;if(on){document.body.classList.add("crystalline-bg");}else{var t=null;try{t=localStorage.getItem("theme")}catch(e){}var d=t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);var l=document.createElement("link");l.rel="preload";l.as="image";l.href=d?"/bg-dark.jpg":"/bg-light.jpg";document.head.appendChild(l);}}catch(e){}})();`;

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
      {/* suppressHydrationWarning: the boot script below adds `crystalline-bg`
          to <body> before React hydrates, exactly like next-themes does on
          <html>. */}
      <body className="min-h-screen" suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: CRYSTALLINE_BOOT_SCRIPT }} />
        {/* Fixed water background (sovereign lanes) — glass distortion refracts against this */}
        <div id="rivr-water-bg" />
        {/* Crystalline gradient background (global lanes) — shown via body.crystalline-bg */}
        <div id="rivr-crystalline-bg" aria-hidden="true" />
        {/* SVG filters for liquid glass effect — hidden, referenced by CSS url() */}
        <svg style={{ display: "none" }} aria-hidden="true">
          <filter id="glass-distortion-shell" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves={1} seed={5} result="turbulence" />
            <feComponentTransfer in="turbulence" result="mapped">
              <feFuncR type="gamma" amplitude={1} exponent={10} offset={0.5} />
              <feFuncG type="gamma" amplitude={0} exponent={1} offset={0} />
              <feFuncB type="gamma" amplitude={0} exponent={1} offset={0.5} />
            </feComponentTransfer>
            <feGaussianBlur in="turbulence" stdDeviation={2} result="softMap" />
            <feSpecularLighting in="softMap" surfaceScale={4} specularConstant={0.9} specularExponent={80} lightingColor="white" result="specLight">
              <fePointLight x={-200} y={-200} z={300} />
            </feSpecularLighting>
            <feComposite in="specLight" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="litImage" />
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale={36} xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves={1} seed={5} result="turbulence" />
            <feComponentTransfer in="turbulence" result="mapped">
              <feFuncR type="gamma" amplitude={1} exponent={10} offset={0.5} />
              <feFuncG type="gamma" amplitude={0} exponent={1} offset={0} />
              <feFuncB type="gamma" amplitude={0} exponent={1} offset={0.5} />
            </feComponentTransfer>
            <feGaussianBlur in="turbulence" stdDeviation={3} result="softMap" />
            <feSpecularLighting in="softMap" surfaceScale={5} specularConstant={1} specularExponent={100} lightingColor="white" result="specLight">
              <fePointLight x={-200} y={-200} z={300} />
            </feSpecularLighting>
            <feComposite in="specLight" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="litImage" />
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale={150} xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="glass-distortion-strong" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves={1} seed={5} result="turbulence" />
            <feComponentTransfer in="turbulence" result="mapped">
              <feFuncR type="gamma" amplitude={1} exponent={10} offset={0.5} />
              <feFuncG type="gamma" amplitude={0} exponent={1} offset={0} />
              <feFuncB type="gamma" amplitude={0} exponent={1} offset={0.5} />
            </feComponentTransfer>
            <feGaussianBlur in="turbulence" stdDeviation={3} result="softMap" />
            <feSpecularLighting in="softMap" surfaceScale={5} specularConstant={1} specularExponent={100} lightingColor="white" result="specLight">
              <fePointLight x={-200} y={-200} z={300} />
            </feSpecularLighting>
            <feComposite in="specLight" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="litImage" />
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale={80} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
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
