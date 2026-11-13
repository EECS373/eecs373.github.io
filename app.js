import { STLViewer } from './stl-viewer.js?v=20261112-model-previews';
import { SITE_CONFIG } from './site-config.js?v=20261112-model-previews';
import { resolveRuntimeConfig, endpointUrl, credentialsForEndpoint, staffRedirectUrl } from './runtime-config.js?v=20261112-model-previews';
import { acceptedModelExtensions, modelExtension, responseError, UploadCooldown, StagedRequest, formatRetryTime } from './upload-control.js?v=20261112-model-previews';
import { ModelPreview, previewDimensions, supportsModelPreview } from './model-preview.js?v=20261112-model-previews';
import { STATUSES, COMPLETION_HOURS, PROGRESS_STAGES, completionInputValue, completionFromInput, completionAfterHours, isCurrentRequest, partProgressCounts, publicQueueRecords, requestProgress, WorkflowActions } from './workflow.js?v=20261112-model-previews';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const NO_PREFERENCE = 'No preference';
const defaultOptions = { material: 'PLA', firstColor: 'White', secondColor: '', backupColor: 'Grey', unit: 'mm' };
const fallbackColors = {White:'#e7e5d4',Ivory:'#eee0bc',Cream:'#f1d6a3',Yellow:'#f4d035',Orange:'#eb8a32',Red:'#d84d48',Coral:'#ec8673',Pink:'#e9a1bd',Magenta:'#c44a95',Purple:'#855ab1',Lavender:'#b8a2d3',Blue:'#5e89c9','Light blue':'#9bc5e8',Navy:'#304665',Cyan:'#54bdcf',Teal:'#47958f',Green:'#519365',Lime:'#a6be53',Olive:'#87904d',Brown:'#946844',Tan:'#c1a184',Grey:'#94a2af','Dark grey':'#5e6978',Black:'#343b47',Silver:'#bfc8d2',Gold:'#cba44f',Bronze:'#a97b53',Clear:'#dce8ed'};
let colors = fallbackColors;
let acceptedExtensions = acceptedModelExtensions();
let configReady = false;
let parts = [];
let selectedPartId = null;
let lastOptions = { ...defaultOptions };
let submitting = false;
let reviewed = null;
let submissionKey = null;
let uploadAttempt = null;
const uploadCooldown = new UploadCooldown();
let cooldownTimer = null;
let lastReceipt = null;
let statusEmail = '';
let statusRequestSequence = 0;
let statusSnapshot = null;
let queueSnapshot = null;
let page = 'submit';
let csrfToken = '';
let authenticated = false;
let adminRequests = [];
let selectedRequest = null;
let adminSelectionSequence = 0;
let editorDirty = false;
let adminLoading = false;
let publicQueueLoading = false;
let settings = null;
let staffController = null;

const runtime = resolveRuntimeConfig(SITE_CONFIG, document.baseURI);
const apiUrl = path => endpointUrl(path, runtime);
const stepWasmUrl = apiUrl('preview/step.wasm') + '?v=20261112-model-previews';
const allowedEmail = value => /^[^\s@]+@umich\.edu$/i.test(value.trim());
const uploadTypes = () => acceptedExtensions.map(extension => extension === '.3mf' ? 'unsliced 3MF' : extension.slice(1).toUpperCase()).join(', ');
const unitLabel = unit => unit === 'embedded' ? 'from file' : unit === 'inch' ? 'inches' : 'millimeters';
function optionsOf(part) {
  const anyColor = part.firstColor === NO_PREFERENCE;
  return {
    material: part.material,
    firstColor: part.firstColor,
    secondColor: anyColor ? '' : part.secondColor,
    backupColor: anyColor ? NO_PREFERENCE : part.backupColor,
    unit: part.unit,
  };
}
const selectedPart = () => parts.find(part => part.id === selectedPartId);
const createId = () => {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

function setMessage(target, text = '', error = false) {
  const element = typeof target === 'string' ? $(target) : target;
  if (element.textContent !== text) element.textContent = text;
  element.classList.toggle('error', error);
  const role = error ? 'alert' : 'status';
  if (element.getAttribute('role') !== role) element.setAttribute('role', role);
}

function globalMessage(text = '') {
  $('#global-message').textContent = text;
  $('#global-message').hidden = !text;
}

async function api(path, { method = 'GET', body, admin = false, headers = {}, timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (admin && method !== 'GET' && method !== 'HEAD') requestHeaders['X-CSRF-Token'] = csrfToken;
  try {
    const credentials = credentialsForEndpoint(path, runtime, location.href);
    const response = await fetch(apiUrl(path), { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), credentials, signal: controller.signal, cache: 'no-store' });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      if (admin && response.status === 401) staffController?.signOut();
      throw responseError(payload, response.status === 413 ? 'The upload is too large for the server.' : `Request failed (${response.status}).`, response.status, response.headers.get('Retry-After'));
    }
    return payload || {};
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The server took too long to respond. Please try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach the server. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timer); }
}

