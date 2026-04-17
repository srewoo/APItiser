import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (error: Error, retry: () => void) => React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
  resetKeys?: ReadonlyArray<unknown>;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (!this.state.error || !this.props.resetKeys || !prevProps.resetKeys) {
      return;
    }
    const changed = this.props.resetKeys.some((key, index) => key !== prevProps.resetKeys?.[index]);
    if (changed) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[APItiser] UI error boundary caught:', error, info);
    this.props.onError?.(error, info);
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleRetry);
      }
      return (
        <div className="error-boundary-fallback" role="alert">
          <h2>Something went wrong</h2>
          <p className="error-boundary-message">{this.state.error.message}</p>
          <button type="button" onClick={this.handleRetry}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
