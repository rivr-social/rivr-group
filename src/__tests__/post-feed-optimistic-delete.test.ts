/**
 * Tests for post feed optimistic delete behavior.
 *
 * The PostCard component uses local `isDeleted` state to immediately
 * hide itself from the feed after a successful delete, without waiting
 * for a router.refresh(). This tests the state transition logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Simulate the PostCard delete state machine
// ---------------------------------------------------------------------------

/**
 * Minimal state machine replicating PostCard's delete flow.
 *
 * The real component uses:
 *   const [isDeleted, setIsDeleted] = useState(false)
 *   const [isDeleting, setIsDeleting] = useState(false)
 *
 * handleDelete calls deleteResource(postId), and on success
 * sets isDeleted = true. The component returns null when isDeleted is true.
 *
 * This function encapsulates that logic for pure testing.
 */
function createPostCardDeleteState(
  deleteResource: (id: string) => Promise<{ success: boolean; message: string }>
) {
  let isDeleting = false;
  let isDeleted = false;

  return {
    get isDeleting() {
      return isDeleting;
    },
    get isDeleted() {
      return isDeleted;
    },
    get isVisible() {
      return !isDeleted;
    },

    async handleDelete(postId: string): Promise<{ success: boolean; message: string }> {
      isDeleting = true;
      const result = await deleteResource(postId);
      isDeleting = false;

      if (!result.success) {
        return result;
      }

      // Optimistic: hide immediately without router.refresh
      isDeleted = true;
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PostCard optimistic delete", () => {
  const mockDeleteResource = vi.fn<
    (id: string) => Promise<{ success: boolean; message: string }>
  >();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts visible and not deleting", () => {
    const state = createPostCardDeleteState(mockDeleteResource);

    expect(state.isVisible).toBe(true);
    expect(state.isDeleting).toBe(false);
    expect(state.isDeleted).toBe(false);
  });

  it("hides the card immediately after successful delete (no router.refresh needed)", async () => {
    mockDeleteResource.mockResolvedValue({ success: true, message: "Post removed" });

    const state = createPostCardDeleteState(mockDeleteResource);

    const result = await state.handleDelete("post-123");

    expect(result.success).toBe(true);
    expect(state.isDeleted).toBe(true);
    expect(state.isVisible).toBe(false);
    expect(mockDeleteResource).toHaveBeenCalledWith("post-123");
    expect(mockDeleteResource).toHaveBeenCalledTimes(1);
  });

  it("remains visible when delete fails", async () => {
    mockDeleteResource.mockResolvedValue({
      success: false,
      message: "Unauthorized",
    });

    const state = createPostCardDeleteState(mockDeleteResource);

    const result = await state.handleDelete("post-456");

    expect(result.success).toBe(false);
    expect(state.isDeleted).toBe(false);
    expect(state.isVisible).toBe(true);
  });

  it("sets isDeleting during the async operation", async () => {
    let resolveDelete: (value: { success: boolean; message: string }) => void;
    const pendingDelete = new Promise<{ success: boolean; message: string }>(
      (resolve) => {
        resolveDelete = resolve;
      }
    );
    mockDeleteResource.mockReturnValue(pendingDelete);

    const state = createPostCardDeleteState(mockDeleteResource);
    const deletePromise = state.handleDelete("post-789");

    // While the delete is in-flight, isDeleting should be true
    expect(state.isDeleting).toBe(true);
    expect(state.isDeleted).toBe(false);
    expect(state.isVisible).toBe(true);

    // Resolve the delete
    resolveDelete!({ success: true, message: "Post removed" });
    await deletePromise;

    // After resolution, isDeleting should be false and card should be hidden
    expect(state.isDeleting).toBe(false);
    expect(state.isDeleted).toBe(true);
    expect(state.isVisible).toBe(false);
  });

  it("resets isDeleting even on failure", async () => {
    mockDeleteResource.mockResolvedValue({
      success: false,
      message: "Server error",
    });

    const state = createPostCardDeleteState(mockDeleteResource);
    await state.handleDelete("post-fail");

    expect(state.isDeleting).toBe(false);
    expect(state.isDeleted).toBe(false);
  });
});
