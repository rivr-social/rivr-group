"use client";

/**
 * GroupPersonaManager — admin surface for a group's own personas.
 *
 * The group-app analogue of the user-facing `PersonaManager` (which manages the
 * signed-in account's personas). These personas are CHILD agents of the GROUP
 * agent (`parent_agent_id = groupId`, `metadata.isGroupPersona = true`) — the
 * group's public-facing sub-identities and the carriers of the group's AI
 * assistant flag (`metadata.autobotEnabled`).
 *
 * Backed entirely by the admin-gated server actions in
 * `@/app/actions/group-personas`:
 *   - create / list / update / delete group personas, and
 *   - `setGroupPersonaAutobotEnabled` — designate which persona (or none) acts
 *     as the group's AI assistant. At most one persona is ever enabled.
 *
 * This card is only rendered inside `/groups/[id]/settings`, which redirects
 * non-admins before mount, so it inherits that admin gate; every mutation is
 * additionally re-checked server-side by `isGroupAdmin`.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { Bot, BotOff, Drama, Edit2, Plus, Trash2 } from "lucide-react";
import {
  createGroupPersona,
  deleteGroupPersona,
  listGroupPersonas,
  setGroupPersonaAutobotEnabled,
  updateGroupPersona,
} from "@/app/actions/group-personas";
import type { SerializedAgent } from "@/lib/graph-serializers";

interface PersonaFormState {
  name: string;
  username: string;
  bio: string;
}

const EMPTY_FORM: PersonaFormState = { name: "", username: "", bio: "" };

/**
 * Reads the truthy `autobotEnabled` flag from a persona's metadata, tolerating
 * the snake_case variant the resolver also accepts.
 */
function isAutobotEnabled(persona: SerializedAgent): boolean {
  const metadata = persona.metadata ?? {};
  return (
    metadata.autobotEnabled === true ||
    metadata.autobot_enabled === true ||
    String(metadata.autobotEnabled).toLowerCase() === "true"
  );
}

