"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm, useWatch } from "react-hook-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ImageUpload } from "@/components/image-upload"
import { TagEditor } from "@/components/tag-editor"
import { TransactionType } from "@/lib/types"
import { Gift, Clock, DollarSign, Package, Briefcase, Plus } from "lucide-react"

/**
 * Add-to-marketplace listing form used in group marketplace creation flows.
 * This component is rendered where members publish a resource/skill/new item listing
 * and choose a transaction model (gift, borrow, rent, sale).
 *
 * Key props:
 * - `groupId`: Group context for listing creation (currently reserved for future data wiring).
 * - `userId`: Current user identifier used to load owned resources and skills.
 * - `onSuccess`: Callback invoked after successful submit or cancel.
 * - `userResources`: Pre-fetched resources owned by the user (from server component parent).
 * - `userSkills`: Pre-fetched skills owned by the user (from server component parent).
 */
const formSchema = z.object({
  title: z.string().min(3, { message: "Title must be at least 3 characters" }),
  description: z.string().min(10, { message: "Description must be at least 10 characters" }),
  transactionType: z.nativeEnum(TransactionType),
  price: z.number().optional(),
  duration: z.string().optional(),
  sourceType: z.enum(["resource", "skill", "new"]),
  resourceId: z.string().optional(),
  skillId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(z.string()).optional(),
})

type FormValues = z.infer<typeof formSchema>

interface AddToMarketplaceFormProps {
  groupId: string
  userId: string
  onSuccess: () => void
  /** Pre-fetched resources owned by the current user. */
  userResources?: Array<{ id: string; name: string }>
  /** Pre-fetched skills owned by the current user. */
  userSkills?: Array<{ id: string; name: string }>
}

/**
 * Renders and validates the marketplace listing form.
 *
 * @param props - Component props.
 * @param props.groupId - Group identifier for the listing context.
 * @param props.userId - User identifier used to query available resources/skills.
 * @param props.onSuccess - Called when the flow should complete (submit success/cancel).
 * @param props.userResources - Pre-fetched resources owned by the user.
 * @param props.userSkills - Pre-fetched skills owned by the user.
 */