function appendDetails(target, entries) {
  target.replaceChildren();
  for (const [label, value] of entries) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value == null || value === '' ? '—' : String(value);
    row.append(dt, dd);
    target.append(row);
  }
}

function formatDate(value, options = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Detroit', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...options }).format(date);
}

function formatDeadline(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0,10)}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', {timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(date) : String(value);
}

function completionText(request) {
  return request.estimatedCompletionAt ? formatDate(request.estimatedCompletionAt, {year: 'numeric', timeZoneName: 'short'}) : 'Not set';
}

const timedTrackers = new WeakMap();
const trackerTimingText = {
  estimated: 'Time estimate',
  passed: 'Estimate passed. Awaiting staff update.',
  unavailable: 'Time estimate unavailable',
};

function updateTrackerFill(tracker, entry, progress) {
  entry.fill.style.setProperty('--stage-fill', progress.fill);
  const text = progress.pickup || trackerTimingText[progress.timing] || '';
  if (entry.note.textContent !== text) entry.note.textContent = text;
  tracker.toggleAttribute('data-timed-tracker', progress.ticking);
}

function renderProgressTracker(request, compact = false) {
  const progress = requestProgress(request);
  if (!progress) return document.createDocumentFragment();
  const tracker = document.createElement('div');
  tracker.className = compact ? 'request-tracker tracker-compact' : 'request-tracker';
  const steps = document.createElement('ol');
  steps.className = 'tracker-steps';
  steps.setAttribute('role', 'list');
  steps.setAttribute('aria-label', 'Print request progress');
  const note = document.createElement('p');
  note.className = 'tracker-note';
  let currentFill;

  PROGRESS_STAGES.forEach((label, index) => {
    const current = index === progress.stage;
    const complete = index < progress.stage || (current && Boolean(progress.pickup));
    const step = document.createElement('li');
    step.className = 'tracker-step';
    if (current) step.setAttribute('aria-current', 'step');
    if (complete) step.classList.add('tracker-step-complete');
    const segment = document.createElement('span');
    segment.className = 'tracker-segment';
    segment.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'tracker-fill';
    segment.append(fill);
    const caption = document.createElement('span');
    caption.className = 'tracker-label';
    caption.textContent = label;
    step.append(segment, caption);
    steps.append(step);
    if (current) currentFill = fill;
  });

  tracker.append(steps, note);
  const entry = {
    fill: currentFill,
    note,
    request: {status: request.status, stageStartedAt: request.stageStartedAt, estimatedCompletionAt: request.estimatedCompletionAt},
  };
  timedTrackers.set(tracker, entry);
  updateTrackerFill(tracker, entry, progress);
  return tracker;
}

function updateVisibleTrackers() {
  if (document.hidden || page === 'submit') return;
  const now = Date.now();
  for (const tracker of $$(`[data-page="${page}"] [data-timed-tracker]`)) {
    const entry = timedTrackers.get(tracker);
    if (entry) updateTrackerFill(tracker, entry, requestProgress(entry.request, now));
  }
}

function formatHours(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'Not estimated';
  const minutes = Math.round(Number(value) * 60);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
}

function normalizeColorPreference(value) {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === NO_PREFERENCE.toLowerCase() ? NO_PREFERENCE : trimmed;
}

