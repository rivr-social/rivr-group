import { Globe, Instagram, Linkedin, Mail, Phone, Send, Shield } from "lucide-react";
import type { ReactNode } from "react";

const X_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const PLATFORM_ICONS: Record<string, ReactNode> = {
  website: <Globe className="h-3 w-3" />,
  x: X_ICON,
  instagram: <Instagram className="h-3 w-3" />,
  linkedin: <Linkedin className="h-3 w-3" />,
  telegram: <Send className="h-3 w-3" />,
  signal: <Shield className="h-3 w-3" />,
  phone: <Phone className="h-3 w-3" />,
  email: <Mail className="h-3 w-3" />,
};

const PLATFORM_ICONS_MD: Record<string, ReactNode> = {
  website: <Globe className="h-3.5 w-3.5" />,
  x: <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>,
  instagram: <Instagram className="h-3.5 w-3.5" />,
  linkedin: <Linkedin className="h-3.5 w-3.5" />,
  telegram: <Send className="h-3.5 w-3.5" />,
  signal: <Shield className="h-3.5 w-3.5" />,
  phone: <Phone className="h-3.5 w-3.5" />,
  email: <Mail className="h-3.5 w-3.5" />,
};

export function getSocialIcon(platform: string, size: "sm" | "md" = "sm"): ReactNode {
  const key = platform.toLowerCase();
  const icons = size === "md" ? PLATFORM_ICONS_MD : PLATFORM_ICONS;
  return icons[key] ?? (size === "md" ? <Globe className="h-3.5 w-3.5" /> : <Globe className="h-3 w-3" />);
}

export function getSocialHref(platform: string, value: string): string {
  const key = platform.toLowerCase();
  if (key === "phone") return `tel:${value}`;
  if (key === "email") return `mailto:${value}`;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://${value}`;
}

export function getSocialDisplayLabel(platform: string): string {
  const labels: Record<string, string> = {
    website: "Website",
    x: "X (Twitter)",
    instagram: "Instagram",
    linkedin: "LinkedIn",
    telegram: "Telegram",
    signal: "Signal",
    phone: "Phone",
    email: "Email",
  };
  return labels[platform.toLowerCase()] ?? platform;
}