export function AddToMarketplaceForm({
  groupId: _groupId,
  userId: _userId,
  onSuccess,
  userResources = [],
  userSkills = [],
}: AddToMarketplaceFormProps) {
  // Local UI state for child components that manage media and taxonomy independently of react-hook-form fields.
  const [images, setImages] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])

  // Form state and schema validation setup for core listing inputs.
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      description: "",
      transactionType: TransactionType.Give,
      sourceType: "new",
      tags: [],
      images: [],
    },
  })

  // Watches transaction type so pricing/duration sections can be conditionally rendered.
  const transactionType = useWatch({ control: form.control, name: "transactionType" })

  const onSubmit = (values: FormValues) => {
    // Merge external local state into submit payload before sending/saving.
    values.images = images
    values.tags = tags

    // Side effect: simulates async API latency before resolving the flow callback.
    setTimeout(() => {
      onSuccess()
    }, 500)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="transactionType"
          render={({ field }) => (
            <FormItem className="space-y-3">
              <FormLabel>Transaction Type</FormLabel>
              <FormControl>
                <RadioGroup
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                  className="grid grid-cols-4 gap-4"
                >
                  <FormItem className="flex flex-col items-center space-y-2 space-x-0">
                    <FormControl>
                      <RadioGroupItem value={TransactionType.Give} className="peer sr-only" id="give" />
                    </FormControl>
                    <FormLabel
                      htmlFor="give"
                      className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
                    >
                      <Gift className="mb-2 h-6 w-6" />
                      Give
                    </FormLabel>
                  </FormItem>
                  <FormItem className="flex flex-col items-center space-y-2 space-x-0">
                    <FormControl>
                      <RadioGroupItem value={TransactionType.Borrow} className="peer sr-only" id="borrow" />
                    </FormControl>
                    <FormLabel
                      htmlFor="borrow"
                      className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
                    >
                      <Clock className="mb-2 h-6 w-6" />
                      Borrow
                    </FormLabel>
                  </FormItem>
                  <FormItem className="flex flex-col items-center space-y-2 space-x-0">
                    <FormControl>
                      <RadioGroupItem value={TransactionType.Rent} className="peer sr-only" id="rent" />
                    </FormControl>
                    <FormLabel
                      htmlFor="rent"
                      className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
                    >
                      <Clock className="mb-2 h-6 w-6" />
                      Rent
                    </FormLabel>
                  </FormItem>
                  <FormItem className="flex flex-col items-center space-y-2 space-x-0">
                    <FormControl>
                      <RadioGroupItem value={TransactionType.Sale} className="peer sr-only" id="sale" />
                    </FormControl>
                    <FormLabel
                      htmlFor="sale"
                      className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
                    >
                      <DollarSign className="mb-2 h-6 w-6" />
                      Sale
                    </FormLabel>
                  </FormItem>
                </RadioGroup>
              </FormControl>
              <FormDescription>Select how you want to offer this item or service.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="sourceType"
          render={({ field }) => (
            <FormItem className="space-y-3">
              <FormLabel>What are you offering?</FormLabel>
              <FormControl>
                <Tabs defaultValue={field.value} onValueChange={field.onChange} className="w-full">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="resource" className="flex items-center gap-1">
                      <Package className="h-4 w-4" />
                      Resource
                    </TabsTrigger>
                    <TabsTrigger value="skill" className="flex items-center gap-1">
                      <Briefcase className="h-4 w-4" />
                      Skill
                    </TabsTrigger>
                    <TabsTrigger value="new" className="flex items-center gap-1">
                      <Plus className="h-4 w-4" />
                      New Item
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="resource" className="pt-4">
                    <FormField
                      control={form.control}
                      name="resourceId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Select a resource</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select a resource" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {userResources.length > 0 ? (
                                userResources.map((resource) => (
                                  <SelectItem key={resource.id} value={resource.id}>
                                    {resource.name}
                                  </SelectItem>
                                ))
                              ) : (
                                <SelectItem value="none" disabled>
                                  No resources found
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                          <FormDescription>
                            Choose from your existing resources or{" "}
                            <Button
                              variant="link"
                              className="p-0 h-auto"
                              onClick={() => form.setValue("sourceType", "new")}
                            >
                              create a new one
                            </Button>
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </TabsContent>

                  <TabsContent value="skill" className="pt-4">
                    <FormField
                      control={form.control}
                      name="skillId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Select a skill</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select a skill" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {userSkills.length > 0 ? (
                                userSkills.map((skill) => (
                                  <SelectItem key={skill.id} value={skill.id}>
                                    {skill.name}
                                  </SelectItem>
                                ))
                              ) : (
                                <SelectItem value="none" disabled>
                                  No skills found
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                          <FormDescription>
                            Choose from your existing skills or{" "}
                            <Button
                              variant="link"
                              className="p-0 h-auto"
                              onClick={() => form.setValue("sourceType", "new")}
                            >
                              create a new one
                            </Button>
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </TabsContent>

                  <TabsContent value="new" className="space-y-4 pt-4">
                    <FormField
                      control={form.control}
                      name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Title</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter a title for your listing" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Description</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="Describe what you're offering..."
                              className="min-h-[100px]"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </TabsContent>
                </Tabs>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Conditional rendering: show price input only for rent/sale transaction models. */}
        {(transactionType === TransactionType.Rent || transactionType === TransactionType.Sale) && (
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Price</FormLabel>
                <FormControl>
                  <div className="relative">
                    <DollarSign className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="number"
                      placeholder="0.00"
                      className="pl-8"
                      {...field}
                      onChange={(e) => field.onChange(Number.parseFloat(e.target.value))}
                    />
                  </div>
                </FormControl>
                <FormDescription>
                  {transactionType === TransactionType.Rent ? "Set the rental price." : "Set the sale price."}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Conditional rendering: show duration details for borrow/rent transaction models. */}
        {(transactionType === TransactionType.Borrow || transactionType === TransactionType.Rent) && (
          <FormField
            control={form.control}
            name="duration"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Duration</FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      transactionType === TransactionType.Borrow
                        ? "e.g., 1 week, until June 15"
                        : "e.g., $10/day, $50/week"
                    }
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  {transactionType === TransactionType.Borrow
                    ? "Specify how long you're willing to lend this item."
                    : "Specify the rental period and rate."}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Supplemental listing metadata managed by local component state. */}
        <div className="space-y-4">
          <div>
            <FormLabel>Images</FormLabel>
            <ImageUpload value={images} onChange={setImages} maxFiles={3} />
            <FormDescription>Add up to 3 images to showcase what you&apos;re offering.</FormDescription>
          </div>

          <div>
            <FormLabel>Tags</FormLabel>
            <TagEditor
              tags={tags}
              setTags={setTags}
              placeholder="Add tags..."
              suggestions={["community", "tools", "skills", "education", "creative", "food", "technology"]}
            />
            <FormDescription>Add tags to help others find your listing.</FormDescription>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          {/* Event handler: cancellation delegates to parent success/close callback. */}
          <Button type="button" variant="outline" onClick={onSuccess}>
            Cancel
          </Button>
          <Button type="submit">Create Listing</Button>
        </div>
      </form>
    </Form>
  )
}