function colorHex(value) {
  if (value === NO_PREFERENCE) return fallbackColors.Grey;
  if (/^#[a-f\d]{6}$/i.test(value)) return value;
  const name = Object.keys(colors).find(name => name.toLowerCase() === String(value).toLowerCase());
  return colors[name] || colors.Grey || '#94a2af';
}

function showStudentPreview(visible, message = '') {
  $('#model-viewer').hidden = !visible;
  $('#rotation-control').hidden = !visible;
  $('#preview-unavailable').textContent = message;
  $('#preview-unavailable').hidden = !message;
}

let previewUnavailableMessage = '3D preview unavailable in this browser.';
let studentGeometry = null;
let studentPreviewPart = null;
const viewer = new STLViewer($('#model-canvas'), { onUnavailable: message => {
  previewUnavailableMessage = message || previewUnavailableMessage;
  if (studentGeometry) showStudentPreview(false, previewUnavailableMessage);
} });

function renderStudentPreview(message = '') {
  const part = selectedPart();
  if (!part) return;
  const hasGeometry = Boolean(studentGeometry);
  const showFit = hasGeometry && part.unit !== 'embedded';
  $('#dimension-row').hidden = part.unit === 'embedded' && !hasGeometry;
  $('#dimension-values').hidden = !hasGeometry;
  $('#fit-message').hidden = !showFit;
  $('#print-volume').hidden = !showFit;
  showStudentPreview(hasGeometry && viewer.available, hasGeometry && !viewer.available ? previewUnavailableMessage : message);
  updateDimensions();
  if (hasGeometry && viewer.available) viewer.resize();
}

const studentPreview = new ModelPreview({
  wasmUrl:stepWasmUrl,
  load:({part}) => part.file.arrayBuffer(),
  clearModel:() => { studentGeometry = null; viewer.setModel(null); },
  onModel:(geometry,{part}) => {
    viewer.setColor(colorHex(part.firstColor)).setModel(geometry);
    studentGeometry = geometry;
  },
  onState:state => {
    if (state.context && state.context.part !== selectedPart()) return;
    const message = state.status === 'loading' ? 'Loading preview…'
      : state.status === 'error' ? `${state.message} Open the file in Bambu Studio.` : '';
    renderStudentPreview(message);
  },
});

function closeStudentPreview() {
  studentPreviewPart = null;
  studentPreview.close();
}

function openStudentPreview() {
  const part = selectedPart();
  if (page !== 'submit' || $('#submission-form').hidden || !part) {
    closeStudentPreview();
    return;
  }
  if (studentPreviewPart === part) return;
  studentPreviewPart = part;
  void studentPreview.open({part, extension:modelExtension(part.file.name)});
}

function populateColors() {
  $('#colors').replaceChildren();
  $('#swatches').replaceChildren();
  for (const [name, hex] of Object.entries(colors)) {
    if (normalizeColorPreference(name) === NO_PREFERENCE) continue;
    const option = document.createElement('option');
    option.value = name;
    $('#colors').append(option);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.color = name;
    button.setAttribute('aria-pressed', 'false');
    const swatch = document.createElement('span');
    swatch.style.background = hex;
    button.append(swatch, document.createTextNode(name));
    button.addEventListener('click', () => { $('#first-color').value = name; savePartOptions(); });
    $('#swatches').append(button);
  }
  const option = document.createElement('option');
  option.value = NO_PREFERENCE;
  $('#colors').append(option);
}

function updateColorSelection() {
  const part = selectedPart();
  const value = part?.firstColor || '';
  const anyColor = value === NO_PREFERENCE;
  $('#no-color-preference')?.setAttribute('aria-pressed', String(anyColor));
  const alternateColors = $('#alternate-colors') || $('#second-color').closest('.field-pair');
  if (alternateColors) alternateColors.hidden = anyColor;
  $('#second-color').disabled = anyColor;
  $('#backup-color').disabled = anyColor;
  $$('#swatches button').forEach(button => {
    const selected = button.dataset.color.toLowerCase() === value.toLowerCase();
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  const hex = colorHex(value);
  $('#custom-color').value = hex;
  if (studentGeometry) viewer.setColor(hex);
}

function updateDimensions() {
  const part = selectedPart();
  if (!part || !studentGeometry) return;
  const dimensions = previewDimensions(studentGeometry, part.unit);
  $('#dimensions').textContent = dimensions.map(value => Number(value.toFixed(1))).join(' × ') + ' mm';
  if (part.unit === 'embedded') return;
  const fits = dimensions[0] <= 256 && dimensions[1] <= 256 && dimensions[2] <= 260;
  $('#fit-message').textContent = fits ? 'Within print volume · Staff review required' : 'Exceeds print volume · Check units and orientation';
  $('#fit-message').classList.toggle('warning', !fits);
}

function renderPartEditor() {
  const part = selectedPart();
  $('#part-settings').disabled = !part || submitting;
  $('#preview-panel').hidden = !part;
  $('#empty-parts').hidden = !!part;
  $('#part-name').textContent = part ? part.file.name : 'Part settings';
  if (!part) { closeStudentPreview(); return; }
  $$('input[name=material]').forEach(input => { input.checked = input.value === part.material; });
  $('#first-color').value = part.firstColor;
  $('#second-color').value = part.secondColor;
  $('#backup-color').value = part.backupColor;
  const embeddedUnits = part.unit === 'embedded';
  $('#unit').value = part.unit;
  $('#unit').disabled = embeddedUnits;
  $('#unit-field').hidden = embeddedUnits;
  $('#preview-filename').textContent = part.file.name;
  openStudentPreview();
  updateColorSelection();
}

function renderFiles() {
  $('#file-list').replaceChildren();
  for (const part of parts) {
    const row = document.createElement('div');
    row.className = 'file-row' + (part.id === selectedPartId ? ' selected' : '');
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'file-select';
    select.setAttribute('aria-pressed', String(part.id === selectedPartId));
    const filename = document.createElement('span');
    const details = document.createElement('small');
    filename.textContent = part.file.name;
    details.textContent = `${part.material} / ${part.firstColor || 'Choose color'} · ${(part.file.size / 1048576).toFixed(2)} MB`;
    select.append(filename, details);
    select.addEventListener('click', () => { selectedPartId = part.id; renderFiles(); renderPartEditor(); });
    const label = document.createElement('label');
    label.className = 'quantity-field';
    label.append(document.createTextNode('Qty'));
    const quantity = document.createElement('input');
    quantity.type = 'number'; quantity.min = '1'; quantity.max = '999'; quantity.step = '1'; quantity.required = true;
    quantity.value = Number.isFinite(part.quantity) ? String(part.quantity) : '';
    quantity.setAttribute('aria-label', `Quantity for ${part.file.name}`);
    quantity.addEventListener('input', () => { part.quantity = Number(quantity.value); quantity.setCustomValidity(Number.isInteger(part.quantity) && part.quantity >= 1 && part.quantity <= 999 ? '' : 'Enter a whole quantity from 1 to 999.'); });
    label.append(quantity);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'remove-part'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${part.file.name}`);
    remove.addEventListener('click', () => { const index = parts.findIndex(item => item.id === part.id); parts.splice(index, 1); if (part.id === selectedPartId) selectedPartId = parts[Math.min(index, parts.length - 1)]?.id || null; renderFiles(); renderPartEditor(); });
    row.append(select, label, remove);
    $('#file-list').append(row);
  }
  $('#review-button').disabled = !configReady || submitting;
}

function savePartOptions() {
  const part = selectedPart();
  if (!part) return;
  part.material = $('input[name=material]:checked').value;
  part.firstColor = normalizeColorPreference($('#first-color').value);
  part.secondColor = normalizeColorPreference($('#second-color').value);
  part.backupColor = $('#backup-color').value.trim();
  if (part.unit !== 'embedded') part.unit = $('#unit').value;
  lastOptions = { material: part.material, firstColor: part.firstColor || lastOptions.firstColor, secondColor: part.secondColor, backupColor: part.backupColor || lastOptions.backupColor, unit: part.unit === 'embedded' ? lastOptions.unit : part.unit };
  renderFiles();
  updateColorSelection();
  updateDimensions();
}

function addFiles(incoming) {
  if (!configReady || submitting || !incoming.length) return;
  if (parts.length + incoming.length > MAX_FILES) { setMessage('#submission-message', 'Maximum 10 model files per request.', true); $('#files').value = ''; return; }
  const inherited = { ...lastOptions };
  try {
    const additions = [];
    for (const file of incoming) {
      const extension = modelExtension(file.name);
      if (!acceptedExtensions.includes(extension)) throw new Error(`Supported formats: ${uploadTypes()}.`);
      if (/\.(?:gcode|bgcode|gco|toolpath|slices)(?:\.|$)/i.test(file.name)) throw new Error('Sliced files and G-code are not accepted.');
      if (file.size > MAX_BYTES) throw new Error(`${file.name} exceeds 10 MB.`);
      if (!file.size) throw new Error(`${file.name} is empty.`);
      const unit = extension === '.stl' || extension === '.obj' ? inherited.unit : 'embedded';
      additions.push({ id: createId(), file, quantity: 1, ...inherited, unit });
    }
    parts.push(...additions);
    selectedPartId = additions[0].id;
    renderFiles();
    renderPartEditor();
    setMessage('#submission-message');
  } catch (error) { setMessage('#submission-message', error.message, true); }
  finally { $('#files').value = ''; }
}

$('#files').addEventListener('change', event => addFiles([...event.target.files]));
$('#drop-zone').addEventListener('dragover', event => { event.preventDefault(); if (configReady && !submitting) $('#drop-zone').classList.add('is-dragging'); });
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('is-dragging'));
$('#drop-zone').addEventListener('drop', event => { event.preventDefault(); $('#drop-zone').classList.remove('is-dragging'); addFiles([...event.dataTransfer.files]); });
$$('input[name=material]').forEach(input => input.addEventListener('change', savePartOptions));
for (const id of ['first-color', 'second-color']) $(`#${id}`).addEventListener('input', savePartOptions);
$('#backup-color').addEventListener('change', savePartOptions);
$('#custom-color').addEventListener('input', event => { $('#first-color').value = event.target.value; savePartOptions(); });
$('#no-color-preference')?.addEventListener('click', () => {
  $('#first-color').value = NO_PREFERENCE;
  savePartOptions();
});
$('#unit').addEventListener('change', savePartOptions);
$('#rotation').addEventListener('input', event => viewer.setYaw(Number(event.target.value)));
$('#reset-view').addEventListener('click', () => { viewer.reset(); $('#rotation').value = '-28'; });
$('#email').addEventListener('input', event => event.target.setCustomValidity(allowedEmail(event.target.value) ? '' : 'Use an @umich.edu email address.'));

function validateParts() {
  if (!parts.length) throw new Error('Add at least one model file.');
  for (const part of parts) {
    if (!Number.isInteger(part.quantity) || part.quantity < 1 || part.quantity > 999) throw new Error(`Enter a whole quantity from 1 to 999 for ${part.file.name}.`);
    const { firstColor, secondColor, backupColor } = optionsOf(part);
    if (!firstColor || !backupColor) { selectedPartId = part.id; renderFiles(); renderPartEditor(); throw new Error(`Choose first and backup colors for ${part.file.name}.`); }
    if ([firstColor, secondColor, backupColor].some(value => value.length > 100)) throw new Error('Color preferences must be 100 characters or fewer.');
  }
}

$('#submission-form').addEventListener('submit', event => {
  event.preventDefault();
  if (submitting || !configReady) return;
  try {
    savePartOptions();
    const email = $('#email').value.trim();
    if (!allowedEmail(email) || !$('#email').checkValidity()) throw new Error('Use an @umich.edu email address.');
    const groupName = $('#group-name').value.trim();
    if (!groupName) throw new Error('Enter your group number and name.');
    const personName = $('#person-name').value.trim();
    if (!personName) throw new Error('Enter your name.');
    validateParts();
    reviewed = { personName, email, groupName, neededBy: $('#needed-by').value || null, specialInstructions: $('#instructions').value.trim(), parts: parts.map(part => ({ ...part, ...optionsOf(part) })) };
    submissionKey = createId();
    uploadAttempt = new StagedRequest(reviewed, submissionKey, uploadCooldown);
    appendDetails($('#review-project'), [['Name', reviewed.personName], ['Group', reviewed.groupName], ['Email', reviewed.email], ['Needed by', formatDeadline(reviewed.neededBy)], ['Instructions', reviewed.specialInstructions]]);
    $('#review-parts').replaceChildren();
    for (const part of reviewed.parts) {
      const item = document.createElement('li'); item.className = 'review-part';
      const title = document.createElement('strong'); title.textContent = `${part.file.name} × ${part.quantity}`;
      const material = document.createElement('p');
      const colorText = part.firstColor === NO_PREFERENCE
        ? `Color: ${NO_PREFERENCE}`
        : `First: ${part.firstColor} · Second: ${part.secondColor || '—'} · Backup: ${part.backupColor}`;
      material.textContent = `Material: ${part.material} · ${colorText}`;
      const unit = document.createElement('p'); unit.textContent = `Units: ${unitLabel(part.unit)}`;
      item.append(title, material, unit); $('#review-parts').append(item);
    }
    $('#submission-form').hidden = true;
    closeStudentPreview();
    $('#review-panel').hidden = false;
    updateSubmissionControls();
    setMessage('#submission-message');
    $('#review-heading').scrollIntoView({ block: 'start' });
  } catch (error) { setMessage('#submission-message', error.message, true); }
});

$('#edit-request').addEventListener('click', () => { if (submitting) return; $('#review-panel').hidden = true; $('#submission-form').hidden = false; uploadAttempt = null; openStudentPreview(); setMessage('#submission-message'); });

function updateSubmissionControls() {
  const remaining = uploadCooldown.remainingSeconds;
  $('#submit-request').disabled = submitting || remaining > 0;
  $('#submit-request').textContent = submitting ? 'Submitting…' : remaining ? `Retry in ${formatRetryTime(remaining)}` : uploadAttempt?.attempted ? 'Retry request' : 'Submit request';
  $('#edit-request').disabled = submitting;
  $('#upload-cooldown').hidden = !remaining;
  $('#upload-cooldown-time').textContent = formatRetryTime(remaining);
  if (remaining && !cooldownTimer) cooldownTimer = setInterval(() => {
    updateSubmissionControls();
    if (!uploadCooldown.remainingSeconds) { clearInterval(cooldownTimer); cooldownTimer = null; setMessage('#submission-message', 'You can retry now. Your parts are kept.'); }
  }, 1000);
}

function uploadFile(file, token, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('uploads'));
    xhr.withCredentials = false;
    xhr.setRequestHeader('X-Upload-Token', token);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = 180000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(event.loaded / event.total, 1)); };
    xhr.onerror = () => reject(new Error('Upload interrupted. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Please try again.'));
    xhr.onload = () => { let payload; try { payload = JSON.parse(xhr.responseText); } catch { payload = null; } if (xhr.status < 200 || xhr.status >= 300) reject(responseError(payload, xhr.status === 413 ? `${file.name} exceeds the server upload limit.` : `Upload failed (${xhr.status}).`, xhr.status, xhr.getResponseHeader('Retry-After'))); else if (!payload?.uploadId) reject(new Error('The server did not confirm the uploaded file.')); else resolve(payload); };
    const form = new FormData(); form.append('file', file, file.name); xhr.send(form);
  });
}

