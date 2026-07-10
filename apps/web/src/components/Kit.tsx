// Printable emergency kit. Renders buildEmergencyKit() output for A4 print.
// Never contains any stored passwords — only the recovery key + instructions.
import { buildEmergencyKit, type EmergencyKit, type VaultStore } from "@pw/core";
import { useEffect } from "react";
import { formatDate } from "./ui";

/** Build kit content from the store's settings + a freshly generated recovery key. */
export function kitFromStore(store: VaultStore, recoveryKey: string): EmergencyKit {
  return buildEmergencyKit({
    ownerName: store.settings.ownerName,
    emergencyContact: store.settings.emergencyContact,
    recoveryKey,
    backupLocation: store.settings.backup.driveFolderId
      ? "Google Drive → “PasswordManagerBackups” folder (encrypted .pwmbackup files)"
      : "Local encrypted export files (.pwmbackup) — wherever you saved them",
    createdAt: new Date().toISOString(),
  });
}

export function KitSheet(props: { kit: EmergencyKit }) {
  const k = props.kit;
  return (
    <div className="kit-sheet">
      <h1>{k.title}</h1>
      <p className="kit-meta">
        Created {formatDate(k.createdAt)}
        {k.ownerName ? <> · Owner: <strong>{k.ownerName}</strong></> : null}
        {k.emergencyContact ? <> · Emergency contact: <strong>{k.emergencyContact}</strong></> : null}
      </p>

      <div className="kit-key-box">
        <div className="kit-key-label">Recovery key — keep this secret</div>
        <div className="kit-key">{k.recoveryKey}</div>
      </div>

      <h2>How to recover the vault</h2>
      <ol>
        {k.instructions.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>

      <h2>Backup location</h2>
      <p>{k.backupLocation || "Local encrypted export files (.pwmbackup)"}</p>

      <h2>Do not share</h2>
      <ul>
        {k.doNotShare.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>

      <h2>Warnings</h2>
      <ul>
        {k.warnings.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

/** Full-screen overlay with print button; used from onboarding and settings. */
export function KitOverlay(props: {
  kit: EmergencyKit;
  onClose: () => void;
  onPrinted?: () => void;
}) {
  useEffect(() => {
    document.body.classList.add("kit-open");
    return () => document.body.classList.remove("kit-open");
  }, []);
  return (
    <div className="kit-overlay">
      <div className="kit-toolbar no-print">
        <button
          className="btn primary"
          onClick={() => {
            props.onPrinted?.();
            window.print();
          }}
        >
          Print / save as PDF
        </button>
        <button className="btn" onClick={props.onClose}>
          Done
        </button>
      </div>
      <KitSheet kit={props.kit} />
    </div>
  );
}