export function GroupPersonaManager({ groupId }: { groupId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [personas, setPersonas] = useState<SerializedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPersona, setEditingPersona] = useState<SerializedAgent | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState<PersonaFormState>(EMPTY_FORM);

  const activePersonaId = personas.find(isAutobotEnabled)?.id ?? null;

  const refresh = useCallback(async () => {
    try {
      const result = await listGroupPersonas(groupId);
      if (result.success && result.personas) {
        setPersonas(result.personas);
      } else if (result.error) {
        toast({ title: result.error, variant: "destructive" });
      }
    } catch {
      // Silently fail on load; the empty-state guidance still renders.
    } finally {
      setLoading(false);
    }
  }, [groupId, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setActionLoading(true);
    try {
      const result = await createGroupPersona({
        groupId,
        name: form.name.trim(),
        username: form.username.trim() || undefined,
        bio: form.bio.trim() || undefined,
      });
      if (result.success) {
        toast({ title: "Persona created" });
        setCreateOpen(false);
        setForm(EMPTY_FORM);
        await refresh();
      } else {
        toast({ title: result.error ?? "Failed to create persona", variant: "destructive" });
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingPersona) return;
    setActionLoading(true);
    try {
      const result = await updateGroupPersona({
        groupId,
        personaId: editingPersona.id,
        name: form.name.trim() || undefined,
        username: form.username.trim() || undefined,
        bio: form.bio.trim() || undefined,
      });
      if (result.success) {
        toast({ title: "Persona updated" });
        setEditingPersona(null);
        setForm(EMPTY_FORM);
        await refresh();
      } else {
        toast({ title: result.error ?? "Failed to update persona", variant: "destructive" });
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    setActionLoading(true);
    try {
      const result = await deleteGroupPersona({ groupId, personaId: deleteConfirmId });
      if (result.success) {
        toast({ title: "Persona deleted" });
        setDeleteConfirmId(null);
        await refresh();
      } else {
        toast({ title: result.error ?? "Failed to delete persona", variant: "destructive" });
      }
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * Designate (or clear, with `personaId = null`) which persona acts as the
   * group's AI assistant. Enabling one clears the flag on the others.
   */
  const handleSetAssistant = async (personaId: string | null) => {
    setActionLoading(true);
    try {
      const result = await setGroupPersonaAutobotEnabled({ groupId, personaId });
      if (result.success) {
        toast({
          title: personaId
            ? "Assistant persona updated"
            : "Assistant persona cleared — the group agent identity is used",
        });
        await refresh();
        // The assistant config card resolves the direct agent server-side, so
        // refresh the route to keep the Assistant tab in sync.
        router.refresh();
      } else {
        toast({ title: result.error ?? "Failed to update assistant persona", variant: "destructive" });
      }
    } finally {
      setActionLoading(false);
    }
  };

  const openEdit = (persona: SerializedAgent) => {
    const metadata = persona.metadata ?? {};
    setForm({
      name: persona.name,
      username: typeof metadata.username === "string" ? metadata.username : "",
      bio: typeof metadata.bio === "string" ? metadata.bio : "",
    });
    setEditingPersona(persona);
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Drama className="h-5 w-5" />
            Group Personas
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Drama className="h-5 w-5" />
                Group Personas
              </CardTitle>
              <CardDescription>
                Alternate public identities for this group. Designate one as the
                group&apos;s AI assistant, or leave none and the assistant runs as the
                group itself.
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setForm(EMPTY_FORM);
                setCreateOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Create Persona
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Active assistant-persona banner */}
          {activePersonaId && (
            <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Bot className="h-4 w-4 text-primary" />
                <span>
                  AI assistant runs as{" "}
                  <strong>
                    {personas.find((p) => p.id === activePersonaId)?.name ?? "persona"}
                  </strong>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSetAssistant(null)}
                disabled={actionLoading}
              >
                <BotOff className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
          )}

          {personas.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No personas yet. Create one to give the group an alternate public
              identity or a dedicated AI-assistant persona.
            </p>
          ) : (
            <div className="space-y-2">
              {personas.map((persona) => {
                const metadata = persona.metadata ?? {};
                const username =
                  typeof metadata.username === "string" ? metadata.username : null;
                const bio = typeof metadata.bio === "string" ? metadata.bio : null;
                const isAssistant = persona.id === activePersonaId;

                return (
                  <div
                    key={persona.id}
                    className={`flex items-center gap-3 rounded-md border p-3 transition-colors ${
                      isAssistant ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    <div className="relative">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={persona.image ?? undefined} alt={persona.name} />
                        <AvatarFallback>
                          {persona.name.substring(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {isAssistant && (
                        <div className="absolute -bottom-1 -right-1 rounded-full bg-primary p-0.5">
                          <Bot className="h-3 w-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{persona.name}</span>
                        {username && (
                          <span className="text-xs text-muted-foreground">@{username}</span>
                        )}
                        {isAssistant && (
                          <Badge variant="default" className="text-xs">
                            AI assistant
                          </Badge>
                        )}
                      </div>
                      {bio && (
                        <p className="text-xs text-muted-foreground truncate">{bio}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      {!isAssistant && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleSetAssistant(persona.id)}
                          disabled={actionLoading}
                          title="Use this persona as the group's AI assistant"
                        >
                          <Bot className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(persona)}
                        title="Edit persona"
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteConfirmId(persona.id)}
                        title="Delete persona"
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Group Persona</DialogTitle>
            <DialogDescription>
              An alternate public identity for this group. It can carry the
              group&apos;s AI assistant.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label htmlFor="group-persona-name">Name *</Label>
              <Input
                id="group-persona-name"
                placeholder="Persona display name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="group-persona-username">Username</Label>
              <Input
                id="group-persona-username"
                placeholder="optional_username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                maxLength={40}
              />
            </div>
            <div>
              <Label htmlFor="group-persona-bio">Bio</Label>
              <Textarea
                id="group-persona-bio"
                placeholder="A short description of this persona"
                value={form.bio}
                onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
                maxLength={500}
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={actionLoading}>
                {actionLoading ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingPersona} onOpenChange={(open) => !open && setEditingPersona(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Group Persona</DialogTitle>
            <DialogDescription>
              Update this persona&apos;s profile information.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label htmlFor="edit-group-persona-name">Name</Label>
              <Input
                id="edit-group-persona-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="edit-group-persona-username">Username</Label>
              <Input
                id="edit-group-persona-username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                maxLength={40}
              />
            </div>
            <div>
              <Label htmlFor="edit-group-persona-bio">Bio</Label>
              <Textarea
                id="edit-group-persona-bio"
                value={form.bio}
                onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
                maxLength={500}
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditingPersona(null)}>
                Cancel
              </Button>
              <Button onClick={handleUpdate} disabled={actionLoading}>
                {actionLoading ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Persona</DialogTitle>
            <DialogDescription>
              This will permanently remove this group persona and all its content.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={actionLoading}>
              {actionLoading ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default GroupPersonaManager;
