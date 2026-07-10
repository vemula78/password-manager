export function FillConfirmDialog(props: {
  reasons: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="modal">
        <h3 style={{ marginTop: 0 }}>Confirm before filling</h3>
        {props.reasons.map((r, i) => (
          <p key={i} className="warning-box">⚠️ {r}</p>
        ))}
        <p className="muted">Only continue if you are certain this page is genuine.</p>
        <div className="btn-row">
          <button className="btn" onClick={props.onCancel}>Cancel</button>
          <button className="btn primary" onClick={props.onConfirm}>Fill anyway</button>
        </div>
      </div>
    </div>
  );
}
