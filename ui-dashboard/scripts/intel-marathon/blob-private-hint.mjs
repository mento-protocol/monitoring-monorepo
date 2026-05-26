export function privateBlobAccessHint(message) {
  const lower = message?.toLowerCase() ?? "";
  if (
    !lower.includes("store") &&
    !lower.includes("private") &&
    !lower.includes("does not support")
  ) {
    return null;
  }
  return "Hint: forensic backups must stay private. Use a BLOB_READ_WRITE_TOKEN scoped to a private Blob store that supports access: 'private'.";
}
