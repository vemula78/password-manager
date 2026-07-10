import { GeneratorPanel } from "../components/GeneratorPanel";

export function Generator() {
  return (
    <div className="screen narrow">
      <h2>Password generator</h2>
      <p className="muted">
        Generated with a cryptographically secure random source. Copies auto-clear from the
        clipboard.
      </p>
      <div className="card">
        <GeneratorPanel />
      </div>
    </div>
  );
}
