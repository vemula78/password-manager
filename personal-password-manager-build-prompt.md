# Build Prompt: Personal Password Manager for Indian Users

You are an expert product engineer, security architect, and UX designer. Build a secure personal password manager app for individual and family use, tailored to Indian users and Indian banking workflows.

The app must be privacy-first, offline-capable, strongly encrypted, easy to use for non-technical users, and suitable for storing sensitive personal credentials such as banking logins, UPI details, card PIN hints, netbanking credentials, insurance portals, government IDs, demat/trading accounts, health portals, and family emergency information.

## Product Goal

Create a personal password manager that helps a user securely store, organize, generate, autofill, back up, restore, and monitor passwords and sensitive records.

The app should support:

- Personal vault
- Optional family vault
- Banking-specific credential templates for India
- Browser extension autofill
- Mobile autofill
- Secure notes and documents
- Encrypted Google Drive backup on a regular schedule
- Offline access
- Master password recovery options
- Emergency access and recovery planning

## Target Platforms

Build with a modular architecture that can support:

- Web app
- Android app
- iOS app
- Desktop app, optional
- Chrome/Edge/Firefox browser extension

For the first version, prioritize:

1. Mobile app
2. Web app
3. Browser extension

## Security Principles

The system must follow these principles:

- Zero-knowledge design where possible.
- The server must never store plaintext passwords, MPINs, transaction passwords, notes, or backup contents.
- All vault content must be encrypted before leaving the user device.
- Google Drive backups must be encrypted locally before upload.
- Master password must never be sent to the server.
- Master password recovery must not give the app provider or cloud provider access to plaintext vault data.
- No sensitive data in logs, crash reports, analytics, URLs, browser localStorage, screenshots, or notifications.
- Clipboard should auto-clear after a configurable timeout.
- Require reauthentication before viewing highly sensitive fields such as MPIN, ATM PIN, transaction password, or recovery codes.

## Encryption Requirements

Implement:

- AES-256-GCM or XChaCha20-Poly1305 for item encryption.
- Argon2id for deriving encryption keys from the master password.
- Unique random salt per user.
- Unique nonce per encrypted item.
- Separate encryption keys for the main vault, family vault, and backup package.
- Encrypted local database.
- Encrypted cloud backup file.
- Secure random password generation using a cryptographically secure random number generator.

Backup files must be unreadable without the master password or a dedicated backup recovery key.

## Authentication

Support:

- Master password
- Passphrase support
- Biometric unlock on mobile
- Device PIN unlock after first successful master password login
- Optional passkey support
- Optional TOTP authenticator MFA
- Recovery codes
- Emergency access contact, optional

Do not force arbitrary password complexity rules. Encourage long passphrases and check against known weak/reused passwords.

## Master Password Recovery

Provide master password recovery options, but clearly explain the security tradeoff to the user.

The app must distinguish between:

- Account recovery: regaining access to the app account.
- Vault recovery: decrypting encrypted vault contents.

In a zero-knowledge design, the provider cannot recover vault contents unless the user has configured a recovery method in advance. Do not promise magical recovery if no recovery method exists.

Support these recovery options:

- Recovery key: generate a high-entropy recovery key during setup. The user can print it, save it offline, or store it separately from the vault.
- Recovery phrase: optional human-readable recovery phrase that can unwrap the vault recovery key.
- Trusted contact recovery: allow the user to nominate one or more trusted contacts who can approve recovery after a waiting period.
- Emergency access recovery: allow a trusted person to request access after a configurable delay, such as 24 hours, 7 days, or 30 days.
- Device-based recovery: allow an already trusted device to help rewrap the vault key after biometric or device credential verification.
- Google Drive backup recovery key: allow the encrypted backup to be restored with either the master password or a separate backup recovery key.
- Paper emergency kit: generate a printable emergency kit containing recovery instructions, recovery key, backup location, and warnings.

Recovery safeguards:

- Recovery must be opt-in.
- Recovery setup must require master password confirmation.
- Recovery changes must require reauthentication.
- Recovery key reveal must require biometric or master password confirmation.
- Trusted contact changes must trigger alerts on all trusted devices.
- Emergency access requests must notify the owner immediately.
- Emergency access must include a cancellation window.
- Recovery attempts must be logged in encrypted local activity history.
- Failed recovery attempts must be rate-limited.
- Recovery keys must be rotatable.
- Lost recovery keys must be replaceable only while the user can still unlock the vault.

Recommended default:

- During onboarding, ask the user to create a printable recovery kit.
- Encourage storing the recovery kit in a safe physical place.
- Encourage setting up at least one trusted contact for emergency access.
- Do not enable trusted contact recovery by default without explicit user consent.

Warnings to show:

- If you forget your master password and lose your recovery key, your encrypted vault may be impossible to recover.
- The provider cannot decrypt your vault for you.
- Anyone with your recovery key may be able to recover your vault, so store it safely.
- Do not store the recovery key inside the same vault.

## Indian Banking Credential Templates

Provide dedicated record templates for Indian financial workflows.

