// Emergency kit content. Core produces the structured data + text blocks; the shells
// render it (web: printable page). Per spec, the kit never contains raw passwords —
// only the recovery key, instructions, and warnings.

export interface EmergencyKitInput {
  ownerName: string;
  emergencyContact: string;
  /** The formatted recovery key, freshly generated or rotated for this kit. */
  recoveryKey: string;
  backupLocation: string;
  createdAt: string;
}

export interface EmergencyKit {
  title: string;
  ownerName: string;
  emergencyContact: string;
  recoveryKey: string;
  backupLocation: string;
  createdAt: string;
  instructions: string[];
  doNotShare: string[];
  warnings: string[];
}

export function buildEmergencyKit(input: EmergencyKitInput): EmergencyKit {
  return {
    title: "Password Vault — Emergency Recovery Kit",
    ownerName: input.ownerName,
    emergencyContact: input.emergencyContact,
    recoveryKey: input.recoveryKey,
    backupLocation: input.backupLocation,
    createdAt: input.createdAt,
    instructions: [
      "This kit lets you (or a trusted person, in an emergency) recover the encrypted password vault if the master password is forgotten.",
      "Open the vault app and choose “Recover with recovery key” on the unlock screen.",
      `Enter the recovery key printed below exactly as shown (dashes optional).`,
      `If this device is lost, first restore the encrypted backup from: ${input.backupLocation || "the configured backup location"}, then recover with this key.`,
      "After recovery, set a new master password immediately and generate a fresh recovery kit — this one becomes invalid once the key is rotated.",
    ],
    doNotShare: [
      "Never share this kit or the recovery key over phone, SMS, WhatsApp or email — no bank or support person will ever legitimately ask for it.",
      "Do not store this kit inside the vault itself, or in the same place as your master password.",
      "Do not photograph this kit and keep the photo in an unencrypted gallery or cloud album.",
    ],
    warnings: [
      "Anyone with this recovery key AND a copy of the vault or its backup can read everything in it. Store it like cash or jewellery — a locker or safe is ideal.",
      "If you forget your master password and lose this recovery key, the vault cannot be recovered by anyone — not the app, not Google.",
      "The provider cannot decrypt your vault for you. That is by design.",
    ],
  };
}
