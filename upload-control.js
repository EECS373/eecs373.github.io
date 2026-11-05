// Retry timing and staged upload state. No automatic network retries.
export function retryDelaySeconds(header, payload = {}, now = Date.now()) {
  const value = String(header ?? '').trim();
  let seconds;
  if (/^\d+(?:\.\d+)?$/.test(value)) seconds = Number(value);
  else if (value) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) seconds = Math.max(0, (date - now) / 1000);
  }
  if (!Number.isFinite(seconds) && payload?.retryAfterSeconds != null && String(payload.retryAfterSeconds).trim()) seconds = Number(payload.retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 30;
  return Math.max(1, Math.ceil(seconds));
}

export function responseError(payload, fallback, status, retryAfter, now = Date.now()) {
  const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message || fallback;
  const error = new Error(message);
  error.status = Number(status);
  error.errorCode = payload?.errorCode;
  if (error.status === 429 || ([409, 503].includes(error.status) && (retryAfter || payload?.retryAfterSeconds != null))) {
    error.retryAfterSeconds = retryDelaySeconds(retryAfter, payload, now);
  }
  return error;
}

export class UploadCooldown {
  constructor(now = () => Date.now()) { this.now = now; this.until = 0; }

  get remainingSeconds() { return Math.max(0, Math.ceil((this.until - this.now()) / 1000)); }

  record(error) {
    if (error?.cooldownActive) return true;
    if (error?.status !== 429 && !([409, 503].includes(error?.status) && error.retryAfterSeconds > 0)) return false;
    const delay = Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 30;
    this.until = Math.max(this.until, this.now() + delay * 1000);
    return true;
  }

  assertReady() {
    if (!this.remainingSeconds) return;
    const error = new Error('Wait for the upload timer before retrying.');
    error.status = 429;
    error.retryAfterSeconds = this.remainingSeconds;
    error.cooldownActive = true;
    throw error;
  }
}

export function formatRetryTime(seconds) {
  const remaining = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}` : `${minutes}:${String(remaining % 60).padStart(2, '0')}`;
}

export class StagedRequest {
  constructor(reviewed, idempotencyKey, cooldown) {
    this.reviewed = reviewed;
    this.idempotencyKey = idempotencyKey;
    this.cooldown = cooldown;
    this.uploadToken = null;
    this.uploaded = [];
    this.finalizedPayload = null;
    this.running = false;
    this.attempted = false;
  }

  async send({ startSession, uploadFile, finalize, onProgress = () => {} }) {
    this.cooldown.assertReady();
    if (this.running) throw new Error('This request is already uploading.');
    this.running = true;
    this.attempted = true;
    try {
      if (!this.finalizedPayload) {
        if (!this.uploadToken) {
          const session = await startSession();
          if (!session?.uploadToken) throw new Error('The server could not start an upload.');
          this.uploadToken = session.uploadToken;
        }
        const totalBytes = this.reviewed.parts.reduce((sum, part) => sum + part.file.size, 0);
        let completedBytes = this.reviewed.parts.slice(0, this.uploaded.length).reduce((sum, part) => sum + part.file.size, 0);
        for (let index = this.uploaded.length; index < this.reviewed.parts.length; index++) {
          const part = this.reviewed.parts[index];
          const progress = fraction => onProgress({ stage: 'upload', index, filename: part.file.name, percent: Math.round((completedBytes + part.file.size * fraction) / totalBytes * 100) });
          progress(0);
          const result = await uploadFile(part.file, this.uploadToken, progress);
          if (!result?.uploadId) throw new Error('The server did not confirm the uploaded file.');
          this.uploaded.push({ uploadId: result.uploadId, quantity: part.quantity, material: part.material, firstColor: part.firstColor, secondColor: part.secondColor, backupColor: part.backupColor, unit: part.unit });
          completedBytes += part.file.size;
          onProgress({ stage: 'upload', index, filename: part.file.name, percent: Math.round(completedBytes / totalBytes * 100) });
        }
        const { email, groupName, neededBy, specialInstructions } = this.reviewed;
        this.finalizedPayload = { email, groupName, neededBy, specialInstructions, uploadToken: this.uploadToken, parts: this.uploaded };
      }
      onProgress({ stage: 'saving', percent: 100 });
      return await finalize(this.finalizedPayload, this.idempotencyKey);
    } catch (error) {
      const limited = this.cooldown.record(error);
      // A rejected, rate-limited part was not accepted. Resume from the last
      // confirmed upload. An unknown file outcome needs a fresh session.
      const expired = error.status === 410 && error.errorCode === 'UPLOAD_SESSION_EXPIRED';
      if (expired) this.finalizedPayload = null;
      if (!limited && !this.finalizedPayload) { this.uploadToken = null; this.uploaded = []; }
      throw error;
    } finally { this.running = false; }
  }
}