### Netbanking Record

Fields:

- Bank name
- Account holder name
- Customer ID / user ID
- Login password
- Transaction password
- Profile password, if applicable
- MPIN
- TPIN
- ATM PIN hint, never encourage storing raw PIN unless user explicitly chooses
- Registered mobile number
- Registered email
- Account number, masked by default
- IFSC code
- Branch
- UPI ID
- Debit card last 4 digits
- Credit card last 4 digits
- Security questions
- Nominee details
- Bank helpline number
- Website URL
- Mobile app name
- Notes
- Last password change date
- Renewal or review reminder

Sensitive fields such as MPIN, ATM PIN, transaction password, TPIN, and security answers must be hidden by default and require biometric or master password confirmation before reveal.

### UPI Record

Fields:

- UPI app name, such as BHIM, PhonePe, Google Pay, Paytm, bank app
- UPI ID
- Linked bank
- Registered mobile number
- UPI PIN hint
- Device binding notes
- Recovery steps
- Support contact
- Notes

Show a warning that raw UPI PIN storage is risky. Prefer storing a memory hint instead of the full PIN.

### Card Record

Fields:

- Card issuer
- Card type: debit, credit, forex, prepaid
- Card network: RuPay, Visa, Mastercard, Amex
- Cardholder name
- Card number, encrypted and masked
- Expiry date
- CVV, hidden by default with warning
- PIN hint
- Billing cycle
- Payment due date
- Credit limit
- Reward program
- Customer care number
- Lost card blocking number
- Notes

### Demat and Trading Account Record

Fields:

- Broker name
- Client ID
- Login password
- Trading password
- TPIN
- Demat BO ID
- Depository: CDSL or NSDL
- Linked bank account
- Registered email
- Registered mobile
- Nominee details
- Support contact
- Notes

### Government and Identity Record

Support records for:

- Aadhaar
- PAN
- Passport
- Driving licence
- Voter ID
- ABHA health ID
- DigiLocker
- Income Tax portal
- GST portal, optional
- EPFO/UAN
- NPS

Fields should be masked by default and encrypted.

## Core Vault Features

The app must include:

- Add, edit, delete, archive, and restore records.
- Folders and tags.
- Favorites.
- Recently used items.
- Search across non-sensitive metadata.
- Secure notes.
- File attachments, encrypted.
- Password history per item.
- Item version history.
- Duplicate password detection.
- Weak password detection.
- Reused password detection.
- Breached password alerting, using privacy-preserving checks where possible.
- Password generator.
- Passphrase generator.
- Custom fields.
- Expiry reminders.
- Renewal reminders.
- Important date reminders.

## Google Drive Backup

Implement encrypted Google Drive backup.

Requirements:

- User can connect Google Drive.
- App creates a dedicated folder, for example `PasswordManagerBackups`.
- Backups are encrypted locally before upload.
- Backup file names should not reveal sensitive user data.
- Backup metadata should be minimal.
- Support automatic backup frequencies:
  - Daily
  - Weekly
  - Monthly
  - Manual only
- Default recommendation: weekly encrypted backup.
- Keep configurable backup retention:
  - Last 7 backups
  - Last 30 backups
  - Custom
- Show last successful backup time.
- Show backup health status.
- Notify user if backup fails.
- Allow manual backup now.
- Allow restore from Google Drive.
- Require master password or backup recovery key to restore.
- Validate backup integrity before restore.
- Never upload plaintext vault export.

Also support local encrypted export as a fallback.

## Browser Extension

Build a browser extension for Chrome, Edge, and Firefox.

Features:

- Detect login forms.
- Autofill username and password.
- Manual fill from extension popup.
- Save new login after successful login.
- Update changed password.
- Generate password during signup/change password.
- Domain matching.
- Warn on lookalike or suspicious domains.
- Warn before filling on HTTP pages.
- Do not autofill into hidden fields.
- Do not autofill into iframes unless trusted.
- Require user confirmation for banking, government, and financial sites.
- Lock extension after inactivity.
- Support keyboard shortcut to open vault search.
- Clipboard copy with auto-clear.

For Indian banking sites, use stricter autofill behavior:

- Do not automatically fill transaction passwords.
- Do not automatically fill MPIN/TPIN/UPI PIN.
- Require explicit reveal or copy with biometric/master password confirmation.
- Show anti-phishing domain warning before filling banking credentials.

## Mobile Features

Mobile app must support:

- Android autofill service.
- iOS Password AutoFill integration.
- Biometric unlock.
- Screenshot protection on sensitive screens.
- App lock on background.
- Offline encrypted access.
- Clipboard auto-clear.
- Share sheet support for saving login details.
- Secure field reveal with biometric confirmation.
- Backup over Wi-Fi only option.
- Low-data mode.

## Personal and Family Use

Support:

- Personal vault
- Family vault
- Shared items
- Emergency access
- Trusted contact
- Export emergency kit
- Nominee and inheritance notes

Emergency kit should include:

- Account owner name
- Emergency contact
- Instructions for recovery
- Where backup is stored
- What not to share
- Recovery code printout

