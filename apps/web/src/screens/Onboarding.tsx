// Onboarding: explain zero-knowledge, create master password, then the REQUIRED
// recovery-kit step (create → print → verify, with an explicit accept-the-risk skip).
import { VaultStore } from "@pw/core";
import { useState } from "react";
import { KitOverlay, kitFromStore } from "../components/Kit";
import { RestorePanel } from "../components/Restore";
import { StrengthMeter, Warning } from "../components/ui";
import { loadConfig } from "../lib/config";
import { idbAdapter } from "../lib/storage";

// Spec §Warnings — shown verbatim on the skip path.
const SKIP_WARNING =
  "If you forget your master password and lose your recovery key, your encrypted vault may be impossible to recover.";

type Step = "welcome" | "kit" | "verify" | "restore";

export function Onboarding(props: { onUnlocked: (s: VaultStore) => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [store, setStore] = useState<VaultStore | null>(null);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [savedChecked, setSavedChecked] = useState(false);
  const [skipChecked, setSkipChecked] = useState(false);
  const [showKit, setShowKit] = useState(false);
  const [verifyInput, setVerifyInput] = useState("");
  const [verifyErr, setVerifyErr] = useState("");

  const createVault = async () => {
    setBusy(true);
    setErr("");
    await new Promise((r) => setTimeout(r, 30)); // Argon2id takes ~1s; let UI paint
    try {
      const s = await VaultStore.create(pwd, idbAdapter);
      const key = await s.createRecoveryKey({ masterPassword: pwd });
      s.log("recovery_key_viewed");
      await s.persist();
      setStore(s);
      setRecoveryKey(key);
      setStep("kit");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const firstGroup = recoveryKey.split("-")[0] ?? "";

  const finish = () => {
    if (store) props.onUnlocked(store);
  };

  const verify = () => {
    if (verifyInput.trim().toUpperCase() === firstGroup.toUpperCase()) {
      finish();
    } else {
      setVerifyErr("That doesn't match the first group of your recovery key. Check your printed kit.");
      setVerifyInput("");
    }
  };

  return (
    <div className="center-page">
      <div className="card auth-card onboarding">
        <div className="brand">
          <span className="brand-icon">🔐</span>
          <h1>Password Vault</h1>
        </div>

        {step === "welcome" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (pwd && pwd === pwd2 && !busy) void createVault();
            }}
          >
            <h2>Create your vault</h2>
            <ul className="zk-points">
              <li>🔒 Everything is encrypted on this device with your master password. It never leaves your device, and it is never sent anywhere.</li>
              <li>🙈 Zero-knowledge: nobody — not this app, not Google — can read your vault or reset your password for you.</li>
              <li>📴 Works fully offline. Backups (local file or Google Drive) are encrypted before they leave this device.</li>
            </ul>
            <label className="field">
              <span>Master password</span>
              <input
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                autoFocus
                autoComplete="new-password"
              />
            </label>
            <StrengthMeter password={pwd} />
            <p className="muted">
              Tip: a long passphrase of 4–5 random words (e.g. <em>temple-lantern-mango-rocket</em>)
              is stronger and easier to remember than a short complex password. There are no
              arbitrary complexity rules here — length wins.
            </p>
            <label className="field">
              <span>Confirm master password</span>
              <input
                type="password"
                value={pwd2}
                onChange={(e) => setPwd2(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {pwd2 && pwd !== pwd2 && <p className="error">Passwords do not match.</p>}
            {err && <p className="error">{err}</p>}
            <button type="submit" className="btn primary full" disabled={!pwd || pwd !== pwd2 || busy}>
              {busy ? "Creating encrypted vault…" : "Create vault"}
            </button>
            <div className="auth-links">
              <button type="button" className="link-btn" onClick={() => setStep("restore")}>
                Restore from a backup instead
              </button>
            </div>
          </form>
        )}

        {step === "restore" && (
          <div>
            <h2>Restore from backup</h2>
            <RestorePanel
              hasLocalVault={false}
              driveClientId={loadConfig().driveClientId}
              onRestored={(s) => props.onUnlocked(s)}
              onCancel={() => setStep("welcome")}
            />
          </div>
        )}

        {step === "kit" && store && (
          <div>
            <h2>Your recovery kit</h2>
            <p>
              This is the <strong>only</strong> way back in if you ever forget your master
              password. It is shown once — print it or write it down now.
            </p>
            <div className="kit-key-box">
              <div className="kit-key-label">Recovery key</div>
              <div className="kit-key">{recoveryKey}</div>
            </div>
            <button
              className="btn full"
              onClick={() => setShowKit(true)}
            >
              View & print emergency kit
            </button>
            <Warning>
              Store your recovery key outside this vault, preferably printed and kept safely.
              Do not store it inside the vault or photograph it into an unencrypted gallery.
            </Warning>
            <label className="check">
              <input
                type="checkbox"
                checked={savedChecked}
                onChange={(e) => {
                  setSavedChecked(e.target.checked);
                  if (e.target.checked) setSkipChecked(false);
                }}
              />
              <span>I have saved my recovery kit</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={skipChecked}
                onChange={(e) => {
                  setSkipChecked(e.target.checked);
                  if (e.target.checked) setSavedChecked(false);
                }}
              />
              <span>Skip, I accept the risk</span>
            </label>
            {skipChecked && <Warning>{SKIP_WARNING}</Warning>}
            <button
              className="btn primary full"
              disabled={!savedChecked && !skipChecked}
              onClick={() => (savedChecked ? setStep("verify") : finish())}
            >
              Continue
            </button>
            {showKit && (
              <KitOverlay
                kit={kitFromStore(store, recoveryKey)}
                onClose={() => setShowKit(false)}
                onPrinted={() => void store.logAndPersist("emergency_kit_exported")}
              />
            )}
          </div>
        )}

        {step === "verify" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (verifyInput) verify();
            }}
          >
            <h2>Verify your kit</h2>
            <p className="muted">
              To make sure you really saved it: enter the <strong>first group</strong> (the 5
              characters before the first dash) of your recovery key.
            </p>
            <label className="field">
              <span>First group of recovery key</span>
              <input
                type="text"
                value={verifyInput}
                onChange={(e) => setVerifyInput(e.target.value)}
                maxLength={5}
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {verifyErr && <p className="error">{verifyErr}</p>}
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => setStep("kit")}>
                Back
              </button>
              <button type="submit" className="btn primary" disabled={verifyInput.length !== 5}>
                Verify & finish
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
