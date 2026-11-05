export function resolveRuntimeConfig(config = {}, documentUrl) {
  const documentBase = new URL('./', documentUrl);
  const apiBase = new URL(config.apiBase || './', documentBase);
  if (!['http:', 'https:'].includes(apiBase.protocol) || apiBase.username || apiBase.password || apiBase.search || apiBase.hash) throw new Error('API base must be an HTTP(S) application URL without credentials, query, or fragment.');
  if (!apiBase.pathname.endsWith('/')) apiBase.pathname += '/';
  const staffUrl = new URL(config.staffUrl || '#staff', apiBase);
  if (!['http:', 'https:'].includes(staffUrl.protocol) || staffUrl.username || staffUrl.password) throw new Error('Staff URL must be an HTTP(S) URL without credentials.');
  return Object.freeze({studentOnly: config.studentOnly === true, apiBase: apiBase.href, staffUrl: staffUrl.href});
}

export function endpointUrl(path, runtime) {
  const relative = String(path).replace(/^\/+/, '');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(relative) || /(?:^|\/)\.\.(?:\/|$)/.test(relative)) throw new Error('Invalid API endpoint.');
  return new URL(`api/${relative}`, runtime.apiBase).href;
}

export function credentialsForEndpoint(path, runtime, documentUrl) {
  const staff = /^admin(?:\/|$)/.test(String(path).replace(/^\/+/, ''));
  const documentOrigin = new URL(documentUrl).origin;
  const sameApiOrigin = new URL(runtime.apiBase).origin === documentOrigin;
  const onStaffOrigin = new URL(runtime.staffUrl).origin === documentOrigin;
  // The protected full app needs its Cloudflare Access cookie on config and
  // other public API calls too. Student builds never send cookies.
  if (!staff) return !runtime.studentOnly && sameApiOrigin && onStaffOrigin ? 'same-origin' : 'omit';
  if (runtime.studentOnly) throw new Error('Staff access is available on the staff site.');
  if (!sameApiOrigin) throw new Error('Staff API access must use the same origin as the staff page.');
  if (!onStaffOrigin) throw new Error('Staff access is available on the staff site.');
  return 'same-origin';
}

export function staffRedirectUrl(hash, runtime, documentUrl) {
  const match = /^#?(?:admin|staff)(\?.*)?$/.exec(hash);
  if (!match) return null;
  const target = new URL(runtime.staffUrl);
  if (!runtime.studentOnly && target.origin === new URL(documentUrl).origin) return null;
  if (match[1]) target.hash = `staff${match[1]}`;
  return target.href;
}
