import React from "react";

import Curio from "./Curio.jsx";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Curio crashed:", error, info);
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
          <button type="button" onClick={this.handleReload}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Curio />
    </ErrorBoundary>
  );
}