Emergency kit must not expose raw passwords unless the user explicitly exports an encrypted package.

## UX Requirements

Design should be simple, calm, and trustworthy.

Main screens:

- Unlock screen
- Dashboard
- All items
- Banking
- Cards
- UPI
- Government IDs
- Secure notes
- Family vault
- Password health
- Backup and restore
- Settings

Dashboard should show:

- Backup status
- Password health score
- Weak/reused password count
- Upcoming reminders
- Recently used items
- Quick add buttons

Use clear warnings for risky storage:

- Storing full ATM PIN, UPI PIN, MPIN, TPIN, or CVV increases risk.
- Prefer storing hints where possible.
- Require reauthentication for reveal.

## Data Model

Use these core entities:

- User
- Device
- Vault
- VaultItem
- VaultItemVersion
- Attachment
- Tag
- Folder
- BackupJob
- BackupFile
- AuditEvent
- EmergencyContact
- RecoveryCode
- RecoveryKey
- RecoveryPhrase
- TrustedContact
- EmergencyAccessRequest
- KeyEnvelope
- SecurityAlert

Vault item types:

- Login
- Netbanking
- UPI
- Card
- DematTrading
- GovernmentID
- SecureNote
- WiFi
- Document
- Insurance
- HealthPortal
- EmailAccount
- SocialAccount
- SoftwareLicense
- RecoveryCode
- Custom

## Audit and Activity History

For personal use, keep a local encrypted activity history:

- Item created
- Item edited
- Item viewed
- Sensitive field revealed
- Password copied
- Backup completed
- Restore completed
- Recovery method created
- Recovery method changed
- Recovery key viewed
- Trusted contact added or removed
- Emergency access requested
- Emergency access approved, denied, cancelled, or completed
- Failed unlock attempts
- Device added
- Device removed

Allow the user to clear activity history after confirmation.

## Privacy Requirements

The app must not sell, share, or monetize user vault data.

Avoid unnecessary analytics. If analytics are included:

- Must be opt-in.
- Must never include vault data, field names, URLs, usernames, bank names, account numbers, or notes.
- Must be easy to disable.

## Import and Export

Support import from:

- Browser CSV
- Bitwarden CSV/JSON
- 1Password export
- LastPass CSV
- Generic CSV

Support export:

- Encrypted app backup
- Encrypted local file
- Plain CSV only after strong warning and reauthentication

Plain CSV export must be disabled by default.

## Reminders

Support reminders for:

- Credit card bill due date
- Insurance premium due date
- Password review
- PAN/Aadhaar document updates
- Passport expiry
- Driving licence expiry
- Card expiry
- Domain renewal, optional
- Subscription renewal

Notifications must not reveal sensitive details on lock screen.

## Admin-Free Personal Mode

This is a personal app, not an enterprise app. There should be no administrator with access to user vaults.

If cloud sync is implemented, the server only stores encrypted data.

## Acceptance Criteria

The app is acceptable only if:

- A user can create a vault with a master password.
- A user can create, print, and verify a master password recovery kit.
- A user can recover vault access using a recovery key if recovery was configured in advance.
- The app clearly states that vault recovery may be impossible if both the master password and recovery key are lost.
- A user can add a netbanking record with login password, transaction password, MPIN, and notes.
- Sensitive banking fields are hidden by default.
- Sensitive banking fields require reauthentication before reveal.
- A user can generate a strong password.
- A user can save and autofill a normal website login.
- The browser extension refuses or warns before autofilling banking transaction fields.
- A user can connect Google Drive.
- A user can create an encrypted Google Drive backup.
- The app can restore from the encrypted Google Drive backup.
- Backups are unreadable without the master password or backup recovery key.
- The app works offline with encrypted local storage.
- Clipboard clears automatically.
- Reused and weak passwords are detected.
- The app has a clear emergency recovery flow.

## Recommended First Release

Build version 1 with:

- Mobile app
- Web app
- Local encrypted vault
- Google Drive encrypted backup
- Netbanking, UPI, card, government ID, and secure note templates
- Password generator
- Biometric unlock
- Manual copy/fill
- Basic browser extension
- Password health dashboard
- Emergency kit
- Master password recovery key

Then build version 2 with:

- Full browser autofill
- Family vault sharing
- Trusted contact recovery
- Passkey support
- Breach monitoring
- Advanced import/export
- Desktop app
- Multi-device encrypted sync

## Important Warnings to Show Users

Display short, clear warnings in the product:

- Do not store full UPI PIN, ATM PIN, MPIN, TPIN, or CVV unless you understand the risk.
- Prefer storing a memory hint instead of the full PIN.
- Never share your master password.
- Google Drive backup is encrypted, but losing both your master password and recovery key may make recovery impossible.
- Store your recovery key outside this vault, preferably printed and kept safely.
- Always verify the website domain before filling banking credentials.
- Transaction passwords should be copied or revealed only when needed.

Build the app with production-quality security, clean UX, careful error handling, and no plaintext exposure of sensitive data.
