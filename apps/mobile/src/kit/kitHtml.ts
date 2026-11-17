// Printable emergency kit for mobile. Content comes from @pw/core's buildEmergencyKit (same
// text as the web kit); this file only renders it to an A4 HTML page for expo-print
// (AirPrint / "Save as PDF"). The kit holds the recovery key and instructions — never
// vault passwords.
import { buildEmergencyKit, type EmergencyKit } from "@pw/core";

export function mobileKit(opts: {
  recoveryKey: string;
  ownerName?: string;
  emergencyContact?: string;
  hasDriveBackup?: boolean;
}): EmergencyKit {
  return buildEmergencyKit({
    ownerName: opts.ownerName ?? "",
    emergencyContact: opts.emergencyContact ?? "",
    recoveryKey: opts.recoveryKey,
    backupLocation: opts.hasDriveBackup
      ? "Google Drive → “PasswordManagerBackups” folder (encrypted .pwmbackup files)"
      : "Local encrypted export files (.pwmbackup) — wherever you saved them",
    createdAt: new Date().toISOString(),
  });
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const list = (items: string[], tag: "ul" | "ol") =>
  `<${tag}>${items.map((s) => `<li>${esc(s)}</li>`).join("")}</${tag}>`;

function formatDate(iso: string): string {
  const d = new Date(iso);
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")}-${m[d.getMonth()]}-${d.getFullYear()}`;
}

export function kitToHtml(k: EmergencyKit): string {
  const meta = [
    `Created ${formatDate(k.createdAt)}`,
    k.ownerName ? `Owner: <strong>${esc(k.ownerName)}</strong>` : "",
    k.emergencyContact ? `Emergency contact: <strong>${esc(k.emergencyContact)}</strong>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111; font-size: 12pt; line-height: 1.45; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  h2 { font-size: 13pt; margin: 16pt 0 4pt; }
  .meta { color: #444; margin: 0 0 14pt; }
  .keybox { border: 2px solid #111; border-radius: 6pt; padding: 12pt; margin: 8pt 0; text-align: center; }
  .keylabel { font-size: 10pt; text-transform: uppercase; letter-spacing: 1pt; color: #444; }
  .key { font-family: Courier, monospace; font-size: 17pt; font-weight: 700; letter-spacing: 1pt; margin-top: 6pt; word-break: break-all; }
  li { margin-bottom: 3pt; }
</style></head><body>
<h1>${esc(k.title)}</h1>
<p class="meta">${meta}</p>
<div class="keybox"><div class="keylabel">Recovery key — keep this secret</div><div class="key">${esc(k.recoveryKey)}</div></div>
<h2>How to recover the vault</h2>${list(k.instructions, "ol")}
<h2>Backup location</h2><p>${esc(k.backupLocation)}</p>
<h2>Do not share</h2>${list(k.doNotShare, "ul")}
<h2>Warnings</h2>${list(k.warnings, "ul")}
</body></html>`;
}
