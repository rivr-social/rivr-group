/**
 * @fileoverview GroupJoinSettings - Admin form for configuring how new members join a group.
 *
 * Rendered in the group admin settings. Supports four join types (Public, Approval Required,
 * Invite Only, Invite & Apply), custom application questions, invite-link generation,
 * and application instructions. Non-admins see a read-only summary.
 *
 * Key props: group, onSave, isAdmin
 */
"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Users, UserCheck, Link, FileText, Plus, Trash2, Copy, Check, ChevronDown, ChevronUp } from "lucide-react"
import { type Group, type JoinQuestion, JoinType, type GroupJoinSettings as GroupJoinSettingsType } from "@/lib/types"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface GroupJoinSettingsProps {
  group: Group
  onSave: (settings: Group["joinSettings"]) => void
  isAdmin: boolean
}

/**
 * Renders join-settings configuration (admin mode) or a read-only summary (non-admin).
 *
 * @param {GroupJoinSettingsProps} props
 * @param {Group} props.group - The group whose join settings are being configured
 * @param {(settings: Group["joinSettings"]) => void} props.onSave - Callback with updated settings on save
 * @param {boolean} props.isAdmin - Whether the current user has admin permissions
 */
export function GroupJoinSettings({ group, onSave, isAdmin }: GroupJoinSettingsProps) {
  const [joinSettings, setJoinSettings] = useState<GroupJoinSettingsType | undefined>(group.joinSettings)
  const [questions, setQuestions] = useState<JoinQuestion[]>(group.joinSettings?.questions || [])
  const [expandedQuestions, setExpandedQuestions] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)

  const handleJoinTypeChange = (value: string) => {
    setJoinSettings({
      ...joinSettings,
      joinType: value as JoinType,
    })
  }

  const handleAddQuestion = () => {
    const newQuestion: JoinQuestion = {
      id: `question_${Date.now()}`,
      question: "",
      required: false,
      type: "text",
    }
    setQuestions([...questions, newQuestion])
    setExpandedQuestions(true)
  }

  const handleQuestionChange = (id: string, field: keyof JoinQuestion, value: JoinQuestion[keyof JoinQuestion]) => {
    setQuestions(questions.map((q) => (q.id === id ? { ...q, [field]: value } : q)))
  }

  const handleRemoveQuestion = (id: string) => {
    setQuestions(questions.filter((q) => q.id !== id))
  }

  const handleAddOption = (questionId: string) => {
    setQuestions(
      questions.map((q) =>
        q.id === questionId
          ? {
              ...q,
              options: [...(q.options || []), ""],
            }
          : q,
      ),
    )
  }

  const handleOptionChange = (questionId: string, index: number, value: string) => {
    setQuestions(
      questions.map((q) =>
        q.id === questionId
          ? {
              ...q,
              options: q.options?.map((opt, i) => (i === index ? value : opt)),
            }
          : q,
      ),
    )
  }

  const handleRemoveOption = (questionId: string, index: number) => {
    setQuestions(
      questions.map((q) =>
        q.id === questionId
          ? {
              ...q,
              options: q.options?.filter((_, i) => i !== index),
            }
          : q,
      ),
    )
  }

  const handleSave = () => {
    if (!joinSettings) return
    const updatedSettings = {
      ...joinSettings,
      questions: questions,
    }
    onSave(updatedSettings)
    setIsEditing(false)
  }

  const copyInviteLink = () => {
    if (joinSettings?.inviteLink) {
      navigator.clipboard.writeText(joinSettings.inviteLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const generateInviteLink = () => {
    const newLink = `https://onelocal.com/groups/${group.id}/join?invite=${Date.now().toString(36)}`
    if (!joinSettings) return
    setJoinSettings({
      ...joinSettings,
      inviteLink: newLink,
    })
  }

  if (!joinSettings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Join Settings</CardTitle>
          <CardDescription>No join settings configured.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Join Settings</CardTitle>
          <CardDescription>This group&apos;s join settings are managed by administrators.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-4">
            {joinSettings.joinType === JoinType.Public && (
              <>
                <Users className="h-5 w-5 text-green-500" />
                <span>This group is public. Anyone can join.</span>
              </>
            )}
            {joinSettings.joinType === JoinType.ApprovalRequired && (
              <>
                <UserCheck className="h-5 w-5 text-amber-500" />
                <span>This group requires admin approval to join.</span>
              </>
            )}
            {joinSettings.joinType === JoinType.InviteOnly && (
              <>
                <Link className="h-5 w-5 text-blue-500" />
                <span>This group is invite-only.</span>
              </>
            )}
            {joinSettings.joinType === JoinType.InviteAndApply && (
              <>
                <FileText className="h-5 w-5 text-purple-500" />
                <span>This group requires an invitation and application.</span>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <div>
            <CardTitle>Group Join Settings</CardTitle>
            <CardDescription>Control how new members can join your group</CardDescription>
          </div>
          {!isEditing ? (
            <Button onClick={() => setIsEditing(true)}>Edit Settings</Button>
          ) : (
            <Button variant="outline" onClick={() => setIsEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!isEditing ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 border rounded-md bg-muted/30">
              {joinSettings.joinType === JoinType.Public && (
                <>
                  <Users className="h-5 w-5 text-green-500" />
                  <div>
                    <p className="font-medium">Public</p>
                    <p className="text-sm text-muted-foreground">Anyone can join this group</p>
                  </div>
                </>
              )}
              {joinSettings.joinType === JoinType.ApprovalRequired && (
                <>
                  <UserCheck className="h-5 w-5 text-amber-500" />
                  <div>
                    <p className="font-medium">Requires Admin Approval</p>
                    <p className="text-sm text-muted-foreground">
                      New members must be approved by an admin
                      {questions.length > 0 && " and answer questions"}
                    </p>
                  </div>
                </>
              )}
              {joinSettings.joinType === JoinType.InviteOnly && (
                <>
                  <Link className="h-5 w-5 text-blue-500" />
                  <div>
                    <p className="font-medium">Invite Only</p>
                    <p className="text-sm text-muted-foreground">New members can only join with an invite link</p>
                  </div>
                </>
              )}
              {joinSettings.joinType === JoinType.InviteAndApply && (
                <>
                  <FileText className="h-5 w-5 text-purple-500" />
                  <div>
                    <p className="font-medium">Invite and Application Required</p>
                    <p className="text-sm text-muted-foreground">
                      New members need an invite and must complete an application
                    </p>
                  </div>
                </>
              )}
            </div>

            {joinSettings.joinType === JoinType.InviteOnly && (
              <div className="p-3 border rounded-md">
                <p className="font-medium mb-2">Invite Link</p>
                <div className="flex items-center gap-2">
                  <Input value={joinSettings.inviteLink || "No invite link generated"} readOnly className="flex-1" />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={copyInviteLink}
                    disabled={!joinSettings.inviteLink}
                    aria-label="Copy invite link"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}

            {(joinSettings.joinType === JoinType.ApprovalRequired ||
              joinSettings.joinType === JoinType.InviteAndApply) &&
              questions.length > 0 && (
                <div className="p-3 border rounded-md">
                  <div className="flex justify-between items-center mb-2">
                    <p className="font-medium">Application Questions</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedQuestions(!expandedQuestions)}
                      aria-label={expandedQuestions ? "Collapse application questions" : "Expand application questions"}
                    >
                      {expandedQuestions ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  </div>

                  {expandedQuestions ? (
                    <div className="space-y-3">
                      {questions.map((q, index) => (
                        <div key={q.id} className="p-2 border rounded-md bg-background">
                          <p className="font-medium">{q.question || `Question ${index + 1}`}</p>
                          <div className="flex gap-2 mt-1">
                            <Badge variant="outline">{q.type}</Badge>
                            {q.required && <Badge>Required</Badge>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {questions.length} question{questions.length !== 1 ? "s" : ""} configured
                    </p>
                  )}
                </div>
              )}

            {joinSettings.joinType === JoinType.InviteAndApply && joinSettings.applicationInstructions && (
              <div className="p-3 border rounded-md">
                <p className="font-medium mb-2">Application Instructions</p>
                <p className="text-sm">{joinSettings.applicationInstructions}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium mb-4">How can people join this group?</h3>
              <RadioGroup value={joinSettings.joinType} onValueChange={handleJoinTypeChange} className="space-y-4">
                <div className="flex items-start space-x-2">
                  <RadioGroupItem value={JoinType.Public} id="public" />
                  <div className="grid gap-1.5">
                    <Label htmlFor="public" className="font-medium flex items-center">
                      <Users className="h-4 w-4 mr-2 text-green-500" />
                      Public
                    </Label>
                    <p className="text-sm text-muted-foreground">Anyone can join without approval</p>
                  </div>
                </div>

                <div className="flex items-start space-x-2">
                  <RadioGroupItem value={JoinType.ApprovalRequired} id="approval" />
                  <div className="grid gap-1.5">
                    <Label htmlFor="approval" className="font-medium flex items-center">
                      <UserCheck className="h-4 w-4 mr-2 text-amber-500" />
                      Requires Admin Approval
                    </Label>
                    <p className="text-sm text-muted-foreground">New members must be approved by an admin</p>
                  </div>
                </div>

                <div className="flex items-start space-x-2">
                  <RadioGroupItem value={JoinType.InviteOnly} id="invite" />
                  <div className="grid gap-1.5">
                    <Label htmlFor="invite" className="font-medium flex items-center">
                      <Link className="h-4 w-4 mr-2 text-blue-500" />
                      Invite Only
                    </Label>
                    <p className="text-sm text-muted-foreground">New members can only join with an invite link</p>
                  </div>
                </div>

                <div className="flex items-start space-x-2">
                  <RadioGroupItem value={JoinType.InviteAndApply} id="invite-apply" />
                  <div className="grid gap-1.5">
                    <Label htmlFor="invite-apply" className="font-medium flex items-center">
                      <FileText className="h-4 w-4 mr-2 text-purple-500" />
                      Invite and Application Required
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      New members need an invite and must complete an application
                    </p>
                  </div>
                </div>
              </RadioGroup>
            </div>

            <Separator />

            {/* Invite Link Section */}
            {(joinSettings.joinType === JoinType.InviteOnly || joinSettings.joinType === JoinType.InviteAndApply) && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-medium mb-2">Invite Link</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Share this link with people you want to invite to the group
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Input value={joinSettings.inviteLink || "No invite link generated"} readOnly className="flex-1" />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={copyInviteLink}
                    disabled={!joinSettings.inviteLink}
                    aria-label="Copy invite link"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>

                <Button variant="outline" onClick={generateInviteLink}>
                  {joinSettings.inviteLink ? "Generate New Link" : "Generate Invite Link"}
                </Button>

                <Separator />
              </div>
            )}

            {/* Application Questions Section */}
            {(joinSettings.joinType === JoinType.ApprovalRequired ||
              joinSettings.joinType === JoinType.InviteAndApply) && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-medium mb-2">Application Questions</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Add questions for prospective members to answer when they apply
                  </p>
                </div>

                {questions.length > 0 && (
                  <div className="space-y-4">
                    {questions.map((question, index) => (
                      <Card key={question.id} className="border border-muted">
                        <CardContent className="pt-4">
                          <div className="space-y-4">
                            <div className="flex items-start justify-between">
                              <Input
                                placeholder={`Question ${index + 1}`}
                                value={question.question}
                                onChange={(e) => handleQuestionChange(question.id, "question", e.target.value)}
                                className="flex-1 mr-2"
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleRemoveQuestion(question.id)}
                                aria-label="Remove question"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>

                            <div className="flex items-center gap-4">
                              <div className="flex-1">
                                <Label htmlFor={`question-type-${question.id}`}>Question Type</Label>
                                <Select
                                  value={question.type}
                                  onValueChange={(value) => handleQuestionChange(question.id, "type", value)}
                                >
                                  <SelectTrigger id={`question-type-${question.id}`}>
                                    <SelectValue placeholder="Select type" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="text">Text</SelectItem>
                                    <SelectItem value="multipleChoice">Multiple Choice</SelectItem>
                                    <SelectItem value="checkbox">Checkbox</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="flex items-center space-x-2 pt-6">
                                <Switch
                                  id={`required-${question.id}`}
                                  checked={question.required}
                                  onCheckedChange={(checked) => handleQuestionChange(question.id, "required", checked)}
                                />
                                <Label htmlFor={`required-${question.id}`}>Required</Label>
                              </div>
                            </div>

                            {question.type === "multipleChoice" && (
                              <div className="space-y-2">
                                <Label>Options</Label>
                                {question.options?.map((option, optIndex) => (
                                  <div key={optIndex} className="flex items-center gap-2">
                                    <Input
                                      placeholder={`Option ${optIndex + 1}`}
                                      value={typeof option === 'string' ? option : option.value}
                                      onChange={(e) => handleOptionChange(question.id, optIndex, e.target.value)}
                                      className="flex-1"
                                    />
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => handleRemoveOption(question.id, optIndex)}
                                      aria-label={`Remove option ${optIndex + 1}`}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                ))}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleAddOption(question.id)}
                                  className="mt-2"
                                >
                                  <Plus className="h-4 w-4 mr-2" />
                                  Add Option
                                </Button>
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

                <Button variant="outline" onClick={handleAddQuestion}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Question
                </Button>

                <Separator />
              </div>
            )}

            {/* Application Instructions */}
            {joinSettings.joinType === JoinType.InviteAndApply && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-medium mb-2">Application Instructions</h3>
                  <p className="text-sm text-muted-foreground mb-4">Provide instructions for applicants</p>
                </div>

                <Textarea
                  placeholder="Enter instructions for applicants..."
                  value={joinSettings.applicationInstructions || ""}
                  onChange={(e) => {
                    if (!joinSettings) return
                    setJoinSettings({
                      ...joinSettings,
                      applicationInstructions: e.target.value,
                    })
                  }}
                  rows={4}
                />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave}>Save Changes</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
