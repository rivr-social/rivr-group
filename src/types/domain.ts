/**
 * Domain type definitions extracted from mock data files.
 *
 * These types define the shape of domain entities used across the application.
 * Mock data files import from here and re-export for backward compatibility.
 */

// ─── Member Info (lightweight user identity for component props) ─────────────

export interface MemberInfo {
  id: string
  name: string
  username: string
  avatar: string
}

// ─── Job Shift & Task Types (from mock-job-shift-data) ─────────────────────

export interface Task {
  id: string
  name: string
  description: string
  points: number
  completed: boolean
  status: 'not_started' | 'in_progress' | 'awaiting_approval' | 'completed' | 'rejected'
  assignedTo?: string
  requiredBadge?: string
  estimatedTime: string
}

export interface JobShift {
  id: string
  title: string
  description: string
  groupId: string
  createdBy: string
  category: string
  location: string
  duration: string
  totalPoints: number
  priority: "low" | "medium" | "high"
  status: "open" | "in-progress" | "completed" | "cancelled"
  requiredBadges: string[]
  tasks: Task[]
  assignees: string[]
  maxAssignees: number
  deadline?: string
  createdAt: string
  updatedAt: string
  comments: Array<{
    id: string
    userId: string
    content: string
    createdAt: string
    replies?: Array<{
      id: string
      userId: string
      content: string
      createdAt: string
    }>
  }>
}

// ─── Document Types (from mock-documents-data) ─────────────────────────────

export type Document = {
  id: string
  title: string
  description: string
  content: string
  createdAt: string
  updatedAt: string
  createdBy: string
  groupId: string
  tags?: string[]
  category?: string
  showOnAbout?: boolean
}

// ─── User Badge Types (from mock-user-badges) ──────────────────────────────

export interface TrainingModule {
  id: string;
  title: string;
  description: string;
  type: 'video' | 'reading' | 'quiz' | 'assignment';
  content: string;
  duration: number;
  order: number;
  completed?: boolean;
}

export interface LiveClass {
  id: string;
  title: string;
  description: string;
  location: string;
  duration: string;
  maxParticipants: number;
  tasks: {
    id: string;
    name: string;
    description: string;
    points: number;
    completed?: boolean;
  }[];
}

export interface UserBadge {
  id: string;
  name: string;
  description: string;
  icon: string;
  level: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  category?: string;
  requirements?: string[];
  trainingModules?: TrainingModule[];
  liveClass?: LiveClass;
  createdAt?: string;
  issuedBy?: string;
  jobsUnlocked?: string[];
  holders?: string[];
}

export interface UserBadges {
  userId: string;
  badges: string[];
}

// ─── Job Listing Types (from mock-job-data) ─────────────────────────────────

export interface JobListing {
  id: string
  title: string
  description: string
  category: string
  type: "job" | "task" | "volunteer"
  compensation?: {
    type: "paid" | "volunteer" | "trade" | "points"
    amount?: number
    currency?: string
    points?: number
  }
  location?: {
    type: "remote" | "in-person" | "hybrid"
    address?: string
    city?: string
  }
  timeCommitment: {
    type: "one-time" | "recurring" | "ongoing"
    duration?: string
    schedule?: string
  }
  requirements?: string[]
  skills?: string[]
  postedBy: string
  groupId: string
  createdAt: string
  deadline?: string
  status: "open" | "in-progress" | "completed" | "cancelled"
  applicants?: string[]
  assignedTo?: string
  tags?: string[]
  urgency: "low" | "medium" | "high"
}

// ─── Project Types (from mock-projects-data) ────────────────────────────────

export interface ProjectDomain {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  leads: string[];
  members: string[];
  subgroupId?: string;
}

export interface ProjectMilestone {
  id: string;
  title: string;
  description: string;
  targetDate: string;
  completed: boolean;
  completedDate?: string;
}

export interface ProjectResource {
  id: string;
  name: string;
  description: string;
  type: "budget" | "equipment" | "space" | "other";
  allocated: boolean;
  amount?: number;
  unit?: string;
}

export interface ProjectRecord {
  id: string;
  title: string;
  description: string;
  longDescription?: string;
  vision?: string;
  objectives?: string[];
  groupId: string;
  createdBy: string;
  category: string;
  status: "planning" | "active" | "completed" | "cancelled";
  priority: "low" | "medium" | "high";
  jobs: string[];
  createdAt: string;
  updatedAt: string;
  deadline?: string;
  totalPoints?: number;
  completionPercentage?: number;
  tags: string[];
  teamLeads: string[];
  domains?: ProjectDomain[];
  milestones?: ProjectMilestone[];
  resources?: ProjectResource[];
  location?: string;
  budget?: number;
  website?: string;
  socialLinks?: { platform: string; url: string }[];
}