$('#submit-request').addEventListener('click', async () => {
  if (!reviewed || submitting || uploadCooldown.remainingSeconds) { updateSubmissionControls(); return; }
  submitting = true;
  updateSubmissionControls();
  $('#upload-progress-panel').hidden = false;
  setMessage('#submission-message');
  try {
    uploadAttempt ||= new StagedRequest(reviewed, submissionKey, uploadCooldown);
    const result = await uploadAttempt.send({
      startSession: () => api('upload-sessions', { method: 'POST', body: {} }),
      uploadFile,
      finalize: (body, key) => api('requests', { method: 'POST', body, headers: { 'X-Idempotency-Key': key }, timeout: 60000 }),
      onProgress: progress => {
        $('#upload-progress').value = progress.percent;
        $('#upload-progress-label').textContent = progress.stage === 'saving' ? 'Saving request…' : `Uploading ${progress.index + 1} of ${reviewed.parts.length}: ${progress.filename}`;
      },
    });
    if (!result.request?.requestNumber) throw new Error('The server did not return a request number. Retry to check this submission.');
    lastReceipt = { ...result.request, email: reviewed.email };
    $('#review-panel').hidden = true;
    $('#submission-success').hidden = false;
    $('#submission-receipt').textContent = `${lastReceipt.requestNumber} · ${lastReceipt.status || 'Submitted'} · ${reviewed.parts.length} file(s), ${reviewed.parts.reduce((sum, part) => sum + part.quantity, 0)} pieces`;
    parts = []; selectedPartId = null; reviewed = null; uploadAttempt = null;
    renderFiles(); renderPartEditor();
    $('#submission-receipt').scrollIntoView({ block: 'center' });
  } catch (error) { setMessage('#submission-message', uploadCooldown.remainingSeconds ? 'Uploads paused. Your parts are kept.' : error.message + (uploadAttempt?.finalizedPayload ? '\nYou can safely retry this submission.' : ''), !uploadCooldown.remainingSeconds); }
  finally { submitting = false; updateSubmissionControls(); $('#upload-progress-panel').hidden = true; }
});

