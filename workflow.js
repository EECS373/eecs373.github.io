export const STATUSES = Object.freeze(['Submitted', 'Queued', 'In progress', 'On printer', 'In EECS 2334']);
export const COMPLETION_HOURS = Object.freeze([1, 2, 3, 6, 12, 18, 24]);
export const COMPLETED_STATUSES = Object.freeze(['On printer', 'In EECS 2334']);
export const PROGRESS_STAGES = Object.freeze([...STATUSES.slice(0, 3), 'Ready for pickup']);
const MAX_ESTIMATED_FILL = 0.95;
const pickupLocations = {
  'On printer': 'On the printer in EECS 2322',
  'In EECS 2334': 'On the instructor tables in EECS 2334',
};
const zone = 'America/Detroit';
const wallClock = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});

export function completionInputValue(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(wallClock.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function completionFromInput(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Choose a valid completion date and time.');
  const [, year, month, day, hour, minute] = match.map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const normalized = new Date(desired).toISOString().slice(0, 16);
  if (normalized !== value) throw new Error('Choose a valid completion date and time.');
  let candidate = desired;
  for (let index = 0; index < 4; index++) {
    const shown = completionInputValue(candidate);
    if (shown === value) return new Date(candidate).toISOString();
    candidate += desired - Date.parse(`${shown}:00Z`);
  }
  throw new Error('That time does not exist in Eastern time. Choose another time.');
}

export function completionAfterHours(hours, now = Date.now()) {
  if (!COMPLETION_HOURS.includes(Number(hours))) throw new Error('Choose a completion-time preset.');
  return new Date(now + Number(hours) * 3600000).toISOString();
}

export class CompletionAutosave {
  constructor(estimate) {
    this.saved = estimate;
    this.pending = null;
    this.inFlight = null;
    this.error = '';
    this.uncertain = false;
    this.didSave = false;
  }

  get estimate() { return this.pending ? this.pending.estimate : this.saved; }
  get ready() { return Boolean(this.pending && !this.inFlight && !this.error); }

  observe(estimate) {
    if (estimate !== this.saved) this.didSave = false;
    this.saved = estimate;
    if (this.ready && !this.uncertain && this.pending.estimate === estimate) this.pending = null;
  }

  queue(estimate, {custom = false} = {}) {
    if (this.pending?.estimate === estimate && !this.error) return;
    this.pending = {estimate, custom};
    this.error = '';
    this.didSave = false;
    this.observe(this.saved);
  }

  cancelUnsentCustom() {
    if (this.pending?.custom && this.pending !== this.inFlight && !this.error) {
      this.pending = this.inFlight;
    }
  }

  start() {
    if (!this.ready) return null;
    this.inFlight = this.pending;
    return this.inFlight;
  }

  succeed(estimate) {
    if (this.pending === this.inFlight) this.pending = null;
    this.inFlight = null;
    this.uncertain = false;
    this.observe(estimate);
    this.didSave = !this.pending;
  }

  fail(message) {
    // A timeout can happen after commit, so the previous value may need to be saved again.
    if (!this.inFlight) return;
    if (this.pending === this.inFlight) this.error = message;
    this.inFlight = null;
    this.uncertain = true;
  }

  retry() { this.error = ''; }
}

export function isCurrentRequest(request, now = Date.now()) {
  if (!COMPLETED_STATUSES.includes(request.status) || !request.completedAt) return true;
  const completed = new Date(request.completedAt).getTime();
  return !Number.isFinite(completed) || now - completed < 48 * 3600000;
}

export function requestProgress(request, now = Date.now()) {
  const statusIndex = STATUSES.indexOf(request.status);
  if (statusIndex < 0) return null;
  const pickup = pickupLocations[request.status];
  if (pickup) return {stage: 3, fill: 1, pickup, timing: null, ticking: false};

  const start = Date.parse(request.stageStartedAt ?? '');
  const eta = Date.parse(request.estimatedCompletionAt ?? '');
  const hasWindow = Number.isFinite(start) && Number.isFinite(eta) && eta > start;
  const pastEstimate = Number.isFinite(eta) && now >= eta;
  const fill = hasWindow ? Math.min(MAX_ESTIMATED_FILL, Math.max(0, (now - start) / (eta - start))) : 0;
  return {
    stage: statusIndex,
    fill,
    pickup: null,
    timing: pastEstimate ? 'passed' : hasWindow ? 'estimated' : 'unavailable',
    ticking: Number.isFinite(eta) && !pastEstimate,
  };
}

export function partProgressCounts(progress) {
  if (!progress || !Number.isSafeInteger(progress.total) || progress.total < 2) return null;
  if (!Number.isSafeInteger(progress.printed) || progress.printed < 0 || progress.printed > progress.total) return null;
  return {printed: progress.printed, total: progress.total};
}

export function publicQueueRecords(requests, now = Date.now()) {
  return requests.filter(request => STATUSES.includes(request.status) && isCurrentRequest(request, now)).map(request => ({
    requestNumber: request.requestNumber, status: request.status,
    queuePosition: request.queuePosition, estimatedCompletionAt: request.estimatedCompletionAt, stageStartedAt: request.stageStartedAt,
    completedAt: request.completedAt, materialSummary: request.materialSummary, colorSummary: request.colorSummary,
    partProgress: partProgressCounts(request.partProgress),
  }));
}

export function gmailComposeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com' || !url.pathname.startsWith('/mail/') || url.username || url.password) throw new Error('Gmail returned an invalid compose link.');
  return url.href;
}

function closePopup(popup) { try { popup?.close(); } catch { /* The user may already have closed it. */ } }

export class WorkflowActions {
  constructor() { this.busy = false; this.revision = 0; }

  async read(loader) {
    if (this.busy) return null;
    const revision = this.revision;
    const result = await loader();
    return revision === this.revision ? result : null;
  }

  async run(action, onBusy = () => {}) {
    if (this.busy) throw new Error('Another update is still saving.');
    this.busy = true;
    this.revision++;
    try { onBusy(true); return await action(); }
    finally { this.busy = false; onBusy(false); }
  }

  changeStatus(status, {openPopup, patch, loadGmail, onSaved = () => {}, onBusy}) {
    if (!STATUSES.includes(status)) return Promise.reject(new Error('Choose a valid status.'));
    return this.run(async () => {
      const needsEmail = COMPLETED_STATUSES.includes(status);
      let popup = null;
      if (needsEmail) {
        try { popup = openPopup(); if (popup) popup.opener = null; } catch { popup = null; }
      }
      let request;
      try { request = await patch({status}); onSaved(request); }
      catch (error) { closePopup(popup); throw error; }
      if (!needsEmail) return {request};
      try {
        const gmail = await loadGmail();
        const composeUrl = gmailComposeUrl(gmail.composeUrl);
        let popupOpened = false;
        try { if (popup && !popup.closed) { popup.location.replace(composeUrl); popupOpened = true; } }
        catch { closePopup(popup); }
        return {request, gmail, composeUrl, popupOpened};
      } catch (error) {
        closePopup(popup);
        return {request, composeError: error};
      }
    }, onBusy);
  }
}
