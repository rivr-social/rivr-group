"use client";

/**
 * Displays a user's connections (followers/following) as a compact card
 * with avatar list.
 */

import Link from "next/link";
import { Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { User } from "@/lib/types";

interface UserConnectionsProps {
  connections: User[];
}

function getInitialsFromName(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function UserConnections({ connections }: UserConnectionsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="h-4 w-4" />
          Connections
          {connections.length > 0 ? (
            <span className="text-sm font-normal text-muted-foreground">
              ({connections.length})
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connections yet. Follow people and join groups to build your network.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {connections.slice(0, 12).map((user) => (
                <Link
                  key={user.id}
                  href={user.profileHref ?? `/profile/${user.username}`}
                  className="group"
                  title={user.name}
                >
                  <Avatar className="h-10 w-10 border-2 border-transparent group-hover:border-primary transition-colors">
                    <AvatarImage src={user.avatar} alt={user.name} />
                    <AvatarFallback>{getInitialsFromName(user.name)}</AvatarFallback>
                  </Avatar>
                </Link>
              ))}
            </div>
            {connections.length > 12 ? (
              <p className="text-xs text-muted-foreground">
                +{connections.length - 12} more connections
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