$('#view-submitted-status').addEventListener('click', () => { if (!lastReceipt) return; $('#status-email').value = lastReceipt.email; location.hash = '#status'; lookupStatus(lastReceipt.email); });
$('#new-request').addEventListener('click', () => { $('#submission-success').hidden = true; $('#submission-form').hidden = false; $('#review-button').disabled = !configReady; setMessage('#submission-message'); });

async function lookupStatus(email = $('#status-email').value) {
  const normalized = email.trim();
  const submit = $('#status-form button');
  if (submit.disabled && normalized === statusEmail) return;
  const sequence = ++statusRequestSequence;
  if (normalized !== statusEmail) {
    statusSnapshot = null;
    $('#status-results').replaceChildren();
  }
  if (!allowedEmail(normalized)) {
    statusEmail = '';
    submit.disabled = false;
    setMessage('#status-message', 'Use an @umich.edu email address.', true);
    return;
  }
  statusEmail = normalized;
  submit.disabled = true;
  if (statusSnapshot === null) setMessage('#status-message', 'Loading…');
  try {
    const result = await api('status', { method: 'POST', body: { email: normalized } });
    if (sequence !== statusRequestSequence) return;
    const requests = Array.isArray(result.requests) ? result.requests : [];
    setMessage('#status-message', requests.length ? `${requests.length} request${requests.length === 1 ? '' : 's'}` : 'No requests found.');
    const snapshot = JSON.stringify(requests);
    if (snapshot === statusSnapshot) return;
    const cards = document.createDocumentFragment();
    for (const request of requests) {
      const card = document.createElement('section'); card.className = 'status-card';
      const header = document.createElement('header'); const id = document.createElement('h2'); id.textContent = request.requestNumber;
      const badge = document.createElement('span');
      badge.className = 'status-badge';
      badge.dataset.status = request.status;
      badge.textContent = request.status;
      const details = document.createElement('dl'); details.className = 'details-list';
      const facts = [['Queue position', request.queuePosition ? `#${request.queuePosition}` : '—'], ['Estimated completion', completionText(request)]];
      const partProgress = partProgressCounts(request.partProgress);
      if (partProgress) facts.push(['Files printed', `${partProgress.printed} of ${partProgress.total}`]);
      if (request.stageStartedAt) facts.push(['Stage started', formatDate(request.stageStartedAt, {timeZoneName:'short'})]);
      facts.push(['Last update', formatDate(request.updatedAt)]);
      appendDetails(details, facts);
      header.append(id, badge);
      card.append(header, renderProgressTracker(request), details);
      cards.append(card);
    }
    $('#status-results').replaceChildren(cards);
    statusSnapshot = snapshot;
  } catch (error) {
    if (sequence === statusRequestSequence) setMessage('#status-message', statusSnapshot === null ? error.message : 'Could not refresh. Showing the last update.', true);
  } finally {
    if (sequence === statusRequestSequence) submit.disabled = false;
  }
}

