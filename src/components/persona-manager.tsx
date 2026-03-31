"use client";

/**
 * PersonaManager component.
 *
 * Renders the persona management panel for the profile page: lists existing
 * personas, shows which is active, and provides create/edit/delete/switch controls.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Drama, Edit2, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import {
  createPersona,
  deletePersona,
  listMyPersonas,
  switchActivePersona,
  updatePersona,
} from "@/app/actions/personas";
import type { SerializedAgent } from "@/lib/graph-serializers";

interface PersonaFormState {
  name: string;
  username: string;
  bio: string;
}

const EMPTY_FORM: PersonaFormState = { name: "", username: "", bio: "" };

export function PersonaManager() {
  const router = useRouter();
  const { toast } = useToast();
  const [personas, setPersonas] = useState<SerializedAgent[]>([]);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPersona, setEditingPersona] = useState<SerializedAgent | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState<PersonaFormState>(EMPTY_FORM);

  const refresh = useCallback(async () => {
    try {
      const result = await listMyPersonas();
      if (result.success && result.personas) {
        setPersonas(result.personas);
        setActivePersonaId(result.activePersonaId ?? null);
      }
    } catch {
      // Silently fail on load
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setActionLoading(true);
    try {
      const result = await createPersona({
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
      const result = await updatePersona({
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
      const result = await deletePersona(deleteConfirmId);
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

  const handleSwitch = async (personaId: string | null) => {
    setActionLoading(true);
    try {
      const result = await switchActivePersona(personaId);
      if (result.success) {
        setActivePersonaId(personaId);
        toast({
          title: personaId ? "Switched persona" : "Switched back to main account",
        });
        router.refresh();
      } else {
        toast({ title: result.error ?? "Failed to switch persona", variant: "destructive" });
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
            Personas
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
            <CardTitle className="flex items-center gap-2">
              <Drama className="h-5 w-5" />
              Personas
            </CardTitle>
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
          {/* Active persona banner */}
          {activePersonaId && (
            <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Drama className="h-4 w-4 text-primary" />
                <span>
                  Operating as{" "}
                  <strong>
                    {personas.find((p) => p.id === activePersonaId)?.name ?? "persona"}
                  </strong>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSwitch(null)}
                disabled={actionLoading}
              >
                <UserX className="h-4 w-4 mr-1" />
                Switch Back
              </Button>
            </div>
          )}

          {personas.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No personas yet. Create one to operate under an alternate identity.
            </p>
          ) : (
            <div className="space-y-2">
              {personas.map((persona) => {
                const metadata = persona.metadata ?? {};
                const username =
                  typeof metadata.username === "string" ? metadata.username : null;
                const bio = typeof metadata.bio === "string" ? metadata.bio : null;
                const isActive = persona.id === activePersonaId;

                return (
                  <div
                    key={persona.id}
                    className={`flex items-center gap-3 rounded-md border p-3 transition-colors ${
                      isActive ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    <div className="relative">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={persona.image ?? undefined} alt={persona.name} />
                        <AvatarFallback>
                          {persona.name.substring(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {isActive && (
                        <div className="absolute -bottom-1 -right-1 rounded-full bg-primary p-0.5">
                          <Drama className="h-3 w-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{persona.name}</span>
                        {username && (
                          <span className="text-xs text-muted-foreground">@{username}</span>
                        )}
                        {isActive && (
                          <Badge variant="default" className="text-xs">
                            Active
                          </Badge>
                        )}
                      </div>
                      {bio && (
                        <p className="text-xs text-muted-foreground truncate">{bio}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      {!isActive && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleSwitch(persona.id)}
                          disabled={actionLoading}
                          title="Switch to this persona"
                        >
                          <UserCheck className="h-4 w-4" />
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
            <DialogTitle>Create Persona</DialogTitle>
            <DialogDescription>
              Create an alternate identity. Your wallet is shared but content is separate.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label htmlFor="persona-name">Name *</Label>
              <Input
                id="persona-name"
                placeholder="Persona display name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="persona-username">Username</Label>
              <Input
                id="persona-username"
                placeholder="optional_username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                maxLength={40}
              />
            </div>
            <div>
              <Label htmlFor="persona-bio">Bio</Label>
              <Textarea
                id="persona-bio"
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
            <DialogTitle>Edit Persona</DialogTitle>
            <DialogDescription>
              Update this persona&apos;s profile information.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label htmlFor="edit-persona-name">Name</Label>
              <Input
                id="edit-persona-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="edit-persona-username">Username</Label>
              <Input
                id="edit-persona-username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                maxLength={40}
              />
            </div>
            <div>
              <Label htmlFor="edit-persona-bio">Bio</Label>
              <Textarea
                id="edit-persona-bio"
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
              This will permanently remove this persona and all its content. This cannot be undone.
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
