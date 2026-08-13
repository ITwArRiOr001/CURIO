import React from "react";

import Unprompted from "./Unprompted.jsx";

/**
 * Catches render-time errors so a single failure never leaves the user
 * staring at a blank white page.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Replace with your error reporting service when you add one.
    console.error("Unprompted crashed:", error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="app-fallback">
          <h1>Something went wrong.</h1>
          <p>The app hit an unexpected error. Reloading usually fixes it.</p>
          <button type="button" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Unprompted />
    </ErrorBoundary>
  );
}
