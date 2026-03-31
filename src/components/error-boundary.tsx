"use client"

/**
 * Client-side error boundary for rendering fallback UI when descendant components throw.
 *
 * Used in:
 * - App/feature wrapper layers where runtime rendering errors should be isolated from the rest of the UI.
 *
 * Key props:
 * - `children`: Component subtree protected by the boundary.
 * - `fallback`: Optional custom fallback UI shown after an error is caught.
 */
import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

/**
 * Catches runtime errors in child components and renders fallback UI.
 *
 * @param props Error boundary props.
 * @param props.children Protected subtree that should render unless an error is thrown.
 * @param props.fallback Optional custom fallback element rendered when `hasError` is true.
 */
export class ErrorBoundary extends Component<Props, State> {
  // Tracks whether a render-time error has been captured and stores the thrown error for display.
  public state: State = {
    hasError: false,
  }

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Side effect: logs error diagnostics to the client console for debugging/monitoring.
    console.error("Uncaught error:", error, errorInfo)
  }

  public render() {
    // Conditional rendering: once an error is captured, render custom fallback or built-in recovery UI.
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return (
        this.props.fallback || (
          <div className="flex flex-col items-center justify-center min-h-[200px] p-6 text-center">
            <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
            <p className="text-muted-foreground mb-4">{this.state.error?.message || "An unexpected error occurred"}</p>
            {/* Event handler: resets boundary state so children can attempt to render again. */}
            <Button onClick={() => this.setState({ hasError: false })}>Try again</Button>
          </div>
        )
      )
    }

    // Normal path: render wrapped children when no error has been recorded.
    return this.props.children
  }
}