$('#status-form').addEventListener('submit', event => { event.preventDefault(); lookupStatus(); });
$('#status-email').addEventListener('input', () => {
  statusRequestSequence++;
  statusEmail = '';
  statusSnapshot = null;
  $('#status-results').replaceChildren();
  $('#status-form button').disabled = false;
  setMessage('#status-message');
});

function renderQueueRow(request) {
  const row = document.createElement('div');
  row.className = 'public-row';
  const rank = document.createElement('span');
  rank.className = 'queue-rank';
  rank.textContent = request.queuePosition ? `#${request.queuePosition}` : '—';

  const title = document.createElement('div');
  title.className = 'queue-title';
  const number = document.createElement('strong');
  number.textContent = request.requestNumber;
  const status = document.createElement('span');
  status.className = 'status-badge queue-status';
  status.dataset.status = request.status;
  status.textContent = request.status;
  title.append(number, status);
  const partProgress = partProgressCounts(request.partProgress);
  if (partProgress) {
    const printed = document.createElement('small');
    printed.textContent = `${partProgress.printed} of ${partProgress.total} files printed`;
    title.append(printed);
  }

  const material = document.createElement('span');
  const materialSummary = request.materialSummary === 'No preference' ? 'Any material' : request.materialSummary;
  const colorSummary = request.colorSummary === 'No preference' ? 'Any color' : request.colorSummary;
  material.textContent = [materialSummary, colorSummary].filter(Boolean).join(' / ');
  const timing = document.createElement('div');
  timing.className = 'queue-estimate';
  const label = document.createElement('small');
  label.textContent = 'Estimated completion';
  const eta = document.createElement('span');
  eta.className = 'queue-eta-value';
  eta.textContent = completionText(request);
  timing.append(label, eta);
  if (request.completedAt) {
    const completed = document.createElement('small');
    completed.textContent = `Completed: ${formatDate(request.completedAt, {timeZoneName:'short'})}`;
    timing.append(completed);
  }
  row.append(rank, title, material, timing, renderProgressTracker(request, true));
  return row;
}

async function loadPublicQueue() {
  if (publicQueueLoading) return;
  publicQueueLoading = true;
  $('#refresh-queue').disabled = true;
  if (queueSnapshot === null) setMessage('#queue-message', 'Loading…');
  try {
    const result = await api('queue');
    const requests = publicQueueRecords(result.requests || []);
    setMessage('#queue-message', requests.length ? '' : 'No requests in the queue.');
    const snapshot = JSON.stringify(requests);
    if (snapshot === queueSnapshot) return;
    const rows = document.createDocumentFragment();
    for (const request of requests) rows.append(renderQueueRow(request));
    $('#public-queue').replaceChildren(rows);
    queueSnapshot = snapshot;
  } catch (error) {
    setMessage('#queue-message', queueSnapshot === null ? error.message : 'Could not refresh. Showing the last update.', true);
  } finally {
    publicQueueLoading = false;
    $('#refresh-queue').disabled = false;
  }
}
$('#refresh-queue').addEventListener('click', loadPublicQueue);

async function navigate() {
  const route = location.hash.slice(1).split('?')[0];
  const staffRedirect = staffRedirectUrl(location.hash, runtime, location.href);
  if (staffRedirect) { location.assign(staffRedirect); return; }
  const normalizedRoute = route === 'staff' ? 'admin' : route;
  page = ['submit', 'status', 'queue', 'admin'].includes(normalizedRoute) ? normalizedRoute : 'submit';
  if (page !== 'admin') staffController?.leave();
  $$('[data-page]').forEach(section => { section.hidden = section.dataset.page !== page; });
  $$('[data-nav]').forEach(link => { if (link.dataset.nav === page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  updateVisibleTrackers();
  if (page === 'submit') openStudentPreview();
  else closeStudentPreview();
  if (page === 'queue') await loadPublicQueue();
  if (page === 'admin' && staffController) { await staffController.checkSession(); if (staffController.isAuthenticated()) await Promise.all([staffController.loadAdminRequests({ preserveEditor: editorDirty }), staffController.loadSettings()]); }
}

async function initialize() {
  populateColors(); renderFiles(); renderPartEditor();
  try {
    const config = await api('config');
    acceptedExtensions = acceptedModelExtensions(config.acceptedExtensions);
    if (!acceptedExtensions.length) throw new Error('No supported model file formats are available.');
    $('#files').accept = acceptedExtensions.join(',');
    $('#upload-limits').textContent = `${uploadTypes()} · Choose files or drop them here`;
    colors = config.colors && Object.keys(config.colors).length ? config.colors : fallbackColors;
    populateColors();
    renderPartEditor();
    configReady = true; $('#files').disabled = false; $('#review-button').disabled = false; globalMessage();
  } catch (error) { globalMessage(`Portal unavailable: ${error.message}`); }
  await navigate();
}

window.addEventListener('hashchange', navigate);
window.addEventListener('pagehide', closeStudentPreview);
window.addEventListener('pageshow', event => { if (event.persisted) openStudentPreview(); });
window.addEventListener('beforeunload', event => { if (submitting) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', updateVisibleTrackers);
setInterval(updateVisibleTrackers, 1000);
setInterval(() => { if (document.hidden) return; if (page === 'queue') loadPublicQueue(); else if (page === 'status' && statusEmail) lookupStatus(statusEmail); }, 30000);
initialize();
